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

test("uiTheme defaults to slate when nothing is stored", async () => {
  const state = await storage.getState();
  assert.equal(state.uiTheme ?? "slate", "slate");

  const ui = await projection.getUiState();
  assert.equal(ui.state.uiTheme ?? "slate", "slate");
});

test("setting a theme via the message handler function calls the backend and persists the result", async () => {
  await session.saveSession(renewable());
  await session.setBackendUrl("https://api.test");

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return response(200, { uiTheme: "indigo" });
  };

  const ui = await projection.setUiTheme("indigo");
  assert.equal(ui.state.uiTheme, "indigo");
  assert.equal((await storage.getState()).uiTheme, "indigo");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/me\/preferences$/);
  assert.equal(requests[0].method, "PUT");
  assert.deepEqual(requests[0].body, { uiTheme: "indigo" });
});

test("a failed backend call keeps the previously-persisted theme rather than silently reverting to default", async () => {
  await session.saveSession(renewable());
  await session.setBackendUrl("https://api.test");

  globalThis.fetch = async () => response(200, { uiTheme: "teal" });
  const afterFirstUpdate = await projection.setUiTheme("teal");
  assert.equal(afterFirstUpdate.state.uiTheme, "teal");

  globalThis.fetch = async () => response(500, { error: "unavailable" });
  await assert.rejects(projection.setUiTheme("indigo"));

  const state = await storage.getState();
  assert.equal(state.uiTheme, "teal");
});

test("session restore fetches preferences once (best-effort) and stores the persisted theme", async () => {
  await session.saveSession(renewable());
  sessionData.clear();
  await session.sessionTestHooks.reset();

  let preferencesCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/auth/refresh")) return response(200, renewable("restored", "refresh-2"));
    if (url.endsWith("/me/preferences")) { preferencesCalls++; return response(200, { uiTheme: "indigo" }); }
    return response(404, {});
  };
  await projection.initializeBackground();
  assert.equal(preferencesCalls, 1);
  assert.equal((await storage.getState()).uiTheme, "indigo");
});

test("session restore preferences fetch failure keeps local state instead of throwing", async () => {
  await session.saveSession(renewable());
  await storage.updateState((state) => ({ ...state, uiTheme: "teal" }));
  sessionData.clear();
  await session.sessionTestHooks.reset();

  globalThis.fetch = async (url) => {
    if (url.endsWith("/auth/refresh")) return response(200, renewable("restored", "refresh-2"));
    if (url.endsWith("/me/preferences")) return response(500, { error: "unavailable" });
    return response(404, {});
  };
  await assert.doesNotReject(projection.initializeBackground());
  assert.equal((await storage.getState()).uiTheme, "teal");
});
