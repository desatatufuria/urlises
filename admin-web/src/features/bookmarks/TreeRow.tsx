import type { BookmarkNode, FolderNode } from "../../lib/api/bookmarks";
import { DropdownMenu } from "../../lib/ui/components/DropdownMenu";

// No @dnd-kit here yet — the drag handle and useSortable/useDroppable wiring
// land in Unit C (design.md hard sequencing). This is the menu-only shape:
// folder rows carry Add folder inside / Add bookmark inside / Rename /
// Delete; bookmark rows carry Edit / Delete.
export interface TreeActions {
  readOnly: boolean;
  onAddFolder: (parentId: string) => void;
  onAddBookmark: (folderId: string) => void;
  onRenameFolder: (folder: FolderNode) => void;
  onDeleteFolder: (folder: FolderNode) => void;
  onEditBookmark: (bookmark: BookmarkNode) => void;
  onDeleteBookmark: (bookmark: BookmarkNode) => void;
}

export function BookmarkRow({ bookmark, actions }: { bookmark: BookmarkNode; actions: TreeActions }) {
  return (
    <li className="ui-tree-row">
      <div className="ui-tree-row-content">
        <a className="ui-tree-label" href={bookmark.url} target="_blank" rel="noreferrer noopener">
          {bookmark.title}
        </a>
        {!actions.readOnly ? (
          <DropdownMenu ariaLabel={`Actions for ${bookmark.title}`} label="⋯">
            {(close) => (
              <>
                <button
                  type="button"
                  className="ui-dropdown__item"
                  onClick={() => {
                    actions.onEditBookmark(bookmark);
                    close();
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ui-dropdown__item"
                  onClick={() => {
                    actions.onDeleteBookmark(bookmark);
                    close();
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}

export function FolderRow({
  folder,
  collapsedIds,
  onToggle,
  actions,
}: {
  folder: FolderNode;
  collapsedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  actions: TreeActions;
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
        {!actions.readOnly ? (
          <DropdownMenu ariaLabel={`Actions for ${folder.name}`} label="⋯">
            {(close) => (
              <>
                <button
                  type="button"
                  className="ui-dropdown__item"
                  onClick={() => {
                    actions.onAddFolder(folder.id);
                    close();
                  }}
                >
                  Add folder inside
                </button>
                <button
                  type="button"
                  className="ui-dropdown__item"
                  onClick={() => {
                    actions.onAddBookmark(folder.id);
                    close();
                  }}
                >
                  Add bookmark inside
                </button>
                <button
                  type="button"
                  className="ui-dropdown__item"
                  onClick={() => {
                    actions.onRenameFolder(folder);
                    close();
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="ui-dropdown__item"
                  onClick={() => {
                    actions.onDeleteFolder(folder);
                    close();
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </DropdownMenu>
        ) : null}
      </div>
      {hasChildren && !collapsed ? (
        <ul className="ui-tree-children">
          {folder.folders.map((child) => (
            <FolderRow key={child.id} folder={child} collapsedIds={collapsedIds} onToggle={onToggle} actions={actions} />
          ))}
          {folder.bookmarks.map((bookmark) => (
            <BookmarkRow key={bookmark.id} bookmark={bookmark} actions={actions} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
