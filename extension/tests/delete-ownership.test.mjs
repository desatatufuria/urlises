import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createChromeHarness, workspaceTree } from "./helpers/fake-chrome.mjs";

globalThis.crypto ??= webcrypto;
let sequence = 0;
const fresh = (prefix) => `${prefix}-${++sequence}`;
const flush = async () => { for (let index = 0; index < 96; index += 1) await Promise.resolve(); };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const workspace = (id) => ({ workspaceId: id, workspaceName: id, workspaceType: "team", organizationId: `org-${id}`, organizationName: "Org", role: "editor" });
const event = (current, kind, payload) => ({ cursor: 1, eventId: fresh("event"), workspaceId: current.workspaceId, originClientId: "remote", kind, entityType: kind.split(".")[0], entityId: payload.id, payload, createdAt: "2026-01-01T00:00:00Z" });

async function runtime({ mode = "held", type = "folder", twoWorkspaces = false } = {}) {
  const current = workspace(fresh("workspace")), other = workspace(fresh("other"));
  const ids = { backend: fresh("backend"), chrome: fresh("chrome"), childBackend: fresh("child-backend"), childChrome: fresh("child-chrome") };
  const folders = type === "folder" ? [{ id: ids.chrome, title: "Remote", children: [{ id: ids.childChrome, title: "Child", url: "https://child.test" }] }] : [];
  const bookmarks = type === "bookmark" ? [{ id: ids.chrome, title: "Remote", url: "https://remote.test" }] : [];
  const harness = createChromeHarness({ tree: workspaceTree([{ id: current.workspaceId, title: current.workspaceName, folders, bookmarks }, ...(twoWorkspaces ? [{ id: other.workspaceId, title: other.workspaceName, folders: [{ id: fresh("other-chrome"), title: "Other" }] }] : [])]) });
  harness.mutators.mode(mode); globalThis.chrome = harness.chrome; globalThis.fetch = harness.fetch.fetch; globalThis.WebSocket = harness.WebSocket;
  const storage = await import(`../dist/shared/storage.js?${fresh("storage")}`), projection = await import(`../dist/background/projection.js?${fresh("projection")}`);
  projection.projectionTestHooks.resetRuntimeState();
  const state = (currentWorkspace) => ({ workspace: currentWorkspace, rootChromeId: "0", organizationChromeId: "2", workspaceChromeId: `workspace:${currentWorkspace.workspaceId}`, chromeIdByBackendId: { [ids.backend]: ids.chrome, ...(type === "folder" ? { [ids.childBackend]: ids.childChrome } : {}) }, backendIdByChromeId: { [ids.chrome]: ids.backend, ...(type === "folder" ? { [ids.childChrome]: ids.childBackend } : {}) }, entityTypeByBackendId: { [ids.backend]: type, ...(type === "folder" ? { [ids.childBackend]: "bookmark" } : {}) }, excludedBackendNodeIds: [], lastCursor: 0, status: "ready", health: "live", recoveryAttemptCount: 0 });
  await storage.setState({ settings: { backendUrl: "https://api.test", clientId: fresh("client") }, session: { accessToken: "token", expiresAt: "2999-01-01T00:00:00Z", clientId: "client", user: { id: "u", email: "u@test" } }, selectedWorkspaceIds: twoWorkspaces ? [current.workspaceId, other.workspaceId] : [current.workspaceId], cachedOrganizations: [], cachedWorkspacesByOrganization: {}, diagnostics: [], projectionsByWorkspaceId: Object.fromEntries([[current.workspaceId, state(current)], ...(twoWorkspaces ? [[other.workspaceId, state(other)]] : [])]) });
  chrome.bookmarks.onRemoved.addListener((id, info) => void projection.handleBookmarkRemoved(id, info));
  return { harness, projection, storage, current, other, ids };
}

for (const type of ["folder", "bookmark"]) test(`remote ${type} delete persists ownership before effect and completes after cleanup`, async () => {
  const { harness, projection, storage, current, ids } = await runtime({ type });
  const apply = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, `${type}.deleted`, type === "folder" ? { id: ids.backend, workspaceId: current.workspaceId } : { id: ids.backend, workspaceId: current.workspaceId }));
  await flush();
  let currentState = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId];
  assert.equal(currentState.convergenceJournal.operations[0].status, "started");
  assert.equal(currentState.convergenceJournal.operations[0].ownership.effect, "delete");
  assert.equal(harness.fetch.mutationCount(), 0, "early callback is owned");
  harness.mutators.flush(); await apply; await flush(); currentState = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId];
  assert.equal(currentState.convergenceJournal.operations[0].status, "done");
  assert.equal(currentState.chromeIdByBackendId[ids.backend], undefined);
  assert.equal(currentState.backendIdByChromeId[ids.chrome], undefined);
  assert.equal(currentState.entityTypeByBackendId[ids.backend], undefined);
  assert.equal(currentState.chromeIdByBackendId[ids.childBackend], undefined);
  assert.equal(harness.fetch.mutationCount(), 0); harness.teardown();
});

