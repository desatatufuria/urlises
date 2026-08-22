import { useCallback, useEffect, useState } from "react";
import {
  applyThemeAttribute,
  readStoredPreference,
  resolveEffectiveScheme,
  writeStoredPreference,
  type ColorSchemePreference,
} from "./colorScheme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/**
 * Reads the stored preference, resolves it against the current system setting,
 * and applies it to the document. Safe to call before React mounts (e.g. from
 * main.tsx) to avoid a flash of the wrong theme on first paint.
 */
export function applyStoredColorScheme(): void {
  const preference = readStoredPreference();
  const systemPrefersDark = window.matchMedia(DARK_MEDIA_QUERY).matches;
  applyThemeAttribute(resolveEffectiveScheme(preference, systemPrefersDark));
}

export function useColorScheme() {
  const [preference, setPreferenceState] = useState<ColorSchemePreference>(() => readStoredPreference());

  useEffect(() => {
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    applyThemeAttribute(resolveEffectiveScheme(preference, media.matches));

    const handleChange = (event: MediaQueryListEvent) => {
      applyThemeAttribute(resolveEffectiveScheme(preference, event.matches));
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);

  const setPreference = useCallback((next: ColorSchemePreference) => {
    writeStoredPreference(next);
    setPreferenceState(next);
    const systemPrefersDark = window.matchMedia(DARK_MEDIA_QUERY).matches;
    applyThemeAttribute(resolveEffectiveScheme(next, systemPrefersDark));
  }, []);

  return { preference, setPreference };
}
