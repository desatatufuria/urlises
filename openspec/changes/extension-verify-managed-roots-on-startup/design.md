# Design: extension-verify-managed-roots-on-startup

One production function gains one branch; one helper is added next to its sibling predicate; four
tests are added. No new state, no new pause reason, no new repair mechanism, no migration, no
backend or `admin-web` change.

Everything below was **re-read from disk** on the current `develop` tree while writing it. Line
numbers are pre-change so `sdd-tasks` can slice directly.

**Line-number audit vs. `proposal.md`:** every number the proposal cites is still accurate —
`ensureWorkspaceProjection` at `projection.ts:755`, `needsBootstrap` at `:2450`,
`initializeBackground`'s `syncSelectedWorkspaces("startup")` at `:184`, `login`'s at `:196`,
`setSelectedWorkspaces`' at `:406`, `getNode` at `chrome-bookmarks.ts:18`. The proposal's
"`projection.ts:687-701`" for the reactive detection is the enclosing loop; the actual root-identity
test is `:695` and its dispatch `:696`. `resyncWorkspace` is at `:955`, `doResyncWorkspace` at
`:1033`, `pauseWorkspace` at `:2060`. Nothing shifted.

---

## 1. Technical approach

`needsBootstrap` (`:2450`) asks *"are the three ids set?"*. Nothing in the codebase ever asks *"do
they still resolve?"* except `handleBookmarkRemoved:695`, which can only ask it while a worker
happens to be alive to receive the event. This change adds the missing question at the one choke
point every entry path already funnels through, and answers a miss with the call the reactive path
already makes.

```
initializeBackground:184 ─┐
login:196 ────────────────┼─→ syncSelectedWorkspaces:741 ─→ ensureWorkspaceProjection:755
setSelectedWorkspaces:406─┘                              │        │
                                                         │        ├─ needsBootstrap → pauseWorkspace("bootstrap-required")   [unchanged]
                                                         │        └─ else → NEW: 3 × getNode
                                                         │                   └─ any miss → resyncWorkspace  ── same call as handleBookmarkRemoved:696
                                                         │                                       │
                                                         │                                       └─→ pauseWorkspace(…, "ambiguous-predecessor", { repair: "rebuild" })
                                                         │                                             └─→ (void) runAutoRepair → rebuildWorkspace  [budget 2, claim, veto — ADR-402/404/406]
                                                         └─→ connectWorkspace:751
```

The new code awaits the three reads and awaits `resyncWorkspace` (which awaits only the durable
pause write and its log). It does **not** await the repair: `pauseWorkspace:2116` already `void`s
the dispatch inside a `finally`. That is precisely what `proposal.md:32` means by "await the checks
inline" and it changes `ensureWorkspaceProjection`'s return timing by at most three local bookmark
reads on the healthy path.

## 2. Architecture decisions

Proposal decisions **D1-D4** and resolved question-round answers **Q1-Q3** are all confirmed against
the tree and implemented literally. **There is no deviation, so no deviation ADR is required.** The
ADRs below settle what the proposal deliberately left to design.

### ADR-501 — Check all three roots, outermost first, in one added `else` branch

**Choice.** In the branch where `latest` exists and `needsBootstrap(latest)` is false, evaluate
`rootChromeId`, then `organizationChromeId`, then `workspaceChromeId`, **all three, sequentially, no
early exit**, collecting the kinds that fail to resolve. A non-empty result calls `resyncWorkspace`
exactly once.

| Option | Tradeoff | Decision |
|---|---|---|
| Stop at the first miss | Saves ≤2 local reads on the *broken* path only — a path that is about to spend an HTTP tree fetch, a full rematerialization and a replay. Reports `root` when the truth is `root, organization, workspace` (a root deletion cascades in Chrome), so the field diagnostic cannot distinguish "the whole managed path was deleted" from "only the org folder was". | Rejected |
| Check all three, collect misses | Fixed, deterministic cost of exactly 3 `chrome.bookmarks.get` per selected workspace per ensure call, on every path. Yields a diagnostic that names the outermost surviving level. | **Chosen** |
| `Promise.all` the three reads | Would cut healthy-path latency to one round. `Promise.all` appears **twice in all of `extension/src`** (`shared/session.ts:60,117`) and **never** for a `chrome.bookmarks` read; every read path in `projection.ts` is sequentially awaited. | Rejected — follow the file's existing pattern; the saving is three local IPC reads once per worker start |

**Order** is root → organization → workspace: it mirrors `ensureManagedPath`'s creation order
(`doResyncWorkspace:1051-1056`) and `handleBookmarkRemoved:695`'s array order, so the reported list
reads outermost-first.

