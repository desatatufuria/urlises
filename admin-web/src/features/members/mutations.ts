import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createOrganizationInvitation, patchOrganizationMember, resendOrganizationInvitation } from "../../lib/api/organizations";
import { queryKeys } from "../../lib/api/queryKeys";
import type { OrganizationRole } from "../../lib/api/types";
import { useAuth } from "../../app/providers/AuthProvider";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";

export function useInviteMemberMutation(token?: string, organizationId?: string) {
  const queryClient = useQueryClient();
	const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (input: { email: string; role: OrganizationRole }) => createOrganizationInvitation(token!, organizationId!, input, retry.keyFor(input)),
    onError: (error, input) => retry.retainAfterFailure(input, error),
    onSuccess: async (_result, input) => {
		retry.confirm(input);
      if (!organizationId) {
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId).invitations });
    },
  });
}

export function useResendInvitationMutation(token?: string, organizationId?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { invitationId: string }) => resendOrganizationInvitation(token!, organizationId!, input.invitationId),
    onSuccess: async () => {
      if (!organizationId) {
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId).invitations });
    },
  });
}

export function useUpdateMemberRoleMutation(token?: string, organizationId?: string) {
	const queryClient = useQueryClient();
	const { session, refreshOrganizations, signOut } = useAuth();

  return useMutation({
    mutationFn: (input: { userId: string; role: OrganizationRole }) => patchOrganizationMember(token!, organizationId!, input),
	onSuccess: async (_member, input) => {
      if (!organizationId) {
        return;
      }

		await queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId).members });
		if (input.userId === session?.user.id) {
			await refreshOrganizations();
			const remaining = queryClient.getQueryData<{ role: string }[]>(queryKeys.auth.organizations) ?? [];
			if (remaining.length === 0) await signOut();
		}
    },
  });
}
