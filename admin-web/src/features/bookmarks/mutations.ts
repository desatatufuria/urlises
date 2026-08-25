import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createBookmark,
  createFolder,
  deleteBookmark,
  deleteFolder,
  updateBookmark,
  updateFolder,
  type CreateBookmarkInput,
  type CreateFolderInput,
  type UpdateBookmarkInput,
  type UpdateFolderInput,
} from "../../lib/api/bookmarks";
import { queryKeys } from "../../lib/api/queryKeys";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";

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
