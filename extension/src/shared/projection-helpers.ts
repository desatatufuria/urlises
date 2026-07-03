import type { FolderNode, ProjectionState, TreeResponse } from "./types.js";

export function collectBackendIds(tree: TreeResponse): Set<string> {
  const ids = new Set<string>();
  const visitFolder = (folder: FolderNode): void => {
    ids.add(folder.id);
    for (const bookmark of folder.bookmarks) {
      ids.add(bookmark.id);
    }
    for (const child of folder.folders) {
      visitFolder(child);
    }
  };

  for (const folder of tree.folders) {
    visitFolder(folder);
  }

  return ids;
}

export function filterFoldersForProjection(
  folders: FolderNode[],
  projection: Pick<ProjectionState, "excludedBackendNodeIds">,
): FolderNode[] {
  const excludedIds = new Set(projection.excludedBackendNodeIds);
  const visitFolders = (nodes: FolderNode[]): FolderNode[] => nodes
    .filter((folder) => !excludedIds.has(folder.id))
    .map((folder) => ({
      ...folder,
      bookmarks: folder.bookmarks.filter((bookmark) => !excludedIds.has(bookmark.id)),
      folders: visitFolders(folder.folders),
    }));

  return visitFolders(folders);
}

export function collectBackendIdsByChromeIds(
  projection: Pick<ProjectionState, "backendIdByChromeId">,
  chromeIds: Iterable<string>,
): string[] {
  const backendIds = new Set<string>();
  for (const chromeId of chromeIds) {
    const backendId = projection.backendIdByChromeId[chromeId];
    if (backendId) {
      backendIds.add(backendId);
    }
  }
  return [...backendIds];
}

export function findReusableFolderNode(
  children: chrome.bookmarks.BookmarkTreeNode[],
  title: string,
): chrome.bookmarks.BookmarkTreeNode | null {
  const matches = children.filter((child) => !child.url && child.title === title);
  return matches.length === 1 ? matches[0] : null;
}

export function findReusableBookmarkNode(
  children: chrome.bookmarks.BookmarkTreeNode[],
  title: string,
  url: string,
): chrome.bookmarks.BookmarkTreeNode | null {
  const matches = children.filter((child) => child.url === url && child.title === title);
  return matches.length === 1 ? matches[0] : null;
}
