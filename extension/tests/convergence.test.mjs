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

test("receipt reduction requires complete matching shapes and rejects hidden-field mismatches without queuing a phantom intent", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/after" }, eventId: "event-9", cursor: 9 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/hidden" } });
  assert.equal(result.disposition, "rejected");
  assert.equal(result.journal.receipts[0].status, "pending");
  assert.equal(result.journal.localIntents.length, 0);
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

test("update receipts retain predecessor/final proof across restart, reject a mismatched reorder, and only queue the genuine post-consumption duplicate", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/after" }, eventId: "event-12", cursor: 12 });
  const restored = convergence.normalizeJournal(JSON.parse(JSON.stringify({ ...convergence.emptyJournal(), receipts: [receipt] })));
  const mismatch = convergence.reduceRemoteCallback(restored, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/hidden" } });
  const consumed = convergence.reduceRemoteCallback(mismatch.journal, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/after" } });
  const duplicate = convergence.reduceRemoteCallback(consumed.journal, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" } });
  assert.deepEqual(receipt.expectedSignatures.length, 2);
  assert.equal(mismatch.disposition, "rejected");
  assert.equal(mismatch.journal.localIntents.length, 0);
  assert.equal(consumed.disposition, "consumed");
  assert.equal(duplicate.disposition, "intent");
  assert.equal(duplicate.journal.localIntents.length, 1);
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
  assert.equal(secondFirst.disposition, "rejected");
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

// --- extension-sync-pause-recovery: ADR-001/002 canonicalized URL comparison ---

test("T-U1 canonicalUrlForComparison treats a bare-origin URL and Chrome's trailing-slash form as equal (the confirmed incident)", () => {
  assert.equal(convergence.canonicalUrlForComparison("https://admin.com"), convergence.canonicalUrlForComparison("https://admin.com/"));
});

test("T-U2 canonicalUrlForComparison strips default ports", () => {
  assert.equal(convergence.canonicalUrlForComparison("https://x:443/a"), convergence.canonicalUrlForComparison("https://x/a"));
  assert.equal(convergence.canonicalUrlForComparison("http://x:80/"), convergence.canonicalUrlForComparison("http://x/"));
});

test("T-U3 canonicalUrlForComparison lowercases scheme and host", () => {
  assert.equal(convergence.canonicalUrlForComparison("HTTPS://Admin.COM/"), convergence.canonicalUrlForComparison("https://admin.com/"));
});

test("T-U4 canonicalUrlForComparison keeps genuinely distinct URLs distinct", () => {
  assert.notEqual(convergence.canonicalUrlForComparison("https://x/a"), convergence.canonicalUrlForComparison("https://x/b"));
  assert.notEqual(convergence.canonicalUrlForComparison("https://x/a%2Fb"), convergence.canonicalUrlForComparison("https://x/a/b"));
  assert.notEqual(convergence.canonicalUrlForComparison("https://x/?q=1"), convergence.canonicalUrlForComparison("https://x/"));
  assert.notEqual(convergence.canonicalUrlForComparison("https://x/#a"), convergence.canonicalUrlForComparison("https://x/#b"));
});

test("T-U5 canonicalUrlForComparison is total (C3): never throws, unparseable input returns raw unchanged", () => {
  for (const raw of ["", "   ", "not a url", "javascript:void(0)", "file:///tmp/x", "chrome://bookmarks"]) {
    assert.doesNotThrow(() => convergence.canonicalUrlForComparison(raw));
  }
  assert.equal(convergence.canonicalUrlForComparison(""), "");
  assert.equal(convergence.canonicalUrlForComparison("   "), "   ");
  assert.equal(convergence.canonicalUrlForComparison("not a url"), "not a url");
});

test("T-U6 canonicalUrlForComparison is idempotent", () => {
  for (const raw of ["https://admin.com", "https://admin.com/", "https://x:443/a", "http://x:80/", "HTTPS://Admin.COM/", "https://x/a", "https://x/a%2Fb", "https://x/?q=1", "https://x/#a", "", "   ", "not a url", "javascript:void(0)", "file:///tmp/x", "chrome://bookmarks"]) {
    const once = convergence.canonicalUrlForComparison(raw);
    assert.equal(convergence.canonicalUrlForComparison(once), once);
  }
});

test("T-C1 regression: bare-origin receipt is consumed by Chrome's normalized trailing-slash callback", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", before: { parentId: "folder-a", index: 0, title: "Admin", url: "https://admin.com/old" }, expectedAfter: { parentId: "folder-a", index: 0, title: "Admin", url: "https://admin.com" }, eventId: "event-t-c1", cursor: 20 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-a", chromeId: "chrome-a", type: "bookmark", node: { parentId: "folder-a", index: 0, title: "Admin", url: "https://admin.com/" } });
  assert.equal(result.disposition, "consumed");
  assert.equal(result.journal.receipts[0].status, "consumed");
  assert.equal(result.journal.localIntents.length, 0);
});

test("T-C2 identical raw URLs still consume (no behavior change for the common case)", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-b", chromeId: "chrome-b", type: "bookmark", before: { parentId: "folder-a", index: 1, title: "Before", url: "https://example.com/x" }, expectedAfter: { parentId: "folder-a", index: 1, title: "After", url: "https://example.com/x" }, eventId: "event-t-c2", cursor: 21 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-b", chromeId: "chrome-b", type: "bookmark", node: { parentId: "folder-a", index: 1, title: "After", url: "https://example.com/x" } });
  assert.equal(result.disposition, "consumed");
});

test("T-C5 different parentId or different index never consumes", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-c", chromeId: "chrome-c", type: "bookmark", before: { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/x" }, expectedAfter: { parentId: "folder-a", index: 2, title: "After", url: "https://example.com/x" }, eventId: "event-t-c5a", cursor: 22 });
  const wrongParent = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-c", chromeId: "chrome-c", type: "bookmark", node: { parentId: "folder-b", index: 2, title: "After", url: "https://example.com/x" } });
  const wrongIndex = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-c", chromeId: "chrome-c", type: "bookmark", node: { parentId: "folder-a", index: 3, title: "After", url: "https://example.com/x" } });
  assert.notEqual(wrongParent.disposition, "consumed");
  assert.equal(wrongParent.journal.receipts[0].status, "pending");
  assert.notEqual(wrongIndex.disposition, "consumed");
  assert.equal(wrongIndex.journal.receipts[0].status, "pending");
});

