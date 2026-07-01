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
