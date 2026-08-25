# Design: extension-rebuild-workspace-lock

Concurrency bugfix design. **Four production edits across two files** (one new lock map, one
rewritten `rebuildWorkspace`, one new FIFO queue around `ensureManagedPath`, one diagnostic log)
plus **one test-double fidelity correction**, all inside `extension/`. No new architecture, no
backend or admin-web change, no persisted-format change, no migration, no packaging change.

Everything below is written against the **current on-disk tree of branch
`fix/extension-rebuild-workspace-lock`** (off `develop`, which carries all three shipped sync
fixes). Every line number was re-read from disk for this design and **supersedes the line numbers
quoted in `proposal.md`** where they differ (`ensureFolderByTitle` is `chrome-bookmarks.ts:169`,
`ensureManagedPath` is `:133`, `workspaceLocks.clear()` is `projection.ts:2480` — all three
confirmed unchanged). Line numbers are *pre-fix* so `sdd-tasks` can slice directly.

**This change is a reuse, not an invention.** Both primitives it needs already exist in the repo
and are already tested: `runCoalescedWorkspaceTask` (`projection.ts:883-920`, exported and unit
tested at `tests/projection-behavior.test.mjs:633`) and the promise-chain FIFO
`enqueueStateMutation` (`shared/storage.ts:168-172`). The design's job is to pick the right one for
each of the two distinct races and to prove the choice.

---

## 1. Constraints this design is bound by

| # | Constraint | Source | How the design satisfies it structurally |
|---|---|---|---|
| C1 | Rebuild MUST NOT share `workspaceLocks` with `drainLocalIntents`. The lock stores no runner, so a rebuild arriving during a drain would be satisfied by a *drain* rerun and never happen. | proposal.md:15 | ADR-301 introduces `rebuildLocks`, a second `Map<string, WorkspaceResyncLock>`. `runCoalescedWorkspaceTask` already takes the map as its first parameter (`:884`) — no helper change. |
| C2 | Separate lock domains MUST NOT create a re-entrancy deadlock. | proposal.md:23, :50 | §8 proves the lock order is strictly `rebuildLocks → managedPathQueue → stateMutationQueue`, acyclic, and that `doResyncWorkspace` never reaches `drainLocalIntents` (verified: its only call sites are `:460`, `:819`, `:879`, none reachable from `doResyncWorkspace`). |
| C3 | Per-workspace locks do **not** cover two different workspaces racing on the shared root / organization folder. | proposal.md:16 | ADR-303 serializes `ensureManagedPath` **globally**, not per organization. The managed root is shared by *every* organization, so an org-keyed lock leaves the root TOCTOU open (§5). |
| C4 | `doResyncWorkspace` returns `Promise<boolean>`; the coalescing runner returns `Promise<void>`. The boolean must survive. | task brief item 1; proposal.md:36 | ADR-302 captures it in a `let` closed over by the runner and read after the coalesced call resolves, with a resumption-order proof that the caller that actually ran the work is also the caller that reaches `connectWorkspace`. |
| C5 | The new diagnostic MUST NOT fire on the happy path. `tests/projection-behavior.test.mjs:1153` asserts `diagnostics.some(entry => entry.level === "warn") === false`. | existing test | ADR-304 gates the log on `existingId` being present **and** unresolvable. In that test the persisted `local-only-node` resolves under `workspace-node`, so the gate is not entered. |
| C6 | A regression test MUST fire rebuilds **unawaited**; the existing `:1103` sequential test passes today and cannot catch this. | proposal.md:18; task brief item 5 | ADR-305 makes the inline double's `create` asynchronous behind an opt-in flag so that "both readers read before either writer writes" is *deterministic*, not dependent on microtask offsets (§7). |
| C7 | Out of scope: `relocateToLocalOnly`'s separate TOCTOU, duplicate cleanup, backend, title-matching redesign. | proposal.md:20-24, :75-76 | §9 lists them under *not touched*. §10.3 records the residual and notes ADR-304's log is what will make it observable in the field. |
| C8 | Size: small single PR, well under the 400-line review budget. | proposal.md:61 | ~35 changed lines of production code, ~12 in the test double, plus three new tests. |

---

## 2. What the current code actually does (verified, not quoted from the proposal)

### 2.1 The coalescing helper — the proposal's fragment, confirmed verbatim

