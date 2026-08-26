import { describe, expect, it } from "vitest";
import type { FolderNode } from "../api/bookmarks";
import { describeMovePlan, flattenTree, isLegalTarget, planDrop, planKeyboardMove, type RowKey } from "./treeModel";

// Fixture shape:
//
// root
// ├─ folder-a (pos 0)
// │   ├─ folder-a1 (pos 0)
// │   │   ├─ folder-a1a (pos 0)
// │   │   └─ bookmark bm-nested (pos 0)
// │   └─ bookmarks bm-a0..bm-a3 (pos 0..3)
// └─ folder-b (pos 1)
//
// folder-y (used only by the cross-group reparent test) has its own
// sibling bookmarks, kept separate from folder-a/folder-b to isolate that
// test's fixture from the reorder-focused fixture above.
function buildTree(): FolderNode[] {
  const folderA1a: FolderNode = { id: "folder-a1a", parentId: "folder-a1", name: "Folder A1a", position: 0, folders: [], bookmarks: [] };
  const folderA1: FolderNode = {
    id: "folder-a1",
    parentId: "folder-a",
    name: "Folder A1",
    position: 0,
    folders: [folderA1a],
    bookmarks: [{ id: "bm-nested", folderId: "folder-a1", title: "Nested Bookmark", url: "https://example.com/nested", position: 0 }],
  };
  const folderA: FolderNode = {
    id: "folder-a",
    name: "Folder A",
    position: 0,
    folders: [folderA1],
    bookmarks: [
      { id: "bm-a0", folderId: "folder-a", title: "Bookmark A0", url: "https://example.com/a0", position: 0 },
      { id: "bm-a1", folderId: "folder-a", title: "Bookmark A1", url: "https://example.com/a1", position: 1 },
      { id: "bm-a2", folderId: "folder-a", title: "Bookmark A2", url: "https://example.com/a2", position: 2 },
      { id: "bm-a3", folderId: "folder-a", title: "Bookmark A3", url: "https://example.com/a3", position: 3 },
    ],
  };
  const folderB: FolderNode = { id: "folder-b", name: "Folder B", position: 1, folders: [], bookmarks: [] };
  return [folderA, folderB];
}

const fullyExpanded = new Set(["folder-a", "folder-a1", "folder-a1a", "folder-b"]);

describe("flattenTree", () => {
  it("visits depth-first, folders before bookmarks within each parent", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(rows.map((row) => row.key)).toEqual([
      "folder:folder-a",
      "folder:folder-a1",
      "folder:folder-a1a",
      "bookmark:bm-nested",
      "bookmark:bm-a0",
      "bookmark:bm-a1",
      "bookmark:bm-a2",
      "bookmark:bm-a3",
      "folder:folder-b",
    ]);
  });

  it("sets per-group index equal to the node's server position, grouped by type under the same parent", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("folder:folder-a")?.index).toBe(0);
    expect(byKey.get("folder:folder-b")?.index).toBe(1);
    expect(byKey.get("folder:folder-a1")?.index).toBe(0);
    expect(byKey.get("bookmark:bm-a0")?.index).toBe(0);
    expect(byKey.get("bookmark:bm-a1")?.index).toBe(1);
    expect(byKey.get("bookmark:bm-a2")?.index).toBe(2);
    expect(byKey.get("bookmark:bm-a3")?.index).toBe(3);
    expect(byKey.get("folder:folder-b")?.groupSize).toBe(2);
    expect(byKey.get("bookmark:bm-a0")?.groupSize).toBe(4);
  });

  it("gives a collapsed folder its own row and contributes no descendant rows", () => {
    const expanded = new Set(["folder-a"]); // folder-a1 is NOT expanded
    const rows = flattenTree(buildTree(), expanded);
    const keys = rows.map((row) => row.key);
    expect(keys).toContain("folder:folder-a1");
    expect(keys).not.toContain("folder:folder-a1a");
    expect(keys).not.toContain("bookmark:bm-nested");
    const folderA1Row = rows.find((row) => row.key === "folder:folder-a1");
    expect(folderA1Row?.hasChildren).toBe(true);
    expect(folderA1Row?.expanded).toBe(false);
  });

  it("normalizes an absent parentId to workspace root (null)", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const folderARow = rows.find((row) => row.key === "folder:folder-a");
    expect(folderARow?.parentFolderId).toBeNull();
    const folderA1Row = rows.find((row) => row.key === "folder:folder-a1");
    expect(folderA1Row?.parentFolderId).toBe("folder-a");
  });
});

