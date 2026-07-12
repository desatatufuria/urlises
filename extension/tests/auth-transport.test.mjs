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

const session = await import("../dist/shared/session.js");
const api = await import("../dist/shared/api.js");
const storage = await import("../dist/shared/storage.js");
const projection = await import("../dist/background/projection.js");

const user = { id: "user-1", email: "user@example.test" };
const renewable = (accessToken = "access-1", refreshToken = "refresh-1") => ({
  accessToken, expiresAt: "2099-01-01T00:00:00.000Z", clientId: "client-1", user, refreshToken,
});

function response(status, body = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test.beforeEach(async () => {
  data.clear();
  sessionData.clear();
  await session.sessionTestHooks.reset();
});

test("login capability stores refresh only in private state", async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init.headers).get("X-Session-Capability"), "renewable-v1");
    return response(200, renewable());
  };
  const loggedIn = await api.login({ backendUrl: "https://api.test", email: user.email, password: "p", deviceName: "Chrome" }, "client-1");
  await session.saveSession(loggedIn);
  const state = data.get("sharedBookmarkSyncState");
  assert.equal(state.session.refreshToken, undefined);
  assert.equal(state.session.accessToken, "");
  assert.equal(sessionData.get("sharedBookmarkSyncAccessToken"), "access-1");
  assert.equal((await storage.getState()).session.accessToken, "");
  assert.equal(session.withRuntimeAccessToken(state.session).accessToken, "access-1");
  assert.equal((await projection.getUiState()).state.session.accessToken, "");
  assert.equal(JSON.stringify(state), JSON.stringify(state).replaceAll("refresh-1", ""));
  assert.equal(data.get("sharedBookmarkSyncPrivate").refreshToken, "refresh-1");
  sessionData.clear();
  await session.sessionTestHooks.reset();
  let refreshes = 0;
  globalThis.fetch = async () => { refreshes++; return response(200, renewable("restored", "refresh-2")); };
  await session.restoreSession();
  assert.equal(refreshes, 1);
  assert.equal((await storage.getState()).session.accessToken, "");
  assert.equal(session.getRuntimeAccessToken(), "restored");
});

test("legacy access state pauses without changing projections, mappings, or cursors", async () => {
  data.set("sharedBookmarkSyncState", {
    settings: { backendUrl: "https://api.test", clientId: "client-1" }, session: renewable(), selectedWorkspaceIds: ["w"],
    projectionsByWorkspaceId: { w: { chromeIdByBackendId: { b: "c" }, backendIdByChromeId: { c: "b" }, lastCursor: 7 } },
    cachedOrganizations: [], cachedWorkspacesByOrganization: {}, diagnostics: [],
  });
  await session.restoreSession();
  const state = data.get("sharedBookmarkSyncState");
  assert.equal(state.authState, "loginRequired");
  assert.equal(state.session, null);
  assert.deepEqual(state.selectedWorkspaceIds, ["w"]);
  assert.equal(state.projectionsByWorkspaceId.w.lastCursor, 7);
  assert.equal(state.projectionsByWorkspaceId.w.chromeIdByBackendId.b, "c");
});

test("five 401s refresh once and replay each original mutation unchanged", async () => {
  await session.saveSession(renewable("expired"));
  let refreshes = 0;
  const mutations = [];
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/auth/refresh")) { refreshes++; return response(200, renewable("fresh", "refresh-2")); }
    const headerEntries = [...new Headers(init.headers).entries()];
    const headers = Object.fromEntries(headerEntries);
    mutations.push({ auth: headers.authorization, authCount: headerEntries.filter(([key]) => key.toLowerCase() === "authorization").length, clientCount: headerEntries.filter(([key]) => key.toLowerCase() === "x-client-id").length, body: init.body, event: headers["x-sync-event-id"], cursor: headers["x-sync-base-cursor"] });
    return headers.authorization === "Bearer fresh" ? response(200, { id: "folder" }) : response(401, { error: "expired" });
  };
  await Promise.all(Array.from({ length: 5 }, () => api.createFolder("https://api.test", { ...renewable("ignored"), accessToken: "" }, "w", { name: "N" }, 9)));
  assert.equal(refreshes, 1);
  assert.equal(mutations.length, 10);
  const pairs = new Map();
  for (const mutation of mutations) pairs.set(mutation.event, [...(pairs.get(mutation.event) ?? []), mutation]);
  for (const pair of pairs.values()) {
    assert.equal(pair.length, 2);
    assert.equal(pair[0].auth, "Bearer expired");
    assert.equal(pair[1].auth, "Bearer fresh");
    assert.equal(pair[1].authCount, 1);
    assert.equal(pair[1].clientCount, 1);
    assert.equal(pair[0].body, pair[1].body);
    assert.equal(pair[0].cursor, pair[1].cursor);
  }
});

test("logout discards a delayed refresh response and clears every local credential", async () => {
  await session.saveSession(renewable("expired"));
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  let started;
  const refreshStarted = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = async (url) => {
    if (url.endsWith("/auth/logout")) return response(204);
    started();
    return delayed;
  };
  const refresh = session.refreshSession("https://api.test");
  await refreshStarted;
  data.get("sharedBookmarkSyncState").session = null;
  await projection.logout();
  release(response(200, renewable("late", "late-refresh")));
  await assert.rejects(refresh, /Session changed/);
  assert.equal(data.get("sharedBookmarkSyncPrivate"), undefined);
  assert.equal(data.get("sharedBookmarkSyncState").session, null);
  assert.equal(sessionData.get("sharedBookmarkSyncAccessToken"), undefined);
  assert.equal(session.getRuntimeAccessToken(), "");
});

test("lost response reuses attempt, while invalid and operational failures preserve or pause safely", async () => {
  await session.saveSession(renewable());
  const attempts = [];
  globalThis.fetch = async (_url, init) => { attempts.push(JSON.parse(init.body).attemptId); throw new TypeError("offline"); };
  await assert.rejects(session.refreshSession("https://api.test"));
  await session.sessionTestHooks.reset();
  globalThis.fetch = async (_url, init) => { attempts.push(JSON.parse(init.body).attemptId); return response(503); };
  await assert.rejects(session.refreshSession("https://api.test"));
  assert.equal(attempts[0], attempts[1]);
  assert.equal(data.get("sharedBookmarkSyncPrivate").refreshToken, "refresh-1");
  await session.sessionTestHooks.reset();
  globalThis.fetch = async () => response(401);
  await assert.rejects(session.refreshSession("https://api.test"));
  assert.equal(data.get("sharedBookmarkSyncPrivate"), undefined);
  assert.equal(data.get("sharedBookmarkSyncState").authState, "loginRequired");
});
