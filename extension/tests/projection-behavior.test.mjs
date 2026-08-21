import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

const storageData = new Map();
const bookmarkNodes = new Map();
let nextBookmarkId = 100;
let enforceStrictIndices = false;
let storageSetFailure;

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
          const failure = storageSetFailure?.(items);
          if (failure) {
            globalThis.chrome.runtime.lastError = { message: failure };
            callback();
            globalThis.chrome.runtime.lastError = null;
            return;
          }
          for (const [key, value] of Object.entries(items)) {
            storageData.set(key, value);
          }
          callback();
        }, 0);
      },
      remove(key, callback) {
        setTimeout(() => {
          storageData.delete(key);
          callback();
        }, 0);
      },
    },
    session: { remove(_key, callback) { callback(); } },
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

  constructor(url, protocols = []) {
    this.url = url;
    this.protocol = protocols[0] ?? "";
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
  handleBookmarkCreated,
  handleBookmarkMoved,
  handleBookmarkRemoved,
  logout,
  markActivitySeen,
  projectionTestHooks,
  rebuildWorkspace,
  retryWorkspace,
  runCoalescedWorkspaceTask,
  setSelectedWorkspaces,
} from "../dist/background/projection.js";
import { createRemoteReceipt } from "../dist/background/convergence.js";
import { getState, setState } from "../dist/shared/storage.js";
import { connectWorkspaceSocket } from "../dist/shared/websocket.js";
import { LOCAL_ONLY_FOLDER_TITLE } from "../dist/shared/runtime.js";

const fetchLog = [];
let fetchHandlers = [];
let pendingTicketResponse;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  fetchLog.push(url);
  if (url.endsWith("/auth/ws-ticket")) {
    if (pendingTicketResponse) {
      return pendingTicketResponse.promise;
    }
    return jsonResponse({ ticket: `ticket-${fetchLog.length}`, expiresAt: "2099-01-01T00:00:30.000Z" });
  }
  const handler = fetchHandlers.find((candidate) => candidate.match(url));
  if (!handler) {
    throw new Error(`Unhandled fetch: ${url}`);
  }
  return handler.respond(url, init);
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

function ackResponse(cursor = 6) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Sync-Event-Id": "evt-ack",
      "X-Sync-Cursor": String(cursor),
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
  pendingTicketResponse = undefined;
  enforceStrictIndices = false;
  storageSetFailure = undefined;
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

    const close = connectWorkspaceSocket("http://localhost:8081", "workspace-1", "ticket-1", callbacks);
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

