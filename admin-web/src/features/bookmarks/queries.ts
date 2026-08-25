import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../lib/api/client";
import { getWorkspaceTree } from "../../lib/api/bookmarks";
import { queryKeys } from "../../lib/api/queryKeys";

export function useWorkspaceTree(token?: string, workspaceId?: string) {
  return useQuery({
    queryKey: workspaceId ? queryKeys.workspace(workspaceId).tree : ["workspaces", "missing", "tree"],
    queryFn: () => getWorkspaceTree(token!, workspaceId!),
    enabled: Boolean(token && workspaceId),
    // Both overrides are required. main.tsx sets a global staleTime of 30s
    // and refetchOnWindowFocus:false; React Query only refetches on focus
    // when the query is STALE, so refetchOnWindowFocus alone would be a
    // silent no-op within 30s of the last fetch.
    staleTime: 0,
    refetchOnWindowFocus: true,
    // 403 = no grant, 404 = no such workspace. Both are terminal answers,
    // not transient failures; the global retry:1 would double the latency
    // to the self-grant call to action.
    retry: (failureCount, error) => !(error instanceof ApiError && (error.status === 403 || error.status === 404)) && failureCount < 1,
  });
}
