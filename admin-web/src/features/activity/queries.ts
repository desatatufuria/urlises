import { useInfiniteQuery } from "@tanstack/react-query";
import { listOrgActivity } from "../../lib/api/activity";
import { queryKeys } from "../../lib/api/queryKeys";

// useOrgActivity drives ActivityPage's "load more" pagination via
// useInfiniteQuery -- the feed is an append-only, newest-first list where
// "load more" is the natural interaction, and TanStack Query's cursor-as-
// pageParam bookkeeping (dedup, per-page cache keys) replaces what a
// hand-rolled cursor-in-useState + manual refetch would otherwise
// reimplement. cursor "" means "no next page" (matches the backend's
// nextCursor contract), so getNextPageParam returns undefined in that case.
export function useOrgActivity(organizationId?: string, token?: string) {
  return useInfiniteQuery({
    queryKey: organizationId ? queryKeys.organization(organizationId).activity : (["organizations", "missing", "activity"] as const),
    queryFn: ({ pageParam }) => listOrgActivity(organizationId!, token!, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (lastPage) => (lastPage.nextCursor ? lastPage.nextCursor : undefined),
    enabled: Boolean(token && organizationId),
  });
}
