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

// RED: api.listSecrets must GET /secrets with bearer auth headers, matching
// createWSTicket/getOrganizations' authenticated-GET shape.
test("api.listSecrets fetches GET /secrets with bearer auth", async () => {
  await session.saveSession(renewable());
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    return response(200, [
      { id: "secret-1", createdAt: "2026-08-20T00:00:00Z", expiresAt: "2026-08-21T00:00:00Z", status: "pending", readAt: null },
    ]);
  };
  const entries = await api.listSecrets("https://api.test", { ...renewable(), accessToken: "" });
  assert.equal(captured.url, "https://api.test/secrets");
  assert.equal(captured.method, "GET");
  assert.equal(captured.headers.authorization, "Bearer access-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "secret-1");
});

// RED: the background handler must require an authenticated session before
// calling the API, mirroring createSecret/sendSecretEmail's guard.
test("projection.listSecrets requires an authenticated session", async () => {
  await assert.rejects(
    projection.listSecrets(),
    /sign in required/,
  );
});

// RED: on success, the handler returns the raw entries from the API
// unmodified — no UiState wrapping, since history isn't persisted state.
test("projection.listSecrets returns the entries from the backend", async () => {
  await session.saveSession(renewable());
  globalThis.fetch = async (url) => {
    assert.ok(url.endsWith("/secrets"));
    return response(200, [
      { id: "secret-1", createdAt: "2026-08-20T00:00:00Z", expiresAt: "2026-08-21T00:00:00Z", status: "read", readAt: "2026-08-20T12:00:00Z" },
      { id: "secret-2", createdAt: "2026-08-19T00:00:00Z", expiresAt: "2026-08-19T01:00:00Z", status: "pending", readAt: null },
    ]);
  };
  const entries = await projection.listSecrets();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, "read");
  assert.equal(entries[1].status, "pending");
});
