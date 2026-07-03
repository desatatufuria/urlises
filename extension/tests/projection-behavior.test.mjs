import test from "node:test";
import assert from "node:assert/strict";

const storageData = new Map();
const bookmarkNodes = new Map();
let nextBookmarkId = 100;
let enforceStrictIndices = false;

function cloneNode(node) {
  return {
    ...node,
    children: node.children ? node.children.map(cloneNode) : undefined,
  };
}

function rebuildBookmarkChildren() {
  for (const node of bookmarkNodes.values()) {
    if (node.url) {
      delete node.children;
      continue;
    }
    node.children = [];
  }

  for (const node of bookmarkNodes.values()) {
    if (!node.parentId) {
      continue;
    }
    const parent = bookmarkNodes.get(node.parentId);
    if (parent) {
      parent.children ??= [];
      parent.children.push(node);
    }
  }

  for (const node of bookmarkNodes.values()) {
    if (node.children) {
      node.children.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    }
  }
}

function createBookmarkNode({ id, parentId, title, url, index = 0 }) {
  return {
    id,
    parentId,
    title,
    url,
    index,
    children: url ? undefined : [],
  };
}

function resetBookmarkTree() {
  bookmarkNodes.clear();
  bookmarkNodes.set("0", createBookmarkNode({ id: "0", title: "root" }));
  bookmarkNodes.set("1", createBookmarkNode({ id: "1", parentId: "0", title: "Other Bookmarks" }));
  rebuildBookmarkChildren();
  nextBookmarkId = 100;
}

function removeBookmarkSubtree(id) {
  const node = bookmarkNodes.get(id);
  if (!node) {
    return;
  }
  for (const child of [...(node.children ?? [])]) {
    removeBookmarkSubtree(child.id);
  }
  bookmarkNodes.delete(id);
}

globalThis.chrome = {
  runtime: {
    lastError: null,
  },
  storage: {
    local: {
      get(key, callback) {
        setTimeout(() => {
          callback({ [key]: storageData.get(key) });
        }, 0);
      },
      set(items, callback) {
        setTimeout(() => {
          for (const [key, value] of Object.entries(items)) {
            storageData.set(key, value);
          }
          callback();
        }, 0);
      },
    },
  },
  bookmarks: {
    get(id, callback) {
      callback(bookmarkNodes.has(id) ? [cloneNode(bookmarkNodes.get(id))] : []);
    },
    getChildren(id, callback) {
      rebuildBookmarkChildren();
      const node = bookmarkNodes.get(id);
      callback((node?.children ?? []).map(cloneNode));
    },
    getSubTree(id, callback) {
      rebuildBookmarkChildren();
      const node = bookmarkNodes.get(id);
      callback(node ? [cloneNode(node)] : []);
    },
    getTree(callback) {
      rebuildBookmarkChildren();
      callback([cloneNode(bookmarkNodes.get("0"))]);
    },
    create(details, callback) {
      const parent = bookmarkNodes.get(details.parentId);
      if (enforceStrictIndices && typeof details.index === "number" && details.index > (parent?.children?.length ?? 0)) {
        globalThis.chrome.runtime.lastError = { message: "Index out of bounds." };
        callback(undefined);
        globalThis.chrome.runtime.lastError = null;
        return;
      }
      const id = String(nextBookmarkId++);
      bookmarkNodes.set(id, createBookmarkNode({ id, ...details }));
      rebuildBookmarkChildren();
      callback(cloneNode(bookmarkNodes.get(id)));
    },
    update(id, changes, callback) {
      const node = bookmarkNodes.get(id);
      Object.assign(node, changes);
      rebuildBookmarkChildren();
      callback(cloneNode(node));
    },
    move(id, destination, callback) {
      const node = bookmarkNodes.get(id);
      Object.assign(node, destination);
      rebuildBookmarkChildren();
      callback(cloneNode(node));
    },
    remove(id, callback) {
      bookmarkNodes.delete(id);
      rebuildBookmarkChildren();
      callback();
    },
    removeTree(id, callback) {
      removeBookmarkSubtree(id);
      rebuildBookmarkChildren();
      callback();
    },
  },
};

class MockWebSocket {
  static instances = [];

  static CONNECTING = 0;

  static OPEN = 1;

  static CLOSING = 2;

  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.listeners = { open: [], message: [], error: [], close: [] };
    this.closed = false;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }

  async emitMessage(payload) {
    for (const listener of this.listeners.message) {
      await listener({ data: JSON.stringify(payload) });
    }
  }

  async emitOpen() {
    for (const listener of this.listeners.open) {
      await listener();
    }
  }

  async emitClose() {
    this.readyState = MockWebSocket.CLOSED;
    for (const listener of this.listeners.close) {
      await listener();
    }
  }

  send(payload) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

globalThis.WebSocket = MockWebSocket;

import { pruneExclusions, removeExclusions } from "../dist/shared/exclusions.js";
import { removeMappingsByBackendIds } from "../dist/shared/mapping.js";
import {
  filterFoldersForProjection,
  findReusableBookmarkNode,
  findReusableFolderNode,
} from "../dist/shared/projection-helpers.js";
import {
  handleBookmarkChanged,
  handleBookmarkMoved,
  handleBookmarkRemoved,
  markActivitySeen,
  projectionTestHooks,
  runCoalescedWorkspaceTask,
} from "../dist/background/projection.js";
import { getState, setState } from "../dist/shared/storage.js";
import { connectWorkspaceSocket } from "../dist/shared/websocket.js";

const fetchLog = [];
let fetchHandlers = [];

globalThis.fetch = async (input) => {
  const url = String(input);
  fetchLog.push(url);
  const handler = fetchHandlers.find((candidate) => candidate.match(url));
  if (!handler) {
    throw new Error(`Unhandled fetch: ${url}`);
  }
  return handler.respond(url);
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ackResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Sync-Event-Id": "evt-ack",
      "X-Sync-Cursor": "6",
      "X-Sync-Duplicate": "false",
    },
  });
}

