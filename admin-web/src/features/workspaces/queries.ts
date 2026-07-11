import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../lib/api/queryKeys";
import { listWorkspaces } from "../../lib/api/workspaces";

export function useWorkspaces(token?: string, organizationId?: string) {
  return useQuery({
    queryKey: organizationId ? queryKeys.organization(organizationId).workspaces : ["organizations", "missing", "workspaces"],
    queryFn: () => listWorkspaces(token!, organizationId!),
    enabled: Boolean(token && organizationId),
  });
}