**Rationale.** `getNode` (`chrome-bookmarks.ts:18-29`) resolves `null` on both `lastError` and an
empty result and **never throws** — verified. So the branch cannot convert a bookmark-API hiccup
into a thrown startup; the worst case is a needless rebuild, which is idempotent and capped at
`MAX_AUTO_REPAIR_ATTEMPTS = 2`.

### ADR-502 — The miss routes through `resyncWorkspace` with a diagnostic naming both the level and the trigger

**Choice.** `resyncWorkspace(workspaceId, \`managed root unresolvable at ${reason}: ${missing.join(", ")}\`)`.

`resyncWorkspace:955-958` pauses with `"ambiguous-predecessor"` + `{ repair: "rebuild" }` and logs
`resync required: ${reason}`. The reason string is log-only — it never reaches `pauseReason`, the
journal, or the UI — so it is free to carry diagnosis. It names the level (`root` / `organization` /
`workspace`) *and* the trigger (`startup` / `login` / `selection changed`, the string
`syncSelectedWorkspaces` already threads down), which is exactly what was missing when this bug was
investigated in the field.

**Alternatives rejected:** reusing the reactive path's literal `"managed synthetic root removed
locally"` (indistinguishable in the diagnostics from an `onRemoved`-driven detection — the one
distinction a field investigation needs); a new `pauseReason` value (D2: same disposition, same
budget, same veto — a new reason would fork `retryJournal`/`normalizeJournal` semantics for no gain).

### ADR-503 — Settles proposal risk #3: `doResyncWorkspace` has no socket dependency

**Verified, not assumed.** `doResyncWorkspace:1033-1125` reaches the network exactly twice:
`getWorkspaceTree` (`:1050`) and `replayEvents` (`:1089`), both HTTP. Its only other I/O is
`chrome.bookmarks` (`ensureManagedPath:1051`, `ensureLocalOnlyFolder:1074`,
`clearManagedChildrenWithSuppression:1075`, `materializeFolder:1086`). It never reads
`socketConnected` except to *choose a health label* at `:1099`. **The rebuild does not require a
connected socket. Risk #3 is dismissed** — no ordering work is needed.

The second half of that risk — the rebuild running *concurrently* with the `connectWorkspace:751`
that follows in the same loop — is also safe, and the proof is structural, not empirical:

- While the rebuild is in flight the journal is `paused`. A socket ack that triggers
  `replayWorkspaceDelta:842` reaches `applyRemoteEnvelope`, which refuses at `:1225`
  (`phase === "paused"`), and `markProjectionLive` refuses on the same condition. The concurrent
  replay is a no-op.
- After the rebuild's success updater (`:1095-1113`) sets the journal live and advances `lastCursor`,
  a late replay of the same events is refused at `:1222` (`event.cursor <= projection.lastCursor`).
- `connectWorkspace:775-787` is in-flight deduped, so the rebuild's own trailing
  `connectWorkspace` and the loop's do not produce two sockets.
- Health after a successful startup rebuild is `"recovering"`, not `"live"` (`:1099`, because
  `socketConnected` is still false) — and it is promoted by the next ack through
  `markProjectionLive`, which also restores the budget. No stuck-in-recovering state.

This overlap is not new — every reactive `resyncWorkspace` already produces it — but on the startup
path it is now near-certain rather than incidental, which is why it is proved here rather than
assumed.

### ADR-504 — Already-degraded and budget-exhausted workspaces (Q2 + proposal risk #4)

**Choice.** No health guard. The branch runs regardless of `latest.health`, per Q2.

The consequence is deliberate and must be pinned by a test: a workspace that already spent
`autoRepairAttempts = 2` and has a dangling root will, on the next worker start, re-enter
`pauseWorkspace`, find `attempts >= MAX_AUTO_REPAIR_ATTEMPTS` (`:2083`), arm nothing, and degrade
immediately with no `/tree` fetch. That is the correct fail-closed outcome (`proposal.md:55`) and it
is also the guard that stops the new trigger from becoming an unbounded per-restart rebuild loop.

## 3. Interfaces / contracts

```ts
// extension/src/background/projection.ts:755-773  (REPLACEMENT of the tail of ensureWorkspaceProjection)
  const latest = (await getState()).projectionsByWorkspaceId[workspaceId];
  if (!latest || needsBootstrap(latest)) {
    await pauseWorkspace(workspaceId, latest?.lastCursor ?? 0, "bootstrap-required");
    return;
  }

  // needsBootstrap only asks whether the ids are SET. MV3 evicts the worker constantly, so a
  // managed folder deleted while no worker was alive loses its onRemoved event forever
  // (handleBookmarkRemoved:695 is the only other place existence is ever re-derived) and nothing
  // else ever notices: the workspace keeps reporting live against a chromeId Chrome no longer
  // knows. Re-deriving existence here — the one choke point startup:184, login:196 and
  // selection change:406 all funnel through — is what closes that window. The miss dispatches the
  // same resyncWorkspace call the reactive path makes, so it inherits the disposition, the
  // 2-attempt budget and the unacknowledged-intent veto (ADR-404/406) with no parallel mechanism.
  const unresolvable = await findUnresolvableManagedRoots(latest);
  if (unresolvable.length > 0) {
    await resyncWorkspace(workspaceId, `managed root unresolvable at ${reason}: ${unresolvable.join(", ")}`);
  }
}
```

