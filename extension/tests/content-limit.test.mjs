import test from "node:test";
import assert from "node:assert/strict";

import { estimateContentLimitStatus, MAX_CIPHERTEXT_BASE64_BYTES } from "../dist/create-secret/content-limit.js";

// RED: small content is well under the server's 64 KB base64 ciphertext cap
// (see backend/internal/secrethide/handler.go's maxCiphertextBase64Bytes),
// so the UI should show a plain "ok" status, not a warning.
test("small content reports an ok status far from the cap", () => {
  const status = estimateContentLimitStatus(200);
  assert.equal(status.level, "ok");
  assert.equal(status.capBytes, MAX_CIPHERTEXT_BASE64_BYTES);
  assert.ok(status.estimatedCiphertextBase64Bytes < status.capBytes);
});

// RED: content whose estimated base64 ciphertext size crosses 90% of the
// cap must warn the user before they hit a hard failure on submit.
test("content approaching the cap reports a warning status", () => {
  // ~92% of 64 KB post-base64 corresponds to roughly 45,000 raw plaintext bytes.
  const status = estimateContentLimitStatus(45_000);
  assert.equal(status.level, "warning");
  assert.ok(status.estimatedCiphertextBase64Bytes <= status.capBytes);
});

// RED: content whose estimated base64 ciphertext size exceeds the cap must
// be flagged "over" so the UI can block submission instead of letting the
// server reject it after the fact.
test("content exceeding the cap reports an over status", () => {
  const status = estimateContentLimitStatus(60_000);
  assert.equal(status.level, "over");
  assert.ok(status.estimatedCiphertextBase64Bytes > status.capBytes);
});

// RED: the estimate must account for AES-GCM's fixed 16-byte auth tag
// overhead and base64's 4/3 expansion, not just raw content length — an
// estimate that ignores this would under-warn right at the boundary.
test("estimate reflects base64 expansion and the GCM auth tag overhead", () => {
  const contentBytes = 9;
  const status = estimateContentLimitStatus(contentBytes);
  // (9 + 16) bytes of ciphertext -> base64 = ceil(25/3)*4 = 36 bytes.
  assert.equal(status.estimatedCiphertextBase64Bytes, 36);
});