function createSyncEvent(overrides = {}) {
  return {
    cursor: 8,
    eventId: "evt-8",
    workspaceId: "workspace-1",
    originClientId: "client-2",
    kind: "bookmark.updated",
    entityType: "bookmark",
    entityId: "bookmark-1",
    createdAt: "2026-07-02T00:00:03.000Z",
    payload: {
      id: "bookmark-1",
      workspaceId: "workspace-1",
      folderId: "folder-a",
      title: "Remote Bookmark",
      url: "https://example.com/remote",
      position: 0,
      createdAt: "2026-07-02T00:00:03.000Z",
      updatedAt: "2026-07-02T00:00:03.000Z",
    },
    ...overrides,
  };
}

function createEditorProjection(overrides = {}) {
  return createProjection({
    workspace: {
      workspaceId: "workspace-1",
      workspaceName: "Workspace",
      workspaceType: "shared",
      organizationId: "org-1",
      organizationName: "Org",
      role: "editor",
    },
    ...overrides,
  });
}

function flushMicrotasks(times = 4) {
  return Array.from({ length: times }).reduce(
    (promise) => promise.then(() => Promise.resolve()),
    Promise.resolve(),
  );
}

function createRuntimeState({
  lastCursor = 0,
  health = "live",
  status = "ready",
  socketConnected = false,
  recoveryAttemptCount = 0,
} = {}) {
  const workspace = {
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    workspaceType: "shared",
    organizationId: "org-1",
    organizationName: "Org",
    role: "viewer",
  };

  return {
    settings: {
      backendUrl: "http://localhost:8081",
      clientId: "client-1",
    },
    session: {
      accessToken: "token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      clientId: "client-1",
      user: {
        id: "user-1",
        email: "user@example.com",
      },
    },
    selectedWorkspaceIds: [workspace.workspaceId],
    cachedOrganizations: [],
    cachedWorkspacesByOrganization: {},
    projectionsByWorkspaceId: {
      [workspace.workspaceId]: createProjection({
        workspace,
        lastCursor,
        health,
        status,
        socketConnected,
        recoveryAttemptCount,
      }),
    },
    diagnostics: [],
  };
}

async function resetRuntime() {
  storageData.clear();
  resetBookmarkTree();
  MockWebSocket.reset();
  fetchLog.length = 0;
  fetchHandlers = [];
  enforceStrictIndices = false;
  globalThis.chrome.runtime.lastError = null;
  projectionTestHooks.resetRuntimeState();
  await setState(createRuntimeState());
}

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createProjection(overrides = {}) {
  return {
    workspace: {
      workspaceId: "workspace-1",
      workspaceName: "Workspace",
      workspaceType: "shared",
      organizationId: "org-1",
      organizationName: "Org",
      role: "viewer",
    },
    chromeIdByBackendId: {},
    backendIdByChromeId: {},
    entityTypeByBackendId: {},
    excludedBackendNodeIds: [],
    lastCursor: 0,
    status: "ready",
    health: "live",
    recoveryAttemptCount: 0,
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetRuntime();
});

test("connectWorkspaceSocket sends keepalive only after an idle window and clears timers on close", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map();
  let nextTimerId = 1;

  globalThis.setTimeout = (callback, delay) => {
    const id = nextTimerId++;
    scheduled.set(id, { callback, delay });
    return id;
  };

  globalThis.clearTimeout = (id) => {
    scheduled.delete(id);
  };

  try {
    const callbacks = {
      onAck: async () => {},
      onEvent: async () => {},
      onResyncRequired: async () => {},
      onClose: async () => {},
      onError: async () => {},
    };

    const close = connectWorkspaceSocket("http://localhost:8081", createRuntimeState().session, "workspace-1", callbacks);
    const socket = MockWebSocket.instances[0];

    await socket.emitOpen();
    assert.equal(scheduled.size, 1);
    assert.equal([...scheduled.values()][0].delay, 20_000);

    await socket.emitMessage({ type: "ack", currentCursor: 5 });
    assert.deepEqual(socket.sent, []);
    assert.equal(scheduled.size, 1);

    const firstTimer = [...scheduled.values()][0];
    firstTimer.callback();

    assert.deepEqual(socket.sent, ['{"type":"keepalive"}']);
    assert.equal(scheduled.size, 1);

    await socket.emitClose();
    assert.equal(scheduled.size, 0);

    close();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("filterFoldersForProjection preserves local exclusions across snapshot rebuilds", () => {
  const projection = createProjection({
    excludedBackendNodeIds: ["folder-hidden", "bookmark-hidden"],
  });

  const filtered = filterFoldersForProjection([
    {
      id: "folder-visible",
      name: "Visible Folder",
      position: 0,
      folders: [
        {
          id: "folder-hidden",
          name: "Hidden Folder Renamed Remotely",
          position: 0,
          folders: [],
          bookmarks: [
            {
              id: "bookmark-under-hidden-folder",
              folderId: "folder-hidden",
              title: "Should stay hidden with parent",
              url: "https://example.com/hidden-parent",
              position: 0,
            },
          ],
        },
      ],
      bookmarks: [
        {
          id: "bookmark-visible",
          folderId: "folder-visible",
          title: "Visible Bookmark",
          url: "https://example.com/visible",
          position: 0,
        },
        {
          id: "bookmark-hidden",
          folderId: "folder-visible",
          title: "Hidden Bookmark Renamed Remotely",
          url: "https://example.com/hidden-bookmark",
          position: 1,
        },
      ],
    },
  ], projection);

  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0].folders, []);
  assert.deepEqual(filtered[0].bookmarks.map((bookmark) => bookmark.id), ["bookmark-visible"]);
});

