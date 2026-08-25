import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createChromeHarness, workspaceTree } from "./helpers/fake-chrome.mjs";

globalThis.crypto ??= webcrypto;

let sequence = 0;
const fresh = (prefix) => `${prefix}-${++sequence}`;
const flushMicrotasks = async (turns = 96) => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const mutationResponse = (body, cursor) => new Response(JSON.stringify(body), {
  status: 201,
  headers: { "content-type": "application/json", "X-Sync-Event-Id": fresh("ack"), "X-Sync-Cursor": String(cursor) },
});
const bookmarkNode = (chrome, id) => new Promise((resolve) => chrome.bookmarks.get(id, ([node]) => resolve(node)));

function workspace(id) {
  return { workspaceId: id, workspaceName: `Workspace ${id}`, workspaceType: "team", organizationId: `org-${id}`, organizationName: `Organization ${id}`, role: "editor" };
}

function projectionState(currentWorkspace, { parentId, parentChromeId } = {}) {
  return {
    workspace: currentWorkspace,
    rootChromeId: "0",
    organizationChromeId: "2",
    workspaceChromeId: `workspace:${currentWorkspace.workspaceId}`,
    chromeIdByBackendId: parentId ? { [parentId]: parentChromeId } : {},
    backendIdByChromeId: parentId ? { [parentChromeId]: parentId } : {},
    entityTypeByBackendId: parentId ? { [parentId]: "folder" } : {},
    excludedBackendNodeIds: [],
    lastCursor: 0,
    status: "ready",
    health: "live",
    recoveryAttemptCount: 0,
  };
}

function stateFor(workspaces) {
  return {
    settings: { backendUrl: "https://api.test", clientId: fresh("client") },
    session: { accessToken: "token", expiresAt: "2999-01-01T00:00:00Z", clientId: "client", user: { id: "user", email: "user@test" } },
    selectedWorkspaceIds: workspaces.map(({ workspace: current }) => current.workspaceId),
    cachedOrganizations: [],
    cachedWorkspacesByOrganization: {},
    diagnostics: [],
    projectionsByWorkspaceId: Object.fromEntries(workspaces.map(({ workspace: current, parentId, parentChromeId }) => [
      current.workspaceId,
      projectionState(current, { parentId, parentChromeId }),
    ])),
  };
}

