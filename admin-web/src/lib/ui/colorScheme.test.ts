import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeAttribute,
  COLOR_SCHEME_STORAGE_KEY,
  readStoredPreference,
  resolveEffectiveScheme,
  writeStoredPreference,
} from "./colorScheme";

describe("resolveEffectiveScheme", () => {
  it("passes light through unchanged when the system prefers dark", () => {
    expect(resolveEffectiveScheme("light", true)).toBe("light");
  });

  it("passes light through unchanged when the system prefers light", () => {
    expect(resolveEffectiveScheme("light", false)).toBe("light");
  });

  it("passes dark through unchanged when the system prefers dark", () => {
    expect(resolveEffectiveScheme("dark", true)).toBe("dark");
  });

  it("passes dark through unchanged when the system prefers light", () => {
    expect(resolveEffectiveScheme("dark", false)).toBe("dark");
  });

  it("resolves system to dark when the system prefers dark", () => {
    expect(resolveEffectiveScheme("system", true)).toBe("dark");
  });

  it("resolves system to light when the system prefers light", () => {
    expect(resolveEffectiveScheme("system", false)).toBe("light");
  });
});

describe("readStoredPreference", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns a valid stored preference as-is", () => {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, "dark");
    expect(readStoredPreference()).toBe("dark");
  });

  it("defaults to system when nothing is stored", () => {
    expect(readStoredPreference()).toBe("system");
  });

  it("defaults to system when the stored value is invalid", () => {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, "not-a-real-preference");
    expect(readStoredPreference()).toBe("system");
  });

  it("defaults to system without crashing when localStorage.getItem throws", () => {
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => readStoredPreference()).not.toThrow();
    expect(readStoredPreference()).toBe("system");
  });
});

describe("writeStoredPreference", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("writes the preference under the expected key", () => {
    writeStoredPreference("dark");
    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("dark");
  });

  it("does not throw when localStorage.setItem throws", () => {
    vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => writeStoredPreference("light")).not.toThrow();
  });
});

describe("applyThemeAttribute", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("sets data-theme to dark when effective is dark", () => {
    applyThemeAttribute("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("leaves data-theme absent when effective is light", () => {
    document.documentElement.dataset.theme = "dark";
    applyThemeAttribute("light");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