test("removeExclusions clears mapped descendant exclusions after canonical folder deletion", () => {
  const projection = createProjection({
    excludedBackendNodeIds: ["folder-a", "folder-b", "bookmark-c", "bookmark-keep"],
  });

  removeExclusions(projection, ["folder-a", "folder-b", "bookmark-c"]);

  assert.deepEqual(projection.excludedBackendNodeIds, ["bookmark-keep"]);
});

test("pruneExclusions drops deleted subtree exclusions during resync", () => {
  const projection = createProjection({
    excludedBackendNodeIds: ["folder-deleted", "bookmark-deleted", "folder-still-visible"],
  });

  pruneExclusions(projection, new Set(["folder-still-visible", "bookmark-still-visible"]));

  assert.deepEqual(projection.excludedBackendNodeIds, ["folder-still-visible"]);
});

test("removeMappingsByBackendIds prunes affected subtree mappings deterministically", () => {
  const projection = createProjection({
    chromeIdByBackendId: {
      "folder-parent": "chrome-parent",
      "folder-child": "chrome-child",
      "bookmark-child": "chrome-bookmark",
    },
    backendIdByChromeId: {
      "chrome-parent": "folder-parent",
      "chrome-child": "folder-child",
      "chrome-bookmark": "bookmark-child",
    },
    entityTypeByBackendId: {
      "folder-parent": "folder",
      "folder-child": "folder",
      "bookmark-child": "bookmark",
    },
  });

  removeMappingsByBackendIds(projection, ["folder-child", "bookmark-child"]);

  assert.equal(projection.chromeIdByBackendId["folder-parent"], "chrome-parent");
  assert.equal(projection.chromeIdByBackendId["folder-child"], undefined);
  assert.equal(projection.backendIdByChromeId["chrome-bookmark"], undefined);
});

test("runCoalescedWorkspaceTask coalesces burst triggers into one follow-up run", async () => {
  const locks = new Map();
  const runs = [];
  const firstPass = deferred();
  const secondPass = deferred();

  let invocation = 0;
  const runner = async (reason) => {
    runs.push(reason);
    invocation += 1;
    if (invocation === 1) {
      await firstPass.promise;
      return;
    }
    await secondPass.promise;
  };

  const initial = runCoalescedWorkspaceTask(locks, "workspace-1", "initial trigger", runner);
  await Promise.resolve();

  const waitingA = runCoalescedWorkspaceTask(locks, "workspace-1", "burst trigger A", runner);
  const waitingB = runCoalescedWorkspaceTask(locks, "workspace-1", "burst trigger B", runner);

  assert.deepEqual(runs, ["initial trigger"]);
  firstPass.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(runs, ["initial trigger", "burst trigger B"]);
  secondPass.resolve();

  await Promise.all([initial, waitingA, waitingB]);
  assert.deepEqual(runs, ["initial trigger", "burst trigger B"]);
  assert.equal(locks.size, 0);
});

test("findReusableFolderNode reuses a single matching managed folder under the expected parent", () => {
  const reusable = findReusableFolderNode([
    { id: "folder-1", title: "Team", parentId: "workspace-1" },
    { id: "folder-2", title: "Other", parentId: "workspace-1" },
  ], "Team");

  assert.equal(reusable?.id, "folder-1");
});

test("findReusableFolderNode refuses ambiguous duplicate titles", () => {
  const reusable = findReusableFolderNode([
    { id: "folder-1", title: "Team", parentId: "workspace-1" },
    { id: "folder-2", title: "Team", parentId: "workspace-1" },
  ], "Team");

  assert.equal(reusable, null);
});

test("findReusableBookmarkNode reuses a single matching managed bookmark under the expected parent", () => {
  const reusable = findReusableBookmarkNode([
    { id: "bookmark-1", title: "Docs", url: "https://example.com/docs", parentId: "folder-1" },
    { id: "bookmark-2", title: "Other", url: "https://example.com/other", parentId: "folder-1" },
  ], "Docs", "https://example.com/docs");

  assert.equal(reusable?.id, "bookmark-1");
});

test("connectWorkspace rebuilds the affected subtree when a folder mapping is stale", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("canonical-folder", createBookmarkNode({ id: "canonical-folder", parentId: "workspace-node", title: "Docs", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-remote": "missing-folder" },
        backendIdByChromeId: { "missing-folder": "folder-remote" },
        entityTypeByBackendId: { "folder-remote": "folder" },
        lastCursor: 7,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "viewer",
        },
        folders: [
          {
            id: "folder-remote",
            name: "Docs",
            position: 0,
            folders: [],
            bookmarks: [],
          },
        ],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=7"),
      respond: () => jsonResponse({
        currentCursor: 8,
        events: [
          {
            cursor: 8,
            eventId: "evt-folder-8",
            workspaceId: "workspace-1",
            originClientId: "client-2",
            kind: "folder.created",
            entityType: "folder",
            entityId: "folder-remote",
            createdAt: "2026-07-02T00:00:02.000Z",
            payload: {
              id: "folder-remote",
              workspaceId: "workspace-1",
              name: "Docs",
              position: 0,
              createdAt: "2026-07-02T00:00:02.000Z",
              updatedAt: "2026-07-02T00:00:02.000Z",
            },
          },
        ],
      }),
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: {
      cursor: 8,
      eventId: "evt-folder-8",
      workspaceId: "workspace-1",
      originClientId: "client-2",
      kind: "folder.created",
      entityType: "folder",
      entityId: "folder-remote",
      createdAt: "2026-07-02T00:00:02.000Z",
      payload: {
        id: "folder-remote",
        workspaceId: "workspace-1",
        name: "Docs",
        position: 0,
        createdAt: "2026-07-02T00:00:02.000Z",
        updatedAt: "2026-07-02T00:00:02.000Z",
      },
    },
  });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  const workspaceChildren = bookmarkNodes.get("workspace-node")?.children ?? [];
  const docsChildren = workspaceChildren.filter((node) => node.title === "Docs");

  assert.equal(docsChildren.length, 1);
  assert.equal(bookmarkNodes.has("canonical-folder"), false);
  assert.equal(projection.chromeIdByBackendId["folder-remote"], docsChildren[0]?.id);
  assert.equal(projection.backendIdByChromeId[docsChildren[0]?.id ?? ""], "folder-remote");
  assert.equal(projection.backendIdByChromeId["missing-folder"], undefined);
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.health, "live");
});

