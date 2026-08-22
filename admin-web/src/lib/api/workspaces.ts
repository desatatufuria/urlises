import { apiRequest, newIdempotencyKey } from "./client";
import type { DeletedWorkspace, WorkspaceAccessSnapshot, WorkspaceSummary, WorkspaceRole } from "./types";

export async function listWorkspaces(token: string, organizationId: string) {
  const response = await apiRequest<{ workspaces: WorkspaceSummary[] }>(`/organizations/${organizationId}/workspaces`, { token });
  return response.workspaces;
}

export function createWorkspace(token: string, organizationId: string, input: { name: string; type: string }, idempotencyKey = newIdempotencyKey()) {
  return apiRequest<WorkspaceSummary>(`/organizations/${organizationId}/workspaces`, {
    method: "POST",
    token,
    body: input,
    idempotencyKey,
  });
}

export function getWorkspaceAccess(token: string, workspaceId: string) {
  return apiRequest<WorkspaceAccessSnapshot>(`/workspaces/${workspaceId}/access`, { token });
}

export function grantUserWorkspaceAccess(token: string, workspaceId: string, userId: string, role: WorkspaceRole) {
  return apiRequest(`/workspaces/${workspaceId}/users/${userId}/access`, {
    method: "PUT",
    token,
    body: { role },
  });
}

export function revokeUserWorkspaceAccess(token: string, workspaceId: string, userId: string) {
  return apiRequest(`/workspaces/${workspaceId}/users/${userId}/access`, {
    method: "DELETE",
    token,
  });
}

export function grantGroupWorkspaceAccess(token: string, workspaceId: string, groupId: string, role: WorkspaceRole) {
  return apiRequest(`/workspaces/${workspaceId}/groups/${groupId}/access`, {
    method: "PUT",
    token,
    body: { role },
  });
}

export function revokeGroupWorkspaceAccess(token: string, workspaceId: string, groupId: string) {
  return apiRequest(`/workspaces/${workspaceId}/groups/${groupId}/access`, {
    method: "DELETE",
    token,
  });
}

export function deleteWorkspace(token: string, workspaceId: string) {
  return apiRequest(`/workspaces/${workspaceId}`, {
    method: "DELETE",
    token,
  });
}

export function restoreWorkspace(token: string, workspaceId: string) {
  return apiRequest<void>(`/workspaces/${workspaceId}/restore`, {
    method: "POST",
    token,
  });
}

export async function listDeletedWorkspaces(token: string) {
  const response = await apiRequest<{ workspaces: DeletedWorkspace[] }>("/workspaces/deleted", { token });
  return response.workspaces;
}
