const clone = (value) => structuredClone(value);
const event = () => { const listeners = new Set(); return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => [...listeners].forEach((fn) => fn(...clone(args))), clear: () => listeners.clear(), get size() { return listeners.size; } }; };

export function workspaceTree(workspaces) {
  return { id: "0", title: "", children: [{ id: "1", title: "Bookmarks bar", children: [] }, { id: "2", title: "Other Bookmarks", children: workspaces.map((workspace) => ({ id: `workspace:${workspace.id}`, title: workspace.title ?? workspace.id, children: [...(workspace.folders ?? []).map((node, index) => ({ id: node.id ?? `folder:${workspace.id}:${index}`, title: node.title, children: node.children ?? [] })), ...(workspace.bookmarks ?? []).map((node, index) => ({ id: node.id ?? `bookmark:${workspace.id}:${index}`, title: node.title, url: node.url }))] })) }] };
}

export function createChromeHarness({ tree = workspaceTree([]), persisted } = {}) {
  const saved = persisted ? clone(persisted) : undefined;
  const local = new Map(saved?.local ? clone(saved.local) : []), session = new Map(saved?.session ? clone(saved.session) : []), nodes = new Map();
  let sequence = Number.isSafeInteger(saved?.sequence) ? saved.sequence : 10;
  const created = event(), changed = event(), moved = event(), removed = event(), message = event(); const events = [created, changed, moved, removed, message];
  const timers = new Map(), sockets = new Set(), queue = (saved?.queue ?? []).map((item) => clone(item)); let phase = "after", duplicates = 1;
  const node = (id) => nodes.get(id);
  const materialize = (raw, parentId, index) => { const id = String(raw.id ?? allocate()); const record = { id, parentId, index, title: raw.title ?? "", url: raw.url, children: [] }; nodes.set(id, record); if (/^\d+$/.test(id)) sequence = Math.max(sequence, Number(id) + 1); (raw.children ?? []).forEach((child, childIndex) => record.children.push(materialize(child, id, childIndex))); return id; };
  const allocate = () => { while (nodes.has(String(sequence))) sequence += 1; return sequence++; };
  const restore = (value) => { nodes.clear(); materialize(clone(value), undefined, 0); };
  restore(saved?.tree ?? tree);
  const view = (id, deep = false) => { const item = node(id); if (!item) return undefined; const result = { id: item.id, parentId: item.parentId, index: item.index, title: item.title }; if (item.url !== undefined) result.url = item.url; if (deep || item.children.length) result.children = item.children.map((child) => view(child, true)); return clone(result); };
  const normalize = (parentId) => node(parentId).children.forEach((child, index) => { node(child).index = index; });
  const emit = (kind, ...args) => ({ created, changed, moved, removed })[kind].emit(...args);
  const deliver = ({ kind, args, count }) => Array.from({ length: count }, () => emit(kind, ...args));
  const complete = (kind, args, callback) => {
    const descriptor = { kind, args: clone(args), count: duplicates };
    if (phase === "before") { deliver(descriptor); callback(); }
    else if (phase === "after") { callback(); queueMicrotask(() => queueMicrotask(() => deliver(descriptor))); }
    else if (phase === "held") queue.push({ ...descriptor, callback });
    else { callback(); queue.push(descriptor); }
  };
  const area = (store) => ({
    get(keys, callback) { const result = {}; for (const key of keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys)) result[key] = store.has(key) ? clone(store.get(key)) : typeof keys === "object" && !Array.isArray(keys) ? clone(keys[key]) : undefined; callback(result); },
    set(items, callback = () => {}) { Object.entries(items).forEach(([key, value]) => store.set(key, clone(value))); callback(); }, remove(keys, callback = () => {}) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => store.delete(key)); callback(); }, clear(callback = () => {}) { store.clear(); callback(); },
  });
  const removeNode = (id, deep, callback) => { const record = node(id); if (!record || (!deep && record.children.length)) throw new Error("node missing or non-empty"); const parent = node(record.parentId); parent.children.splice(record.index, 1); normalize(parent.id); const info = { parentId: parent.id, index: record.index, node: viewFrom(record) }; const erase = (current) => { node(current).children.forEach(erase); nodes.delete(current); }; erase(id); complete("removed", [id, info], callback); };
  const viewFrom = (record) => { const result = { id: record.id, parentId: record.parentId, index: record.index, title: record.title }; if (record.url !== undefined) result.url = record.url; return clone(result); };
  const bookmarks = {
    onCreated: created, onChanged: changed, onMoved: moved, onRemoved: removed,
    get(id, callback) { callback(node(id) ? [view(id)] : []); }, getChildren(id, callback) { callback((node(id)?.children ?? []).map((child) => view(child))); }, getSubTree(id, callback) { callback(node(id) ? [view(id, true)] : []); }, getTree(callback) { callback([view("0", true)]); },
    create(input, callback) { const parent = node(input.parentId ?? "2"); if (!parent) throw new Error("parent missing"); const id = String(allocate()), record = { id, parentId: parent.id, index: input.index ?? parent.children.length, title: input.title ?? "", url: input.url, children: [] }; parent.children.splice(Math.max(0, Math.min(record.index, parent.children.length)), 0, id); nodes.set(id, record); normalize(parent.id); complete("created", [id, view(id)], () => callback(view(id))); },
    update(id, changes, callback) { const record = node(id); const changeInfo = clone(changes); Object.assign(record, changeInfo); complete("changed", [id, changeInfo], () => callback(view(id))); },
    move(id, destination, callback) { const record = node(id), oldParentId = record.parentId, oldIndex = record.index, from = node(oldParentId), to = node(destination.parentId ?? oldParentId); from.children.splice(oldIndex, 1); normalize(from.id); record.parentId = to.id; to.children.splice(Math.max(0, Math.min(destination.index ?? to.children.length, to.children.length)), 0, id); normalize(to.id); complete("moved", [id, { parentId: to.id, oldParentId, index: record.index, oldIndex }], () => callback(view(id))); },
    remove(id, callback) { removeNode(id, false, callback); }, removeTree(id, callback) { removeNode(id, true, callback); },
  };
  class WebSocket { constructor(url) { this.url = url; this.readyState = 1; sockets.add(this); } addEventListener() {} close() { this.readyState = 3; sockets.delete(this); } send() {} }
  const responses = [], requests = [];
  const fetch = async (url, init = {}) => { requests.push(clone({ url: String(url), method: (init.method ?? "GET").toUpperCase(), headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ?? null })); const next = responses.shift() ?? { value: new Response() }; if (next.deferred) return next.promise; if (next.error) throw next.error; return next.value; };
  const isDomainMutation = ({ url, method }) => !["GET", "HEAD"].includes(method) && /\/(bookmarks|folders)(?:\/|$)/.test(new URL(url, "https://fake.test").pathname) && !/\/auth(?:\/|$)/.test(new URL(url, "https://fake.test").pathname);
  const harness = { chrome: { runtime: { lastError: null, onMessage: message }, storage: { local: area(local), session: area(session) }, bookmarks }, WebSocket, fetch: { fetch, requests, respond: (value) => responses.push({ value }), reject: (error) => responses.push({ error }), defer: () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); responses.push({ deferred: true, promise }); return { resolve, reject }; }, mutationCount: () => requests.filter(isDomainMutation).length }, timers: { set: (fn) => { const id = Symbol(); timers.set(id, fn); return id; }, clear: (id) => timers.delete(id), flush: () => { const due = [...timers.entries()]; due.forEach(([id]) => timers.delete(id)); due.forEach(([, fn]) => fn()); } }, mutators: { mode: (value, count = 1) => { phase = value; duplicates = count; }, flush: (order) => { const pending = queue.splice(0); (order ?? pending.map((_, index) => index)).forEach((index) => { const item = pending[index]; if (item) { deliver(item); item.callback?.(); } }); }, settle: () => harness.mutators.flush(), pending: () => queue.length }, snapshot: () => clone({ local: [...local], session: [...session], tree: view("0", true), sequence, queue: queue.map(({ kind, args, count }) => ({ kind, args, count })) }), openHandles: () => ({ listeners: events.reduce((total, item) => total + item.size, 0), timers: timers.size, sockets: sockets.size }), resetRuntime: () => { events.forEach((item) => item.clear()); timers.clear(); [...sockets].forEach((socket) => socket.close()); queue.length = 0; }, teardown: () => { harness.resetRuntime(); const handles = harness.openHandles(); if (Object.values(handles).some(Boolean)) throw new Error(`open handles: ${JSON.stringify(handles)}`); } };
  // Runtime reset intentionally models worker lifecycle only; production-module reloading is not emulated.
  return harness;
}