test("T-C6 folder receipt (url undefined on both sides) consumes on title match", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "folder-b", chromeId: "chrome-d", type: "folder", before: { parentId: "root", index: 0, title: "Before" }, expectedAfter: { parentId: "root", index: 0, title: "After" }, eventId: "event-t-c6", cursor: 23 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "folder-b", chromeId: "chrome-d", type: "folder", node: { parentId: "root", index: 0, title: "After" } });
  assert.equal(result.disposition, "consumed");
  assert.equal(result.journal.receipts[0].status, "consumed");
});

test("T-C7 move semantics preserved: changed-kind against a move receipt never consumes; moved-kind with matching move and canonically-equal url consumes", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-e", chromeId: "chrome-e", type: "bookmark", before: { parentId: "folder-a", index: 0, title: "Same", url: "https://admin.com" }, expectedAfter: { parentId: "folder-b", index: 1, title: "Same", url: "https://admin.com" }, eventId: "event-t-c7", cursor: 24, move: { oldParentId: "folder-a", oldIndex: 0, parentId: "folder-b", index: 1 } });
  const changedKind = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-e", chromeId: "chrome-e", type: "bookmark", node: { parentId: "folder-b", index: 1, title: "Same", url: "https://admin.com/" } });
  assert.notEqual(changedKind.disposition, "consumed");
  const movedKind = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "moved", workspaceId: "workspace-a", backendId: "bookmark-e", chromeId: "chrome-e", type: "bookmark", node: { parentId: "folder-b", index: 1, title: "Same", url: "https://admin.com/" }, move: { oldParentId: "folder-a", oldIndex: 0, parentId: "folder-b", index: 1 } });
  assert.equal(movedKind.disposition, "consumed");
});

