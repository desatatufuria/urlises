import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/api/queryKeys";
import { grantGroupWorkspaceAccess, grantUserWorkspaceAccess, revokeGroupWorkspaceAccess, revokeUserWorkspaceAccess } from "../../lib/api/workspaces";
import type { WorkspaceRole } from "../../lib/api/types";

export function useGrantUserWorkspaceAccessMutation(token?: string, workspaceId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { userId: string; role: WorkspaceRole }) => grantUserWorkspaceAccess(token!, workspaceId!, input.userId, input.role),
    onSuccess: async () => {
      if (!workspaceId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId).access }), queryClient.invalidateQueries({ queryKey: ["organizations"] })]);
    },
  });
}

export function useRevokeUserWorkspaceAccessMutation(token?: string, workspaceId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) => revokeUserWorkspaceAccess(token!, workspaceId!, userId),
    onSuccess: async () => {
      if (!workspaceId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId).access }), queryClient.invalidateQueries({ queryKey: ["organizations"] })]);
    },
  });
}

export function useGrantGroupWorkspaceAccessMutation(token?: string, workspaceId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { groupId: string; role: WorkspaceRole }) => grantGroupWorkspaceAccess(token!, workspaceId!, input.groupId, input.role),
    onSuccess: async () => {
      if (!workspaceId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId).access }), queryClient.invalidateQueries({ queryKey: ["organizations"] })]);
    },
  });
}

export function useRevokeGroupWorkspaceAccessMutation(token?: string, workspaceId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (groupId: string) => revokeGroupWorkspaceAccess(token!, workspaceId!, groupId),
    onSuccess: async () => {
      if (!workspaceId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId).access }), queryClient.invalidateQueries({ queryKey: ["organizations"] })]);
    },
  });
}