test("connectWorkspace replays ack gaps before returning to live health", async () => {
  await setState(createRuntimeState({ lastCursor: 5 }));
  fetchHandlers = [
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=5"),
      respond: () => jsonResponse({
        currentCursor: 7,
        events: [
          { cursor: 6, eventId: "evt-6", workspaceId: "workspace-1", originClientId: "client-2", kind: "noop", entityType: "folder", entityId: "folder-6", payload: {}, createdAt: "2026-07-02T00:00:00.000Z" },
          { cursor: 7, eventId: "evt-7", workspaceId: "workspace-1", originClientId: "client-2", kind: "noop", entityType: "folder", entityId: "folder-7", payload: {}, createdAt: "2026-07-02T00:00:01.000Z" },
        ],
      }),
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(fetchLog.length, 1);
  assert.match(fetchLog[0], /afterCursor=5$/);
  assert.equal(projection.lastCursor, 7);
  assert.equal(projection.health, "live");
  assert.equal(projection.status, "ready");
  assert.equal(projection.recoveryAttemptCount, 0);
});

test("connectWorkspace silently reconnects after socket close and restores live health on ack", async () => {
  await setState(createRuntimeState({ lastCursor: 5 }));

  await projectionTestHooks.recoverWorkspace("workspace-1", "websocket closed", "reconnect");

  assert.equal(MockWebSocket.instances.length, 1);
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.health, "recovering");
  assert.equal(projection.status, "syncing");
  assert.equal(projection.recoveryAttemptCount, 1);

  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 5 });

  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.health, "live");
  assert.equal(projection.status, "ready");
  assert.equal(projection.recoveryAttemptCount, 0);
});

test("live remote activity updates revision metadata and markActivitySeen acknowledges it", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Local Bookmark", url: "https://example.com/local", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7, socketConnected: true }),
    activitySignal: { revision: 0, lastSeenRevision: 0 },
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" },
        backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" },
        entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" },
        lastCursor: 7,
        activityRevision: 0,
      }),
    },
  });

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: createSyncEvent({
      payload: {
        id: "bookmark-1",
        workspaceId: "workspace-1",
        folderId: "folder-a",
        title: "Remote Bookmark",
        url: "https://example.com/remote",
        position: 0,
        createdAt: "2026-07-03T16:00:00.000Z",
        updatedAt: "2026-07-03T16:00:00.000Z",
      },
      createdAt: "2026-07-03T16:00:00.000Z",
    }),
  });

  let state = await getState();
  assert.equal(state.activitySignal?.revision, 1);
  assert.equal(state.activitySignal?.lastSeenRevision, 0);
  assert.equal(state.projectionsByWorkspaceId["workspace-1"].activityRevision, 1);
  assert.equal(state.projectionsByWorkspaceId["workspace-1"].lastActivityAt, "2026-07-03T16:00:00.000Z");
  assert.deepEqual(state.projectionsByWorkspaceId["workspace-1"].lastActivity, {
    entityType: "bookmark",
    action: "updated",
    label: "Remote Bookmark",
  });

  await markActivitySeen();
  state = await getState();
  assert.equal(state.activitySignal?.lastSeenRevision, 1);
});

test("connectWorkspace falls back to full resync when replay reports a gap", async () => {
  await setState(createRuntimeState({ lastCursor: 5 }));
  fetchHandlers = [
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=5"),
      respond: () => jsonResponse({ currentCursor: 8, events: [], resyncRequired: true }),
    },
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "viewer",
        },
        folders: [],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=0"),
      respond: () => jsonResponse({ currentCursor: 8, events: [] }),
    },
  ];

  await projectionTestHooks.replayWorkspaceDelta("workspace-1", 5, "resume after socket ack");

  assert.equal(MockWebSocket.instances.length, 1);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=5")).length, 1);
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 1);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=0")).length, 1);

  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 8 });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.health, "live");
  assert.equal(projection.status, "ready");
});

test("connectWorkspace degrades only after the silent recovery budget is exhausted", async () => {
  await setState(createRuntimeState({ lastCursor: 5 }));

  await projectionTestHooks.recoverWorkspace("workspace-1", "websocket closed", "reconnect");
  await projectionTestHooks.recoverWorkspace("workspace-1", "websocket closed", "reconnect");
  await projectionTestHooks.recoverWorkspace("workspace-1", "websocket closed", "reconnect");

  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.health, "recovering");
  assert.equal(projection.recoveryAttemptCount, 3);

  await projectionTestHooks.recoverWorkspace("workspace-1", "websocket closed", "reconnect");

  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(MockWebSocket.instances.length, 3);
  assert.equal(projection.health, "degraded");
  assert.equal(projection.status, "error");
  assert.equal(projection.degradedReason, "websocket closed");
});

