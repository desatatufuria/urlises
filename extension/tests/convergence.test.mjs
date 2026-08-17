import test from "node:test";
import assert from "node:assert/strict";

const convergence = await import("../dist/background/convergence.js");

const desired = [{ backendId: "folder-a", type: "folder", title: "A", position: 0 }];
const root = { chromeId: "managed-root-42", type: "folder", managed: true, position: 0 };
const base = { epoch: 4, snapshotId: "snapshot-1", cursor: 9, managedRootChromeId: root.chromeId, desired, inventory: [root], mappings: {} };

test("same snapshot has stable operation IDs and ambiguous candidates never create", () => {
  const input = base;
  assert.deepEqual(convergence.plan(input), convergence.plan(input));
  const ambiguous = convergence.plan({ ...input, inventory: [root,
    { chromeId: "a", parentChromeId: root.chromeId, type: "folder", title: "A", position: 0, managed: true },
    { chromeId: "b", parentChromeId: root.chromeId, type: "folder", title: "A", position: 0, managed: true },
  ] });
  assert.equal(ambiguous.pauseReason, "identity-ambiguous");
  assert.equal(ambiguous.operations.length, 0);
  const collisionA = convergence.plan({ ...base, desired: [{ backendId: "bookmark", type: "bookmark", title: "A:B", url: "C", position: 0 }] });
  const collisionB = convergence.plan({ ...base, desired: [{ backendId: "bookmark", type: "bookmark", title: "A", url: "B:C", position: 0 }] });
  assert.notEqual(collisionA.operations[0].id, collisionB.operations[0].id);
});

test("planner pauses invalid bijections and never deletes outside supplied managed inventory", () => {
  const input = { ...base, epoch: 1, desired: [], mappings: { backendToChrome: { a: "x", b: "x" }, chromeToBackend: { x: "a" }, }, inventory: [root, { chromeId: "outside", type: "bookmark", managed: false, position: 0 }] };
  assert.equal(convergence.plan(input).pauseReason, "mapping-not-bijective");
  const deletion = convergence.plan({ ...input, mappings: {}, inventory: [root, { chromeId: "inside", type: "bookmark", managed: true, position: 0 }, { chromeId: "outside", type: "bookmark", managed: false, position: 0 }] });
  assert.deepEqual(deletion.operations.map((op) => op.chromeId), ["inside"]);
  assert.equal(convergence.plan({ ...base, managedRootChromeId: "missing" }).pauseReason, "managed-root-missing");
});

test("adoption is claimed and mapped nodes are validated and reconciled", () => {
  const adopted = { chromeId: "adopted", parentChromeId: root.chromeId, type: "folder", title: "A", position: 0, managed: true };
  const adoption = convergence.plan({ ...base, inventory: [root, adopted] });
  assert.deepEqual(adoption.operations.map((op) => [op.kind, op.chromeId]), [["adopt", "adopted"]]);
  const mappings = { backendToChrome: { "folder-a": "adopted" }, chromeToBackend: { adopted: "folder-a" } };
  assert.deepEqual(convergence.plan({ ...base, inventory: [root, adopted], mappings }).operations, []);
  assert.equal(convergence.plan({ ...base, mappings }).pauseReason, "stale-mapping");
  const divergent = convergence.plan({ ...base, inventory: [root, { ...adopted, title: "Old" }], mappings });
  assert.deepEqual(divergent.operations.map((op) => [op.kind, op.chromeId]), [["reconcile", "adopted"]]);
});

test("scheduler coalesces latest epoch and stale checkpoints stop", () => {
  let journal = convergence.emptyJournal();
  journal = convergence.requestEpoch(journal, 1);
  journal = convergence.requestEpoch(journal, 5);
  journal = convergence.requestEpoch(journal, 3);
  assert.deepEqual([journal.epoch, journal.queuedEpoch], [1, 5]);
  journal = convergence.checkpoint(journal, 1);
  assert.deepEqual([journal.epoch, journal.queuedEpoch], [5, undefined]);
  assert.equal(convergence.checkpoint(journal, 1).epoch, 5);
  const otherWorkspace = convergence.requestEpoch(convergence.emptyJournal(), 9);
  assert.deepEqual([journal.epoch, otherWorkspace.epoch], [5, 9]);
  const paused = convergence.requestEpoch({ ...convergence.emptyJournal(), epoch: 1, queuedEpoch: 2, phase: "paused", pauseReason: "stale-mapping" }, 5);
  assert.deepEqual([paused.phase, convergence.checkpoint(paused, 1).phase], ["paused", "paused"]);
});

