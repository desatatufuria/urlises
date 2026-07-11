import { apiRequest, newIdempotencyKey } from "./client";
import type { GroupMember, GroupSummary } from "./types";

interface RawGroup {
  id: string;
  organizationId: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

function normalizeGroup(group: RawGroup): GroupSummary {
  return {
    groupId: group.id,
    organizationId: group.organizationId,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export async function listGroups(token: string, organizationId: string) {
  const response = await apiRequest<{ groups: RawGroup[] }>(`/organizations/${organizationId}/groups`, { token });
  return response.groups.map(normalizeGroup);
}

export function createGroup(token: string, organizationId: string, input: { name: string }, idempotencyKey = newIdempotencyKey()) {
  return apiRequest<RawGroup>(`/organizations/${organizationId}/groups`, {
    method: "POST",
    token,
    body: input,
    idempotencyKey,
  }).then(normalizeGroup);
}

export function updateGroup(token: string, organizationId: string, groupId: string, input: { name: string }) {
  return apiRequest<RawGroup>(`/organizations/${organizationId}/groups/${groupId}`, {
    method: "PATCH",
    token,
    body: input,
  }).then(normalizeGroup);
}

export function deleteGroup(token: string, organizationId: string, groupId: string) {
  return apiRequest(`/organizations/${organizationId}/groups/${groupId}`, {
    method: "DELETE",
    token,
  });
}

export async function listGroupMembers(token: string, groupId: string) {
  const response = await apiRequest<{ members: GroupMember[] }>(`/groups/${groupId}/members`, { token });
  return response.members;
}

export function addGroupMember(token: string, groupId: string, input: { userId: string }, idempotencyKey = newIdempotencyKey()) {
  return apiRequest<GroupMember>(`/groups/${groupId}/members`, {
    method: "POST",
    token,
    body: input,
    idempotencyKey,
  });
}

export function removeGroupMember(token: string, groupId: string, userId: string) {
  return apiRequest(`/groups/${groupId}/members/${userId}`, {
    method: "DELETE",
    token,
  });
}