function remoteEvent(currentWorkspace, kind, payload, cursor = 1) {
  return {
    cursor,
    eventId: fresh("remote-event"),
    workspaceId: currentWorkspace.workspaceId,
    originClientId: "remote-client",
    kind,
    entityType: kind.split(".")[0],
    entityId: payload.id,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function runtime({ mode = "before", workspaces = [] } = {}) {
  const resolved = workspaces.length > 0 ? workspaces : [{ workspace: workspace(fresh("workspace")), parentId: fresh("parent"), parentChromeId: fresh("parent-chrome") }];
  const harness = createChromeHarness({ tree: workspaceTree(resolved.map(({ workspace: current, parentId, parentChromeId }) => ({
    id: current.workspaceId,
    title: current.workspaceName,
    folders: parentId ? [{ id: parentChromeId, title: parentId }] : [],
  }))) });
  harness.mutators.mode(mode);
  globalThis.chrome = harness.chrome;
  globalThis.fetch = harness.fetch.fetch;
  globalThis.WebSocket = harness.WebSocket;
  const storage = await import(`../dist/shared/storage.js?${fresh("storage")}`);
  const projection = await import(`../dist/background/projection.js?${fresh("projection")}`);
  projection.projectionTestHooks.resetRuntimeState();
  await storage.setState(stateFor(resolved));
  chrome.bookmarks.onCreated.addListener((id, node) => void projection.handleBookmarkCreated(id, node));
  return { harness, projection, storage, workspaces: resolved };
}

async function waitForHeldCreate(harness, expectedParentId) {
  for (let turn = 0; turn < 192; turn += 1) {
    if (harness.mutators.pending() === 1) {
      const children = await new Promise((resolve) => chrome.bookmarks.getChildren(expectedParentId, resolve));
      if (children.length === 1) return children[0];
    }
    await Promise.resolve();
  }
  assert.fail("remote create did not produce a held Chrome side effect");
}

function operation(state, workspaceId) {
  return state.projectionsByWorkspaceId[workspaceId].convergenceJournal?.operations[0];
}

for (const fixture of [
  { label: "folder", kind: "folder.created", payload: (ids) => ({ id: ids.backendId, workspaceId: ids.workspace.workspaceId, name: "Remote folder", position: 0 }) },
  { label: "bookmark", kind: "bookmark.created", payload: (ids) => ({ id: ids.backendId, workspaceId: ids.workspace.workspaceId, folderId: ids.parentId, title: "Remote bookmark", url: "https://remote.test", position: 0 }) },
]) {
  for (const mode of ["before", "delayed"]) {
    test(`remote ${fixture.label} create is owned when callback runs ${mode}`, async () => {
      const current = workspace(fresh("workspace"));
      const parentId = fixture.label === "bookmark" ? fresh("parent") : undefined;
      const parentChromeId = parentId ? fresh("parent-chrome") : undefined;
      const { harness, projection, storage, workspaces } = await runtime({ mode, workspaces: [{ workspace: current, parentId, parentChromeId }] });
      const payload = fixture.payload({ workspace: current, parentId, backendId: fresh("backend") });
      const apply = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, fixture.kind, payload));
      if (mode === "delayed") harness.mutators.flush([0]);
      await apply;
      await flushMicrotasks();
      const owned = operation(await storage.getState(), current.workspaceId);
      const mutations = harness.fetch.mutationCount();
      harness.teardown();
      assert.equal(owned?.status, "done", "RED: remote create must have durable completed ownership");
      assert.equal(mutations, 0, "owned callback must not create a domain mutation");
    });
  }

  test(`remote ${fixture.label} create suppresses its id but not a later local id of the same shape`, async () => {
    const current = workspace(fresh("workspace"));
    const parentId = fixture.label === "bookmark" ? fresh("parent") : undefined;
    const parentChromeId = parentId ? fresh("parent-chrome") : undefined;
    const { harness, projection, storage } = await runtime({ mode: "delayed", workspaces: [{ workspace: current, parentId, parentChromeId }] });
    harness.mutators.mode("delayed", 2);
    const payload = fixture.payload({ workspace: current, parentId, backendId: fresh("backend") });
    await projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, fixture.kind, payload));
    harness.mutators.flush([0]);
    await flushMicrotasks();
    const owned = operation(await storage.getState(), current.workspaceId);
    const remoteNode = await bookmarkNode(chrome, owned.chromeId);
    await projection.handleBookmarkCreated(owned.chromeId, remoteNode);
    projection.projectionTestHooks.resetRuntimeState();
    harness.fetch.respond(response({ eventId: fresh("ack"), cursor: 2, duplicate: false }, 201));
    harness.fetch.respond(response({ workspace: current, folders: [] }));
    harness.fetch.respond(response({ events: [], currentCursor: 2 }));
    const localId = fresh("local-chrome");
    await projection.handleBookmarkCreated(localId, { ...remoteNode, id: localId });
    const mutations = harness.fetch.mutationCount();
    harness.teardown();
    assert.equal(owned?.status, "done", "RED: duplicate callbacks require durable ownership");
    assert.equal(mutations, 1, "only the later local id must mutate the backend");
  });

  test(`remote ${fixture.label} creates remain owned when held callbacks are reordered`, async () => {
    const current = workspace(fresh("workspace"));
    const parentId = fixture.label === "bookmark" ? fresh("parent") : undefined;
    const parentChromeId = parentId ? fresh("parent-chrome") : undefined;
    const { harness, projection, storage } = await runtime({ mode: "held", workspaces: [{ workspace: current, parentId, parentChromeId }] });
    const first = fixture.payload({ workspace: current, parentId, backendId: fresh("backend") });
    const second = { ...fixture.payload({ workspace: current, parentId, backendId: fresh("backend") }), position: 1 };
    const applies = [
      projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, fixture.kind, first, 1)),
      projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, fixture.kind, second, 1)),
    ];
    await flushMicrotasks();
    assert.equal(harness.mutators.pending(), 2, "both real Chrome creates must be held");
    harness.mutators.flush([1, 0]);
    await Promise.all(applies);
    const owned = operation(await storage.getState(), current.workspaceId);
    const mutations = harness.fetch.mutationCount();
    harness.teardown();
    assert.equal(owned?.status, "done", "RED: reordered callbacks require durable ownership");
    assert.equal(mutations, 0);
  });
}

