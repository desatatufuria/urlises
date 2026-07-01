import {
  createBookmark as apiCreateBookmark,
  createFolder as apiCreateFolder,
  deleteBookmark as apiDeleteBookmark,
  deleteFolder as apiDeleteFolder,
  getOrganizations,
  getWorkspaceTree,
  getWorkspaces,
  login as apiLogin,
  parseBookmarkDeletePayload,
  parseFolderDeletePayload,
  replayEvents,
  updateBookmark as apiUpdateBookmark,
  updateFolder as apiUpdateFolder,
  ApiError,
} from "../shared/api.js";
import { pushDiagnostic } from "../shared/diagnostics.js";
import { addExclusion, isExcluded, pruneExclusions, removeExclusions } from "../shared/exclusions.js";
import { removeMappingByBackendId, removeMappingsByChromeIds, setMapping } from "../shared/mapping.js";
import { collectBackendIds, collectBackendIdsByChromeIds, filterFoldersForProjection } from "../shared/projection-helpers.js";
import { setBackendUrl, saveSession, clearSession, ensureClientId } from "../shared/session.js";
import { createProjectionState, getState, resetStatePreservingSettings, setState, updateState } from "../shared/storage.js";
import type {
  BookmarkNode,
  BookmarkResource,
  FolderNode,
  FolderResource,
  LoginRequest,
  ProjectionState,
  SessionData,
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
const suppressedChromeIds = new Set<string>();

type WorkspaceResyncLock = {
  active: Promise<void>;
  rerunRequested: boolean;
  latestReason: string;
};

const workspaceLocks = new Map<string, WorkspaceResyncLock>();

export async function initializeBackground(): Promise<void> {
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
  for (const projection of Object.values(state.projectionsByWorkspaceId)) {
    await removeWorkspaceProjection(projection);
  }
  await clearSession();
  await resetStatePreservingSettings();
  await log("auth", "signed out and cleared local projections", "info");
  return getUiState();
}

export async function getUiState(): Promise<UiState> {
  return { state: await getState() };
}

export async function loadOptionsState(): Promise<UiState> {
  const state = await getState();
  if (state.session) {
    await refreshWorkspaceCatalog(state.session, state.settings.backendUrl);
  }
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
  }
  return getUiState();
}

export async function handleBookmarkCreated(_id: string, node: chrome.bookmarks.BookmarkTreeNode): Promise<void> {
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
  if (isSuppressed(id)) {
    return;
  }
  const context = await resolveContext(id);
  if (!context?.backendId) {
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
    await logRejectedMutation(context.workspaceId, "local change rejected by backend", error);
    return;
  }
  await resyncWorkspace(context.workspaceId, "local update accepted");
}

export async function handleBookmarkMoved(id: string, moveInfo: BookmarkMoveInfo): Promise<void> {
  if (isSuppressed(id)) {
    return;
  }
  const context = await resolveContext(id);
  if (!context?.backendId) {
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
    await logRejectedMutation(context.workspaceId, "local move rejected by backend", error);
    return;
  }
  await resyncWorkspace(context.workspaceId, "local move accepted");
}

export async function handleBookmarkRemoved(id: string, _removeInfo: BookmarkRemoveInfo): Promise<void> {
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
    if (context.entityType === "folder") {
      await apiDeleteFolder(context.state.settings.backendUrl, context.state.session!, context.backendId, context.projection.lastCursor);
    } else {
      await apiDeleteBookmark(context.state.settings.backendUrl, context.state.session!, context.backendId, context.projection.lastCursor);
    }
  } catch (error) {
    await logRejectedMutation(context.workspaceId, "local delete rejected by backend", error);
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
    await resyncWorkspace(workspaceId, reason);
    await connectWorkspace(workspaceId);
  }
}

async function connectWorkspace(workspaceId: string): Promise<void> {
  const state = await getState();
  const projection = state.projectionsByWorkspaceId[workspaceId];
  if (!state.session || !projection) {
    return;
  }

  closeWorkspaceSocket(workspaceId);
  const close = connectWorkspaceSocket(state.settings.backendUrl, state.session, workspaceId, {
    onAck: async (currentCursor) => {
      const latest = await getState();
      const current = latest.projectionsByWorkspaceId[workspaceId];
      if (!current || !latest.session) {
        return;
      }
      await markSocketState(workspaceId, true);
      if (currentCursor > current.lastCursor) {
        await replayWorkspaceDelta(workspaceId, current.lastCursor);
      }
    },
    onEvent: async (event) => {
      await applyRemoteEnvelope(workspaceId, event);
    },
    onResyncRequired: async () => {
      await resyncWorkspace(workspaceId, "server requested resync");
    },
    onClose: async () => {
      await markSocketState(workspaceId, false);
    },
    onError: async (message) => {
      await log(`ws:${workspaceId}`, message, "warn");
    },
  });

  socketClosers.set(workspaceId, close);
}

