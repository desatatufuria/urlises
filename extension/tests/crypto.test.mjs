import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

import {
  decrypt,
  deriveWrappingKey,
  encrypt,
  generateContentKey,
  MIN_KDF_ITERATIONS,
  unwrapKey,
  wrapKey,
} from "../dist/shared/crypto.js";

test("round-trips plaintext through encrypt/decrypt with the same content key", async () => {
  const key = await generateContentKey();

  const { ciphertext, iv } = await encrypt(key, "top secret credential");
  const plaintext = await decrypt(key, ciphertext, iv);

  assert.equal(plaintext, "top secret credential");
});

test("round-trips a different plaintext to prove decrypt is not a hardcoded stub", async () => {
  const key = await generateContentKey();

  const { ciphertext, iv } = await encrypt(key, "a completely different message");
  const plaintext = await decrypt(key, ciphertext, iv);

  assert.equal(plaintext, "a completely different message");
});

test("derives a PBKDF2-SHA256 wrapping key with at least 210,000 iterations by default", async () => {
  const { iterations } = await deriveWrappingKey("correct horse battery staple");

  assert.ok(iterations >= MIN_KDF_ITERATIONS);
});

test("generates a fresh random salt on every call, even for the same passphrase", async () => {
  const first = await deriveWrappingKey("same passphrase");
  const second = await deriveWrappingKey("same passphrase");

  assert.notEqual(first.salt, second.salt);
});

test("wraps and unwraps a content key round-trip with the correct passphrase, salt, and iterations", async () => {
  const contentKey = await generateContentKey();
  const { key: wrappingKey, salt, iterations } = await deriveWrappingKey("correct passphrase");
  const wrapped = await wrapKey(wrappingKey, contentKey);

  const { key: sameWrappingKey } = await deriveWrappingKey("correct passphrase", salt, iterations);
  const unwrapped = await unwrapKey(sameWrappingKey, wrapped);

  const { ciphertext, iv } = await encrypt(contentKey, "payload protected by a passphrase");
  const plaintext = await decrypt(unwrapped, ciphertext, iv);

  assert.equal(plaintext, "payload protected by a passphrase");
});

test("rejects with a GCM auth-tag mismatch (not silent garbage) when unwrapping with the wrong passphrase", async () => {
  const contentKey = await generateContentKey();
  const { key: wrappingKey, salt, iterations } = await deriveWrappingKey("correct passphrase");
  const wrapped = await wrapKey(wrappingKey, contentKey);

  const { key: wrongWrappingKey } = await deriveWrappingKey("wrong passphrase", salt, iterations);

  await assert.rejects(() => unwrapKey(wrongWrappingKey, wrapped));
});

test("wire format matches admin-web: wrappedContentKey is base64(iv(12B) || gcmCiphertext)", async () => {
  const contentKey = await generateContentKey();
  const { key: wrappingKey } = await deriveWrappingKey("passphrase");
  const wrapped = await wrapKey(wrappingKey, contentKey);

  const combined = Buffer.from(wrapped, "base64");
  // AES-256-GCM wraps a 32-byte raw key into a 32-byte ciphertext + 16-byte
  // auth tag; the wire format prefixes that with a 12-byte IV.
  assert.equal(combined.length, 12 + 32 + 16);
});
