import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";

// jsdom's built-in Crypto implements getRandomValues/randomUUID but not
// SubtleCrypto. Patch in Node's webcrypto.subtle for tests only — production
// builds run in a real browser, which always provides window.crypto.subtle.
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, "subtle", { value: webcrypto.subtle });
}

// jsdom does not implement window.matchMedia. Provide a minimal stub so
// color-scheme detection (system light/dark) doesn't crash in tests; it
// always reports "no match" and supports the addEventListener/removeEventListener
// pair useColorScheme relies on to react to live OS theme changes.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