async function replayWorkspaceDelta(workspaceId: string, afterCursor: number): Promise<void> {
  const state = await getState();
  if (!state.session) {
    return;
  }
  const replay = await replayEvents(state.settings.backendUrl, state.session, workspaceId, afterCursor);
  if (replay.resyncRequired) {
    await resyncWorkspace(workspaceId, "replay gap requires resync");
    return;
  }
  for (const event of replay.events) {
    await applyRemoteEnvelope(workspaceId, event);
  }
  await updateProjectionState(workspaceId, (projection) => {
    projection.lastCursor = Math.max(projection.lastCursor, replay.currentCursor);
    projection.lastSyncedAt = new Date().toISOString();
    projection.status = "ready";
  });
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

async function logRejectedMutation(workspaceId: string, summary: string, error: unknown): Promise<void> {
  const detail = describeError(error);
  await log(`mutation:${workspaceId}`, `${summary}: ${detail}`, "error");
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

async function doResyncWorkspace(workspaceId: string, reason: string): Promise<void> {
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
      projectionState.lastError = undefined;
    }, tree.workspace);
    await log(`sync:${workspaceId}`, `resynced workspace (${reason})`, "info");
  } catch (error) {
    await updateProjectionState(workspaceId, (projection) => {
      projection.status = "error";
      projection.lastError = error instanceof Error ? error.message : "workspace resync failed";
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

  if (!allowReplayCatchup && event.cursor <= projection.lastCursor) {
    return;
  }
  if (!allowReplayCatchup && projection.lastCursor > 0 && event.cursor !== projection.lastCursor + 1) {
    await replayWorkspaceDelta(workspaceId, projection.lastCursor);
    return;
  }

  try {
    switch (event.kind) {
      case "folder.created":
      case "folder.updated":
        await applyRemoteFolderUpsert(workspaceId, event.payload as FolderResource);
        break;
      case "folder.deleted":
        await applyRemoteFolderDelete(workspaceId, parseFolderDeletePayload(event.payload), allowReplayCatchup);
        break;
      case "bookmark.created":
      case "bookmark.updated":
        await applyRemoteBookmarkUpsert(workspaceId, event.payload as BookmarkResource);
        break;
      case "bookmark.deleted":
        await applyRemoteBookmarkDelete(workspaceId, parseBookmarkDeletePayload(event.payload));
        break;
      default:
        await log(`sync:${workspaceId}`, `ignored unsupported event ${event.kind}`, "warn");
    }

    await updateProjectionState(workspaceId, (current) => {
      current.lastCursor = Math.max(current.lastCursor, event.cursor);
      current.lastSyncedAt = new Date().toISOString();
      current.status = "ready";
      current.lastError = undefined;
    });
  } catch (error) {
    await log(`sync:${workspaceId}`, `remote apply failed for ${event.kind}: ${error instanceof Error ? error.message : String(error)}`, "warn");
    await resyncWorkspace(workspaceId, `remote apply fallback for ${event.kind}`);
  }
}

async function applyRemoteFolderUpsert(workspaceId: string, folder: FolderResource): Promise<void> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection?.workspaceChromeId) {
    throw new Error("workspace projection missing for folder upsert");
  }

  if (isExcluded(projection, folder.id) || isExcluded(projection, folder.parentId)) {
    const hiddenChromeId = projection.chromeIdByBackendId[folder.id];
    if (hiddenChromeId) {
      await deleteChromeNode(workspaceId, hiddenChromeId, folder.id, "folder");
    }
    return;
  }

  const parentChromeId = folder.parentId ? projection.chromeIdByBackendId[folder.parentId] : projection.workspaceChromeId;
  if (!parentChromeId) {
    throw new Error("missing parent chrome id for folder upsert");
  }

  const chromeId = projection.chromeIdByBackendId[folder.id];
  if (!chromeId) {
    const created = await withSuppression(
      async () => createFolder(parentChromeId, folder.name, folder.position),
      [parentChromeId],
    );
    await updateProjectionState(workspaceId, (current) => {
      setMapping(current, folder.id, created.id, "folder");
    });
    return;
  }

  const existing = await getNode(chromeId);
  if (!existing) {
    throw new Error("stale folder mapping");
  }
  await withSuppression(async () => {
    if (existing.title !== folder.name) {
      await updateNode(chromeId, { title: folder.name });
    }
    if (existing.parentId !== parentChromeId || existing.index !== folder.position) {
      await moveNode(chromeId, { parentId: parentChromeId, index: folder.position });
    }
  });
}

