import test from "node:test";
import assert from "node:assert/strict";
import { createChromeHarness, workspaceTree } from "./helpers/fake-chrome.mjs";

const call = (method, ...args) => new Promise((resolve) => method(...args, resolve));

test("storage values are isolated and persist into a fresh runtime", async () => {
  const harness = createChromeHarness();
  const localValue = { nested: 1 }, sessionValue = { nested: 2 };
  await call(harness.chrome.storage.local.set, { value: localValue });
  await call(harness.chrome.storage.session.set, { value: sessionValue });
  localValue.nested = sessionValue.nested = 8;
  const local = await call(harness.chrome.storage.local.get, "value");
  const session = await call(harness.chrome.storage.session.get, "value");
  local.value.nested = session.value.nested = 9;
  assert.equal((await call(harness.chrome.storage.local.get, "value")).value.nested, 1);
  assert.equal((await call(harness.chrome.storage.session.get, "value")).value.nested, 2);
  const revived = createChromeHarness({ persisted: harness.snapshot() });
  assert.equal((await call(revived.chrome.storage.local.get, "value")).value.nested, 1);
  harness.teardown(); revived.teardown();
});

test("workspace trees preserve parent and index order", async () => {
  const harness = createChromeHarness({ tree: workspaceTree([{ id: "one", folders: [{ title: "A" }], bookmarks: [{ title: "B", url: "https://b.test" }] }]) });
  const root = (await call(harness.chrome.bookmarks.getChildren, "workspace:one"));
  assert.deepEqual(root.map(({ title, parentId, index }) => ({ title, parentId, index })), [{ title: "A", parentId: "workspace:one", index: 0 }, { title: "B", parentId: "workspace:one", index: 1 }]);
  const moved = await call(harness.chrome.bookmarks.move, root[1].id, { parentId: "workspace:one", index: 0 });
  assert.equal(moved.index, 0);
  assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "workspace:one")).map((node) => node.title), ["B", "A"]);
  harness.teardown();
});

test("mutators deliver before, after, and delayed callbacks deterministically", async () => {
  const harness = createChromeHarness(); const seen = [];
  harness.chrome.bookmarks.onCreated.addListener((id) => seen.push(id));
  for (const phase of ["before", "after", "delayed"]) {
    harness.mutators.mode(phase); seen.length = 0;
    const pending = call(harness.chrome.bookmarks.create, { parentId: "2", title: phase });
    if (phase === "before") assert.equal(seen.length, 1);
    await pending;
    if (phase === "after") assert.equal(seen.length, 1);
    if (phase === "delayed") { assert.equal(seen.length, 0); harness.mutators.flush(); assert.equal(seen.length, 1); }
  }
  harness.teardown();
});

test("mutators duplicate and reorder queued callbacks without clocks", async () => {
  const harness = createChromeHarness(); const seen = [];
  harness.chrome.bookmarks.onCreated.addListener((_id, node) => seen.push(node.title));
  harness.mutators.mode("delayed", 2);
  await call(harness.chrome.bookmarks.create, { parentId: "2", title: "first" });
  await call(harness.chrome.bookmarks.create, { parentId: "2", title: "second" });
  harness.mutators.flush([1, 0]);
  assert.deepEqual(seen, ["second", "second", "first", "first"]);
  harness.teardown();
});

test("deferred mutation settlement is caller controlled", async () => {
  const harness = createChromeHarness(); harness.mutators.mode("held");
  let settled = false;
  const pending = call(harness.chrome.bookmarks.create, { parentId: "2", title: "held" }).then(() => { settled = true; });
  assert.equal(settled, false); harness.mutators.settle(); await pending; assert.equal(settled, true);
  harness.teardown();
});

test("fetch recorder clones requests and supports deferred responses and errors", async () => {
  const harness = createChromeHarness(); const deferred = harness.fetch.defer();
  const pending = harness.fetch.fetch("https://api.test/items", { method: "POST", headers: { X: "1" }, body: JSON.stringify({ id: 1 }) });
  assert.equal(harness.fetch.mutationCount(), 1); deferred.resolve(new Response("ok")); assert.equal(await (await pending).text(), "ok");
  harness.fetch.reject(new TypeError("offline")); await assert.rejects(harness.fetch.fetch("https://api.test/items"), /offline/);
  assert.deepEqual(harness.fetch.requests[0], { url: "https://api.test/items", method: "POST", headers: { x: "1" }, body: '{"id":1}' });
  harness.teardown();
});

test("runtime reset and teardown remove listeners, timers, and sockets", () => {
  const harness = createChromeHarness(); harness.chrome.runtime.onMessage.addListener(() => {}); harness.timers.set(() => {}); new harness.WebSocket("ws://api.test");
  harness.resetRuntime(); assert.deepEqual(harness.openHandles(), { listeners: 0, timers: 0, sockets: 0 });
  harness.teardown(); assert.deepEqual(harness.openHandles(), { listeners: 0, timers: 0, sockets: 0 });
});