test("T-B1 a pre-fix raw-signature receipt still passes validReceipt (backwards compatibility, the release-day landmine)", () => {
  const before = { parentId: "folder-a", index: 2, title: "Before", url: "https://example.com/before" };
  const expectedAfter = { parentId: "folder-a", index: 2, title: "After", url: "https://admin.com" };
  // Hand-written literal strings — NOT computed via shapeSignature() — reproducing exactly what
  // the pre-fix raw shapeSignature() would have persisted for this before/expectedAfter pair.
  const preFixSignatures = [
    '["folder-a",2,"Before","https://example.com/before"]',
    '["folder-a",2,"After","https://admin.com"]',
  ];
  const receipt = { version: 1, workspaceId: "workspace-a", backendId: "bookmark-f", chromeId: "chrome-f", type: "bookmark", before, expectedAfter, eventId: "event-t-b1", cursor: 25, status: "pending", expectedSignatures: preFixSignatures };
  const result = convergence.normalizeJournal({ ...convergence.emptyJournal(), receipts: [receipt] });
  assert.notEqual(result.phase, "paused");
  assert.notEqual(result.pauseReason, "ambiguous-operation");
});

// --- extension-sync-pause-recovery: ADR-003 "rejected" disposition, no phantom intent ---

test("T-C3 C2 guard: same URL but different title never consumes, and is rejected (title is never normalized)", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-g", chromeId: "chrome-g", type: "bookmark", before: { parentId: "folder-a", index: 0, title: "Before", url: "https://admin.com" }, expectedAfter: { parentId: "folder-a", index: 0, title: "Expected Title", url: "https://admin.com" }, eventId: "event-t-c3", cursor: 26 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-g", chromeId: "chrome-g", type: "bookmark", node: { parentId: "folder-a", index: 0, title: "Different Title", url: "https://admin.com/" } });
  assert.equal(result.disposition, "rejected");
});

test("T-C4 genuinely different URL is rejected, not consumed", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-h", chromeId: "chrome-h", type: "bookmark", before: { parentId: "folder-a", index: 0, title: "Same", url: "https://example.com/old" }, expectedAfter: { parentId: "folder-a", index: 0, title: "Same", url: "https://example.com/expected" }, eventId: "event-t-c4", cursor: 27 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-h", chromeId: "chrome-h", type: "bookmark", node: { parentId: "folder-a", index: 0, title: "Same", url: "https://other.com/" } });
  assert.equal(result.disposition, "rejected");
});

test("T-C8 validReceipt gate intact: a tampered expectedSignatures[1] never consumes, even when the shape matches", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-i", chromeId: "chrome-i", type: "bookmark", before: { parentId: "folder-a", index: 0, title: "Same", url: "https://admin.com" }, expectedAfter: { parentId: "folder-a", index: 0, title: "Same", url: "https://admin.com" }, eventId: "event-t-c8", cursor: 28 });
  const tampered = { ...receipt, expectedSignatures: [receipt.expectedSignatures[0], "tampered-signature"] };
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [tampered] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-i", chromeId: "chrome-i", type: "bookmark", node: { parentId: "folder-a", index: 0, title: "Same", url: "https://admin.com/" } });
  assert.notEqual(result.disposition, "consumed");
});

