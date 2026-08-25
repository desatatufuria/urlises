import type { FolderNode } from "../api/bookmarks";

// Pure, DOM-free move planner (design.md "Model" / Decision 9). Everything
// that decides WHAT a drop or a keyboard command means lives here, fully
// unit-testable; @dnd-kit itself is a thin wiring layer around this module
// (BookmarkTree.tsx / TreeRow.tsx / dnd/collision.ts / dnd/announcements.ts).

export type NodeType = "folder" | "bookmark";
export type RowKey = `folder:${string}` | `bookmark:${string}`;

export interface FlatRow {
  key: RowKey;
  type: NodeType;
  id: string;
  label: string; // folder name | bookmark title
  url?: string; // bookmarks only
  parentFolderId: string | null; // null ⇒ workspace root (folders only)
  depth: number;
  index: number; // index within its SIBLING GROUP === server `position`
  groupSize: number; // size of that group, folders XOR bookmarks
  hasChildren: boolean;
  expanded: boolean;
  ancestorIds: string[]; // folder ids from root to parent — powers the cycle pre-check
}

function byPosition<T extends { position: number }>(a: T, b: T): number {
  return a.position - b.position;
}

/**
 * Depth-first, folders-before-bookmarks within each parent (mirroring the
 * two disjoint position spaces — folders and bookmarks under the same
 * parent can both hold position 0). Collapsed folders contribute their own
 * row and no descendants.
 */
export function flattenTree(folders: FolderNode[], expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];

  function visitFolder(folder: FolderNode, depth: number, parentFolderId: string | null, ancestorIds: string[]) {
    const hasChildren = folder.folders.length > 0 || folder.bookmarks.length > 0;
    const isExpanded = expanded.has(folder.id);

    rows.push({
      key: `folder:${folder.id}`,
      type: "folder",
      id: folder.id,
      label: folder.name,
      parentFolderId,
      depth,
      index: folder.position,
      groupSize: 0, // filled in by the caller once the sibling group is known
      hasChildren,
      expanded: isExpanded,
      ancestorIds,
    });

    if (!hasChildren || !isExpanded) {
      return;
    }

    const childAncestors = [...ancestorIds, folder.id];
    const childFolders = [...folder.folders].sort(byPosition);
    childFolders.forEach((child) => visitFolder(child, depth + 1, folder.id, childAncestors));

    const childBookmarks = [...folder.bookmarks].sort(byPosition);
    childBookmarks.forEach((bookmark) => {
      rows.push({
        key: `bookmark:${bookmark.id}`,
        type: "bookmark",
        id: bookmark.id,
        label: bookmark.title,
        url: bookmark.url,
        parentFolderId: folder.id,
        depth: depth + 1,
        index: bookmark.position,
        groupSize: childBookmarks.length,
        hasChildren: false,
        expanded: false,
        ancestorIds: childAncestors,
      });
    });
  }

  const rootFolders = [...folders].sort(byPosition);
  rootFolders.forEach((folder) => visitFolder(folder, 0, null, []));

  // Folder groupSize is only known once all siblings under the same parent
  // have been visited, so it's filled in as a second pass grouped by
  // (type=folder, parentFolderId).
  const folderGroupSizes = new Map<string | null, number>();
  for (const row of rows) {
    if (row.type !== "folder") continue;
    folderGroupSizes.set(row.parentFolderId, (folderGroupSizes.get(row.parentFolderId) ?? 0) + 1);
  }
  for (const row of rows) {
    if (row.type !== "folder") continue;
    row.groupSize = folderGroupSizes.get(row.parentFolderId) ?? 0;
  }

  return rows;
}

function findRow(rows: FlatRow[], key: RowKey): FlatRow | undefined {
  return rows.find((row) => row.key === key);
}

export type DropTarget = { kind: "row"; key: RowKey } | { kind: "into"; folderId: string } | { kind: "into-root" };

export type MovePlan =
  | { kind: "move"; type: NodeType; id: string; label: string; parentFolderId: string | null; parentChanged: boolean; position: number }
  | { kind: "none"; reason: "same-position" | "illegal-target" | "cycle" | "not-found" };

