export const queryKeys = {
  auth: {
    me: ["auth", "me"] as const,
    organizations: ["organizations"] as const,
  },
  organization: (organizationId: string) => ({
    members: ["organizations", organizationId, "members"] as const,
    invitations: ["organizations", organizationId, "invitations"] as const,
    groups: ["organizations", organizationId, "groups"] as const,
    workspaces: ["organizations", organizationId, "workspaces"] as const,
  }),
  group: (groupId: string) => ({
    members: ["groups", groupId, "members"] as const,
  }),
  workspace: (workspaceId: string) => ({
    access: ["workspaces", workspaceId, "access"] as const,
  }),
};