test("connectWorkspaceSocket fails closed when the negotiated ticket protocol differs", async () => {
  const errors = [];
  connectWorkspaceSocket("http://localhost:8081", "workspace-1", "ticket-1", {
    onAck: async () => {}, onEvent: async () => {}, onResyncRequired: async () => {}, onClose: async () => {},
    onError: async (message) => { errors.push(message); },
  });
  const socket = MockWebSocket.instances[0];
  socket.protocol = "sbs-ticket.other";
  await socket.emitOpen();
  assert.equal(socket.closed, true);
  assert.deepEqual(errors, ["websocket protocol rejected for workspace workspace-1"]);
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
  assert.equal(fetchLog.length, 2);
  assert.match(fetchLog[1], /afterCursor=5$/);
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

test("concurrent connection triggers share one ticket and one active socket", async () => {
  await setState(createRuntimeState());
  await Promise.all([
    projectionTestHooks.connectWorkspace("workspace-1"),
    projectionTestHooks.connectWorkspace("workspace-1"),
    projectionTestHooks.connectWorkspace("workspace-1"),
  ]);
  assert.equal(MockWebSocket.instances.length, 1);
  assert.equal(fetchLog.filter((url) => url.endsWith("/auth/ws-ticket")).length, 1);
});

for (const [action, invalidate] of [
  ["logout", () => logout()],
  ["workspace deselection", () => setSelectedWorkspaces([])],
]) {
  test(`ticket completion after ${action} does not open or reconnect a socket`, async () => {
    const ticketResponse = deferred();
    pendingTicketResponse = ticketResponse;
    fetchHandlers = [{ match: (url) => url.endsWith("/organizations"), respond: () => jsonResponse({ organizations: [] }) }];
    const connection = projectionTestHooks.connectWorkspace("workspace-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetchLog.filter((url) => url.endsWith("/auth/ws-ticket")).length, 1);

    await invalidate();
    ticketResponse.resolve(jsonResponse({ ticket: "stale-ticket", expiresAt: "2099-01-01T00:00:30.000Z" }));
    await connection;
    await flushMicrotasks();

    assert.equal(MockWebSocket.instances.length, 0);
    assert.deepEqual(projectionTestHooks.socketRuntimeCounts(), { tokens: 0, closers: 0, flights: 0 });
    assert.equal(fetchLog.filter((url) => url.endsWith("/auth/ws-ticket")).length, 1);
  });
}

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

test("replay gap pauses the workspace without destructive resync", async () => {
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

  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=5")).length, 1);
  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 0);
  assert.equal(projection.lastCursor, 5);
  assert.equal(projection.convergenceJournal?.pauseReason, "ambiguous-predecessor");
});

test("Retry keeps an unproven receipt paused and Rebuild is the only destructive workspace action", async () => {
  const journal = { version: 1, phase: "paused", pauseReason: "final-verification-failed", failedCursor: 6, repairDisposition: "retry", operations: [], attempts: 0, receipts: [{ version: 1, workspaceId: "workspace-1", backendId: "bookmark-1", chromeId: "bookmark-node", type: "bookmark", before: { title: "Before" }, expectedAfter: { title: "After" }, expectedSignatures: ["bad"], eventId: "evt-6", cursor: 6, status: "pending" }], localIntents: [{ eventId: "local-1", kind: "changed", status: "queued", payload: { workspaceId: "workspace-1", backendId: "bookmark-1", chromeId: "bookmark-node", type: "bookmark", kind: "changed", node: { id: "bookmark-node", title: "Local" } } }] };
  await setState({ ...createRuntimeState({ lastCursor: 5 }), projectionsByWorkspaceId: { "workspace-1": createProjection({ lastCursor: 5, convergenceJournal: journal }) } });
  await retryWorkspace("workspace-1");
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(fetchLog.filter((url) => url.endsWith("/tree")).length, 0);
  assert.equal(projection.convergenceJournal?.phase, "paused");
  assert.equal(projection.convergenceJournal?.repairDisposition, "rebuild");
  assert.equal(projection.convergenceJournal?.localIntents.length, 1);
  fetchHandlers = [{ match: (url) => url.endsWith("/workspaces/workspace-1/tree"), respond: () => jsonResponse({ workspace: projection.workspace, folders: [] }) }, { match: (url) => url.includes("afterCursor=0"), respond: () => jsonResponse({ currentCursor: 5, events: [] }) }];
  await rebuildWorkspace("workspace-1");
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(fetchLog.filter((url) => url.endsWith("/tree")).length, 1);
  assert.equal(projection.convergenceJournal?.localIntents.length, 1);
  assert.equal(projection.convergenceJournal?.phase, "live");
});

test("rebuildWorkspace creates the local-only folder and does not duplicate it on repeated rebuilds", async () => {
  const workspace = { workspaceId: "workspace-1", workspaceName: "Workspace", workspaceType: "shared", organizationId: "org-1", organizationName: "Org", role: "editor" };
  fetchHandlers = [
    { match: (url) => url.endsWith("/workspaces/workspace-1/tree"), respond: () => jsonResponse({ workspace, folders: [] }) },
    { match: (url) => url.includes("afterCursor=0"), respond: () => jsonResponse({ currentCursor: 0, events: [] }) },
  ];
  await setState({ ...createRuntimeState(), projectionsByWorkspaceId: { "workspace-1": createEditorProjection() } });

  await rebuildWorkspace("workspace-1");
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  const workspaceChromeId = projection.workspaceChromeId;
  let localOnlyChildren = (bookmarkNodes.get(workspaceChromeId)?.children ?? []).filter((node) => node.title === LOCAL_ONLY_FOLDER_TITLE);
  assert.equal(localOnlyChildren.length, 1, "RED: workspace bootstrap must create exactly one local-only folder");
  assert.equal(projection.localOnlyChromeId, localOnlyChildren[0].id);

  fetchHandlers = [
    { match: (url) => url.endsWith("/workspaces/workspace-1/tree"), respond: () => jsonResponse({ workspace, folders: [] }) },
    { match: (url) => url.includes("afterCursor=0"), respond: () => jsonResponse({ currentCursor: 0, events: [] }) },
  ];
  await rebuildWorkspace("workspace-1");
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  localOnlyChildren = (bookmarkNodes.get(workspaceChromeId)?.children ?? []).filter((node) => node.title === LOCAL_ONLY_FOLDER_TITLE);
  assert.equal(localOnlyChildren.length, 1, "a repeated rebuild must not duplicate the local-only folder");
  assert.equal(projection.localOnlyChromeId, localOnlyChildren[0].id);
});

test("creating a bookmark directly at the workspace root relocates it into the local-only folder instead of syncing or resyncing", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("local-only-node", createBookmarkNode({ id: "local-only-node", parentId: "workspace-node", title: LOCAL_ONLY_FOLDER_TITLE, index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState(),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", localOnlyChromeId: "local-only-node" }),
    },
  });

  const created = await new Promise((resolve) => chrome.bookmarks.create({ parentId: "workspace-node", title: "Root Bookmark", url: "https://example.com/root", index: 0 }, resolve));
  await handleBookmarkCreated(created.id, created);

  const state = await getState();
  const projection = state.projectionsByWorkspaceId["workspace-1"];
  const localOnlyChildren = bookmarkNodes.get("local-only-node")?.children ?? [];
  const workspaceRootChildren = bookmarkNodes.get("workspace-node")?.children ?? [];

  assert.equal(localOnlyChildren.some((node) => node.id === created.id), true, "RED: the orphaned bookmark must land inside the local-only folder");
  assert.equal(workspaceRootChildren.some((node) => node.id === created.id), false, "the bookmark must no longer sit directly at the workspace root");
  assert.equal(fetchLog.some((url) => url.includes("/bookmarks")), false, "must never send a backend mutation for root-level content");
  assert.equal(projection.convergenceJournal?.pauseReason, undefined, "must not pause the workspace as a boundary violation");
  assert.equal(state.diagnostics.some((entry) => entry.level === "warn"), false, "must not log a boundary-violation warning");
  assert.equal(state.diagnostics.some((entry) => entry.message.includes("local_only_relocated")), true, "must log an informational relocation event");
});

test("creating a bookmark or folder inside the local-only folder is a pure no-op for the sync engine", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("local-only-node", createBookmarkNode({ id: "local-only-node", parentId: "workspace-node", title: LOCAL_ONLY_FOLDER_TITLE, index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState(),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", localOnlyChromeId: "local-only-node" }),
    },
  });

  const beforeProjection = (await getState()).projectionsByWorkspaceId["workspace-1"];

  const bookmarkNode = await new Promise((resolve) => chrome.bookmarks.create({ parentId: "local-only-node", title: "Note", url: "https://example.com/note", index: 0 }, resolve));
  await handleBookmarkCreated(bookmarkNode.id, bookmarkNode);
  const folderNode = await new Promise((resolve) => chrome.bookmarks.create({ parentId: "local-only-node", title: "Subfolder", index: 1 }, resolve));
  await handleBookmarkCreated(folderNode.id, folderNode);

  const afterProjection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.deepEqual(afterProjection, beforeProjection, "RED: content created inside the local-only folder must never mutate projection state");
  assert.equal(fetchLog.length, 0, "RED: content created inside the local-only folder must never call the backend");
});

