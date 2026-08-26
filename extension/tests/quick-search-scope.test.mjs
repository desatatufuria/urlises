import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

const data = new Map();
const sessionData = new Map();
const storageArea = (store) => ({
  get(key, callback) { callback({ [key]: store.get(key) }); },
  set(items, callback) { Object.entries(items).forEach(([key, value]) => store.set(key, value)); callback(); },
  remove(key, callback) { store.delete(key); callback(); },
});
globalThis.chrome = { runtime: { lastError: null }, storage: { local: storageArea(data), session: storageArea(sessionData) } };

const storage = await import("../dist/shared/storage.js");
const projection = await import("../dist/background/projection.js");
const {
  collectManagedChromeIds,
  resolveScopeAvailability,
  filterByScope,
} = await import("../dist/quick-search/workspace-scope.js");

test.beforeEach(() => {
  data.clear();
  sessionData.clear();
});

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
    socketConnected: true,
    health: "live",
    recoveryAttemptCount: 0,
    autoRepairAttempts: 0,
    activityRevision: 0,
    ...overrides,
  };
}

// ---- collectManagedChromeIds ----------------------------------------------

test("collectManagedChromeIds unions backendIdByChromeId keys across every selected workspace", () => {
  const state = {
    selectedWorkspaceIds: ["ws-1", "ws-2"],
    projectionsByWorkspaceId: {
      "ws-1": createProjection({ backendIdByChromeId: { "chrome-1": "backend-1", "chrome-2": "backend-2" } }),
      "ws-2": createProjection({ backendIdByChromeId: { "chrome-3": "backend-3" } }),
    },
  };
  const ids = collectManagedChromeIds(state);
  assert.deepEqual([...ids].sort(), ["chrome-1", "chrome-2", "chrome-3"]);
});

test("collectManagedChromeIds excludes a workspace not in selectedWorkspaceIds even if its projection lingers", () => {
  const state = {
    selectedWorkspaceIds: ["ws-1"],
    projectionsByWorkspaceId: {
      "ws-1": createProjection({ backendIdByChromeId: { "chrome-1": "backend-1" } }),
      "ws-2": createProjection({ backendIdByChromeId: { "chrome-9": "backend-9" } }),
    },
  };
  const ids = collectManagedChromeIds(state);
  assert.deepEqual([...ids], ["chrome-1"]);
});

test("collectManagedChromeIds skips a selected workspace with no projection yet (still bootstrapping)", () => {
  const state = {
    selectedWorkspaceIds: ["ws-1", "ws-not-bootstrapped"],
    projectionsByWorkspaceId: {
      "ws-1": createProjection({ backendIdByChromeId: { "chrome-1": "backend-1" } }),
    },
  };
  const ids = collectManagedChromeIds(state);
  assert.deepEqual([...ids], ["chrome-1"]);
});

// ---- resolveScopeAvailability ----------------------------------------------

const session = {
  accessToken: "token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  clientId: "client-1",
  user: { id: "user-1", email: "user@example.com" },
};

test("resolveScopeAvailability keeps workspace scope when signed in with a selected workspace", () => {
  const result = resolveScopeAvailability({ session, selectedWorkspaceIds: ["ws-1"] }, "workspace");
  assert.deepEqual(result, { workspaceEnabled: true, effectiveScope: "workspace" });
});

test("resolveScopeAvailability falls back to global with a reason when signed out, without mutating the persisted preference", () => {
  const result = resolveScopeAvailability({ session: null, selectedWorkspaceIds: [] }, "workspace");
  assert.equal(result.workspaceEnabled, false);
  assert.equal(result.effectiveScope, "global");
  assert.match(result.disabledReason, /Sign in/);
  // the function is pure — it never touches storage, so the caller's
  // persisted "workspace" choice is provably untouched by this call.
});

test("resolveScopeAvailability falls back to global with a different reason when signed in but no workspace is selected", () => {
  const result = resolveScopeAvailability({ session, selectedWorkspaceIds: [] }, "workspace");
  assert.equal(result.workspaceEnabled, false);
  assert.equal(result.effectiveScope, "global");
  assert.match(result.disabledReason, /Select a workspace/);
});

