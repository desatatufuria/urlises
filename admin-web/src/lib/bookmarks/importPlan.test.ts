import { describe, expect, it, vi } from "vitest";
import type { ParsedNode } from "./parseNetscapeBookmarks";
import { IMPORT_NODE_CEILING, ImportCeilingError, retryFailedPlan, runImportPlan, toImportPlan, type ImportItem } from "./importPlan";

function folder(name: string, children: ParsedNode[], key: string): ParsedNode {
  return { kind: "folder", key, name, children };
}

function bookmark(title: string, url: string, key: string): ParsedNode {
  return { kind: "bookmark", key, title, url };
}

describe("toImportPlan", () => {
  it("emits strict pre-order: every item's parentKey appears earlier in the array than the item itself", () => {
    const roots: ParsedNode[] = [
      folder("Work", [bookmark("One", "https://example.com/1", "n1"), folder("Nested", [bookmark("Deep", "https://example.com/deep", "n3")], "n2")], "n0"),
      bookmark("Root Bookmark", "https://example.com/root", "n4"),
    ];

    const plan = toImportPlan(roots);
    const indexOf = new Map(plan.map((item, index) => [item.key, index]));

    for (const item of plan) {
      if (item.parentKey !== null) {
        expect(indexOf.get(item.parentKey)).toBeLessThan(indexOf.get(item.key)!);
      }
    }

    expect(plan.map((item) => item.key)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
    expect(plan.find((item) => item.key === "n0")?.parentKey).toBeNull();
    expect(plan.find((item) => item.key === "n1")?.parentKey).toBe("n0");
    expect(plan.find((item) => item.key === "n3")?.parentKey).toBe("n2");
  });
});

function buildFlatPlan(count: number): ImportItem[] {
  const items: ImportItem[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push({ key: `n${i}`, kind: "bookmark", label: `Bookmark ${i}`, url: `https://example.com/${i}`, parentKey: null });
  }
  return items;
}

describe("runImportPlan — ceiling", () => {
  it("allows a plan of exactly the ceiling and creates every node", async () => {
    const plan = buildFlatPlan(IMPORT_NODE_CEILING);
    const createBookmark = vi.fn().mockImplementation((_parentId: string, item: ImportItem) => Promise.resolve(`server-${item.key}`));
    const createFolder = vi.fn();

    const result = await runImportPlan({ plan, destinationFolderId: "root", createdIds: {}, create: { createFolder, createBookmark } });

    expect(createBookmark).toHaveBeenCalledTimes(IMPORT_NODE_CEILING);
    expect(result.completed).toBe(IMPORT_NODE_CEILING);
    expect(result.failures).toHaveLength(0);
  });

  it("refuses a plan over the ceiling and issues zero create calls", async () => {
    const plan = buildFlatPlan(IMPORT_NODE_CEILING + 1);
    const createBookmark = vi.fn();
    const createFolder = vi.fn();

    await expect(runImportPlan({ plan, destinationFolderId: "root", createdIds: {}, create: { createFolder, createBookmark } })).rejects.toBeInstanceOf(ImportCeilingError);

    expect(createBookmark).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });
});

describe("runImportPlan — sequential parent-before-child and partial failure", () => {
  it("creates a folder before its children, using the folder's server-assigned id as their parentId", async () => {
    const plan: ImportItem[] = [
      { key: "n0", kind: "folder", label: "Work", parentKey: null },
      { key: "n1", kind: "bookmark", label: "One", url: "https://example.com/1", parentKey: "n0" },
    ];
    const calls: string[] = [];
    const createFolder = vi.fn().mockImplementation((parentId: string) => {
      calls.push(`folder:${parentId}`);
      return Promise.resolve("server-folder-1");
    });
    const createBookmark = vi.fn().mockImplementation((parentId: string) => {
      calls.push(`bookmark:${parentId}`);
      return Promise.resolve("server-bookmark-1");
    });

    const result = await runImportPlan({ plan, destinationFolderId: "root", createdIds: {}, create: { createFolder, createBookmark } });

    expect(calls).toEqual(["folder:root", "bookmark:server-folder-1"]);
    expect(result.createdIds).toEqual({ n0: "server-folder-1", n1: "server-bookmark-1" });
  });

  it("preserves nodes created before a mid-run failure, continues to independent nodes, and lists a failed folder's children as missing-parent without a request", async () => {
    const plan: ImportItem[] = [
      { key: "n0", kind: "bookmark", label: "First", url: "https://example.com/first", parentKey: null },
      { key: "n1", kind: "folder", label: "Broken Folder", parentKey: null },
      { key: "n2", kind: "bookmark", label: "Child of broken", url: "https://example.com/child", parentKey: "n1" },
      { key: "n3", kind: "bookmark", label: "Independent", url: "https://example.com/independent", parentKey: null },
    ];

    const createBookmark = vi.fn().mockImplementation((_parentId: string, item: ImportItem) => {
      if (item.key === "n3") return Promise.resolve("server-n3");
      return Promise.resolve(`server-${item.key}`);
    });
    const createFolder = vi.fn().mockImplementation(() => Promise.reject(new Error("folder create rejected")));

    const result = await runImportPlan({ plan, destinationFolderId: "root", createdIds: {}, create: { createFolder, createBookmark } });

    // n0 succeeded before the failure.
    expect(result.createdIds.n0).toBe("server-n0");
    // n1 (the folder) failed with a request-cause reason.
    const n1Failure = result.failures.find((f) => f.key === "n1");
    expect(n1Failure?.cause).toBe("request");
    expect(n1Failure?.reason).toContain("folder create rejected");
    // n2, the failed folder's child, is listed as missing-parent WITHOUT a create call for it.
    const n2Failure = result.failures.find((f) => f.key === "n2");
    expect(n2Failure?.cause).toBe("missing-parent");
    expect(createBookmark).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ key: "n2" }));
    // n3, independent of the failure, still gets attempted and succeeds.
    expect(result.createdIds.n3).toBe("server-n3");
    expect(result.completed).toBe(2);
  });
});