test("rebuilding a workspace preserves existing content inside the local-only folder and keeps the folder itself", async () => {
  bookmarkNodes.set("root-node", createBookmarkNode({ id: "root-node", parentId: "1", title: "URLises", index: 0 }));
  bookmarkNodes.set("org-node", createBookmarkNode({ id: "org-node", parentId: "root-node", title: "Org", index: 0 }));
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "org-node", title: "Workspace", index: 0 }));
  bookmarkNodes.set("local-only-node", createBookmarkNode({ id: "local-only-node", parentId: "workspace-node", title: LOCAL_ONLY_FOLDER_TITLE, index: 0 }));
  bookmarkNodes.set("local-only-bookmark", createBookmarkNode({ id: "local-only-bookmark", parentId: "local-only-node", title: "My note", url: "https://example.com/note", index: 0 }));
  bookmarkNodes.set("stale-folder", createBookmarkNode({ id: "stale-folder", parentId: "workspace-node", title: "Stale", index: 1 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState({ lastCursor: 7 }),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({
        workspaceChromeId: "workspace-node",
        localOnlyChromeId: "local-only-node",
        chromeIdByBackendId: { "folder-stale": "stale-folder" },
        backendIdByChromeId: { "stale-folder": "folder-stale" },
        entityTypeByBackendId: { "folder-stale": "folder" },
        lastCursor: 7,
      }),
    },
  });

  const workspace = { workspaceId: "workspace-1", workspaceName: "Workspace", workspaceType: "shared", organizationId: "org-1", organizationName: "Org", role: "editor" };
  fetchHandlers = [
    { match: (url) => url.endsWith("/workspaces/workspace-1/tree"), respond: () => jsonResponse({ workspace, folders: [] }) },
    { match: (url) => url.includes("afterCursor=0"), respond: () => jsonResponse({ currentCursor: 0, events: [] }) },
  ];

  await rebuildWorkspace("workspace-1");

  assert.equal(bookmarkNodes.has("local-only-node"), true, "RED: rebuild must never delete the local-only folder");
  assert.equal(bookmarkNodes.has("local-only-bookmark"), true, "RED: rebuild must never delete content inside the local-only folder");
  assert.equal(bookmarkNodes.has("stale-folder"), false, "rebuild must still clear unmanaged synced content outside the local-only folder");
  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.localOnlyChromeId, "local-only-node");
});

test("editing, moving within, or removing a bookmark inside the local-only folder never calls the backend", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("local-only-node", createBookmarkNode({ id: "local-only-node", parentId: "workspace-node", title: LOCAL_ONLY_FOLDER_TITLE, index: 0 }));
  bookmarkNodes.set("local-only-bookmark", createBookmarkNode({ id: "local-only-bookmark", parentId: "local-only-node", title: "My note", url: "https://example.com/note", index: 0 }));
  rebuildBookmarkChildren();

  await setState({
    ...createRuntimeState(),
    projectionsByWorkspaceId: {
      "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", localOnlyChromeId: "local-only-node" }),
    },
  });

  await handleBookmarkChanged("local-only-bookmark", { title: "Renamed note" });
  await handleBookmarkMoved("local-only-bookmark", { parentId: "local-only-node", oldParentId: "local-only-node", index: 0, oldIndex: 0 });
  await handleBookmarkRemoved("local-only-bookmark", { parentId: "local-only-node", index: 0 });

  assert.equal(fetchLog.length, 0, "RED: no backend call must ever happen for content inside the local-only folder");
});