```ts
// extension/src/background/projection.ts:883-920  (CURRENT — unchanged by this design)
export async function runCoalescedWorkspaceTask(
  locks: Map<string, WorkspaceResyncLock>,
  workspaceId: string,
  reason: string,
  runner: (reason: string) => Promise<void>,
): Promise<void> {
  const active = locks.get(workspaceId);
  if (active) {
    active.rerunRequested = true;
    active.latestReason = reason;
    await active.active;                       // ← follower path: returns without ever running `runner`
    return;
  }
  const lock: WorkspaceResyncLock = { active: Promise.resolve(), rerunRequested: false, latestReason: reason };
  lock.active = (async () => {
    try {
      do {
        const currentReason = lock.latestReason;
        lock.rerunRequested = false;
        await runner(currentReason);
      } while (lock.rerunRequested);
    } finally {
      if (locks.get(workspaceId) === lock) locks.delete(workspaceId);
      lock.rerunRequested = false;
    }
  })();
  locks.set(workspaceId, lock);
  await lock.active;                           // ← leader path: registered synchronously, before any follower
}
```

The map is a **parameter** (`:884`), and the type `WorkspaceResyncLock` (`:137-141`) carries no
runner. Both facts are load-bearing: the first is why a second map costs nothing, the second is why
sharing one map would be wrong (C1).

### 2.2 The two unlocked call sites

```ts
// extension/src/background/projection.ts:401-406  (CURRENT)
export async function rebuildWorkspace(workspaceId: string): Promise<UiState> {
  await updateProjectionState(workspaceId, (current) => { current.convergenceJournal = rebuildJournal(current.convergenceJournal ?? emptyJournal()); });
  volatileRepairGates.delete(workspaceId);
  if (await doResyncWorkspace(workspaceId, "explicit rebuild", "recovering")) await connectWorkspace(workspaceId);
  return getUiState();
}
```

```ts
// extension/src/background/chrome-bookmarks.ts:133-139 / :169-176  (CURRENT)
export async function ensureManagedPath(organizationName: string, workspaceName: string): Promise<{ rootId: string; organizationId: string; workspaceId: string }> {
  const containerId = await getDefaultContainerId();
  const root = await ensureManagedRoot(containerId);                        // read-then-create #1 (shared by ALL orgs)
  const organization = await ensureFolderByTitle(root.id, organizationName); // read-then-create #2 (shared by all workspaces of the org)
  const workspace = await ensureFolderByTitle(organization.id, workspaceName);// read-then-create #3
  return { rootId: root.id, organizationId: organization.id, workspaceId: workspace.id };
}

async function ensureFolderByTitle(parentId: string, title: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const children = await getChildren(parentId);                              // T
  const existing = children.find((child) => !child.url && child.title === title);
  if (existing) return existing;
  return createFolder(parentId, title);                                      // O — Chrome permits duplicate-titled siblings
}
```

`doResyncWorkspace` (`:1000`) has **exactly one caller** — `rebuildWorkspace:404`. Verified by
grep: the identifier appears at `:404` and `:1000` only. `resyncWorkspace` (`:922`) is the disabled
automatic path (it pauses instead of resyncing). So the race is user-triggered only, and locking at
`rebuildWorkspace` covers 100% of it.

The three `ensureManagedPath` steps touch **only** `chrome.bookmarks.*` (`getDefaultContainerId:193`,
`getChildren:18`, `createFolder:44`, `updateNode:70`). No `getState`/`updateState`, no network. That
is what makes a global lock cheap (C3) and lock-order-safe (§8).

### 2.3 Why the loser's folder disappears silently

