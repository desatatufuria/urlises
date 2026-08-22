export type OrganizationRole = "owner" | "admin" | "member";
export type WorkspaceRole = "admin" | "editor" | "viewer";

export interface AdminUser {
  id: string;
  email: string;
  name?: string;
}

export interface AdminSession {
  accessToken: string;
  expiresAt: string;
  clientId: string;
  user: AdminUser;
}

export interface AdminPrincipal {
  userId: string;
  email: string;
  name?: string;
  clientId: string;
}

export interface LoginPayload {
  email: string;
  password: string;
  deviceName?: string;
}

export interface RegistrationPayload extends LoginPayload {
  name: string;
  invitationToken?: string;
}

export interface OrganizationMembership {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

export interface OrganizationMember {
  userId: string;
  email: string;
  name?: string;
  role: OrganizationRole;
}

export interface SecretBlob {
  ciphertext: string;
  iv: string;
  wrappedContentKey: string | null;
  passphraseSalt: string | null;
  kdfIterations: number | null;
}

export interface AcceptedInvitation {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

export interface PendingInvitation {
  invitationId: string;
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

export interface GroupSummary {
  groupId: string;
  organizationId: string;
  name: string;
  memberCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface GroupMember {
  userId: string;
  email: string;
  name?: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceType: string;
  organizationId: string;
  organizationName: string;
  role: WorkspaceRole;
  sources?: string[];
}

export interface WorkspaceUserGrant {
  userId: string;
  email: string;
  role: WorkspaceRole;
}

export interface WorkspaceGroupGrant {
  groupId: string;
  groupName: string;
  role: WorkspaceRole;
}

export interface EffectiveWorkspaceUserAccess {
  userId: string;
  email: string;
  role: WorkspaceRole;
  sources: string[];
}

export interface WorkspaceAccessSnapshot {
  workspace: WorkspaceSummary;
  userGrants: WorkspaceUserGrant[];
  groupGrants: WorkspaceGroupGrant[];
  effectiveAccess: EffectiveWorkspaceUserAccess[];
}

// DeletedOrganization mirrors backend/internal/organizations/service.go's
// DeletedOrganization struct JSON tags verbatim (checked, not guessed).
// deletedByEmail is omitempty on the wire, so it is absent (undefined) or
// null depending on how deleted_by_user_id resolved -- callers must treat
// both the same way.
export interface DeletedOrganization {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
  deletedAt: string;
  deletedByEmail?: string | null;
  purgeAt: string;
}

// DeletedWorkspace mirrors backend/internal/workspaces/service.go's
// DeletedWorkspace struct JSON tags verbatim.
export interface DeletedWorkspace {
  workspaceId: string;
  workspaceName: string;
  workspaceType: string;
  organizationId: string;
  organizationName: string;
  deletedAt: string;
  deletedByEmail?: string | null;
  purgeAt: string;
}