```ts
// extension/src/background/projection.ts — new, immediately after needsBootstrap:2450-2452
// Existence only, by decision (proposal D3): whether a managed folder the user *moved* is a
// violation or a legitimate reorganization is a separate product question, so parentage is not
// checked here. Ordered outermost-first to mirror ensureManagedPath's creation order (:1051-1056)
// and handleBookmarkRemoved's identity test (:695). getNode (chrome-bookmarks.ts:18) never throws —
// it resolves null on chrome.runtime.lastError and on an empty result alike — so this can never
// turn a bookmark-read hiccup into a thrown startup; the worst case is one idempotent, budgeted
// rebuild. All three are read even after the first miss: a root deletion cascades in Chrome, and
// naming every unresolvable level is what lets a field diagnostic distinguish "the whole managed
// path is gone" from "only the workspace folder is".
async function findUnresolvableManagedRoots(projection: ProjectionState): Promise<string[]> {
  const unresolvable: string[] = [];
  for (const [kind, chromeId] of [
    ["root", projection.rootChromeId],
    ["organization", projection.organizationChromeId],
    ["workspace", projection.workspaceChromeId],
  ] as const) {
    if (!chromeId || !await getNode(chromeId)) {
      unresolvable.push(kind);
    }
  }
  return unresolvable;
}
```

An unset id counts as unresolvable. Unreachable from the only call site (it sits behind
`!needsBootstrap`), but it keeps the helper total rather than carrying an unchecked assumption.

## 4. File changes

| File | Action | Description |
|---|---|---|
| `extension/src/background/projection.ts` | Modify | `ensureWorkspaceProjection` (`:755`): `return` after the bootstrap pause (behaviourally identical today — nothing follows it), then the verification branch. New `findUnresolvableManagedRoots` after `needsBootstrap` (`:2452`). ~25 lines including comments. |
| `extension/tests/projection-behavior.test.mjs` | Modify | 4 tests appended (§5). |

`getNode` and `ProjectionState` are already imported in `projection.ts`. No new import, no new
export, no `projectionTestHooks` addition.

## 5. Testing strategy

`extension/tests/projection-behavior.test.mjs` carries its own in-file `chrome` double (`:78-255`),
not `tests/helpers/fake-chrome.mjs`. Two facts make the fixture exact:

- `chrome.bookmarks.get(id, cb)` (`:114-116`) calls back with `[]` when the id is absent from
  `bookmarkNodes` → `getNode` resolves `null`. This is the "node no longer exists" simulation.
- `removeBookmarkSubtree(id)` (`:67-76`) deletes from the map and **dispatches no event whatsoever**
  — the double has no `onRemoved` wiring at all; `handleBookmarkRemoved` is only ever called
  explicitly by tests. Seeding the three nodes and then calling `removeBookmarkSubtree` is therefore
  a faithful model of "deleted while no worker was alive", and the tests must never call
  `handleBookmarkRemoved`, which is itself the assertion that detection came from the new branch.

Entry point: `setSelectedWorkspaces(["workspace-1"])` (already imported at `:277`). Re-selecting an
already-selected id runs no `removeWorkspaceProjection` and preserves the seeded projection, then
reaches `syncSelectedWorkspaces("selection changed") → ensureWorkspaceProjection`. Model the fixture
on the existing test at `:3489` ("a newly selected workspace bootstraps itself instead of showing
degraded"): `fetchBudget`, the four `fetchHandlers` (`/organizations`,
`/organizations/org-1/workspaces`, `/workspaces/workspace-1/tree`, `/sync/events?afterCursor=0`),
`{ timeout: 15_000 }`, and `await projectionTestHooks.settleAutoRepair("workspace-1")` after the
act. Seed the projection with `createEditorProjection({ rootChromeId, organizationChromeId,
workspaceChromeId, autoRepairAttempts: <explicit> })` — the harness default is `2` (`:485`), so
every test that expects a repair must opt in explicitly.

