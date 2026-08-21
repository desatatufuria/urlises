import test from "node:test";
import assert from "node:assert/strict";

import { formatSecretHistoryEntry } from "../dist/options/secret-history.js";

const NOW = new Date("2026-08-21T12:00:00Z");

// RED: a pending, not-yet-expired secret shows a plain "Pending" label.
test("formats a pending secret as Pending", () => {
  const entry = {
    id: "secret-1",
    createdAt: "2026-08-21T10:00:00Z",
    expiresAt: "2026-08-22T10:00:00Z",
    status: "pending",
    readAt: null,
  };
  const formatted = formatSecretHistoryEntry(entry, NOW);
  assert.equal(formatted.id, "secret-1");
  assert.equal(formatted.statusLabel, "Pending");
  assert.equal(formatted.statusTag, "pending");
  assert.ok(formatted.createdLabel.length > 0);
});

// RED: a read secret shows "Read <time>" using the same absolute
// timestamp convention as the rest of the UI (formatUiTimestamp), not a
// relative-time string.
test("formats a read secret as Read <time>", () => {
  const entry = {
    id: "secret-2",
    createdAt: "2026-08-20T10:00:00Z",
    expiresAt: "2026-08-21T10:00:00Z",
    status: "read",
    readAt: "2026-08-20T11:30:00Z",
  };
  const formatted = formatSecretHistoryEntry(entry, NOW);
  assert.ok(formatted.statusLabel.startsWith("Read "));
  assert.ok(formatted.statusLabel.length > "Read ".length);
  assert.equal(formatted.statusTag, "read");
});

// RED: a secret whose backend status is already "expired" shows the
// never-read label.
test("formats a backend-computed expired secret as Expired — never read", () => {
  const entry = {
    id: "secret-3",
    createdAt: "2026-08-19T10:00:00Z",
    expiresAt: "2026-08-20T10:00:00Z",
    status: "expired",
    readAt: null,
  };
  const formatted = formatSecretHistoryEntry(entry, NOW);
  assert.equal(formatted.statusLabel, "Expired — never read");
  assert.equal(formatted.statusTag, "expired");
});

// RED: as a client-side safety net mirroring the backend's compute-don't-
// store rule (status == 'pending' AND now > expiresAt), a still-"pending"
// row whose expiresAt has already passed by render time must also render
// as expired — covering the fetch-then-render race window.
test("treats a stale pending row past its expiresAt as expired at render time", () => {
  const entry = {
    id: "secret-4",
    createdAt: "2026-08-19T10:00:00Z",
    expiresAt: "2026-08-20T10:00:00Z", // before NOW
    status: "pending",
    readAt: null,
  };
  const formatted = formatSecretHistoryEntry(entry, NOW);
  assert.equal(formatted.statusLabel, "Expired — never read");
  assert.equal(formatted.statusTag, "expired");
});

// RED: a "read" status always wins over expiresAt, even if expiresAt is
// also in the past — a read secret is never displayed as expired.
test("a read secret is never displayed as expired even past its expiresAt", () => {
  const entry = {
    id: "secret-5",
    createdAt: "2026-08-19T10:00:00Z",
    expiresAt: "2026-08-20T10:00:00Z", // before NOW
    status: "read",
    readAt: "2026-08-19T11:00:00Z",
  };
  const formatted = formatSecretHistoryEntry(entry, NOW);
  assert.ok(formatted.statusLabel.startsWith("Read "));
  assert.equal(formatted.statusTag, "read");
});
