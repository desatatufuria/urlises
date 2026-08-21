import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";

// jsdom's built-in Crypto implements getRandomValues/randomUUID but not
// SubtleCrypto. Patch in Node's webcrypto.subtle for tests only — production
// builds run in a real browser, which always provides window.crypto.subtle.
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, "subtle", { value: webcrypto.subtle });
}

