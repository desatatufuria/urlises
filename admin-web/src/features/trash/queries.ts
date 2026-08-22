import { useQuery } from "@tanstack/react-query";
import { listDeletedOrganizations } from "../../lib/api/organizations";
import { listDeletedWorkspaces } from "../../lib/api/workspaces";
import { queryKeys } from "../../lib/api/queryKeys";

// Both Trash lists are requester-scoped (see queryKeys.trash's comment), so
// neither query needs an organizationId argument -- authorization is inline
// in the backend query, not derived from the active organization.
export function useDeletedOrganizations(token?: string) {
  return useQuery({
    queryKey: queryKeys.trash.organizations,
    queryFn: () => listDeletedOrganizations(token!),
    enabled: Boolean(token),
  });
}

export function useDeletedWorkspaces(token?: string) {
  return useQuery({
    queryKey: queryKeys.trash.workspaces,
    queryFn: () => listDeletedWorkspaces(token!),
    enabled: Boolean(token),
  });
}