test("remote receipt capacity prunes consumed receipts or pauses before the Chrome effect", async () => {
  for (const status of ["consumed", "pending"]) {
    await resetRuntime();
    bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
    bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
    bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Before", url: "https://example.com/before", index: 0 }));
    rebuildBookmarkChildren();
    const receipts = Array.from({ length: 100 }, (_, cursor) => ({ ...createRemoteReceipt({ workspaceId: "workspace-1", backendId: `old-${cursor}`, chromeId: `old-${cursor}`, type: "bookmark", before: { parentId: "folder-a", index: cursor, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-a", index: cursor, title: "After", url: "https://example.com/after" }, eventId: `old-${cursor}`, cursor }), status }));
    await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" }, backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" }, entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" }, lastCursor: 7, convergenceJournal: { version: 1, phase: "live", operations: [], localIntents: [], attempts: 0, receipts } }) } });

    await projectionTestHooks.applyRemoteEnvelope("workspace-1", createSyncEvent({ cursor: 8, eventId: `capacity-${status}`, payload: { id: "bookmark-1", workspaceId: "workspace-1", folderId: "folder-a", title: "After", url: "https://example.com/after", position: 0 } }));

    const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
    if (status === "consumed") {
      assert.equal(projection.convergenceJournal.receipts.length, 21);
      assert.equal(projection.convergenceJournal.receipts.at(-1).status, "pending");
      assert.equal(bookmarkNodes.get("bookmark-node").title, "After");
    } else {
      assert.equal(projection.convergenceJournal.pauseReason, "receipt-capacity");
      assert.equal(projection.convergenceJournal.failedCursor, 8);
      assert.equal(bookmarkNodes.get("bookmark-node").title, "Before");
    }
    assert.equal(projection.lastCursor, 7);
  }
});

test("durable receipt write failure blocks the process without claiming a persisted pause", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Before", url: "https://example.com/before", index: 0 }));
  rebuildBookmarkChildren();
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" }, backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" }, entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" }, lastCursor: 7 }) } });
  let failAllWrites = false;
  storageSetFailure = (items) => {
    const projection = Object.values(items)[0]?.projectionsByWorkspaceId?.["workspace-1"];
    if (failAllWrites || projection?.convergenceJournal?.receipts?.some((receipt) => receipt.cursor === 8 && receipt.status === "pending")) {
      failAllWrites = true;
      return "durable storage unavailable";
    }
  };

  await projectionTestHooks.applyRemoteEnvelope("workspace-1", createSyncEvent({ cursor: 8, eventId: "durable-8", payload: { id: "bookmark-1", workspaceId: "workspace-1", folderId: "folder-a", title: "After", url: "https://example.com/after", position: 0 } }));
  storageSetFailure = undefined;
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projectionTestHooks.volatileRepairGate("workspace-1"), "durable-write-failed");
  assert.equal(projection.convergenceJournal?.phase, "plan");
  assert.equal(projection.convergenceJournal?.pauseReason, undefined);
  assert.equal(projection.lastCursor, 7);
  assert.equal(bookmarkNodes.get("bookmark-node").title, "Before");

  await projectionTestHooks.applyRemoteEnvelope("workspace-1", createSyncEvent({ cursor: 9, eventId: "durable-9", payload: { id: "bookmark-1", workspaceId: "workspace-1", folderId: "folder-a", title: "Later", url: "https://example.com/later", position: 0 } }));
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 7);
  assert.equal(bookmarkNodes.get("bookmark-node").title, "Before");
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

test("connectWorkspace logs secret-free pause context on rejected Chrome effects", async () => {
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
  await flushMicrotasks(8);

  const diagnostics = (await getState()).diagnostics.map((entry) => entry.message);
  const applyLine = diagnostics.find((entry) => entry.includes("eventId=evt-bookmark-8") && entry.includes("action=live-apply"));
  const pauseLine = diagnostics.find((entry) => entry.includes("eventId=evt-bookmark-8") && entry.includes("action=paused") && entry.includes("failure=remote effect gate failed"));

  assert.ok(applyLine);
  assert.match(applyLine, /operation=bookmark-upsert/);
  assert.match(applyLine, /expectedParentChromeId=parent-folder/);
  assert.match(applyLine, /currentChildCount=0/);
  assert.match(applyLine, /requestedIndex=5/);
  assert.match(applyLine, /branch=create/);

  assert.ok(pauseLine);
  assert.match(pauseLine, /action=paused/);
  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.convergenceJournal?.pauseReason, "chrome-effect-rejected");
  assert.equal(projection.convergenceJournal?.failedCursor, 8);
  assert.equal(projection.lastCursor, 7);
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

test("remote update pauses at a hidden-field verification failure", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Before", url: "https://example.com/before", index: 0 }));
  rebuildBookmarkChildren();
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" }, backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" }, entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" }, lastCursor: 7 }) } });
  await projectionTestHooks.connectWorkspace("workspace-1");
  await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({ type: "event", event: createSyncEvent({ cursor: 8, eventId: "evt-update-8", payload: { id: "bookmark-1", workspaceId: "workspace-1", folderId: "folder-a", title: "After", url: "https://example.com/after", position: 0 } }) });
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.deepEqual(projection.convergenceJournal?.receipts?.map((receipt) => [receipt.status, receipt.before.title, receipt.expectedAfter.title]), [["pending", "Before", "After"]]);
  assert.equal(projection.lastCursor, 7);
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "After", url: "https://example.com/hidden", index: 0 }));
  rebuildBookmarkChildren();
  await handleBookmarkChanged("bookmark-node", { title: "After" });
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.convergenceJournal?.receipts?.[0]?.status, "pending");
  assert.equal(projection.lastCursor, 7);
  await MockWebSocket.instances[0].emitMessage({ type: "event", event: createSyncEvent({ cursor: 9, eventId: "evt-update-9", payload: { id: "bookmark-1", workspaceId: "workspace-1", folderId: "folder-a", title: "Final", url: "https://example.com/final", position: 0 } }) });
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.convergenceJournal?.pauseReason, "final-verification-failed");
  assert.equal(projection.convergenceJournal?.failedCursor, 8);
  assert.equal(projection.lastCursor, 7);
  assert.equal(fetchLog.length, 1);
});

