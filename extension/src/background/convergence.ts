import type { ConvergenceJournal, ConvergenceOperation, ReceiptNodeShape, RemoteReceipt } from "../shared/types.js";

export type DesiredNode = { backendId: string; parentId?: string; type: "folder" | "bookmark"; title?: string; url?: string; position: number };
export type InventoryNode = { chromeId: string; parentChromeId?: string; type: "folder" | "bookmark"; title?: string; url?: string; position: number; managed: boolean };
type Input = { epoch: number; snapshotId: string; cursor: number; managedRootChromeId: string; desired: DesiredNode[]; inventory: InventoryNode[]; mappings: { backendToChrome?: Record<string, string>; chromeToBackend?: Record<string, string> } };
export type LocalIntentInput = { workspaceId: string; backendId: string; chromeId: string; type: "folder" | "bookmark"; kind: string; node: { parentId?: string; index?: number; title: string; url?: string } };
export type RemoteReceiptInput = Omit<RemoteReceipt, "version" | "expectedSignatures" | "status">;
export type RemoteCallback = { kind: "changed" | "moved"; workspaceId: string; backendId: string; chromeId: string; type: "folder" | "bookmark"; node: ReceiptNodeShape; move?: RemoteReceipt["move"] };
export type RepairGate = NonNullable<ConvergenceJournal["pauseReason"]>;

export function emptyJournal(): ConvergenceJournal {
  return { version: 1, phase: "plan", operations: [], localIntents: [], attempts: 0 };
}

export function normalizeJournal(value: Partial<ConvergenceJournal> | undefined): ConvergenceJournal {
  const journal = { ...emptyJournal(), ...value, operations: value?.operations ?? [], localIntents: value?.localIntents ?? [] } as ConvergenceJournal;
  if (journal.operations.length > 500) return pause(journal, "operation-overflow");
  const receipts = pruneReceipts(value?.receipts ?? []);
  if (receipts.length) journal.receipts = receipts;
  if (receipts.length > 100) return pause(journal, "receipt-overflow");
  if (journal.localIntents.length > 100) return pause(journal, "intent-overflow");
  if (journal.phase === "paused" && journal.failedCursor !== undefined) {
    return journal.pauseReason === "bootstrap-required" ? { ...journal, repairDisposition: "rebuild" } : journal;
  }
  return journal.operations.some((operation) => operation.status === "started") || receipts.some((receipt) => !validReceipt(receipt)) ? pause(journal, "ambiguous-operation") : journal;
}

export function createRemoteReceipt(input: RemoteReceiptInput): RemoteReceipt { return { ...input, version: 1, expectedSignatures: [shapeSignature(input.before), shapeSignature(input.expectedAfter)], status: "pending" }; }
export function reduceRemoteCallback(
  journal: ConvergenceJournal,
  callback: RemoteCallback,
): { journal: ConvergenceJournal; disposition: "consumed" | "rejected" | "intent"; cursor?: number } {
  const receipts = journal.receipts ?? [],
    match = receipts.find((receipt) => receipt.status === "pending" && exactIdentity(receipt, callback));
  if (match && callbackMatches(match, callback))
    return { disposition: "consumed", journal: { ...journal, receipts: receipts.map((receipt) => receipt === match ? { ...receipt, status: "consumed" } : receipt) } };
  if (match) return { disposition: "rejected", journal: { ...journal, receipts }, cursor: match.cursor };
  return { disposition: "intent", journal: captureLocalIntent({ ...journal, receipts }, callback) };
}

export function captureLocalIntent(journal: ConvergenceJournal, input: LocalIntentInput): ConvergenceJournal {
  const payload = {
    workspaceId: input.workspaceId,
    backendId: input.backendId,
    chromeId: input.chromeId,
    type: input.type,
    kind: input.kind,
    node: { id: input.chromeId, parentId: input.node.parentId, index: input.node.index, title: input.node.title, url: input.node.url },
  };
  const eventId = `local-intent-v1:${JSON.stringify([payload.workspaceId, payload.backendId, payload.chromeId, payload.type, payload.kind, payload.node.parentId ?? null, payload.node.index ?? null, payload.node.title, payload.node.url ?? null])}`;
  if (journal.localIntents.some((intent) => intent.eventId === eventId)) return journal;
  const localIntents = [...journal.localIntents];
  while (localIntents.length >= 100) {
    const acknowledged = localIntents.findIndex((intent) => intent.status === "acked");
    if (acknowledged < 0) break;
    localIntents.splice(acknowledged, 1);
  }
  localIntents.push({ eventId, kind: input.kind, payload, status: "queued" });
  return localIntents.length > 100 ? pause({ ...journal, localIntents }, "intent-overflow") : { ...journal, localIntents };
}