type LegalityReason = "ok" | "illegal-target" | "cycle" | "not-found";

/**
 * Legality rules (applied identically by the collision filter and the
 * keyboard planner):
 *  - row:       target.type === active.type, target !== active, and (for a
 *               folder active) target is not inside active's subtree.
 *  - into:      target !== active, folderId is not in active's subtree, and
 *               folderId !== active's current parent.
 *  - into-root: active is a folder currently NOT already at the root.
 */
function legalityReason(rows: FlatRow[], activeKey: RowKey, target: DropTarget): LegalityReason {
  const active = findRow(rows, activeKey);
  if (!active) {
    return "not-found";
  }

  if (target.kind === "row") {
    if (target.key === activeKey) {
      return "illegal-target";
    }
    const targetRow = findRow(rows, target.key);
    if (!targetRow) {
      return "not-found";
    }
    if (targetRow.type !== active.type) {
      return "illegal-target";
    }
    if (active.type === "folder" && targetRow.ancestorIds.includes(active.id)) {
      return "cycle";
    }
    return "ok";
  }

  if (target.kind === "into") {
    if (target.folderId === active.id) {
      return "illegal-target";
    }
    const targetFolder = findRow(rows, `folder:${target.folderId}`);
    if (!targetFolder || targetFolder.type !== "folder") {
      return "not-found";
    }
    if (targetFolder.ancestorIds.includes(active.id)) {
      return "cycle";
    }
    if (target.folderId === active.parentFolderId) {
      return "illegal-target";
    }
    return "ok";
  }

  // into-root
  if (active.type !== "folder") {
    return "illegal-target";
  }
  if (active.parentFolderId === null) {
    return "illegal-target";
  }
  return "ok";
}

export function isLegalTarget(rows: FlatRow[], activeKey: RowKey, target: DropTarget): boolean {
  return legalityReason(rows, activeKey, target) === "ok";
}

function countGroup(rows: FlatRow[], type: NodeType, parentFolderId: string | null): number {
  return rows.filter((row) => row.type === type && row.parentFolderId === parentFolderId).length;
}

/**
 * Position arithmetic (the single load-bearing formula). For `{kind:"row"}`
 * targets, `position = overRow.index`. This is correct for both same-group
 * reorder and cross-group reparent, and matches both dnd-kit's
 * `arrayMove(items, from, to)` and the server's `insertAt` (which excludes
 * the moving row and inserts at the given position). For `{kind:"into"}`
 * and `{kind:"into-root"}`, `position` is the destination group's current
 * size (append) — `PrepareFolderPatchTx` clamps to siblingCount anyway.
 */
export function planDrop(rows: FlatRow[], activeKey: RowKey, target: DropTarget): MovePlan {
  const active = findRow(rows, activeKey);
  if (!active) {
    return { kind: "none", reason: "not-found" };
  }

  // Dropping (or hovering) a row onto itself mid-drag is a common dnd-kit
  // report and is a no-op, not a semantic rejection.
  if (target.kind === "row" && target.key === activeKey) {
    return { kind: "none", reason: "same-position" };
  }

  const reason = legalityReason(rows, activeKey, target);
  if (reason !== "ok") {
    return { kind: "none", reason };
  }

  if (target.kind === "row") {
    const targetRow = findRow(rows, target.key)!;
    return {
      kind: "move",
      type: active.type,
      id: active.id,
      label: active.label,
      parentFolderId: targetRow.parentFolderId,
      parentChanged: targetRow.parentFolderId !== active.parentFolderId,
      position: targetRow.index,
    };
  }

  if (target.kind === "into") {
    return {
      kind: "move",
      type: active.type,
      id: active.id,
      label: active.label,
      parentFolderId: target.folderId,
      parentChanged: true,
      position: countGroup(rows, active.type, target.folderId),
    };
  }

  // into-root
  return {
    kind: "move",
    type: active.type,
    id: active.id,
    label: active.label,
    parentFolderId: null,
    parentChanged: true,
    position: countGroup(rows, active.type, null),
  };
}