`doResyncWorkspace:1020-1028` writes `workspaceChromeId` unconditionally; last write wins.
`:1041` then calls `ensureLocalOnlyFolder` against the *winner's* folder, `:1042` clears its managed
children, `:1052` rematerializes. The loser's folder — with the user's real bookmarks and its own
`Personal (not synced)` — is left parented under the organization folder, unreferenced by any
mapping, and is never cleared because `clearManagedChildrenWithSuppression` only walks the winner.
No error is raised anywhere on that path. That is the exact "new Chrome id each time, `Personal
(not synced)` freshly empty, no error" field symptom.

---

## 3. ADR-301 — A second lock map, `rebuildLocks`, reusing the existing coalescing helper

**Decision.** Declare `const rebuildLocks = new Map<string, WorkspaceResyncLock>();` immediately
after `workspaceLocks` (`projection.ts:143`), and route `doResyncWorkspace` through
`runCoalescedWorkspaceTask(rebuildLocks, …)`.

**Rationale.**

1. **Coalescing is the right *semantic* for a user-facing button** (proposal question round #1,
   resolved): a burst of Rebuild clicks collapses into the current run plus at most one follow-up,
   every caller awaits completion, and the follow-up always carries the latest reason. This is the
   behavior users already experience for local drains, so it introduces no new UX state.
2. **A second map costs one line** because `locks` is already a parameter (`:884`) — this helper was
   written to be reused, and its unit test (`:633-667`) constructs its own `new Map()`, proving the
   contract.
3. **Sharing `workspaceLocks` is wrong twice over.** (a) The lock records no runner, so a Rebuild
   arriving during an active drain would set `rerunRequested`, await, and be "satisfied" by a second
   *drain* — the rebuild would never run and the caller would still be told it finished (C1).
   (b) `drainLocalIntents` is reachable from listener callbacks; if any such path ever ran inside the
   rebuild's critical section it would take the same key, set `rerunRequested`, and `await
   active.active` — awaiting the promise it is itself inside. Deadlock. Separate domains make that
   structurally impossible (C2).
4. **Cost of separate domains, stated honestly:** drain and rebuild are *not* mutually exclusive.
   That is the status quo (`proposal.md:23`), not a regression, and it is the deliberate price of
   (3b).

**Rejected alternatives.**

- *A per-workspace `Promise` in-flight dedup like `socketConnectFlights` (`:81`, used by
  `connectWorkspace:748-760`).* Rejected: it collapses a burst to the **first** run and drops every
  later request. For Rebuild that is wrong — a click after the resync has already read the backend
  tree must still produce a fresh resync, or the user's second click is silently ignored. Coalescing
  keeps exactly that follow-up.
- *A plain mutex (no coalescing) so N clicks produce N sequential resyncs.* Rejected: N full
  tree-fetch + clear + rematerialize cycles per burst, for an outcome identical to two.
- *Locking inside `doResyncWorkspace` instead of `rebuildWorkspace`.* Rejected: `rebuildJournal`
  (`:402`) and `volatileRepairGates.delete` (`:403`) run *before* the resync and are part of the
  same user action; leaving them outside means a second click can rewrite the journal underneath a
  running rebuild. Locking at the public entry point makes the whole button one critical section.

---

## 4. ADR-302 — The boolean crosses the `void` runner boundary in a captured `let`

**Decision.**

```ts
// extension/src/background/projection.ts:401-406  (REPLACEMENT)
export async function rebuildWorkspace(workspaceId: string): Promise<UiState> {
  await updateProjectionState(workspaceId, (current) => { current.convergenceJournal = rebuildJournal(current.convergenceJournal ?? emptyJournal()); });
  volatileRepairGates.delete(workspaceId);
  let resynced = false;
  await runCoalescedWorkspaceTask(rebuildLocks, workspaceId, "explicit rebuild", async (reason) => {
    resynced = await doResyncWorkspace(workspaceId, reason, "recovering");
  });
  if (resynced) await connectWorkspace(workspaceId);
  return getUiState();
}
```

**Why this is correct, not merely convenient — the resumption-order proof.**

- The runner closure belongs to the **leader** (the caller that created the lock). The `do/while` at
  `:905-909` re-invokes *that same closure* for every coalesced rerun, so after the loop ends
  `resynced` holds the outcome of the **last run that actually executed** — which is precisely the
  run that satisfies every follower. Reading a stale first-pass value is impossible.
- **Followers never run the runner**, so their own `resynced` stays `false` and they skip
  `connectWorkspace`. That is safe because the leader always performs it: the leader registers its
  `await lock.active` at `:919` *synchronously within its own call*, before any follower can reach
  `:893`. Continuations on a settled promise run in registration order, so the leader resumes first,
  evaluates `if (resynced)` and enters `connectWorkspace` before any follower returns.
- Net effect: **exactly one** `connectWorkspace` per burst instead of N. `connectWorkspace` is
  itself in-flight-deduped (`:748-759`), so N was already collapsing to one socket — the change is a
  simplification, not a behavior change.
- Followers return `getUiState()` while that connect is still in flight. Identical to today:
  `socketConnected` is only set later, inside `onAck` (`:809`), so no caller has ever observed a
  connected socket in the `UiState` returned by `rebuildWorkspace`.

**Rejected alternatives.**

- *A module-level `Map<string, boolean>` of last rebuild outcomes, read by every caller.* It would
  let followers observe the true outcome too. Rejected: new module state that must be added to
  `resetRuntimeState`, an unanswerable "who deletes the entry" question (leader-deletes races
  follower-reads), and **zero behavioral gain** — the leader already performs the only
  `connectWorkspace` that matters, and it is deduped anyway.
- *Widen `runCoalescedWorkspaceTask` to `runner: (reason) => Promise<T>` and return `T`.* Rejected:
  it changes a helper that `drainLocalIntents` (`:464`) shares and that has a pinned unit test
  (`:633`), to serve one call site. The coalescing contract also has no single answer for "which
  `T` does a follower get" — the `let` makes that question local and explicitly answered above.
- *Call `connectWorkspace` unconditionally after the lock.* Rejected: it would connect after a
  **failed** resync, discarding the existing `if (await doResyncWorkspace(...))` guard, which exists
  so a paused/failed workspace does not open a socket.

---

## 5. ADR-303 — `ensureManagedPath` is serialized by a single global FIFO queue, mirroring `enqueueStateMutation`

**Decision.** Add a module-private promise-chain queue in `chrome-bookmarks.ts` and wrap the whole
body of `ensureManagedPath`. `ensureManagedRoot` and `ensureFolderByTitle` are **not** modified.

```ts
// extension/src/background/chrome-bookmarks.ts — module scope, after LEGACY_ROOT_FOLDER_TITLE (~:3)

