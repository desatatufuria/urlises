import { apiRequest } from "./client";
import type { SecretBlob } from "./types";

// Both calls are deliberately unauthenticated: no `token`/session option is
// passed to apiRequest, matching invitations.ts's precedent for public,
// unauthenticated endpoints. The recipient of a share link never has (and
// must never need) an admin session.

export function getSecret(token: string) {
  return apiRequest<SecretBlob>(`/secrets/${encodeURIComponent(token)}`, {
    method: "GET",
  });
}

export function burnSecret(token: string) {
  return apiRequest<{ status: string }>(`/secrets/${encodeURIComponent(token)}/burn`, {
    method: "POST",
  });
}

// SecretHistoryEntry is the metadata-only shape the backend's micro-registry
// (GET /secrets) returns for the authenticated caller's own secrets — never
// a token, ciphertext, iv, or any key/passphrase-related field, since the
// registry must never be usable to re-fetch or re-derive a secret's
// content or link. Field names match
// backend/internal/secrethide/handler.go's secretHistoryView verbatim
// (also mirrored, separately, by extension/src/shared/api.ts).
export interface SecretHistoryEntry {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "read" | "expired";
  readAt: string | null;
  sentToEmail: string | null;
}

// listMySecrets fetches the signed-in admin's own secret history — this is
// scoped strictly to the caller (backend's Service.ListOwned keys on
// principal.UserID), never the wider organization. There is no backend
// capability today for cross-user/org-wide secret visibility.
export function listMySecrets(token: string) {
  return apiRequest<SecretHistoryEntry[]>("/secrets", {
    method: "GET",
    token,
  });
}