export function plan(input: Input): ConvergenceJournal {
  const mappings = input.mappings.backendToChrome ?? {};
  const inverse = input.mappings.chromeToBackend ?? {};
  if (!isBijection(mappings, inverse)) return pause(emptyJournal(), "mapping-not-bijective");
  const inventory = input.inventory.filter((node) => node.managed);
  if (!inventory.some((node) => node.chromeId === input.managedRootChromeId)) return pause(emptyJournal(), "managed-root-missing");
  for (const [backendId, chromeId] of Object.entries(mappings)) {
    const node = input.desired.find((item) => item.backendId === backendId);
    const actual = inventory.find((item) => item.chromeId === chromeId);
    const parentChromeId = node?.parentId ? mappings[node.parentId] : input.managedRootChromeId;
    if (!node || !actual || chromeId === input.managedRootChromeId || !parentChromeId) return pause(emptyJournal(), "stale-mapping");
  }
  const operations: ConvergenceOperation[] = [];
  const claimed = new Set([input.managedRootChromeId, ...Object.values(mappings)]);
  for (const node of [...input.desired].sort((a, b) => a.backendId.localeCompare(b.backendId))) {
    const chromeId = mappings[node.backendId];
    const parentChromeId = node.parentId ? mappings[node.parentId] : input.managedRootChromeId;
    if (chromeId) {
      const actual = inventory.find((item) => item.chromeId === chromeId)!;
      if (actual.parentChromeId !== parentChromeId || !sameNode(actual, node)) operations.push(operation(input.epoch, node, "reconcile", chromeId));
      continue;
    }
    const candidates = parentChromeId ? inventory.filter((item) => item.chromeId !== input.managedRootChromeId && item.parentChromeId === parentChromeId && sameNode(item, node)) : [];
    if (candidates.length > 1 || (candidates[0] && claimed.has(candidates[0].chromeId))) return pause({ ...emptyJournal(), operations }, "identity-ambiguous");
    if (candidates[0]) claimed.add(candidates[0].chromeId);
    operations.push(operation(input.epoch, node, candidates[0] ? "adopt" : "create", candidates[0]?.chromeId));
  }
  for (const node of inventory.filter((item) => !claimed.has(item.chromeId)).sort((a, b) => a.chromeId.localeCompare(b.chromeId))) {
    operations.push({ id: `${input.epoch}:unknown:delete:${node.chromeId}`, kind: "delete", backendId: "unknown", chromeId: node.chromeId, fingerprint: node.chromeId, status: "planned" });
  }
  return normalizeJournal({ version: 1, epoch: input.epoch, desired: { snapshotId: input.snapshotId, cursor: input.cursor }, phase: "apply", operations, localIntents: [], attempts: 0 });
}

export function requestEpoch(journal: ConvergenceJournal, epoch: number): ConvergenceJournal {
  if (journal.epoch === undefined) return { ...journal, epoch: Math.max(journal.queuedEpoch ?? epoch, epoch), queuedEpoch: undefined };
  return epoch > Math.max(journal.epoch, journal.queuedEpoch ?? journal.epoch) ? { ...journal, queuedEpoch: epoch } : journal;
}

export function normalizedReceipts(receipts: RemoteReceipt[] = []): RemoteReceipt[] { return pruneReceipts(receipts); }
export function canPersistReceipt(journal: ConvergenceJournal, _cursor: number): boolean { return normalizedReceipts(journal.receipts).length < 100; }
export function gateRemoteEffect(journal: ConvergenceJournal, cursor: number, reason: RepairGate): ConvergenceJournal {
  return { ...journal, phase: "paused", pauseReason: reason, failedCursor: cursor, repairDisposition: reason === "bootstrap-required" ? "rebuild" : "retry" };
}
export function retryJournal(journal: ConvergenceJournal): ConvergenceJournal {
  if (journal.phase !== "paused") return journal;
  return journal.pauseReason === "bootstrap-required" || journal.repairDisposition === "rebuild" || journal.receipts?.some((receipt) => receipt.status === "pending")
    ? { ...journal, repairDisposition: "rebuild" }
    : { ...journal, phase: "replay", repairDisposition: "retry" };
}
export function rebuildJournal(journal: ConvergenceJournal): ConvergenceJournal {
  const receipts = normalizedReceipts((journal.receipts ?? []).filter((receipt) => receipt.status === "consumed"));
  const localIntents = (journal.localIntents ?? []).filter((intent) => intent.status === "acked");
  const operations = (journal.operations ?? []).filter((operation) => operation.status === "done");
  return { ...journal, phase: "replay", receipts, localIntents, operations, repairDisposition: "rebuild", pauseReason: undefined, failedCursor: undefined };
}