test("folder delete subtree read errors pause without removing or clearing mappings", async () => {
  const { harness, projection, storage, current, ids } = await runtime({ mode: "after" });
  const originalGetSubTree = chrome.bookmarks.getSubTree, originalRemoveTree = chrome.bookmarks.removeTree;
  let removeCalls = 0;
  chrome.bookmarks.getSubTree = (_id, callback) => { chrome.runtime.lastError = { message: "subtree unavailable" }; callback([]); chrome.runtime.lastError = null; };
  chrome.bookmarks.removeTree = (...args) => { removeCalls += 1; originalRemoveTree(...args); };
  try {
    await projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, "folder.deleted", { id: ids.backend, workspaceId: current.workspaceId }));
  } finally {
    chrome.bookmarks.getSubTree = originalGetSubTree; chrome.bookmarks.removeTree = originalRemoveTree;
  }
  const next = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId];
  assert.equal(removeCalls, 0);
  assert.equal(next.chromeIdByBackendId[ids.backend], ids.chrome); assert.equal(next.chromeIdByBackendId[ids.childBackend], ids.childChrome);
  assert.equal(next.backendIdByChromeId[ids.chrome], ids.backend); assert.equal(next.backendIdByChromeId[ids.childChrome], ids.childBackend);
  assert.equal(next.convergenceJournal.phase, "paused"); assert.equal(next.convergenceJournal.pauseReason, "ambiguous-operation");
  assert.equal(next.convergenceJournal.operations.some(({ status }) => status === "done"), false); assert.equal(next.lastCursor, 0);
  harness.teardown();
});

test("delayed, duplicate, reordered, and restart delete callbacks remain owned", async () => {
  const { harness, projection, storage, current, ids } = await runtime({ mode: "delayed" });
  harness.mutators.mode("delayed", 2);
  await projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, "folder.deleted", { id: ids.backend, workspaceId: current.workspaceId }));
  harness.mutators.flush([0]); await flush();
  const persisted = harness.snapshot(); harness.resetRuntime(); const revived = createChromeHarness({ persisted });
  globalThis.chrome = revived.chrome; globalThis.fetch = revived.fetch.fetch; globalThis.WebSocket = revived.WebSocket;
  const restored = await import(`../dist/shared/storage.js?${fresh("restored-storage")}`), restoredProjection = await import(`../dist/background/projection.js?${fresh("restored-projection")}`);
  restoredProjection.projectionTestHooks.resetRuntimeState(); chrome.bookmarks.onRemoved.addListener((id, info) => void restoredProjection.handleBookmarkRemoved(id, info));
  await restoredProjection.handleBookmarkRemoved(ids.chrome, { parentId: `workspace:${current.workspaceId}`, index: 0, node: { id: ids.chrome, title: "Remote" } }); await flush();
  assert.equal((await restored.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal.operations[0].status, "done");
  assert.equal(revived.fetch.mutationCount(), 0); harness.teardown(); revived.teardown();
});

test("reordered folder delete callbacks remain independently owned", async () => {
  const { harness, projection, storage, current, ids } = await runtime(); const secondBackend = fresh("second-backend");
  chrome.bookmarks.create({ parentId: `workspace:${current.workspaceId}`, title: "Second" }, () => {});
  const created = (await new Promise((resolve) => chrome.bookmarks.getChildren(`workspace:${current.workspaceId}`, resolve))).at(-1).id;
  await storage.updateState((state) => { const mapped = state.projectionsByWorkspaceId[current.workspaceId]; mapped.chromeIdByBackendId[secondBackend] = created; mapped.backendIdByChromeId[created] = secondBackend; mapped.entityTypeByBackendId[secondBackend] = "folder"; return state; });
  const first = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, "folder.deleted", { id: ids.backend, workspaceId: current.workspaceId })), second = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, "folder.deleted", { id: secondBackend, workspaceId: current.workspaceId }));
  await flush(); harness.mutators.flush([2, 1, 0]); await Promise.all([first, second]); await flush();
  assert.equal((await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal.operations.filter(({ status }) => status === "done").length, 2); assert.equal(harness.fetch.mutationCount(), 0); harness.teardown();
});

