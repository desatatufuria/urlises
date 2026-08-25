export const queryKeys = {
  auth: {
    me: ["auth", "me"] as const,
    organizations: ["organizations"] as const,
  },
  // trash is requester-scoped, not active-organization-scoped: both Trash
  // lists (GET /organizations/deleted, GET /workspaces/deleted) span every
  // organization the requester owns/admins, so this key group stays
  // top-level rather than nested under queryKeys.organization(id).
  trash: {
    organizations: ["trash", "organizations"] as const,
    workspaces: ["trash", "workspaces"] as const,
  },
  organization: (organizationId: string) => ({
    members: ["organizations", organizationId, "members"] as const,
    invitations: ["organizations", organizationId, "invitations"] as const,
    groups: ["organizations", organizationId, "groups"] as const,
    workspaces: ["organizations", organizationId, "workspaces"] as const,
    activity: ["organizations", organizationId, "activity"] as const,
  }),
  group: (groupId: string) => ({
    members: ["groups", groupId, "members"] as const,
  }),
  workspace: (workspaceId: string) => ({
    access: ["workspaces", workspaceId, "access"] as const,
    tree: ["workspaces", workspaceId, "tree"] as const,
  }),
};