export function checkpoint(journal: ConvergenceJournal, epoch: number): ConvergenceJournal {
  if (journal.phase === "paused" || journal.epoch !== epoch || journal.queuedEpoch === undefined) return journal;
  return { ...journal, epoch: Math.max(journal.epoch, journal.queuedEpoch), queuedEpoch: undefined, phase: "plan" };
}

function operation(epoch: number, node: DesiredNode, kind: "create" | "adopt" | "reconcile", chromeId?: string): ConvergenceOperation {
  const fingerprint = JSON.stringify([node.type, node.parentId ?? null, node.position, node.title ?? null, node.url ?? null]);
  return { id: `${epoch}:${node.backendId}:${kind}:${fingerprint}`, kind, backendId: node.backendId, chromeId, fingerprint, status: "planned" };
}
function shapeSignature(shape: ReceiptNodeShape): string { return JSON.stringify([shape.parentId ?? null, shape.index ?? null, shape.title, shape.url ?? null]); }
export function canonicalUrlForComparison(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}
export function sameUrl(left: string | undefined, right: string | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return canonicalUrlForComparison(left) === canonicalUrlForComparison(right);
}
function sameShape(actual: ReceiptNodeShape, expected: ReceiptNodeShape): boolean {
  return (actual.parentId ?? null) === (expected.parentId ?? null)
    && (actual.index ?? null) === (expected.index ?? null)
    && actual.title === expected.title          // C2: strict equality, never normalized
    && sameUrl(actual.url, expected.url);
}
function exactIdentity(receipt: RemoteReceipt, callback: RemoteCallback): boolean { return receipt.workspaceId === callback.workspaceId && receipt.backendId === callback.backendId && receipt.chromeId === callback.chromeId && receipt.type === callback.type; }
function callbackMatches(receipt: RemoteReceipt, callback: RemoteCallback): boolean {
  return validReceipt(receipt)
    && sameShape(callback.node, receipt.expectedAfter)
    && (callback.kind === "changed"
      ? receipt.move === undefined
      : receipt.move !== undefined && callback.move !== undefined && sameMove(receipt.move, callback.move));
}
function sameMove(left: NonNullable<RemoteReceipt["move"]>, right: NonNullable<RemoteReceipt["move"]>): boolean { return left.oldParentId === right.oldParentId && left.oldIndex === right.oldIndex && left.parentId === right.parentId && left.index === right.index; }
function validReceipt(receipt: RemoteReceipt): boolean { return receipt.version === 1 && (receipt.status === "pending" || receipt.status === "consumed") && receipt.expectedSignatures?.[0] === shapeSignature(receipt.before) && receipt.expectedSignatures?.[1] === shapeSignature(receipt.expectedAfter); }
function pruneReceipts(receipts: RemoteReceipt[]): RemoteReceipt[] { const consumed = receipts.filter((receipt) => receipt.status === "consumed"); return receipts.filter((receipt) => receipt.status !== "consumed" || !consumed.slice(0, -20).includes(receipt)); }
function sameNode(actual: InventoryNode, desired: DesiredNode): boolean { return actual.type === desired.type && actual.position === desired.position && actual.title === desired.title && actual.url === desired.url; }
function isBijection(forward: Record<string, string>, inverse: Record<string, string>): boolean { return Object.entries(forward).every(([backendId, chromeId]) => inverse[chromeId] === backendId) && Object.entries(inverse).every(([chromeId, backendId]) => forward[backendId] === chromeId); }
function pause(journal: ConvergenceJournal, pauseReason: NonNullable<ConvergenceJournal["pauseReason"]>): ConvergenceJournal { return { ...journal, phase: "paused", pauseReason }; }
