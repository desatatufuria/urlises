import { describe, expect, it } from "vitest";
import { deriveWrappingKey, decrypt, encrypt, generateContentKey, MIN_KDF_ITERATIONS, unwrapKey, wrapKey } from "./crypto";

describe("crypto", () => {
  it("round-trips plaintext through encrypt/decrypt with the same content key", async () => {
    const key = await generateContentKey();

    const { ciphertext, iv } = await encrypt(key, "top secret credential");
    const plaintext = await decrypt(key, ciphertext, iv);

    expect(plaintext).toBe("top secret credential");
  });

  it("round-trips a different plaintext to prove decrypt is not a hardcoded stub", async () => {
    const key = await generateContentKey();

    const { ciphertext, iv } = await encrypt(key, "a completely different message");
    const plaintext = await decrypt(key, ciphertext, iv);

    expect(plaintext).toBe("a completely different message");
  });

  it("derives a PBKDF2-SHA256 wrapping key with at least 210,000 iterations by default", async () => {
    const { iterations } = await deriveWrappingKey("correct horse battery staple");

    expect(iterations).toBeGreaterThanOrEqual(MIN_KDF_ITERATIONS);
  });

  it("generates a fresh random salt on every call, even for the same passphrase", async () => {
    const first = await deriveWrappingKey("same passphrase");
    const second = await deriveWrappingKey("same passphrase");

    expect(first.salt).not.toBe(second.salt);
  });

  it("wraps and unwraps a content key round-trip with the correct passphrase, salt, and iterations", async () => {
    const contentKey = await generateContentKey();
    const { key: wrappingKey, salt, iterations } = await deriveWrappingKey("correct passphrase");
    const wrapped = await wrapKey(wrappingKey, contentKey);

    const { key: sameWrappingKey } = await deriveWrappingKey("correct passphrase", salt, iterations);
    const unwrapped = await unwrapKey(sameWrappingKey, wrapped);

    const { ciphertext, iv } = await encrypt(contentKey, "payload protected by a passphrase");
    const plaintext = await decrypt(unwrapped, ciphertext, iv);

    expect(plaintext).toBe("payload protected by a passphrase");
  });

  it("rejects with a GCM auth-tag mismatch (not silent garbage) when unwrapping with the wrong passphrase", async () => {
    const contentKey = await generateContentKey();
    const { key: wrappingKey, salt, iterations } = await deriveWrappingKey("correct passphrase");
    const wrapped = await wrapKey(wrappingKey, contentKey);

    const { key: wrongWrappingKey } = await deriveWrappingKey("wrong passphrase", salt, iterations);

    await expect(unwrapKey(wrongWrappingKey, wrapped)).rejects.toThrow();
  });
});
