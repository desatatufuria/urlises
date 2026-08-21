import {
  createBookmark as apiCreateBookmark,
  createFolder as apiCreateFolder,
  deleteBookmark as apiDeleteBookmark,
  deleteFolder as apiDeleteFolder,
  getOrganizations,
  getWorkspaceTree,
  getWorkspaces,
  login as apiLogin,
  createWSTicket,
  parseBookmarkDeletePayload,
  parseFolderDeletePayload,
  replayEvents,
  updateBookmark as apiUpdateBookmark,
  updateFolder as apiUpdateFolder,
  ApiError,
} from "../shared/api.js";
import { pushDiagnostic } from "../shared/diagnostics.js";
import { addExclusion, isExcluded, pruneExclusions, removeExclusions } from "../shared/exclusions.js";
import { removeMappingByBackendId, removeMappingsByBackendIds, removeMappingsByChromeIds, setMapping } from "../shared/mapping.js";
import {
  collectBackendIds,
  collectBackendIdsByChromeIds,
  filterFoldersForProjection,
  findReusableBookmarkNode,
  findReusableFolderNode,
} from "../shared/projection-helpers.js";
import { LOCAL_ONLY_FOLDER_TITLE } from "../shared/runtime.js";
import { setBackendUrl, saveSession, clearSession, ensureClientId, restoreSession, setSessionPauseHandler, bestEffortLogout } from "../shared/session.js";
import { createProjectionState, getState, resetStatePreservingSettings, setState, updateState } from "../shared/storage.js";
import type {
  ActivitySignal,
  BookmarkNode,
  BookmarkResource,
  ExtensionState,
  FolderNode,
  FolderResource,
  LoginRequest,
  ProjectionActivityDetail,
  ProjectionState,
  SessionData,
  StatusOverview,
  SyncEnvelope,
  TreeResponse,
  UiState,
  WorkspaceAccess,
} from "../shared/types.js";
import {
  clearChildren,
  collectChromeIds,
  createBookmark,
  createFolder,
  ensureManagedPath,
  getChildren,
  getNode,
  getSubTree,
  moveNode,
  removeNode,
  removeTree,
  updateNode,
} from "./chrome-bookmarks.js";
import { connectWorkspaceSocket } from "../shared/websocket.js";
import type { BookmarkChangeInfo, BookmarkMoveInfo, BookmarkRemoveInfo } from "./bookmark-listeners.js";
import { canPersistReceipt, captureLocalIntent, createRemoteReceipt, emptyJournal, gateRemoteEffect, normalizedReceipts, rebuildJournal, reduceRemoteCallback, retryJournal, type RepairGate } from "./convergence.js";

const socketClosers = new Map<string, () => void>();
const socketTokens = new Map<string, symbol>();
const socketConnectFlights = new Map<string, Promise<void>>();
const liveApplyQueues = new Map<string, Promise<void>>();
const suppressedChromeIds = new Set<string>();
const abandonedMutationKeys = new Map<string, ReturnType<typeof setTimeout>>();
const volatileRepairGates = new Map<string, RepairGate>();
const MAX_SILENT_RECOVERY_ATTEMPTS = 3;
const ABANDONED_MUTATION_TTL_MS = 1500;

type RemoteApplyDiagnosticContext = Record<string, string | number | boolean | undefined>;
type RecoveryReason = "missing-parent" | "stale-mapping" | "local-404";

type RecoveryScope = {
  workspaceId: string;
  entityType?: "folder" | "bookmark";
  entityBackendId?: string;
  parentBackendId?: string;
  mappedChromeId?: string;
  reason: RecoveryReason;
  pruneExclusions?: boolean;
};

type RecoveryValidation =
  | { status: "valid" }
  | { status: "recover-subtree"; reason: string; invalidateBackendIds?: string[] };

type CanonicalAnchor = {
  parentChromeId: string;
  folders: FolderNode[];
  bookmarks: BookmarkNode[];
  validBackendIds: Set<string>;
};

class RemoteApplyError extends Error {
  constructor(
    message: string,
    readonly context: RemoteApplyDiagnosticContext,
    readonly gate: RepairGate = "chrome-effect-rejected",
  ) {
    super(message);
    this.name = "RemoteApplyError";
  }
}

class RemoteDeleteReadError extends Error {}

export const projectionTestHooks = {
  applyRemoteEnvelope,
  connectWorkspace,
  drainLocalIntents,
  recoverWorkspace,
  replayWorkspaceDelta,
  resetRuntimeState,
  volatileRepairGate: (workspaceId: string) => volatileRepairGates.get(workspaceId),
  socketRuntimeCounts: () => ({ tokens: socketTokens.size, closers: socketClosers.size, flights: socketConnectFlights.size }),
};

type WorkspaceResyncLock = {
  active: Promise<void>;
  rerunRequested: boolean;
  latestReason: string;
};

const workspaceLocks = new Map<string, WorkspaceResyncLock>();

export async function initializeBackground(): Promise<void> {
  setSessionPauseHandler(closeAllSockets);
  await restoreSession();
  const state = await getState();
  if (!state.session || state.selectedWorkspaceIds.length === 0) {
    return;
  }
  await syncSelectedWorkspaces("startup");
}

export async function login(request: LoginRequest): Promise<UiState> {
  const clientId = await ensureClientId();
  const session = await apiLogin(request, clientId);
  await setBackendUrl(request.backendUrl);
  await saveSession(session);
  await refreshWorkspaceCatalog(session, request.backendUrl);
  await log("auth", `signed in as ${session.user.email}`, "info");
  await syncSelectedWorkspaces("login");
  return getUiState();
}

export async function logout(): Promise<UiState> {
  closeAllSockets();
  const state = await getState();
  void bestEffortLogout(state.settings.backendUrl, state.settings.clientId).catch(() => undefined);
  await clearSession();
  for (const projection of Object.values(state.projectionsByWorkspaceId)) {
    await removeWorkspaceProjection(projection);
  }
  await resetStatePreservingSettings();
  await log("auth", "signed out and cleared local projections", "info");
  return getUiState();
}

export async function getUiState(): Promise<UiState> {
  return buildUiState(await getState());
}

export async function loadOptionsState(): Promise<UiState> {
  const state = await getState();
  if (state.session) {
    await refreshWorkspaceCatalog(state.session, state.settings.backendUrl);
  }
  return getUiState();
}

export async function markActivitySeen(): Promise<UiState> {
  await updateState((state) => {
    const revision = state.activitySignal?.revision ?? 0;
    return {
      ...state,
      activitySignal: {
        revision,
        lastSeenRevision: revision,
      },
    };
  });
  return getUiState();
}

export async function setSelectedWorkspaces(workspaceIds: string[]): Promise<UiState> {
  const uniqueIds = [...new Set(workspaceIds)];
  const previous = await getState();
  const removed = previous.selectedWorkspaceIds.filter((id) => !uniqueIds.includes(id));

  for (const workspaceId of removed) {
    closeWorkspaceSocket(workspaceId);
    const projection = previous.projectionsByWorkspaceId[workspaceId];
    if (projection) {
      await removeWorkspaceProjection(projection);
    }
  }

  await updateState((state) => ({
    ...state,
    selectedWorkspaceIds: uniqueIds,
    projectionsByWorkspaceId: Object.fromEntries(
      Object.entries(state.projectionsByWorkspaceId).filter(([workspaceId]) => uniqueIds.includes(workspaceId)),
    ),
  }));

  await syncSelectedWorkspaces("selection changed");
  return getUiState();
}

export async function resyncAll(): Promise<UiState> {
  const state = await getState();
  for (const workspaceId of state.selectedWorkspaceIds) {
    await retryWorkspace(workspaceId);
  }
  return getUiState();
}

export async function retryWorkspace(workspaceId: string): Promise<UiState> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) return getUiState();
  let retryable = false;
  await updateProjectionState(workspaceId, (current) => { current.convergenceJournal = retryJournal(current.convergenceJournal ?? emptyJournal()); retryable = current.convergenceJournal.phase === "replay"; if (retryable) current.status = "syncing"; });
  if (!retryable) return getUiState();
  volatileRepairGates.delete(workspaceId);
  await replayWorkspaceDelta(workspaceId, projection.lastCursor, "explicit retry");
  return getUiState();
}

export async function rebuildWorkspace(workspaceId: string): Promise<UiState> {
  await updateProjectionState(workspaceId, (current) => { current.convergenceJournal = rebuildJournal(current.convergenceJournal ?? emptyJournal()); });
  volatileRepairGates.delete(workspaceId);
  if (await doResyncWorkspace(workspaceId, "explicit rebuild", "recovering")) await connectWorkspace(workspaceId);
  return getUiState();
}

type LocalIntentContext = {
  projection: ProjectionState;
  workspaceId: string;
  backendId: string;
  entityType: "folder" | "bookmark";
};

async function settleLocalMutation(
  workspaceId: string,
  cursor: number,
  mutateProjection: (projection: ProjectionState) => void,
): Promise<void> {
  await updateProjectionState(workspaceId, (projection) => {
    mutateProjection(projection);
    projection.lastCursor = Math.max(projection.lastCursor, cursor);
    projection.lastSyncedAt = new Date().toISOString();
    projection.status = "ready";
    if (projection.socketConnected) projection.health = "live";
    projection.lastError = undefined;
  });
}

async function captureLocalUpdateOrMove(context: LocalIntentContext, chromeId: string, kind: "changed" | "moved"): Promise<void> {
  const node = await getNode(chromeId);
  if (!node) {
    await updateProjectionState(context.workspaceId, (projection) => {
      const journal = projection.convergenceJournal ?? emptyJournal();
      journal.phase = "paused";
      journal.pauseReason = projection.lastCursor === 0 ? "cursor-zero-read-failed" : "ambiguous-operation";
      projection.convergenceJournal = journal;
    });
    return;
  }
  if (!await isWithinWorkspace(node, context.projection.workspaceChromeId)) {
    await updateProjectionState(context.workspaceId, (projection) => {
      const journal = projection.convergenceJournal ?? emptyJournal();
      journal.phase = "paused";
      journal.pauseReason = "stale-mapping";
      projection.convergenceJournal = journal;
    });
    return;
  }
  await updateProjectionState(context.workspaceId, (projection) => {
    projection.convergenceJournal = captureLocalIntent(projection.convergenceJournal ?? emptyJournal(), {
      workspaceId: context.workspaceId,
      backendId: context.backendId,
      chromeId,
      type: context.entityType,
      kind,
      node: { parentId: node.parentId, index: node.index, title: node.title, url: node.url },
    });
  });
  await drainLocalIntents(context.workspaceId, `local ${kind}`);
}

async function drainLocalIntents(workspaceId: string, reason: string): Promise<void> {
  await runCoalescedWorkspaceTask(workspaceLocks, workspaceId, reason, () => drainLocalIntentsNow(workspaceId));
}

