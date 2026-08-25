import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import { isLegalTarget, type DropTarget, type FlatRow, type RowKey } from "../../../lib/bookmarks/treeModel";

/**
 * Parses a droppable/sortable container id back into the DropTarget it
 * represents. Row ids are the RowKey itself ("folder:x" / "bookmark:y");
 * folder into-zones are prefixed "into:"; the root drop zone is the fixed
 * id "into-root".
 */
export function parseDroppableId(id: string): DropTarget | null {
  if (id === "into-root") {
    return { kind: "into-root" };
  }
  if (id.startsWith("into:")) {
    return { kind: "into", folderId: id.slice("into:".length) };
  }
  if (id.startsWith("folder:") || id.startsWith("bookmark:")) {
    return { kind: "row", key: id as RowKey };
  }
  return null;
}

/**
 * Custom collision detection (design.md Decision 6): filters
 * `droppableContainers` by `isLegalTarget` BEFORE collision runs, so an
 * illegal target is never reported as `over` at all — the placeholder
 * simply snaps to the nearest legal slot instead of showing a drop
 * indicator that then gets refused.
 */
export function legalTargets(rows: FlatRow[]): CollisionDetection {
  return (args) => {
    const activeKey = args.active.id as RowKey;
    const legalContainers = args.droppableContainers.filter((container) => {
      const target = parseDroppableId(String(container.id));
      return target ? isLegalTarget(rows, activeKey, target) : false;
    });
    return closestCenter({ ...args, droppableContainers: legalContainers });
  };
}