test("connectWorkspace logs live remote apply context before resyncing on out-of-bounds bookmark creation", async () => {
  enforceStrictIndices = true;
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("parent-folder", createBookmarkNode({ id: "parent-folder", parentId: "workspace-node", title: "Docs", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-parent": "parent-folder" },
        backendIdByChromeId: { "parent-folder": "folder-parent" },
        entityTypeByBackendId: { "folder-parent": "folder" },
        lastCursor: 7,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "viewer",
        },
        folders: [],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=0"),
      respond: () => jsonResponse({ currentCursor: 8, events: [] }),
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: {
      cursor: 8,
      eventId: "evt-bookmark-8",
      workspaceId: "workspace-1",
      originClientId: "client-2",
      kind: "bookmark.created",
      entityType: "bookmark",
      entityId: "bookmark-remote",
      createdAt: "2026-07-02T00:00:03.000Z",
      payload: {
        id: "bookmark-remote",
        workspaceId: "workspace-1",
        folderId: "folder-parent",
        title: "Debug Bookmark",
        url: "https://example.com/debug",
        position: 5,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    },
  });

  const diagnostics = (await getState()).diagnostics.map((entry) => entry.message);
  const applyLine = diagnostics.find((entry) => entry.includes("eventId=evt-bookmark-8") && entry.includes("action=live-apply"));
  const resyncLine = diagnostics.find((entry) => entry.includes("eventId=evt-bookmark-8") && entry.includes("action=resync") && entry.includes("failure=Index out of bounds."));

  assert.ok(applyLine);
  assert.match(applyLine, /operation=bookmark-upsert/);
  assert.match(applyLine, /expectedParentChromeId=parent-folder/);
  assert.match(applyLine, /currentChildCount=0/);
  assert.match(applyLine, /requestedIndex=5/);
  assert.match(applyLine, /branch=create/);

  assert.ok(resyncLine);
  assert.match(resyncLine, /action=resync/);
});

test("connectWorkspace restores a missing parent subtree before bookmark apply resumes", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-parent": "missing-parent" },
        backendIdByChromeId: { "missing-parent": "folder-parent" },
        entityTypeByBackendId: { "folder-parent": "folder" },
        lastCursor: 7,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "viewer",
        },
        folders: [
          {
            id: "folder-parent",
            name: "Docs",
            position: 0,
            folders: [],
            bookmarks: [
              {
                id: "bookmark-remote",
                folderId: "folder-parent",
                title: "Debug Bookmark",
                url: "https://example.com/debug",
                position: 0,
              },
            ],
          },
        ],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=7"),
      respond: () => jsonResponse({
        currentCursor: 8,
        events: [
          {
            cursor: 8,
            eventId: "evt-bookmark-8",
            workspaceId: "workspace-1",
            originClientId: "client-2",
            kind: "bookmark.created",
            entityType: "bookmark",
            entityId: "bookmark-remote",
            createdAt: "2026-07-02T00:00:03.000Z",
            payload: {
              id: "bookmark-remote",
              workspaceId: "workspace-1",
              folderId: "folder-parent",
              title: "Debug Bookmark",
              url: "https://example.com/debug",
              position: 0,
              createdAt: "2026-07-02T00:00:03.000Z",
              updatedAt: "2026-07-02T00:00:03.000Z",
            },
          },
        ],
      }),
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: {
      cursor: 8,
      eventId: "evt-bookmark-8",
      workspaceId: "workspace-1",
      originClientId: "client-2",
      kind: "bookmark.created",
      entityType: "bookmark",
      entityId: "bookmark-remote",
      createdAt: "2026-07-02T00:00:03.000Z",
      payload: {
        id: "bookmark-remote",
        workspaceId: "workspace-1",
        folderId: "folder-parent",
        title: "Debug Bookmark",
        url: "https://example.com/debug",
        position: 0,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    },
  });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 1);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=7")).length, 1);
  assert.equal(projection.chromeIdByBackendId["folder-parent"], "100");
  assert.equal(projection.chromeIdByBackendId["bookmark-remote"], "101");
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.health, "live");
});

test("remote bookmark update side effects are not re-emitted as local changes", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Local Bookmark", url: "https://example.com/local", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" },
        backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" },
        entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" },
        lastCursor: 7,
      }),
    },
  });

  let bookmarkPatchCalls = 0;
  fetchHandlers = [
    {
      match: (url) => url.endsWith("/bookmarks/bookmark-1"),
      respond: () => {
        bookmarkPatchCalls += 1;
        return ackResponse();
      },
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: createSyncEvent({
      payload: {
        id: "bookmark-1",
        workspaceId: "workspace-1",
        folderId: "folder-a",
        title: "Remote Bookmark",
        url: "https://example.com/remote",
        position: 0,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    }),
  });

  await handleBookmarkChanged("bookmark-node", {
    title: "Remote Bookmark",
    url: "https://example.com/remote",
  });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(bookmarkPatchCalls, 0);
  assert.equal(bookmarkNodes.get("bookmark-node")?.title, "Remote Bookmark");
  assert.equal(bookmarkNodes.get("bookmark-node")?.url, "https://example.com/remote");
  assert.equal(projection.lastCursor, 8);
});

test("remote bookmark title-only update side effects are not re-emitted as local changes", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Local Bookmark", url: "https://example.com/local", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" },
        backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" },
        entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" },
        lastCursor: 7,
      }),
    },
  });

  let bookmarkPatchCalls = 0;
  fetchHandlers = [
    {
      match: (url) => url.endsWith("/bookmarks/bookmark-1"),
      respond: () => {
        bookmarkPatchCalls += 1;
        return ackResponse();
      },
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: createSyncEvent({
      payload: {
        id: "bookmark-1",
        workspaceId: "workspace-1",
        folderId: "folder-a",
        title: "Remote Bookmark",
        url: "https://example.com/local",
        position: 0,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    }),
  });

  await handleBookmarkChanged("bookmark-node", {
    title: "Remote Bookmark",
  });

  assert.equal(bookmarkPatchCalls, 0);
  assert.equal(bookmarkNodes.get("bookmark-node")?.title, "Remote Bookmark");
  assert.equal(bookmarkNodes.get("bookmark-node")?.url, "https://example.com/local");
});

