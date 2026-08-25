# Design: extension-auto-repair-before-degraded

Bounded self-healing design. **Three chained slices**, all inside `extension/`: Slice A gives
resync-shaped pauses the disposition that makes repair possible at all (3 edits), Slice B routes the
two silently-invisible journal pauses through the one degrade path (1 edit), Slice C adds the
bounded auto-repair layer above the pause decision (1 new field, 1 new map, 1 rewritten function, 2
new functions, 3 reset sites, 1 runtime reset, 2 test hooks). No backend or `admin-web` change, no
message-format change, no migration, no packaging change.

Everything below is written against the **current on-disk tree of branch
`feature/extension-auto-repair-on-pause`** (off `develop`, which carries the four shipped sync
fixes). **Every line number in this document was re-read from disk while writing it** and
supersedes any number quoted in `exploration.md` or `proposal.md` where they differ. Line numbers
are *pre-change* so `sdd-tasks` can slice directly.

**This design exists because two undesigned attempts failed.** Attempt 1 blocked on the repair
dispatch and broke 18 tests. Attempt 2 went fire-and-forget, got to 4 failures, fixed 3, and then
hit two unresolved symptoms: within one recovery chain two sequential `pauseWorkspace` calls both
recorded the new attempt counter as `1` (never `2`), and the *full* suite hung with no output for
2+ minutes while the failing test passed in isolation. §3, §4 and §11 close those two specific gaps
with mechanisms and proofs, not with assertions; §12 designs the tests that fail *fast and legibly*
if either recurs. Everything else in this document is subordinate to that goal.

---

## 1. Constraints this design is bound by

| # | Constraint | Source | How the design satisfies it structurally |
|---|---|---|---|
| C1 | Two separate `pauseWorkspace` invocations for one workspace MUST NOT both conclude "no repair is running, I'll start one". | attempt 2's `1, 1` counter | ADR-401: the in-flight claim is written **inside** the `updateProjectionState` updater, in the same serialized `stateMutationQueue` slot that decides to pause. §3.2 proves no interleaving window exists there, and that a claim written *after* the `await` does have one. |
| C2 | A repair action's own downstream pauses MUST NOT start a second chain, and MUST NOT consume budget. | attempt 2's nested `recoverWorkspace("resync")` pause | ADR-402: the counter is incremented **only** in the same updater that arms a dispatch. A nested pause finds the claim held, so it takes neither branch: it gates the journal, stays `recovering`, and returns. §4.3 traces the exact failing scenario. |
| C3 | The attempt budget MUST be monotonic for as long as the workspace stays broken; nothing on the repair path may reset it. | attempt 2's `1, 1` counter (second, likelier root cause — §3.4) | ADR-403: `autoRepairAttempts` resets at exactly the three sites `recoveryAttemptCount` already resets at, and **explicitly not** in `enterRecovery` (`projection.ts:2040-2045`), which clears `degradedAt`/`degradedReason` on the repair path and is the natural place to make this mistake. T-C6 pins it. |
| C4 | The suite MUST NOT be able to hang again. A regression MUST surface as a fast, legible failure. | attempt 2's 2+ minute silent hang | §11.4 identifies the mechanism (a fire-and-forget chain outliving its test and re-arming `setTimeout`, the same class of leak the file already documents at `tests/projection-behavior.test.mjs:471-478`). §12.1 adds three independent fast-failure fuses: bounded chains in `settleAutoRepair`, a mock-`fetch` budget, and per-test `{ timeout }`. |
| C5 | `pauseWorkspace`'s timing contract for its 12 existing call sites MUST NOT change. | proposal.md:39 (D4), attempt 1's 18 failures | ADR-402: dispatch is `void`-ed inside a `finally`, never awaited. The only added `await` on the pause path is the counter/claim write, which is the same single `updateProjectionState` call the function already makes. |
| C6 | A pause whose durable write fails MUST claim nothing and dispatch nothing. `applyRemoteEnvelope:1270-1275` depends on `pauseWorkspace` still throwing there. | `projection.ts:1265`, `:1270-1275`; test `:1437` | ADR-401's `catch` releases the claim and rethrows before any dispatch. T-C7 pins it with the existing `storageSetFailure` hook. |
| C7 | Automatic repair MUST NOT prune unacknowledged local intent. | `openspec/specs/extension-sync-convergence/spec.md:72` ("Unacknowledged intent MUST NOT be pruned") | ADR-406: `planAutoRepair` refuses a rebuild-shaped repair whenever any local intent is not `acked`, because `rebuildJournal` (`convergence.ts:113`) drops exactly those. The workspace degrades instead and the human decides. |
| C8 | Automatic paths MUST NOT run an unbounded destructive resync. | spec.md:81, spec.md:86; test names at `tests/projection-behavior.test.mjs:1056`, `:1092`, `:2260` | ADR-404: Slice A does **not** restore an inline `doResyncWorkspace` call at 8 call sites. Rematerialization only ever happens through the single bounded, counted, claimed auto-repair layer, capped at 2 per workspace per live-return. |
| C9 | `enterRecovery`'s give-up branch MUST keep `degradedReason` as its human reason and MUST NOT gate the journal. | test `:1467-1485` (asserts `degradedReason === "websocket closed"`); §5.2's three harms | ADR-405: Slice B is narrowed to `captureLocalUpdateOrMove`. `enterRecovery` is left byte-for-byte unchanged, with a proof that it already *is* a bounded pre-degrade repair layer (`MAX_SILENT_RECOVERY_ATTEMPTS = 3`, `projection.ts:86`). |
| C10 | The visible red-dot signal MUST remain `health === "degraded"` and nothing else. | `shared/ui/status.ts:75`, `:81-87`, `:232`, `:262`, `:300-309` | §2.4: `recovering` has its own card style (`theme.css:436-438`) and is excluded from `degradedWorkspaceCount`, so the intermediate state is visible in the popup without painting the toolbar badge. |
| C11 | Persisted state MUST stay backward compatible with installs that predate the counter. | proposal.md:64 | ADR-403: `autoRepairAttempts` is normalized with `?? 0` in `normalizeProjectionState` (`shared/storage.ts:82-91`), exactly like `recoveryAttemptCount` (`:87`). Old code ignores the extra key. |
| C12 | Each slice MUST be an independently reviewable, independently revertable commit under the 400-line review budget. | proposal.md:60, D6 | §10's inventory is grouped by slice; §13 gives the stacked-branch plan and a per-slice rollback. Slice A ≈ 10 production lines, Slice B ≈ 12, Slice C ≈ 90. |

---

## 2. What the current code actually does (verified, not quoted from the proposal)

### 2.1 The serialization primitive everything rests on

```ts
// extension/src/shared/storage.ts:49-56, 168-172  (CURRENT — unchanged by this design)
export async function updateState(updater: (state: ExtensionState) => ExtensionState | Promise<ExtensionState>): Promise<ExtensionState> {
  return enqueueStateMutation(async () => {
    const current = await getState();
    const next = await updater(current);
    await chromeStorageSet({ [STORAGE_KEY]: next });
    return next;
  });
}

function enqueueStateMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const next = stateMutationQueue.then(mutation, mutation);
  stateMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}
```

Three facts, all load-bearing:

1. **Total order.** For enqueues A then B, B's `mutation` body cannot start until A's returned promise
   has settled, because `stateMutationQueue` is re-pointed at A's tail before B chains onto it. The
   whole `getState → updater → chromeStorageSet` cycle is one indivisible slot.
2. **The updater passed by `updateProjectionState` (`projection.ts:1747-1766`) is synchronous** — a
   plain `(projection: ProjectionState) => void`. It contains no `await`, so it runs to completion
   inside its slot with zero interleaving of any kind, including with other `updateState` slots.
3. **`getState()` is *not* queued** (`storage.ts:26-43` calls `chromeStorageGet` directly). Any value
   read outside an updater is a snapshot that may be stale by the time it is used. This is why the
   decision to repair must be taken *inside* an updater and never from a pre-read projection.

`recoveryAttemptCount` is the existing proof that pattern (2) works: `enterRecovery`
(`projection.ts:2024-2048`) reads and increments it inside the updater at `:2028`/`:2042`, and test
`:1467-1485` shows it counting `1, 2, 3` then degrading, deterministically, across four separate
invocations.

### 2.2 The pause choke point and its 12 call sites — re-verified

```ts
// extension/src/background/projection.ts:2010-2022  (CURRENT)
async function pauseWorkspace(workspaceId: string, cursor: number, reason: Parameters<typeof gateRemoteEffect>[2]): Promise<void> {
  let disposition: "retry" | "rebuild" = "retry";
  await updateProjectionState(workspaceId, (projection) => {
    projection.convergenceJournal = gateRemoteEffect(projection.convergenceJournal ?? emptyJournal(), cursor, reason);
    if (projection.convergenceJournal.receipts?.some((receipt) => receipt.status === "pending")) projection.convergenceJournal.repairDisposition = "rebuild";
    disposition = projection.convergenceJournal.repairDisposition ?? "retry";
    projection.status = "error";
    projection.health = "degraded";
    projection.degradedReason = reason;
    projection.degradedAt = new Date().toISOString();
  });
  await log(`repair:${workspaceId}`, `paused cursor ${cursor}; ${reason}; disposition ${disposition}`, "warn");
}
```

The exploration's 12-call-site map is **accurate against this tree** — all twelve line numbers still
hold: `:529` (local-intent dispatch failed), `:749` (`bootstrap-required`), `:928`
(`resyncWorkspace`), `:1090` (`doResyncWorkspace` catch), `:1198` / `:1271` (`applyRemoteEnvelope`
receipt-capacity and catch-all), `:1380` / `:1392` (folder upsert capacity guards), `:1490` /
`:1503` (bookmark upsert capacity guards), `:2007` (`recoverWorkspace`, `mode === "resync"`),
`:2213` (`recoverSubtreeThenWorkspace` terminal fallback).

`gateRemoteEffect` (`convergence.ts:102-104`) always sets `phase: "paused"`, `pauseReason`,
`failedCursor`, and a `repairDisposition` that is `"rebuild"` **only** for `bootstrap-required` and
`"retry"` for all fifteen other reasons.

### 2.3 The two non-`pauseWorkspace` degrade paths

