export type ColorSchemePreference = "light" | "dark" | "system";

export type EffectiveColorScheme = "light" | "dark";

export const COLOR_SCHEME_STORAGE_KEY = "urlises-color-scheme";

const VALID_PREFERENCES: ColorSchemePreference[] = ["light", "dark", "system"];

function isColorSchemePreference(value: string | null): value is ColorSchemePreference {
  return value !== null && (VALID_PREFERENCES as string[]).includes(value);
}

export function resolveEffectiveScheme(preference: ColorSchemePreference, systemPrefersDark: boolean): EffectiveColorScheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

export function readStoredPreference(): ColorSchemePreference {
  try {
    const stored = window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    return isColorSchemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function writeStoredPreference(preference: ColorSchemePreference): void {
  try {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, preference);
  } catch {
    // Best-effort persistence only (e.g. private browsing may throw); never crash the caller.
  }
}

// Light has no attribute-selector override in tokens.css ([data-theme="dark"] is the
// only variant), so the light case simply removes the attribute rather than setting
// data-theme="light" explicitly.
export function applyThemeAttribute(effective: EffectiveColorScheme): void {
  if (effective === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    delete document.documentElement.dataset.theme;
  }
}
