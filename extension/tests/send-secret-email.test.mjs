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

// RED: api.sendSecretEmail must POST to /secrets/{token}/send-email with
// bearer auth headers and a body carrying recipientEmail + fragment — never
// a "link"/"url" field, since the server reconstructs the link itself (see
// backend/internal/secrethide/send_email.go's allowedSendSecretLinkFields).
test("api.sendSecretEmail posts recipientEmail and fragment to the token-scoped endpoint", async () => {
  await session.saveSession(renewable());
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(init.body) };
    return response(200, { status: "sent" });
  };
  const result = await api.sendSecretEmail("https://api.test", { ...renewable(), accessToken: "" }, "tok-123", {
    recipientEmail: "friend@example.test",
    fragment: "AbCdEf==",
  });
  assert.equal(result.status, "sent");
  assert.equal(captured.url, "https://api.test/secrets/tok-123/send-email");
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers.authorization, "Bearer access-1");
  assert.deepEqual(captured.body, { recipientEmail: "friend@example.test", fragment: "AbCdEf==" });
});

// RED: when no fragment is supplied (e.g. a passphrase-protected secret),
// the wire body must omit the field entirely rather than sending an empty
// string or null, matching the server's optional-field contract.
test("api.sendSecretEmail omits fragment entirely when not provided", async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return response(200, { status: "sent" });
  };
  await api.sendSecretEmail("https://api.test", { ...renewable(), accessToken: "" }, "tok-123", {
    recipientEmail: "friend@example.test",
  });
  assert.deepEqual(captured, { recipientEmail: "friend@example.test" });
  assert.equal("fragment" in captured, false);
});

// RED: the background handler must require an authenticated session before
// calling the API, mirroring createSecret's guard.
test("projection.sendSecretEmail requires an authenticated session", async () => {
  await assert.rejects(
    projection.sendSecretEmail({ token: "tok-123", recipientEmail: "friend@example.test" }),
    /sign in required/,
  );
});

// RED: on success, the handler calls through to the backend and resolves
// with the current UiState (mirroring createSecret's return shape).
test("projection.sendSecretEmail sends the email and resolves UiState on success", async () => {
  await session.saveSession(renewable());
  let called = false;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/secrets/tok-123/send-email")) {
      called = true;
      assert.deepEqual(JSON.parse(init.body), { recipientEmail: "friend@example.test", fragment: "frag" });
      return response(200, { status: "sent" });
    }
    return response(404, {});
  };
  const result = await projection.sendSecretEmail({ token: "tok-123", recipientEmail: "friend@example.test", fragment: "frag" });
  assert.equal(called, true);
  assert.ok(result.state);
});

// RED: a 404 (unknown token, not the owner, or not pending — all collapsed
// server-side for security) must surface a specific, actionable message
// instead of a raw HTTP status.
test("projection.sendSecretEmail maps a 404 to an actionable 'no longer valid' message", async () => {
  await session.saveSession(renewable());
  globalThis.fetch = async () => response(404, { error: "not found" });
  await assert.rejects(
    projection.sendSecretEmail({ token: "tok-123", recipientEmail: "friend@example.test" }),
    /no longer valid/i,
  );
});

// RED: 502/503 (mail delivery failure/unavailable) must surface a distinct
// "couldn't send right now" message, not the raw status either.
test("projection.sendSecretEmail maps 502/503 to a delivery-failure message", async () => {
  await session.saveSession(renewable());
  globalThis.fetch = async () => response(502, { error: "email delivery failed" });
  await assert.rejects(
    projection.sendSecretEmail({ token: "tok-123", recipientEmail: "friend@example.test" }),
    /couldn't send/i,
  );

  await session.sessionTestHooks.reset();
  await session.saveSession(renewable());
  globalThis.fetch = async () => response(503, { error: "email delivery unavailable" });
  await assert.rejects(
    projection.sendSecretEmail({ token: "tok-123", recipientEmail: "friend@example.test" }),
    /couldn't send/i,
  );
});
