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

const socketClosers = new Map<string, () => void>();
const socketTokens = new Map<string, symbol>();
const socketConnectFlights = new Map<string, Promise<void>>();
const suppressedChromeIds = new Set<string>();
const abandonedMutationKeys = new Map<string, ReturnType<typeof setTimeout>>();
const pendingRemoteBookmarkOps = new Map<string, PendingRemoteBookmarkOp>();
const MAX_SILENT_RECOVERY_ATTEMPTS = 3;
const ABANDONED_MUTATION_TTL_MS = 1500;
const REMOTE_BOOKMARK_OP_TTL_MS = 1500;

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

type PendingRemoteBookmarkOp = {
  workspaceId: string;
  backendId: string;
  chromeId?: string;
  expected?: { title?: string; url?: string };
  targetMove?: { parentChromeId: string; index: number };
  cursor: number;
  expiresAt: number;
};

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
  ) {
    super(message);
    this.name = "RemoteApplyError";
  }
}

export const projectionTestHooks = {
  applyRemoteEnvelope,
  connectWorkspace,
  recoverWorkspace,
  replayWorkspaceDelta,
  resetRuntimeState,
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
    await resyncWorkspace(workspaceId, "manual resync-all");
    await connectWorkspace(workspaceId);
  }
  return getUiState();
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
      await resyncWorkspace(context.workspaceId, "bookmark create outside canonical folder boundary");
      return;
    }
    try {
      await apiCreateBookmark(state.settings.backendUrl, state.session!, context.workspaceId, {
        folderId: parentBackendId,
        title: node.title,
        url: node.url,
        position: node.index,
      }, projection.lastCursor);
    } catch (error) {
      await logRejectedMutation(context.workspaceId, "bookmark create rejected by backend", error);
      return;
    }
    await resyncWorkspace(context.workspaceId, "bookmark created locally");
    return;
  }

  try {
    await apiCreateFolder(state.settings.backendUrl, state.session!, context.workspaceId, {
      parentId: resolveParentBackendId(projection, node.parentId),
      name: node.title,
      position: node.index,
    }, projection.lastCursor);
  } catch (error) {
    await logRejectedMutation(context.workspaceId, "folder create rejected by backend", error);
    return;
  }
  await resyncWorkspace(context.workspaceId, "folder created locally");
}

export async function handleBookmarkChanged(id: string, changeInfo: BookmarkChangeInfo): Promise<void> {
  const remoteOp = consumePendingRemoteBookmarkChange(id, changeInfo);
  if (remoteOp) {
    return;
  }
  if (isSuppressed(id)) {
    return;
  }
  const context = await resolveContext(id);
  if (!context?.backendId) {
    return;
  }
  if (isMutationAbandoned(context.workspaceId, context.backendId, id)) {
    return;
  }
  if (context.projection.workspace.role === "viewer") {
    await resyncWorkspace(context.workspaceId, "viewer local change rejected");
    return;
  }
  try {
    if (context.entityType === "folder") {
      await apiUpdateFolder(context.state.settings.backendUrl, context.state.session!, context.backendId, {
        name: changeInfo.title,
      }, context.projection.lastCursor);
    } else {
      await apiUpdateBookmark(context.state.settings.backendUrl, context.state.session!, context.backendId, {
        title: changeInfo.title,
        url: changeInfo.url,
      }, context.projection.lastCursor);
    }
  } catch (error) {
    await logRejectedMutation(
      context.workspaceId,
      "local change rejected by backend",
      error,
      createRecoveryScope({
        workspaceId: context.workspaceId,
        entityType: context.entityType,
        entityBackendId: context.backendId,
        mappedChromeId: id,
        reason: "local-404",
      }),
    );
    return;
  }
  await resyncWorkspace(context.workspaceId, "local update accepted");
}