async function drainLocalIntentsNow(workspaceId: string): Promise<void> {
  while (true) {
    const state = await getState();
    const projection = state.projectionsByWorkspaceId[workspaceId];
    const journal = projection?.convergenceJournal;
    if (!state.session || !projection || journal?.phase === "paused") return;
    const intent = journal?.localIntents.find((candidate) => candidate.status !== "acked");
    if (!intent) return;

    try {
      if (intent.payload.workspaceId !== workspaceId
        || projection.backendIdByChromeId[intent.payload.chromeId] !== intent.payload.backendId
        || projection.entityTypeByBackendId[intent.payload.backendId] !== intent.payload.type) {
        throw new Error("local intent identity is outside the workspace mapping");
      }
      const chromeNode = await getNode(intent.payload.chromeId);
      if (!chromeNode || !await isWithinWorkspace(chromeNode, projection.workspaceChromeId)) {
        throw new Error("local intent node is outside the workspace projection");
      }
      const parentChromeId = intent.payload.node.parentId;
      const parentBackendId = parentChromeId === projection.workspaceChromeId
        ? null
        : parentChromeId ? projection.backendIdByChromeId[parentChromeId] : undefined;
      if (intent.payload.node.index === undefined || (parentChromeId !== projection.workspaceChromeId && !parentBackendId)) {
        throw new Error("local intent parent or position is not mapped");
      }
      if (intent.payload.type === "bookmark" && (!parentBackendId || !intent.payload.node.url)) {
        throw new Error("bookmark intent requires a canonical folder and URL");
      }

      await updateProjectionState(workspaceId, (current) => {
        const pending = current.convergenceJournal?.localIntents.find((candidate) => candidate.eventId === intent.eventId);
        if (pending && pending.status !== "acked") pending.status = "sent";
      });

      const eventId = await opaqueLocalIntentEventId(intent.eventId);
      const ack = intent.payload.type === "folder"
        ? (await apiUpdateFolder(state.settings.backendUrl, state.session, intent.payload.backendId, {
          name: intent.payload.node.title,
          parentId: parentBackendId ?? null,
          position: intent.payload.node.index,
        }, projection.lastCursor, eventId)).ack
        : (await apiUpdateBookmark(state.settings.backendUrl, state.session, intent.payload.backendId, {
          folderId: parentBackendId!,
          title: intent.payload.node.title,
          url: intent.payload.node.url!,
          position: intent.payload.node.index,
        }, projection.lastCursor, eventId)).ack;

      await settleLocalMutation(workspaceId, ack.cursor, (current) => {
        const acknowledged = current.convergenceJournal?.localIntents.find((candidate) => candidate.eventId === intent.eventId);
        if (acknowledged) acknowledged.status = "acked";
      });
      await log(`intent:${workspaceId}`, `local ${intent.kind} acknowledged at cursor ${ack.cursor}`, "info");
    } catch (error) {
      try {
        await log(`intent:${workspaceId}`, `local intent dispatch failed: ${describeError(error)}`, "warn");
        await pauseWorkspace(workspaceId, (await getState()).projectionsByWorkspaceId[workspaceId]?.lastCursor ?? 0, "ambiguous-predecessor");
      } catch {}
      return;
    }
  }
}

async function opaqueLocalIntentEventId(eventId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(eventId));
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `local-intent-sha256-${hex}`;
}

async function isWithinWorkspace(node: chrome.bookmarks.BookmarkTreeNode, workspaceChromeId: string | undefined): Promise<boolean> {
  if (!workspaceChromeId) return false;
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    if (parentId === workspaceChromeId) return true;
    visited.add(parentId);
    parentId = (await getNode(parentId))?.parentId;
  }
  return false;
}

export async function handleBookmarkCreated(id: string, node: chrome.bookmarks.BookmarkTreeNode): Promise<void> {
  if (await ownsRemoteCreate(id, node)) return;
  if (isSuppressed(node.id) || isSuppressed(node.parentId)) {
    return;
  }

  const context = await resolveContext(node.parentId ?? node.id);
  if (!context || context.syntheticRoot !== "workspace") {
    return;
  }

  const { state, projection } = context;
  if (projection.workspace.role === "viewer") {
    await resyncWorkspace(context.workspaceId, "viewer local create rejected");
    return;
  }

  if (node.url) {
    const parentBackendId = projection.backendIdByChromeId[node.parentId ?? ""];
    if (!parentBackendId) {
      if (projection.workspaceChromeId && node.parentId === projection.workspaceChromeId) {
        await relocateToLocalOnly(context.workspaceId, projection, id, "created-outside-canonical-folder");
        return;
      }
      await resyncWorkspace(context.workspaceId, "bookmark create outside canonical folder boundary");
      return;
    }
    try {
      const { resource, ack } = await apiCreateBookmark(state.settings.backendUrl, state.session!, context.workspaceId, {
        folderId: parentBackendId,
        title: node.title,
        url: node.url,
        position: node.index,
      }, projection.lastCursor);
      await settleLocalMutation(context.workspaceId, ack.cursor, (current) => {
        setMapping(current, resource.id, id, "bookmark");
      });
    } catch (error) {
      await logRejectedMutation(context.workspaceId, "bookmark create rejected by backend", error);
      return;
    }
    return;
  }

  try {
    const { resource, ack } = await apiCreateFolder(state.settings.backendUrl, state.session!, context.workspaceId, {
      parentId: resolveParentBackendId(projection, node.parentId),
      name: node.title,
      position: node.index,
    }, projection.lastCursor);
    await settleLocalMutation(context.workspaceId, ack.cursor, (current) => {
      setMapping(current, resource.id, id, "folder");
    });
  } catch (error) {
    await logRejectedMutation(context.workspaceId, "folder create rejected by backend", error);
  }
}

export async function handleBookmarkChanged(id: string, changeInfo: BookmarkChangeInfo): Promise<void> {
  const context = await resolveContext(id);
  if (!context?.backendId || !context.entityType) {
    return;
  }
  const node = await getNode(id);
  if (node && await consumeRemoteUpdate({ projection: context.projection, workspaceId: context.workspaceId, backendId: context.backendId, entityType: context.entityType }, id, node)) return;
  if (isSuppressed(id)) return;
  if (isMutationAbandoned(context.workspaceId, context.backendId, id)) {
    return;
  }
  if (context.projection.workspace.role === "viewer") {
    await resyncWorkspace(context.workspaceId, "viewer local change rejected");
    return;
  }
  await captureLocalUpdateOrMove({
    projection: context.projection,
    workspaceId: context.workspaceId,
    backendId: context.backendId,
    entityType: context.entityType,
  }, id, "changed");
}

export async function handleBookmarkMoved(id: string, moveInfo: BookmarkMoveInfo): Promise<void> {
  const context = await resolveContext(id);
  if (!context?.backendId || !context.entityType) {
    return;
  }
  const node = await getNode(id);
  if (node && await isWithinWorkspace(node, context.projection.workspaceChromeId) && await consumeRemoteMove({ projection: context.projection, workspaceId: context.workspaceId, backendId: context.backendId, entityType: context.entityType }, id, node, moveInfo)) return;
  if (isSuppressed(id)) return;
  if (isMutationAbandoned(context.workspaceId, context.backendId, id)) {
    return;
  }
  if (context.projection.workspace.role === "viewer") {
    await resyncWorkspace(context.workspaceId, "viewer local move rejected");
    return;
  }

  await captureLocalUpdateOrMove({
    projection: context.projection,
    workspaceId: context.workspaceId,
    backendId: context.backendId,
    entityType: context.entityType,
  }, id, "moved");
}

export async function handleBookmarkRemoved(id: string, removeInfo: BookmarkRemoveInfo): Promise<void> {
  if (await ownsRemoteDelete(id, removeInfo)) return;
  if (isSuppressed(id)) {
    return;
  }

  const context = await resolveContext(id);
  if (!context) {
    const state = await getState();
    for (const workspaceId of state.selectedWorkspaceIds) {
      const projection = state.projectionsByWorkspaceId[workspaceId];
      if (!projection) {
        continue;
      }
      if ([projection.rootChromeId, projection.organizationChromeId, projection.workspaceChromeId].includes(id)) {
        await resyncWorkspace(workspaceId, "managed synthetic root removed locally");
        return;
      }
    }
    return;
  }

  if (!context.backendId) {
    await resyncWorkspace(context.workspaceId, "managed synthetic root removed locally");
    return;
  }

  if (isMutationAbandoned(context.workspaceId, context.backendId, id)) {
    return;
  }

  if (context.projection.workspace.role === "viewer") {
    await updateState((state) => {
      const projection = state.projectionsByWorkspaceId[context.workspaceId];
      if (!projection) {
        return state;
      }
      addExclusion(projection, context.backendId!);
      return { ...state };
    });
    await resyncWorkspace(context.workspaceId, "viewer exclusion applied locally");
    return;
  }

  try {
    let ack;
    if (context.entityType === "folder") {
      ack = await apiDeleteFolder(context.state.settings.backendUrl, context.state.session!, context.backendId, context.projection.lastCursor);
    } else {
      ack = await apiDeleteBookmark(context.state.settings.backendUrl, context.state.session!, context.backendId, context.projection.lastCursor);
    }
    const removedChromeIds = removeInfo.node ? collectChromeIds(removeInfo.node) : [id];
    await settleLocalMutation(context.workspaceId, ack.cursor, (projection) => {
      removeMappingsByChromeIds(projection, removedChromeIds);
    });
  } catch (error) {
    await logRejectedMutation(context.workspaceId, "local delete rejected by backend", error);
  }
}

async function syncSelectedWorkspaces(reason: string): Promise<void> {
  const state = await getState();
  if (!state.session) {
    return;
  }

  await refreshWorkspaceCatalog(state.session, state.settings.backendUrl);
  const refreshed = await getState();
  for (const workspaceId of refreshed.selectedWorkspaceIds) {
    await ensureWorkspaceProjection(workspaceId, reason);
    await connectWorkspace(workspaceId);
  }
}

async function ensureWorkspaceProjection(workspaceId: string, reason: string): Promise<void> {
  const state = await getState();
  if (!state.session) {
    return;
  }
  const workspace = resolveWorkspace(state, workspaceId);
  if (!workspace) {
    return;
  }

  await updateProjectionState(workspaceId, (projection) => {
    projection.workspace = workspace;
  }, workspace);

  const latest = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!latest || needsBootstrap(latest)) {
    await pauseWorkspace(workspaceId, latest?.lastCursor ?? 0, "bootstrap-required");
  }
}

async function connectWorkspace(workspaceId: string): Promise<void> {
  const active = socketConnectFlights.get(workspaceId);
  if (active) {
    return active;
  }
  const flight = connectWorkspaceNow(workspaceId).finally(() => {
    if (socketConnectFlights.get(workspaceId) === flight) {
      socketConnectFlights.delete(workspaceId);
    }
  });
  socketConnectFlights.set(workspaceId, flight);
  return flight;
}