export type MoveCommand = "up" | "down" | "outdent" | "indent";

/**
 * Keyboard commands (handled on the drag handle's onKeyDown, so they never
 * collide with KeyboardSensor's space-to-lift or with normal tabbing):
 *  - Alt+Up / Alt+Down: position ± 1 within the row's own sibling group;
 *    refused at the ends.
 *  - Alt+Left (outdent): reparent to the grandparent, appended. Refused for
 *    a bookmark whose parent is a root folder (would land at the
 *    workspace root, which bookmarks cannot occupy).
 *  - Alt+Right (indent): reparent into the folder immediately preceding
 *    this row among its parent's combined children; refused when that
 *    neighbour is not a folder or does not exist.
 *
 * Every branch delegates to planDrop for the actual MovePlan construction,
 * so the keyboard path is structurally guaranteed to produce the same
 * MovePlan as the equivalent pointer drag.
 */
export function planKeyboardMove(rows: FlatRow[], activeKey: RowKey, command: MoveCommand): MovePlan {
  const active = findRow(rows, activeKey);
  if (!active) {
    return { kind: "none", reason: "not-found" };
  }

  if (command === "up" || command === "down") {
    const targetIndex = active.index + (command === "up" ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= active.groupSize) {
      return { kind: "none", reason: "illegal-target" };
    }
    const siblingRow = rows.find((row) => row.type === active.type && row.parentFolderId === active.parentFolderId && row.index === targetIndex);
    if (!siblingRow) {
      return { kind: "none", reason: "not-found" };
    }
    return planDrop(rows, activeKey, { kind: "row", key: siblingRow.key });
  }

  if (command === "outdent") {
    if (active.parentFolderId === null) {
      return { kind: "none", reason: "illegal-target" };
    }
    const parentRow = findRow(rows, `folder:${active.parentFolderId}`);
    if (!parentRow) {
      return { kind: "none", reason: "not-found" };
    }
    const grandparentId = parentRow.parentFolderId;
    if (active.type === "bookmark" && grandparentId === null) {
      return { kind: "none", reason: "illegal-target" };
    }
    if (grandparentId === null) {
      return planDrop(rows, activeKey, { kind: "into-root" });
    }
    return planDrop(rows, activeKey, { kind: "into", folderId: grandparentId });
  }

  // indent: the folder immediately preceding this row among its parent's
  // combined children (folders before bookmarks, each group in position
  // order) — exactly the relative order flattenTree already produced for
  // direct children of the same parent.
  const combinedChildren = rows.filter((row) => row.parentFolderId === active.parentFolderId);
  const activePosition = combinedChildren.findIndex((row) => row.key === activeKey);
  const precedingRow = activePosition > 0 ? combinedChildren[activePosition - 1] : undefined;
  if (!precedingRow || precedingRow.type !== "folder") {
    return { kind: "none", reason: "illegal-target" };
  }
  return planDrop(rows, activeKey, { kind: "into", folderId: precedingRow.id });
}

/**
 * One description function, two consumers: dnd-kit's `announcements` object
 * (features/bookmarks/dnd/announcements.ts) and the keyboard path's own
 * aria-live region text.
 */
export function describeMovePlan(plan: MovePlan, rows: FlatRow[]): string {
  if (plan.kind === "none") {
    switch (plan.reason) {
      case "same-position":
        return "No change — dropped in the same position.";
      case "cycle":
        return "That folder cannot move into its own subtree.";
      case "not-found":
        return "That item could no longer be found.";
      case "illegal-target":
      default:
        return "That move is not allowed here.";
    }
  }

  const kindLabel = plan.type === "folder" ? "Folder" : "Bookmark";
  if (plan.parentChanged) {
    const destination = plan.parentFolderId ? (rows.find((row) => row.type === "folder" && row.id === plan.parentFolderId)?.label ?? "another folder") : "the workspace root";
    return `${kindLabel} "${plan.label}" moved into ${destination}, position ${plan.position + 1}.`;
  }
  return `${kindLabel} "${plan.label}" moved to position ${plan.position + 1}.`;
}
