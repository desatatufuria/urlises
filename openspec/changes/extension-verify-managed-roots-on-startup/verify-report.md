# Verify Report: extension-verify-managed-roots-on-startup

**Change**: extension-verify-managed-roots-on-startup
**Branch**: fix/extension-verify-managed-roots-on-startup (off develop), commit 75ae697
**Mode**: full artifact verification (proposal + spec + design + tasks), all present
**Verdict**: **PASS** (0 CRITICAL, 0 WARNING, 0 SUGGESTION)

## 1. Test / build evidence (independently re-run, not trusted from the apply report)

```
$ cd extension && npm run test:projection
...
1..247
# tests 247
# suites 0
# pass 247
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3856.136491
```

247/247 pass, exit 0. Matches apply's claimed count exactly (develop baseline was 243/243; this change adds the 4 new T-V1..T-V4 tests → 247).

```
$ cd extension && npm run typecheck
> tsc -p tsconfig.json --noEmit
EXIT:0
```

Typecheck clean, zero errors.

## 2. Diff scope (git diff develop..fix/extension-verify-managed-roots-on-startup -- extension/)

```
 extension/src/background/projection.ts       |  37 +++
 extension/tests/projection-behavior.test.mjs | 153 ++++++++++++
 6 files changed, 634 insertions(+)  (remaining 4 files are openspec SDD artifacts)
```

Exactly 2 code/test files touched, both in scope. No unrelated files. Only 3 hunks total:
- `projection.ts:769` — tail of `ensureWorkspaceProjection` (verification branch)
- `projection.ts:2465` — new `findUnresolvableManagedRoots` helper after `needsBootstrap`
- `projection-behavior.test.mjs:3687` — 4 tests appended (pure addition, no existing lines touched)

## 3. `findUnresolvableManagedRoots` structure — read directly, not inferred

```ts
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

Confirmed: all three (`root`/`organization`/`workspace`) are checked via `getNode`, outermost-first, in a single `for...of` loop over a fixed tuple array. No `break`, no `return` inside the loop body — every miss is pushed, no early exit on the first miss. This satisfies ADR-501 ("check all three, collect misses") literally, not just by call count.

## 4. `ensureWorkspaceProjection` verification branch

```ts
const latest = (await getState()).projectionsByWorkspaceId[workspaceId];
if (!latest || needsBootstrap(latest)) {
  await pauseWorkspace(workspaceId, latest?.lastCursor ?? 0, "bootstrap-required");
  return;
}
// ... verification branch ...
const unresolvable = await findUnresolvableManagedRoots(latest);
if (unresolvable.length > 0) {
  await resyncWorkspace(workspaceId, `managed root unresolvable at ${reason}: ${unresolvable.join(", ")}`);
}
```

- The new `return` was added after the bootstrap pause, making the verification branch reachable only when `needsBootstrap(latest)` is false — confirmed by control flow, not assumption.
- `resyncWorkspace` at line 969 is the **same** function `handleBookmarkRemoved` calls (`grep` confirms a single `async function resyncWorkspace` definition in the file) — no parallel/new repair path introduced.
- Grepped the whole file for `health === "degraded"` / `health===\"degraded\"`: the only hit (line 1043) is an unrelated `degradedWorkspaceCount` aggregation, not a guard in this code path. No health guard exists that would skip verification for already-degraded workspaces — confirmed absence, not just absence-by-omission.

## 5. `handleBookmarkRemoved` — byte-identical confirmation

`git diff develop..fix/... -- extension/src/background/projection.ts` shows zero hunks inside `handleBookmarkRemoved`'s body (lines ~681-720); the only textual references to it are two new *comments* in the added code that cite its line number for context. Independently byte-diffed the extracted function body (develop vs. branch, lines 680-720): **IDENTICAL**, confirmed via `diff` returning no output.

## 6. Test evidence — T-V1 through T-V4 read directly against the fixture

The in-file `chrome` double (`projection-behavior.test.mjs:78-131`) has **no `onRemoved` wiring at all** (`grep onRemoved` in the test file returns only comments/test-name text, zero listener registration) — `chrome.bookmarks.get` returns `[]` for a deleted id, so `getNode` resolves `null` faithfully, and `removeBookmarkSubtree` (line 67) deletes from the map without dispatching any event. This makes "deleted while no worker was alive" the only way these fixtures can be interpreted; `handleBookmarkRemoved` is never called by any of the four new tests.

