# Tasks: Auto-repair before showing the degraded state

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Step0 ~20-30, Slice A ~100-140, Slice B ~65-85, Slice C ~300-370 (total ~500-650) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Step0 → Slice A → Slice B → Slice C, stacked |
| Delivery strategy | auto-chain (already resolved — proposal.md "resolved by orchestrator") |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

Base/tracker: `feature/extension-auto-repair-on-pause` (off `develop`). Each unit branches off the previous (stacked-branch-per-unit, this session's established pattern; design §13 shows A→B→C, Step0 is prepended per explicit user instruction).

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 0 | Anti-hang test infra (settle hook, fetch fuse), no behavior change | PR 0, base=tracker | `cd extension && npm run test:projection` (full suite, must stay green+exit) | N/A — infra only, no live scenario | Revert test-file/hook additions; zero production impact |
| 1 | Slice A: resync-shaped pauses disposition `rebuild`, no inline resync | PR 1, base=PR0 | `npm run build && node --test --test-name-pattern="(resync|disposition|Retry path)" tests/projection-behavior.test.mjs` | N/A — no browser E2E harness in repo; live check deferred to Phase D | Drop `{ repair: "rebuild" }` hints; `options` param stays (backward compatible) |
| 2 | Slice B: `captureLocalUpdateOrMove`'s 2 pauses degrade visibly | PR 2, base=PR1 | `--test-name-pattern="(cursor-zero|ambiguous-operation|stale-mapping|give-up)"` | N/A — same reason as Unit 1 | Restore the two direct journal writes (pre-`pauseWorkspace`) |
| 3 | Slice C: bounded auto-repair mechanism (counter, claim, policy) | PR 3, base=PR2 | `--test-name-pattern="(auto-repair|nested pause|bootstraps itself|budget)"` | N/A — same reason; manual gate is Phase D | Revert the `finally` dispatch line; counter becomes inert, `autoRepairAttempts` ignored by old code (C11) |

## Phase 0: Step 0 — Anti-hang test infra (lands FIRST, alone, before any slice's production code; branch `.../step-0-anti-hang-test-infra`)

- [x] 0.1 Add `settleAutoRepair`/`autoRepairFlightCount` to `projectionTestHooks` (projection.ts:126-135), `maxChains=4` fuse (inventory #17). Implemented with a minimal inert `autoRepairFlights` map (declared ahead of Slice C's production writer so the hooks type-check with zero behavior change); Slice C's C.4 upgrades the claim shape in place.
- [x] 0.2 Add `fetchBudget` fuse to the mock `fetch` double (tests/projection-behavior.test.mjs:284-302); reset in `resetRuntime`.
- [x] 0.3 (Optional) add `--test-timeout` to `package.json:10` only if `node --version` >= 20.15 (inventory #5). SKIPPED: `node --version` is v18.20.4, below the 20.15 guard — not added, per design §12.1 point 3.
- [x] 0.4 Gate: full `npm run test:projection` green, process exits, no new assertions; `npm run typecheck` green. Commit alone. Result: 228/228 pass, typecheck clean, process exited.

## Phase A: Slice A — resync-shaped pauses get a rebuild disposition (ADR-404; branch `.../slice-a-resync-disposition` off step-0)

RED:
- [x] A.1 T-A1: table-driven over the 8 call sites (:567,:578,:624,:647,:674,:682,:699,:945) — `phase==="paused"`, `pauseReason==="ambiguous-predecessor"`, `repairDisposition==="rebuild"`, zero `/tree` fetches, `repair:` diagnostic. RED confirmed (all 8 cases failed on `repairDisposition` before GREEN).
- [x] A.2 T-A2: `recoverWorkspace(...,"resync")` (:2007) dispositions rebuild; keeps `:1056`'s zero-`/tree` assertion. Implemented as a new test (`a replay gap that requires resync is dispositioned rebuild, not retry`) reusing the `:1056` fixture shape so the original test stays byte-for-byte unchanged (A.10).
- [x] A.3 T-A3: `recoverSubtreeThenWorkspace` fallback (:2213) dispositions rebuild. Implemented by extending the existing `connectWorkspace falls back from subtree recovery to workspace resync before degrading` test in place (same call site/scenario) with one added `repairDisposition === "rebuild"` assertion.
- [x] A.4 T-A4: Retry is a no-op after a resync-shaped pause (no `/sync/events` fetch); Rebuild clears it. RED confirmed.

GREEN:
- [x] A.5 `pauseWorkspace` gains `options: { repair?: "retry"|"rebuild" }` (projection.ts:2010).
- [x] A.6 `resyncWorkspace` (:927-930) passes `{ repair: "rebuild" }`; log → `resync required: …`.
- [x] A.7 `recoverWorkspace` resync fallback (:2007) passes `{ repair: "rebuild" }`.
- [x] A.8 `recoverSubtreeThenWorkspace` fallback (:2213) passes `{ repair: "rebuild" }`.
- [x] A.9 Confirm T-A1-T-A4 green. Confirmed: full suite 231/231 green.

Regression guard (D6/C8, explicit — not incidental):
- [x] A.10 Run and confirm UNCHANGED pass of the three named zero-`/tree` tests: `tests/projection-behavior.test.mjs:1056`, `:1092`, `:2260` (T-A5) — Slice A never calls `doResyncWorkspace` inline. Confirmed passing unchanged; `git diff` against step0 contains zero occurrences of `doResyncWorkspace` and zero diff in `enterRecovery`.
- [x] A.11 Gate: `npm run test:projection` + `npm run typecheck` green. Commit Slice A alone. Result: 231/231 pass, typecheck clean. Production diff: 22 lines (projection.ts).

## Phase B: Slice B — `captureLocalUpdateOrMove`'s 2 direct pauses degrade visibly (ADR-405; branch `.../slice-b-visible-local-pauses` off slice-a)

RED:
- [x] B.1 T-B1: vanished node, `lastCursor===0` → `pauseReason==="cursor-zero-read-failed"`, `health==="degraded"`, `failedCursor===0`, zero fetches. Implemented by extending the existing `missing cursor-zero node pauses intent capture...` test in place. RED confirmed.
- [x] B.2 T-B2: vanished node past cursor zero → `pauseReason==="ambiguous-operation"`, `failedCursor===5`. New test `a local change to a vanished node past cursor zero degrades as ambiguous-operation`. RED confirmed.
- [x] B.3 T-B3: node moved outside workspace subtree → `pauseReason==="stale-mapping"`, `health==="degraded"`, no backend call. New test `a local move of a node outside the workspace subtree degrades as stale-mapping`. RED confirmed.
- [x] B.4 T-B4 (guard): re-assert `:1467-1485` verbatim + `journal?.phase !== "paused"` + `degradedReason==="websocket closed"`. Added the phase assertion to the existing `connectWorkspace degrades only after the silent recovery budget is exhausted` test.

GREEN:
- [x] B.5 Rewrite the two direct journal blocks in `captureLocalUpdateOrMove` (:435-454) to call `pauseWorkspace` with a snapshot-read cursor/reason; no `{ repair }` hint.
- [x] B.6 Confirm T-B1-T-B4 green. Do NOT touch `enterRecovery` (:2024-2048) — excluded, ADR-405. Confirmed: `git diff feature/extension-auto-repair-on-pause -- src/background/projection.ts` shows zero occurrences of `enterRecovery`.
- [x] B.7 Gate: `npm run test:projection` + `npm run typecheck` green. Commit Slice B alone. Result: 233/233 pass, typecheck clean. Production diff: 19 lines (net, projection.ts).

## Phase C: Slice C — bounded auto-repair mechanism (ADR-401/402/403/406; branch `.../slice-c-bounded-auto-repair` off slice-b)

Scaffolding (additive, no behavior change):
- [x] C.1 Add `autoRepairAttempts: number` to `ProjectionState` (types.ts:233).
- [x] C.2 Default `autoRepairAttempts: 0` in `createProjectionState` (storage.ts:77).
- [x] C.3 Normalize `autoRepairAttempts: projection.autoRepairAttempts ?? 0` (storage.ts:87, C11).
- [x] C.4 Add `AutoRepairClaim` type, `autoRepairFlights` map, `MAX_AUTO_REPAIR_ATTEMPTS=2`, `createAutoRepairClaim()` (projection.ts:85-87). The bare `autoRepairFlights` map already existed from Phase 0 (inert); this task upgraded its claim type to `{ promise, release }` and added the constant/factory.
- [x] C.5 Harness: `createProjection` factory gets legacy default `autoRepairAttempts: 2` (§12.2) so existing tests keep pinning immediate-degrade.

RED before #11 (pauseWorkspace rewrite):
- [x] C.6 T-C1 (attempt-2 regression): nested pause inside a running repair starts no 2nd chain; counter sequence `1` then `2`, never `1,1`; `autoRepairFlightCount()<=1` throughout, `0` after settle. RED confirmed (attempts stayed `0`, no dispatch, before GREEN).
- [x] C.7 T-C2: two pauses fired unawaited for one workspace start exactly one chain. RED confirmed.
- [x] C.8 T-C3: transient failure (drainLocalIntentsNow's catch) repairs silently, `health` never `"degraded"`. RED confirmed.
- [x] C.9 T-C4: newly selected workspace bootstraps itself (no fixture override — production default). RED confirmed.
- [x] C.10 T-C5: third consecutive failure degrades with Slice A's `repairDisposition`. RED confirmed.
- [x] C.11 T-C6 (§3.4 guard): budget stays monotonic across a chain through `enterRecovery` — `autoRepairAttempts===2`, not `1`. RED confirmed.
- [x] C.12 T-C7: durable-write failure (`storageSetFailure`) claims nothing, still throws, no dispatch. Passed even pre-GREEN (trivially true with no mechanism yet) — kept as a permanent regression guard, consistent with C6.

GREEN (#11+#12, coupled by compilation):
- [x] C.13 Rewrite `pauseWorkspace`: claim+counter decided inside the atomic updater, armed dispatch `void`-ed in a `finally` after `await log(...)`; `catch` releases claim and rethrows (C6).
- [x] C.14 Add `planAutoRepair` (pure, mirrors `retryJournal`), `runAutoRepair` (session/selection/claim-identity guards), `settleAfterAutoRepair` (re-drive or fail-closed degrade).
- [x] C.15 Confirm T-C1-T-C7 green. Confirmed (two fixture bugs found and fixed along the way — see Deviations/Issues in the final report — not mechanism bugs).

RED before #12's veto branch:
- [x] C.16 T-C8: rebuild-shaped pause with an unacknowledged (`sent`) local intent degrades immediately on the FIRST pause, `autoRepairAttempts===0`, intent preserved, zero `/tree` fetches. RED confirmed once C.13/C.14 landed (without the veto, `planAutoRepair` incorrectly armed a rebuild).

GREEN:
- [x] C.17 Add the unacknowledged-intent veto branch to `planAutoRepair` (C7, spec.md:72). Confirm T-C8 green.

RED before #13-#15 (reset sites):
- [x] C.18 T-C9: success resets the budget — fail once (attempts→1), heal, assert `autoRepairAttempts===0`, fail again → `recovering`, not `degraded`. RED confirmed (attempts stayed `1` after heal, pre-reset).

GREEN:
- [x] C.19 Add `autoRepairAttempts = 0` reset in `markProjectionLive`, `doResyncWorkspace`'s live branch, `attemptSubtreeRecovery`'s success updater. Do NOT reset in `enterRecovery` (C3/T-C6 guard) — confirmed zero diff in `enterRecovery` across the whole 4-branch chain.
- [x] C.20 Confirm T-C9 green.

Cleanup / hang-safety:
- [x] C.21 In `resetRuntimeState` (after `rebuildLocks.clear()`), release every claim then `autoRepairFlights.clear()` (inventory #16).
- [x] C.22 Full-suite gate: `npm run test:projection` (all T-A/T-B/T-C + legacy suite) + `npm run typecheck` green; confirm process exits (no hang). Commit Slice C alone. Result: 243/243 pass across 3 consecutive runs, typecheck clean, process exits every time (no hang).

**Critical finding, fixed as part of this slice (test-infra, not production code):** turning on the auto-repair layer meant several *pre-existing* tests (written before this feature existed) that pass through a mid-test socket ack matching `lastCursor` now legitimately reset `autoRepairAttempts` to `0` via `markProjectionLive` (an intentional, designed behavior — §5's "cheap reset trigger" residual) and then unknowingly trigger a **real, fire-and-forget auto-repair chain** on their own later failure, because they predate `settleAutoRepair` and never await it. That chain does not stop when the test ends; its `updateProjectionState`/`getState` calls keep landing on the *shared* `stateMutationQueue` and can corrupt whichever *later* test happens to be using the same `"workspace-1"` id at that moment — this is precisely the cross-test corruption class design §11.4 warns about, just triggered by tests that don't know the mechanism exists rather than by a new test forgetting to await it. First observed as a hard-to-reproduce failure in `remote forward-by-many same-parent bookmark move lands at the exact requested index (T-M3)`, ~6 tests after the actual leak (`connectWorkspace falls back from subtree recovery...`, which now legitimately self-heals — see below). Root-caused via targeted `console.error` instrumentation (temporary, removed), not by guessing. **Fix:** `resetRuntime()` (the shared `beforeEach` in `tests/projection-behavior.test.mjs`) now unconditionally drains `projectionTestHooks.settleAutoRepair("workspace-1")` and `"workspace-2"` at the very start, before any other teardown — cheap/no-op for tests with no active chain, and closes the corruption vector for every test in the file, past and future, without requiring every individual test author to know about the auto-repair layer.

One additional pre-existing test's *contract* legitimately changed by this slice, not just its fixture: `connectWorkspace falls back from subtree recovery to workspace resync before degrading` — renamed to `...and self-heals via bounded auto-repair` — because its exact fixture (ack matching `lastCursor` resets the budget, then a resync-shaped failure with a *working* second `/tree` response) is design §4.3's own worked "self-heal" trace. Its assertions were updated from "1 tree fetch, health degraded" to "2 tree fetches, health live, budget reset" to match the intentional improvement. Its original "disposition is `rebuild`" pin was preserved as a new, isolated test (`T-A3: subtree recovery's workspace fallback is dispositioned rebuild when the auto-repair budget is exhausted`) that explicitly seeds an exhausted budget so it observes the pause in isolation from the auto-repair layer's own self-heal.

## Phase D: Delivery gate

- [ ] D.1 Confirm design §14's spec-delta amendments are already reflected in the current hand-amended `specs/extension-sync-convergence/spec.md` — verify no drift before opening PRs. NOT performed by sdd-apply — recommend the orchestrator do this diff check before opening PRs, since it is a read/compare step over already-final artifacts, not implementation.
- [ ] D.2 MANDATORY, cannot be completed by sdd-apply — live manual production test required before merge to `develop` (design §13 script): (1) fresh workspace bootstraps without red dot; (2) backend down → local edit → backend back → self-heals without red dot; (3) backend stays down → red dot after exactly 2 attempts with "Rebuild required"; (4) `Personal (not synced)` content survives every automatic rebuild. Orchestrator gates the merge on this sign-off, not this task list.
