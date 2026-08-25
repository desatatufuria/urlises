# Verify Report: extension-auto-repair-before-degraded

**Change**: extension-auto-repair-before-degraded
**Branch chain**: feature/extension-auto-repair-on-pause → -step0 → -slice-a → -slice-b → -slice-c (tip)
**Mode**: full artifact verification (proposal + spec + design + tasks), all present
**Verdict**: **PASS WITH WARNINGS** (0 CRITICAL, 1 WARNING, 0 SUGGESTION)

## Test / build evidence (independently re-run, not trusted from the apply report)

| Branch | Build | Typecheck | Tests | Result |
|---|---|---|---|---|
| step0 | clean | clean | 228/228 | green (isolated worktree) |
| slice-a | clean | clean | 231/231 | green (isolated worktree) |
| slice-b | clean | clean | 233/233 | green (isolated worktree) |
| slice-c (tip) | clean | clean | 243/243, 2 consecutive runs, ~3.9s each, clean exit | green |

`node --version`: v18.20.4. No hang observed on any run. Command exit codes all 0.

## 1. Bounded-ness / termination proof — re-derived against actual code (design §11.1)

Grepped `projection.ts` directly, not the design's prose:

- **Exactly one increment site** for `autoRepairAttempts`: `projection.ts:2092`, `projection.autoRepairAttempts = attempts + 1;` — inside `pauseWorkspace`'s `updateProjectionState` updater, guarded by `if (action)`.
- **Exactly one claim-set site**: `projection.ts:2094`, `autoRepairFlights.set(workspaceId, claim);` — same updater, same `if (action)` branch, no `await` between the `chainInFlight`/`attempts` reads (:2081-2082) and the write.
- **Exactly one release-and-clear site**: `resetRuntimeState` (`projection.ts:2623-2641`) — releases every claim then `.clear()`s the map. (Individual per-chain releases also exist in `pauseWorkspace`'s `catch` and `runAutoRepair`'s `finally`, but those are claim-identity-scoped deletions of one entry, matching design; the *clear-all* site is singular.)
- **Exactly 3 reset-to-0 sites** for the counter, each verified by reading the surrounding function:
  - `markProjectionLive` (`:1916`), early-returns at `:1903` if the journal is paused, so it only fires on genuine live.
  - `doResyncWorkspace`'s live branch (`:1111`), inside `if (projectionState.health === "live")`.
  - `attemptSubtreeRecovery`'s success updater (`:2422`), unconditional in the success path.
- `enterRecovery` (`:2163-2187`) contains **zero** occurrences of `autoRepairAttempts` — confirmed by grep and by a byte-for-byte diff of the extracted function body between `develop` and the `slice-c` tip (identical).

This matches design §11.1's proof exactly: at most 2 dispatches per budget window, at most 1 concurrent chain per workspace, both by construction of a single synchronous arm-site guarded by a single claim-check in the same slot. Verdict: **proof holds against the real code**, not just the design's narrative.

## 2. The flagged race window — settle's re-drive vs. an unrelated concurrent `pauseWorkspace`

Confirmed the window is real: `runAutoRepair`'s `finally` deletes the claim (`:2133`) *before* calling `settleAfterAutoRepair` (`:2135`), and `settleAfterAutoRepair` does an un-queued `await getState()` (`:2144`) before its own re-entrant `pauseWorkspace` call (`:2150`). Between the claim deletion and that re-entrant call actually reaching its `updateProjectionState` slot, `autoRepairFlights.has(workspaceId)` is `false`, so a **wholly independent, concurrent** `pauseWorkspace` invocation for the same workspace can indeed race the settle-driven re-drive for "who gets to arm attempt 2."

**This does not violate the bound.** `stateMutationQueue` (`storage.ts:5`) is a single **global** FIFO (not per-workspace — confirmed by reading `storage.ts:5,171-173`), so both the settle-driven call and any unrelated concurrent call are serialized onto the same queue before either's updater body runs. Whichever of the two updater invocations executes first sees `chainInFlight === false`, arms, increments the counter by exactly one, and sets the claim in that same synchronous slot; the second invocation — regardless of which one it is — necessarily observes `chainInFlight === true` in *its* slot and takes the no-increment branch. The atomicity that makes the bound hold is a property of "one arm per slot-observing-no-claim," not of which logical caller performed the arm. So the only externally observable consequence of this race is **misattribution** (a different concurrent pause's reason may be the one that ends up credited with "attempt 2" instead of the settle-driven re-drive's own pause reason) — never a double-arm, never more than 2 total increments before a reset, never 2 concurrent chains. Confirmed by direct trace against the actual `pauseWorkspace` body (`:2071-2118`), not merely by re-reading the design's assertion.

## 3. Named test mapping — read directly, not inferred from titles