test("remote folder title update waits for its durable complete-node proof", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "workspace-node", title: "Before", index: 0 })); rebuildBookmarkChildren();
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", chromeIdByBackendId: { "folder-1": "folder-node" }, backendIdByChromeId: { "folder-node": "folder-1" }, entityTypeByBackendId: { "folder-1": "folder" }, lastCursor: 7 }) } });
  await projectionTestHooks.connectWorkspace("workspace-1"); await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({ type: "event", event: createSyncEvent({ cursor: 8, eventId: "evt-folder-update-8", kind: "folder.updated", entityType: "folder", entityId: "folder-1", payload: { id: "folder-1", workspaceId: "workspace-1", name: "After", position: 0 } }) });
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.deepEqual(projection.convergenceJournal?.receipts?.map((receipt) => [receipt.type, receipt.status, receipt.before.title, receipt.expectedAfter.title]), [["folder", "pending", "Before", "After"]]);
  assert.equal(projection.lastCursor, 7);
  await handleBookmarkChanged("folder-node", { title: "After" });
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.convergenceJournal?.receipts?.[0]?.status, "consumed");
  assert.equal(fetchLog.length, 1);
});

test("remote folder move persists and waits for its exact complete callback", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "A", index: 0 }));
  bookmarkNodes.set("folder-b", createBookmarkNode({ id: "folder-b", parentId: "workspace-node", title: "B", index: 1 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "folder-a", title: "Moved", index: 0 })); rebuildBookmarkChildren();
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", chromeIdByBackendId: { "folder-a": "folder-a", "folder-b": "folder-b", "folder-1": "folder-node" }, backendIdByChromeId: { "folder-a": "folder-a", "folder-b": "folder-b", "folder-node": "folder-1" }, entityTypeByBackendId: { "folder-a": "folder", "folder-b": "folder", "folder-1": "folder" }, lastCursor: 7 }) } });
  await projectionTestHooks.connectWorkspace("workspace-1"); await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  await MockWebSocket.instances[0].emitMessage({ type: "event", event: createSyncEvent({ cursor: 8, eventId: "evt-folder-move-8", kind: "folder.updated", entityType: "folder", entityId: "folder-1", payload: { id: "folder-1", workspaceId: "workspace-1", parentId: "folder-b", name: "Moved", position: 0 } }) });
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.deepEqual(projection.convergenceJournal?.receipts?.map((receipt) => [receipt.type, receipt.status, receipt.move]), [["folder", "pending", { oldParentId: "folder-a", oldIndex: 0, parentId: "folder-b", index: 0 }]]);
  assert.equal(projection.lastCursor, 7);
  await handleBookmarkMoved("folder-node", { parentId: "folder-b", oldParentId: "folder-a", index: 1, oldIndex: 0 });
  assert.equal((await getState()).projectionsByWorkspaceId["workspace-1"].lastCursor, 7);
  await handleBookmarkMoved("folder-node", { parentId: "folder-b", oldParentId: "folder-a", index: 0, oldIndex: 0 });
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.convergenceJournal?.receipts?.[0]?.status, "consumed");
});

