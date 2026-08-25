import { useState } from "react";
import type { BookmarkNode, FolderNode } from "../../lib/api/bookmarks";
import { DataState } from "../../lib/ui/components/DataState";

// Plain recursive renderer — no flattenTree, no @dnd-kit. Both land in Unit
// C alongside the drag-and-drop layer (design.md hard sequencing).

function BookmarkRow({ bookmark }: { bookmark: BookmarkNode }) {
  return (
    <li className="ui-tree-row">
      <a className="ui-tree-label" href={bookmark.url} target="_blank" rel="noreferrer noopener">
        {bookmark.title}
      </a>
    </li>
  );
}

function FolderRow({
  folder,
  collapsedIds,
  onToggle,
}: {
  folder: FolderNode;
  collapsedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const hasChildren = folder.folders.length > 0 || folder.bookmarks.length > 0;
  const collapsed = collapsedIds.has(folder.id);

  return (
    <li className="ui-tree-row">
      <div className="ui-tree-row-content">
        {hasChildren ? (
          <button
            type="button"
            className="ui-tree-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
            onClick={() => onToggle(folder.id)}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="ui-tree-toggle-spacer" aria-hidden="true" />
        )}
        <span className="ui-tree-label">{folder.name}</span>
      </div>
      {hasChildren && !collapsed ? (
        <ul className="ui-tree-children">
          {folder.folders.map((child) => (
            <FolderRow key={child.id} folder={child} collapsedIds={collapsedIds} onToggle={onToggle} />
          ))}
          {folder.bookmarks.map((bookmark) => (
            <BookmarkRow key={bookmark.id} bookmark={bookmark} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function BookmarkTree({ folders, workspaceName }: { folders: FolderNode[]; workspaceName: string }) {
  // Pure view state; survives refetch because refetch does not remount.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const onToggle = (id: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  if (folders.length === 0) {
    return <DataState compact title="No bookmarks yet" description="This workspace has no folders or bookmarks yet." />;
  }

  return (
    <ul aria-label={`Bookmark tree for ${workspaceName}`} className="ui-tree">
      {folders.map((folder) => (
        <FolderRow key={folder.id} folder={folder} collapsedIds={collapsedIds} onToggle={onToggle} />
      ))}
    </ul>
  );
}