export async function handleBookmarkMoved(id: string, moveInfo: BookmarkMoveInfo): Promise<void> {
  const remoteOp = consumePendingRemoteBookmarkMove(id, moveInfo);
  if (remoteOp) {
    return;
  }
  if (isSuppressed(id)) {
    return;
  }
  const context = await resolveContext(id);
  if (!context?.backendId) {
    return;
  }
  if (isMutationAbandoned(context.workspaceId, context.backendId, id)) {
    return;
  }
  if (context.projection.workspace.role === "viewer") {
    await resyncWorkspace(context.workspaceId, "viewer local move rejected");
    return;
  }

  const parentBackendId = resolveParentBackendId(context.projection, moveInfo.parentId);
  try {
    if (context.entityType === "folder") {
      await apiUpdateFolder(context.state.settings.backendUrl, context.state.session!, context.backendId, {
        parentId: parentBackendId,
        position: moveInfo.index,
      }, context.projection.lastCursor);
    } else {
      if (!parentBackendId) {
        await resyncWorkspace(context.workspaceId, "bookmark cannot move to synthetic workspace root");
        return;
      }
      await apiUpdateBookmark(context.state.settings.backendUrl, context.state.session!, context.backendId, {
        folderId: parentBackendId,
        position: moveInfo.index,
      }, context.projection.lastCursor);
    }
  } catch (error) {
    await logRejectedMutation(
      context.workspaceId,
      "local move rejected by backend",
      error,
      createRecoveryScope({
        workspaceId: context.workspaceId,
        entityType: context.entityType,
        entityBackendId: context.backendId,
        parentBackendId: parentBackendId ?? undefined,
        mappedChromeId: id,
        reason: "local-404",
      }),
    );
    return;
  }
  await resyncWorkspace(context.workspaceId, "local move accepted");
}

export async function handleBookmarkRemoved(id: string, removeInfo: BookmarkRemoveInfo): Promise<void> {
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

  const parentBackendId = resolveParentBackendId(context.projection, removeInfo.parentId);

  try {
    if (context.entityType === "folder") {
      await apiDeleteFolder(context.state.settings.backendUrl, context.state.session!, context.backendId, context.projection.lastCursor);
    } else {
      await apiDeleteBookmark(context.state.settings.backendUrl, context.state.session!, context.backendId, context.projection.lastCursor);
    }
  } catch (error) {
    await logRejectedMutation(
      context.workspaceId,
      "local delete rejected by backend",
      error,
      createRecoveryScope({
        workspaceId: context.workspaceId,
        entityType: context.entityType,
        entityBackendId: context.backendId,
        parentBackendId: parentBackendId ?? undefined,
        mappedChromeId: id,
        reason: "local-404",
        pruneExclusions: true,
      }),
    );
    return;
  }

  await resyncWorkspace(context.workspaceId, "local delete accepted");
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
    await doResyncWorkspace(workspaceId, reason, "bootstrap");
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
    },
    onEvent: async (event) => {
      if (!isActiveSocket()) {
        return;
      }
      await applyRemoteEnvelope(workspaceId, event);
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
  }
  await markProjectionLive(workspaceId, replay.currentCursor);
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
  await runCoalescedWorkspaceTask(workspaceLocks, workspaceId, reason, (currentReason) => doResyncWorkspace(workspaceId, currentReason));
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

