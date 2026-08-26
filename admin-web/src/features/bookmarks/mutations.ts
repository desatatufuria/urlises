import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createBookmark,
  createFolder,
  deleteBookmark,
  deleteFolder,
  updateBookmark,
  updateFolder,
  type BookmarkResource,
  type CreateBookmarkInput,
  type CreateFolderInput,
  type FolderResource,
  type UpdateBookmarkInput,
  type UpdateFolderInput,
} from "../../lib/api/bookmarks";
import { queryKeys } from "../../lib/api/queryKeys";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";
import type { MovePlan } from "../../lib/bookmarks/treeModel";

// design.md "Refetch": no optimistic tree state anywhere — every mutation's
// onSettled invalidates the tree query, so the rendered order always comes
// from the server's recomputed positions, even for a rejected mutation.
function useInvalidateTree(workspaceId?: string) {
  const queryClient = useQueryClient();
  return () => {
    if (!workspaceId) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId).tree });
  };
}

export function useCreateFolderMutation(token?: string, workspaceId?: string) {
  const invalidateTree = useInvalidateTree(workspaceId);
  const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (input: CreateFolderInput) => createFolder(token!, workspaceId!, input, retry.keyFor(input)),
    onError: (error, input) => retry.retainAfterFailure(input, error),
    onSuccess: (_result, input) => retry.confirm(input),
    onSettled: () => invalidateTree(),
  });
}

export function useUpdateFolderMutation(token?: string, workspaceId?: string) {
  const invalidateTree = useInvalidateTree(workspaceId);
  const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (variables: { folderId: string; input: UpdateFolderInput }) =>
      updateFolder(token!, variables.folderId, variables.input, retry.keyFor(variables)),
    onError: (error, variables) => retry.retainAfterFailure(variables, error),
    onSuccess: (_result, variables) => retry.confirm(variables),
    onSettled: () => invalidateTree(),
  });
}

export function useDeleteFolderMutation(token?: string, workspaceId?: string) {
  const invalidateTree = useInvalidateTree(workspaceId);
  const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (folderId: string) => deleteFolder(token!, folderId, retry.keyFor({ delete: folderId })),
    onError: (error, folderId) => retry.retainAfterFailure({ delete: folderId }, error),
    onSuccess: (_result, folderId) => retry.confirm({ delete: folderId }),
    onSettled: () => invalidateTree(),
  });
}

export function useCreateBookmarkMutation(token?: string, workspaceId?: string) {
  const invalidateTree = useInvalidateTree(workspaceId);
  const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (input: CreateBookmarkInput) => createBookmark(token!, workspaceId!, input, retry.keyFor(input)),
    onError: (error, input) => retry.retainAfterFailure(input, error),
    onSuccess: (_result, input) => retry.confirm(input),
    onSettled: () => invalidateTree(),
  });
}

export function useUpdateBookmarkMutation(token?: string, workspaceId?: string) {
  const invalidateTree = useInvalidateTree(workspaceId);
  const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (variables: { bookmarkId: string; input: UpdateBookmarkInput }) =>
      updateBookmark(token!, variables.bookmarkId, variables.input, retry.keyFor(variables)),
    onError: (error, variables) => retry.retainAfterFailure(variables, error),
    onSuccess: (_result, variables) => retry.confirm(variables),
    onSettled: () => invalidateTree(),
  });
}

export function useDeleteBookmarkMutation(token?: string, workspaceId?: string) {
  const invalidateTree = useInvalidateTree(workspaceId);
  const retry = useUncertainCreationKey();

  return useMutation({
    mutationFn: (bookmarkId: string) => deleteBookmark(token!, bookmarkId, retry.keyFor({ delete: bookmarkId })),
    onError: (error, bookmarkId) => retry.retainAfterFailure({ delete: bookmarkId }, error),
    onSuccess: (_result, bookmarkId) => retry.confirm({ delete: bookmarkId }),
    onSettled: () => invalidateTree(),
  });
}

// Both the pointer drag path (onDragEnd) and the keyboard Alt+Arrow path
// (planKeyboardMove) build a MovePlan via the same pure treeModel.ts
// planner and funnel into this single mutation (design.md Decision 9).
export function useMoveNodeMutation(token?: string, workspaceId?: string) {
  const invalidateTree = useInvalidateTree(workspaceId);
  const retry = useUncertainCreationKey();

  return useMutation<FolderResource | BookmarkResource, Error, Extract<MovePlan, { kind: "move" }>>({
    mutationFn: (plan) =>
      plan.type === "folder"
        ? updateFolder(token!, plan.id, { ...(plan.parentChanged ? { parentId: plan.parentFolderId } : {}), position: plan.position }, retry.keyFor(plan))
        : updateBookmark(token!, plan.id, { ...(plan.parentChanged ? { folderId: plan.parentFolderId! } : {}), position: plan.position }, retry.keyFor(plan)),
    onError: (error, plan) => retry.retainAfterFailure(plan, error),
    onSuccess: (_result, plan) => retry.confirm(plan),
    // onSettled, not onSuccess: a REJECTED move (cycle guard, stale
    // position) must also resync the displayed order, or the UI keeps
    // showing a state the server never accepted.
    onSettled: () => invalidateTree(),
  });
}