async function connectWorkspaceNow(workspaceId: string): Promise<void> {
  const state = await getState();
  const projection = state.projectionsByWorkspaceId[workspaceId];
  if (!state.session || !state.selectedWorkspaceIds.includes(workspaceId) || !projection) {
    return;
  }

  closeWorkspaceSocket(workspaceId);
  const token = Symbol(workspaceId);
  socketTokens.set(workspaceId, token);
  const isCurrent = (latest: typeof state): boolean => socketTokens.get(workspaceId) === token
    && Boolean(latest.session)
    && latest.authState !== "loginRequired"
    && latest.selectedWorkspaceIds.includes(workspaceId)
    && Boolean(latest.projectionsByWorkspaceId[workspaceId]);

  let ticket: string;
  try {
    ticket = (await createWSTicket(state.settings.backendUrl, state.session)).ticket;
  } catch {
    const latest = await getState();
    if (!isCurrent(latest)) {
      return;
    }
    await log(`ws:${workspaceId}`, "websocket ticket unavailable", "warn");
    if (await enterRecovery(workspaceId, "websocket ticket unavailable")) {
      setTimeout(() => { void connectWorkspace(workspaceId); }, 250);
    }
    return;
  }

  const latest = await getState();
  if (!isCurrent(latest)) {
    return;
  }

  const isActiveSocket = (): boolean => socketTokens.get(workspaceId) === token;
  const close = connectWorkspaceSocket(latest.settings.backendUrl, workspaceId, ticket, {
    onAck: async (currentCursor) => {
      if (!isActiveSocket()) {
        return;
      }
      const latest = await getState();
      const current = latest.projectionsByWorkspaceId[workspaceId];
      if (!current || !latest.session) {
        return;
      }
      await markSocketState(workspaceId, true);
      if (currentCursor < current.lastCursor) {
        await recoverWorkspace(workspaceId, `server cursor ${currentCursor} is behind local cursor ${current.lastCursor}`, "resync");
        return;
      }
      if (currentCursor > current.lastCursor) {
        await replayWorkspaceDelta(workspaceId, current.lastCursor, "resume after socket ack");
        return;
      }
      await markProjectionLive(workspaceId);
      await drainLocalIntents(workspaceId, "socket acknowledged");
    },
    onEvent: async (event) => {
      if (!isActiveSocket()) {
        return;
      }
      await enqueueLiveRemoteEnvelope(workspaceId, event);
    },
    onResyncRequired: async (reason) => {
      if (!isActiveSocket()) {
        return;
      }
      await recoverWorkspace(workspaceId, reason, "resync");
    },
    onClose: async () => {
      if (!isActiveSocket()) {
        return;
      }
      socketTokens.delete(workspaceId);
      await markSocketState(workspaceId, false);
      await recoverWorkspace(workspaceId, "websocket closed", "reconnect");
    },
    onError: async (message) => {
      if (!isActiveSocket()) {
        return;
      }
      await log(`ws:${workspaceId}`, message, "warn");
    },
  });

  socketClosers.set(workspaceId, () => {
    if (socketTokens.get(workspaceId) === token) {
      socketTokens.delete(workspaceId);
    }
    close();
  });
}

async function replayWorkspaceDelta(workspaceId: string, afterCursor: number, reason: string): Promise<void> {
  const state = await getState();
  if (!state.session) {
    return;
  }
  const replay = await replayEvents(state.settings.backendUrl, state.session, workspaceId, afterCursor);
  if (replay.resyncRequired) {
    await recoverWorkspace(workspaceId, `replay gap requires resync (${reason})`, "resync");
    return;
  }
  for (const event of replay.events) {
    await applyRemoteEnvelope(workspaceId, event, true);
    const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
    if (!projection || projection.lastCursor < event.cursor) return;
  }
  await markProjectionLive(workspaceId, replay.currentCursor);
  await drainLocalIntents(workspaceId, reason);
  await log(`sync:${workspaceId}`, `replayed workspace delta (${reason})`, "info");
}

export async function runCoalescedWorkspaceTask(
  locks: Map<string, WorkspaceResyncLock>,
  workspaceId: string,
  reason: string,
  runner: (reason: string) => Promise<void>,
): Promise<void> {
  const active = locks.get(workspaceId);
  if (active) {
    active.rerunRequested = true;
    active.latestReason = reason;
    await active.active;
    return;
  }

  const lock: WorkspaceResyncLock = {
    active: Promise.resolve(),
    rerunRequested: false,
    latestReason: reason,
  };

  lock.active = (async () => {
    try {
      do {
        const currentReason = lock.latestReason;
        lock.rerunRequested = false;
        await runner(currentReason);
      } while (lock.rerunRequested);
    } finally {
      if (locks.get(workspaceId) === lock) {
        locks.delete(workspaceId);
      }
      lock.rerunRequested = false;
    }
  })();

  locks.set(workspaceId, lock);
  await lock.active;
}

async function resyncWorkspace(workspaceId: string, reason: string): Promise<void> {
  await pauseWorkspace(workspaceId, (await getState()).projectionsByWorkspaceId[workspaceId]?.lastCursor ?? 0, "ambiguous-predecessor");
  await log(`repair:${workspaceId}`, `automatic resync disabled: ${reason}`, "warn");
}