test("mapped remote id remains owned after its completed operation is pruned", async () => {
  const current = workspace(fresh("workspace"));
  const { harness, projection, storage } = await runtime({ workspaces: [{ workspace: current }] });
  const backendIds = Array.from({ length: 21 }, () => fresh("backend"));
  for (const [index, backendId] of backendIds.entries()) {
    await projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, "folder.created", { id: backendId, workspaceId: current.workspaceId, name: `Remote ${index}`, position: 0 }, index + 1));
  }
  const state = await storage.getState();
  const originalChromeId = state.projectionsByWorkspaceId[current.workspaceId].chromeIdByBackendId[backendIds[0]];
  assert.equal(state.projectionsByWorkspaceId[current.workspaceId].convergenceJournal.operations.some(({ backendId }) => backendId === backendIds[0]), false);
  projection.projectionTestHooks.resetRuntimeState();
  await projection.handleBookmarkCreated(originalChromeId, await bookmarkNode(chrome, originalChromeId));
  assert.equal(harness.fetch.mutationCount(), 0, "the persisted mapping must suppress a very late duplicate");
  harness.teardown();
});

for (const prunable of [true, false]) {
  test(`remote create at operation capacity ${prunable ? "prunes completed ownership" : "pauses without a Chrome effect"}`, async () => {
    const current = workspace(fresh("workspace"));
    const { harness, projection, storage } = await runtime({ workspaces: [{ workspace: current }] });
    await storage.updateState((state) => {
      state.projectionsByWorkspaceId[current.workspaceId].convergenceJournal = {
        version: 1, phase: "live", localIntents: [], attempts: 0,
        operations: Array.from({ length: 500 }, (_, index) => ({ id: `seed-${index}`, kind: "create", backendId: `seed-${index}`, fingerprint: "seed", status: prunable && index === 0 ? "done" : "planned", ...(prunable && index === 0 ? { ownership: { workspaceId: current.workspaceId, type: "folder", parentChromeId: "unused", title: "Old", index: 0 } } : {}) })),
      };
      return state;
    });
    const payload = { id: fresh("backend"), workspaceId: current.workspaceId, name: "At capacity", position: 0 };
    await projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, "folder.created", payload));
    const projected = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId];
    const children = await new Promise((resolve) => chrome.bookmarks.getChildren(`workspace:${current.workspaceId}`, resolve));
    assert.deepEqual([projected.convergenceJournal.operations.length, children.length, projected.convergenceJournal.phase, projected.convergenceJournal.pauseReason], [500, prunable ? 1 : 0, prunable ? "live" : "paused", prunable ? undefined : "operation-overflow"]);
    harness.teardown();
  });
}

test("remote create restart records ambiguity before a revived listener can emit another mutation", async () => {
  const current = workspace(fresh("workspace"));
  const { harness, projection, storage } = await runtime({ mode: "held", workspaces: [{ workspace: current }] });
  const payload = { id: fresh("backend"), workspaceId: current.workspaceId, name: "Restart folder", position: 0 };
  const apply = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, "folder.created", payload));
  const created = await waitForHeldCreate(harness, `workspace:${current.workspaceId}`);
  assert.equal(created.title, payload.name, "the real Chrome create completed before the callback");
  const persisted = harness.snapshot();
  harness.resetRuntime();
  const revived = createChromeHarness({ persisted });
  globalThis.chrome = revived.chrome;
  globalThis.fetch = revived.fetch.fetch;
  globalThis.WebSocket = revived.WebSocket;
  const restoredStorage = await import(`../dist/shared/storage.js?${fresh("restored-storage")}`);
  const restoredProjection = await import(`../dist/background/projection.js?${fresh("restored-projection")}`);
  restoredProjection.projectionTestHooks.resetRuntimeState();
  chrome.bookmarks.onCreated.addListener((id, node) => void restoredProjection.handleBookmarkCreated(id, node));
  const started = operation(await restoredStorage.getState(), current.workspaceId);
  if (started?.status !== "started") {
    harness.teardown();
    revived.teardown();
    assert.equal(started?.status, "started", "RED: restart requires a durable started ownership record");
  }
  assert.equal(started?.status, "started", "RED: restart requires a durable started ownership record");
  assert.equal(started?.ownership?.chromeId, undefined, "started ownership must remain unresolved after worker loss");
  assert.equal((await restoredStorage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal?.pauseReason, "ambiguous-operation");
  revived.mutators.flush();
  await flushMicrotasks();
  assert.equal(revived.fetch.mutationCount(), 0, "revived listener must suppress the orphaned callback");
  harness.teardown();
  revived.teardown();
});

