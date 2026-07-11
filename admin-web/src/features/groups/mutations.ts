import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addGroupMember, createGroup, deleteGroup, removeGroupMember, updateGroup } from "../../lib/api/groups";
import { queryKeys } from "../../lib/api/queryKeys";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";

export function useCreateGroupMutation(token?: string, organizationId?: string) {
  const queryClient = useQueryClient();
	const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (input: { name: string }) => createGroup(token!, organizationId!, input, retry.keyFor(input)),
		onError: (error, input) => retry.retainAfterFailure(input, error),
	    onSuccess: async (_result, input) => {
			retry.confirm(input);
      if (!organizationId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId).groups }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
    },
  });
}

export function useUpdateGroupMutation(token?: string, organizationId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { groupId: string; name: string }) => updateGroup(token!, organizationId!, input.groupId, { name: input.name }),
    onSuccess: async () => {
      if (!organizationId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId).groups }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
    },
  });
}

export function useDeleteGroupMutation(token?: string, organizationId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (groupId: string) => deleteGroup(token!, organizationId!, groupId),
    onSuccess: async () => {
      if (!organizationId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId).groups }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
    },
  });
}

export function useAddGroupMemberMutation(token?: string, groupId?: string) {
  const queryClient = useQueryClient();
	const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (input: { userId: string }) => addGroupMember(token!, groupId!, input, retry.keyFor(input)),
    onError: (error, input) => retry.retainAfterFailure(input, error),
    onSuccess: async (_result, input) => {
			retry.confirm(input);
      if (!groupId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId).members }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
    },
  });
}

export function useRemoveGroupMemberMutation(token?: string, groupId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) => removeGroupMember(token!, groupId!, userId),
    onSuccess: async () => {
      if (!groupId) {
        return;
      }

      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.group(groupId).members }), queryClient.invalidateQueries({ queryKey: ["workspaces"] })]);
    },
  });
}
