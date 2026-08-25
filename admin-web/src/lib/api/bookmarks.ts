import { apiRequest } from "./client";
import type { WorkspaceSummary } from "./types";

export interface BookmarkNode {
  id: string;
  folderId: string;
  title: string;
  url: string;
  position: number;
}

export interface FolderNode {
  id: string;
  // omitempty server-side (workspaces/service.go:107) — a ROOT folder omits
  // the key entirely. Every consumer normalizes with `node.parentId ?? null`.
  parentId?: string;
  name: string;
  position: number;
  folders: FolderNode[];
  bookmarks: BookmarkNode[];
}

// The tree endpoint's `workspace` field is the backend's WorkspaceAccess
// struct (workspaces/service.go:36), the same wire shape admin-web already
// models as WorkspaceSummary for the workspace list — reused rather than
// re-declared as a separate WorkspaceAccessSummary type.
export interface WorkspaceTree {
  workspace: WorkspaceSummary;
  folders: FolderNode[];
}

export interface FolderResource {
  id: string;
  workspaceId: string;
  parentId?: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkResource {
  id: string;
  workspaceId: string;
  folderId: string;
  title: string;
  url: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export function getWorkspaceTree(token: string, workspaceId: string) {
  return apiRequest<WorkspaceTree>(`/workspaces/${workspaceId}/tree`, { token });
}

export interface CreateFolderInput {
  parentId: string | null;
  name: string;
}

// syncEventId is REQUIRED on every mutation (Decision 2): a default would
// restore the exact failure this change exists to fix — POST/DELETE
// silently minting a random event id and losing retry protection.
export function createFolder(token: string, workspaceId: string, input: CreateFolderInput, syncEventId: string) {
  return apiRequest<FolderResource>(`/workspaces/${workspaceId}/folders`, {
    method: "POST",
    token,
    // Built key-by-key, never spread: parentId is presence-detecting on the
    // backend (OptionalString) — an explicit `null` means "workspace root",
    // never "omit". JSON.stringify drops undefined keys.
    body: { parentId: input.parentId, name: input.name },
    syncEventId,
  });
}

export interface UpdateFolderInput {
  name?: string;
  parentId?: string | null;
  position?: number;
}

export function updateFolder(token: string, folderId: string, input: UpdateFolderInput, syncEventId: string) {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.parentId !== undefined) body.parentId = input.parentId;
  if (input.position !== undefined) body.position = input.position;

  return apiRequest<FolderResource>(`/folders/${folderId}`, {
    method: "PATCH",
    token,
    body,
    syncEventId,
  });
}

export function deleteFolder(token: string, folderId: string, syncEventId: string) {
  return apiRequest<void>(`/folders/${folderId}`, {
    method: "DELETE",
    token,
    syncEventId,
  });
}

export interface CreateBookmarkInput {
  folderId: string;
  title: string;
  url: string;
}

export function createBookmark(token: string, workspaceId: string, input: CreateBookmarkInput, syncEventId: string) {
  return apiRequest<BookmarkResource>(`/workspaces/${workspaceId}/bookmarks`, {
    method: "POST",
    token,
    body: { folderId: input.folderId, title: input.title, url: input.url },
    syncEventId,
  });
}

export interface UpdateBookmarkInput {
  folderId?: string;
  title?: string;
  url?: string;
  position?: number;
}

export function updateBookmark(token: string, bookmarkId: string, input: UpdateBookmarkInput, syncEventId: string) {
  const body: Record<string, unknown> = {};
  if (input.folderId !== undefined) body.folderId = input.folderId;
  if (input.title !== undefined) body.title = input.title;
  if (input.url !== undefined) body.url = input.url;
  if (input.position !== undefined) body.position = input.position;

  return apiRequest<BookmarkResource>(`/bookmarks/${bookmarkId}`, {
    method: "PATCH",
    token,
    body,
    syncEventId,
  });
}

export function deleteBookmark(token: string, bookmarkId: string, syncEventId: string) {
  return apiRequest<void>(`/bookmarks/${bookmarkId}`, {
    method: "DELETE",
    token,
    syncEventId,
  });
}
