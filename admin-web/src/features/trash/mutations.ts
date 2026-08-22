import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../app/providers/AuthProvider";
import { queryKeys } from "../../lib/api/queryKeys";
import { restoreOrganization } from "../../lib/api/organizations";
import { restoreWorkspace } from "../../lib/api/workspaces";

// Restoring an organization must make it reappear in the org switcher
// immediately, not just in the Trash list -- so this invalidates
// auth.organizations AND calls refreshOrganizations() (design.md's Frontend
// API clients section), mirroring how useDeleteOrganizationMutation already
// depends on the same AuthProvider method for the inverse transition.
export function useRestoreOrganizationMutation(token?: string) {
  const queryClient = useQueryClient();
  const { refreshOrganizations } = useAuth();

  return useMutation({
    mutationFn: (organizationId: string) => restoreOrganization(token!, organizationId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.trash.organizations }),
        queryClient.invalidateQueries({ queryKey: queryKeys.auth.organizations }),
      ]);
      await refreshOrganizations();
    },
  });
}

// Mirrors useDeleteWorkspaceMutation's invalidation set (organization(id).workspaces
// + the standalone ["workspaces"] key), plus trash.workspaces for this list.
// organizationId travels with the mutation input rather than as a hook
// argument because a Trash row's workspace can belong to any organization
// the requester administers, not just the currently active one.
export function useRestoreWorkspaceMutation(token?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { workspaceId: string; organizationId: string }) => restoreWorkspace(token!, input.workspaceId),
    onSuccess: async (_result, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.trash.workspaces }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organization(input.organizationId).workspaces }),
        queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
      ]);
    },
  });
}
