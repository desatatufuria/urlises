import { ROOT_FOLDER_TITLE } from "../shared/runtime.js";

const LEGACY_ROOT_FOLDER_TITLE = "Shared Bookmarks";

export async function getNode(id: string): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  return new Promise((resolve) => {
    chrome.bookmarks.get(id, (nodes) => {
      const error = chrome.runtime.lastError;
      if (error || !nodes?.length) {
        resolve(null);
        return;
      }
      resolve(nodes[0]);
    });
  });
}

export async function getChildren(id: string): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getChildren(id, (nodes) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(nodes);
    });
  });
}

export async function getSubTree(id: string): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  return new Promise((resolve) => {
    chrome.bookmarks.getSubTree(id, (nodes) => {
      const error = chrome.runtime.lastError;
      if (error || !nodes?.length) {
        resolve(null);
        return;
      }
      resolve(nodes[0]);
    });
  });
}

export async function createFolder(parentId: string, title: string, index?: number): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create({ parentId, title, index }, (node) => {
      const error = chrome.runtime.lastError;
      if (error || !node) {
        reject(new Error(error?.message ?? "failed to create folder"));
        return;
      }
      resolve(node);
    });
  });
}

export async function createBookmark(parentId: string, title: string, url: string, index?: number): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create({ parentId, title, url, index }, (node) => {
      const error = chrome.runtime.lastError;
      if (error || !node) {
        reject(new Error(error?.message ?? "failed to create bookmark"));
        return;
      }
      resolve(node);
    });
  });
}

export async function updateNode(id: string, changes: chrome.bookmarks.UpdateChanges): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.update(id, changes, (node) => {
      const error = chrome.runtime.lastError;
      if (error || !node) {
        reject(new Error(error?.message ?? "failed to update bookmark node"));
        return;
      }
      resolve(node);
    });
  });
}

/**
 * Chromium's BookmarkModel::Move reads `destination.index` in the parent's *pre-removal*
 * coordinate space. For a same-parent move it silently no-ops when the index equals
 * `oldIndex` or `oldIndex + 1`, and decrements any index greater than `oldIndex`. Translating a
 * desired *final* index into that space means adding 1 to same-parent forward moves and leaving
 * every other case alone. Cross-parent and backward moves already coincide in both spaces.
 */
export function chromeMoveIndex(move: { oldParentId: string; oldIndex: number; parentId: string; index: number }): number {
  return move.parentId === move.oldParentId && move.index > move.oldIndex ? move.index + 1 : move.index;
}

export async function moveNode(id: string, destination: { parentId?: string; index?: number }): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(id, destination, (node) => {
      const error = chrome.runtime.lastError;
      if (error || !node) {
        reject(new Error(error?.message ?? "failed to move bookmark node"));
        return;
      }
      resolve(node);
    });
  });
}

export async function removeNode(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.remove(id, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

export async function removeTree(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.removeTree(id, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

export async function ensureManagedPath(organizationName: string, workspaceName: string): Promise<{ rootId: string; organizationId: string; workspaceId: string }> {
  const containerId = await getDefaultContainerId();
  const root = await ensureManagedRoot(containerId);
  const organization = await ensureFolderByTitle(root.id, organizationName);
  const workspace = await ensureFolderByTitle(organization.id, workspaceName);
  return { rootId: root.id, organizationId: organization.id, workspaceId: workspace.id };
}

export async function clearChildren(folderId: string, excludeIds: string[] = []): Promise<string[]> {
  const children = await getChildren(folderId);
  const removedIds: string[] = [];
  for (const child of children) {
    if (excludeIds.includes(child.id)) {
      continue;
    }
    const subtree = await getSubTree(child.id);
    if (subtree) {
      removedIds.push(...collectChromeIds(subtree));
    }
    if (child.url) {
      await removeNode(child.id);
    } else {
      await removeTree(child.id);
    }
  }
  return removedIds;
}

export function collectChromeIds(node: chrome.bookmarks.BookmarkTreeNode): string[] {
  const ids = [node.id];
  for (const child of node.children ?? []) {
    ids.push(...collectChromeIds(child));
  }
  return ids;
}

async function ensureFolderByTitle(parentId: string, title: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const children = await getChildren(parentId);
  const existing = children.find((child) => !child.url && child.title === title);
  if (existing) {
    return existing;
  }
  return createFolder(parentId, title);
}

async function ensureManagedRoot(containerId: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const children = await getChildren(containerId);
  const currentRoot = children.find((child) => !child.url && child.title === ROOT_FOLDER_TITLE);
  if (currentRoot) {
    return currentRoot;
  }

  const legacyRoot = children.find((child) => !child.url && child.title === LEGACY_ROOT_FOLDER_TITLE);
  if (legacyRoot) {
    return updateNode(legacyRoot.id, { title: ROOT_FOLDER_TITLE });
  }

  return createFolder(containerId, ROOT_FOLDER_TITLE);
}

async function getDefaultContainerId(): Promise<string> {
  const tree = await new Promise<chrome.bookmarks.BookmarkTreeNode[]>((resolve, reject) => {
    chrome.bookmarks.getTree((nodes) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(nodes);
    });
  });

  const root = tree[0];
  const preferred = root.children?.find((node) => /other/i.test(node.title));
  return preferred?.id ?? root.children?.[0]?.id ?? root.id;
}