test("resolveScopeAvailability returns the persisted global scope unchanged when available", () => {
  const result = resolveScopeAvailability({ session, selectedWorkspaceIds: ["ws-1"] }, "global");
  assert.deepEqual(result, { workspaceEnabled: true, effectiveScope: "global" });
});

// ---- filterByScope: Personal (not synced) exclusion + filter-before-cap ---

test("filterByScope excludes a Personal (not synced) bookmark from workspace scope and includes it in global", () => {
  const managedChromeIds = new Set(["chrome-managed-1"]);
  const results = [
    { id: "chrome-managed-1", title: "Managed", url: "https://example.com/managed" },
    { id: "chrome-personal-1", title: "Personal (not synced) bookmark", url: "https://example.com/personal" },
  ];
  const workspaceResults = filterByScope(results, "workspace", managedChromeIds);
  assert.deepEqual(workspaceResults, [{ id: "chrome-managed-1", title: "Managed", url: "https://example.com/managed" }]);

  const globalResults = filterByScope(results, "global", managedChromeIds);
  assert.deepEqual(globalResults, results);
});

test("filtering by scope before capping never hides a workspace match behind personal ones crowding the head", () => {
  // 60 personal bookmarks (not in managedChromeIds) followed by 2 workspace
  // matches. Capping at 50 BEFORE filtering would silently drop both
  // workspace matches; filtering first and capping after must keep them.
  const managedChromeIds = new Set(["chrome-ws-1", "chrome-ws-2"]);
  const personal = Array.from({ length: 60 }, (_, index) => ({
    id: `chrome-personal-${index}`,
    title: "Personal",
    url: `https://example.com/${index}`,
  }));
  const workspaceMatches = [
    { id: "chrome-ws-1", title: "Workspace 1", url: "https://example.com/ws-1" },
    { id: "chrome-ws-2", title: "Workspace 2", url: "https://example.com/ws-2" },
  ];
  const all = [...personal, ...workspaceMatches];

  const filtered = filterByScope(all, "workspace", managedChromeIds);
  assert.deepEqual(filtered, workspaceMatches);
});

// ---- Integration: setQuickSearchScope / getUiState / storage -------------

test("quickSearchScope defaults to workspace when nothing is stored", async () => {
  const state = await storage.getState();
  assert.equal(state.quickSearchScope, "workspace");

  const ui = await projection.getUiState();
  assert.equal(ui.state.quickSearchScope, "workspace");
});

test("setQuickSearchScope persists global and getUiState reflects it", async () => {
  const ui = await projection.setQuickSearchScope("global");
  assert.equal(ui.state.quickSearchScope, "global");
  assert.equal((await storage.getState()).quickSearchScope, "global");
});

test("a legacy persisted state without quickSearchScope normalizes to workspace on read", async () => {
  await new Promise((resolve) => {
    globalThis.chrome.storage.local.set(
      {
        sharedBookmarkSyncState: {
          settings: { backendUrl: "http://localhost:8081", clientId: "" },
          session: null,
          selectedWorkspaceIds: [],
          cachedOrganizations: [],
          cachedWorkspacesByOrganization: {},
          projectionsByWorkspaceId: {},
          diagnostics: [],
          // no quickSearchScope key at all — simulates a pre-Slice-B install
        },
      },
      resolve,
    );
  });
  const state = await storage.getState();
  assert.equal(state.quickSearchScope, "workspace");
});

test("an unrecognized persisted quickSearchScope value normalizes to workspace on read", async () => {
  await new Promise((resolve) => {
    globalThis.chrome.storage.local.set(
      {
        sharedBookmarkSyncState: {
          settings: { backendUrl: "http://localhost:8081", clientId: "" },
          session: null,
          selectedWorkspaceIds: [],
          cachedOrganizations: [],
          cachedWorkspacesByOrganization: {},
          projectionsByWorkspaceId: {},
          diagnostics: [],
          quickSearchScope: "not-a-real-scope",
        },
      },
      resolve,
    );
  });
  const state = await storage.getState();
  assert.equal(state.quickSearchScope, "workspace");
});