describe("retryFailedPlan + runImportPlan — retry mechanics", () => {
  it("re-attempts only the failed subset in original pre-order, retains createdIds, and updates the failure list", async () => {
    const fullPlan: ImportItem[] = [
      { key: "n0", kind: "folder", label: "Folder", parentKey: null },
      { key: "n1", kind: "bookmark", label: "Ok", url: "https://example.com/ok", parentKey: "n0" },
      { key: "n2", kind: "bookmark", label: "Flaky", url: "https://example.com/flaky", parentKey: "n0" },
      { key: "n3", kind: "bookmark", label: "Always fails", url: "https://example.com/fail", parentKey: "n0" },
    ];

    const createFolder = vi.fn().mockResolvedValue("server-folder");
    let flakyAttempt = 0;
    const createBookmark = vi.fn().mockImplementation((_parentId: string, item: ImportItem) => {
      if (item.key === "n1") return Promise.resolve("server-n1");
      if (item.key === "n2") {
        flakyAttempt += 1;
        return flakyAttempt === 1 ? Promise.reject(new Error("transient")) : Promise.resolve("server-n2");
      }
      return Promise.reject(new Error("always fails"));
    });

    const firstRun = await runImportPlan({ plan: fullPlan, destinationFolderId: "root", createdIds: {}, create: { createFolder, createBookmark } });

    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(firstRun.failures.map((f) => f.key)).toEqual(["n2", "n3"]);

    const retryPlan = retryFailedPlan(fullPlan, firstRun.failures);
    // Original pre-order is preserved for the retried subset.
    expect(retryPlan.map((item) => item.key)).toEqual(["n2", "n3"]);

    const secondRun = await runImportPlan({ plan: retryPlan, destinationFolderId: "root", createdIds: firstRun.createdIds, create: { createFolder, createBookmark } });

    // The folder is never re-created on retry — createdIds was retained.
    expect(createFolder).toHaveBeenCalledTimes(1);
    // n2 now succeeds and disappears from the failure list.
    expect(secondRun.createdIds.n2).toBe("server-n2");
    // n3 fails again and stays listed, with its reason.
    expect(secondRun.failures.map((f) => f.key)).toEqual(["n3"]);
    expect(secondRun.failures[0].reason).toContain("always fails");
  });
});
