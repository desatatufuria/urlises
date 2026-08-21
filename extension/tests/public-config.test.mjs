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
const { DEFAULT_PUBLIC_BASE_URL } = await import("../dist/shared/runtime.js");

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

// RED: session restore must fetch GET /config/public exactly once
// (best-effort, mirroring refreshPreferences) and persist the returned
// publicBaseUrl into settings, so popup.ts can build correct share links
// without hardcoding localhost.
test("session restore fetches public config once (best-effort) and stores the publicBaseUrl", async () => {
  await session.saveSession(renewable());
  sessionData.clear();
  await session.sessionTestHooks.reset();

  let publicConfigCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/auth/refresh")) return response(200, renewable("restored", "refresh-2"));
    if (url.endsWith("/me/preferences")) return response(200, { uiTheme: "slate" });
    if (url.endsWith("/config/public")) {
      publicConfigCalls++;
      return response(200, { publicBaseUrl: "https://admin.urlises.lab.dtfuria.xyz" });
    }
    return response(404, {});
  };
  await projection.initializeBackground();
  assert.equal(publicConfigCalls, 1);
  assert.equal((await storage.getState()).settings.publicBaseUrl, "https://admin.urlises.lab.dtfuria.xyz");
});

// RED: an older/incompatible backend that doesn't serve /config/public (or
// any other fetch failure) must never throw and must never clobber whatever
// is already persisted — the create-secret flow must keep working.
test("session restore public config fetch failure keeps local state instead of throwing", async () => {
  await session.saveSession(renewable());
  sessionData.clear();
  await session.sessionTestHooks.reset();

  globalThis.fetch = async (url) => {
    if (url.endsWith("/auth/refresh")) return response(200, renewable("restored", "refresh-2"));
    if (url.endsWith("/me/preferences")) return response(200, { uiTheme: "slate" });
    if (url.endsWith("/config/public")) return response(404, {});
    return response(404, {});
  };
  await assert.doesNotReject(projection.initializeBackground());
  const state = await storage.getState();
  assert.equal(state.settings.publicBaseUrl, undefined);
  assert.equal(state.settings.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL, DEFAULT_PUBLIC_BASE_URL);
});

// RED: login must fetch and persist the public config too, mirroring
// refreshPreferences being called from both login() and session restore.
test("login fetches public config and persists it in settings", async () => {
  globalThis.fetch = async (url) => {
    if (url.endsWith("/auth/login")) return response(201, renewable());
    if (url.endsWith("/me/preferences")) return response(200, { uiTheme: "slate" });
    if (url.endsWith("/config/public")) return response(200, { publicBaseUrl: "https://admin.urlises.lab.dtfuria.xyz" });
    if (url.includes("/organizations")) return response(200, { organizations: [] });
    return response(404, {});
  };
  await projection.login({ backendUrl: "https://api.test", email: "user@example.test", password: "pw", deviceName: "device" });
  const state = await storage.getState();
  assert.equal(state.settings.publicBaseUrl, "https://admin.urlises.lab.dtfuria.xyz");
});
