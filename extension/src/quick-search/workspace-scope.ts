// Pure logic for the quick-search workspace-scope filter: no chrome.*, no
// DOM, unit-tested directly under node --test (design.md ADR-503/504). The
// entry file (quick-search.ts) wires these into the render pipeline.

import type { ExtensionState, QuickSearchScope } from "../shared/types.js";

/**
 * Collapses the selected workspaces' backendIdByChromeId maps into a single
 * Set<string> — a snapshot built once per window open, not per keystroke
 * (design.md ADR-503). Membership is the UNION over `selectedWorkspaceIds`,
 * not `Object.keys(projectionsByWorkspaceId)`: iterating the selection list
 * is invariant-independent and survives a projection that lingers after a
 * failed removal. A selected workspace with no projection yet (still
 * bootstrapping) contributes nothing, which is correct — it simply has no
 * managed ids yet.
 */
export function collectManagedChromeIds(
  state: Pick<ExtensionState, "selectedWorkspaceIds" | "projectionsByWorkspaceId">,
): Set<string> {
  const ids = new Set<string>();
  for (const workspaceId of state.selectedWorkspaceIds) {
    const projection = state.projectionsByWorkspaceId[workspaceId];
    if (!projection) continue;
    for (const chromeId of Object.keys(projection.backendIdByChromeId)) {
      ids.add(chromeId);
    }
  }
  return ids;
}

export interface ScopeAvailability {
  workspaceEnabled: boolean;
  effectiveScope: QuickSearchScope;
  disabledReason?: string;
}

/**
 * Computes the scope actually usable for rendering, WITHOUT ever persisting
 * a fallback (design.md ADR-504): `workspace` is available only when signed
 * in AND at least one workspace is selected. When unavailable, the
 * effective scope silently falls back to `global` for rendering, but the
 * caller's persisted preference is left untouched — a signed-out user's
 * "workspace" choice survives and reactivates after signing back in.
 */
export function resolveScopeAvailability(
  state: Pick<ExtensionState, "session" | "selectedWorkspaceIds">,
  persisted: QuickSearchScope,
): ScopeAvailability {
  const workspaceEnabled = Boolean(state.session) && state.selectedWorkspaceIds.length > 0;
  if (workspaceEnabled) {
    return { workspaceEnabled, effectiveScope: persisted };
  }
  return {
    workspaceEnabled,
    effectiveScope: "global",
    disabledReason: state.session
      ? "Select a workspace in Options to search only synced bookmarks."
      : "Sign in from the URLises popup to search only synced bookmarks.",
  };
}

/**
 * Filters search results by scope. `global` passes everything through
 * unchanged — Personal (not synced) bookmarks are never keys in any
 * workspace's backendIdByChromeId (design.md §2.3), so they are naturally
 * excluded from `workspace` scope by this membership test with no special
 * casing needed. MUST be called before capping, never after (design.md §5):
 * capping first would silently hide workspace matches whenever personal
 * bookmarks crowd the head of Chrome's own ordering.
 */
export function filterByScope<T extends { id: string }>(
  results: T[],
  scope: QuickSearchScope,
  managedChromeIds: Set<string>,
): T[] {
  if (scope === "global") return results;
  return results.filter((result) => managedChromeIds.has(result.id));
}