test("replay stops at a pending update receipt before later effects or cursor promotion", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Before", url: "https://example.com/before", index: 0 }));
  rebuildBookmarkChildren();
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" }, backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" }, entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" }, lastCursor: 7 }) } });
  fetchHandlers = [{ match: (url) => url.includes("afterCursor=7"), respond: () => jsonResponse({ currentCursor: 9, events: [
    createSyncEvent({ cursor: 8, eventId: "evt-update-8", payload: { id: "bookmark-1", workspaceId: "workspace-1", folderId: "folder-a", title: "After", url: "https://example.com/after", position: 0 } }),
    createSyncEvent({ cursor: 9, eventId: "evt-create-9", kind: "bookmark.created", entityId: "bookmark-2", payload: { id: "bookmark-2", workspaceId: "workspace-1", folderId: "folder-a", title: "Later", url: "https://example.com/later", position: 1 } }),
  ] }) }];
  await projectionTestHooks.replayWorkspaceDelta("workspace-1", 7, "pending update proof");
  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 7);
  assert.equal(projection.convergenceJournal?.receipts?.[0]?.status, "pending");
  assert.equal(bookmarkNodes.get("bookmark-node")?.title, "After");
  assert.equal(bookmarkNodes.get("folder-a")?.children?.length, 1);
});

test("live socket FIFO stops a burst after the predecessor receipt persists", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Before", url: "https://example.com/before", index: 0 })); rebuildBookmarkChildren();
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({ workspaceChromeId: "workspace-node", chromeIdByBackendId: { "folder-a": "folder-a", "bookmark-1": "bookmark-node" }, backendIdByChromeId: { "folder-a": "folder-a", "bookmark-node": "bookmark-1" }, entityTypeByBackendId: { "folder-a": "folder", "bookmark-1": "bookmark" }, lastCursor: 7 }) } });
  await projectionTestHooks.connectWorkspace("workspace-1"); await MockWebSocket.instances[0].emitMessage({ type: "ack", currentCursor: 7 });
  const socket = MockWebSocket.instances[0];
  const first = socket.emitMessage({ type: "event", event: createSyncEvent({ cursor: 8, eventId: "evt-live-8", payload: { id: "bookmark-1", workspaceId: "workspace-1", folderId: "folder-a", title: "After", url: "https://example.com/after", position: 0 } }) });
  const second = socket.emitMessage({ type: "event", event: createSyncEvent({ cursor: 9, eventId: "evt-live-9", kind: "bookmark.created", entityId: "bookmark-2", payload: { id: "bookmark-2", workspaceId: "workspace-1", folderId: "folder-a", title: "Later", url: "https://example.com/later", position: 1 } }) });
  await Promise.all([first, second]);
  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(bookmarkNodes.get("bookmark-node")?.title, "After");
  assert.equal(bookmarkNodes.get("folder-a")?.children?.length, 1);
  assert.equal(projection.lastCursor, 7);
  assert.equal(projection.convergenceJournal?.receipts?.[0]?.status, "pending");
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

test("remote bookmark move persists before effect and checkpoints only its exact callback", async () => {
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

  const movedNode = bookmarkNodes.get("bookmark-node");
  let projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(bookmarkPatchCalls, 0);
  assert.equal(movedNode?.parentId, "folder-b");
  assert.equal(movedNode?.index, 0);
  assert.equal(projection.lastCursor, 7);
  assert.deepEqual(projection.convergenceJournal?.receipts?.map((receipt) => [receipt.status, receipt.move]), [["pending", { oldParentId: "folder-a", oldIndex: 0, parentId: "folder-b", index: 0 }]]);
  await handleBookmarkMoved("bookmark-node", { parentId: "folder-b", oldParentId: "folder-a", index: 1, oldIndex: 0 });
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 7);
  assert.equal(projection.convergenceJournal?.receipts?.[0]?.status, "pending");
  assert.equal(projection.convergenceJournal?.localIntents.length, 1);
  await handleBookmarkMoved("bookmark-node", { parentId: "folder-b", oldParentId: "folder-a", index: 0, oldIndex: 0 });
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.convergenceJournal?.receipts?.[0]?.status, "consumed");
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Bookmark", url: "https://example.com/bookmark", index: 0 }));
  rebuildBookmarkChildren();
  await handleBookmarkMoved("bookmark-node", { parentId: "folder-a", oldParentId: "folder-b", index: 0, oldIndex: 0 });
  await handleBookmarkMoved("bookmark-node", { parentId: "folder-a", oldParentId: "folder-b", index: 0, oldIndex: 0 });
  projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.convergenceJournal?.localIntents.filter((intent) => intent.kind === "moved").length, 2);
});

test("combined remote bookmark update and move waits for its complete moved callback", async () => {
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

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(bookmarkPatchCalls, 0);
  assert.deepEqual(bookmarkNodes.get("bookmark-node"), { id: "bookmark-node", parentId: "folder-b", title: "Remote Bookmark", url: "https://example.com/remote", index: 0 });
  assert.equal(projection.lastCursor, 7);
  assert.deepEqual(projection.convergenceJournal?.receipts?.map((receipt) => [receipt.status, receipt.expectedAfter]), [["pending", { parentId: "folder-b", index: 0, title: "Remote Bookmark", url: "https://example.com/remote" }]]);
  await handleBookmarkChanged("bookmark-node", { title: "Remote Bookmark", url: "https://example.com/remote" });
  assert.equal((await getState()).projectionsByWorkspaceId["workspace-1"].lastCursor, 7);
  await handleBookmarkMoved("bookmark-node", { parentId: "folder-b", oldParentId: "folder-a", index: 0, oldIndex: 0 });
  assert.equal((await getState()).projectionsByWorkspaceId["workspace-1"].lastCursor, 8);
});

