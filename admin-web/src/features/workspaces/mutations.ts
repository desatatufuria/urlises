import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/api/queryKeys";
import { createWorkspace } from "../../lib/api/workspaces";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";

export function useCreateWorkspaceMutation(token?: string, organizationId?: string) {
  const queryClient = useQueryClient();
	const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (input: { name: string; type: string }) => createWorkspace(token!, organizationId!, input, retry.keyFor(input)),
    onError: (error, input) => retry.retainAfterFailure(input, error),
    onSuccess: async (_result, input) => {
		retry.confirm(input);
      if (!organizationId) {
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId).workspaces });
    },
  });
}