test("restart between delete side effect and callback recovers persisted ownership", async () => {
  const { harness, projection, current, ids } = await runtime(); void projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, "folder.deleted", { id: ids.backend, workspaceId: current.workspaceId })); await flush();
  const persisted = harness.snapshot(); harness.resetRuntime(); const revived = createChromeHarness({ persisted }); globalThis.chrome = revived.chrome; globalThis.fetch = revived.fetch.fetch; globalThis.WebSocket = revived.WebSocket;
  const storage = await import(`../dist/shared/storage.js?${fresh("restart-storage")}`), restored = await import(`../dist/background/projection.js?${fresh("restart-projection")}`); restored.projectionTestHooks.resetRuntimeState();
  assert.equal((await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal.operations[0].status, "started");
  await restored.handleBookmarkRemoved(ids.chrome, { parentId: `workspace:${current.workspaceId}`, index: 0, node: { id: ids.chrome, title: "Remote" } }); await flush();
  assert.equal((await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal.operations[0].status, "done"); assert.equal(revived.fetch.mutationCount(), 0); harness.teardown(); revived.teardown();
});

test("delete verification failure pauses, workspace ownership is isolated, and unmatched deletes mutate once", async () => {
  const { harness, projection, storage, current, other, ids } = await runtime({ twoWorkspaces: true });
  const originalGet = chrome.bookmarks.get; chrome.bookmarks.get = (id, callback) => originalGet(id, (nodes) => callback(id === ids.chrome ? [{ id }] : nodes));
  const apply = projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, "folder.deleted", { id: ids.backend, workspaceId: current.workspaceId }));
  await flush(); harness.mutators.flush(); await apply; await flush();
  assert.equal((await storage.getState()).projectionsByWorkspaceId[current.workspaceId].convergenceJournal.phase, "paused");
  chrome.bookmarks.get = originalGet;
  const otherChrome = (await new Promise((resolve) => chrome.bookmarks.getChildren(`workspace:${other.workspaceId}`, resolve)))[0].id, otherBackend = fresh("other-backend");
  await storage.updateState((state) => { const otherProjection = state.projectionsByWorkspaceId[other.workspaceId]; otherProjection.chromeIdByBackendId = { [otherBackend]: otherChrome }; otherProjection.backendIdByChromeId = { [otherChrome]: otherBackend }; otherProjection.entityTypeByBackendId = { [otherBackend]: "folder" }; return state; });
  assert.equal((await storage.getState()).projectionsByWorkspaceId[other.workspaceId].chromeIdByBackendId[otherBackend], otherChrome, "other workspace is unchanged");
  harness.fetch.respond(reply({ eventId: fresh("ack"), cursor: 2 })); harness.fetch.respond(reply({ workspace: other, folders: [] })); harness.fetch.respond(reply({ events: [], currentCursor: 2 }));
  void projection.handleBookmarkRemoved(otherChrome, { parentId: `workspace:${other.workspaceId}`, index: 0, node: { id: otherChrome, title: "local" } }); await flush();
  assert.equal(harness.fetch.mutationCount(), 1); harness.teardown();
});

test("unmatched local bookmark deletion emits exactly one bookmark mutation", async () => {
  const { harness, projection, current, ids } = await runtime({ type: "bookmark", mode: "after" });
  harness.fetch.respond(reply({ eventId: fresh("ack"), cursor: 2 })); harness.fetch.respond(reply({ workspace: current, folders: [] })); harness.fetch.respond(reply({ events: [], currentCursor: 2 }));
  void projection.handleBookmarkRemoved(ids.chrome, { parentId: `workspace:${current.workspaceId}`, index: 0, node: { id: ids.chrome, title: "local", url: "https://local.test" } }); await flush();
  assert.equal(harness.fetch.requests.filter((request) => request.method === "DELETE" && request.url.includes("/bookmarks/")).length, 1); harness.teardown();
});

for (const prunable of [true, false]) test(`delete capacity ${prunable ? "prunes" : "pauses before effect"}`, async () => {
  const { harness, projection, storage, current, ids } = await runtime({ mode: "after" });
  await storage.updateState((state) => { state.projectionsByWorkspaceId[current.workspaceId].convergenceJournal = { version: 1, phase: "live", localIntents: [], attempts: 0, operations: Array.from({ length: 500 }, (_, index) => ({ id: `old-${index}`, kind: "delete", backendId: `old-${index}`, fingerprint: "old", status: prunable && index === 0 ? "done" : "planned", ownership: { workspaceId: current.workspaceId, effect: "delete", type: "folder", chromeId: `old-${index}` } })) }; return state; });
  await projection.projectionTestHooks.applyRemoteEnvelope(current.workspaceId, event(current, "folder.deleted", { id: ids.backend, workspaceId: current.workspaceId }));
  const next = (await storage.getState()).projectionsByWorkspaceId[current.workspaceId];
  assert.equal(next.convergenceJournal.phase, prunable ? "live" : "paused"); assert.equal(await new Promise((resolve) => chrome.bookmarks.get(ids.chrome, (nodes) => resolve(nodes.length))), prunable ? 0 : 1); harness.teardown();
});