test("caps, legacy migration, and started restart ambiguity pause safely", () => {
  assert.equal(convergence.normalizeJournal({ operations: Array(501).fill({}) }).pauseReason, "operation-overflow");
  assert.equal(convergence.normalizeJournal({ localIntents: Array(101).fill({}) }).pauseReason, "intent-overflow");
  assert.deepEqual(convergence.normalizeJournal(undefined), convergence.emptyJournal());
  assert.equal(convergence.normalizeJournal({ version: 1, operations: [{ status: "started" }] }).pauseReason, "ambiguous-operation");
});

test("intent capture uses a stable contained identity and never prunes queued intent", () => {
  const journal = convergence.captureLocalIntent(convergence.emptyJournal(), {
    workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", kind: "changed",
    node: { parentId: "folder-a", index: 2, title: "Renamed", url: "https://example.com/renamed" },
  });
  const repeated = convergence.captureLocalIntent(journal, {
    workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", kind: "changed",
    node: { parentId: "folder-a", index: 2, title: "Renamed", url: "https://example.com/renamed" },
  });
  assert.equal(journal.localIntents.length, 1);
  assert.equal(repeated.localIntents.length, 1);
  assert.equal(repeated.localIntents[0].eventId, journal.localIntents[0].eventId);
  assert.deepEqual(journal.localIntents[0].payload, {
    workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", kind: "changed",
    node: { id: "chrome-a", parentId: "folder-a", index: 2, title: "Renamed", url: "https://example.com/renamed" },
  });
  const full = convergence.captureLocalIntent({ ...convergence.emptyJournal(), localIntents: Array.from({ length: 100 }, (_, index) => ({ eventId: `old-${index}`, kind: "changed", payload: {}, status: "queued" })) }, {
    workspaceId: "workspace-a", backendId: "bookmark-b", chromeId: "chrome-b", type: "bookmark", kind: "moved",
    node: { parentId: "folder-a", index: 3, title: "Second", url: "https://example.com/second" },
  });
  assert.equal(full.pauseReason, "intent-overflow");
  assert.equal(full.localIntents.length, 101);
});

test("receipt reduction requires complete matching shapes and queues hidden-field mismatches", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/after" }, eventId: "event-9", cursor: 9 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/hidden" } });
  assert.equal(result.disposition, "intent");
  assert.equal(result.journal.receipts[0].status, "pending");
  assert.equal(result.journal.localIntents.length, 1);
});

test("only one exact pending receipt consumes; duplicate callbacks stay intent-driven", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-b", index: 3, title: "After", url: "https://example.com/after" }, eventId: "event-10", cursor: 10, move: { oldParentId: "folder-a", oldIndex: 2, parentId: "folder-b", index: 3 } });
  const callback = { kind: "moved", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-b", index: 3, title: "After", url: "https://example.com/after" }, move: { oldParentId: "folder-a", oldIndex: 2, parentId: "folder-b", index: 3 } };
  const consumed = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, callback);
  const duplicate = convergence.reduceRemoteCallback(consumed.journal, callback);
  assert.equal(consumed.disposition, "consumed");
  assert.equal(consumed.journal.receipts[0].status, "consumed");
  assert.equal(duplicate.disposition, "intent");
  assert.equal(duplicate.journal.localIntents.length, 1);
});

test("update receipts retain predecessor/final proof across restart and queue reordered callbacks", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/after" }, eventId: "event-12", cursor: 12 });
  const restored = convergence.normalizeJournal(JSON.parse(JSON.stringify({ ...convergence.emptyJournal(), receipts: [receipt] })));
  const mismatch = convergence.reduceRemoteCallback(restored, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/hidden" } });
  const consumed = convergence.reduceRemoteCallback(mismatch.journal, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/after" } });
  const duplicate = convergence.reduceRemoteCallback(consumed.journal, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" } });
  assert.deepEqual(receipt.expectedSignatures.length, 2);
  assert.equal(mismatch.disposition, "intent");
  assert.equal(consumed.disposition, "consumed");
  assert.equal(duplicate.disposition, "intent");
  assert.equal(duplicate.journal.localIntents.length, 2);
});

test("restart retains pending receipt and intent without enabling remote application", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "folder-a", chromeId: "chrome-a", type: "folder", before: { parentId: "root", index: 0, title: "Before" }, expectedAfter: { parentId: "root", index: 1, title: "After" }, eventId: "event-11", cursor: 11 });
  const journal = convergence.captureLocalIntent({ ...convergence.emptyJournal(), receipts: [receipt] }, { workspaceId: "workspace-a", backendId: "folder-a", chromeId: "chrome-a", type: "folder", kind: "changed", node: { parentId: "root", index: 0, title: "Local" } });
  const restored = convergence.normalizeJournal(JSON.parse(JSON.stringify(journal)));
  assert.equal(restored.receipts[0].status, "pending");
  assert.equal(restored.localIntents.length, 1);
  assert.notEqual(restored.phase, "apply");
});

