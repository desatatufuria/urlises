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
const { filterRecipients, MAX_RECIPIENT_SUGGESTIONS } = await import("../dist/create-secret/recipient-filter.js");

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

// RED: api.getSecretRecipients must GET /me/secret-recipients with bearer
// auth headers and unwrap the {recipients} envelope, mirroring
// list-secrets.test.mjs's api.listSecrets test.
test("api.getSecretRecipients fetches GET /me/secret-recipients with bearer auth", async () => {
  await session.saveSession(renewable());
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    return response(200, {
      recipients: [{ userId: "user-2", email: "peer@example.test", name: "Peer" }],
    });
  };
  const recipients = await api.getSecretRecipients("https://api.test", { ...renewable(), accessToken: "" });
  assert.equal(captured.url, "https://api.test/me/secret-recipients");
  assert.equal(captured.method, "GET");
  assert.equal(captured.headers.authorization, "Bearer access-1");
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].userId, "user-2");
  assert.equal(recipients[0].email, "peer@example.test");
});

// RED: the background handler must require an authenticated session before
// calling the API, mirroring createSecret/listSecrets' guard.
test("projection.listSecretRecipients requires an authenticated session", async () => {
  await assert.rejects(
    projection.listSecretRecipients(),
    /sign in required/,
  );
});

// RED: on success, the handler returns the raw entries from the API
// unmodified — the directory isn't persisted state.
test("projection.listSecretRecipients returns the entries from the backend", async () => {
  await session.saveSession(renewable());
  globalThis.fetch = async (url) => {
    assert.ok(url.endsWith("/me/secret-recipients"));
    return response(200, {
      recipients: [
        { userId: "user-1", email: "user@example.test" },
        { userId: "user-2", email: "peer@example.test", name: "Peer" },
      ],
    });
  };
  const recipients = await projection.listSecretRecipients();
  assert.equal(recipients.length, 2);
  assert.equal(recipients[0].userId, "user-1");
  assert.equal(recipients[1].name, "Peer");
});

// --- filterRecipients (pure module) ---------------------------------------

const candidates = [
  { userId: "u1", email: "alice@example.test", name: "Alice Anders" },
  { userId: "u2", email: "bob@example.test", name: "Bob Baker" },
  { userId: "u3", email: "carol.alison@example.test", name: "Carol Craig" },
  { userId: "u4", email: "dave@example.test" },
];

// RED: an empty or whitespace-only query returns [] -- the compact panel
// shows nothing until the user types (Decision 15).
test("filterRecipients returns [] for an empty or whitespace-only query", () => {
  assert.deepEqual(filterRecipients(candidates, ""), []);
  assert.deepEqual(filterRecipients(candidates, "   "), []);
});

// RED: matches a substring of the email field.
test("filterRecipients matches a substring of the email", () => {
  const results = filterRecipients(candidates, "bob@");
  assert.equal(results.length, 1);
  assert.equal(results[0].userId, "u2");
});

// RED: matches a substring of the name field.
test("filterRecipients matches a substring of the name", () => {
  const results = filterRecipients(candidates, "Craig");
  assert.equal(results.length, 1);
  assert.equal(results[0].userId, "u3");
});

// RED: matching is case-insensitive on both fields.
test("filterRecipients matches case-insensitively", () => {
  const results = filterRecipients(candidates, "ALICE");
  assert.equal(results.length, 1);
  assert.equal(results[0].userId, "u1");
});

// RED: a candidate whose email or name starts with the query ranks before a
// candidate that only matches mid-string, even though the mid-string match
// appears earlier in the server's email-sorted order.
test("filterRecipients ranks prefix matches before mid-string matches", () => {
  // "alison" is a mid-string match of carol.alison@example.test's email and
  // comes before "Alison ..." in server order; "Alison Young" is a prefix
  // match of its own name and must rank first despite appearing later.
  const prefixLater = [
    { userId: "u3", email: "carol.alison@example.test", name: "Carol Craig" },
    { userId: "u5", email: "alison@example.test", name: "Alison Young" },
  ];
  const results = filterRecipients(prefixLater, "alison");
  assert.equal(results.length, 2);
  assert.equal(results[0].userId, "u5");
  assert.equal(results[1].userId, "u3");
});

// RED: within the same rank, the server's existing email-sorted order is
// preserved (no re-sorting by the filter itself).
test("filterRecipients preserves server email order within the same rank", () => {
  const sameRank = [
    { userId: "u1", email: "team-a@example.test", name: "Team A" },
    { userId: "u2", email: "team-b@example.test", name: "Team B" },
  ];
  const results = filterRecipients(sameRank, "team");
  assert.deepEqual(results.map((r) => r.userId), ["u1", "u2"]);
});

// RED: results are capped at MAX_RECIPIENT_SUGGESTIONS even when more
// candidates match.
test("filterRecipients caps results at MAX_RECIPIENT_SUGGESTIONS", () => {
  const many = Array.from({ length: MAX_RECIPIENT_SUGGESTIONS + 5 }, (_, i) => ({
    userId: `u${i}`,
    email: `match${i}@example.test`,
  }));
  const results = filterRecipients(many, "match");
  assert.equal(results.length, MAX_RECIPIENT_SUGGESTIONS);
});

// RED: no match on either field returns [].
test("filterRecipients returns [] when nothing matches", () => {
  assert.deepEqual(filterRecipients(candidates, "zzz-no-match"), []);
});

// RED: an empty candidate list returns [] regardless of query.
test("filterRecipients returns [] for an empty candidate list", () => {
  assert.deepEqual(filterRecipients([], "alice"), []);
});
