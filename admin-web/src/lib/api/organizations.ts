import { apiRequest, newIdempotencyKey } from "./client";
import type { OrganizationMember, OrganizationMembership, OrganizationRole, PendingInvitation } from "./types";

interface RawInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: string;
  invitedByUserId: string;
  invitedByEmail?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string | null;
}

function normalizeInvitation(invitation: RawInvitation): PendingInvitation {
  return {
    invitationId: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedByUserId: invitation.invitedByUserId,
    invitedByEmail: invitation.invitedByEmail,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
    expiresAt: invitation.expiresAt ?? null,
  };
}

export async function listOrganizations(token: string) {
  const response = await apiRequest<{ organizations: OrganizationMembership[] }>("/organizations", { token });
  return response.organizations;
}

export async function listOrganizationMembers(token: string, organizationId: string) {
  const response = await apiRequest<{ members: OrganizationMember[] }>(`/organizations/${organizationId}/members`, { token });
  return response.members;
}

export async function listOrganizationInvitations(token: string, organizationId: string) {
  const response = await apiRequest<{ invitations: RawInvitation[] }>(`/organizations/${organizationId}/invitations`, { token });
  return response.invitations.map(normalizeInvitation);
}

export function createOrganizationInvitation(token: string, organizationId: string, input: { email: string; role: OrganizationRole }, idempotencyKey = newIdempotencyKey()) {
  return apiRequest<RawInvitation>(`/organizations/${organizationId}/invitations`, {
    method: "POST",
    token,
    body: input,
    idempotencyKey,
  }).then(normalizeInvitation);
}

export function patchOrganizationMember(
  token: string,
  organizationId: string,
  input: { userId: string; role?: OrganizationRole; remove?: boolean },
) {
  return apiRequest<OrganizationMember | undefined>(`/organizations/${organizationId}/members`, {
    method: "PATCH",
    token,
    body: input,
  });
}