test("remote bookmark url-only update side effects are not re-emitted as local changes", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Local Bookmark", url: "https://example.com/local", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" },
        backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" },
        entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" },
        lastCursor: 7,
      }),
    },
  });

  let bookmarkPatchCalls = 0;
  fetchHandlers = [
    {
      match: (url) => url.endsWith("/bookmarks/bookmark-1"),
      respond: () => {
        bookmarkPatchCalls += 1;
        return ackResponse();
      },
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: createSyncEvent({
      payload: {
        id: "bookmark-1",
        workspaceId: "workspace-1",
        folderId: "folder-a",
        title: "Local Bookmark",
        url: "https://example.com/remote",
        position: 0,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    }),
  });

  await handleBookmarkChanged("bookmark-node", {
    url: "https://example.com/remote",
  });

  assert.equal(bookmarkPatchCalls, 0);
  assert.equal(bookmarkNodes.get("bookmark-node")?.title, "Local Bookmark");
  assert.equal(bookmarkNodes.get("bookmark-node")?.url, "https://example.com/remote");
});

test("remote bookmark move preserves final parent/index without local move re-emission", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("folder-b", createBookmarkNode({ id: "folder-b", parentId: "workspace-node", title: "Links", index: 1 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Bookmark", url: "https://example.com/bookmark", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-a": "folder-a", "folder-b": "folder-b", "bookmark-1": "bookmark-node" },
        backendIdByChromeId: { "folder-a": "folder-a", "folder-b": "folder-b", "bookmark-node": "bookmark-1" },
        entityTypeByBackendId: { "folder-a": "folder", "folder-b": "folder", "bookmark-1": "bookmark" },
        lastCursor: 7,
      }),
    },
  });

  let bookmarkPatchCalls = 0;
  fetchHandlers = [
    {
      match: (url) => url.endsWith("/bookmarks/bookmark-1"),
      respond: () => {
        bookmarkPatchCalls += 1;
        return ackResponse();
      },
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: createSyncEvent({
      payload: {
        id: "bookmark-1",
        workspaceId: "workspace-1",
        folderId: "folder-b",
        title: "Bookmark",
        url: "https://example.com/bookmark",
        position: 0,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    }),
  });

  await handleBookmarkMoved("bookmark-node", {
    parentId: "folder-b",
    oldParentId: "folder-a",
    index: 0,
    oldIndex: 0,
  });

  const movedNode = bookmarkNodes.get("bookmark-node");
  assert.equal(bookmarkPatchCalls, 0);
  assert.equal(movedNode?.parentId, "folder-b");
  assert.equal(movedNode?.index, 0);
});

test("remote bookmark update and move consume suppression independently", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("folder-b", createBookmarkNode({ id: "folder-b", parentId: "workspace-node", title: "Links", index: 1 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Local Bookmark", url: "https://example.com/local", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-a": "folder-a", "folder-b": "folder-b", "bookmark-1": "bookmark-node" },
        backendIdByChromeId: { "folder-a": "folder-a", "folder-b": "folder-b", "bookmark-node": "bookmark-1" },
        entityTypeByBackendId: { "folder-a": "folder", "folder-b": "folder", "bookmark-1": "bookmark" },
        lastCursor: 7,
      }),
    },
  });

  let bookmarkPatchCalls = 0;
  fetchHandlers = [
    {
      match: (url) => url.endsWith("/bookmarks/bookmark-1"),
      respond: () => {
        bookmarkPatchCalls += 1;
        return ackResponse();
      },
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: createSyncEvent({
      payload: {
        id: "bookmark-1",
        workspaceId: "workspace-1",
        folderId: "folder-b",
        title: "Remote Bookmark",
        url: "https://example.com/remote",
        position: 0,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    }),
  });

  await handleBookmarkChanged("bookmark-node", {
    title: "Remote Bookmark",
    url: "https://example.com/remote",
  });
  await handleBookmarkMoved("bookmark-node", {
    parentId: "folder-b",
    oldParentId: "folder-a",
    index: 0,
    oldIndex: 0,
  });

  assert.equal(bookmarkPatchCalls, 0);
  assert.equal(bookmarkNodes.get("bookmark-node")?.parentId, "folder-b");
  assert.equal(bookmarkNodes.get("bookmark-node")?.title, "Remote Bookmark");
});

test("handleBookmarkChanged stops retrying repeated rejected local updates after recovery starts", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-node", title: "Bookmark", url: "https://example.com/bookmark", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 5 }),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-1": "folder-node", "bookmark-1": "bookmark-node" },
        backendIdByChromeId: { "folder-node": "folder-1", "bookmark-node": "bookmark-1" },
        entityTypeByBackendId: { "folder-1": "folder", "bookmark-1": "bookmark" },
        lastCursor: 5,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/bookmarks/bookmark-1"),
      respond: () => errorResponse(404, "not found"),
    },
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        folders: [],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=5"),
      respond: () => jsonResponse({ currentCursor: 5, events: [] }),
    },
  ];

  await handleBookmarkChanged("bookmark-node", {
    title: "Renamed Bookmark",
    url: "https://example.com/bookmark",
  });
  await handleBookmarkChanged("bookmark-node", {
    title: "Renamed Bookmark",
    url: "https://example.com/bookmark",
  });
  await flushMicrotasks();

  const state = await getState();
  const projection = state.projectionsByWorkspaceId["workspace-1"];
  const diagnostics = state.diagnostics.map((entry) => entry.message);
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 1);
  assert.equal(diagnostics.filter((entry) => entry.includes("local change rejected by backend")).length, 1);
  assert.equal(projection.chromeIdByBackendId["bookmark-1"], undefined);
});

test("handleBookmarkRemoved stops retrying a rejected local delete after bounded recovery starts", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "workspace-node", title: "Docs", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 5 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-1": "folder-node" },
        backendIdByChromeId: { "folder-node": "folder-1" },
        entityTypeByBackendId: { "folder-1": "folder" },
        lastCursor: 5,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/folders/folder-1"),
      respond: () => errorResponse(404, "not found"),
    },
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        folders: [],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=5"),
      respond: () => jsonResponse({ currentCursor: 5, events: [] }),
    },
  ];

  await handleBookmarkRemoved("folder-node", { parentId: "workspace-node", index: 0 });
  await handleBookmarkRemoved("folder-node", { parentId: "workspace-node", index: 0 });
  await flushMicrotasks();

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 1);
  assert.equal(projection.chromeIdByBackendId["folder-1"], undefined);
});

