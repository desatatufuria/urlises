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
    if (phase === "after") { await Promise.resolve(); assert.equal(seen.length, 1); }
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
  const pending = harness.fetch.fetch("https://api.test/workspaces/one/bookmarks", { method: "POST", headers: { X: "1" }, body: JSON.stringify({ id: 1 }) });
  assert.equal(harness.fetch.mutationCount(), 1); deferred.resolve(new Response("ok")); assert.equal(await (await pending).text(), "ok");
  harness.fetch.reject(new TypeError("offline")); await assert.rejects(harness.fetch.fetch("https://api.test/items"), /offline/);
  assert.deepEqual(harness.fetch.requests[0], { url: "https://api.test/workspaces/one/bookmarks", method: "POST", headers: { x: "1" }, body: '{"id":1}' });
  harness.teardown();
});

test("runtime reset and teardown remove listeners, timers, and sockets", () => {
  const harness = createChromeHarness(); harness.chrome.runtime.onMessage.addListener(() => {}); harness.timers.set(() => {}); new harness.WebSocket("ws://api.test");
  harness.resetRuntime(); assert.deepEqual(harness.openHandles(), { listeners: 0, timers: 0, sockets: 0 });
  harness.teardown(); assert.deepEqual(harness.openHandles(), { listeners: 0, timers: 0, sockets: 0 });
});

test("revived runtimes flush persisted queued descriptors through fresh listeners", async () => {
  const original = createChromeHarness(); const beforeRestart = [];
  original.chrome.bookmarks.onCreated.addListener((_id, node) => beforeRestart.push(node.title));
  original.mutators.mode("delayed", 2);
  await call(original.chrome.bookmarks.create, { parentId: "2", title: "persisted" });
  const snapshot = original.snapshot(); snapshot.local.push(["extra", { nested: true }]);
  const revived = createChromeHarness({ persisted: snapshot }); const afterRestart = [];
  revived.chrome.bookmarks.onCreated.addListener((_id, node) => afterRestart.push(node.title));
  snapshot.local[0][1].nested = false; snapshot.queue[0].args[1].title = "mutated snapshot";
  revived.mutators.flush();
  assert.deepEqual(beforeRestart, []);
  assert.deepEqual(afterRestart, ["persisted", "persisted"]);
  assert.deepEqual(await call(revived.chrome.storage.local.get, "extra"), { extra: { nested: true } });
  original.teardown(); revived.teardown();
});

test("after delivery yields to the mutator promise continuation and captures schedule state", async () => {
  const harness = createChromeHarness(); const order = [], seen = [];
  harness.chrome.bookmarks.onCreated.addListener((_id, node) => { order.push("event"); seen.push(node.title); });
  harness.mutators.mode("after", 2);
  await call(harness.chrome.bookmarks.create, { parentId: "2", title: "after" }).then(() => order.push("continuation"));
  await Promise.resolve();
  assert.deepEqual(order, ["continuation", "event", "event"]);
  harness.mutators.mode("delayed", 2);
  await call(harness.chrome.bookmarks.create, { parentId: "2", title: "captured" });
  harness.mutators.mode("before", 1); harness.mutators.flush();
  assert.deepEqual(seen.slice(-2), ["captured", "captured"]);
  harness.teardown();
});

test("timers, IDs, events, fetch filtering, and revived clones model Chrome boundaries", async () => {
  const tree = workspaceTree([{ id: "one", folders: [{ id: "20", title: "seed" }], bookmarks: [{ id: "40", title: "bookmark", url: "https://seed.test" }] }]);
  const harness = createChromeHarness({ tree }); const events = [];
  const created = () => events.push("created");
  harness.chrome.bookmarks.onCreated.addListener(created); harness.chrome.bookmarks.onCreated.removeListener(created);
  harness.chrome.bookmarks.onChanged.addListener((id, info) => events.push(["changed", id, info]));
  harness.chrome.bookmarks.onMoved.addListener((id, info) => events.push(["moved", id, info]));
  harness.chrome.bookmarks.onRemoved.addListener((id, info) => events.push(["removed", id, info]));
  harness.mutators.mode("delayed");
  const node = await call(harness.chrome.bookmarks.create, { parentId: "workspace:one", title: "new" });
  assert.equal(node.id, "41");
  await call(harness.chrome.bookmarks.update, node.id, { title: "changed" });
  await call(harness.chrome.bookmarks.move, node.id, { parentId: "2", index: 0 });
  await call(harness.chrome.bookmarks.remove, node.id);
  harness.mutators.flush([1, 2, 3, 0]);
  assert.deepEqual(events.map(([kind]) => kind), ["changed", "moved", "removed"]);
  assert.deepEqual(events[1][2], { parentId: "2", oldParentId: "workspace:one", index: 0, oldIndex: 2 });
  assert.deepEqual(events[2][2], { parentId: "2", index: 0, node: { id: "41", parentId: "2", index: 0, title: "changed" } });
  const timerOrder = []; harness.timers.set(() => { timerOrder.push("first"); harness.timers.set(() => timerOrder.push("next")); });
  harness.timers.flush(); assert.deepEqual(timerOrder, ["first"]); assert.equal(harness.openHandles().timers, 1);
  harness.timers.flush(); assert.deepEqual(timerOrder, ["first", "next"]);
  await harness.fetch.fetch("https://api.test/auth/login", { method: "POST" });
  await harness.fetch.fetch("https://api.test/auth/refresh", { method: "POST" });
  await harness.fetch.fetch("https://api.test/auth/logout", { method: "POST" });
  await harness.fetch.fetch("https://api.test/auth/ws-ticket", { method: "POST" });
  await harness.fetch.fetch("https://api.test/workspaces/one/bookmarks", { method: "GET" });
  await harness.fetch.fetch("https://api.test/workspaces/one/bookmarks", { method: "POST" });
  await harness.fetch.fetch("https://api.test/workspaces/one/folders/one", { method: "PATCH" });
  assert.equal(harness.fetch.requests.length, 7); assert.equal(harness.fetch.mutationCount(), 2);
  const snapshot = harness.snapshot(); const revived = createChromeHarness({ persisted: snapshot });
  snapshot.tree.children[1].children[0].title = "mutated"; snapshot.session.push(["later", { value: 1 }]);
  assert.equal((await call(revived.chrome.bookmarks.get, "workspace:one"))[0].title, "one");
  assert.deepEqual(await call(revived.chrome.storage.session.get, "later"), { later: undefined });
  harness.teardown(); revived.teardown();
});

