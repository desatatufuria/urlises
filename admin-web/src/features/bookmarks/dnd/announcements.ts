import type { Announcements } from "@dnd-kit/core";
import { describeMovePlan, planDrop, type FlatRow, type RowKey } from "../../../lib/bookmarks/treeModel";
import { parseDroppableId } from "./collision";

/**
 * dnd-kit `announcements`, built on the same `describeMovePlan` the
 * keyboard path's own aria-live region uses (design.md — "one description
 * function, two consumers").
 */
export function buildAnnouncements(rows: FlatRow[]): Announcements {
  const labelFor = (key: RowKey) => rows.find((row) => row.key === key)?.label ?? "item";

  return {
    onDragStart({ active }) {
      return `Picked up ${labelFor(active.id as RowKey)}.`;
    },
    onDragOver({ active, over }) {
      if (!over) {
        return "No legal drop target.";
      }
      const target = parseDroppableId(String(over.id));
      if (!target) {
        return undefined;
      }
      const plan = planDrop(rows, active.id as RowKey, target);
      return describeMovePlan(plan, rows);
    },
    onDragEnd({ active, over }) {
      if (!over) {
        return `Move of ${labelFor(active.id as RowKey)} cancelled.`;
      }
      const target = parseDroppableId(String(over.id));
      if (!target) {
        return undefined;
      }
      const plan = planDrop(rows, active.id as RowKey, target);
      return describeMovePlan(plan, rows);
    },
    onDragCancel({ active }) {
      return `Move of ${labelFor(active.id as RowKey)} cancelled.`;
    },
  };
}