test("remote create final-shape mismatch pauses rather than completing ownership", async () => {
  const current = workspace(fresh("workspace"));
  const parentId = fresh("parent");
  const parentChromeId = fresh("parent-chrome");
  const { harness, projection, storage } = await runtime({ mode: "held", workspaces: [{ workspace: current, parentId, parentChromeId }] });
  const payload = { id: fresh("backend"), workspaceId: current.workspaceId, folderId: parentId, title: "Mismatch", url: "https://mismatch.test", position: 0 };
  const apply = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, "bookmark.created", payload));
  const created = await waitForHeldCreate(harness, parentChromeId);
  const originalGet = harness.chrome.bookmarks.get;
  harness.chrome.bookmarks.get = (id, callback) => originalGet(id, (nodes) => callback(nodes.map((node) => node.id === created.id ? { ...node, parentId: "wrong-parent", index: 99, title: "Wrong" } : node)));
  harness.mutators.settle();
  await apply;
  const journal = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal;
  const operationStatus = journal?.operations[0]?.status;
  harness.teardown();
  assert.equal(operationStatus, "started", "RED: final-shape validation requires a durable started ownership record");
  assert.equal(journal?.phase, "paused", "RED: final Chrome shape mismatch must pause ownership");
  assert.equal(journal?.pauseReason, "ambiguous-operation");
});

for (const fixture of [
  { label: "folder", create: (chrome, parentChromeId) => new Promise((resolve) => chrome.bookmarks.create({ parentId: parentChromeId, title: "Local folder", index: 0 }, resolve)) },
  { label: "bookmark", create: (chrome, parentChromeId) => new Promise((resolve) => chrome.bookmarks.create({ parentId: parentChromeId, title: "Local bookmark", url: "https://local.test", index: 0 }, resolve)) },
]) {
  test(`local ${fixture.label} create settles its mapping and cursor after one domain mutation`, async () => {
    const current = workspace(fresh("workspace"));
    const parentId = fresh("parent");
    const parentChromeId = fresh("parent-chrome");
    const backendId = fresh(`backend-${fixture.label}`);
    const { harness, storage } = await runtime({ workspaces: [{ workspace: current, parentId, parentChromeId }] });
    harness.fetch.respond(mutationResponse(fixture.label === "folder"
      ? { id: backendId, workspaceId: current.workspaceId, parentId: null, name: "Local folder", position: 0 }
      : { id: backendId, workspaceId: current.workspaceId, folderId: parentId, title: "Local bookmark", url: "https://local.test", position: 0 }, 1));
    const created = await fixture.create(chrome, fixture.label === "folder" ? `workspace:${current.workspaceId}` : parentChromeId);
    await flushMicrotasks();
    const projection = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId];
    assert.equal(harness.fetch.mutationCount(), 1);
    assert.equal(projection.backendIdByChromeId[created.id], backendId);
    assert.equal(projection.chromeIdByBackendId[backendId], created.id);
    assert.equal(projection.lastCursor, 1);
    assert.notEqual(projection.convergenceJournal?.phase, "paused");
    harness.teardown();
  });
}

