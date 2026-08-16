import type { ConvergenceJournal, ConvergenceOperation } from "../shared/types.js";

export type DesiredNode = { backendId: string; parentId?: string; type: "folder" | "bookmark"; title?: string; url?: string; position: number };
export type InventoryNode = { chromeId: string; parentChromeId?: string; type: "folder" | "bookmark"; title?: string; url?: string; position: number; managed: boolean };
type Input = { epoch: number; snapshotId: string; cursor: number; managedRootChromeId: string; desired: DesiredNode[]; inventory: InventoryNode[]; mappings: { backendToChrome?: Record<string, string>; chromeToBackend?: Record<string, string> } };
export type LocalIntentInput = { workspaceId: string; backendId: string; chromeId: string; type: "folder" | "bookmark"; kind: string; node: { parentId?: string; index?: number; title: string; url?: string } };

export function emptyJournal(): ConvergenceJournal {
  return { version: 1, phase: "plan", operations: [], localIntents: [], attempts: 0 };
}

export function normalizeJournal(value: Partial<ConvergenceJournal> | undefined): ConvergenceJournal {
  const journal = { ...emptyJournal(), ...value, operations: value?.operations ?? [], localIntents: value?.localIntents ?? [] } as ConvergenceJournal;
  if (journal.operations.length > 500) return pause(journal, "operation-overflow");
  if (journal.localIntents.length > 100) return pause(journal, "intent-overflow");
  return journal.operations.some((operation) => operation.status === "started") ? pause(journal, "ambiguous-operation") : journal;
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

export function checkpoint(journal: ConvergenceJournal, epoch: number): ConvergenceJournal {
  if (journal.phase === "paused" || journal.epoch !== epoch || journal.queuedEpoch === undefined) return journal;
  return { ...journal, epoch: Math.max(journal.epoch, journal.queuedEpoch), queuedEpoch: undefined, phase: "plan" };
}

function operation(epoch: number, node: DesiredNode, kind: "create" | "adopt" | "reconcile", chromeId?: string): ConvergenceOperation {
  const fingerprint = JSON.stringify([node.type, node.parentId ?? null, node.position, node.title ?? null, node.url ?? null]);
  return { id: `${epoch}:${node.backendId}:${kind}:${fingerprint}`, kind, backendId: node.backendId, chromeId, fingerprint, status: "planned" };
}
function sameNode(actual: InventoryNode, desired: DesiredNode): boolean { return actual.type === desired.type && actual.position === desired.position && actual.title === desired.title && actual.url === desired.url; }
function isBijection(forward: Record<string, string>, inverse: Record<string, string>): boolean { return Object.entries(forward).every(([backendId, chromeId]) => inverse[chromeId] === backendId) && Object.entries(inverse).every(([chromeId, backendId]) => forward[backendId] === chromeId); }
function pause(journal: ConvergenceJournal, pauseReason: NonNullable<ConvergenceJournal["pauseReason"]>): ConvergenceJournal { return { ...journal, phase: "paused", pauseReason }; }