```ts
// extension/src/background/projection.ts:435-454  (CURRENT — the invisible pauses)
async function captureLocalUpdateOrMove(context: LocalIntentContext, chromeId: string, kind: "changed" | "moved"): Promise<void> {
  const node = await getNode(chromeId);
  if (!node) {
    await updateProjectionState(context.workspaceId, (projection) => {
      const journal = projection.convergenceJournal ?? emptyJournal();
      journal.phase = "paused";
      journal.pauseReason = projection.lastCursor === 0 ? "cursor-zero-read-failed" : "ambiguous-operation";
      projection.convergenceJournal = journal;
    });
    return;
  }
  if (!await isWithinWorkspace(node, context.projection.workspaceChromeId)) {
    await updateProjectionState(context.workspaceId, (projection) => { /* … "stale-mapping" … */ });
    return;
  }
  …
}
```

Neither block touches `health`, `status`, `degradedReason`, `failedCursor` or `repairDisposition`.
The workspace is left showing `live` while `applyRemoteEnvelope:1196` and `drainLocalIntentsNow:477`
both early-return forever on the paused journal. That is a **shipped defect**: three pause reasons
that the user can never see. Slice B fixes it (ADR-405).

`enterRecovery`'s give-up branch (`:2031-2038`) is the other path, and it is *not* the same kind of
thing — see §5.2.

### 2.4 What "degraded" means to the UI — re-read, and one exploration claim corrected

- Toolbar red dot: `status.ts:79-87`, gated on `overview.degradedWorkspaceCount > 0`, which counts
  only `projection.health === "degraded"` (`:75`).
- Card: `getCardClassName` (`:300-309`) → `ui-card--degraded` only for `degraded`;
  `ui-card--recovering` (`theme.css:436-438`, amber border) for `recovering`; label "Recovering"
  (`:291-292`).

So `health: "recovering"` during the silent attempts is visible in the popup and invisible on the
toolbar. Proposal resolution #1 is confirmed against the code.

**Correction to `exploration.md:8`:** it claims a workspace degraded through `enterRecovery` has the
UI "fall back to `Retry available`". It does not. `status.ts:238-240` computes the repair label only
`if (projection.convergenceJournal?.pauseReason)`; with no pause reason the label is `undefined` and
`detail` falls through to `degradedReason` (`:241-242`) — i.e. `"websocket closed"`, which is
correct and honest. There is no UI gap to fix on that path, which removes the exploration's main
argument for folding `enterRecovery` into `pauseWorkspace` (§5.2).

### 2.5 The two repair actions already exist and are already the user's buttons

```ts
// extension/src/background/projection.ts:391-411  (CURRENT)
export async function retryWorkspace(workspaceId: string): Promise<UiState> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) return getUiState();
  let retryable = false;
  await updateProjectionState(workspaceId, (current) => { current.convergenceJournal = retryJournal(current.convergenceJournal ?? emptyJournal()); retryable = current.convergenceJournal.phase === "replay"; if (retryable) current.status = "syncing"; });
  if (!retryable) return getUiState();
  volatileRepairGates.delete(workspaceId);
  await replayWorkspaceDelta(workspaceId, projection.lastCursor, "explicit retry");
  return getUiState();
}

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

This change invents **no** repair machinery. The auto-repair layer calls exactly these two
functions, which are already locked (`rebuildLocks`, from the sibling change), already
in-flight-deduped downstream (`socketConnectFlights:753-765`), and already tested.

`retryJournal` (`convergence.ts:105-110`) escalates to `"rebuild"` — leaving `phase: "paused"` and
making `retryWorkspace` a no-op at `:396` — when the reason is `bootstrap-required`, when the
disposition is already `rebuild`, or when any receipt is still `pending`. `planAutoRepair` (ADR-406)
mirrors those three conditions exactly, so the layer never dispatches a retry that is a guaranteed
no-op.

---

## 3. ADR-401 — One decision point, and the claim is written inside the atomic updater

**Decision.** Keep `pauseWorkspace` as the single place where "degrade or repair" is decided. Inside
its existing `updateProjectionState` updater, and **only** there:

1. read `projection.autoRepairAttempts`;
2. test `autoRepairFlights.has(workspaceId)`;
3. if no claim and budget remains and `planAutoRepair` returns an action: increment the counter,
   `autoRepairFlights.set(workspaceId, claim)`, mark the projection `recovering`, and record the
   armed action in a closed-over local;
4. otherwise persist today's `degraded` state unchanged.

The dispatch itself happens after the updater, `void`-ed, never awaited (ADR-402).

### 3.1 Why the guard has to be a module-level Map and not persisted state

"Is a repair chain in flight" is a property of *this service-worker instance's* running promises,
not of the workspace. Persisting it would survive a service-worker restart as a permanently-true
flag with no chain behind it, and would need a startup reconciliation pass that does not exist. Every
other in-flight guard in this file is an in-memory map for the same reason:
`socketConnectFlights:81`, `liveApplyQueues:82`, `volatileRepairGates:85`, `workspaceLocks:143`,
`rebuildLocks:144`. `autoRepairFlights` follows that shape and is cleared by `resetRuntimeState`
(`:2483-2497`) like all of them.

### 3.2 The proof C1 needs — claim inside the updater vs. claim after the await

This is the exact question attempt 2 got wrong. Both variants write a plain `Map` entry with a plain
synchronous statement; the difference is *which slot* that statement executes in.

Let A and B be two `pauseWorkspace` invocations for the same workspace from two independent async
chains (in the failing scenario: the subtree-fallback pause and the nested resync pause). Write
`slot(X)` for the body `updateState` runs for X inside `enqueueStateMutation`.

**Variant 1 — claim after the await (what a naive implementation does, and what attempt 2's symptom
is consistent with):**

```
A: await updateProjectionState(...)   → enqueues slot(A)
B: await updateProjectionState(...)   → enqueues slot(B)
   … slot(A) runs: reads attempts=0, writes attempts=1, persists …
   … slot(B) runs: reads attempts=1, writes attempts=2, persists …     ← counter is fine here