async function doResyncWorkspace(workspaceId: string, reason: string, targetHealth: ProjectionState["health"] = "bootstrap"): Promise<void> {
  const state = await getState();
  if (!state.session) {
    return;
  }
  const workspace = resolveWorkspace(state, workspaceId);
  if (!workspace) {
    return;
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
    const removedIds = await clearManagedChildrenWithSuppression(workspaceChromeId);
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
    }

    await updateProjectionState(workspaceId, (projectionState) => {
      projectionState.lastCursor = replay.currentCursor;
      projectionState.lastSyncedAt = new Date().toISOString();
      projectionState.status = "ready";
      projectionState.health = projectionState.socketConnected ? "live" : targetHealth;
      projectionState.lastError = undefined;
      if (projectionState.health === "live") {
        projectionState.recoveryAttemptCount = 0;
        projectionState.recoveryStartedAt = undefined;
        projectionState.degradedAt = undefined;
        projectionState.degradedReason = undefined;
      }
    }, tree.workspace);
    await recordActivity(workspaceId);
    await log(`sync:${workspaceId}`, `resynced workspace (${reason})`, "info");
  } catch (error) {
    await updateProjectionState(workspaceId, (projection) => {
      projection.status = "error";
      projection.health = "degraded";
      projection.lastError = error instanceof Error ? error.message : "workspace resync failed";
      projection.degradedReason = projection.lastError;
      projection.degradedAt = new Date().toISOString();
    }, workspace);
    await log(`sync:${workspaceId}`, `resync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
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
    let activityDetail: ProjectionActivityDetail | undefined;
    switch (event.kind) {
      case "folder.created":
      case "folder.updated":
        await applyRemoteFolderUpsert(workspaceId, event, event.payload as FolderResource, action);
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
        await applyRemoteBookmarkUpsert(workspaceId, event, event.payload as BookmarkResource, action);
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
      current.lastCursor = Math.max(current.lastCursor, event.cursor);
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
    const detail = error instanceof Error ? error.message : String(error);
    await logRemoteApplyDiagnostic(workspaceId, {
      ...context,
      action: "resync",
      failure: detail,
    }, "warn");
    await log(`sync:${workspaceId}`, `remote apply failed for ${event.kind}: ${detail}`, "warn");
    await recoverWorkspace(workspaceId, `remote apply fallback for ${event.kind}`, "resync");
  }
}

async function applyRemoteFolderUpsert(
  workspaceId: string,
  event: SyncEnvelope,
  folder: FolderResource,
  action: "live-apply" | "replay",
): Promise<void> {
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
    return;
  }

  const parentChromeId = folder.parentId ? projection.chromeIdByBackendId[folder.parentId] : projection.workspaceChromeId;
  const validation = await validateRecoveryScope(scope, parentChromeId);
  if (validation.status !== "valid") {
    await recoverSubtreeThenWorkspace(scope, validation.reason, validation.invalidateBackendIds);
    return;
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
    return;
  }
  if (!chromeId) {
    await logRemoteApplyDiagnostic(workspaceId, {
      ...baseContext,
      branch: "create",
    });
    const ownership = await startRemoteCreate(workspaceId, event, folder.id, "folder", parentChromeId, folder.name, undefined, folder.position);
    if (!ownership) return;
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
    return;
  }

  const existing = await getNode(chromeId);
  if (!existing) {
    throw new Error("stale folder mapping");
  }
  const existingContext = {
    ...baseContext,
    branch: existing.parentId !== parentChromeId || existing.index !== folder.position ? "move" : "update",
    currentChromeId: chromeId,
    currentParentChromeId: existing.parentId,
    currentIndex: existing.index,
  };
  await logRemoteApplyDiagnostic(workspaceId, existingContext);
  await withSuppression(async () => {
    if (existing.title !== folder.name) {
      await updateNode(chromeId, { title: folder.name });
    }
    if (existing.parentId !== parentChromeId || existing.index !== folder.position) {
      try {
        await moveNode(chromeId, { parentId: parentChromeId, index: folder.position });
      } catch (error) {
        throw createRemoteApplyError(error, existingContext);
      }
    }
  });
}

async function applyRemoteBookmarkUpsert(
  workspaceId: string,
  event: SyncEnvelope,
  bookmark: BookmarkResource,
  action: "live-apply" | "replay",
): Promise<void> {
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
    return;
  }

  const parentChromeId = projection.chromeIdByBackendId[bookmark.folderId];
  const validation = await validateRecoveryScope(scope, parentChromeId);
  if (validation.status !== "valid") {
    await recoverSubtreeThenWorkspace(scope, validation.reason, validation.invalidateBackendIds);
    return;
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
    return;
  }
  if (!chromeId) {
    await logRemoteApplyDiagnostic(workspaceId, {
      ...baseContext,
      branch: "create",
    });
    const ownership = await startRemoteCreate(workspaceId, event, bookmark.id, "bookmark", parentChromeId, bookmark.title, bookmark.url, bookmark.position);
    if (!ownership) return;
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
    return;
  }

  const existing = await getNode(chromeId);
  if (!existing) {
    throw new Error("stale bookmark mapping");
  }

  const existingContext = {
    ...baseContext,
    branch: existing.parentId !== parentChromeId || existing.index !== bookmark.position ? "move" : "update",
    currentChromeId: chromeId,
    currentParentChromeId: existing.parentId,
    currentIndex: existing.index,
  };
  await logRemoteApplyDiagnostic(workspaceId, existingContext);

  const expectedRemoteChange = existing.title !== bookmark.title || existing.url !== bookmark.url
    ? {
      ...(existing.title !== bookmark.title ? { title: bookmark.title } : {}),
      ...(existing.url !== bookmark.url ? { url: bookmark.url } : {}),
    }
    : undefined;

  const remoteOp = registerPendingRemoteBookmarkOp({
    workspaceId,
    backendId: bookmark.id,
    chromeId,
    expected: expectedRemoteChange,
    targetMove: existing.parentId !== parentChromeId || existing.index !== bookmark.position
      ? { parentChromeId, index: bookmark.position }
      : undefined,
    cursor: event.cursor,
  });

  try {
    if (existing.title !== bookmark.title || existing.url !== bookmark.url) {
      await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
    }
    if (existing.parentId !== parentChromeId || existing.index !== bookmark.position) {
      await moveNode(chromeId, { parentId: parentChromeId, index: bookmark.position });
    }
  } catch (error) {
    clearPendingRemoteBookmarkOp(remoteOp);
    throw createRemoteApplyError(error, existingContext);
  }

  const finalNode = await getNode(chromeId);
  if (!finalNode) {
    clearPendingRemoteBookmarkOp(remoteOp);
    await recoverSubtreeThenWorkspace(scope, "remote bookmark missing after apply", [bookmark.id]);
    return;
  }
  if (finalNode.parentId !== parentChromeId || finalNode.index !== bookmark.position) {
    clearPendingRemoteBookmarkOp(remoteOp);
    await recoverSubtreeThenWorkspace(scope, "remote bookmark final parent/index mismatch after apply", [bookmark.id]);
    return;
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
  const validation = await validateRecoveryScope(scope, parentChromeId);
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
  const subtree = entityType === "folder" ? await getSubTree(chromeId) : null;
  const chromeIds = subtree ? collectChromeIds(subtree) : [chromeId];
  await withSuppression(async () => {
    if (entityType === "folder") {
      await removeTree(chromeId);
    } else {
      await removeNode(chromeId);
    }
  }, chromeIds);
  await updateProjectionState(workspaceId, (current) => {
    const removedBackendIds = collectBackendIdsByChromeIds(current, chromeIds);
    removeMappingsByChromeIds(current, chromeIds);
    removeMappingByBackendId(current, backendId);
    if (pruneRemovedExclusions) {
      removeExclusions(current, [...removedBackendIds, backendId]);
    }
  });
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

async function clearManagedChildrenWithSuppression(workspaceChromeId: string): Promise<string[]> {
  const subtree = await getSubTree(workspaceChromeId);
  const managedChildIds = (subtree?.children ?? []).flatMap((child) => collectChromeIds(child));
  return withSuppression(() => clearChildren(workspaceChromeId), managedChildIds);
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

  closeWorkspaceSocket(workspaceId);
  await doResyncWorkspace(workspaceId, reason, "recovering");
  await connectWorkspace(workspaceId);
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

function createPendingRemoteBookmarkOpKey(workspaceId: string, backendId: string): string {
  return `${workspaceId}:${backendId}`;
}

function pruneExpiredPendingRemoteBookmarkOps(now = Date.now()): void {
  for (const [key, op] of pendingRemoteBookmarkOps.entries()) {
    if (op.expiresAt <= now) {
      pendingRemoteBookmarkOps.delete(key);
    }
  }
}

function discardPendingRemoteBookmarkOps(
  workspaceId: string,
  backendIds: Iterable<string>,
  chromeIds: Iterable<string>,
): void {
  const backendIdSet = new Set(backendIds);
  const chromeIdSet = new Set(chromeIds);
  if (backendIdSet.size === 0 && chromeIdSet.size === 0) {
    return;
  }

  pruneExpiredPendingRemoteBookmarkOps();
  for (const [key, op] of pendingRemoteBookmarkOps.entries()) {
    if (op.workspaceId !== workspaceId) {
      continue;
    }
    if (backendIdSet.has(op.backendId) || (op.chromeId && chromeIdSet.has(op.chromeId))) {
      pendingRemoteBookmarkOps.delete(key);
    }
  }
}

function registerPendingRemoteBookmarkOp(input: Omit<PendingRemoteBookmarkOp, "expiresAt">): PendingRemoteBookmarkOp | undefined {
  if (!input.expected && !input.targetMove) {
    return undefined;
  }
  pruneExpiredPendingRemoteBookmarkOps();
  const op: PendingRemoteBookmarkOp = {
    ...input,
    expiresAt: Date.now() + REMOTE_BOOKMARK_OP_TTL_MS,
  };
  pendingRemoteBookmarkOps.set(createPendingRemoteBookmarkOpKey(op.workspaceId, op.backendId), op);
  return op;
}

function clearPendingRemoteBookmarkOp(op: PendingRemoteBookmarkOp | undefined): void {
  if (!op) {
    return;
  }
  pendingRemoteBookmarkOps.delete(createPendingRemoteBookmarkOpKey(op.workspaceId, op.backendId));
}

function findPendingRemoteBookmarkOp(chromeId: string): PendingRemoteBookmarkOp | undefined {
  pruneExpiredPendingRemoteBookmarkOps();
  for (const op of pendingRemoteBookmarkOps.values()) {
    if (op.chromeId === chromeId) {
      return op;
    }
  }
  return undefined;
}

function matchesRemoteBookmarkChange(op: PendingRemoteBookmarkOp, changeInfo: BookmarkChangeInfo): boolean {
  if (!op.expected) {
    return false;
  }
  if (op.expected.title !== undefined && changeInfo.title !== op.expected.title) {
    return false;
  }
  if (op.expected.url !== undefined && changeInfo.url !== op.expected.url) {
    return false;
  }
  return true;
}

function matchesRemoteBookmarkMove(op: PendingRemoteBookmarkOp, moveInfo: BookmarkMoveInfo): boolean {
  if (!op.targetMove) {
    return false;
  }
  return op.targetMove.parentChromeId === moveInfo.parentId && op.targetMove.index === moveInfo.index;
}

function finalizePendingRemoteBookmarkOp(op: PendingRemoteBookmarkOp, kind: "change" | "move"): void {
  if (kind === "change") {
    op.expected = undefined;
  } else {
    op.targetMove = undefined;
  }
  if (!op.expected && !op.targetMove) {
    clearPendingRemoteBookmarkOp(op);
    return;
  }
  op.expiresAt = Date.now() + REMOTE_BOOKMARK_OP_TTL_MS;
  pendingRemoteBookmarkOps.set(createPendingRemoteBookmarkOpKey(op.workspaceId, op.backendId), op);
}

function consumePendingRemoteBookmarkChange(chromeId: string, changeInfo: BookmarkChangeInfo): PendingRemoteBookmarkOp | undefined {
  const op = findPendingRemoteBookmarkOp(chromeId);
  if (!op || !matchesRemoteBookmarkChange(op, changeInfo)) {
    return undefined;
  }
  finalizePendingRemoteBookmarkOp(op, "change");
  return op;
}

function consumePendingRemoteBookmarkMove(chromeId: string, moveInfo: BookmarkMoveInfo): PendingRemoteBookmarkOp | undefined {
  const op = findPendingRemoteBookmarkOp(chromeId);
  if (!op || !matchesRemoteBookmarkMove(op, moveInfo)) {
    return undefined;
  }
  finalizePendingRemoteBookmarkOp(op, "move");
  return op;
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

async function validateRecoveryScope(scope: RecoveryScope, parentChromeId: string | undefined): Promise<RecoveryValidation> {
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
    ? await getSubTree(scope.mappedChromeId)
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

  discardPendingRemoteBookmarkOps(scope.workspaceId, backendIds, chromeIds);

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

  closeWorkspaceSocket(scope.workspaceId);
  await doResyncWorkspace(scope.workspaceId, reason, "recovering");
  await connectWorkspace(scope.workspaceId);
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

  const removedIds = await clearManagedChildrenWithSuppression(anchor.parentChromeId);
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
  suppressedChromeIds.clear();
  pendingRemoteBookmarkOps.clear();
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