test("unmatched B local create leaves A ownership untouched and emits one B mutation", async () => {
  const workspaceA = workspace(fresh("workspace-a"));
  const workspaceB = workspace(fresh("workspace-b"));
  const parentB = fresh("parent-b");
  const parentChromeB = fresh("parent-chrome-b");
  const { harness, storage } = await runtime({ workspaces: [
    { workspace: workspaceA },
    { workspace: workspaceB, parentId: parentB, parentChromeId: parentChromeB },
  ] });
  const seededJournal = {
    version: 1,
    phase: "paused",
    pauseReason: "ambiguous-operation",
    operations: [{ id: fresh("owned"), kind: "create", backendId: fresh("backend-a"), fingerprint: "folder|workspace-a", status: "started", ownership: { workspaceId: workspaceA.workspaceId, effect: "create", type: "folder", parentChromeId: `workspace:${workspaceA.workspaceId}`, title: "Owned A", index: 0 } }],
    localIntents: [],
    attempts: 0,
  };
  await storage.updateState((next) => {
    next.projectionsByWorkspaceId[workspaceA.workspaceId].convergenceJournal = structuredClone(seededJournal);
    return next;
  });
  harness.fetch.respond(response({ eventId: fresh("ack"), cursor: 1, duplicate: false }, 201));
  harness.fetch.respond(response({ workspace: workspaceB, folders: [] }));
  harness.fetch.respond(response({ events: [], currentCursor: 1 }));
  chrome.bookmarks.create({ parentId: parentChromeB, title: "Legitimate B", url: "https://b.test", index: 0 }, () => {});
  await flushMicrotasks();
  const mutations = harness.fetch.requests.filter((request) => request.method === "POST" && request.url.includes(`/workspaces/${workspaceB.workspaceId}/bookmarks`));
  assert.equal(mutations.length, 1, "the B bookmark must use exactly one B domain mutation");
  assert.deepEqual((await storage.getState()).projectionsByWorkspaceId[workspaceA.workspaceId].convergenceJournal, seededJournal);
  harness.teardown();
});

// --- extension-create-ownership-url-normalization: ADR-101/102/103 ---

test("T-P1 bare-origin remote create converges without pause (the incident regression)", async () => {
  const current = workspace(fresh("workspace"));
  const parentId = fresh("parent");
  const parentChromeId = fresh("parent-chrome");
  const { harness, projection, storage } = await runtime({ mode: "held", workspaces: [{ workspace: current, parentId, parentChromeId }] });
  const payload = { id: fresh("backend"), workspaceId: current.workspaceId, folderId: parentId, title: "Pruebs", url: "https://pruebs", position: 0 };
  const apply = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, "bookmark.created", payload));
  const created = await waitForHeldCreate(harness, parentChromeId);
  const originalGet = harness.chrome.bookmarks.get;
  harness.chrome.bookmarks.get = (id, callback) => originalGet(id, (nodes) => callback(nodes.map((node) => node.id === created.id ? { ...node, url: "https://pruebs/" } : node)));
  harness.mutators.settle();
  await apply;
  const journal = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal;
  const mutations = harness.fetch.mutationCount();
  harness.teardown();
  assert.equal(journal?.operations[0]?.status, "done", "RED: bare-origin create must complete ownership despite Chrome's trailing-slash normalization");
  assert.notEqual(journal?.phase, "paused");
  assert.equal(journal?.pauseReason, undefined);
  assert.equal(mutations, 0, "no phantom backend mutation");
});