test("same-parent move to oldIndex+1 is a silent Chromium no-op (T-F1)", async () => {
  const harness = createChromeHarness({ tree: workspaceTree([{ id: "one", folders: [{ title: "A" }, { title: "B" }] }]) });
  const moved = [];
  harness.chrome.bookmarks.onMoved.addListener((id, info) => moved.push(info));
  const root = await call(harness.chrome.bookmarks.getChildren, "workspace:one");
  const result = await call(harness.chrome.bookmarks.move, root[0].id, { parentId: "workspace:one", index: 1 });
  assert.equal(result.index, 0);
  assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "workspace:one")).map((node) => node.title), ["A", "B"]);
  harness.mutators.settle();
  assert.deepEqual(moved, [], "a same-parent no-op must deliver zero onMoved events");
  harness.teardown();
});

test("same-parent forward-by-many decrements through the pre-removal coordinate (T-F2)", async () => {
  const harness = createChromeHarness({ tree: workspaceTree([{ id: "one", folders: [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }] }]) });
  const moved = [];
  harness.chrome.bookmarks.onMoved.addListener((id, info) => moved.push(info));
  harness.mutators.mode("delayed");
  const root = await call(harness.chrome.bookmarks.getChildren, "workspace:one");
  const result = await call(harness.chrome.bookmarks.move, root[0].id, { parentId: "workspace:one", index: 3 });
  assert.equal(result.index, 2);
  harness.mutators.flush();
  assert.deepEqual(moved.map(({ oldIndex, index }) => ({ oldIndex, index })), [{ oldIndex: 0, index: 2 }]);
  assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "workspace:one")).map((node) => node.title), ["B", "C", "A", "D"]);
  harness.teardown();
});

test("backward, cross-parent, index-less append, and out-of-bounds moves are unchanged by the fix (T-F3)", async () => {
  {
    const harness = createChromeHarness({ tree: workspaceTree([{ id: "one", folders: [{ title: "A" }, { title: "B" }, { title: "C" }] }]) });
    const moved = [];
    harness.chrome.bookmarks.onMoved.addListener((id, info) => moved.push(info));
    harness.mutators.mode("delayed");
    const root = await call(harness.chrome.bookmarks.getChildren, "workspace:one");
    const result = await call(harness.chrome.bookmarks.move, root[2].id, { parentId: "workspace:one", index: 0 });
    assert.equal(result.index, 0);
    harness.mutators.flush();
    assert.deepEqual(moved.map(({ oldIndex, index }) => ({ oldIndex, index })), [{ oldIndex: 2, index: 0 }]);
    assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "workspace:one")).map((node) => node.title), ["C", "A", "B"]);
    harness.teardown();
  }
  {
    const harness = createChromeHarness({ tree: workspaceTree([{ id: "one", folders: [{ title: "A" }, { title: "B" }] }, { id: "two", folders: [{ title: "X" }] }]) });
    const root = await call(harness.chrome.bookmarks.getChildren, "workspace:one");
    const result = await call(harness.chrome.bookmarks.move, root[0].id, { parentId: "workspace:two", index: 0 });
    assert.equal(result.index, 0);
    assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "workspace:one")).map((node) => ({ title: node.title, index: node.index })), [{ title: "B", index: 0 }]);
    assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "workspace:two")).map((node) => node.title), ["A", "X"]);
    harness.teardown();
  }
  {
    const harness = createChromeHarness({ tree: workspaceTree([{ id: "one", folders: [{ title: "A" }, { title: "B" }, { title: "C" }] }]) });
    const root = await call(harness.chrome.bookmarks.getChildren, "workspace:one");
    const result = await call(harness.chrome.bookmarks.move, root[0].id, { parentId: "workspace:one" });
    assert.equal(result.index, 2, "an index-less same-parent move must append to the end");
    assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "workspace:one")).map((node) => node.title), ["B", "C", "A"]);
    harness.teardown();
  }
  {
    const harness = createChromeHarness({ tree: workspaceTree([{ id: "one", folders: [{ title: "A" }] }]) });
    const root = await call(harness.chrome.bookmarks.getChildren, "workspace:one");
    await assert.rejects(call(harness.chrome.bookmarks.move, root[0].id, { parentId: "workspace:one", index: 5 }), /Index out of bounds\./);
    harness.teardown();
  }
});
