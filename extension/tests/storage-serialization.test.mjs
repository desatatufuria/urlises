import test from "node:test";
import assert from "node:assert/strict";

const storageData = new Map();

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
};

const { getState, setState, updateState } = await import("../dist/shared/storage.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createState(overrides = {}) {
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
    selectedWorkspaceIds: [],
    cachedOrganizations: [],
    cachedWorkspacesByOrganization: {},
    projectionsByWorkspaceId: {},
    diagnostics: [],
    ...overrides,
  };
}

test("updateState serializes concurrent mutations so session and workspace selection are not lost", async () => {
  storageData.clear();
  await setState(createState());

  await Promise.all([
    updateState(async (state) => {
      await delay(20);
      return {
        ...state,
        selectedWorkspaceIds: [...state.selectedWorkspaceIds, "workspace-a"],
      };
    }),
    updateState(async (state) => {
      await delay(5);
      return {
        ...state,
        selectedWorkspaceIds: [...state.selectedWorkspaceIds, "workspace-b"],
      };
    }),
  ]);

  const finalState = await getState();
  assert.deepEqual(finalState.selectedWorkspaceIds, ["workspace-a", "workspace-b"]);
  assert.equal(finalState.session?.accessToken, "token-1");
});

test("getState hydrates new projection health defaults from legacy persisted projection state", async () => {
  storageData.clear();
  await setState(createState({
    projectionsByWorkspaceId: {
      "workspace-a": {
        workspace: {
          workspaceId: "workspace-a",
          workspaceName: "Workspace A",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "viewer",
        },
        chromeIdByBackendId: {},
        backendIdByChromeId: {},
        entityTypeByBackendId: {},
        excludedBackendNodeIds: [],
        lastCursor: 5,
        status: "ready",
        socketConnected: true,
      },
    },
  }));

  const finalState = await getState();
  assert.equal(finalState.projectionsByWorkspaceId["workspace-a"].health, "live");
  assert.equal(finalState.projectionsByWorkspaceId["workspace-a"].recoveryAttemptCount, 0);
});
