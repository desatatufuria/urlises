import { useQuery } from "@tanstack/react-query";
import { listOrganizationInvitations, listOrganizationMembers } from "../../lib/api/organizations";
import { queryKeys } from "../../lib/api/queryKeys";

export function useOrganizationMembers(token?: string, organizationId?: string) {
  return useQuery({
    queryKey: organizationId ? queryKeys.organization(organizationId).members : ["organizations", "missing", "members"],
    queryFn: () => listOrganizationMembers(token!, organizationId!),
    enabled: Boolean(token && organizationId),
  });
}

export function useOrganizationInvitations(token?: string, organizationId?: string) {
  return useQuery({
    queryKey: organizationId ? queryKeys.organization(organizationId).invitations : ["organizations", "missing", "invitations"],
    queryFn: () => listOrganizationInvitations(token!, organizationId!),
    enabled: Boolean(token && organizationId),
  });
}