test("handleBookmarkMoved stops retrying a rejected local move after bounded recovery starts", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "workspace-node", title: "Docs", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 5 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-1": "folder-node" },
        backendIdByChromeId: { "folder-node": "folder-1" },
        entityTypeByBackendId: { "folder-1": "folder" },
        lastCursor: 5,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/folders/folder-1"),
      respond: () => errorResponse(404, "not found"),
    },
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        folders: [],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=5"),
      respond: () => jsonResponse({ currentCursor: 5, events: [] }),
    },
  ];

  await handleBookmarkMoved("folder-node", { parentId: "workspace-node", index: 0, oldParentId: "workspace-node", oldIndex: 0 });
  await handleBookmarkMoved("folder-node", { parentId: "workspace-node", index: 0, oldParentId: "workspace-node", oldIndex: 0 });
  await flushMicrotasks();

  const state = await getState();
  const projection = state.projectionsByWorkspaceId["workspace-1"];
  const diagnostics = state.diagnostics.map((entry) => entry.message);
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 1);
  assert.equal(diagnostics.filter((entry) => entry.includes("local move rejected by backend")).length, 1);
  assert.equal(projection.chromeIdByBackendId["folder-1"], undefined);
});

test("connectWorkspace falls back from subtree recovery to workspace resync before degrading", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-parent": "missing-parent" },
        backendIdByChromeId: { "missing-parent": "folder-parent" },
        entityTypeByBackendId: { "folder-parent": "folder" },
        lastCursor: 7,
      }),
    },
  });

  let treeReads = 0;
  fetchHandlers = [
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => {
        treeReads += 1;
        if (treeReads === 1) {
          return jsonResponse({
            workspace: {
              workspaceId: "workspace-1",
              workspaceName: "Workspace",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Org",
              role: "viewer",
            },
            folders: [],
          });
        }
        return jsonResponse({
          workspace: {
            workspaceId: "workspace-1",
            workspaceName: "Workspace",
            workspaceType: "shared",
            organizationId: "org-1",
            organizationName: "Org",
            role: "viewer",
          },
          folders: [
            {
              id: "folder-parent",
              name: "Docs",
              position: 0,
              folders: [],
              bookmarks: [
                {
                  id: "bookmark-remote",
                  folderId: "folder-parent",
                  title: "Debug Bookmark",
                  url: "https://example.com/debug",
                  position: 0,
                },
              ],
            },
          ],
        });
      },
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=7"),
      respond: () => jsonResponse({ currentCursor: 8, events: [], resyncRequired: true }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=0"),
      respond: () => jsonResponse({ currentCursor: 8, events: [] }),
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: {
      cursor: 8,
      eventId: "evt-bookmark-8",
      workspaceId: "workspace-1",
      originClientId: "client-2",
      kind: "bookmark.created",
      entityType: "bookmark",
      entityId: "bookmark-remote",
      createdAt: "2026-07-02T00:00:03.000Z",
      payload: {
        id: "bookmark-remote",
        workspaceId: "workspace-1",
        folderId: "folder-parent",
        title: "Debug Bookmark",
        url: "https://example.com/debug",
        position: 0,
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z",
      },
    },
  });

  await MockWebSocket.instances.at(-1).emitMessage({ type: "ack", currentCursor: 8 });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  const diagnostics = (await getState()).diagnostics.map((entry) => entry.message);
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 2);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=7")).length, 1);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=0")).length, 1);
  assert.ok(diagnostics.some((entry) => entry.includes("action=recover-subtree") && entry.includes("entityId=bookmark-remote")));
  assert.ok(diagnostics.some((entry) => entry.includes("action=recover-workspace") && entry.includes("entityId=bookmark-remote")));
  assert.equal(projection.health, "live");
  assert.equal(projection.degradedReason, undefined);
});

test("connectWorkspace validates the expected parent path before folder delete continues", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "workspace-node", title: "Docs", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: {
          "folder-parent": "missing-parent",
          "folder-deleted": "folder-node",
        },
        backendIdByChromeId: {
          "missing-parent": "folder-parent",
          "folder-node": "folder-deleted",
        },
        entityTypeByBackendId: {
          "folder-parent": "folder",
          "folder-deleted": "folder",
        },
        lastCursor: 7,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "viewer",
        },
        folders: [],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=7"),
      respond: () => jsonResponse({
        currentCursor: 8,
        events: [
          {
            cursor: 8,
            eventId: "evt-folder-delete-8",
            workspaceId: "workspace-1",
            originClientId: "client-2",
            kind: "folder.deleted",
            entityType: "folder",
            entityId: "folder-deleted",
            createdAt: "2026-07-02T00:00:04.000Z",
            payload: {
              id: "folder-deleted",
              workspaceId: "workspace-1",
              parentId: "folder-parent",
            },
          },
        ],
      }),
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: {
      cursor: 8,
      eventId: "evt-folder-delete-8",
      workspaceId: "workspace-1",
      originClientId: "client-2",
      kind: "folder.deleted",
      entityType: "folder",
      entityId: "folder-deleted",
      createdAt: "2026-07-02T00:00:04.000Z",
      payload: {
        id: "folder-deleted",
        workspaceId: "workspace-1",
        parentId: "folder-parent",
      },
    },
  });

  const state = await getState();
  const projection = state.projectionsByWorkspaceId["workspace-1"];
  const diagnostics = state.diagnostics.map((entry) => entry.message);
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 1);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=7")).length, 1);
  assert.equal(projection.chromeIdByBackendId["folder-deleted"], undefined);
  assert.equal(bookmarkNodes.get("workspace-node")?.children?.length ?? 0, 0);
  assert.ok(diagnostics.some((entry) => entry.includes("action=recover-subtree") && entry.includes("reason=expected parent chrome node missing")));
});

