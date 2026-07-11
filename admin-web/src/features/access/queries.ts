import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../lib/api/queryKeys";
import { getWorkspaceAccess } from "../../lib/api/workspaces";

export function useWorkspaceAccess(token?: string, workspaceId?: string) {
  return useQuery({
    queryKey: workspaceId ? queryKeys.workspace(workspaceId).access : ["workspaces", "missing", "access"],
    queryFn: () => getWorkspaceAccess(token!, workspaceId!),
    enabled: Boolean(token && workspaceId),
  });
}
