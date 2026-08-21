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
