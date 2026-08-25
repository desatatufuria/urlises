import { useState } from "react";
import type { FolderNode } from "../../lib/api/bookmarks";
import { DataState } from "../../lib/ui/components/DataState";
import { FolderRow, type TreeActions } from "./TreeRow";

// Plain recursive renderer — no flattenTree, no @dnd-kit. Both land in Unit
// C alongside the drag-and-drop layer (design.md hard sequencing). Row
// content (chevron/label/menu) lives in TreeRow.tsx; this component owns
// only expand/collapse view state and the top-level list.
export function BookmarkTree({ folders, workspaceName, actions }: { folders: FolderNode[]; workspaceName: string; actions: TreeActions }) {
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
        <FolderRow key={folder.id} folder={folder} collapsedIds={collapsedIds} onToggle={onToggle} actions={actions} />
      ))}
    </ul>
  );
}