// A local, independent port of dnd-kit's arrayMove and the server's
// insertAt (bookmarks/service.go:745) — used only to cross-check planDrop's
// position arithmetic against two implementations that were not written by
// planDrop itself.
function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function insertAt(ids: string[], movingId: string, position: number): string[] {
  const withoutMoving = ids.filter((id) => id !== movingId);
  const clamped = Math.max(0, Math.min(position, withoutMoving.length));
  return [...withoutMoving.slice(0, clamped), movingId, ...withoutMoving.slice(clamped)];
}

describe("planDrop — same-group reorder (the single highest-value test in the change)", () => {
  const groupIds = ["bm-a0", "bm-a1", "bm-a2", "bm-a3"];

  it("sets position === overRow.index for every (from, to) pair, matching arrayMove and insertAt", () => {
    for (let from = 0; from < groupIds.length; from += 1) {
      for (let to = 0; to < groupIds.length; to += 1) {
        if (from === to) continue;
        const rows = flattenTree(buildTree(), fullyExpanded);
        const activeKey = `bookmark:${groupIds[from]}` as RowKey;
        const overKey = `bookmark:${groupIds[to]}` as RowKey;
        const plan = planDrop(rows, activeKey, { kind: "row", key: overKey });

        expect(plan.kind).toBe("move");
        if (plan.kind !== "move") continue;
        expect(plan.parentChanged).toBe(false);
        expect(plan.position).toBe(to);

        const viaServer = insertAt(groupIds, groupIds[from], plan.position);
        const viaClient = arrayMove(groupIds, from, to);
        expect(viaServer).toEqual(viaClient);
      }
    }
  });

  it("resolves dropping a row onto itself as a same-position no-op, not an illegal move", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const plan = planDrop(rows, "bookmark:bm-a1", { kind: "row", key: "bookmark:bm-a1" });
    expect(plan).toEqual({ kind: "none", reason: "same-position" });
  });
});

describe("planDrop — cross-group reparent", () => {
  function buildSiblingFolders(): FolderNode[] {
    const folderX: FolderNode = {
      id: "folder-x",
      name: "Folder X",
      position: 0,
      folders: [],
      bookmarks: [{ id: "bm-x0", folderId: "folder-x", title: "Bookmark X0", url: "https://example.com/x0", position: 0 }],
    };
    const folderY: FolderNode = {
      id: "folder-y",
      name: "Folder Y",
      position: 1,
      folders: [],
      bookmarks: [
        { id: "bm-y0", folderId: "folder-y", title: "Bookmark Y0", url: "https://example.com/y0", position: 0 },
        { id: "bm-y1", folderId: "folder-y", title: "Bookmark Y1", url: "https://example.com/y1", position: 1 },
      ],
    };
    return [folderX, folderY];
  }

  it("sets parentChanged and inserts before the hovered row when dragging into a different group", () => {
    const rows = flattenTree(buildSiblingFolders(), new Set(["folder-x", "folder-y"]));
    const plan = planDrop(rows, "bookmark:bm-x0", { kind: "row", key: "bookmark:bm-y1" });

    expect(plan).toEqual({
      kind: "move",
      type: "bookmark",
      id: "bm-x0",
      label: "Bookmark X0",
      parentFolderId: "folder-y",
      parentChanged: true,
      position: 1, // bm-y1's index — inserts immediately before it
    });
  });

  it("appends when dropped into a folder's into-zone, at the destination group size", () => {
    const rows = flattenTree(buildSiblingFolders(), new Set(["folder-x", "folder-y"]));
    const plan = planDrop(rows, "bookmark:bm-x0", { kind: "into", folderId: "folder-y" });

    expect(plan).toEqual({
      kind: "move",
      type: "bookmark",
      id: "bm-x0",
      label: "Bookmark X0",
      parentFolderId: "folder-y",
      parentChanged: true,
      position: 2, // folder-y already has 2 bookmarks; append at index 2
    });
  });
});

