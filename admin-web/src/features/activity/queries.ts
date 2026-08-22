import { useInfiniteQuery } from "@tanstack/react-query";
import type { ActivityCategory } from "../../lib/api/activity";
import { listOrgActivity } from "../../lib/api/activity";
import { queryKeys } from "../../lib/api/queryKeys";

// useOrgActivity drives ActivityPage's "load more" pagination via
// useInfiniteQuery -- the feed is an append-only, newest-first list where
// "load more" is the natural interaction, and TanStack Query's cursor-as-
// pageParam bookkeeping (dedup, per-page cache keys) replaces what a
// hand-rolled cursor-in-useState + manual refetch would otherwise
// reimplement. cursor "" means "no next page" (matches the backend's
// nextCursor contract), so getNextPageParam returns undefined in that case.
// category is appended to the query key (not a new queryKeys entry) so each
// category is a distinct cached infinite query -- cursors from one category
// never page into another, and prefix-based invalidation of the base
// `activity` key still matches every category.
export function useOrgActivity(organizationId?: string, token?: string, category: ActivityCategory = "all") {
  return useInfiniteQuery({
    queryKey: organizationId
      ? [...queryKeys.organization(organizationId).activity, category]
      : ([...(["organizations", "missing", "activity"] as const), category] as const),
    queryFn: ({ pageParam }) => listOrgActivity(organizationId!, token!, pageParam || undefined, category),
    initialPageParam: "",
    getNextPageParam: (lastPage) => (lastPage.nextCursor ? lastPage.nextCursor : undefined),
    enabled: Boolean(token && organizationId),
  });
}