test("T-I1 identity-matching but shape-mismatching callback is rejected at the receipt's own cursor, with no phantom intent queued", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "bookmark-j", chromeId: "chrome-j", type: "bookmark", before: { parentId: "folder-a", index: 0, title: "Before", url: "https://example.com/before" }, expectedAfter: { parentId: "folder-a", index: 0, title: "Expected", url: "https://example.com/expected" }, eventId: "event-t-i1", cursor: 29 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-j", chromeId: "chrome-j", type: "bookmark", node: { parentId: "folder-a", index: 0, title: "Unexpected", url: "https://example.com/unexpected" } });
  assert.equal(result.disposition, "rejected");
  assert.equal(result.cursor, receipt.cursor);
  assert.equal(result.journal.localIntents.length, 0);
});

test("T-I2 a callback with no pending receipt for its identity is still captured as a genuine local-edit intent", () => {
  const result = convergence.reduceRemoteCallback(convergence.emptyJournal(), { kind: "changed", workspaceId: "workspace-a", backendId: "bookmark-k", chromeId: "chrome-k", type: "bookmark", node: { parentId: "folder-a", index: 0, title: "Local Edit", url: "https://example.com/local" } });
  assert.equal(result.disposition, "intent");
  assert.equal(result.journal.localIntents.length, 1);
});

test("T-I3 identity mismatch on type only (folder vs bookmark) is captured as intent, not rejected", () => {
  const receipt = convergence.createRemoteReceipt({ workspaceId: "workspace-a", backendId: "shared-id", chromeId: "chrome-l", type: "folder", before: { parentId: "root", index: 0, title: "Before" }, expectedAfter: { parentId: "root", index: 0, title: "After" }, eventId: "event-t-i3", cursor: 30 });
  const result = convergence.reduceRemoteCallback({ ...convergence.emptyJournal(), receipts: [receipt] }, { kind: "changed", workspaceId: "workspace-a", backendId: "shared-id", chromeId: "chrome-l", type: "bookmark", node: { parentId: "root", index: 0, title: "After", url: "https://example.com/x" } });
  assert.equal(result.disposition, "intent");
  assert.equal(result.journal.localIntents.length, 1);
});

// --- extension-sync-pause-recovery: ADR-005 rebuildJournal drops queued local intents ---

test("T-R1 rebuildJournal keeps only acked local intents", () => {
  const journal = { ...convergence.emptyJournal(), localIntents: [
    { eventId: "intent-queued", kind: "changed", payload: {}, status: "queued" },
    { eventId: "intent-sent", kind: "changed", payload: {}, status: "sent" },
    { eventId: "intent-acked", kind: "changed", payload: {}, status: "acked" },
  ] };
  const rebuilt = convergence.rebuildJournal(journal);
  assert.deepEqual(rebuilt.localIntents.map((intent) => intent.eventId), ["intent-acked"]);
});

test("T-R2 rebuildJournal drops pending receipts, keeps consumed ones, clears pauseReason/failedCursor, and sets phase/repairDisposition", () => {
  const pending = { status: "pending", cursor: 1, expectedSignatures: [] };
  const consumed = { status: "consumed", cursor: 2, expectedSignatures: [] };
  const journal = { ...convergence.emptyJournal(), phase: "paused", pauseReason: "final-verification-failed", failedCursor: 8, receipts: [pending, consumed], localIntents: [{ eventId: "e1", kind: "changed", payload: {}, status: "queued" }] };
  const rebuilt = convergence.rebuildJournal(journal);
  assert.deepEqual(rebuilt.receipts, [consumed]);
  assert.equal(rebuilt.phase, "replay");
  assert.equal(rebuilt.repairDisposition, "rebuild");
  assert.equal(rebuilt.pauseReason, undefined);
  assert.equal(rebuilt.failedCursor, undefined);
  assert.deepEqual(rebuilt.localIntents, []);
});

test("T-R3 retryJournal leaves localIntents untouched (deliberate asymmetry with rebuildJournal)", () => {
  const journal = convergence.gateRemoteEffect({ ...convergence.emptyJournal(), localIntents: [{ eventId: "e1", kind: "changed", payload: {}, status: "queued" }] }, 3, "final-verification-failed");
  const retried = convergence.retryJournal(journal);
  assert.deepEqual(retried.localIntents, journal.localIntents);
  assert.equal(retried.localIntents.length, 1);
});

