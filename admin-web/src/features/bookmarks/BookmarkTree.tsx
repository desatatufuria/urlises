import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useState } from "react";
import type { FolderNode } from "../../lib/api/bookmarks";
import { describeMovePlan, flattenTree, planDrop, planKeyboardMove, type MoveCommand, type MovePlan, type RowKey } from "../../lib/bookmarks/treeModel";
import { DataState } from "../../lib/ui/components/DataState";
import { buildAnnouncements } from "./dnd/announcements";
import { legalTargets, parseDroppableId } from "./dnd/collision";
import { TreeRow, type TreeActions } from "./TreeRow";

function collectFolderIds(folders: FolderNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: FolderNode[]) => {
    for (const folder of list) {
      ids.push(folder.id);
      walk(folder.folders);
    }
  };
  walk(folders);
  return ids;
}

function RootDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: "into-root" });
  return (
    <li ref={setNodeRef} className={`ui-tree-root-drop${isOver ? " ui-tree-root-drop--over" : ""}`}>
      Drop here to move to the workspace root
    </li>
  );
}

export function BookmarkTree({
  folders,
  workspaceName,
  actions,
  onMove,
}: {
  folders: FolderNode[];
  workspaceName: string;
  actions: TreeActions;
  onMove: (plan: Extract<MovePlan, { kind: "move" }>) => void;
}) {
  // Pure view state; survives refetch because refetch does not remount.
  // Default: every folder expanded, mirroring the prior recursive
  // renderer's default. `collapsedIds` retains only user-toggled
  // exceptions; flattenTree wants the positive "expanded" set (design.md),
  // computed here as "every folder id minus the collapsed ones".
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<RowKey | null>(null);
  const [liveMessage, setLiveMessage] = useState("");

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

  // Hooks must run unconditionally every render, so the sensors are
  // created before the empty-tree early return below.
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 4 } });
  const keyboardSensor = useSensor(KeyboardSensor);
  const sensors = useSensors(pointerSensor, keyboardSensor);

  if (folders.length === 0) {
    return <DataState compact title="No bookmarks yet" description="This workspace has no folders or bookmarks yet." />;
  }

  const allFolderIds = collectFolderIds(folders);
  const expandedIds = new Set(allFolderIds.filter((id) => !collapsedIds.has(id)));
  const rows = flattenTree(folders, expandedIds);
  const activeRow = activeKey ? (rows.find((row) => row.key === activeKey) ?? null) : null;

  const handleKeyboardMove = (key: RowKey, command: MoveCommand) => {
    const plan = planKeyboardMove(rows, key, command);
    setLiveMessage(describeMovePlan(plan, rows));
    if (plan.kind === "move") {
      onMove(plan);
    }
  };

  const handleDragStart = (event: DragStartEvent) => setActiveKey(event.active.id as RowKey);
  const handleDragCancel = () => setActiveKey(null);
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveKey(null);
    if (!over) {
      return;
    }
    const target = parseDroppableId(String(over.id));
    if (!target) {
      return;
    }
    const plan = planDrop(rows, active.id as RowKey, target);
    setLiveMessage(describeMovePlan(plan, rows));
    if (plan.kind === "move") {
      onMove(plan);
    }
  };

  return (
    <>
      {/* Keyboard-path announcements (Alt+Arrow); dnd-kit renders its own
          separate live region from `accessibility.announcements` below —
          both are driven by the same describeMovePlan function. */}
      <div aria-live="polite" data-testid="tree-move-announcer" className="ui-visually-hidden">
        {liveMessage}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={legalTargets(rows)}
        accessibility={{ announcements: buildAnnouncements(rows) }}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={rows.map((row) => row.key)} strategy={verticalListSortingStrategy}>
          <ul aria-label={`Bookmark tree for ${workspaceName}`} className="ui-tree">
            {activeRow?.type === "folder" ? <RootDropZone /> : null}
            {rows.map((row) => (
              <TreeRow key={row.key} row={row} actions={actions} onToggle={onToggle} onKeyboardMove={handleKeyboardMove} />
            ))}
          </ul>
        </SortableContext>
        <DragOverlay>{activeRow ? <span className="ui-tree-drag-overlay">{activeRow.label}</span> : null}</DragOverlay>
      </DndContext>
    </>
  );
}
