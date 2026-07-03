import { DIAGNOSTIC_LIMIT } from "./runtime.js";
import type { DiagnosticEntry, ExtensionState } from "./types.js";

export function pushDiagnostic(state: ExtensionState, entry: Omit<DiagnosticEntry, "time">): ExtensionState {
  const nextEntry: DiagnosticEntry = {
    time: new Date().toISOString(),
    ...entry,
  };

  return {
    ...state,
    diagnostics: [nextEntry, ...state.diagnostics].slice(0, DIAGNOSTIC_LIMIT),
  };
}
