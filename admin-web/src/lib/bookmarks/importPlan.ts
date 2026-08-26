import type { ParsedNode } from "./parseNetscapeBookmarks";
import type { NodeType } from "./treeModel";

// Pure import-run orchestration (design.md Phase D2). No `fetch`, no React,
// no `lib/api/bookmarks.ts` import — the actual create calls are injected
// via `CreateFns` so this module stays unit-testable with mocks and is
// reused unchanged by `features/bookmarks/useImportRunner.ts`, which binds
// `CreateFns` to the real API + `useUncertainCreationKey` event ids.

export interface ImportItem {
  key: string;
  kind: NodeType;
  label: string;
  url?: string;
  parentKey: string | null;
}

/** Pre-order DFS ⇒ a parent always precedes every descendant, in file order. */
export function toImportPlan(roots: ParsedNode[]): ImportItem[] {
  const items: ImportItem[] = [];

  function visit(nodes: ParsedNode[], parentKey: string | null) {
    for (const node of nodes) {
      if (node.kind === "folder") {
        items.push({ key: node.key, kind: "folder", label: node.name, parentKey });
        visit(node.children, node.key);
      } else {
        items.push({ key: node.key, kind: "bookmark", label: node.title, url: node.url, parentKey });
      }
    }
  }

  visit(roots, null);
  return items;
}

// Proposal A: imports above this ceiling are refused up front, naming the
// bulk import endpoint as the fix for that scale.
export const IMPORT_NODE_CEILING = 500;

export class ImportCeilingError extends Error {
  nodeCount: number;

  constructor(nodeCount: number) {
    super(`This file contains ${nodeCount} bookmarks and folders, which is over the ${IMPORT_NODE_CEILING}-item limit for this tool. Use the bulk import endpoint for imports at this scale.`);
    this.name = "ImportCeilingError";
    this.nodeCount = nodeCount;
  }
}

export interface ImportFailure {
  key: string;
  label: string;
  kind: NodeType;
  reason: string;
  cause: "request" | "missing-parent";
}

export interface ImportRunState {
  status: "idle" | "ready" | "running" | "done";
  plan: ImportItem[];
  destinationFolderId: string | null;
  // planKey -> server id; RETAINED across retries (Decision 16).
  createdIds: Record<string, string>;
  failures: ImportFailure[];
  completed: number;
  total: number;
  currentKey: string | null;
}

export interface CreateFns {
  // parentId is null only for a top-level folder created directly at the
  // workspace root (folders.parentId is nullable server-side). A bookmark
  // can never legally target the root (bookmarks.folder_id is NOT NULL) —
  // the UI's pre-flight check (Decision 17) refuses that case before a run
  // ever starts, so createBookmark's parentId here is always a real folder id.
  createFolder: (parentId: string | null, item: ImportItem) => Promise<string>;
  createBookmark: (parentId: string, item: ImportItem) => Promise<string>;
}

export interface RunImportPlanOptions {
  plan: ImportItem[];
  destinationFolderId: string | null;
  /** Carried over from a previous run for retry — never mutated in place. */
  createdIds: Record<string, string>;
  create: CreateFns;
  onProgress?: (completed: number, total: number, currentKey: string | null) => void;
}

export interface RunImportPlanResult {
  createdIds: Record<string, string>;
  failures: ImportFailure[];
  completed: number;
}

/**
 * Sequential, one in-flight create call at a time, parent-before-child
 * (design.md Decision 15 — no `position` is ever sent, so pre-order
 * creation reproduces file order exactly). A node whose parent is missing
 * from `createdIds` (because the parent itself failed earlier in THIS run)
 * is recorded as a `missing-parent` failure and never attempted.
 *
 * Refuses up front — before any create call — when `plan.length` exceeds
 * `IMPORT_NODE_CEILING` (Requirement: Import Size Ceiling).
 */
export async function runImportPlan(options: RunImportPlanOptions): Promise<RunImportPlanResult> {
  if (options.plan.length > IMPORT_NODE_CEILING) {
    throw new ImportCeilingError(options.plan.length);
  }

  const createdIds: Record<string, string> = { ...options.createdIds };
  const failures: ImportFailure[] = [];
  let completed = 0;
  const total = options.plan.length;

  for (const item of options.plan) {
    options.onProgress?.(completed, total, item.key);

    const parentId: string | null | undefined = item.parentKey === null ? options.destinationFolderId : createdIds[item.parentKey];
    if (item.parentKey !== null && !parentId) {
      failures.push({
        key: item.key,
        label: item.label,
        kind: item.kind,
        reason: "Its parent folder failed to create, so this item was never attempted.",
        cause: "missing-parent",
      });
      continue;
    }

    // Defensive only: a bookmark can never legally target the workspace
    // root (bookmarks.folder_id is NOT NULL). The UI's pre-flight check
    // (Decision 17) refuses this case before a run ever starts.
    if (item.kind === "bookmark" && !parentId) {
      failures.push({
        key: item.key,
        label: item.label,
        kind: item.kind,
        reason: "A bookmark cannot be created at the workspace root.",
        cause: "missing-parent",
      });
      continue;
    }

    try {
      const serverId = item.kind === "folder" ? await options.create.createFolder(parentId ?? null, item) : await options.create.createBookmark(parentId as string, item);
      createdIds[item.key] = serverId;
      completed += 1;
    } catch (error) {
      failures.push({
        key: item.key,
        label: item.label,
        kind: item.kind,
        reason: error instanceof Error ? error.message : "Request failed.",
        cause: "request",
      });
    }
  }

  options.onProgress?.(completed, total, null);

  return { createdIds, failures, completed };
}

/**
 * `retryFailed()` never re-runs the whole plan: re-running everything would
 * duplicate every folder that already succeeded (design.md Decision 16).
 * Filters the ORIGINAL plan by the failed key set, so pre-order is
 * preserved for the retried subset.
 */
export function retryFailedPlan(fullPlan: ImportItem[], failures: ImportFailure[]): ImportItem[] {
  const failedKeys = new Set(failures.map((failure) => failure.key));
  return fullPlan.filter((item) => failedKeys.has(item.key));
}