- **T-V1** (dangling root, no `onRemoved`): seeds 3 nodes, deletes `workspace-node` via `removeBookmarkSubtree`, drives detection through `setSelectedWorkspaces` → `ensureWorkspaceProjection` (not the reactive handler). Asserts a `resync required: managed root unresolvable at selection changed: workspace` diagnostic, `autoRepairAttempts===1` (spent through the counted layer), `repairDisposition==="rebuild"` (same disposition as reactive path), a new resolvable `workspaceChromeId`, and `health!=="degraded"`. Genuinely exercises the new branch end-to-end.
- **T-V2** (healthy, untouched): all 3 nodes resolve; asserts **zero** `/workspaces/workspace-1/tree` fetches, `autoRepairAttempts` unchanged at 0, `health` stays `"live"`, journal not paused, `workspaceChromeId` unchanged, `autoRepairFlightCount()===0`. This test would fail on a regression that added an unconditional extra check/dispatch — any such regression would trigger a `/tree` fetch or increment the counter or start a repair flight, all of which are asserted against directly, not inferred.
- **T-V3** (already-degraded gets a fresh attempt): seeds `health:"degraded"`, journal already `paused` with `pauseReason:"ambiguous-predecessor"`, `autoRepairAttempts:1`, then deletes the workspace node. Asserts exactly one `auto-repair ... started` diagnostic, `autoRepairAttempts===2`, exactly one `/tree` fetch, and `health!=="degraded"` afterward — proving the degraded workspace was actually re-verified and re-attempted, not skipped.
- **T-V4** (exhausted budget degrades immediately): as T-V1 but seeded `autoRepairAttempts:2`. Asserts `health==="degraded"`, **zero** `/tree` fetches, and zero `auto-repair ... started` diagnostics — confirming the pre-existing budget guard inside `pauseWorkspace`/`resyncWorkspace` (`attempts >= MAX_AUTO_REPAIR_ATTEMPTS`) degrades immediately rather than looping into another rebuild, exactly as ADR-504 requires.

No tautologies, no ghost loops over possibly-empty collections, no assertions divorced from production code — every assertion reads real post-call state (`projection.autoRepairAttempts`, `projection.health`, `fetchLog`, `state.diagnostics`) produced by driving `setSelectedWorkspaces` through the real `ensureWorkspaceProjection` code path.

## 7. Spec scenario → test/implementation mapping

| spec.md scenario | Implementation | Test | Status |
|---|---|---|---|
| Healthy workspace is untouched by verification | `ensureWorkspaceProjection`'s verification branch, no-op path | T-V2 | ✅ Covered, passing |
| Dangling root detected without a live removal event | `findUnresolvableManagedRoots` + `resyncWorkspace` dispatch | T-V1 | ✅ Covered, passing |
| Already-degraded workspace gets a fresh rebuild attempt | Same branch, no `health` guard (ADR-504) | T-V3 | ✅ Covered, passing |
| Reactive removal detection is unaffected | `handleBookmarkRemoved`, confirmed byte-identical | Pre-existing suite (untouched, still 100% passing within the 247) | ✅ Covered, passing |
| Read failure at cursor zero (pre-existing, unmodified requirement) | Unchanged | Pre-existing suite | Out of scope for this change — unmodified, still passing |

T-V4 is a regression-safety test (ADR-504 / proposal risk #4), not a distinct spec.md scenario name, but it directly pins the budget-exhaustion consequence the "Already-degraded" scenario's design explicitly calls out as required behavior.

## 8. Tasks / apply-progress cross-check

All tasks in `tasks.md` (Phase 1-4) are checked. Tasks.md's own inline RED/GREEN evidence (`not ok 190/191/192/193` on develop, `ok 190/191/192/193` post-change, full suite 247/247) matches the independently re-run result in section 1. Proposal.md's 4 Success Criteria are checked and match what was independently confirmed here (T-V1/T-V2/T-V3 mapping, `resyncWorkspace` reuse, byte-identical `handleBookmarkRemoved`).

No `apply-progress` artifact file exists separately in this openspec change directory (this project's active backend for this session had no Engram/mem_* tools attached); `tasks.md`'s inline confirmations serve as the equivalent apply evidence and were independently verified against the actual code and test run rather than trusted at face value.

## Issues

None found. 0 CRITICAL, 0 WARNING, 0 SUGGESTION.

## Final Verdict: **PASS**
