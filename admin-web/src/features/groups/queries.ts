import { useQuery } from "@tanstack/react-query";
import { listGroupMembers, listGroups } from "../../lib/api/groups";
import { queryKeys } from "../../lib/api/queryKeys";

export function useGroups(token?: string, organizationId?: string) {
  return useQuery({
    queryKey: organizationId ? queryKeys.organization(organizationId).groups : ["organizations", "missing", "groups"],
    queryFn: () => listGroups(token!, organizationId!),
    enabled: Boolean(token && organizationId),
  });
}

export function useGroupMembers(token?: string, groupId?: string) {
  return useQuery({
    queryKey: groupId ? queryKeys.group(groupId).members : ["groups", "missing", "members"],
    queryFn: () => listGroupMembers(token!, groupId!),
    enabled: Boolean(token && groupId),
  });
}