// ensureManagedPath is a three-step check-then-create (root → organization → workspace) against a
// tree Chrome lets anyone mutate concurrently, and every step is shared with other workspaces: the
// managed root by every organization, the organization folder by every workspace inside it. Two
// overlapping resyncs both read "absent" and both create, and Chrome happily keeps duplicate-titled
// siblings. Serializing the whole composite is what makes "resolve or create, exactly once" true.
let managedPathQueue: Promise<unknown> = Promise.resolve();

function enqueueManagedPathTask<T>(task: () => Promise<T>): Promise<T> {
  const next = managedPathQueue.then(task, task);
  managedPathQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function ensureManagedPath(organizationName: string, workspaceName: string): Promise<{ rootId: string; organizationId: string; workspaceId: string }> {
  return enqueueManagedPathTask(async () => {
    const containerId = await getDefaultContainerId();
    const root = await ensureManagedRoot(containerId);
    const organization = await ensureFolderByTitle(root.id, organizationName);
    const workspace = await ensureFolderByTitle(organization.id, workspaceName);
    return { rootId: root.id, organizationId: organization.id, workspaceId: workspace.id };
  });
}
```

**Rationale.**

1. **Not `runCoalescedWorkspaceTask`.** Coalescing is *collapse to the latest* — correct for a
   user-facing button whose runs are interchangeable, wrong for an internal resolver whose callers
   each need **their own** return value. A follower here must not be told "someone else's path is
   yours"; it must wait its turn and then re-read the tree, at which point the winner's folders are
   visible and `ensureFolderByTitle` reuses them. A FIFO queue gives exactly that; coalescing cannot.
2. **Global, not per organization (C3).** The org name is available (`ensureManagedPath`'s first
   parameter) so an org-keyed lock is *implementable* — and still wrong: `ensureManagedRoot` runs on
   the **shared default container** for every organization, so two different orgs bootstrapping
   concurrently would still both create a managed root. Fixing that would require a two-level lock
   (global for the root, per-org for the org folder) — more moving parts, a lock-ordering rule to
   maintain, for a critical section that is 3–4 local `chrome.bookmarks` calls with **no network and
   no storage**. The only thing a global lock serializes is multi-workspace bootstrap, and only for
   the duration of those calls (proposal.md risk row 3).
3. **The primitive already exists in this repo.** `enqueueStateMutation`
   (`shared/storage.ts:168-172`) is the same three lines, and this design copies its exact shape
   including `\.then(task, task)` — which runs the next task on **both** settlement paths, so one
   rejected `ensureManagedPath` cannot poison the queue for every later workspace, and the tail
   `.then(() => undefined, () => undefined)` keeps the chain unrejected.
4. **No reset hook needed.** Unlike `rebuildLocks`, the queue holds no keyed state: it is a single
   tail promise that is always settled between bursts and self-drains. Adding it to
   `resetRuntimeState` (which lives in `projection.ts` and cannot see a private in
   `chrome-bookmarks.ts`) would require a new export for no benefit.
5. **`ensureFolderByTitle` stays untouched** because the invariant is *composite*: "root, org and
   workspace resolved against one consistent view". Locking each leaf independently would still let
   two callers interleave *between* steps and derive a workspace folder under a root that the other
   caller replaced.

**Rejected alternative — an in-flight `Map<string, Promise<…>>` keyed by `org/workspace`
(`socketConnectFlights` shape).** Rejected: sharing one resolved path between concurrent callers of
the *same* key is fine, but callers of *different* keys are exactly the cross-workspace race in C3,
and a per-key map does not order them at all.

---

## 6. ADR-304 — One `warn` in `ensureLocalOnlyFolder`, gated on an unresolvable persisted id

**Decision.**

```ts
// extension/src/background/projection.ts:1093-1114  (REPLACEMENT — added lines marked)
async function ensureLocalOnlyFolder(workspaceId: string, workspaceChromeId: string): Promise<string> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  const existingId = projection?.localOnlyChromeId;
  let unresolved: "missing" | "reparented" | undefined;                                     // +
  if (existingId) {
    const existingNode = await getNode(existingId);
    if (existingNode && existingNode.parentId === workspaceChromeId) {
      return existingId;
    }
    unresolved = existingNode ? "reparented" : "missing";                                   // +
  }

  const children = await getChildren(workspaceChromeId);
  const reused = children.find((child) => !child.url && child.title === LOCAL_ONLY_FOLDER_TITLE);
  const folderNode = reused ?? await withSuppression(
    async () => createFolder(workspaceChromeId, LOCAL_ONLY_FOLDER_TITLE),
    [workspaceChromeId],
  );

  if (unresolved) {                                                                          // +
    await log(                                                                               // +
      `sync:${workspaceId}`,                                                                 // +
      `local-only folder ${existingId} ${unresolved} under workspace ${workspaceChromeId}; ${reused ? `reused title match ${folderNode.id}` : `created ${folderNode.id}`}`, // +
      "warn",                                                                                // +
    );                                                                                       // +
  }                                                                                          // +

  await updateProjectionState(workspaceId, (current) => {
    current.localOnlyChromeId = folderNode.id;
  });
  return folderNode.id;
}
```

**Placement — after resolution, before the id is persisted.** `proposal.md:17` requires the message
to state *"whether it reused a title match or created a folder"*, which is only knowable after
`folderNode` exists; `proposal.md:67` asks for it *"before recreation"*. Both are satisfied by
placing it between resolution and `updateProjectionState`: the diagnostic is written **before the
new identity is committed to persisted state**, so a workspace can never show a swapped
`localOnlyChromeId` without a preceding warn. `log:1847` goes through `updateState`, which is FIFO
(`storage.ts:168`), so that ordering is guaranteed, not incidental.

**Signature check.** `log(scope, message, level)` (`projection.ts:1847-1849`), `level: "info" |
"warn" | "error"`. The `sync:${workspaceId}` scope matches the neighboring calls at `:1081`,
`:1127`, `:880`.

**Level `warn`, not `info`:** an unresolvable persisted id *is* the identity churn this change
exists to prevent; after the two locks land, this log firing in the field means a remaining path
(`relocateToLocalOnly`, §10.3) mutated the folder, and it must be greppable next to the other
`warn`s. **`existingId === undefined` deliberately does not log** — that is normal first bootstrap,
and logging it would drown the signal and break C5's neighbouring test at `:1153`.

---

## 7. ADR-305 — An opt-in asynchronous `create` in the inline Chrome double, so the RED is deterministic

**The problem.** The inline double's `chrome.bookmarks.create` (`tests/projection-behavior.test.mjs:130-142`)
invokes its callback **synchronously**, unlike `storage.local` in the same file, which already uses
`setTimeout(…, 0)` (`:84`, `:89`, `:104`). Two unawaited `rebuildWorkspace()` calls do interleave
(every `getState`/`fetch` is a real async boundary), but whether *both* `getChildren` reads land
before *either* `createFolder` write depends on the microtask offset between the two flights. A test
that depends on that is a coin flip, and a flaky RED is worse than no RED.

**Decision.** Mirror the `enforceStrictIndices` precedent (`:10`, `:132`, reset at `:421`): add
`let asyncBookmarkCallbacks = false;` and, when it is on, defer the whole body of `create` onto a
macrotask.

```js
// extension/tests/projection-behavior.test.mjs:130  (REPLACEMENT shape)
    create(details, callback) {
      const run = () => { /* …existing body, unchanged… */ };
      if (asyncBookmarkCallbacks) { setTimeout(run, 0); return; }
      run();
    },
