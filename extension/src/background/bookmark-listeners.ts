export interface BookmarkChangeInfo {
  title?: string;
  url?: string;
}

export interface BookmarkMoveInfo {
  parentId: string;
  oldParentId: string;
  index: number;
  oldIndex: number;
}

export interface BookmarkRemoveInfo {
  parentId: string;
  index: number;
  node?: chrome.bookmarks.BookmarkTreeNode;
}

export interface BookmarkListenerHandlers {
  onCreated: (id: string, node: chrome.bookmarks.BookmarkTreeNode) => Promise<void>;
  onChanged: (id: string, changeInfo: BookmarkChangeInfo) => Promise<void>;
  onMoved: (id: string, moveInfo: BookmarkMoveInfo) => Promise<void>;
  onRemoved: (id: string, removeInfo: BookmarkRemoveInfo) => Promise<void>;
}

export function registerBookmarkListeners(handlers: BookmarkListenerHandlers): void {
  chrome.bookmarks.onCreated.addListener((id, node) => {
    void handlers.onCreated(id, node);
  });
  chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
    void handlers.onChanged(id, changeInfo);
  });
  chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
    void handlers.onMoved(id, moveInfo);
  });
  chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
    void handlers.onRemoved(id, removeInfo);
  });
}