test("local update and move dispatch durable complete-shape intents in order", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-a", createBookmarkNode({ id: "folder-a", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("folder-b", createBookmarkNode({ id: "folder-b", parentId: "workspace-node", title: "Links", index: 1 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-a", title: "Renamed", url: "https://example.com/renamed", index: 0 }));
  rebuildBookmarkChildren();
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({
    workspaceChromeId: "workspace-node",
    chromeIdByBackendId: { "folder-a": "folder-a", "folder-b": "folder-b", "bookmark-1": "bookmark-node" },
    backendIdByChromeId: { "folder-a": "folder-a", "folder-b": "folder-b", "bookmark-node": "bookmark-1" },
    entityTypeByBackendId: { "folder-a": "folder", "folder-b": "folder", "bookmark-1": "bookmark" },
  }) } });

  const requests = [];
  fetchHandlers = [{
    match: (url) => url.endsWith("/bookmarks/bookmark-1"),
    respond: (_url, init) => {
      requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return ackResponse(8 + requests.length - 1);
    },
  }];

  await handleBookmarkChanged("bookmark-node", { title: "Renamed" });
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-b", title: "Renamed", url: "https://example.com/renamed", index: 0 }));
  rebuildBookmarkChildren();
  await handleBookmarkMoved("bookmark-node", { parentId: "folder-b", oldParentId: "folder-a", index: 0, oldIndex: 0 });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  const journal = projection.convergenceJournal;
  assert.equal(requests.length, 2, JSON.stringify((await getState()).diagnostics));
  assert.deepEqual(journal.localIntents.map((intent) => [intent.kind, intent.payload.workspaceId, intent.payload.backendId, intent.payload.chromeId, intent.payload.type, intent.payload.node]), [
    ["changed", "workspace-1", "bookmark-1", "bookmark-node", "bookmark", { id: "bookmark-node", parentId: "folder-a", index: 0, title: "Renamed", url: "https://example.com/renamed" }],
    ["moved", "workspace-1", "bookmark-1", "bookmark-node", "bookmark", { id: "bookmark-node", parentId: "folder-b", index: 0, title: "Renamed", url: "https://example.com/renamed" }],
  ]);
  assert.deepEqual(journal.localIntents.map((intent) => intent.status), ["acked", "acked"]);
  assert.equal(projection.lastCursor, 9);
  assert.deepEqual(requests.map((request) => request.body), [
    { folderId: "folder-a", title: "Renamed", url: "https://example.com/renamed", position: 0 },
    { folderId: "folder-b", title: "Renamed", url: "https://example.com/renamed", position: 0 },
  ]);
  for (const request of requests) {
    assert.match(request.headers.get("X-Sync-Event-Id"), /^local-intent-sha256-[a-f0-9]{64}$/);
    assert.equal(request.headers.get("X-Sync-Event-Id").includes("renamed"), false);
  }
});