```

**Why this makes the race deterministic.** Microtasks always drain before timers. With the flag on,
flight A reaches `createFolder` and schedules `T_A`; A suspends; flight B — still inside the
microtask drain — performs its `getChildren`, sees no folder (nothing has been created yet, because
`T_A` has not run), and schedules `T_B`. Both timers then fire and both folders exist. The duplicate
is produced by construction, for **any** interleaving of the two flights, not just a lucky one.
Post-fix the same test is green by construction too: the queue (ADR-303) / the lock (ADR-301) means
B's `getChildren` runs strictly after A's `create` has completed.

**Why opt-in rather than global.** ADR-204 of the sibling change made the double's `move` faithful
with no flag, justified by a per-test audit proving nothing broke. That audit is not available here:
deferring `create` changes the *timing* of every test in the file that materializes bookmarks, and
this file mutates globals per test (`:472-481` replaces `globalThis.setTimeout` wholesale for the
keepalive test). An opt-in flag is the proportionate, in-repo-precedented answer; the three new
tests are the only ones that set it, and `resetRuntime` (`:421`) clears it. **`getChildren` is
deliberately left synchronous** — making the *read* async would push B's read past A's write and
*hide* the race.

---

## 8. Data flow and lock order

```
 popup "Rebuild" (click 1)            popup "Rebuild" (click 2, same tick)
        │                                       │
        ▼                                       ▼
 rebuildWorkspace:401                    rebuildWorkspace:401
   rebuildJournal :402                     rebuildJournal :402
   volatileRepairGates.delete :403         volatileRepairGates.delete :403
        │                                       │
        ▼                                       ▼
 runCoalescedWorkspaceTask(rebuildLocks, id, "explicit rebuild", runner)   ◄── ADR-301
        │ leader: creates lock, runs runner            │ follower: rerunRequested = true
        │                                              └─ await lock.active ─────┐
        ▼                                                                        │
   doResyncWorkspace:1000                                                        │
        ├─ getWorkspaceTree :1017        (network)                               │
        ├─ ensureManagedPath :1018 ─────► enqueueManagedPathTask  ◄── ADR-303    │
        │       (FIFO, global)              getDefaultContainerId :193           │
        │                                   ensureManagedRoot     :178           │
        │                                   ensureFolderByTitle   :169 ×2        │
        ├─ updateProjectionState :1020   (stateMutationQueue, storage.ts:168)    │
        ├─ ensureLocalOnlyFolder :1041 ──► warn on unresolvable id  ◄── ADR-304  │
        ├─ clearManagedChildren  :1042                                           │
        ├─ materializeFolder     :1052                                           │
        └─ replay + checkpoint   :1056-1079 → returns boolean ──► `resynced`     │
        │                                                                        │
        ▼  do/while: rerunRequested → runner runs again with latest reason       │
   lock drains, locks.delete :912 ──────────────────────────────────────────────►┘
        ▼                                        ▼
   if (resynced) connectWorkspace :404      getUiState()  (leader resumes first — §4)