async function logRejectedMutation(
  workspaceId: string,
  summary: string,
  error: unknown,
  scope?: RecoveryScope,
): Promise<void> {
  const detail = describeError(error);
  await log(`mutation:${workspaceId}`, `${summary}: ${detail}`, "error");
  if (scope && isCascadeRecoveryError(error)) {
    await abandonLocalMutation(scope);
    await recoverSubtreeThenWorkspace(scope, `${summary} (${detail})`);
    return;
  }
  await resyncWorkspace(workspaceId, `${summary} (${detail})`);
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `HTTP ${error.status}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildUiState(state: ExtensionState): UiState {
  const activitySignal = ensureActivitySignal(state);
  const statusOverview = buildStatusOverview(state);
  return {
    state: {
      ...state,
      session: state.session ? { ...state.session, accessToken: "" } : null,
      activitySignal,
      statusOverview,
    },
  };
}

function ensureActivitySignal(state: Pick<ExtensionState, "activitySignal" | "projectionsByWorkspaceId">): ActivitySignal {
  const revision = Math.max(
    state.activitySignal?.revision ?? 0,
    ...Object.values(state.projectionsByWorkspaceId).map((projection) => projection.activityRevision ?? 0),
  );
  return {
    revision,
    lastSeenRevision: Math.min(state.activitySignal?.lastSeenRevision ?? 0, revision),
  };
}

function buildStatusOverview(state: ExtensionState): StatusOverview {
  const projections = Object.values(state.projectionsByWorkspaceId);
  return {
    selectedWorkspaceCount: state.selectedWorkspaceIds.length,
    activeWorkspaceCount: projections.length,
    liveWorkspaceCount: projections.filter((projection) => projection.socketConnected || projection.health === "live").length,
    degradedWorkspaceCount: projections.filter((projection) => projection.health === "degraded").length,
  };
}

async function doResyncWorkspace(workspaceId: string, reason: string, targetHealth: ProjectionState["health"] = "bootstrap"): Promise<boolean> {
  const state = await getState();
  if (!state.session) {
    return false;
  }
  const workspace = resolveWorkspace(state, workspaceId);
  if (!workspace) {
    return false;
  }

  await updateProjectionState(workspaceId, (projection) => {
    projection.status = "syncing";
    projection.health = targetHealth;
    projection.lastError = undefined;
  }, workspace);

  try {
    const tree = await getWorkspaceTree(state.settings.backendUrl, state.session, workspaceId);
    const path = await ensureManagedPath(tree.workspace.organizationName, tree.workspace.workspaceName);

    await updateProjectionState(workspaceId, (projection) => {
      projection.rootChromeId = path.rootId;
      projection.organizationChromeId = path.organizationId;
      projection.workspaceChromeId = path.workspaceId;
      projection.workspace = tree.workspace;
      projection.chromeIdByBackendId = {};
      projection.backendIdByChromeId = {};
      projection.entityTypeByBackendId = {};
    }, tree.workspace);

    const validIds = collectBackendIds(tree);
    await updateProjectionState(workspaceId, (projection) => {
      pruneExclusions(projection, validIds);
    }, tree.workspace);

    const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
    if (!projection?.workspaceChromeId) {
      throw new Error("missing workspace chrome folder after path creation");
    }

    const workspaceChromeId = projection.workspaceChromeId;
    const localOnlyChromeId = await ensureLocalOnlyFolder(workspaceId, workspaceChromeId);
    const removedIds = await clearManagedChildrenWithSuppression(workspaceChromeId, [localOnlyChromeId]);
    await updateProjectionState(workspaceId, (current) => {
      removeMappingsByChromeIds(current, removedIds);
    });

    const latest = (await getState()).projectionsByWorkspaceId[workspaceId];
    if (!latest?.workspaceChromeId) {
      throw new Error("projection state disappeared during resync");
    }

    for (const folder of filterFoldersForProjection(tree.folders, latest)) {
      await materializeFolder(workspaceId, latest.workspaceChromeId, folder);
    }

    const replay = await replayEvents(state.settings.backendUrl, state.session, workspaceId, 0);
    for (const event of replay.events) {
      await applyRemoteEnvelope(workspaceId, event, true);
      if ((await getState()).projectionsByWorkspaceId[workspaceId]?.lastCursor < event.cursor) throw new Error("rebuild replay did not checkpoint");
    }

    await updateProjectionState(workspaceId, (projectionState) => {
      projectionState.lastCursor = Math.max(projectionState.lastCursor, replay.currentCursor);
      projectionState.lastSyncedAt = new Date().toISOString();
      projectionState.status = "ready";
      projectionState.health = projectionState.socketConnected ? "live" : targetHealth;
      projectionState.lastError = undefined;
      if (projectionState.convergenceJournal) {
        projectionState.convergenceJournal.phase = "live";
        projectionState.convergenceJournal.pauseReason = undefined;
        projectionState.convergenceJournal.failedCursor = undefined;
      }
      if (projectionState.health === "live") {
        projectionState.recoveryAttemptCount = 0;
        projectionState.recoveryStartedAt = undefined;
        projectionState.degradedAt = undefined;
        projectionState.degradedReason = undefined;
      }
    }, tree.workspace);
    await recordActivity(workspaceId);
    await log(`sync:${workspaceId}`, `resynced workspace (${reason})`, "info");
    return true;
  } catch {
    try {
      await pauseWorkspace(workspaceId, (await getState()).projectionsByWorkspaceId[workspaceId]?.lastCursor ?? 0, "chrome-effect-rejected");
    } catch {
      volatileRepairGates.set(workspaceId, "chrome-effect-rejected");
    }
    return false;
  }
}

async function ensureLocalOnlyFolder(workspaceId: string, workspaceChromeId: string): Promise<string> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  const existingId = projection?.localOnlyChromeId;
  if (existingId) {
    const existingNode = await getNode(existingId);
    if (existingNode && existingNode.parentId === workspaceChromeId) {
      return existingId;
    }
  }

  const children = await getChildren(workspaceChromeId);
  const reused = children.find((child) => !child.url && child.title === LOCAL_ONLY_FOLDER_TITLE);
  const folderNode = reused ?? await withSuppression(
    async () => createFolder(workspaceChromeId, LOCAL_ONLY_FOLDER_TITLE),
    [workspaceChromeId],
  );

  await updateProjectionState(workspaceId, (current) => {
    current.localOnlyChromeId = folderNode.id;
  });
  return folderNode.id;
}

async function relocateToLocalOnly(workspaceId: string, projection: ProjectionState, chromeId: string, reason: string): Promise<void> {
  if (!projection.workspaceChromeId) {
    return;
  }
  const localOnlyChromeId = await ensureLocalOnlyFolder(workspaceId, projection.workspaceChromeId);
  if (chromeId === localOnlyChromeId) {
    return;
  }
  try {
    await moveNode(chromeId, { parentId: localOnlyChromeId });
  } catch (error) {
    await log(`sync:${workspaceId}`, `local-only relocation failed: ${describeError(error)}`, "warn");
    return;
  }
  await log(`sync:${workspaceId}`, `event=local_only_relocated workspaceId=${workspaceId} chromeId=${chromeId} reason=${reason}`, "info");
}

async function materializeFolder(workspaceId: string, parentChromeId: string, folder: FolderNode): Promise<void> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection || isExcluded(projection, folder.id)) {
    return;
  }
  const node = await withSuppression(
    async () => createFolder(parentChromeId, folder.name, folder.position),
    [parentChromeId],
  );
  await updateProjectionState(workspaceId, (current) => {
    setMapping(current, folder.id, node.id, "folder");
  });
  for (const bookmark of folder.bookmarks) {
    await materializeBookmark(workspaceId, node.id, bookmark);
  }
  for (const childFolder of folder.folders) {
    await materializeFolder(workspaceId, node.id, childFolder);
  }
}

async function materializeBookmark(workspaceId: string, parentChromeId: string, bookmark: BookmarkNode): Promise<void> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection || isExcluded(projection, bookmark.id)) {
    return;
  }
  const node = await withSuppression(
    async () => createBookmark(parentChromeId, bookmark.title, bookmark.url, bookmark.position),
    [parentChromeId],
  );
  await updateProjectionState(workspaceId, (current) => {
    setMapping(current, bookmark.id, node.id, "bookmark");
  });
}

async function applyRemoteEnvelope(workspaceId: string, event: SyncEnvelope, allowReplayCatchup = false): Promise<void> {
  if (volatileRepairGates.has(workspaceId)) return;
  const state = await getState();
  const projection = state.projectionsByWorkspaceId[workspaceId];
  if (!projection) {
    return;
  }

  const action = allowReplayCatchup ? "replay" : "live-apply";
  const baseContext = createRemoteEventContext(event, { action, projectionCursor: projection.lastCursor });

  if (event.cursor <= projection.lastCursor) {
    return;
  }
  if (projection.convergenceJournal?.phase === "paused") return;
  if (projection.convergenceJournal?.receipts?.some((receipt) => receipt.status === "pending")) {
    if (!canPersistReceipt(projection.convergenceJournal, event.cursor)) await pauseWorkspace(workspaceId, event.cursor, "receipt-capacity");
    return;
  }
  if (!allowReplayCatchup && projection.lastCursor > 0 && event.cursor !== projection.lastCursor + 1) {
    await logRemoteApplyDiagnostic(workspaceId, {
      ...baseContext,
      action: "replay",
      reason: "cursor-gap",
      expectedCursor: projection.lastCursor + 1,
    });
    await recoverWorkspace(workspaceId, `cursor gap detected at ${projection.lastCursor} for ${event.kind}`, "replay");
    return;
  }

  try {
    let shouldRecordActivity = false;
    let deferCheckpoint = false;
    let activityDetail: ProjectionActivityDetail | undefined;
    switch (event.kind) {
      case "folder.created":
      case "folder.updated":
        deferCheckpoint = await applyRemoteFolderUpsert(workspaceId, event, event.payload as FolderResource, action);
        shouldRecordActivity = true;
        activityDetail = createEntityActivityDetail(
          "folder",
          event.kind === "folder.created" ? "created" : "updated",
          (event.payload as FolderResource).name,
        );
        break;
      case "folder.deleted":
        activityDetail = await applyRemoteFolderDelete(workspaceId, event, parseFolderDeletePayload(event.payload), action, allowReplayCatchup);
        shouldRecordActivity = true;
        break;
      case "bookmark.created":
      case "bookmark.updated":
        deferCheckpoint = await applyRemoteBookmarkUpsert(workspaceId, event, event.payload as BookmarkResource, action);
        shouldRecordActivity = true;
        activityDetail = createEntityActivityDetail(
          "bookmark",
          event.kind === "bookmark.created" ? "created" : "updated",
          (event.payload as BookmarkResource).title,
        );
        break;
      case "bookmark.deleted":
        activityDetail = await applyRemoteBookmarkDelete(workspaceId, event, parseBookmarkDeletePayload(event.payload), action, allowReplayCatchup);
        shouldRecordActivity = true;
        break;
      default:
        await log(`sync:${workspaceId}`, `ignored unsupported event ${event.kind}`, "warn");
    }

    await updateProjectionState(workspaceId, (current) => {
      if (!deferCheckpoint) current.lastCursor = Math.max(current.lastCursor, event.cursor);
      current.lastSyncedAt = new Date().toISOString();
      current.status = "ready";
      current.health = current.socketConnected ? "live" : current.health;
      current.lastError = undefined;
    });
    if (shouldRecordActivity) {
      await recordActivity(workspaceId, {
        occurredAt: event.createdAt,
        detail: activityDetail,
      });
    }
  } catch (error) {
    const context = error instanceof RemoteApplyError ? error.context : baseContext;
    const gate = error instanceof RemoteDeleteReadError ? "complete-node-read-failed" : error instanceof RemoteApplyError ? error.gate : "chrome-effect-rejected";
    if (gate === "durable-write-failed") volatileRepairGates.set(workspaceId, gate);
    try {
      await logRemoteApplyDiagnostic(workspaceId, { ...context, action: "paused", failure: "remote effect gate failed" }, "warn");
      await log(`sync:${workspaceId}`, `remote apply paused at cursor ${event.cursor}`, "warn");
    } catch {}
    try {
      await pauseWorkspace(workspaceId, event.cursor, gate);
      volatileRepairGates.delete(workspaceId);
    } catch {
      volatileRepairGates.set(workspaceId, gate);
    }
  }
}

function enqueueLiveRemoteEnvelope(workspaceId: string, event: SyncEnvelope): Promise<void> {
  const previous = liveApplyQueues.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => applyRemoteEnvelope(workspaceId, event));
  liveApplyQueues.set(workspaceId, next);
  void next.then(
    () => { if (liveApplyQueues.get(workspaceId) === next) liveApplyQueues.delete(workspaceId); },
    () => { if (liveApplyQueues.get(workspaceId) === next) liveApplyQueues.delete(workspaceId); },
  );
  return next;
}

async function applyRemoteFolderUpsert(
  workspaceId: string,
  event: SyncEnvelope,
  folder: FolderResource,
  action: "live-apply" | "replay",
): Promise<boolean> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection?.workspaceChromeId) {
    throw new Error("workspace projection missing for folder upsert");
  }

  const scope = createRecoveryScope({
    workspaceId,
    entityType: "folder",
    entityBackendId: folder.id,
    parentBackendId: folder.parentId,
    mappedChromeId: projection.chromeIdByBackendId[folder.id],
    reason: "missing-parent",
  });

  if (isExcluded(projection, folder.id) || isExcluded(projection, folder.parentId)) {
    const hiddenChromeId = projection.chromeIdByBackendId[folder.id];
    if (hiddenChromeId) {
      await deleteChromeNode(workspaceId, hiddenChromeId, folder.id, "folder");
    }
    return false;
  }

  const parentChromeId = folder.parentId ? projection.chromeIdByBackendId[folder.parentId] : projection.workspaceChromeId;
  const validation = await validateRecoveryScope(scope, parentChromeId);
  if (validation.status !== "valid") {
    await recoverSubtreeThenWorkspace(scope, validation.reason, validation.invalidateBackendIds);
    return false;
  }

  const parentState = await inspectChromeParent(parentChromeId);
  const baseContext = createRemoteEventContext(event, {
    action,
    operation: "folder-upsert",
    backendParentId: folder.parentId ?? "workspace-root",
    expectedParentChromeId: parentChromeId,
    mappedChromeId: projection.chromeIdByBackendId[folder.id],
    currentChildCount: parentState.currentChildCount,
    requestedIndex: folder.position,
  });

  const chromeId = await reconcileFolderChromeNode(workspaceId, projection, folder, parentChromeId, scope);
  if (chromeId === null) {
    return false;
  }
  if (!chromeId) {
    await logRemoteApplyDiagnostic(workspaceId, {
      ...baseContext,
      branch: "create",
    });
    const ownership = await startRemoteCreate(workspaceId, event, folder.id, "folder", parentChromeId, folder.name, undefined, folder.position);
    if (!ownership) return false;
    const created = await withSuppression(
      async () => {
        try {
          return await createFolder(parentChromeId, folder.name, folder.position);
        } catch (error) {
          throw createRemoteApplyError(error, {
            ...baseContext,
            branch: "create",
          });
        }
      },
      [parentChromeId],
    );
    await updateProjectionState(workspaceId, (current) => {
      setMapping(current, folder.id, created.id, "folder");
    });
    await finishRemoteCreate(workspaceId, ownership, created.id);
    return false;
  }

  const existing = await getNode(chromeId);
  if (!existing) {
    throw new RemoteApplyError("stale folder mapping", baseContext, "complete-node-read-failed");
  }
  const existingContext = {
    ...baseContext,
    branch: existing.parentId !== parentChromeId || existing.index !== folder.position ? "move" : "update",
    currentChromeId: chromeId,
    currentParentChromeId: existing.parentId,
    currentIndex: existing.index,
  };
  await logRemoteApplyDiagnostic(workspaceId, existingContext);
  if (existing.parentId !== parentChromeId || existing.index !== folder.position) {
    if (!canPersistReceipt(projection.convergenceJournal ?? emptyJournal(), event.cursor)) { await pauseWorkspace(workspaceId, event.cursor, "receipt-capacity"); return true; }
    if (existing.parentId === undefined || existing.index === undefined) throw new RemoteApplyError("remote folder move predecessor is incomplete", existingContext, "ambiguous-predecessor");
    await persistRemoteReceipt(workspaceId, event, folder.id, chromeId, "folder", existing, { parentId: parentChromeId, index: folder.position, title: folder.name }, { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: folder.position });
    if (existing.title !== folder.name) await updateNode(chromeId, { title: folder.name });
    await moveNode(chromeId, { parentId: parentChromeId, index: folder.position });
    return true;
  }
  const updateReceipt = existing.title !== folder.name;
  if (updateReceipt && !canPersistReceipt(projection.convergenceJournal ?? emptyJournal(), event.cursor)) { await pauseWorkspace(workspaceId, event.cursor, "receipt-capacity"); return true; }
  if (updateReceipt) await persistRemoteReceipt(workspaceId, event, folder.id, chromeId, "folder", existing, { parentId: existing.parentId!, index: existing.index!, title: folder.name });
  if (updateReceipt) await updateNode(chromeId, { title: folder.name });
  return updateReceipt;
}

async function applyRemoteBookmarkUpsert(
  workspaceId: string,
  event: SyncEnvelope,
  bookmark: BookmarkResource,
  action: "live-apply" | "replay",
): Promise<boolean> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) {
    throw new Error("workspace projection missing for bookmark upsert");
  }

  const scope = createRecoveryScope({
    workspaceId,
    entityType: "bookmark",
    entityBackendId: bookmark.id,
    parentBackendId: bookmark.folderId,
    mappedChromeId: projection.chromeIdByBackendId[bookmark.id],
    reason: "missing-parent",
  });

  if (isExcluded(projection, bookmark.id) || isExcluded(projection, bookmark.folderId)) {
    const hiddenChromeId = projection.chromeIdByBackendId[bookmark.id];
    if (hiddenChromeId) {
      await deleteChromeNode(workspaceId, hiddenChromeId, bookmark.id, "bookmark");
    }
    return false;
  }

  const parentChromeId = projection.chromeIdByBackendId[bookmark.folderId];
  const validation = await validateRecoveryScope(scope, parentChromeId);
  if (validation.status !== "valid") {
    await recoverSubtreeThenWorkspace(scope, validation.reason, validation.invalidateBackendIds);
    return false;
  }

  const parentState = await inspectChromeParent(parentChromeId);
  const baseContext = createRemoteEventContext(event, {
    action,
    operation: "bookmark-upsert",
    backendParentId: bookmark.folderId,
    expectedParentChromeId: parentChromeId,
    mappedChromeId: projection.chromeIdByBackendId[bookmark.id],
    currentChildCount: parentState.currentChildCount,
    requestedIndex: bookmark.position,
  });

  const chromeId = await reconcileBookmarkChromeNode(workspaceId, projection, bookmark, parentChromeId, scope);
  if (chromeId === null) {
    return false;
  }
  if (!chromeId) {
    await logRemoteApplyDiagnostic(workspaceId, {
      ...baseContext,
      branch: "create",
    });
    const ownership = await startRemoteCreate(workspaceId, event, bookmark.id, "bookmark", parentChromeId, bookmark.title, bookmark.url, bookmark.position);
    if (!ownership) return false;
    const created = await withSuppression(
      async () => {
        try {
          return await createBookmark(parentChromeId, bookmark.title, bookmark.url, bookmark.position);
        } catch (error) {
          throw createRemoteApplyError(error, {
            ...baseContext,
            branch: "create",
          });
        }
      },
      [parentChromeId],
    );
    await updateProjectionState(workspaceId, (current) => {
      setMapping(current, bookmark.id, created.id, "bookmark");
    });
    await finishRemoteCreate(workspaceId, ownership, created.id);
    return false;
  }

  const existing = await getNode(chromeId);
  if (!existing) {
    throw new RemoteApplyError("stale bookmark mapping", baseContext, "complete-node-read-failed");
  }

  const existingContext = {
    ...baseContext,
    branch: existing.parentId !== parentChromeId || existing.index !== bookmark.position ? "move" : "update",
    currentChromeId: chromeId,
    currentParentChromeId: existing.parentId,
    currentIndex: existing.index,
  };
  await logRemoteApplyDiagnostic(workspaceId, existingContext);

  if (existing.parentId !== parentChromeId || existing.index !== bookmark.position) {
    if (!canPersistReceipt(projection.convergenceJournal ?? emptyJournal(), event.cursor)) { await pauseWorkspace(workspaceId, event.cursor, "receipt-capacity"); return true; }
    if (existing.parentId === undefined || existing.index === undefined) throw new RemoteApplyError("remote bookmark move predecessor is incomplete", existingContext, "ambiguous-predecessor");
    await persistRemoteReceipt(workspaceId, event, bookmark.id, chromeId, "bookmark", existing, { parentId: parentChromeId, index: bookmark.position, title: bookmark.title, url: bookmark.url }, { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: bookmark.position });
    if (existing.title !== bookmark.title || existing.url !== bookmark.url) await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
    await moveNode(chromeId, { parentId: parentChromeId, index: bookmark.position });
    return true;
  }

  const updateReceipt = existing.title !== bookmark.title || existing.url !== bookmark.url;
  if (updateReceipt && !canPersistReceipt(projection.convergenceJournal ?? emptyJournal(), event.cursor)) { await pauseWorkspace(workspaceId, event.cursor, "receipt-capacity"); return true; }
  if (updateReceipt) await persistRemoteReceipt(workspaceId, event, bookmark.id, chromeId, "bookmark", existing, { parentId: existing.parentId!, index: existing.index!, title: bookmark.title, url: bookmark.url });
  try {
    if (existing.title !== bookmark.title || existing.url !== bookmark.url) {
      await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
    }
  } catch (error) {
    throw createRemoteApplyError(error, existingContext);
  }

  const finalNode = await getNode(chromeId);
  if (!finalNode) {
    throw new RemoteApplyError("remote bookmark missing after apply", existingContext, "complete-node-read-failed");
  }
  if (finalNode.parentId !== parentChromeId || finalNode.index !== bookmark.position) {
    throw new RemoteApplyError("remote bookmark final parent/index mismatch after apply", existingContext, "final-verification-failed");
  }
  return updateReceipt;
}

async function consumeRemoteUpdate(context: LocalIntentContext, chromeId: string, node: chrome.bookmarks.BookmarkTreeNode): Promise<boolean> {
  return consumeRemoteCallback(context, chromeId, node, "changed");
}

async function consumeRemoteMove(context: LocalIntentContext, chromeId: string, node: chrome.bookmarks.BookmarkTreeNode, move: BookmarkMoveInfo): Promise<boolean> {
  return consumeRemoteCallback(context, chromeId, node, "moved", move);
}

async function consumeRemoteCallback(context: LocalIntentContext, chromeId: string, node: chrome.bookmarks.BookmarkTreeNode, kind: "changed" | "moved", move?: BookmarkMoveInfo): Promise<boolean> {
  let consumed = false;
  await updateProjectionState(context.workspaceId, (projection) => {
    const before = projection.convergenceJournal?.receipts ?? [];
    const result = reduceRemoteCallback(projection.convergenceJournal ?? emptyJournal(), {
      kind, workspaceId: context.workspaceId, backendId: context.backendId, chromeId, type: context.entityType,
      node: { parentId: node.parentId, index: node.index, title: node.title, url: node.url }, move,
    });
    projection.convergenceJournal = result.journal;
    if (result.disposition === "consumed") {
      const pendingReceipt = result.journal.receipts?.find((receipt, index) => before[index]?.status === "pending" && receipt.status === "consumed");
      if (pendingReceipt) projection.lastCursor = Math.max(projection.lastCursor, pendingReceipt.cursor);
      consumed = true;
    } else if (before.some((receipt) => receipt.status === "pending" && receipt.workspaceId === context.workspaceId && receipt.backendId === context.backendId && receipt.chromeId === chromeId)) {
      projection.convergenceJournal = gateRemoteEffect(result.journal, before.find((receipt) => receipt.status === "pending" && receipt.workspaceId === context.workspaceId && receipt.backendId === context.backendId && receipt.chromeId === chromeId)?.cursor ?? projection.lastCursor, "final-verification-failed");
    }
  });
  return consumed;
}

async function persistRemoteReceipt(workspaceId: string, event: SyncEnvelope, backendId: string, chromeId: string, type: "folder" | "bookmark", before: chrome.bookmarks.BookmarkTreeNode, expectedAfter: { parentId: string; index: number; title: string; url?: string }, move?: { oldParentId: string; oldIndex: number; parentId: string; index: number }): Promise<void> {
  try {
    await updateProjectionState(workspaceId, (current) => {
      const journal = current.convergenceJournal ?? emptyJournal();
      journal.receipts = normalizedReceipts(journal.receipts);
      const pending = journal.receipts.some((receipt) => receipt.status === "pending" && receipt.workspaceId === workspaceId && receipt.backendId === backendId && receipt.chromeId === chromeId && receipt.type === type);
      if (!pending) journal.receipts.push(createRemoteReceipt({ workspaceId, backendId, chromeId, type, before: { parentId: before.parentId, index: before.index, title: before.title, url: before.url }, expectedAfter, eventId: event.eventId, cursor: event.cursor, move }));
      current.convergenceJournal = journal;
    });
  } catch {
    throw new RemoteApplyError("durable receipt write failed", createRemoteEventContext(event, { operation: "receipt-write", backendId, chromeId }), "durable-write-failed");
  }
}

async function applyRemoteFolderDelete(
  workspaceId: string,
  event: SyncEnvelope,
  payload: { id: string; parentId?: string },
  action: "live-apply" | "replay",
  allowReplayCatchup = false,
): Promise<ProjectionActivityDetail | undefined> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) {
    return undefined;
  }
  const scope = createRecoveryScope({
    workspaceId,
    entityType: "folder",
    entityBackendId: payload.id,
    parentBackendId: payload.parentId,
    mappedChromeId: projection.chromeIdByBackendId[payload.id],
    reason: "stale-mapping",
    pruneExclusions: true,
  });
  const parentChromeId = payload.parentId ? projection.chromeIdByBackendId[payload.parentId] : projection.workspaceChromeId;
  const validation = await validateRecoveryScope(scope, parentChromeId, true);
  if (validation.status !== "valid") {
    await invalidateSubtreeMappings(scope, [...(validation.invalidateBackendIds ?? []), payload.id]);
    if (!allowReplayCatchup) {
      await recoverSubtreeThenWorkspace(scope, validation.reason, validation.invalidateBackendIds);
    }
    return createEntityActivityDetail("folder", "deleted", `Folder ${payload.id}`);
  }
  const chromeId = projection.chromeIdByBackendId[payload.id];
  if (!chromeId) {
    await logRemoteApplyDiagnostic(workspaceId, createRemoteEventContext(event, {
      action,
      operation: "folder-delete",
      branch: "mapping-miss",
    }));
    await invalidateSubtreeMappings(scope, [payload.id]);
    if (!allowReplayCatchup) {
      await recoverSubtreeThenWorkspace(scope, "remote folder delete pruned stale mapping", [payload.id]);
    }
    return createEntityActivityDetail("folder", "deleted", `Folder ${payload.id}`);
  }
  const existing = await getNode(chromeId);
  await logRemoteApplyDiagnostic(workspaceId, createRemoteEventContext(event, {
    action,
    operation: "folder-delete",
    currentChromeId: chromeId,
  }));
  await deleteChromeNode(workspaceId, chromeId, payload.id, "folder", scope.pruneExclusions);
  if (!allowReplayCatchup) {
    await recoverSubtreeThenWorkspace(scope, "remote folder delete pruned excluded descendants");
  }
  return createEntityActivityDetail("folder", "deleted", existing?.title ?? `Folder ${payload.id}`);
}

async function applyRemoteBookmarkDelete(
  workspaceId: string,
  event: SyncEnvelope,
  payload: { id: string; folderId?: string },
  action: "live-apply" | "replay",
  allowReplayCatchup = false,
): Promise<ProjectionActivityDetail | undefined> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) {
    return undefined;
  }
  const scope = createRecoveryScope({
    workspaceId,
    entityType: "bookmark",
    entityBackendId: payload.id,
    parentBackendId: payload.folderId,
    mappedChromeId: projection.chromeIdByBackendId[payload.id],
    reason: "stale-mapping",
    pruneExclusions: true,
  });
  const parentChromeId = payload.folderId ? projection.chromeIdByBackendId[payload.folderId] : projection.workspaceChromeId;
  const validation = await validateRecoveryScope(scope, parentChromeId);
  if (validation.status !== "valid") {
    await invalidateSubtreeMappings(scope, [...(validation.invalidateBackendIds ?? []), payload.id]);
    if (!allowReplayCatchup) {
      await recoverSubtreeThenWorkspace(scope, validation.reason, validation.invalidateBackendIds);
    }
    return createEntityActivityDetail("bookmark", "deleted", `Bookmark ${payload.id}`);
  }
  const chromeId = projection.chromeIdByBackendId[payload.id];
  if (!chromeId) {
    await logRemoteApplyDiagnostic(workspaceId, createRemoteEventContext(event, {
      action,
      operation: "bookmark-delete",
      branch: "mapping-miss",
    }));
    await invalidateSubtreeMappings(scope, [payload.id]);
    return createEntityActivityDetail("bookmark", "deleted", `Bookmark ${payload.id}`);
  }
  const existing = await getNode(chromeId);
  await logRemoteApplyDiagnostic(workspaceId, createRemoteEventContext(event, {
    action,
    operation: "bookmark-delete",
    currentChromeId: chromeId,
  }));
  await deleteChromeNode(workspaceId, chromeId, payload.id, "bookmark", scope.pruneExclusions);
  return createEntityActivityDetail("bookmark", "deleted", existing?.title ?? `Bookmark ${payload.id}`);
}

async function deleteChromeNode(
  workspaceId: string,
  chromeId: string,
  backendId: string,
  entityType: "folder" | "bookmark",
  pruneRemovedExclusions = true,
): Promise<void> {
  const subtree = entityType === "folder" ? await readDeleteSubTree(workspaceId, chromeId) : null;
  const chromeIds = subtree ? collectChromeIds(subtree) : [chromeId];
  const operationId = await startRemoteDelete(workspaceId, backendId, chromeId, entityType, chromeIds);
  if (!operationId) return;
  await withSuppression(async () => {
    if (entityType === "folder") {
      await removeTree(chromeId);
    } else {
      await removeNode(chromeId);
    }
  }, chromeIds);
  await finishRemoteDelete(workspaceId, operationId, pruneRemovedExclusions);
}

async function readDeleteSubTree(workspaceId: string, chromeId: string): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  try {
    return await new Promise((resolve, reject) => {
      chrome.bookmarks.getSubTree(chromeId, (nodes) => {
        const error = chrome.runtime.lastError;
        if (error) { reject(new RemoteDeleteReadError(error.message)); return; }
        resolve(nodes?.[0] ?? null);
      });
    });
  } catch (error) {
    await updateProjectionState(workspaceId, (projection) => {
      const journal = projection.convergenceJournal ?? { version: 1 as const, phase: "live" as const, operations: [], localIntents: [], attempts: 0 };
      journal.phase = "paused";
      journal.pauseReason = "ambiguous-operation";
      projection.convergenceJournal = journal;
    });
    throw error;
  }
}

async function refreshWorkspaceCatalog(session: SessionData, backendUrl: string): Promise<void> {
  const organizations = await getOrganizations(backendUrl, session);
  const workspacesByOrganization: Record<string, WorkspaceAccess[]> = {};
  for (const organization of organizations) {
    workspacesByOrganization[organization.organizationId] = await getWorkspaces(backendUrl, session, organization.organizationId);
  }
  await updateState((state) => ({
    ...state,
    cachedOrganizations: organizations,
    cachedWorkspacesByOrganization: workspacesByOrganization,
  }));
}

async function removeWorkspaceProjection(projection: ProjectionState): Promise<void> {
  if (projection.workspaceChromeId) {
    try {
      const workspaceChromeId = projection.workspaceChromeId;
      await withSuppression(async () => removeTree(workspaceChromeId), [workspaceChromeId]);
    } catch {
      // ignore best-effort cleanup
    }
  }
}

async function clearManagedChildrenWithSuppression(workspaceChromeId: string, excludeIds: string[] = []): Promise<string[]> {
  const subtree = await getSubTree(workspaceChromeId);
  const managedChildIds = (subtree?.children ?? [])
    .filter((child) => !excludeIds.includes(child.id))
    .flatMap((child) => collectChromeIds(child));
  return withSuppression(() => clearChildren(workspaceChromeId, excludeIds), managedChildIds);
}

async function updateProjectionState(
  workspaceId: string,
  updater: (projection: ProjectionState) => void,
  workspace?: WorkspaceAccess,
): Promise<void> {
  await updateState((state) => {
    const current = state.projectionsByWorkspaceId[workspaceId] ?? (workspace ? createProjectionState(workspace) : undefined);
    if (!current) {
      return state;
    }
    updater(current);
    return {
      ...state,
      projectionsByWorkspaceId: {
        ...state.projectionsByWorkspaceId,
        [workspaceId]: current,
      },
    };
  });
}

async function startRemoteCreate(workspaceId: string, event: SyncEnvelope, backendId: string, type: "folder" | "bookmark", parentChromeId: string, title: string, url: string | undefined, index: number): Promise<string | null> {
  const id = `${event.cursor}:${backendId}:create`, ownership = { workspaceId, type, parentChromeId, title, url, index };
  let admitted = false;
  await updateProjectionState(workspaceId, (projection) => {
    const journal = projection.convergenceJournal ?? { version: 1 as const, phase: "live" as const, operations: [], localIntents: [], attempts: 0 };
    const existing = journal.operations.some((operation) => operation.id === id);
    const maximum = existing ? 500 : 499;
    while (journal.operations.length > maximum) {
      const oldestDone = journal.operations.findIndex((operation) => operation.id !== id && operation.ownership && operation.status === "done");
      if (oldestDone < 0) { journal.phase = "paused"; journal.pauseReason = "operation-overflow"; projection.convergenceJournal = journal; return; }
      journal.operations.splice(oldestDone, 1);
    }
    if (!existing) journal.operations.push({ id, kind: "create", backendId, fingerprint: JSON.stringify(ownership), status: "started", ownership });
    projection.convergenceJournal = journal;
    admitted = true;
  });
  return admitted ? id : null;
}

async function finishRemoteCreate(workspaceId: string, id: string, chromeId: string): Promise<void> {
  const node = await getNode(chromeId);
  await updateProjectionState(workspaceId, (projection) => {
    const journal = projection.convergenceJournal, operation = journal?.operations.find((item) => item.id === id), ownership = operation?.ownership;
    if (!journal || !operation || !ownership) return;
    if (!node || node.parentId !== ownership.parentChromeId || node.index !== ownership.index || node.title !== ownership.title || node.url !== ownership.url) { journal.phase = "paused"; journal.pauseReason = "ambiguous-operation"; return; }
    operation.chromeId = chromeId; operation.status = "done";
    if (journal.pauseReason === "ambiguous-operation") { journal.phase = "live"; journal.pauseReason = undefined; }
    const done = journal.operations.filter((item) => item.ownership && item.status === "done");
    if (done.length > 20) journal.operations = journal.operations.filter((item) => !done.slice(0, -20).includes(item));
  });
}

async function startRemoteDelete(workspaceId: string, backendId: string, chromeId: string, type: "folder" | "bookmark", chromeIds: string[]): Promise<string | null> {
  const id = `delete:${backendId}:${chromeId}`;
  let admitted = false;
  await updateProjectionState(workspaceId, (projection) => {
    const journal = projection.convergenceJournal ?? { version: 1 as const, phase: "live" as const, operations: [], localIntents: [], attempts: 0 };
    const existing = journal.operations.some((operation) => operation.id === id);
    if (existing) { projection.convergenceJournal = journal; return; }
    const mappedChromeIds = chromeIds.filter((id) => projection.backendIdByChromeId[id] !== undefined);
    if (mappedChromeIds.length > 500) { journal.phase = "paused"; journal.pauseReason = "ambiguous-operation"; projection.convergenceJournal = journal; return; }
    while (!existing && journal.operations.length >= 500) {
      const oldestDone = journal.operations.findIndex((operation) => operation.ownership && operation.status === "done");
      if (oldestDone < 0) { journal.phase = "paused"; journal.pauseReason = "operation-overflow"; projection.convergenceJournal = journal; return; }
      journal.operations.splice(oldestDone, 1);
    }
    const ownership = { workspaceId, effect: "delete" as const, type, chromeId, mappedChromeIds };
    journal.operations.push({ id, kind: "delete", backendId, chromeId, fingerprint: JSON.stringify(ownership), status: "started", ownership });
    projection.convergenceJournal = journal; admitted = true;
  });
  return admitted ? id : null;
}

async function finishRemoteDelete(workspaceId: string, id: string, pruneRemovedExclusions = true): Promise<void> {
  const state = await getState(), operation = state.projectionsByWorkspaceId[workspaceId]?.convergenceJournal?.operations.find((item) => item.id === id), ownership = operation?.ownership;
  if (!operation || ownership?.effect !== "delete" || !ownership.chromeId || await getNode(ownership.chromeId)) {
    await updateProjectionState(workspaceId, (projection) => { const journal = projection.convergenceJournal; if (journal?.operations.some((item) => item.id === id)) { journal.phase = "paused"; journal.pauseReason = "ambiguous-operation"; } });
    return;
  }
  await updateProjectionState(workspaceId, (projection) => {
    const current = projection.convergenceJournal?.operations.find((item) => item.id === id), owned = current?.ownership;
    if (!current || !owned?.chromeId || owned.effect !== "delete") return;
    const removedBackendIds = collectBackendIdsByChromeIds(projection, owned.mappedChromeIds ?? [owned.chromeId]);
    removeMappingsByChromeIds(projection, owned.mappedChromeIds ?? [owned.chromeId]); removeMappingByBackendId(projection, current.backendId);
    const clean = [current.backendId, ...removedBackendIds].every((backendId) => !projection.chromeIdByBackendId[backendId] && !projection.entityTypeByBackendId[backendId]);
    if (!clean) { projection.convergenceJournal!.phase = "paused"; projection.convergenceJournal!.pauseReason = "ambiguous-operation"; return; }
    if (pruneRemovedExclusions) removeExclusions(projection, [...removedBackendIds, current.backendId]);
    current.status = "done"; if (projection.convergenceJournal!.pauseReason === "ambiguous-operation") { projection.convergenceJournal!.phase = "live"; projection.convergenceJournal!.pauseReason = undefined; }
    const done = projection.convergenceJournal!.operations.filter((item) => item.ownership?.effect === "delete" && item.status === "done");
    if (done.length > 20) projection.convergenceJournal!.operations = projection.convergenceJournal!.operations.filter((item) => !done.slice(0, -20).includes(item));
  });
}

async function ownsRemoteDelete(id: string, removeInfo: BookmarkRemoveInfo): Promise<boolean> {
  const state = await getState();
  for (const [workspaceId, projection] of Object.entries(state.projectionsByWorkspaceId)) {
    const operation = projection.convergenceJournal?.operations.find((item) => item.status === "started" && item.ownership?.effect === "delete" && item.ownership.workspaceId === workspaceId && item.ownership.chromeId === id && item.ownership.type === (removeInfo.node?.url ? "bookmark" : "folder"));
    if (operation) { await finishRemoteDelete(workspaceId, operation.id); return true; }
  }
  return false;
}

async function ownsRemoteCreate(id: string, node: chrome.bookmarks.BookmarkTreeNode): Promise<boolean> {
  const state = await getState();
  return Object.entries(state.projectionsByWorkspaceId).some(([workspaceId, projection]) => {
    if (projection.backendIdByChromeId[id] !== undefined) return true;
    return projection.convergenceJournal?.operations.some((operation) => {
      const ownership = operation.ownership;
      const sameShape = ownership?.workspaceId === workspaceId && ownership.type === (node.url ? "bookmark" : "folder") && ownership.parentChromeId === node.parentId && ownership.title === node.title && ownership.url === node.url && ownership.index === node.index;
      return sameShape && (operation.status === "started" || (operation.status === "done" && operation.chromeId === id));
    }) ?? false;
  });
}

async function log(scope: string, message: string, level: "info" | "warn" | "error"): Promise<void> {
  await updateState((state) => pushDiagnostic(state, { scope, message, level }));
}

async function markSocketState(workspaceId: string, connected: boolean): Promise<void> {
  await updateProjectionState(workspaceId, (projection) => {
    projection.socketConnected = connected;
  });
}

async function markProjectionLive(workspaceId: string, currentCursor?: number): Promise<void> {
  await updateProjectionState(workspaceId, (projection) => {
    if (projection.convergenceJournal?.phase === "paused") return;
    if (typeof currentCursor === "number") {
      projection.lastCursor = Math.max(projection.lastCursor, currentCursor);
    }
    projection.lastSyncedAt = new Date().toISOString();
    projection.status = "ready";
    projection.health = "live";
    projection.lastError = undefined;
    projection.recoveryAttemptCount = 0;
    projection.recoveryStartedAt = undefined;
    projection.degradedAt = undefined;
    projection.degradedReason = undefined;
    projection.socketConnected = true;
    if (projection.convergenceJournal) {
      projection.convergenceJournal.phase = "live";
      projection.convergenceJournal.pauseReason = undefined;
      projection.convergenceJournal.failedCursor = undefined;
    }
  });
}

async function recordActivity(
  workspaceId: string,
  activity: { occurredAt?: string; detail?: ProjectionActivityDetail } = {},
): Promise<void> {
  const occurredAt = activity.occurredAt ?? new Date().toISOString();
  await updateState((state) => {
    const projection = state.projectionsByWorkspaceId[workspaceId];
    if (!projection) {
      return state;
    }
    const currentSignal = ensureActivitySignal(state);
    const nextRevision = currentSignal.revision + 1;
    projection.lastActivityAt = occurredAt;
    projection.lastActivity = activity.detail ?? createWorkspaceActivityDetail(projection.workspace.workspaceName);
    projection.activityRevision = nextRevision;
    return {
      ...state,
      activitySignal: {
        revision: nextRevision,
        lastSeenRevision: currentSignal.lastSeenRevision,
      },
      projectionsByWorkspaceId: {
        ...state.projectionsByWorkspaceId,
        [workspaceId]: projection,
      },
    };
  });
}

function createEntityActivityDetail(
  entityType: "folder" | "bookmark",
  action: "created" | "updated" | "deleted",
  label: string,
): ProjectionActivityDetail {
  return {
    entityType,
    action,
    label,
  };
}

function createWorkspaceActivityDetail(workspaceName: string): ProjectionActivityDetail {
  return {
    entityType: "workspace",
    action: "resynced",
    label: workspaceName,
  };
}

async function recoverWorkspace(
  workspaceId: string,
  reason: string,
  mode: "reconnect" | "replay" | "resync",
): Promise<void> {
  const shouldContinue = await enterRecovery(workspaceId, reason);
  if (!shouldContinue) {
    await logRemoteApplyDiagnostic(workspaceId, {
      action: "degraded",
      reason,
      recoveryMode: mode,
    }, "warn");
    await log(`sync:${workspaceId}`, `projection degraded: ${reason}`, "warn");
    return;
  }

  await logRemoteApplyDiagnostic(workspaceId, {
    action: mode,
    reason,
    recoveryMode: mode,
  });

  if (mode === "reconnect") {
    await connectWorkspace(workspaceId);
    return;
  }

  if (mode === "replay") {
    const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
    if (!projection) {
      return;
    }
    await replayWorkspaceDelta(workspaceId, projection.lastCursor, reason);
    return;
  }

  await pauseWorkspace(workspaceId, (await getState()).projectionsByWorkspaceId[workspaceId]?.lastCursor ?? 0, "ambiguous-predecessor");
}

async function pauseWorkspace(workspaceId: string, cursor: number, reason: Parameters<typeof gateRemoteEffect>[2]): Promise<void> {
  let disposition: "retry" | "rebuild" = "retry";
  await updateProjectionState(workspaceId, (projection) => {
    projection.convergenceJournal = gateRemoteEffect(projection.convergenceJournal ?? emptyJournal(), cursor, reason);
    if (projection.convergenceJournal.receipts?.some((receipt) => receipt.status === "pending")) projection.convergenceJournal.repairDisposition = "rebuild";
    disposition = projection.convergenceJournal.repairDisposition ?? "retry";
    projection.status = "error";
    projection.health = "degraded";
    projection.degradedReason = reason;
    projection.degradedAt = new Date().toISOString();
  });
  await log(`repair:${workspaceId}`, `paused cursor ${cursor}; ${reason}; disposition ${disposition}`, "warn");
}

async function enterRecovery(workspaceId: string, reason: string): Promise<boolean> {
  let shouldContinue = true;
  const now = new Date().toISOString();
  await updateProjectionState(workspaceId, (projection) => {
    const nextAttempt = projection.recoveryAttemptCount + 1;
    projection.socketConnected = false;
    projection.lastError = reason;
    if (nextAttempt > MAX_SILENT_RECOVERY_ATTEMPTS) {
      projection.status = "error";
      projection.health = "degraded";
      projection.degradedReason = reason;
      projection.degradedAt = now;
      shouldContinue = false;
      return;
    }

    projection.status = "syncing";
    projection.health = "recovering";
    projection.recoveryAttemptCount = nextAttempt;
    projection.recoveryStartedAt = projection.recoveryStartedAt ?? now;
    projection.degradedAt = undefined;
    projection.degradedReason = undefined;
  });
  return shouldContinue;
}

function createRemoteEventContext(event: SyncEnvelope, extra: RemoteApplyDiagnosticContext = {}): RemoteApplyDiagnosticContext {
  return {
    eventKind: event.kind,
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    entityId: event.entityId,
    cursor: event.cursor,
    ...extra,
  };
}

function createRemoteApplyError(error: unknown, context: RemoteApplyDiagnosticContext): RemoteApplyError {
  if (error instanceof RemoteApplyError) {
    return error;
  }
  return new RemoteApplyError(error instanceof Error ? error.message : String(error), context);
}

function createRecoveryScope(scope: RecoveryScope): RecoveryScope {
  return scope;
}

function createAbandonedMutationKey(workspaceId: string, value: string): string {
  return `${workspaceId}:${value}`;
}

function isMutationAbandoned(workspaceId: string, backendId?: string, chromeId?: string): boolean {
  const backendKey = backendId ? createAbandonedMutationKey(workspaceId, `backend:${backendId}`) : undefined;
  const chromeKey = chromeId ? createAbandonedMutationKey(workspaceId, `chrome:${chromeId}`) : undefined;
  return Boolean((backendKey && abandonedMutationKeys.has(backendKey)) || (chromeKey && abandonedMutationKeys.has(chromeKey)));
}

async function abandonLocalMutation(scope: RecoveryScope): Promise<void> {
  const keys = [
    scope.entityBackendId ? createAbandonedMutationKey(scope.workspaceId, `backend:${scope.entityBackendId}`) : undefined,
    scope.mappedChromeId ? createAbandonedMutationKey(scope.workspaceId, `chrome:${scope.mappedChromeId}`) : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const key of keys) {
    const existing = abandonedMutationKeys.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timeout = setTimeout(() => {
      abandonedMutationKeys.delete(key);
    }, ABANDONED_MUTATION_TTL_MS);
    abandonedMutationKeys.set(key, timeout);
  }
}

function isCascadeRecoveryError(error: unknown): boolean {
  const detail = describeError(error).toLowerCase();
  return detail.includes("404") || detail.includes("not found") || detail.includes("parent");
}

async function validateRecoveryScope(scope: RecoveryScope, parentChromeId: string | undefined, failClosedFolderRead = false): Promise<RecoveryValidation> {
  if (!parentChromeId) {
    return {
      status: "recover-subtree",
      reason: "missing parent chrome id",
      invalidateBackendIds: scope.parentBackendId ? [scope.parentBackendId] : undefined,
    };
  }

  const parentNode = await getNode(parentChromeId);
  if (!parentNode) {
    return {
      status: "recover-subtree",
      reason: "expected parent chrome node missing",
      invalidateBackendIds: scope.parentBackendId ? [scope.parentBackendId] : undefined,
    };
  }

  if (!scope.mappedChromeId) {
    return { status: "valid" };
  }

  const mappedNode = scope.reason === "stale-mapping" && scope.entityType === "folder"
    ? failClosedFolderRead ? await readDeleteSubTree(scope.workspaceId, scope.mappedChromeId) : await getSubTree(scope.mappedChromeId)
    : await getNode(scope.mappedChromeId);
  if (!mappedNode) {
    return {
      status: "recover-subtree",
      reason: "mapped chrome node missing",
      invalidateBackendIds: scope.entityBackendId ? [scope.entityBackendId] : undefined,
    };
  }

  return { status: "valid" };
}

async function invalidateSubtreeMappings(scope: RecoveryScope, extraBackendIds: string[] = []): Promise<void> {
  const state = await getState();
  const projection = state.projectionsByWorkspaceId[scope.workspaceId];
  if (!projection) {
    return;
  }

  const backendIds = new Set<string>(extraBackendIds);
  if (scope.entityBackendId) {
    backendIds.add(scope.entityBackendId);
  }

  const chromeIds = new Set<string>();
  if (scope.mappedChromeId) {
    chromeIds.add(scope.mappedChromeId);
    const subtree = await getSubTree(scope.mappedChromeId);
    for (const chromeId of subtree ? collectChromeIds(subtree) : [scope.mappedChromeId]) {
      chromeIds.add(chromeId);
      const backendId = projection.backendIdByChromeId[chromeId];
      if (backendId) {
        backendIds.add(backendId);
      }
    }
  }

  await updateProjectionState(scope.workspaceId, (current) => {
    removeMappingsByBackendIds(current, backendIds);
    removeMappingsByChromeIds(current, [...chromeIds]);
    if (scope.pruneExclusions) {
      removeExclusions(current, backendIds);
    }
  });
}

async function recoverSubtreeThenWorkspace(
  scope: RecoveryScope,
  reason: string,
  invalidateBackendIds: string[] = [],
): Promise<void> {
  const shouldContinue = await enterRecovery(scope.workspaceId, reason);
  if (!shouldContinue) {
    await logRemoteApplyDiagnostic(scope.workspaceId, {
      action: "degraded",
      reason,
      recoveryMode: "subtree-first",
      entityId: scope.entityBackendId,
    }, "warn");
    await log(`sync:${scope.workspaceId}`, `projection degraded: ${reason}`, "warn");
    return;
  }

  await logRemoteApplyDiagnostic(scope.workspaceId, {
    action: "recover-subtree",
    reason,
    recoveryMode: "subtree-first",
    entityId: scope.entityBackendId,
    parentBackendId: scope.parentBackendId,
  });

  const restored = await attemptSubtreeRecovery(scope, invalidateBackendIds, reason);
  if (restored) {
    return;
  }

  await logRemoteApplyDiagnostic(scope.workspaceId, {
    action: "recover-workspace",
    reason,
    recoveryMode: "workspace-fallback",
    entityId: scope.entityBackendId,
    parentBackendId: scope.parentBackendId,
  }, "warn");

  await pauseWorkspace(scope.workspaceId, (await getState()).projectionsByWorkspaceId[scope.workspaceId]?.lastCursor ?? 0, "ambiguous-predecessor");
}

async function attemptSubtreeRecovery(
  scope: RecoveryScope,
  invalidateBackendIds: string[],
  reason: string,
): Promise<boolean> {
  const state = await getState();
  const projection = state.projectionsByWorkspaceId[scope.workspaceId];
  if (!state.session || !projection?.workspaceChromeId) {
    return false;
  }

  const replayCursor = projection.lastCursor;
  await invalidateSubtreeMappings(scope, invalidateBackendIds);

  const tree = await getWorkspaceTree(state.settings.backendUrl, state.session, scope.workspaceId);
  const latest = (await getState()).projectionsByWorkspaceId[scope.workspaceId];
  if (!latest?.workspaceChromeId) {
    return false;
  }

  const anchor = await resolveCanonicalAnchor(tree, latest, scope);
  if (!anchor) {
    return false;
  }

  const removedIds = await clearManagedChildrenWithSuppression(anchor.parentChromeId, latest.localOnlyChromeId ? [latest.localOnlyChromeId] : []);
  await updateProjectionState(scope.workspaceId, (current) => {
    const removedBackendIds = collectBackendIdsByChromeIds(current, removedIds);
    removeMappingsByChromeIds(current, removedIds);
    if (scope.pruneExclusions) {
      removeExclusions(current, removedBackendIds.filter((backendId) => !anchor.validBackendIds.has(backendId)));
    }
  });

  const projectionForBuild = (await getState()).projectionsByWorkspaceId[scope.workspaceId];
  if (!projectionForBuild) {
    return false;
  }

  await materializeChildren(
    scope.workspaceId,
    anchor.parentChromeId,
    filterFoldersForProjection(anchor.folders, projectionForBuild),
    anchor.bookmarks.filter((bookmark) => !isExcluded(projectionForBuild, bookmark.id)),
  );

  const replay = await replayEvents(state.settings.backendUrl, state.session, scope.workspaceId, replayCursor);
  if (replay.resyncRequired) {
    return false;
  }

  for (const event of replay.events) {
    await applyRemoteEnvelope(scope.workspaceId, event, true);
    if ((await getState()).projectionsByWorkspaceId[scope.workspaceId]?.lastCursor < event.cursor) return false;
  }

  await updateProjectionState(scope.workspaceId, (current) => {
    current.lastCursor = Math.max(current.lastCursor, replay.currentCursor);
    current.lastSyncedAt = new Date().toISOString();
    current.status = "ready";
    current.health = "live";
    current.lastError = undefined;
    current.recoveryAttemptCount = 0;
    current.recoveryStartedAt = undefined;
    current.degradedAt = undefined;
    current.degradedReason = undefined;
    current.socketConnected = true;
  }, tree.workspace);
  await recordActivity(scope.workspaceId);
  await log(`sync:${scope.workspaceId}`, `recovered subtree (${reason})`, "info");
  return true;
}

async function inspectChromeParent(parentChromeId: string): Promise<{ currentChildCount?: number }> {
  try {
    const children = await getChildren(parentChromeId);
    return { currentChildCount: children.length };
  } catch {
    return {};
  }
}

async function logRemoteApplyDiagnostic(
  workspaceId: string,
  context: RemoteApplyDiagnosticContext,
  level: "info" | "warn" | "error" = "info",
): Promise<void> {
  const fields = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  await log(`sync:${workspaceId}`, `remote ${fields}`.trim(), level);
}

function needsBootstrap(projection: ProjectionState): boolean {
  return !projection.rootChromeId || !projection.organizationChromeId || !projection.workspaceChromeId;
}

async function reconcileFolderChromeNode(
  workspaceId: string,
  projection: ProjectionState,
  folder: FolderResource,
  parentChromeId: string,
  scope: RecoveryScope,
): Promise<string | null | undefined> {
  const mappedId = projection.chromeIdByBackendId[folder.id];
  if (mappedId) {
    const mapped = await getNode(mappedId);
    if (mapped) {
      return mapped.id;
    }
    await recoverSubtreeThenWorkspace(scope, "stale folder mapping detected before remote apply", [folder.id]);
    return null;
  }

  const reusable = findReusableFolderNode(await getChildren(parentChromeId), folder.name);
  if (!reusable) {
    return undefined;
  }

  await updateProjectionState(workspaceId, (current) => {
    setMapping(current, folder.id, reusable.id, "folder");
  });
  return reusable.id;
}

async function reconcileBookmarkChromeNode(
  workspaceId: string,
  projection: ProjectionState,
  bookmark: BookmarkResource,
  parentChromeId: string,
  scope: RecoveryScope,
): Promise<string | null | undefined> {
  const mappedId = projection.chromeIdByBackendId[bookmark.id];
  if (mappedId) {
    const mapped = await getNode(mappedId);
    if (mapped) {
      return mapped.id;
    }
    await recoverSubtreeThenWorkspace(scope, "stale bookmark mapping detected before remote apply", [bookmark.id]);
    return null;
  }

  const reusable = findReusableBookmarkNode(await getChildren(parentChromeId), bookmark.title, bookmark.url);
  if (!reusable) {
    return undefined;
  }

  await updateProjectionState(workspaceId, (current) => {
    setMapping(current, bookmark.id, reusable.id, "bookmark");
  });
  return reusable.id;
}

function indexCanonicalFolders(
  folders: FolderNode[],
  parentId: string | undefined,
  foldersById: Map<string, FolderNode>,
  parentByFolderId: Map<string, string | undefined>,
): void {
  for (const folder of folders) {
    foldersById.set(folder.id, folder);
    parentByFolderId.set(folder.id, parentId);
    indexCanonicalFolders(folder.folders, folder.id, foldersById, parentByFolderId);
  }
}

function collectCanonicalBackendIdsForFolder(folder: FolderNode): Set<string> {
  const ids = new Set<string>([folder.id]);
  for (const bookmark of folder.bookmarks) {
    ids.add(bookmark.id);
  }
  for (const child of folder.folders) {
    for (const id of collectCanonicalBackendIdsForFolder(child)) {
      ids.add(id);
    }
  }
  return ids;
}

function collectCanonicalBackendIdsForChildren(folders: FolderNode[], bookmarks: BookmarkNode[]): Set<string> {
  const ids = new Set<string>();
  for (const bookmark of bookmarks) {
    ids.add(bookmark.id);
  }
  for (const folder of folders) {
    for (const id of collectCanonicalBackendIdsForFolder(folder)) {
      ids.add(id);
    }
  }
  return ids;
}

async function resolveCanonicalAnchor(
  tree: TreeResponse,
  projection: ProjectionState,
  scope: RecoveryScope,
): Promise<CanonicalAnchor | null> {
  const foldersById = new Map<string, FolderNode>();
  const parentByFolderId = new Map<string, string | undefined>();
  indexCanonicalFolders(tree.folders, undefined, foldersById, parentByFolderId);

  const candidateIds = [scope.parentBackendId, scope.entityType === "folder" ? scope.entityBackendId : undefined]
    .filter((value): value is string => Boolean(value));

  for (const candidateId of candidateIds) {
    let currentId: string | undefined = candidateId;
    while (currentId) {
      const folder = foldersById.get(currentId);
      const mappedChromeId = projection.chromeIdByBackendId[currentId];
      const mappedNode = mappedChromeId ? await getNode(mappedChromeId) : null;
      if (folder && mappedNode) {
        return {
          parentChromeId: mappedNode.id,
          folders: folder.folders,
          bookmarks: folder.bookmarks,
          validBackendIds: collectCanonicalBackendIdsForChildren(folder.folders, folder.bookmarks),
        };
      }
      currentId = parentByFolderId.get(currentId);
    }
  }

  if (!projection.workspaceChromeId || !await getNode(projection.workspaceChromeId)) {
    return null;
  }

  return {
    parentChromeId: projection.workspaceChromeId,
    folders: tree.folders,
    bookmarks: [],
    validBackendIds: collectBackendIds(tree),
  };
}

async function materializeChildren(
  workspaceId: string,
  parentChromeId: string,
  folders: FolderNode[],
  bookmarks: BookmarkNode[],
): Promise<void> {
  for (const bookmark of bookmarks) {
    await materializeBookmark(workspaceId, parentChromeId, bookmark);
  }
  for (const folder of folders) {
    await materializeFolder(workspaceId, parentChromeId, folder);
  }
}

function closeWorkspaceSocket(workspaceId: string): void {
  socketTokens.delete(workspaceId);
  const closer = socketClosers.get(workspaceId);
  if (!closer) {
    return;
  }
  socketClosers.delete(workspaceId);
  closer();
}

function closeAllSockets(): void {
  socketTokens.clear();
  for (const [workspaceId, close] of socketClosers.entries()) {
    socketClosers.delete(workspaceId);
    close();
  }
}

function resetRuntimeState(): void {
  closeAllSockets();
  socketClosers.clear();
  socketTokens.clear();
  socketConnectFlights.clear();
  liveApplyQueues.clear();
  suppressedChromeIds.clear();
  volatileRepairGates.clear();
  for (const timeout of abandonedMutationKeys.values()) {
    clearTimeout(timeout);
  }
  abandonedMutationKeys.clear();
  workspaceLocks.clear();
}

function resolveWorkspace(state: Awaited<ReturnType<typeof getState>>, workspaceId: string): WorkspaceAccess | undefined {
  for (const workspaces of Object.values(state.cachedWorkspacesByOrganization)) {
    const workspace = workspaces.find((entry) => entry.workspaceId === workspaceId);
    if (workspace) {
      return workspace;
    }
  }
  return state.projectionsByWorkspaceId[workspaceId]?.workspace;
}

function resolveParentBackendId(projection: ProjectionState, chromeParentId: string | undefined): string | null {
  if (!chromeParentId || chromeParentId === projection.workspaceChromeId) {
    return null;
  }
  return projection.backendIdByChromeId[chromeParentId] ?? null;
}

async function resolveContext(chromeId: string): Promise<
  | {
      state: Awaited<ReturnType<typeof getState>>;
      projection: ProjectionState;
      workspaceId: string;
      backendId?: string;
      entityType?: "folder" | "bookmark";
      syntheticRoot?: "workspace";
    }
  | undefined
> {
  const state = await getState();
  for (const [workspaceId, projection] of Object.entries(state.projectionsByWorkspaceId)) {
    if (projection.workspaceChromeId === chromeId) {
      return { state, projection, workspaceId, syntheticRoot: "workspace" };
    }
    const backendId = projection.backendIdByChromeId[chromeId];
    if (backendId) {
      return {
        state,
        projection,
        workspaceId,
        backendId,
        entityType: projection.entityTypeByBackendId[backendId],
        syntheticRoot: "workspace",
      };
    }
  }
  return undefined;
}

async function withSuppression<T>(operation: () => Promise<T>, explicitIds?: string[]): Promise<T> {
  const idsToRelease = new Set(explicitIds ?? []);
  for (const id of idsToRelease) {
    suppressedChromeIds.add(id);
  }
  try {
    const result = await operation();
    if (typeof result === "object" && result !== null && "id" in result) {
      const chromeId = String((result as { id: string }).id);
      suppressedChromeIds.add(chromeId);
      idsToRelease.add(chromeId);
    }
    return result;
  } finally {
    setTimeout(() => {
      for (const id of idsToRelease) {
        suppressedChromeIds.delete(id);
      }
    }, 250);
  }
}

function isSuppressed(chromeId: string | undefined): boolean {
  if (!chromeId) {
    return false;
  }
  if (!suppressedChromeIds.has(chromeId)) {
    return false;
  }
  suppressedChromeIds.delete(chromeId);
  return true;
}