A: resumes (microtask after slot(A)'s chromeStorageSet resolves) → flights.set(ws, claimA) → dispatch
B: resumes → flights.has(ws)?  ← depends purely on whether A's continuation was scheduled first
```

The `flights.has` test in B's continuation and the `flights.set` in A's continuation are two
*separate* microtasks, ordered only by the resolution order of two independent `chromeStorageSet`
promises, which are two independent `setTimeout(…, 0)` macrotasks in the test double
(`tests/projection-behavior.test.mjs:89-103`) and two independent IPC round-trips in the browser.
**Both can observe "no claim" and both can dispatch.** Two chains for one workspace is the
unbounded-work precondition of §11.4's hang.

**Variant 2 — claim inside the updater (this design):**

```
   … slot(A) runs: reads attempts=0 and flights.has=false → writes attempts=1, flights.set(ws, claimA), persists …
   … slot(B) runs: reads flights.has=true → takes the "chain already running" branch, writes nothing to the counter …
A: resumes → dispatch (claimA)
B: resumes → no dispatch
```

The `has` and the `set` are now statements *inside the same synchronous callback in the same slot*,
and slots are totally ordered (§2.1 fact 1). There is no schedulable point between them. Whichever
of A or B is enqueued first claims; the other necessarily observes the claim, because a synchronous
write performed in slot N is visible to every statement in slot N+1 by construction. This is exactly
the property the counter already relies on and `recoveryAttemptCount` already demonstrates.

**Answer to "does claiming inside the updater actually achieve anything a plain Map wouldn't?"**
Yes, and it is the whole fix. It is not the Map that is unsafe; it is the *slot* the Map is written
in. A Map written inside the updater is as strongly ordered as the persisted counter next to it. A
Map written after the `await` — or worse, from inside the dispatched repair, as
`exploration.md:35` reconstructs — is ordered by nothing.

### 3.3 Why the counter still lives on `ProjectionState`

The claim is enough to make the *dispatch decision* single-threaded, but the *budget* must survive a
service-worker restart (MV3 evicts the worker aggressively; a workspace that failed twice must not
get a fresh budget of two just because the worker was recycled) and must be observable by the
popup/diagnostics. `ProjectionState` gives both, and normalization already handles absent fields
(`storage.ts:87-88`). This is proposal D1, confirmed.

### 3.4 What most likely produced `1, 1` — a correction to the exploration's reconstruction

`exploration.md:35` blames a bare module-level `Map<string, number>` incremented from inside the
fire-and-forget dispatch. That is possible, but there is a second mechanism that reproduces `1, 1`
**even with the counter correctly placed on `ProjectionState` and correctly incremented inside the
updater**, and it is the more likely one because the code invites it:

```ts
// extension/src/background/projection.ts:2040-2045  (CURRENT — enterRecovery's continue branch)
projection.status = "syncing";
projection.health = "recovering";
projection.recoveryAttemptCount = nextAttempt;
projection.recoveryStartedAt = projection.recoveryStartedAt ?? now;
projection.degradedAt = undefined;
projection.degradedReason = undefined;
```

This branch already exists to *clear the degraded bookkeeping*, and it sits directly on the nested
path (`recoverWorkspace:1976` → `enterRecovery`). Any implementation that added
`projection.autoRepairAttempts = 0;` next to `degradedAt = undefined` — a natural-looking edit —
produces exactly the reported sequence:

```
pause #1 → attempts 0 → 1, dispatch
   repair → replayWorkspaceDelta → recoverWorkspace("resync") → enterRecovery → attempts reset to 0
pause #2 → attempts 0 → 1        ← "1, 1", with a perfectly atomic counter
```

Both mechanisms are closed by this design: the counter is written in exactly one place (ADR-402's
armed branch), and C3/ADR-403 forbid a reset anywhere on the repair path. Neither reconstruction can
be confirmed against the discarded diff — it was never committed — but the implementation rules
below make both unreachable, which is what matters.

**Rejected alternatives.**

- *Counter inside `ConvergenceJournal.attempts` (`types.ts:210`, currently dead).* Rejected:
  `plan()` (`convergence.ts:92`) rebuilds the journal with `attempts: 0` as ordinary re-planning,
  and `rebuildJournal`/`retryJournal` rewrite the journal wholesale. The budget would reset on
  events that are not "the workspace came back to life".
- *Reuse `recoveryAttemptCount` / raise `MAX_SILENT_RECOVERY_ATTEMPTS`.* Rejected for the reason
  `exploration.md:39` gives: it only gates the four sites that reach
  `recoverWorkspace`/`recoverSubtreeThenWorkspace`, leaving the largest pause source (`:1271`) with
  zero attempts. It is also a *different* budget with a different meaning — see §5.2.
- *A promise-valued flight map (`socketConnectFlights` shape) as the only guard, no counter.*
  Rejected: it prevents concurrency but not repetition. A workspace that fails, repairs, fails,
  repairs… forever has one chain at a time and still never shows red.

---

## 4. ADR-402 — The armed dispatch, and the re-drive that produces attempt 2

**Decision.** `pauseWorkspace` gains an options bag and a dispatch tail; two new module functions
carry the policy and the chain.

```ts
// extension/src/background/projection.ts:85-87  (insert with the other module state)
type AutoRepairClaim = { promise: Promise<void>; release: () => void };
const autoRepairFlights = new Map<string, AutoRepairClaim>();
const MAX_AUTO_REPAIR_ATTEMPTS = 2;

function createAutoRepairClaim(): AutoRepairClaim {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
```

```ts
// extension/src/background/projection.ts:2010-2022  (REPLACEMENT)
async function pauseWorkspace(
  workspaceId: string,
  cursor: number,
  reason: Parameters<typeof gateRemoteEffect>[2],
  options: { repair?: "retry" | "rebuild" } = {},
): Promise<void> {
  const claim = createAutoRepairClaim();
  let disposition: "retry" | "rebuild" = "retry";
  let armed: "retry" | "rebuild" | undefined;
  let attempt = 0;

  try {
    await updateProjectionState(workspaceId, (projection) => {
      projection.convergenceJournal = gateRemoteEffect(projection.convergenceJournal ?? emptyJournal(), cursor, reason);
      if (options.repair) projection.convergenceJournal.repairDisposition = options.repair;               // ADR-404
      if (projection.convergenceJournal.receipts?.some((receipt) => receipt.status === "pending")) projection.convergenceJournal.repairDisposition = "rebuild";
      disposition = projection.convergenceJournal.repairDisposition ?? "retry";

      // Decide and claim in ONE slot. No await may ever be introduced between
      // these three statements — that gap is what let a prior implementation
      // start two chains for one workspace (design §3.2).
      const chainInFlight = autoRepairFlights.has(workspaceId);
      const attempts = projection.autoRepairAttempts ?? 0;
      const action = chainInFlight || attempts >= MAX_AUTO_REPAIR_ATTEMPTS ? undefined : planAutoRepair(projection);

      if (chainInFlight || action) {
        projection.status = "syncing";
        projection.health = "recovering";
        projection.lastError = reason;
        projection.degradedAt = undefined;
        projection.degradedReason = undefined;
        if (action) {
          projection.autoRepairAttempts = attempts + 1;   // the ONLY write to this counter
          attempt = attempts + 1;
          autoRepairFlights.set(workspaceId, claim);
          armed = action;
        }
        return;
      }

      projection.status = "error";
      projection.health = "degraded";
      projection.degradedReason = reason;
      projection.degradedAt = new Date().toISOString();
    });
  } catch (error) {
    if (autoRepairFlights.get(workspaceId) === claim) autoRepairFlights.delete(workspaceId);
    claim.release();
    throw error;                                          // C6: applyRemoteEnvelope:1270-1275 still fails closed
  }

  try {
    await log(`repair:${workspaceId}`, armed
      ? `paused cursor ${cursor}; ${reason}; disposition ${disposition}; auto-repair ${armed} attempt ${attempt}/${MAX_AUTO_REPAIR_ATTEMPTS}`
      : `paused cursor ${cursor}; ${reason}; disposition ${disposition}`, "warn");
  } finally {
    if (armed) void runAutoRepair(workspaceId, armed, claim);
  }
}
```

```ts
// extension/src/background/projection.ts — new, immediately after pauseWorkspace
async function runAutoRepair(workspaceId: string, action: "retry" | "rebuild", claim: AutoRepairClaim): Promise<void> {
  let failure: string | undefined;
  try {
    const state = await getState();
    if (!state.session || !state.selectedWorkspaceIds.includes(workspaceId) || !state.projectionsByWorkspaceId[workspaceId]) return;
    if (autoRepairFlights.get(workspaceId) !== claim) return;          // logout / resetRuntimeState took it
    await log(`repair:${workspaceId}`, `auto-repair ${action} started`, "info");
    if (action === "rebuild") await rebuildWorkspace(workspaceId);
    else await retryWorkspace(workspaceId);
  } catch (error) {
    failure = describeError(error);
  } finally {
    const owned = autoRepairFlights.get(workspaceId) === claim;
    if (owned) autoRepairFlights.delete(workspaceId);
    try {
      if (owned) await settleAfterAutoRepair(workspaceId, failure);
    } catch {}
    claim.release();                                                    // released LAST — see §4.2
  }
}

async function settleAfterAutoRepair(workspaceId: string, failure?: string): Promise<void> {
  const projection = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!projection) return;
  const journal = projection.convergenceJournal;
  if (journal?.phase === "paused" && journal.pauseReason) {
    // Re-enter the single decision point with the pause the repair left behind:
    // it either arms attempt 2 (incrementing in its own slot) or degrades.
    await pauseWorkspace(workspaceId, journal.failedCursor ?? projection.lastCursor, journal.pauseReason, { repair: journal.repairDisposition });
    return;
  }
  if (failure && projection.health === "recovering") {
    await updateProjectionState(workspaceId, (current) => {           // never leave "recovering" with no chain
      current.status = "error";
      current.health = "degraded";
      current.degradedReason = failure;
      current.degradedAt = new Date().toISOString();
    });
  }
}
```

### 4.1 Why a re-drive rather than a loop inside the runner

A `for (attempt of 1..2)` loop inside `runAutoRepair` would work, but it would put the budget logic
in two places and would contradict this change's own spec delta
(`specs/extension-sync-convergence/spec.md:29`: the counter "MUST increment atomically inside the
same state update that decides to pause"). The re-drive keeps **exactly one** place where the
counter is read and written, and it is the same place that decides to degrade. Termination is by
construction: `settleAfterAutoRepair` can only call `pauseWorkspace`, which can only arm a dispatch
while `autoRepairAttempts < 2`, and every arm increments. Maximum dispatches per budget: 2. The
recursion is not stack recursion — the second dispatch is `void`-ed, so the first chain's promise
settles independently.

### 4.2 Release order, and why the claim resolves last

`finally` order is: (1) snapshot ownership, (2) delete the claim so the decision point is free
again, (3) `await settleAfterAutoRepair` — which may arm attempt 2 and register a *new* claim, (4)
`claim.release()`. Releasing last means an awaiter of chain 1 resumes only after chain 2 (if any) is
already registered, so the `settleAutoRepair` test hook (§12.1) converges deterministically instead
of racing the hand-off.

### 4.3 The failing scenario, traced end to end

Test `tests/projection-behavior.test.mjs:2385`, *"connectWorkspace falls back from subtree recovery
to workspace resync before degrading"*, with `autoRepairAttempts: 0` (the new tests opt in
explicitly; §12.2 explains why the legacy harness default is 2).

| # | Event | Line | Effect |
|---|---|---|---|
| 1 | socket `ack currentCursor 7`, `lastCursor 7` | `:805-824` | `markProjectionLive` → live |
| 2 | event cursor 8 for `folder-parent` → mapped chrome id `missing-parent` is absent | `:1426-1431` | `validateRecoveryScope` → `recover-subtree` |
| 3 | `recoverSubtreeThenWorkspace` | `:2180` | `enterRecovery` → `recoveryAttemptCount 0→1`, `health "recovering"` |
| 4 | `attemptSubtreeRecovery` | `:2262-2265` | tree read #1, anchor = workspace root, `replayEvents(afterCursor=7)` → `resyncRequired` → `false` |
| 5 | **pause P1**, cursor 7, `ambiguous-predecessor`, `{ repair: "rebuild" }` (ADR-404) | `:2213` | slot: no claim, attempts `0 → 1`, claim set, `health "recovering"`, **armed = rebuild** |
| 6 | dispatch (`void`) | `finally` | `runAutoRepair` starts; `applyRemoteEnvelope`'s continuation at `:1272` runs first (microtask beats the runner's `getState`, which is a `setTimeout(…,0)` in the double) so the volatile gate is cleared before the runner does anything |
| 7 | `applyRemoteEnvelope` checkpoint | `:1249-1255` | `lastCursor 7 → 8` (pre-existing behavior: the checkpoint advances even though event 8 was never applied — see §11.3) |
| 8 | runner attempt 1: `rebuildWorkspace` | `:402-411` | `rebuildJournal` → `rebuildLocks` → `doResyncWorkspace` → tree read #2 → materialize → `replayEvents(afterCursor=0)` |
| 9a | rebuild succeeds | `:1067-1084` | journal `live`, `health` live/recovering, `autoRepairAttempts` reset by `markProjectionLive` on the next ack (ADR-403). **User never saw red.** |
| 9b | rebuild fails → `doResyncWorkspace` catch → **pause P2** | `:1090` | slot: **claim is held** → no dispatch, no counter write, stays `recovering` |
| 10 | runner `finally` → release → `settleAfterAutoRepair` | — | journal still paused → re-drive `pauseWorkspace` → attempts `1 → 2`, new claim, **armed = rebuild (attempt 2)** |
| 11 | attempt 2 fails the same way → **pause P3** | `:1090` | claim held → no dispatch |
| 12 | runner 2 `finally` → re-drive | — | attempts `2 >= MAX` → **degrade**: `status "error"`, `health "degraded"`, `degradedReason`, `degradedAt` |

Counter reads across the whole chain: `1`, then `2`, then exhausted. Never `1, 1`. The nested pauses
at steps 9b and 11 are exactly the calls attempt 2 mis-handled; here they are structurally incapable
of arming anything, because `autoRepairFlights.has(workspaceId)` is evaluated in the same slot that
would have armed them.

The same trace holds when the repair action is `retryWorkspace` and the nested pause arrives through
`replayWorkspaceDelta:875 → recoverWorkspace(…, "resync"):2007 → enterRecovery:2024 →
pauseWorkspace:2007`: that nested pause finds the claim held, so it neither dispatches nor
increments, and `enterRecovery` is forbidden from touching `autoRepairAttempts` (C3).

### 4.4 The "cursor 8, then cursor 7" observation, explained

Both pauses in that chain read the cursor from a *snapshot* taken outside any updater
(`:2007`, `:2213`, `:928`, `:1090` all use `(await getState()).projectionsByWorkspaceId[…]
?.lastCursor ?? 0`). Step 7 above advances `lastCursor` from 7 to 8 while the dispatched chain is
already running. So one pause reads 7 and the other reads 8, and their *diagnostics* are ordered by
when each `log()` call reaches the shared `stateMutationQueue` — not by causality. If the prior
attempt dispatched the repair *before* `pauseWorkspace`'s own `await log(...)`, the nested pause's
log could easily land first, printing `cursor 8` before `cursor 7`.

That ordering is therefore a **symptom of fire-and-forget interleaving, not a bug in itself**. This
design still removes it: the dispatch is placed in a `finally` *after* `await log(...)`
(§4, `pauseWorkspace` tail), so the pause's own diagnostic is always enqueued before the repair's
first write, while a throwing `log` still cannot leak an armed claim.

**Rejected alternatives.**

- *Await the repair inside `pauseWorkspace`.* Rejected: this is attempt 1, which broke 18 tests by
  changing the return timing of a function called from 12 sites, several of them inside `catch`
  blocks that must not grow a network round-trip (`:529`, `:1090`, `:1271`). C5.
- *Dispatch from the call sites instead of from `pauseWorkspace`* (exploration Approach 3).
  Rejected: 8-12 copies of the same budget logic, and it cannot see the journal state the decision
  depends on without re-reading it outside a slot (§2.1 fact 3).
- *Classify call sites into "fresh" and "terminal" and only hook the fresh ones* (exploration
  Approach 2). Rejected definitively — see §6.

---

## 5. ADR-403 — Reset points, and the two live-transitions deliberately excluded

**Decision.** `autoRepairAttempts` resets to `0` at exactly the three sites where
`recoveryAttemptCount` already resets, and nowhere else:

| # | Site | Line (pre-change) | Condition |
|---|---|---|---|
| 1 | `markProjectionLive` | `:1882` (inside `:1872-1893`) | early-returns first if the journal is paused (`:1874`), so it only fires on a genuine return to live |
| 2 | `doResyncWorkspace` success | `:1079` | inside `if (projectionState.health === "live")` (`:1078`) |
| 3 | `attemptSubtreeRecovery` success | `:2278` | unconditional in the success updater (`:2272-2283`) |

All three verified on disk; the exploration's line numbers (1882 / 1079 / 2278) are **still
accurate**.

**Answer to "does the new counter need more reset points than the old one?"** No — and the two
candidates must be *actively* rejected, because the new counter is indeed entered from more pause
sites than the old one. `health` becomes `"live"` in five places, not three:

| Site | Line | Reset `recoveryAttemptCount`? | Reset `autoRepairAttempts`? |
|---|---|---|---|
| `markProjectionLive` | `:1880` | yes | **yes** |
| `doResyncWorkspace` | `:1071` | yes (`:1079`) | **yes** |
| `attemptSubtreeRecovery` | `:2276` | yes (`:2278`) | **yes** |
| `settleLocalMutation` | `:430` (`if socketConnected`) | no | **no** |
| `applyRemoteEnvelope` checkpoint | `:1253` (`if socketConnected`) | no | **no** |

Resetting at `:430`/`:1253` would mean every single acknowledged local edit and every applied remote
event hands the workspace a fresh budget of two. A workspace that alternates "apply one event / fail"
would then get an unbounded stream of two-attempt budgets — the slow-motion infinite-retry the
proposal's question round rejected when it chose a per-workspace budget over a per-cause one
(`proposal.md:81`). Excluding them is fail-safe in the only direction that matters: the worst case
is *fewer* silent attempts than the budget allows, never more, and a user-visible red dot is the
fallback, never a hidden loop.

Residual, recorded not hidden: `markProjectionLive` is reachable cheaply (any socket ack with equal
cursors, `:823`), so a workspace with a flapping socket does receive repeated fresh budgets over
time. That is bounded in *rate* by `MAX_SILENT_RECOVERY_ATTEMPTS = 3` on the reconnect path
(`:86`, `:2031`) and in *concurrency* by the claim, and every attempt writes a `repair:` diagnostic,
so the pattern is greppable in the field. Accepted.

---

## 6. ADR-404 — Slice A: give resync-shaped pauses the right disposition; do **not** re-enable inline destructive resync

This is the design's largest deviation from `proposal.md`, and it is evidence-driven.

### 6.1 What the proposal asked for, and what the tree says about it

`proposal.md:10` asks to restore `resyncWorkspace` to `runCoalescedWorkspaceTask(…,
doResyncWorkspace)`. Doing that literally re-enables *automatic destructive rematerialization* at
these 8 call sites:

| # | Call site | Line | Trigger |
|---|---|---|---|
| 1 | `handleBookmarkCreated` | `:567` | viewer local create rejected |
| 2 | `handleBookmarkCreated` | `:578` | bookmark created outside a canonical folder |
| 3 | `handleBookmarkChanged` | `:624` | viewer local change rejected |
| 4 | `handleBookmarkMoved` | `:647` | viewer local move rejected |
| 5 | `handleBookmarkRemoved` | `:674` | managed synthetic root removed (no context) |
| 6 | `handleBookmarkRemoved` | `:682` | managed synthetic root removed (no backend id) |
| 7 | `handleBookmarkRemoved` | `:699` | viewer exclusion applied locally |
| 8 | `logRejectedMutation` | `:945` | any local mutation rejected by the backend |

Three pieces of counter-evidence, all re-read from disk:

1. **`openspec/specs/extension-sync-convergence/spec.md:81`** — "destructive normal resync MUST
   remain disabled until final repair/enablement" — and **`:86`** — "GIVEN a containment or
   verification failure **during repair** … THEN … no destructive resync runs".
2. **Named, shipped tests encode it.** `tests/projection-behavior.test.mjs:1056` *"replay gap pauses
   the workspace without destructive resync"* asserts `tree` fetches `=== 0` (`:1087`);
   `:2260` *"handleBookmarkRemoved pauses a rejected local delete without destructive recovery"*
   asserts `tree` fetches `=== 0` (`:2316`) **and deliberately registers a working `/tree` handler
   at `:2292` so that an accidental resync shows up as a count, not as an "Unhandled fetch" crash**;
   `:1092` *"…Rebuild is the only destructive workspace action…"*.
3. **`chrome.bookmarks` listener re-entrancy.** `doResyncWorkspace` mutates the tree
   (`clearManagedChildrenWithSuppression:1047`, `materializeFolder:1057-1059`). Suppression is
   best-effort with a 250 ms TTL (`withSuppression:2547-2567`). Any listener that slips through
   lands back in `handleBookmarkRemoved:674` → `resyncWorkspace` → the same coalescing lock, setting
   `rerunRequested` (`:896`) from inside the run it is nested in. That does not deadlock (Chrome
   invokes listeners, nobody awaits them) but it does schedule another full resync, which can
   schedule another. A self-feeding resync loop is a plausible reason the stub exists.

### 6.2 Decision

Slice A changes **disposition, not action**. The three resync-shaped pause sites pass an explicit
repair hint; nothing runs an inline `doResyncWorkspace`:

```ts
// extension/src/background/projection.ts:927-930  (REPLACEMENT)
// These eight call sites all mean "the local tree no longer matches canonical state". Replaying
// from lastCursor can never close that gap — only rematerialization can — so the pause must say
// "rebuild". That is what lets the bounded auto-repair layer spend an attempt on the action that
// can actually work, and what stops the popup offering a Retry that is guaranteed to fail.
// Rematerialization still never runs inline here: it only ever happens through the counted,
// claimed, capped layer in ADR-402 (spec.md:81, spec.md:86).
async function resyncWorkspace(workspaceId: string, reason: string): Promise<void> {
  await pauseWorkspace(workspaceId, (await getState()).projectionsByWorkspaceId[workspaceId]?.lastCursor ?? 0, "ambiguous-predecessor", { repair: "rebuild" });
  await log(`repair:${workspaceId}`, `resync required: ${reason}`, "warn");
}
```

```ts
// extension/src/background/projection.ts:2007  (REPLACEMENT — recoverWorkspace, mode "resync")
await pauseWorkspace(workspaceId, (await getState()).projectionsByWorkspaceId[workspaceId]?.lastCursor ?? 0, "ambiguous-predecessor", { repair: "rebuild" });
```

```ts
// extension/src/background/projection.ts:2213  (REPLACEMENT — recoverSubtreeThenWorkspace fallback)
await pauseWorkspace(scope.workspaceId, (await getState()).projectionsByWorkspaceId[scope.workspaceId]?.lastCursor ?? 0, "ambiguous-predecessor", { repair: "rebuild" });
```

### 6.3 Why this is not a downgrade of the proposal's intent

`proposal.md:10` justifies Slice A as a *prerequisite*: "8 call sites otherwise fail by
construction". That is correct, and this version satisfies it more precisely. Without a hint, those
pauses carry `repairDisposition: "retry"` (`convergence.ts:103`), so:

- the auto-repair layer would dispatch `retryWorkspace`, whose `retryJournal` puts the journal in
  `replay` and replays from `lastCursor` — which in the §4.3 scenario is cursor 8, an event that was
  *checkpointed but never applied* (§11.3). The replay returns nothing, `markProjectionLive` fires,
  and the workspace is reported healthy while the bookmark is permanently missing. **A silent
  divergence is strictly worse than today's red dot.**
- the popup's label (`status.ts:239`) says "Retry available" for a condition where the user's Retry
  button is provably a no-op: `retryJournal` → `replay` → same gap → `resyncRequired` →
  `recoverWorkspace("resync")` → pause again. Slice A fixes that shipped UX bug on its own, with no
  dependency on Slice C.

So Slice A delivers a real, independently valuable, independently revertable improvement, and it is
still the prerequisite Slice C needs — it just supplies *information* rather than *behavior*.

### 6.4 Consequences for the three "no destructive resync" tests

- `:1056` and `:2260` keep asserting zero `/tree` fetches, because Slice A performs none. With
  Slice C landed they still pass, because the legacy harness default exhausts the budget (§12.2).
- Their *intent* — "an automatic path must not destroy the local tree unilaterally" — is preserved
  even for a budget-0 projection, because rematerialization now happens only under: an explicit
  budget of 2, a per-workspace claim, and ADR-406's unacknowledged-intent veto.

**Rejected alternatives.**

- *Literal restore of `runCoalescedWorkspaceTask(workspaceLocks, …, doResyncWorkspace)`.* Rejected
  on §6.1 (1)(2)(3). Additionally it would reuse `workspaceLocks`, the **drain** lock, which the
  sibling design (`extension-rebuild-workspace-lock/design.md` §3, C1) already proved wrong: the
  lock stores no runner, so a resync arriving during a drain is "satisfied" by a second *drain* and
  never runs.
- *Restore it behind a new dedicated `resyncLocks` map.* Rejected: it fixes the lock-domain problem
  but none of the spec, test-contract or listener-re-entrancy problems, and it duplicates
  `rebuildWorkspace`'s work with different pre/post steps for no gain.
- *Leave the disposition alone and let Slice C special-case these reasons.* Rejected: it hides the
  classification inside the repair layer where the popup cannot see it, and leaves the misleading
  "Retry available" label in place.

---

## 7. ADR-405 — Slice B: `captureLocalUpdateOrMove` in, `enterRecovery` out

### 7.1 In scope — the two invisible pauses

```ts
// extension/src/background/projection.ts:435-454  (REPLACEMENT of the two direct-journal blocks)
async function captureLocalUpdateOrMove(context: LocalIntentContext, chromeId: string, kind: "changed" | "moved"): Promise<void> {
  const node = await getNode(chromeId);
  if (!node) {
    const cursor = (await getState()).projectionsByWorkspaceId[context.workspaceId]?.lastCursor ?? 0;
    await pauseWorkspace(context.workspaceId, cursor, cursor === 0 ? "cursor-zero-read-failed" : "ambiguous-operation");
    return;
  }
  if (!await isWithinWorkspace(node, context.projection.workspaceChromeId)) {
    await pauseWorkspace(context.workspaceId, (await getState()).projectionsByWorkspaceId[context.workspaceId]?.lastCursor ?? 0, "stale-mapping");
    return;
  }
  …unchanged…
}
```

What changes, precisely: `phase: "paused"` and `pauseReason` are set exactly as before (via
`gateRemoteEffect`, `convergence.ts:102-104`); additionally `failedCursor`, `repairDisposition`,
`status: "error"`, `health: "degraded"`, `degradedReason`, `degradedAt` and one `repair:`
diagnostic. The reason selection moves from inside the updater to a snapshot read — the same shape
the other 12 call sites already use, and safe here because `lastCursor === 0` is a stable predicate
at this point (nothing can advance the cursor while the journal is being paused for a missing node).

This is proposal D5, unchanged and confirmed: without it, three pause reasons never reach the
`health` signal at all, so "every pause cause attempts repair before degrading" would be vacuously
false for them.

No `{ repair }` hint here: a missing or out-of-workspace node is exactly the mapping-integrity class
that `gateRemoteEffect`'s default (`retry`) is meant for, and `planAutoRepair` will escalate to
rebuild on its own if a receipt is pending.

### 7.2 Out of scope — and why `enterRecovery` must stay untouched (answer to design question 5)

`proposal.md:11` also asks to route `enterRecovery`'s give-up branch (`:2031-2038`) through
`pauseWorkspace`. **Do not.** Three concrete, verified harms, plus one dissolved motivation:

1. **It would block the existing self-heal.** `gateRemoteEffect` sets `phase: "paused"`.
   `markProjectionLive:1874` and `applyRemoteEnvelope:1196` both early-return on a paused journal.
   Today a workspace degraded by connectivity exhaustion still heals on the next successful ack
   (`:823 → markProjectionLive`) — e.g. after a browser restart, `initializeBackground:146` →
   `syncSelectedWorkspaces:719` → `connectWorkspace`. Gating the journal would make that
   impossible and force a manual Retry for what was a network hiccup.
2. **It would escalate a network hiccup into a destructive rebuild.** `pauseWorkspace:2014` upgrades
   the disposition to `"rebuild"` whenever any receipt is `pending`. A disconnect during a pending
   remote transition is ordinary; converting it into "Rebuild required" (and, with Slice C, into an
   *automatic* rematerialization) is a large, unjustified escalation.
3. **It would lie in the journal.** Every `pauseReason` in `types.ts:211` names a *convergence
   integrity* failure. "websocket closed" is not one. `retryJournal`/`normalizeJournal` branch on
   those values; feeding them a connectivity failure makes downstream repair semantics wrong.

And the motivation `exploration.md:8` gives — that the give-up path shows a bogus "Retry available"
— is **not true** (§2.4). The give-up path has no `pauseReason`, so `status.ts:241-242` shows
`degradedReason`, i.e. the real reason.

Finally, `enterRecovery` **already is** the bounded pre-degrade repair layer for its own class of
failure: `MAX_SILENT_RECOVERY_ATTEMPTS = 3` (`:86`), counted at `:2028`/`:2042`, degrading only at
`:2031`, and pinned by test `:1467-1485`. Requirement "attempt repair before showing red" is
satisfied there today, with a budget of three. Stacking a second budget of two on top would give a
disconnected workspace 3 reconnects **and then** 2 rebuilds — the worst possible combination.

Slice B therefore ships as a one-function change. §14 lists the spec-delta sentence this requires
amending.

---

## 8. ADR-406 — `planAutoRepair`: a pure policy function with an unacknowledged-intent veto

```ts
// extension/src/background/projection.ts — new, immediately before pauseWorkspace
// Pure by construction: no getState, no await. That is what lets pauseWorkspace call it from
// inside the atomic updater, on the very projection object it is mutating, while runAutoRepair's
// successor call sees identical semantics from a fresh read.
function planAutoRepair(projection: ProjectionState): "retry" | "rebuild" | undefined {
  const journal = projection.convergenceJournal;
  if (!journal || journal.phase !== "paused") return undefined;

  // Mirrors retryJournal (convergence.ts:105-110) exactly, so the layer never dispatches a
  // retryWorkspace that would return at projection.ts:396 without doing anything.
  const needsRebuild = journal.repairDisposition === "rebuild"
    || journal.pauseReason === "bootstrap-required"
    || (journal.receipts ?? []).some((receipt) => receipt.status === "pending");
  if (!needsRebuild) return "retry";

  // spec.md:72 — "Unacknowledged intent MUST NOT be pruned". rebuildJournal (convergence.ts:113)
  // keeps only acked intents, so an automatic rebuild is allowed only when there is nothing
  // unacknowledged to lose. Otherwise degrade and let the human decide: that is precisely what
  // "Rebuild is the only destructive workspace action" means (test :1092).
  return (journal.localIntents ?? []).some((intent) => intent.status !== "acked") ? undefined : "rebuild";
}
```

Consequences worth stating explicitly:

- **The most common transient failure auto-heals.** `drainLocalIntentsNow`'s catch (`:529`) pauses
  with `ambiguous-predecessor`, disposition `retry`, and the failed intent still `sent` — no pending
  receipt, so `planAutoRepair` returns `"retry"`, `retryWorkspace` replays and
  `replayWorkspaceDelta:884` re-drains the intent. This is the backend-hiccup case the user
  complained about.
- **First sync stops being red.** `ensureWorkspaceProjection:749` pauses a newly selected workspace
  with `bootstrap-required`. Today the user must click Rebuild before anything syncs at all
  (verified: `setSelectedWorkspaces:358` → `syncSelectedWorkspaces:719` → pause → `connectWorkspace`
  → ack → `markProjectionLive` early-returns on the paused journal → stays degraded). With this
  layer, `planAutoRepair` returns `"rebuild"` (no intents on a fresh projection) and the workspace
  bootstraps itself. This is the single largest UX win in the change and it needs its own test
  (T-C4).
- **A workspace with a stuck unacknowledged intent never auto-rebuilds.** It degrades on the first
  rebuild-shaped pause. Deliberate, spec-mandated, and the safe direction.
- `LOCAL_ONLY_FOLDER_TITLE` content is never at risk: `doResyncWorkspace:1046-1047` resolves and
  excludes it before clearing (`ensureLocalOnlyFolder`, `clearManagedChildrenWithSuppression`).

---

## 9. Data flow, ordering and lock discipline

```
 any of the 12 pause sites (…:529 :749 :928 :1090 :1198 :1271 :1380 :1392 :1490 :1503 :2007 :2213)
        │
        ▼
 pauseWorkspace(workspaceId, cursor, reason, { repair? })                       ◄── ADR-401
        │
        ├─ updateProjectionState ──► enqueueStateMutation (storage.ts:168) ── ONE SLOT ──┐
        │     gateRemoteEffect (+ repair hint, + pending-receipt upgrade)                │
        │     read autoRepairAttempts │ read autoRepairFlights.has │ planAutoRepair      │ no await
        │     ├─ arm: attempts+1, flights.set(claim), health "recovering"                │ inside
        │     ├─ chain in flight: health "recovering", no counter write                  │
        │     └─ else: health "degraded", degradedReason, degradedAt  ──► RED DOT        │
        │                                                             ◄──────────────────┘
        ├─ await log("repair:…")                          (same FIFO queue, so ordered before the repair)
        └─ finally: if armed → void runAutoRepair(...)                             ◄── fire-and-forget (C5)
                          │
                          ├─ guards: session? selected? projection? claim still mine?
                          ├─ action "retry"   → retryWorkspace:391  → replayWorkspaceDelta → drainLocalIntents
                          ├─ action "rebuild" → rebuildWorkspace:402 → rebuildLocks → doResyncWorkspace
                          │        └─ any downstream pause re-enters pauseWorkspace and finds the claim held
                          └─ finally: delete claim → settleAfterAutoRepair → (arm attempt 2 | degrade) → release
```

**Lock order:** `autoRepairFlights → rebuildLocks → managedPathQueue → stateMutationQueue`, always
in that direction. Provable rather than asserted:

- `autoRepairFlights` is **not a mutex** — no production code path ever `await`s a claim's promise.
  Only the test hook does, and only from test scope. A structure nobody blocks on cannot participate
  in a cycle.
- The claim is written and read only inside `updateProjectionState` updaters (plus the runner's
  identity checks), i.e. inside the innermost queue, never around it.
- `rebuildLocks` / `managedPathQueue` / `stateMutationQueue` ordering is unchanged and was proved by
  the sibling design (`extension-rebuild-workspace-lock/design.md` §8).
- The runner never holds a lock while dispatching: `void runAutoRepair` returns immediately, and the
  runner's own `await`s are all inside functions that take their locks in the order above.

**Re-entrancy into `rebuildLocks`.** If a *user* Rebuild is running and its `doResyncWorkspace`
fails, `pauseWorkspace:1090` may arm a chain whose `rebuildWorkspace` then takes the follower path
of the same lock (`runCoalescedWorkspaceTask:894-900`): it sets `rerunRequested` and awaits. No
deadlock — the leader is not waiting on the runner — and the coalesced rerun performs the work.
Bounded by the same budget of 2.

---

## 10. Change inventory

| # | Slice | File:line (pre-change, verified on disk) | Change | ADR |
|---|---|---|---|---|
| 1 | A | `src/background/projection.ts:927-930` | `resyncWorkspace` pauses with `{ repair: "rebuild" }`; log becomes `resync required: …` | 404 |
| 2 | A | `src/background/projection.ts:2007` | `recoverWorkspace` resync fallback passes `{ repair: "rebuild" }` | 404 |
| 3 | A | `src/background/projection.ts:2213` | `recoverSubtreeThenWorkspace` fallback passes `{ repair: "rebuild" }` | 404 |
| 4 | A | `src/background/projection.ts:2010` | `pauseWorkspace` gains the `options: { repair? }` parameter and applies it after `gateRemoteEffect` | 404 |
| 5 | A | `package.json:10` | *(optional, see §12.1)* add `--test-timeout=…` if `node --version` ≥ 20.15 | — |
| 6 | B | `src/background/projection.ts:435-454` | `captureLocalUpdateOrMove`'s two direct journal writes → `pauseWorkspace` | 405 |
| 7 | C | `src/shared/types.ts:233` (insert after) | `autoRepairAttempts: number;` on `ProjectionState` | 403 |
| 8 | C | `src/shared/storage.ts:77` (insert after) | `autoRepairAttempts: 0` in `createProjectionState` | 403 |
| 9 | C | `src/shared/storage.ts:87` (insert after) | `autoRepairAttempts: projection.autoRepairAttempts ?? 0` in `normalizeProjectionState` | 403 / C11 |
| 10 | C | `src/background/projection.ts:85-87` | `AutoRepairClaim`, `autoRepairFlights`, `MAX_AUTO_REPAIR_ATTEMPTS`, `createAutoRepairClaim` | 401 |
| 11 | C | `src/background/projection.ts:2010-2022` | `pauseWorkspace` rewritten: claim + counter in the updater, armed dispatch in a `finally` | 401 / 402 |
| 12 | C | `src/background/projection.ts` (new, before/after `pauseWorkspace`) | `planAutoRepair`, `runAutoRepair`, `settleAfterAutoRepair` | 402 / 406 |
| 13 | C | `src/background/projection.ts:1882` (insert after) | `projection.autoRepairAttempts = 0;` in `markProjectionLive` | 403 |
| 14 | C | `src/background/projection.ts:1079` (insert after) | `projectionState.autoRepairAttempts = 0;` in `doResyncWorkspace`'s live branch | 403 |
| 15 | C | `src/background/projection.ts:2278` (insert after) | `current.autoRepairAttempts = 0;` in `attemptSubtreeRecovery`'s success updater | 403 |
| 16 | C | `src/background/projection.ts:2496` (insert after `rebuildLocks.clear()`) | release every claim, then `autoRepairFlights.clear()` | 401 / C4 |
| 17 | C | `src/background/projection.ts:126-135` | `projectionTestHooks`: `settleAutoRepair`, `autoRepairFlightCount` | §12.1 |
| 18 | A/B/C | `tests/projection-behavior.test.mjs` | harness: `createProjection` budget default, `fetchBudget` fuse; new tests T-A1…T-C9 | §12 |

**Explicitly not touched:** `enterRecovery` (`:2024-2048`) — ADR-405; `MAX_SILENT_RECOVERY_ATTEMPTS`
and `recoveryAttemptCount` semantics; `gateRemoteEffect` / `retryJournal` / `rebuildJournal` /
`plan` / `normalizeJournal` (`convergence.ts`); `runCoalescedWorkspaceTask` (`:888-925`);
`workspaceLocks` / `rebuildLocks` / `drainLocalIntents`; `doResyncWorkspace`'s body except the one
reset line; `shared/ui/status.ts` (no UI change is required — `recovering` is already rendered);
`shared/websocket.ts`; `service-worker.ts`; `scripts/package.mjs`; anything under `backend/` or
`admin-web/`.

---

## 11. Bounded-ness, self-heal and hang proofs

### 11.1 Termination

Per workspace, per budget: `pauseWorkspace` arms a dispatch only when `autoRepairAttempts <
MAX_AUTO_REPAIR_ATTEMPTS` **and** no claim is held, and every arm increments the counter in the same
slot. The counter is written in exactly one statement in the codebase. Therefore at most 2 chains
are ever dispatched between two resets, and each chain runs at most one repair action. The re-drive
(`settleAfterAutoRepair`) can only reach `pauseWorkspace`, so it inherits the same bound.
Downstream pauses inside a chain cannot arm (claim held) and cannot increment. **Maximum work per
budget: 2 repair actions. Maximum concurrency: 1.**

### 11.2 Every terminal state is one of three

When a chain's `finally` completes, the workspace is in exactly one of:

1. **live** — journal not paused, `health` live (set by `markProjectionLive:1880`,
   `doResyncWorkspace:1071` or `attemptSubtreeRecovery:2276`), counter reset by the same updater;
2. **recovering with a successor chain** — `settleAfterAutoRepair` re-drove `pauseWorkspace`, which
   armed attempt 2 and registered a new claim;
3. **degraded** — either `pauseWorkspace`'s exhausted/unsafe branch, or
   `settleAfterAutoRepair`'s fail-closed branch for "the action threw and the journal is not
   paused".

There is no fourth state, and in particular no "recovering forever with nothing running" — that
would be a silent-green failure, the exact thing `captureLocalUpdateOrMove` does today and Slice B
removes.

### 11.3 Pre-existing behavior this design relies on but does not change

`applyRemoteEnvelope:1249-1255` advances `lastCursor` to the event cursor even when the apply routed
into `recoverSubtreeThenWorkspace` and produced no effect (§4.3 step 7). This is why a
resync-shaped failure must be repaired by rematerialization and not by replay (§6.3), and why
ADR-404 exists. Changing the checkpoint rule is **out of scope** — it is a fail-closed sequencing
question that belongs to `Verified Fail-Closed Sequencing` and would need its own change. Recorded
here so the next investigation does not re-derive it.

### 11.4 The hang: mechanism and three independent fuses

`npm run test:projection` runs `node --test tests/*.test.mjs` with **no timeout** (`package.json:10`;
`node --test` defaults to no per-test deadline unless `--test-timeout` is passed). A fire-and-forget
chain that outlives its test therefore has three ways to hang the *process*, not just the test:

1. it keeps issuing `fetch` calls against the *next* test's `fetchHandlers`, where an unmatched URL
   throws `Unhandled fetch` (`tests/projection-behavior.test.mjs:299`) inside a `void`-ed promise;
2. it reaches `connectWorkspaceNow`'s reconnect timer
   (`projection.ts:793`, `setTimeout(() => { void connectWorkspace(workspaceId); }, 250)`) and the
   websocket keepalive, which re-arm themselves — the file already documents this exact leak class
   at `tests/projection-behavior.test.mjs:471-478`;
3. two overlapping chains for one workspace (only possible under §3.2 variant 1) keep enqueuing work
   onto `stateMutationQueue` faster than it drains.

The design closes (3) structurally and (1)/(2) operationally: `resetRuntimeState` releases and
clears every claim (inventory #16) and is already called from `beforeEach` (`:433`) and `after`
(`:477`); the runner aborts when its claim is no longer registered; and every new test awaits
`settleAutoRepair` before asserting, so no chain survives its test. §12.1 adds the three fuses that
turn any residual regression into a fast failure instead of silence.

### 11.5 Field self-heal

- A workspace paused by a transient backend error: attempt 1 replays, `markProjectionLive` resets
  the counter, user sees at most a brief "Recovering". No red dot, no manual action.
- A newly selected workspace: auto-bootstraps (ADR-406) instead of sitting red.
- A genuinely broken workspace: two attempts, then red with the correct `repairDisposition`, i.e.
  the popup offers Rebuild where Rebuild is what is needed (Slice A) instead of a Retry that cannot
  work.
- An install upgrading from a version without the field: `normalizeProjectionState` supplies `0`, so
  the first pause after the upgrade gets a full budget.
- A workspace with an unacknowledged intent stuck behind a rebuild-shaped pause: red immediately,
  intent preserved. Intended (C7).

---

## 12. Test strategy (Strict TDD, three RED/GREEN cycles)

Runner: `cd extension && npm run test:projection` (`package.json:10` → `npm run build && node --test
tests/*.test.mjs`), `node:test` + `node:assert/strict`, importing compiled `../dist/`. Home:
`extension/tests/projection-behavior.test.mjs`, which already imports `retryWorkspace` (`:275`),
`rebuildWorkspace` (`:274`), the four `handleBookmark*` handlers (`:266-269`), `projectionTestHooks`
(`:273`) and `getState`/`setState` (`:280`).

**Repository configuration note.** `openspec/config.yaml:12` records `strict_tdd: false` and
`:17-20` records no detected test runner — that metadata is stale relative to this package, and the
four prior sibling changes all shipped red-first against `npm run test:projection`. This design
follows the session's Strict TDD directive, which is stricter than the config, and `sdd-tasks`
should keep each RED step as its own task.

### 12.1 Step 0 — anti-hang infrastructure, landed first, no new assertions

This step exists solely so history cannot repeat. It must be committed and green **before Slice C's
production code is written**.

1. **Bounded settle hook** (inventory #17):

```ts
// extension/src/background/projection.ts:126-135 (projectionTestHooks, added members)
settleAutoRepair: async (workspaceId: string, maxChains = 4): Promise<void> => {
  for (let round = 0; round < maxChains; round += 1) {
    const claim = autoRepairFlights.get(workspaceId);
    if (!claim) return;
    await claim.promise;
  }
  throw new Error(`auto-repair for ${workspaceId} did not quiesce within ${maxChains} chains`);
},
autoRepairFlightCount: (): number => autoRepairFlights.size,
```

  With `MAX_AUTO_REPAIR_ATTEMPTS = 2` at most two chains can ever run, so `maxChains = 4` is a
  fuse, not a limit: if it ever trips, the failure message names the bug instead of hanging.

2. **Mock-`fetch` budget** in the harness, next to the existing doubles
   (`tests/projection-behavior.test.mjs:284-302`):

```js
let fetchBudget = Number.POSITIVE_INFINITY;   // reset in resetRuntime (:422-435)
globalThis.fetch = async (input, init) => {
  const url = String(input);
  fetchLog.push(url);
  if (fetchLog.length > fetchBudget) throw new Error(`fetch budget exhausted after ${fetchLog.length} calls (runaway auto-repair?): ${url}`);
  …existing body unchanged…
};
```

  Every new Slice C test sets `fetchBudget` to a small explicit number (typically 8-12). A repair
  loop then fails on call N+1 in milliseconds with a message that names the suspect — deterministic,
  no wall-clock assertion, no flake on slow CI.

3. **Per-test deadlines.** Every new test is declared `test(name, { timeout: 15_000 }, async () => …)`.
   The per-test `timeout` option is available in every Node version this repo builds on; the
   CLI-wide `--test-timeout` flag (inventory #5) is a *bonus* backstop and must only be added after
   confirming `node --version` ≥ 20.15 in the devcontainer, since older runtimes reject the flag and
   would break the whole script.

**Gate:** with all three added and no behavior change, the full suite must be green and must exit.
If it does not, the harness edit is wrong — not a test.

### 12.2 The legacy-contract decision: default the harness budget to exhausted

`createProjection` (`tests/projection-behavior.test.mjs:445-465`) gains one line:

```js
  recoveryAttemptCount: 0,
  // Legacy tests were written against "a pause degrades immediately". That contract still holds
  // once the auto-repair budget is spent, so the factory hands every legacy fixture an exhausted
  // budget. Tests that exercise the repair layer opt in with `autoRepairAttempts: 0`.
  autoRepairAttempts: 2,
```

Rationale, and why this is not "hiding" a regression:

- It keeps ~30 existing tests pinning exactly what they were written to pin (fetch counts, pause
  reasons, `health: "degraded"` at `:1482`, `:2494`, `:2812`) instead of rewriting them into a
  different scenario — the failure mode that produced attempt 1's 18 broken tests.
- The default is *not* what production ships: `createProjectionState`
  (`shared/storage.ts:66-80`) and `normalizeProjectionState` (`:82-91`) both yield `0`. Coverage of
  the real default is provided explicitly by T-C4 (fresh projection, no fixture override) and by
  every T-C test opting in to `0`.
- It is one line, greppable, and commented at the point of use.

### 12.3 Slice A — RED before inventory items #1-#4

The brief asks for the most rigorous plan here because Slice A is the highest-risk slice. Under
ADR-404 the risk profile changed (no inline destructive resync), so the rigor goes into proving
**all eight funnels** reach a correctly-dispositioned pause and **none** of them rematerializes.

| ID | Name | Pins |
|---|---|---|
| T-A1 | `every automatic resync trigger pauses with a rebuild disposition and touches no backend tree` | Table-driven over the 8 call sites: `{ label, seed, act }` for viewer-create (`:567`), create-outside-canonical (`:578`), viewer-change (`:624`), viewer-move (`:647`), root-removed-no-context (`:674`), root-removed-no-backend-id (`:682`), viewer-exclusion (`:699`), rejected-mutation (`:945`). For each: `await resetRuntime()`, seed, act, then assert `journal.phase === "paused"`, `journal.pauseReason === "ambiguous-predecessor"`, **`journal.repairDisposition === "rebuild"`**, `fetchLog.filter(url => url.endsWith("/tree")).length === 0`, and a `repair:` diagnostic containing `resync required`. A `/tree` handler is registered in every case (mirroring `:2292`) so an accidental resync is a count, not a crash. |
| T-A2 | `a replay gap that requires resync is dispositioned rebuild, not retry` | `recoverWorkspace(…, "resync")` at `:2007` via `projectionTestHooks.replayWorkspaceDelta` (the `:1056` scenario): asserts `repairDisposition === "rebuild"` while keeping `:1056`'s own zero-`/tree` assertion true. |
| T-A3 | `subtree recovery's workspace fallback is dispositioned rebuild` | `:2213`, via the `:2385` scenario shape. |
| T-A4 | `the Retry path is a no-op for a resync-shaped pause, and Rebuild is not` | Regression evidence for §6.3: after T-A2's pause, `await retryWorkspace(...)` leaves `phase === "paused"` and issues no `/sync/events` fetch (because `retryJournal` escalates to rebuild), while `rebuildWorkspace` clears it. This is the test that justifies the whole slice. |
| T-A5 | `existing non-destructive contracts still hold` | Assert-by-running: `:1056`, `:1092`, `:2260`, `:2385` unchanged and green. Listed as an explicit gate, not a new test. |

### 12.4 Slice B — RED before inventory item #6

| ID | Name | Pins |
|---|---|---|
| T-B1 | `a local change to a bookmark whose Chrome node vanished after cursor zero degrades visibly` | The `:2179` scenario with `lastCursor: 0`: keeps `pauseReason === "cursor-zero-read-failed"` and `fetchLog.length === 0`, and **adds** `health === "degraded"`, `status === "error"`, `degradedReason === "cursor-zero-read-failed"`, `journal.failedCursor === 0`. Closes the "silently stuck green" gap. |
| T-B2 | `a local change to a vanished node past cursor zero degrades as ambiguous-operation` | Same shape with `lastCursor: 5` → `pauseReason === "ambiguous-operation"`, `failedCursor === 5`. |
| T-B3 | `a local move of a node outside the workspace subtree degrades as stale-mapping` | Node reparented outside `workspaceChromeId` → `handleBookmarkMoved` → `pauseReason === "stale-mapping"`, `health === "degraded"`, no backend call. |
| T-B4 | `enterRecovery's give-up path is unchanged` | Re-assert `:1467-1485` verbatim **plus** `journal?.phase !== "paused"` and `degradedReason === "websocket closed"`. This is the guard test for ADR-405: if a future edit routes `enterRecovery` through `pauseWorkspace`, this fails immediately. |

### 12.5 Slice C — RED before inventory items #7-#17

Every test below: `{ timeout: 15_000 }`, an explicit `fetchBudget`, an explicit
`autoRepairAttempts: 0` in the fixture, and `await projectionTestHooks.settleAutoRepair("workspace-1")`
before assertions.

| ID | Name | Cycle | What it pins |
|---|---|---|---|
| **T-C1** | **`a nested pause inside a running repair never starts a second chain and never re-uses attempt 1`** | RED before #11 | **The attempt-2 regression test.** Replays §4.3 exactly: seed the `:2385` fixture with `autoRepairAttempts: 0`; make the repair action fail so it pauses again from inside its own chain. Assert, in order: (a) the sequence of persisted `autoRepairAttempts` values observed via a `storageSetFailure`-style write spy (or a `repair:` diagnostic per attempt) is **`1` then `2`, never `1, 1`**; (b) `projectionTestHooks.autoRepairFlightCount()` never exceeded 1 — sampled by asserting it is `<= 1` after each awaited step and `0` after settle; (c) exactly 2 `auto-repair … started` diagnostics; (d) final `health === "degraded"`. `fetchBudget` bounds the whole test. **This is the test that would have failed fast on attempt 2's bug instead of hanging.** |
| **T-C2** | **`two independent pauses arriving for one workspace start exactly one repair chain`** | RED before #11 | The C1 concurrency case: fire two `pauseWorkspace`-reaching operations **unawaited** (e.g. `projectionTestHooks.applyRemoteEnvelope` for two failing events, `await Promise.all`). Assert exactly one `auto-repair … started` diagnostic, `autoRepairAttempts === 1`, `autoRepairFlightCount() === 0` after settle. Fails under §3.2 variant 1. |
| T-C3 | `a transient local-intent dispatch failure repairs silently and never shows degraded` | RED before #11 | `:529` path: first `PATCH` throws, second succeeds. Assert `health` never becomes `"degraded"` (capture it after settle **and** assert no `degradedAt`), journal returns to non-paused, `autoRepairAttempts === 0` after `markProjectionLive`. |
| T-C4 | `a newly selected workspace bootstraps itself instead of showing degraded` | RED before #11 | `setSelectedWorkspaces(["workspace-1"])` against a projection with **no `autoRepairAttempts` override** (production default via `createProjectionState`). Assert the managed path materialized and `health !== "degraded"`. The ADR-406 UX win. |
| T-C5 | `the third consecutive failure degrades with the disposition Slice A assigned` | RED before #11 | Budget 0, three failing repairs → `health === "degraded"`, `repairDisposition === "rebuild"`, `degradedReason` set, and exactly 2 repair attempts in the diagnostics. |
| **T-C6** | **`the attempt budget is monotonic across a recovery chain that calls enterRecovery`** | RED before #11 | The §3.4 guard: drive a pause whose repair path passes through `enterRecovery` (`recoverWorkspace(…, "resync")`), then assert `autoRepairAttempts === 2`, not `1`. Fails immediately if anyone adds a reset next to `:2044-2045`. |
| T-C7 | `a pause whose durable write fails claims no repair flight` | RED before #11 | Uses the existing `storageSetFailure` hook (`:1444`): the pause write fails → `pauseWorkspace` still throws (so `applyRemoteEnvelope:1273` still sets the volatile gate — assert `volatileRepairGate("workspace-1")`), `autoRepairFlightCount() === 0`, and no `auto-repair … started` diagnostic. C6. |
| T-C8 | `an automatic rebuild is refused while an unacknowledged intent exists` | RED before #12 | Journal with a `sent` intent + a rebuild-shaped pause → `health === "degraded"` on the **first** pause, `autoRepairAttempts === 0`, intent still present, zero `/tree` fetches. C7 / spec.md:72. |
| T-C9 | `a successful repair restores the full budget for a later, unrelated failure` | RED before #13-#15 | Fail once (attempts → 1), heal (`markProjectionLive`), assert `autoRepairAttempts === 0`, then fail again and assert the new pause is `recovering`, not `degraded`. Proposal success criterion 3. |

**Layer table**

| Layer | What to test | Approach |
|---|---|---|
| Unit | `planAutoRepair`'s four branches (retry / rebuild / veto / not-paused) | Pure function; can be asserted directly if exported through `projectionTestHooks`, otherwise covered by T-C5/T-C8 |
| Integration | T-A1…T-C9 | `node:test` against `dist/`, inline Chrome + fetch + WebSocket doubles, unawaited entry points, bounded fuses |
| E2E | N/A | No browser E2E harness in this repo; live verification is the manual gate in §13 |

**Tests deliberately not written**

- Anything asserting wall-clock elapsed time. The brief asks for a bound on runaway behavior; the
  `fetchBudget` fuse and the chain-count fuse give that deterministically, while a `Date.now()`
  assertion would flake on a loaded CI box.
- Anything asserting the exact *number* of `stateMutationQueue` writes. It is an internal detail and
  would pin implementation, not behavior.

---

## 13. Delivery, rollout and rollback

Branching (Gitflow, per `openspec/config.yaml:10` and `proposal.md:68`): base
`feature/extension-auto-repair-on-pause` off `develop`; three stacked branches, each its own PR,
each independently green:

```
develop
 └── feature/extension-auto-repair-on-pause
      ├── …/slice-a-resync-disposition      (inventory #1-#5, T-A1…T-A5)
      ├── …/slice-b-visible-local-pauses    (inventory #6,     T-B1…T-B4)   [on top of A]
      └── …/slice-c-bounded-auto-repair     (inventory #7-#18, T-C1…T-C9)   [on top of B]
```

**No merge to `develop` until live/manual verification confirms the behavior in a real browser
against a real backend** — the same gate the four prior sync fixes used this session. Minimum manual
script: (1) select a fresh workspace → it must bootstrap without a red dot; (2) stop the backend,
make a local edit, restart the backend → the workspace must self-heal without a red dot; (3) keep
the backend broken → red dot must appear after exactly two attempts, with "Rebuild required" where
Slice A assigned it; (4) confirm `Personal (not synced)` content survives every automatic rebuild.

**Rollback.** C: revert the whole Slice C commit, not just the `finally` dispatch line — a partial
revert leaves a claim permanently held and the counter permanently stuck at 1 (never reaching the
degrade branch), which strands the workspace in `"recovering"` forever instead of restoring today's
"degrade on first failure" behavior. A full revert of the commit restores that behavior exactly and
is independently confirmed green (`sdd-verify`). Persisted `autoRepairAttempts` is additive and
simply ignored by the older code either way. B: restore the two direct journal writes. A: drop the
`{ repair: "rebuild" }` hints; the `options` parameter is backward compatible and can stay. No
migration in either direction.

---

## 14. Spec-delta amendments this design requires

`openspec/changes/extension-auto-repair-before-degraded/specs/extension-sync-convergence/spec.md`
was written against the proposal's original Slice A/B shape and must be amended before `sdd-apply`,
otherwise the implementation and the delta disagree:

| Delta line | Says | Must become |
|---|---|---|
| `:7`, `:16-21` | "Normal resync via `doResyncWorkspace`, dispatched through `runCoalescedWorkspaceTask`, MUST be enabled" / scenario "Resync executes under verified receipts … rather than logging `automatic resync disabled` and pausing" | Rematerialization MUST NOT run inline from the eight automatic triggers; those pauses MUST carry `repairDisposition: "rebuild"`, and rematerialization MUST only run through the bounded, claimed, counted auto-repair layer, and MUST NOT run at all while any local intent is unacknowledged (ADR-404, ADR-406). |
| `:29` | "Every pause reason, **including `captureLocalUpdateOrMove`'s direct journal pauses**, MUST reach this same `health` signal" | Unchanged — Slice B delivers exactly this. |
| `:31` | "(Previously: … `enterRecovery`'s give-up branch … did not consistently set `health`, or set it with no `repairDisposition`)" | Drop the `enterRecovery` clause: it does set `health` consistently (`:2032-2035`), and having no `repairDisposition` is correct there because it never gates the journal (ADR-405, §2.4). |
| new | — | Add a scenario: "GIVEN a rebuild-shaped pause and an unacknowledged local intent / WHEN the pause is persisted / THEN no automatic repair runs and the workspace degrades immediately" (C7, spec.md:72). |

The parent spec's `Isolation, Repair, and Diagnostics` sentence
(`openspec/specs/extension-sync-convergence/spec.md:81`) is *satisfied*, not superseded, by this
design: destructive normal resync remains disabled as an inline automatic action; what this change
enables is a bounded, budgeted, intent-preserving repair layer — which is what "until final
repair/enablement" was reserving room for.

---

## 15. Threat matrix

Included because, unlike the four sibling bugfixes, this change can *destroy local data* on its own
initiative. No shell, subprocess, VCS/PR automation or executable-file boundary is involved; the
threats are data-integrity and liveness.

| # | Threat | Vector | Mitigation | Pinned by |
|---|---|---|---|---|
| T1 | Silent loss of unacknowledged user edits | automatic `rebuildWorkspace` → `rebuildJournal` prunes non-acked intents (`convergence.ts:113`) | ADR-406 veto: any non-acked intent forces immediate degrade | T-C8 |
| T2 | Silent divergence reported as healthy | a retry-shaped repair on a resync-shaped failure replays past a checkpointed-but-unapplied cursor (§11.3) | ADR-404 dispositions those pauses `rebuild`; `planAutoRepair` mirrors `retryJournal` | T-A2, T-A4 |
| T3 | Unbounded repair loop / suite hang | two chains per workspace, or a non-monotonic counter | claim written in the deciding slot (§3.2); single counter write site (§11.1); `resetRuntimeState` release; three test fuses (§12.1) | T-C1, T-C2, T-C6 |
| T4 | Repair masks a real convergence bug | two silent attempts hide a reproducible failure | every attempt writes a `repair:` diagnostic with reason, disposition and attempt number; `degradedReason` survives exhaustion | T-C5 |
| T5 | Durable-write failure leaves a permanently armed claim | `chromeStorageSet` rejects after the updater ran | `catch` deletes the claim, releases it, rethrows; no dispatch | T-C7 |
| T6 | Repair acting on a deselected or signed-out workspace | chain outlives `setSelectedWorkspaces([])` / `logout` | runner re-checks session, selection, projection and claim identity before acting; `resetRuntimeState` clears claims | T-C4 harness, `:870` deselection test |
| T7 | Cross-workspace interference | one workspace's repair rematerializing another's folders | all state is keyed by `workspaceId`; rematerialization goes through `ensureManagedPath`'s global FIFO from the sibling change; no shared mutable repair state | existing `:1185` two-workspace test |
| T8 | Red dot suppressed while genuinely broken | `health: "recovering"` with no chain running | §11.2's three-terminal-states invariant, incl. `settleAfterAutoRepair`'s fail-closed branch | T-C5 |

### 15.1 Compliance with `openspec/config.yaml` design rules

- **`:53` "Keep the backend modular and document sync/event consistency rules."** No backend module
  is touched. The sync/event consistency rules this change interacts with are documented above and
  left intact: checkpoint-after-verification (`:1249-1255`, §11.3), pause-stops-advancement
  (`:1196`, `:477`), receipt capacity (`convergence.ts:101`), and the cursor semantics of replay vs.
  rematerialization (§6.3).
- **`:54` "Document contracts between the Go backend and Chrome extension."** No contract changes.
  The repair layer only re-invokes existing calls through existing clients: `GET
  /workspaces/{id}/tree` (`shared/api.ts` `getWorkspaceTree`, via `doResyncWorkspace:1022`) and `GET
  /sync/events?workspaceId=…&afterCursor=…` (`replayEvents`, via `replayWorkspaceDelta:873` and
  `doResyncWorkspace:1061`). No new endpoint, header, idempotency key or payload field. The only
  observable change from the backend's perspective is that these two idempotent reads may be issued
  up to two extra times per workspace per failure episode; both are already issued repeatedly by the
  user's Retry/Rebuild buttons, and both are rate-bounded by the per-workspace claim.
- **`:47` (proposal rule) Gitflow branch intent** — recorded in §13.

---

## 16. Open questions and residual risks

None blocking. Decisions this design took that a reviewer may want to overrule explicitly, each
already argued above:

1. **Slice A performs no inline resync** (ADR-404) — a deliberate deviation from `proposal.md:10`,
   requiring the spec-delta amendment in §14. If the orchestrator rejects the deviation, the
   alternative is a dedicated `resyncLocks` map plus rewriting three named non-destructive tests,
   and §6.1's three counter-arguments still stand.
2. **`enterRecovery` is left untouched** (ADR-405) — a deliberate narrowing of `proposal.md:11`,
   requiring the §14 delta amendment.
3. **Automatic rebuild is allowed** when no unacknowledged intent exists (ADR-406). This is the
   feature's only destructive capability; the veto, the budget of 2, the claim and the manual live
   gate in §13 are its four independent brakes.

Residuals, recorded not hidden:

- `markProjectionLive` is a cheap reset trigger, so a flapping socket yields repeated fresh budgets
  over time (§5, accepted, bounded by `MAX_SILENT_RECOVERY_ATTEMPTS` and observable in diagnostics).
- A successful automatic rebuild whose socket never acks leaves the card reading "Recovering" with
  `autoRepairAttempts` still non-zero. This is pre-existing `rebuildWorkspace` behavior
  (`:407` passes `targetHealth: "recovering"`), not a regression.
- `applyRemoteEnvelope`'s checkpoint-on-unapplied-event (§11.3) remains out of scope and is the most
  likely source of the *next* convergence investigation.
