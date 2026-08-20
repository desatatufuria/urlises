import { apiRequest } from "./client";
import type { AcceptedInvitation } from "./types";

export function acceptInvitation(accessToken: string, invitationToken: string) {
  return apiRequest<AcceptedInvitation>(`/invitations/${encodeURIComponent(invitationToken)}/accept`, {
    method: "POST",
    token: accessToken,
  });
}