```

**Lock-order invariant (C2):** `rebuildLocks → managedPathQueue → stateMutationQueue`, always in
that direction, never the reverse. Provable, not asserted: `ensureManagedPath`'s critical section
calls only `chrome.bookmarks.*` — no `getState`/`updateState`, so it cannot re-enter the storage
queue's owner; and nothing inside `chrome-bookmarks.ts` imports `projection.ts`, so it cannot reach
`rebuildLocks`. `workspaceLocks` sits outside this chain entirely and is never taken inside it
(`drainLocalIntents`'s three call sites — `:460`, `:819`, `:879` — are unreachable from
`doResyncWorkspace`).

---

## 9. Change inventory

| # | File:line (pre-fix, verified on disk) | Change | ADR |
|---|---|---|---|
| 1 | `extension/src/background/projection.ts:143` (insert after) | `const rebuildLocks = new Map<string, WorkspaceResyncLock>();` | 301 |
| 2 | `extension/src/background/projection.ts:401-406` | `rebuildWorkspace` routes `doResyncWorkspace` through `runCoalescedWorkspaceTask(rebuildLocks, …)`; boolean via captured `let resynced` | 301/302 |
| 3 | `extension/src/background/projection.ts:1093-1114` | `ensureLocalOnlyFolder`: `unresolved` tracking + one `warn` before `updateProjectionState` | 304 |
| 4 | `extension/src/background/projection.ts:2480` (insert after `workspaceLocks.clear()`) | `rebuildLocks.clear();` inside `resetRuntimeState` | 301 |
| 5 | `extension/src/background/chrome-bookmarks.ts:3` (insert after) | `managedPathQueue` + `enqueueManagedPathTask` | 303 |
| 6 | `extension/src/background/chrome-bookmarks.ts:133-139` | `ensureManagedPath` body wrapped in `enqueueManagedPathTask` | 303 |
| 7 | `extension/tests/projection-behavior.test.mjs:10` / `:130-142` / `:421` | `asyncBookmarkCallbacks` flag, deferred `create`, reset in `resetRuntime` | 305 |
| 8 | `extension/tests/projection-behavior.test.mjs:274` | add `ROOT_FOLDER_TITLE` to the existing `dist/shared/runtime.js` import | §11 |
| 9 | `extension/tests/projection-behavior.test.mjs` (append after `:1127`) | T-R1..T-R4 | §11 |

**Explicitly not touched:** `runCoalescedWorkspaceTask` (`:883-920`) and `WorkspaceResyncLock`
(`:137-141`) — reused as-is; `workspaceLocks` / `drainLocalIntents` / `drainLocalIntentsNow`;
`doResyncWorkspace`'s body (`:1000-1091`); `relocateToLocalOnly` (`:1116`); `connectWorkspace` /
`socketConnectFlights`; `ensureFolderByTitle` (`:169`) and `ensureManagedRoot` (`:178`) bodies;
`getDefaultContainerId` (`:193`); all of `convergence.ts`; `shared/storage.ts`; `shared/types.ts`;
`tests/helpers/fake-chrome.mjs`; `extension/scripts/package.mjs`; anything under `backend/` or
`admin-web/`.

---

## 10. Self-heal proof

### 10.1 An install that already has duplicate folders

The fix is **preventive**, and it must not silently pick the wrong survivor. Post-fix, the next
Rebuild takes the managed-path queue alone and runs `ensureFolderByTitle`, which returns
`children.find(…)` — the **first** matching sibling, i.e. Chrome's index order. That is stable
across rebuilds (the double and Chrome both preserve sibling order), so the workspace re-binds to
one specific duplicate and stops churning; the other duplicates remain as inert user-visible
folders. They are not deleted (`clearManagedChildrenWithSuppression` only walks the bound folder),
so **no user data is destroyed by the fix** — matching `proposal.md`'s risk row 4: cleanup is
manual and belongs in release notes.

### 10.2 The `Personal (not synced)` symptom

Post-fix, a rebuild resolves the *same* `workspaceChromeId` every time, so
`ensureLocalOnlyFolder:1096-1101` finds the persisted `localOnlyChromeId` still parented there and
returns early — no title lookup, no create, and `:1042` preserves it via the `excludeIds` argument.
The "freshly empty" folder is unreachable for the burst-click cause. Pinned by T-R1/T-R2.

### 10.3 Residual, recorded not hidden

`relocateToLocalOnly:1116-1120` calls `ensureLocalOnlyFolder` from the chrome-listener path, outside
`rebuildLocks`, so a remote event landing mid-rebuild can still race the local-only folder. Out of
scope by explicit decision (`proposal.md:75`) because folding it in crosses into the drain/rebuild
re-entrancy hazard §3(3b) avoids. **ADR-304's warn is the instrumentation for that follow-up** — it
is the only way that race will announce itself in the field.

---

## 11. Test strategy (Strict TDD, two RED/GREEN cycles)

Runner: `cd extension && npm run test:projection` (`package.json:10` — `npm run build && node --test
tests/*.test.mjs`), `node:test` + `node:assert/strict`, importing compiled `../dist/`. Home:
`extension/tests/projection-behavior.test.mjs`, which already imports `rebuildWorkspace` (`:266`),
`runCoalescedWorkspaceTask` (`:268`), `getState`/`setState` (`:272`), `LOCAL_ONLY_FOLDER_TITLE`
(`:274`), and already hosts the sequential sibling at `:1103` and the coalescing unit test at `:633`.

**Step 0 (gate, no new assertions):** land ADR-305's flag with `asyncBookmarkCallbacks = false`
everywhere and confirm the full suite is green. A default-false flag must be a no-op; if anything
turns red, the double's edit is wrong, not a test.

| ID | Name | Cycle | What it pins |
|---|---|---|---|
| T-R1 | `concurrent rebuilds of one workspace produce a single managed folder with a stable chrome id` | RED before #2 | `asyncBookmarkCallbacks = true`; one awaited `rebuildWorkspace` to establish the path, capture `workspaceChromeId`; then `const a = rebuildWorkspace("workspace-1"); const b = rebuildWorkspace("workspace-1"); await Promise.all([a, b]);` — **no `await` between the two calls** (this is the entire difference from `:1103`). Assert: exactly one child of the org folder titled `"Workspace"`; `projection.workspaceChromeId` **unchanged** from the captured value; exactly one `LOCAL_ONLY_FOLDER_TITLE` child; `projection.localOnlyChromeId` equals its id. |
| T-R2 | `a concurrent rebuild burst never orphans the local-only folder's contents` | RED before #2 | Same shape, with a bookmark seeded inside the local-only folder before the burst. Assert the node still exists and is still parented under `projection.localOnlyChromeId`. Directly encodes the "freshly empty `Personal (not synced)`" symptom. |
| T-R3 | `concurrent rebuilds of two workspaces in one organization share one root and one organization folder` | RED before #6 | Two projections (`workspace-1`/`workspace-2`, both `organizationName: "Org"`, names `"Workspace A"`/`"Workspace B"`), `selectedWorkspaceIds` for both, fetch handlers for both `/tree` URLs (`url.includes("afterCursor=0")` already serves both). Fire both `rebuildWorkspace` calls unawaited, `await Promise.all`. Assert: exactly one child of container `"1"` titled `ROOT_FOLDER_TITLE`; exactly one child of it titled `"Org"`; two distinct workspace folders under it; and `rootChromeId`/`organizationChromeId` **equal across the two projections**. This is the test the per-workspace lock alone cannot make green — it is what justifies ADR-303. |
| T-R4 | `an unrecognizable local-only folder is logged before its identity is replaced` | RED before #3 | Pre-seed the full managed path (container → root → `"Org"` → `"Workspace"` → a `Personal (not synced)` child), set `projection.localOnlyChromeId` to a stale id that is absent from the tree, run **one awaited** rebuild. Assert a `warn` diagnostic whose message contains the stale id and `reused title match`; assert `projection.localOnlyChromeId` now equals the pre-seeded folder's id; assert no duplicate local-only folder. Also assert (C5) that a clean rebuild in T-R1 emits **no** `warn`. |

**Layer table**

| Layer | What to test | Approach |
|---|---|---|
| Unit | Coalescing contract of `runCoalescedWorkspaceTask` with an independent map | Already covered by `:633-667`; unchanged, and it is the evidence that a second map is a supported use |
| Integration | T-R1..T-R4 | `node:test` against `dist/`, inline Chrome + fetch + WebSocket doubles, unawaited concurrent entry points |
| E2E | N/A | No browser E2E harness in this repo |

**Not a test to write:** anything asserting the *number* of `/tree` fetches during a burst. Two
concurrent clicks legitimately produce two runs (current + one coalesced follow-up); asserting `1`
would pin coalescing as deduplication, which it is not.

---

## 12. Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The change is in-process concurrency control over
`chrome.bookmarks.*` calls that already exist.

## 13. Migration / Rollout

No migration required. Both locks are in-memory only; no schema, persisted-state, message-format,
or backend change. Rollback is a single revert of the branch merge. Release notes must state that
folders duplicated by *past* incidents are not auto-removed (§10.1).

## 14. Open Questions

None. All four proposal questions were resolved by the orchestrator (`proposal.md:71-77`), and this
design's own three forks — separate vs. shared lock map (§3), captured `let` vs. outcome map (§4),
global vs. per-organization `ensureManagedPath` lock (§5) — are decided with rationale above.
