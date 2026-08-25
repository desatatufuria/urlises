import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, KeyboardEvent } from "react";
import type { FlatRow, MoveCommand, RowKey } from "../../lib/bookmarks/treeModel";
import { DropdownMenu } from "../../lib/ui/components/DropdownMenu";

// TreeRow now renders one FlatRow (flattenTree's output) rather than
// recursing over FolderNode — the flat SortableContext lives in
// BookmarkTree.tsx (design.md Decision 7). The drag handle carries both
// @dnd-kit's pointer/KeyboardSensor listeners AND the Alt+Arrow onKeyDown
// handler for the guaranteed keyboard path (Decision 8) — the two never
// collide because Alt+Arrow is not a key dnd-kit's KeyboardSensor binds.
export interface TreeActions {
  readOnly: boolean;
  onAddFolder: (parentId: string) => void;
  onAddBookmark: (folderId: string) => void;
  onRenameFolder: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onEditBookmark: (bookmarkId: string) => void;
  onDeleteBookmark: (bookmarkId: string) => void;
}

function keyboardCommandFor(event: KeyboardEvent): MoveCommand | null {
  if (!event.altKey) {
    return null;
  }
  switch (event.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "outdent";
    case "ArrowRight":
      return "indent";
    default:
      return null;
  }
}

export function TreeRow({
  row,
  actions,
  onToggle,
  onKeyboardMove,
}: {
  row: FlatRow;
  actions: TreeActions;
  onToggle: (folderId: string) => void;
  onKeyboardMove: (key: RowKey, command: MoveCommand) => void;
}) {
  const sortable = useSortable({ id: row.key, disabled: actions.readOnly });
  const into = useDroppable({ id: `into:${row.id}`, disabled: actions.readOnly || row.type !== "folder" });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition ?? undefined,
    ["--depth" as string]: row.depth,
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const command = keyboardCommandFor(event);
    if (!command) {
      return;
    }
    event.preventDefault();
    onKeyboardMove(row.key, command);
  };

  return (
    <li ref={sortable.setNodeRef} style={style} className={`ui-tree-row${sortable.isDragging ? " ui-tree-row--dragging" : ""}`}>
      <div className="ui-tree-row-content">
        {!actions.readOnly ? (
          <button type="button" className="ui-tree-handle" aria-label={`Move ${row.label}`} {...sortable.attributes} {...sortable.listeners} onKeyDown={handleKeyDown}>
            ⠿
          </button>
        ) : (
          <span className="ui-tree-handle-spacer" aria-hidden="true" />
        )}

        {row.type === "folder" && row.hasChildren ? (
          <button type="button" className="ui-tree-toggle" aria-expanded={row.expanded} aria-label={row.expanded ? `Collapse ${row.label}` : `Expand ${row.label}`} onClick={() => onToggle(row.id)}>
            {row.expanded ? "▾" : "▸"}
          </button>
        ) : row.type === "folder" ? (
          <span className="ui-tree-toggle-spacer" aria-hidden="true" />
        ) : null}

        {row.type === "bookmark" ? (
          <a className="ui-tree-label" href={row.url} target="_blank" rel="noreferrer noopener">
            {row.label}
          </a>
        ) : (
          <span ref={into.setNodeRef} className={`ui-tree-label${into.isOver ? " ui-tree-label--drop-target" : ""}`}>
            {row.label}
          </span>
        )}

        {!actions.readOnly ? (
          <DropdownMenu ariaLabel={`Actions for ${row.label}`} label="⋯">
            {(close) =>
              row.type === "folder" ? (
                <>
                  <button
                    type="button"
                    className="ui-dropdown__item"
                    onClick={() => {
                      actions.onAddFolder(row.id);
                      close();
                    }}
                  >
                    Add folder inside
                  </button>
                  <button
                    type="button"
                    className="ui-dropdown__item"
                    onClick={() => {
                      actions.onAddBookmark(row.id);
                      close();
                    }}
                  >
                    Add bookmark inside
                  </button>
                  <button
                    type="button"
                    className="ui-dropdown__item"
                    onClick={() => {
                      actions.onRenameFolder(row.id);
                      close();
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="ui-dropdown__item"
                    onClick={() => {
                      actions.onDeleteFolder(row.id);
                      close();
                    }}
                  >
                    Delete
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ui-dropdown__item"
                    onClick={() => {
                      actions.onEditBookmark(row.id);
                      close();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ui-dropdown__item"
                    onClick={() => {
                      actions.onDeleteBookmark(row.id);
                      close();
                    }}
                  >
                    Delete
                  </button>
                </>
              )
            }
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}