| # | Test | Fixture | Asserts |
|---|---|---|---|
| T-V1 | a dangling managed root is detected on the next ensure with no `onRemoved` event | 3 nodes seeded, then `removeBookmarkSubtree("workspace-node")`; `health: "live"`, `status: "ready"`, `autoRepairAttempts: 0` | a diagnostic matches `/resync required: managed root unresolvable at selection changed: workspace/`; `autoRepairAttempts === 1` (it went through the *counted* layer, not a parallel mechanism); `convergenceJournal.repairDisposition === "rebuild"` (same disposition as the reactive path); `workspaceChromeId` changed **and** now resolves in `bookmarkNodes`; `health !== "degraded"` |
| T-V2 | a workspace whose managed roots all resolve is untouched | all 3 nodes present; `health: "live"`, `autoRepairAttempts: 0`; a **working** `/tree` handler is registered so a regression surfaces as a count, not an "Unhandled fetch" crash — the pattern the existing `:1056` / `:2260` tests already use | zero `/workspaces/workspace-1/tree` entries in `fetchLog`; `autoRepairAttempts` still `0`; `health` still `"live"`; `convergenceJournal?.phase !== "paused"`; `workspaceChromeId` unchanged; `projectionTestHooks.autoRepairFlightCount() === 0` |
| T-V3 | an already-degraded workspace still gets one fresh attempt (Q2) | as T-V1 but seeded `health: "degraded"`, `status: "error"`, `degradedReason` set, journal paused with `pauseReason: "ambiguous-predecessor"`, `autoRepairAttempts: 1` | a `/auto-repair rebuild started/` diagnostic exists; `autoRepairAttempts === 2`; one `/tree` fetch; `health !== "degraded"` — i.e. the degraded workspace was verified, not skipped |
| T-V4 | an exhausted budget degrades immediately instead of rebuilding every restart (ADR-504 / risk #4) | as T-V1 but `autoRepairAttempts: 2` | `health === "degraded"`; zero `/tree` fetches; zero `/auto-repair \S+ started/` diagnostics |

T-V1 and T-V2 are the two the proposal names explicitly; T-V3 pins resolved answer Q2 and T-V4 pins
the loop bound that makes Q2 safe. Write T-V1 RED first (it fails on `develop` with
`autoRepairAttempts === 0` and no diagnostic) — `strict_tdd` is `false` in `openspec/config.yaml`,
so this is a recommendation, not a gate.

**Regression surface.** `ensureWorkspaceProjection` is reachable from only three test sites in the
whole suite: `projection-behavior.test.mjs:893` (`setSelectedWorkspaces([])` — empty list, the loop
never runs), `:3511` (empty `projectionsByWorkspaceId` → bootstrap branch, unchanged), and
`initializeBackground` in `theme-preferences.test.mjs:88,104` / `public-config.test.mjs:55,74`
(`selectedWorkspaceIds` empty → returns at `:181`). Every other fixture built by `createProjection`
(`:462`) leaves the three chrome ids undefined, so `needsBootstrap` is true and the new branch is
never entered. Expected breakage: none.

| Layer | What | How |
|---|---|---|
| Unit | `findUnresolvableManagedRoots` ordering and all-three behavior | Covered transitively by T-V1's diagnostic string; not exported, so no direct unit test |
| Integration | the four rows above | `node --test extension/tests/projection-behavior.test.mjs` against `extension/dist` (tests import compiled `../dist/**`, so `tsc` must run first) |
| E2E | — | N/A — no UI surface changes; `health`/`degradedWorkspaceCount` semantics are untouched |

## 6. Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. The change adds three local `chrome.bookmarks.get` reads and one call
to an existing internal function.

## 7. Backend / extension contract

Unchanged. No message format, no endpoint, no cursor semantics, no persisted-state shape is touched
(`config.yaml` `rules.design`: nothing to document here beyond this statement). The rebuild the
branch can trigger uses `GET /workspaces/{id}/tree` and `GET .../sync/events` exactly as
`rebuildWorkspace` already does.

## 8. Migration / rollout

No migration. No feature flag. No persisted field added, so installs that predate the change need no
normalization and a rollback needs no cleanup. Rollback = delete the branch and the helper.

Delivery: single PR on `fix/extension-verify-managed-roots-on-startup` off `develop`. Forecast is
~25 production lines + ~120 test lines — comfortably inside the 400-line review budget, no chaining
needed.

## 9. Open questions

None blocking. Recorded for the record, not for this change:

- Structural/parentage validation stays deferred (Q3). If a user *moves* a managed folder rather than
  deleting it, all three ids still resolve and this branch stays silent — the workspace is
  functionally fine, but the orphaned-duplicate shape found during the investigation remains
  undetected. Revisit only with a product decision on move-vs-violation.
- Q1's no-timer decision leaves a stuck window bounded by MV3's restart cadence. Revisit only if
  field evidence shows workers staying alive unusually long.