describe("isLegalTarget", () => {
  it("rejects a cross-type row target (bookmark active, folder row target)", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(isLegalTarget(rows, "bookmark:bm-a0", { kind: "row", key: "folder:folder-b" })).toBe(false);
  });

  it("rejects targeting itself", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(isLegalTarget(rows, "bookmark:bm-a0", { kind: "row", key: "bookmark:bm-a0" })).toBe(false);
  });

  it("rejects a folder dragged onto its own descendant (cycle)", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(isLegalTarget(rows, "folder:folder-a", { kind: "row", key: "folder:folder-a1" })).toBe(false);
    expect(isLegalTarget(rows, "folder:folder-a", { kind: "into", folderId: "folder-a1a" })).toBe(false);
  });

  it("rejects an into-zone target that is the active row's own current parent", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(isLegalTarget(rows, "bookmark:bm-a0", { kind: "into", folderId: "folder-a" })).toBe(false);
  });

  it("rejects a bookmark targeting into-root (only folders may sit at the workspace root)", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(isLegalTarget(rows, "bookmark:bm-a0", { kind: "into-root" })).toBe(false);
  });

  it("accepts a legal same-type row target and a legal into-zone target", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(isLegalTarget(rows, "bookmark:bm-a0", { kind: "row", key: "bookmark:bm-a2" })).toBe(true);
    expect(isLegalTarget(rows, "bookmark:bm-a0", { kind: "into", folderId: "folder-a1" })).toBe(true);
    expect(isLegalTarget(rows, "folder:folder-a1", { kind: "into-root" })).toBe(true);
  });
});

describe("planKeyboardMove — byte-identical to the equivalent planDrop call", () => {
  it("up/down reorder within the sibling group matches dragging onto the neighbouring row", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const down = planKeyboardMove(rows, "bookmark:bm-a1", "down");
    const equivalentDown = planDrop(rows, "bookmark:bm-a1", { kind: "row", key: "bookmark:bm-a2" });
    expect(down).toEqual(equivalentDown);

    const up = planKeyboardMove(rows, "bookmark:bm-a2", "up");
    const equivalentUp = planDrop(rows, "bookmark:bm-a2", { kind: "row", key: "bookmark:bm-a1" });
    expect(up).toEqual(equivalentUp);
  });

  it("refuses up at the start and down at the end of the sibling group", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(planKeyboardMove(rows, "bookmark:bm-a0", "up")).toEqual({ kind: "none", reason: "illegal-target" });
    expect(planKeyboardMove(rows, "bookmark:bm-a3", "down")).toEqual({ kind: "none", reason: "illegal-target" });
  });

  it("outdent reparents to the grandparent, matching the equivalent planDrop into-target call", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const outdent = planKeyboardMove(rows, "bookmark:bm-nested", "outdent");
    const equivalent = planDrop(rows, "bookmark:bm-nested", { kind: "into", folderId: "folder-a" });
    expect(outdent).toEqual(equivalent);
    expect(outdent).toMatchObject({ kind: "move", parentFolderId: "folder-a", parentChanged: true });
  });

  it("refuses outdent for a bookmark whose parent is a root folder", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    expect(planKeyboardMove(rows, "bookmark:bm-a0", "outdent")).toEqual({ kind: "none", reason: "illegal-target" });
  });

  it("indent reparents into the immediately preceding folder sibling, matching the equivalent planDrop into-target call", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const indent = planKeyboardMove(rows, "bookmark:bm-a0", "indent");
    const equivalent = planDrop(rows, "bookmark:bm-a0", { kind: "into", folderId: "folder-a1" });
    expect(indent).toEqual(equivalent);
    expect(indent).toMatchObject({ kind: "move", parentFolderId: "folder-a1", parentChanged: true });
  });

  it("refuses indent when the preceding neighbour is not a folder or does not exist", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    // bm-a1's preceding combined-children neighbour is bm-a0, a bookmark.
    expect(planKeyboardMove(rows, "bookmark:bm-a1", "indent")).toEqual({ kind: "none", reason: "illegal-target" });
    // folder-a1's preceding neighbour: none (it's the first combined child of folder-a).
    expect(planKeyboardMove(rows, "folder:folder-a1", "indent")).toEqual({ kind: "none", reason: "illegal-target" });
  });
});

describe("describeMovePlan", () => {
  it("describes a successful move including the item label", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const plan = planDrop(rows, "bookmark:bm-a0", { kind: "row", key: "bookmark:bm-a2" });
    const text = describeMovePlan(plan, rows);
    expect(text).toContain("Bookmark A0");
  });

  it("describes a rejected cycle move without throwing", () => {
    const rows = flattenTree(buildTree(), fullyExpanded);
    const plan = planDrop(rows, "folder:folder-a", { kind: "row", key: "folder:folder-a1" });
    expect(plan.kind).toBe("none");
    const text = describeMovePlan(plan, rows);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});