// --- extension-create-ownership-url-normalization: ADR-102 sameUrl becomes public API ---

test("T-U7 sameUrl is exported and undefined-safe in both directions, symmetric on the incident pair", () => {
  assert.equal(convergence.sameUrl(undefined, undefined), true);
  assert.equal(convergence.sameUrl("https://x/", undefined), false);
  assert.equal(convergence.sameUrl(undefined, "https://x/"), false);
  assert.equal(convergence.sameUrl("https://pruebs/", "https://pruebs"), true);
  assert.equal(convergence.sameUrl("https://pruebs", "https://pruebs/"), true);
  assert.equal(convergence.sameUrl("https://a/", "https://b/"), false);
});

// --- extension-create-ownership-url-normalization: ADR-103 rebuildJournal drops non-done operations ---

test("T-R4 rebuildJournal keeps only done operations (the incident, unit level)", () => {
  const stuck = { id: "11:workspace-a:create", kind: "create", backendId: "backend-11", fingerprint: "f", status: "started", ownership: { workspaceId: "workspace-a", type: "bookmark", parentChromeId: "parent", title: "Remote", url: "https://pruebs", index: 0 } };
  const doneOp = { id: "5:workspace-a:create", kind: "create", backendId: "backend-5", fingerprint: "f2", status: "done" };
  const journal = { ...convergence.emptyJournal(), operations: [stuck, doneOp] };
  const rebuilt = convergence.rebuildJournal(journal);
  assert.deepEqual(rebuilt.operations, [doneOp]);
  assert.equal(rebuilt.phase, "replay");
  assert.equal(rebuilt.pauseReason, undefined);
  assert.equal(rebuilt.failedCursor, undefined);
});

test("T-R5 rebuildJournal keeps all operations, in order, when every operation is already done", () => {
  const operations = [
    { id: "1:workspace-a:create", kind: "create", backendId: "backend-1", fingerprint: "f1", status: "done" },
    { id: "2:workspace-a:create", kind: "create", backendId: "backend-2", fingerprint: "f2", status: "done" },
  ];
  const journal = { ...convergence.emptyJournal(), operations };
  const rebuilt = convergence.rebuildJournal(journal);
  assert.deepEqual(rebuilt.operations, operations);
});

test("T-R6 retryJournal leaves a started operation untouched (deliberate asymmetry with rebuildJournal)", () => {
  const started = { id: "11:workspace-a:create", kind: "create", backendId: "backend-11", fingerprint: "f", status: "started", ownership: { workspaceId: "workspace-a", type: "bookmark", parentChromeId: "parent", title: "Remote", url: "https://pruebs", index: 0 } };
  const journal = convergence.gateRemoteEffect({ ...convergence.emptyJournal(), operations: [started] }, 11, "ambiguous-operation");
  const retried = convergence.retryJournal(journal);
  assert.deepEqual(retried.operations, [started]);
});

test("T-R7 normalizeJournal(rebuildJournal(stuckJournal)) is not paused with ambiguous-operation", () => {
  const stuck = { id: "11:workspace-a:create", kind: "create", backendId: "backend-11", fingerprint: "f", status: "started", ownership: { workspaceId: "workspace-a", type: "bookmark", parentChromeId: "parent", title: "Remote", url: "https://pruebs", index: 0 } };
  const stuckJournal = { ...convergence.emptyJournal(), phase: "paused", pauseReason: "ambiguous-operation", operations: [stuck] };
  const rebuilt = convergence.normalizeJournal(convergence.rebuildJournal(stuckJournal));
  assert.notEqual(rebuilt.phase, "paused");
  assert.notEqual(rebuilt.pauseReason, "ambiguous-operation");
});
