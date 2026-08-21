// Pure helper for the Options page's compact "Secret history" section.
// Kept side-effect free (no DOM access) so it can be unit tested directly,
// mirroring create-secret/content-limit.ts and popup/status-detail.ts.

import type { SecretHistoryEntry } from "../shared/api.js";
import { formatUiTimestamp } from "../shared/ui/status.js";

export type SecretHistoryStatusTag = "pending" | "read" | "expired";

export interface FormattedSecretHistoryEntry {
  id: string;
  createdLabel: string;
  statusLabel: string;
  statusTag: SecretHistoryStatusTag;
}

/**
 * Formats one secret-history row for display: the created time using this
 * codebase's existing short-absolute timestamp convention
 * (formatUiTimestamp — see shared/ui/status.ts) and a status label that is
 * exactly one of "Pending", "Read <time>", or "Expired — never read".
 *
 * `now` is threaded through explicitly (rather than calling `new Date()`
 * internally) both for deterministic unit testing and as a client-side
 * safety net mirroring the backend's compute-don't-store expiry rule
 * (status == 'pending' AND now > expiresAt, see
 * backend/internal/secrethide/handler.go's secretHistoryStatus): if the
 * list was fetched slightly before an entry's expiresAt but is rendered
 * slightly after, this keeps the label accurate without waiting for a
 * refetch.
 */
export function formatSecretHistoryEntry(entry: SecretHistoryEntry, now: Date): FormattedSecretHistoryEntry {
  const statusTag = resolveSecretHistoryStatusTag(entry, now);
  const statusLabel = formatSecretHistoryStatusLabel(entry, statusTag);
  return {
    id: entry.id,
    createdLabel: formatUiTimestamp(entry.createdAt) ?? entry.createdAt,
    statusLabel: entry.sentToEmail ? `${statusLabel} — sent to ${entry.sentToEmail}` : statusLabel,
    statusTag,
  };
}

function resolveSecretHistoryStatusTag(entry: SecretHistoryEntry, now: Date): SecretHistoryStatusTag {
  if (entry.status === "read") {
    return "read";
  }
  if (entry.status === "expired" || now.getTime() > new Date(entry.expiresAt).getTime()) {
    return "expired";
  }
  return "pending";
}

function formatSecretHistoryStatusLabel(entry: SecretHistoryEntry, statusTag: SecretHistoryStatusTag): string {
  switch (statusTag) {
    case "read":
      return `Read ${entry.readAt ? (formatUiTimestamp(entry.readAt) ?? entry.readAt) : ""}`.trim();
    case "expired":
      return "Expired — never read";
    case "pending":
      return "Pending";
  }
}