test("serialized move receipts enforce predecessor order after restart", () => {
  const first = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-a", index: 0, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-b", index: 1, title: "First", url: "https://example.com/first" }, eventId: "event-13", cursor: 13, move: { oldParentId: "folder-a", oldIndex: 0, parentId: "folder-b", index: 1 } });
  const second = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-b", index: 1, title: "First", url: "https://example.com/first" }, expectedAfter: { parentId: "folder-c", index: 2, title: "Second", url: "https://example.com/second" }, eventId: "event-14", cursor: 14, move: { oldParentId: "folder-b", oldIndex: 1, parentId: "folder-c", index: 2 } });
  const restored = convergence.normalizeJournal(JSON.parse(JSON.stringify({ ...convergence.emptyJournal(), receipts: [first, second] })));
  const secondFirst = convergence.reduceRemoteCallback(restored, { kind: "moved", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-c", index: 2, title: "Second", url: "https://example.com/second" }, move: { parentId: "folder-c", index: 2, oldParentId: "folder-b", oldIndex: 1 } });
  const firstConsumed = convergence.reduceRemoteCallback(secondFirst.journal, { kind: "moved", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-b", index: 1, title: "First", url: "https://example.com/first" }, move: first.move });
  const secondConsumed = convergence.reduceRemoteCallback(firstConsumed.journal, { kind: "moved", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-c", index: 2, title: "Second", url: "https://example.com/second" }, move: second.move });
  assert.equal(secondFirst.disposition, "intent");
  assert.deepEqual(secondFirst.journal.receipts.map((receipt) => receipt.status), ["pending", "pending"]);
  assert.deepEqual(firstConsumed.journal.receipts.map((receipt) => receipt.status), ["consumed", "pending"]);
  assert.deepEqual(secondConsumed.journal.receipts.map((receipt) => receipt.status), ["consumed", "consumed"]);
});

test("repair gate matrix pauses before unsafe effects and retains receipts and intents", () => {
  for (const reason of ["receipt-capacity", "durable-write-failed", "complete-node-read-failed", "final-verification-failed", "chrome-effect-rejected", "ambiguous-predecessor"]) {
    const journal = convergence.gateRemoteEffect({ ...convergence.emptyJournal(), receipts: [{ status: "pending", cursor: 7 }], localIntents: [{ eventId: "local-1", status: "queued" }] }, 8, reason);
    assert.equal(journal.phase, "paused", reason);
    assert.equal(journal.pauseReason, reason);
    assert.equal(journal.failedCursor, 8);
    assert.equal(journal.receipts.length, 1);
    assert.equal(journal.localIntents.length, 1);
    assert.equal(convergence.normalizeJournal({ ...journal, operations: [{ status: "started" }] }).pauseReason, reason);
  }
});

test("receipt capacity prunes only terminal safe receipts and retry keeps the failed cursor", () => {
  const consumed = Array.from({ length: 100 }, (_, cursor) => ({ status: "consumed", cursor }));
  assert.equal(convergence.canPersistReceipt({ ...convergence.emptyJournal(), receipts: consumed }, 101), true);
  const blocked = convergence.gateRemoteEffect({ ...convergence.emptyJournal(), receipts: [...consumed, { status: "pending", cursor: 101 }] }, 102, "receipt-capacity");
  assert.equal(convergence.retryJournal(blocked).phase, "paused");
  assert.equal(convergence.retryJournal(blocked).repairDisposition, "rebuild");
  assert.equal(convergence.retryJournal(blocked).failedCursor, 102);
});

test("bootstrap requires rebuild and retry cannot bypass the gate", () => {
  const blocked = convergence.gateRemoteEffect(convergence.emptyJournal(), 0, "bootstrap-required");
  assert.equal(blocked.phase, "paused");
  assert.equal(blocked.repairDisposition, "rebuild");
  assert.equal(convergence.retryJournal(blocked).phase, "paused");
  assert.equal(convergence.retryJournal(blocked).pauseReason, "bootstrap-required");
  const restored = convergence.normalizeJournal({ ...blocked, repairDisposition: "retry" });
  assert.equal(restored.repairDisposition, "rebuild");
  assert.equal(convergence.retryJournal(restored).phase, "paused");
});
