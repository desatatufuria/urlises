export interface AdvancedToggleState {
  expanded: boolean;
  ariaExpanded: "true" | "false";
}

/**
 * Pure state transition for the popup's "Advanced setup" disclosure toggle.
 * Kept side-effect free (no DOM access) so it can be unit tested directly.
 */
export function nextAdvancedToggleState(isExpanded: boolean): AdvancedToggleState {
  const expanded = !isExpanded;
  return { expanded, ariaExpanded: expanded ? "true" : "false" };
}