| Test ID | Actual test name (as implemented) | Line | Verdict |
|---|---|---|---|
| T-C1 | `a nested pause inside a running repair never starts a second chain and never re-uses attempt 1` | 3371 | Real, asserts attempt sequence `[1,2]` (never `[1,1]`), `autoRepairFlightCount()===0` post-settle, `health==="degraded"`. Correctly exercises the exact §4.3 scenario. |
| T-C6 | `the attempt budget is monotonic across a recovery chain that calls enterRecovery` | 3558 | Real, drives `recoverWorkspace(...,"resync")` (which calls `enterRecovery`) and asserts `autoRepairAttempts===2`, guarding exactly the §3.4 mis-reset scenario. |
| T-C8 | `an automatic rebuild is refused while an unacknowledged intent exists` | 3615 | Real, seeds a `status:"sent"` intent, asserts degrade on the *first* pause, `autoRepairAttempts===0`, intent preserved, zero `/tree` fetches. |
| Cross-test contamination fix | `resetRuntime` (`tests/projection-behavior.test.mjs:429-452`) | 429 | Confirmed: drains `settleAutoRepair("workspace-1")` and `("workspace-2")` unconditionally at the very start of teardown, before any other reset, exactly as the apply report described. |

T-A1–A5, T-B1–B4, and the remaining T-C tests (C2–C5, C7, C9) were also located and spot-read (T-B1/B2/B3/B4, T-A1 table-driven case, T-C7 durable-write-failure case); all assert real, behaviorally-correct outcomes rather than tautologies. The apply report's claim of "extended existing test, not new" for T-A3 (`subtree recovery's workspace fallback is dispositioned rebuild when the auto-repair budget is exhausted`) and the renamed `...and self-heals via bounded auto-repair` test (line 2750) were both located and match the described restructuring.

## 4. The three "no destructive resync" guard tests — pass for the right reason, not by luck

Located at current lines (renumbered from the pre-change 1056/1092/2260):
- `replay gap pauses the workspace without destructive resync` (line 1079)
- `Retry keeps an unproven receipt paused and Rebuild is the only destructive workspace action...` (line 1115)
- `handleBookmarkRemoved pauses a rejected local delete without destructive recovery` (line 2564)

All three build their fixtures via `createRuntimeState`/`createProjection`/`createEditorProjection`, and **none of them override `autoRepairAttempts`**. Per the harness default (`tests/projection-behavior.test.mjs` `createProjection`, §12.2 of the design), the default is `autoRepairAttempts: 2` — an already-exhausted budget. Traced through `pauseWorkspace`'s arm condition (`chainInFlight || attempts >= MAX_AUTO_REPAIR_ATTEMPTS ? undefined : planAutoRepair(...)`, `:2083`): with `attempts===2`, `action` is deterministically `undefined` on every call, so the auto-repair layer **never engages** for these three tests — no fire-and-forget dispatch is ever scheduled, so the zero-`/tree`-fetch assertions are not racing a background chain; they are structurally guaranteed. This is exactly the intended effect of §12.2's "legacy contract" harness default, and it holds up under direct trace, not just under passing test output.

## 5. Slice separability — re-verified independently, not trusted from the apply report

Checked out step0, slice-a, and slice-b into isolated `git worktree` checkouts (not the tip) and ran `npm install && npm run build && npm run typecheck && npm run test:projection` on each in isolation:

- step0: build clean, typecheck clean, **228/228** tests pass.
- slice-a: build clean, typecheck clean, **231/231** tests pass.
- slice-b: build clean, typecheck clean, **233/233** tests pass.

All three numbers match tasks.md's per-slice gate results exactly (0.4/A.11/B.7). Worktrees were removed after verification; the primary checkout was left untouched at `slice-c`.

## 6. Unrelated file modifications — confirmed absent from all 4 commits

`git show --stat <commit> -- .github .devcontainer` for each of `5c23799`, `948d1dd`, `d32a25a`, `fe5fbc5`, and `git diff develop feature/extension-auto-repair-on-pause-slice-c -- .github .devcontainer` for the full range: **all empty**. The working-tree modifications to `.devcontainer/devcontainer.json` and `.github/workflows/release.yml` visible in `git status` are confirmed to originate from something other than this change's 4 commits, as expected. Not investigated further per the orchestrator's instruction.

## 7. Rollback claim (design §13) — confirmed for A and B, **inaccurate for C** as literally stated

- **Slice A** (`drop the { repair: "rebuild" } hints; options stays, backward compatible`): confirmed. The `options: { repair? }` parameter (`:2064`) is optional with a default `{}`; dropping the three call-site hints (`:927-930`, `:2007`, `:2213` region) leaves `pauseWorkspace` compiling and behaving as it did before Slice A.
- **Slice B** (`restore the two direct journal writes`): confirmed low-risk; independently verified the pre-Slice-B code (checked out as `slice-a` tip) builds/tests green, so a revert of `d32a25a` alone lands on a known-green base.
- **`autoRepairAttempts` additive and ignored by older code**: confirmed. `normalizeProjectionState` (`storage.ts:90`) uses `?? 0`; older code has no reference to the field and cannot break on its presence.
- **Slice C** ("revert the finally dispatch line — the counter becomes inert, `pauseWorkspace` degrades on first failure again"): **traced against the actual code and this specific claim does not hold.** If only the dispatch line `if (armed) void runAutoRepair(workspaceId, armed, claim);` (`:2116`) is deleted while everything else in the rewritten `pauseWorkspace` stays:
  1. On the first pause with budget remaining, the updater still arms: `autoRepairAttempts` still increments to 1, `autoRepairFlights.set(...)` still runs, `health` is still set to `"recovering"` (not `"degraded"`).
  2. Because the dispatch never runs, `runAutoRepair`/`settleAfterAutoRepair` never execute, so the claim is **never released** and the counter is **never incremented again or reset**.
  3. Every subsequent pause for that workspace sees `chainInFlight === true` (permanently, since nothing ever deletes the claim) and therefore takes the `if (chainInFlight || action)` branch forever, re-setting `health = "recovering"` and clearing `degradedAt`/`degradedReason` on every call, with `action` forced to `undefined` (because `chainInFlight` short-circuits it), so the counter never moves past 1.
  4. Net effect: the workspace gets **permanently stuck in `"recovering"`, never `"degraded"`** — the exact "silently stuck, reporting non-degraded" failure class that Slice B was built to eliminate — rather than "degrading on first failure" as the design text claims.

  The **actually safe and tested** rollback for Slice C is a full revert of commit `fe5fbc5` (or equivalently, resetting to the `slice-b` tip), which this verification pass confirmed independently builds, typechecks, and passes 233/233 tests. This is a WARNING against the design document's rollback narrative, not against the shipped code or its test coverage — no test in the suite currently exercises "dispatch line removed while the rest of the mechanism stays," so nothing here is a regression; it is a latent inaccuracy in design.md §13 that would mislead a future maintainer attempting the described minimal-line rollback.

## Issues

### CRITICAL
None.

### WARNING
1. **design.md §13's stated one-line rollback for Slice C is incorrect and would produce a worse failure mode than the one being rolled back from.** Deleting only the `runAutoRepair` dispatch call leaves the workspace permanently claimed and stuck in `health: "recovering"` (never `"degraded"`) rather than "degrading on first failure" as claimed, because the counter-increment and claim-set logic is not gated on the dispatch line — only the repair *action* is. Recommend the orchestrator correct design.md §13 to say "revert the Slice C commit in full" (verified safe/green in this pass) rather than describing a targeted one-line revert. Does not block archive; no shipped test claims to cover this literal partial-revert scenario, so there is no test/implementation mismatch, only a documentation-accuracy gap.

### SUGGESTION
None.

## Spec compliance matrix (Requirement: Verified Fail-Closed Sequencing / Isolation, Repair, and Diagnostics)

| Scenario | Covering test | Status |
|---|---|---|
| Resync-shaped pauses carry rebuild disposition instead of resyncing inline | T-A1 (table, 8 sites), T-A2, T-A3 | PASS |
| Containment holds during automatic rematerialization | pre-existing 2-workspace containment test (unchanged) | PASS |
| First repair attempt shows recovering, not degraded | T-C2, T-C4, T-C9 (first-failure branch) | PASS |
| Exhausted attempts degrade uniformly with correct disposition | T-C5 | PASS |
| Success resets the budget for a later, unrelated failure | T-C9 | PASS |
| No concurrent repair chain per workspace | T-C1, T-C2 | PASS |
| Unacknowledged local intent vetoes automatic rebuild | T-C8 | PASS |
| Pause timing contract unchanged | pre-existing caller-timing tests (unchanged, all green) | PASS |
| Every pause reason (incl. captureLocalUpdateOrMove's three) reaches health signal | T-B1, T-B2, T-B3 | PASS |
| enterRecovery give-up branch unchanged, no repairDisposition | T-B4 | PASS |

## Task completion

All 44 non-manual tasks in tasks.md are marked `[x]` and were independently spot-verified against source/tests, not just trusted from the checkbox. Phase D (D.1, D.2) remains explicitly and correctly unchecked — out of scope for this verification pass, per the orchestrator's instruction; not treated as a blocking incomplete task since it is manual-only by design.

## Final verdict

**PASS WITH WARNINGS.** The core mechanism, its termination/concurrency proof, the race-window analysis, the test suite, and slice separability all hold up under independent, adversarial re-verification against the actual code (not the design's prose). One documentation-only inaccuracy was found in design.md §13's Slice C rollback description; it does not affect the shipped implementation or its test coverage and does not block archival, but should be corrected before this design document is relied upon for an actual future rollback.