test("T-P2 folder create with undefined url still verifies, and a byte-identical bookmark url still converges", async () => {
  const folderWorkspace = workspace(fresh("workspace"));
  const bookmarkWorkspace = workspace(fresh("workspace"));
  const parentId = fresh("parent");
  const parentChromeId = fresh("parent-chrome");
  const { harness, projection, storage } = await runtime({ workspaces: [
    { workspace: folderWorkspace },
    { workspace: bookmarkWorkspace, parentId, parentChromeId },
  ] });
  const folderPayload = { id: fresh("backend"), workspaceId: folderWorkspace.workspaceId, name: "Remote folder", position: 0 };
  await projection.projectionTestHooks.applyRemoteEnvelope(folderWorkspace.workspaceId, remoteEvent(folderWorkspace, "folder.created", folderPayload));
  const bookmarkPayload = { id: fresh("backend"), workspaceId: bookmarkWorkspace.workspaceId, folderId: parentId, title: "Remote bookmark", url: "https://remote.test", position: 0 };
  await projection.projectionTestHooks.applyRemoteEnvelope(bookmarkWorkspace.workspaceId, remoteEvent(bookmarkWorkspace, "bookmark.created", bookmarkPayload));
  await flushMicrotasks();
  const state = await storage.getState();
  const folderJournal = state.projectionsByWorkspaceId[folderWorkspace.workspaceId].convergenceJournal;
  const bookmarkJournal = state.projectionsByWorkspaceId[bookmarkWorkspace.workspaceId].convergenceJournal;
  harness.teardown();
  assert.equal(folderJournal?.operations[0]?.status, "done", "folder create with url:undefined on both sides must verify");
  assert.notEqual(folderJournal?.phase, "paused");
  assert.equal(bookmarkJournal?.operations[0]?.status, "done", "byte-identical url bookmark create must verify");
  assert.notEqual(bookmarkJournal?.phase, "paused");
});

for (const mismatch of [
  { label: "title", override: (node) => ({ ...node, title: "Wrong Title" }) },
  { label: "parentId", override: (node) => ({ ...node, parentId: "wrong-parent" }) },
  { label: "index", override: (node) => ({ ...node, index: 99 }) },
  { label: "genuinely different url", override: (node) => ({ ...node, url: "https://other.test/" }) },
]) {
  test(`T-P3 genuine ${mismatch.label} mismatch still pauses with ambiguous-operation`, async () => {
    const current = workspace(fresh("workspace"));
    const parentId = fresh("parent");
    const parentChromeId = fresh("parent-chrome");
    const { harness, projection, storage } = await runtime({ mode: "held", workspaces: [{ workspace: current, parentId, parentChromeId }] });
    const payload = { id: fresh("backend"), workspaceId: current.workspaceId, folderId: parentId, title: "Correct Title", url: "https://pruebs", position: 0 };
    const apply = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, remoteEvent(current, "bookmark.created", payload));
    const created = await waitForHeldCreate(harness, parentChromeId);
    const originalGet = harness.chrome.bookmarks.get;
    harness.chrome.bookmarks.get = (id, callback) => originalGet(id, (nodes) => callback(nodes.map((node) => node.id === created.id ? mismatch.override(node) : node)));
    harness.mutators.settle();
    await apply;
    const journal = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal;
    harness.teardown();
    assert.equal(journal?.operations[0]?.status, "started", `RED: genuine ${mismatch.label} mismatch must not reach done`);
    assert.equal(journal?.phase, "paused");
    assert.equal(journal?.pauseReason, "ambiguous-operation");
  });
}

test("T-P4 rebuild through storage.updateState clears a stuck started create operation and does not re-pause on the next read", async () => {
  const current = workspace(fresh("workspace"));
  const { harness, storage } = await runtime({ workspaces: [{ workspace: current }] });
  const stuckOperation = { id: "11:backend-workspace:create", kind: "create", backendId: fresh("backend"), fingerprint: "f", status: "started", ownership: { workspaceId: current.workspaceId, type: "bookmark", parentChromeId: `workspace:${current.workspaceId}`, title: "Pruebs", url: "https://pruebs", index: 0 } };
  await storage.updateState((state) => {
    state.projectionsByWorkspaceId[current.workspaceId].convergenceJournal = {
      version: 1, phase: "paused", pauseReason: "ambiguous-operation", operations: [stuckOperation], localIntents: [], attempts: 0,
    };
    return state;
  });
  const convergence = await import(`../dist/background/convergence.js?${fresh("convergence")}`);
  await storage.updateState((state) => {
    state.projectionsByWorkspaceId[current.workspaceId].convergenceJournal = convergence.rebuildJournal(state.projectionsByWorkspaceId[current.workspaceId].convergenceJournal);
    return state;
  });
  const journal = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal;
  harness.teardown();
  assert.notEqual(journal?.phase, "paused", "RED: rebuild must clear the stuck started operation so the next read does not re-pause");
  assert.equal(journal?.pauseReason, undefined);
  assert.equal(journal?.operations.some((op) => op.status === "started"), false);
});
