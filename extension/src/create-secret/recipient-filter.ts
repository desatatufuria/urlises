// Pure helper for the create-secret page's recipient picker. Kept side-effect
// free (no DOM access) so it can be unit tested directly, mirroring
// content-limit.ts and popup/advanced-toggle.ts -- create-secret.ts's own
// header comment states DOM wiring there is deliberately not unit tested.

import type { SecretRecipient } from "../shared/types.js";

/** Compact-panel cap on the number of rendered suggestions, independent of
 * how many candidates the directory backend returns. */
export const MAX_RECIPIENT_SUGGESTIONS = 8;

/**
 * Case-insensitive substring match on email OR name. Prefix matches rank
 * before mid-string matches; within a rank the server's existing
 * email-sorted order is preserved (no re-sorting here). An empty or
 * whitespace-only query returns [] -- the compact panel shows nothing until
 * the user types (see design.md Decision 15). Results are capped at
 * MAX_RECIPIENT_SUGGESTIONS.
 */
export function filterRecipients(candidates: readonly SecretRecipient[], query: string): SecretRecipient[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const prefixMatches: SecretRecipient[] = [];
  const midMatches: SecretRecipient[] = [];

  for (const candidate of candidates) {
    const email = candidate.email.toLowerCase();
    const name = (candidate.name ?? "").toLowerCase();
    const emailIndex = email.indexOf(normalizedQuery);
    const nameIndex = name.indexOf(normalizedQuery);
    if (emailIndex === -1 && nameIndex === -1) {
      continue;
    }
    const isPrefixMatch = emailIndex === 0 || nameIndex === 0;
    (isPrefixMatch ? prefixMatches : midMatches).push(candidate);
  }

  return [...prefixMatches, ...midMatches].slice(0, MAX_RECIPIENT_SUGGESTIONS);
}
