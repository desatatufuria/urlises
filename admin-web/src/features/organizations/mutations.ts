import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../app/providers/AuthProvider";
import { deleteOrganization } from "../../lib/api/organizations";

// Mirrors useRemoveMemberMutation/useUpdateMemberRoleMutation's self-removal
// sign-out branch (features/members/mutations.ts): refreshOrganizations()
// returns the freshly fetched list so the branch can act on it in the same
// tick, rather than reading stale query-cache state.
export function useDeleteOrganizationMutation(token?: string, organizationId?: string) {
  const { refreshOrganizations, signOut } = useAuth();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: () => deleteOrganization(token!, organizationId!),
    onSuccess: async () => {
      const remaining = await refreshOrganizations();
      if (remaining.length === 0) {
        await signOut();
        return;
      }
      navigate("/");
    },
  });
}