test("connectWorkspace prunes descendant mappings and exclusions after stale folder delete recovery", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-node", title: "Debug Bookmark", url: "https://example.com/debug", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: {
          "folder-deleted": "folder-node",
          "bookmark-deleted": "bookmark-node",
        },
        backendIdByChromeId: {
          "folder-node": "folder-deleted",
          "bookmark-node": "bookmark-deleted",
        },
        entityTypeByBackendId: {
          "folder-deleted": "folder",
          "bookmark-deleted": "bookmark",
        },
        excludedBackendNodeIds: ["bookmark-deleted"],
        lastCursor: 7,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "viewer",
        },
        folders: [],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=7"),
      respond: () => jsonResponse({
        currentCursor: 8,
        events: [
          {
            cursor: 8,
            eventId: "evt-folder-delete-8",
            workspaceId: "workspace-1",
            originClientId: "client-2",
            kind: "folder.deleted",
            entityType: "folder",
            entityId: "folder-deleted",
            createdAt: "2026-07-02T00:00:04.000Z",
            payload: {
              id: "folder-deleted",
              workspaceId: "workspace-1",
            },
          },
        ],
      }),
    },
  ];

  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({
    type: "event",
    event: {
      cursor: 8,
      eventId: "evt-folder-delete-8",
      workspaceId: "workspace-1",
      originClientId: "client-2",
      kind: "folder.deleted",
      entityType: "folder",
      entityId: "folder-deleted",
      createdAt: "2026-07-02T00:00:04.000Z",
      payload: {
        id: "folder-deleted",
        workspaceId: "workspace-1",
      },
    },
  });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.chromeIdByBackendId["folder-deleted"], undefined);
  assert.equal(projection.chromeIdByBackendId["bookmark-deleted"], undefined);
  assert.deepEqual(projection.excludedBackendNodeIds, []);
  assert.equal(bookmarkNodes.get("workspace-node")?.children?.length ?? 0, 0);
});

test("replay catchup skips stale historical bookmark events after subtree recovery advances the cursor", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        workspaceChromeId: "workspace-node",
        chromeIdByBackendId: { "folder-parent": "missing-parent" },
        backendIdByChromeId: { "missing-parent": "folder-parent" },
        entityTypeByBackendId: { "folder-parent": "folder" },
        lastCursor: 7,
      }),
    },
  });

  fetchHandlers = [
    {
      match: (url) => url.endsWith("/workspaces/workspace-1/tree"),
      respond: () => jsonResponse({
        workspace: {
          workspaceId: "workspace-1",
          workspaceName: "Workspace",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        folders: [
          {
            id: "folder-parent",
            name: "Docs",
            position: 0,
            folders: [],
            bookmarks: [
              {
                id: "bookmark-remote",
                folderId: "folder-parent",
                title: "Remote Bookmark",
                url: "https://example.com/remote",
                position: 0,
              },
            ],
          },
        ],
      }),
    },
    {
      match: (url) => url.includes("/sync/events?workspaceId=workspace-1&afterCursor=7"),
      respond: () => jsonResponse({
        currentCursor: 9,
        events: [
          {
            cursor: 8,
            eventId: "evt-bookmark-8",
            workspaceId: "workspace-1",
            originClientId: "client-2",
            kind: "bookmark.created",
            entityType: "bookmark",
            entityId: "bookmark-remote",
            createdAt: "2026-07-02T00:00:03.000Z",
            payload: {
              id: "bookmark-remote",
              workspaceId: "workspace-1",
              folderId: "folder-parent",
              title: "Remote Bookmark",
              url: "https://example.com/remote",
              position: 0,
              createdAt: "2026-07-02T00:00:03.000Z",
              updatedAt: "2026-07-02T00:00:03.000Z",
            },
          },
          {
            cursor: 9,
            eventId: "evt-bookmark-9",
            workspaceId: "workspace-1",
            originClientId: "client-2",
            kind: "bookmark.updated",
            entityType: "bookmark",
            entityId: "bookmark-remote",
            createdAt: "2026-07-02T00:00:04.000Z",
            payload: {
              id: "bookmark-remote",
              workspaceId: "workspace-1",
              folderId: "folder-parent",
              title: "Remote Bookmark Updated",
              url: "https://example.com/remote-updated",
              position: 0,
              createdAt: "2026-07-02T00:00:03.000Z",
              updatedAt: "2026-07-02T00:00:04.000Z",
            },
          },
        ],
      }),
    },
  ];

  await projectionTestHooks.replayWorkspaceDelta("workspace-1", 7, "dirty workspace replay catchup");

  const state = await getState();
  const projection = state.projectionsByWorkspaceId["workspace-1"];
  const diagnostics = state.diagnostics.map((entry) => entry.message);
  const evt9ReplayLines = diagnostics.filter((entry) => entry.includes("eventId=evt-bookmark-9") && entry.includes("action=replay"));
  const workspaceChildren = bookmarkNodes.get("workspace-node")?.children ?? [];
  const docsFolder = workspaceChildren.find((node) => node.title === "Docs");

  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=7")).length, 2);
  assert.equal(evt9ReplayLines.length, 1);
  assert.equal(projection.lastCursor, 9);
  assert.equal(projection.chromeIdByBackendId["folder-parent"], docsFolder?.id);
  assert.equal(projection.health, "live");
  assert.equal(docsFolder?.children?.length ?? 0, 1);
  assert.equal(docsFolder?.children?.[0]?.title, "Remote Bookmark Updated");
  assert.equal(docsFolder?.children?.[0]?.url, "https://example.com/remote-updated");
});