async function applyRemoteBookmarkUpsert(workspaceId: string, bookmark: BookmarkResource): Promise<void> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) {
    throw new Error("workspace projection missing for bookmark upsert");
  }

  if (isExcluded(projection, bookmark.id) || isExcluded(projection, bookmark.folderId)) {
    const hiddenChromeId = projection.chromeIdByBackendId[bookmark.id];
    if (hiddenChromeId) {
      await deleteChromeNode(workspaceId, hiddenChromeId, bookmark.id, "bookmark");
    }
    return;
  }

  const parentChromeId = projection.chromeIdByBackendId[bookmark.folderId];
  if (!parentChromeId) {
    throw new Error("missing parent chrome id for bookmark upsert");
  }

  const chromeId = projection.chromeIdByBackendId[bookmark.id];
  if (!chromeId) {
    const created = await withSuppression(
      async () => createBookmark(parentChromeId, bookmark.title, bookmark.url, bookmark.position),
      [parentChromeId],
    );
    await updateProjectionState(workspaceId, (current) => {
      setMapping(current, bookmark.id, created.id, "bookmark");
    });
    return;
  }

  const existing = await getNode(chromeId);
  if (!existing) {
    throw new Error("stale bookmark mapping");
  }

  await withSuppression(async () => {
    if (existing.title !== bookmark.title || existing.url !== bookmark.url) {
      await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
    }
    if (existing.parentId !== parentChromeId || existing.index !== bookmark.position) {
      await moveNode(chromeId, { parentId: parentChromeId, index: bookmark.position });
    }
  });
}

async function applyRemoteFolderDelete(
  workspaceId: string,
  payload: { id: string },
  allowReplayCatchup = false,
): Promise<void> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) {
    return;
  }
  const chromeId = projection.chromeIdByBackendId[payload.id];
  if (!chromeId) {
    await updateProjectionState(workspaceId, (current) => {
      removeMappingByBackendId(current, payload.id);
      removeExclusions(current, [payload.id]);
    });
    if (!allowReplayCatchup) {
      await resyncWorkspace(workspaceId, "remote folder delete pruned excluded descendants");
    }
    return;
  }
  await deleteChromeNode(workspaceId, chromeId, payload.id, "folder");
  if (!allowReplayCatchup) {
    await resyncWorkspace(workspaceId, "remote folder delete pruned excluded descendants");
  }
}

async function applyRemoteBookmarkDelete(workspaceId: string, payload: { id: string }): Promise<void> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) {
    return;
  }
  const chromeId = projection.chromeIdByBackendId[payload.id];
  if (!chromeId) {
    await updateProjectionState(workspaceId, (current) => {
      removeMappingByBackendId(current, payload.id);
      removeExclusions(current, [payload.id]);
    });
    return;
  }
  await deleteChromeNode(workspaceId, chromeId, payload.id, "bookmark");
}

async function deleteChromeNode(
  workspaceId: string,
  chromeId: string,
  backendId: string,
  entityType: "folder" | "bookmark",
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
    removeExclusions(current, [...removedBackendIds, backendId]);
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

async function log(scope: string, message: string, level: "info" | "warn" | "error"): Promise<void> {
  await updateState((state) => pushDiagnostic(state, { scope, message, level }));
}

async function markSocketState(workspaceId: string, connected: boolean): Promise<void> {
  await updateProjectionState(workspaceId, (projection) => {
    projection.socketConnected = connected;
  });
}

function closeWorkspaceSocket(workspaceId: string): void {
  const closer = socketClosers.get(workspaceId);
  if (!closer) {
    return;
  }
  socketClosers.delete(workspaceId);
  closer();
}

function closeAllSockets(): void {
  for (const [workspaceId, close] of socketClosers.entries()) {
    socketClosers.delete(workspaceId);
    close();
  }
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
