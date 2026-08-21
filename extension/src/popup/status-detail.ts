import type { StatusTone } from "../shared/ui/status.js";

/**
 * Pure predicate for whether the popup's status detail sentence should be
 * shown. Only the "attention" tone carries genuinely new information the
 * user needs before deciding what to do next; "neutral" and "live" tones
 * are already fully conveyed by the status pill, so repeating a confirmation
 * sentence would be redundant "data slop". Kept side-effect free (no DOM
 * access) so it can be unit tested directly.
 */
export function shouldShowStatusDetail(tone: StatusTone): boolean {
  return tone === "attention";
}