test("sent local intent resumes with the same opaque event ID after recovery", async () => {
  bookmarkNodes.set("workspace-node", createBookmarkNode({ id: "workspace-node", parentId: "1", title: "Workspace", index: 0 }));
  bookmarkNodes.set("folder-node", createBookmarkNode({ id: "folder-node", parentId: "workspace-node", title: "Docs", index: 0 }));
  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-node", title: "Retry", url: "https://example.com/retry", index: 0 }));
  rebuildBookmarkChildren();
  const intent = {
    eventId: "local-intent-v1:durable-retry",
    kind: "changed",
    status: "sent",
    payload: { workspaceId: "workspace-1", backendId: "bookmark-1", chromeId: "bookmark-node", type: "bookmark", kind: "changed", node: { id: "bookmark-node", parentId: "folder-node", index: 0, title: "Retry", url: "https://example.com/retry" } },
  };
  await setState({ ...createRuntimeState({ lastCursor: 7 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({
    workspaceChromeId: "workspace-node",
    chromeIdByBackendId: { "folder-1": "folder-node", "bookmark-1": "bookmark-node" },
    backendIdByChromeId: { "folder-node": "folder-1", "bookmark-node": "bookmark-1" },
    entityTypeByBackendId: { "folder-1": "folder", "bookmark-1": "bookmark" },
    lastCursor: 7,
    convergenceJournal: { version: 1, phase: "live", operations: [], localIntents: [intent], attempts: 0 },
  }) } });

  const eventIds = [];
  fetchHandlers = [{ match: (url) => url.endsWith("/bookmarks/bookmark-1"), respond: (_url, init) => {
    eventIds.push(new Headers(init.headers).get("X-Sync-Event-Id"));
    throw new Error("lost response");
  } }];
  await projectionTestHooks.drainLocalIntents("workspace-1", "restart");
  const firstEventId = eventIds[0];
  assert.equal((await getState()).projectionsByWorkspaceId["workspace-1"].convergenceJournal.localIntents[0].status, "sent");

  await setState({ ...(await getState()), projectionsByWorkspaceId: { "workspace-1": {
    ...(await getState()).projectionsByWorkspaceId["workspace-1"],
    convergenceJournal: { ...(await getState()).projectionsByWorkspaceId["workspace-1"].convergenceJournal, phase: "live", pauseReason: undefined, failedCursor: undefined },
  } } });
  fetchHandlers = [{ match: (url) => url.endsWith("/bookmarks/bookmark-1"), respond: (_url, init) => {
    eventIds.push(new Headers(init.headers).get("X-Sync-Event-Id"));
    return ackResponse(8);
  } }];
  await projectionTestHooks.drainLocalIntents("workspace-1", "retry");
  assert.equal(eventIds.length, 2);
  assert.equal(eventIds[1], firstEventId);
  assert.equal((await getState()).projectionsByWorkspaceId["workspace-1"].convergenceJournal.localIntents[0].status, "acked");
});

test("missing cursor-zero node pauses intent capture without advancing or mutating remotely", async () => {
  await setState({ ...createRuntimeState({ lastCursor: 0 }), projectionsByWorkspaceId: { "workspace-1": createEditorProjection({
    workspaceChromeId: "workspace-node", chromeIdByBackendId: { "bookmark-1": "missing-node" },
    backendIdByChromeId: { "missing-node": "bookmark-1" }, entityTypeByBackendId: { "bookmark-1": "bookmark" },
  }) } });

  await handleBookmarkChanged("missing-node", { title: "Lost" });

  const projection = (await getState()).projectionsByWorkspaceId["workspace-1"];
  assert.equal(fetchLog.length, 0);
  assert.equal(projection.lastCursor, 0);
  assert.equal(projection.convergenceJournal.phase, "paused");
  assert.equal(projection.convergenceJournal.pauseReason, "cursor-zero-read-failed");
  assert.deepEqual(projection.convergenceJournal.localIntents, []);
});

test("handleBookmarkChanged retains one failed stable intent without destructive recovery", async () => {
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

  bookmarkNodes.set("bookmark-node", createBookmarkNode({ id: "bookmark-node", parentId: "folder-node", title: "Renamed Bookmark", url: "https://example.com/bookmark", index: 0 }));
  rebuildBookmarkChildren();
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
  assert.equal(fetchLog.filter((url) => url.endsWith("/bookmarks/bookmark-1")).length, 1);
  assert.equal(projection.convergenceJournal.localIntents.length, 1);
  assert.equal(projection.convergenceJournal.localIntents[0].status, "sent");
  assert.equal(projection.convergenceJournal.localIntents[0].payload.node.title, "Renamed Bookmark");
  assert.equal(projection.convergenceJournal.pauseReason, "ambiguous-predecessor");
});

test("handleBookmarkRemoved pauses a rejected local delete without destructive recovery", async () => {
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
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 0);
  assert.equal(projection.chromeIdByBackendId["folder-1"], "folder-node");
  assert.equal(projection.convergenceJournal?.pauseReason, "ambiguous-predecessor");
});

test("handleBookmarkMoved retains one failed stable intent without destructive recovery", async () => {
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
  assert.equal(fetchLog.filter((url) => url.endsWith("/folders/folder-1")).length, 1);
  assert.equal(projection.convergenceJournal.localIntents.length, 1);
  assert.equal(projection.convergenceJournal.localIntents[0].status, "sent");
  assert.equal(projection.convergenceJournal.localIntents[0].payload.node.parentId, "workspace-node");
  assert.equal(projection.convergenceJournal.pauseReason, "ambiguous-predecessor");
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
  assert.equal(fetchLog.filter((url) => url.endsWith("/workspaces/workspace-1/tree")).length, 1);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=7")).length, 1);
  assert.equal(fetchLog.filter((url) => url.includes("afterCursor=0")).length, 0);
  assert.ok(diagnostics.some((entry) => entry.includes("action=recover-subtree") && entry.includes("entityId=bookmark-remote")));
  assert.equal(projection.health, "degraded");
  assert.equal(projection.convergenceJournal?.pauseReason, "ambiguous-predecessor");
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

test("replay catchup stops at an unverified subtree event without cursor promotion", async () => {
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
  assert.equal(projection.lastCursor, 8);
  assert.equal(projection.convergenceJournal?.receipts?.find((receipt) => receipt.cursor === 9)?.status, "pending");
  assert.equal(projection.convergenceJournal?.repairDisposition, "rebuild");
  assert.equal(projection.chromeIdByBackendId["folder-parent"], docsFolder?.id);
  assert.equal(projection.health, "degraded");
  assert.equal(docsFolder?.children?.length ?? 0, 1);
  assert.equal(docsFolder?.children?.[0]?.title, "Remote Bookmark Updated");
  assert.equal(docsFolder?.children?.[0]?.url, "https://example.com/remote-updated");
});
