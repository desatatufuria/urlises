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
- [ ] C.1 Add `autoRepairAttempts: number` to `ProjectionState` (types.ts:233).
- [ ] C.2 Default `autoRepairAttempts: 0` in `createProjectionState` (storage.ts:77).
- [ ] C.3 Normalize `autoRepairAttempts: projection.autoRepairAttempts ?? 0` (storage.ts:87, C11).
- [ ] C.4 Add `AutoRepairClaim` type, `autoRepairFlights` map, `MAX_AUTO_REPAIR_ATTEMPTS=2`, `createAutoRepairClaim()` (projection.ts:85-87).
- [ ] C.5 Harness: `createProjection` factory gets legacy default `autoRepairAttempts: 2` (§12.2) so existing tests keep pinning immediate-degrade.

RED before #11 (pauseWorkspace rewrite):
- [ ] C.6 T-C1 (attempt-2 regression): nested pause inside a running repair starts no 2nd chain; counter sequence `1` then `2`, never `1,1`; `autoRepairFlightCount()<=1` throughout, `0` after settle.
- [ ] C.7 T-C2: two pauses fired unawaited for one workspace start exactly one chain.
- [ ] C.8 T-C3: transient `:529` failure repairs silently, `health` never `"degraded"`.
- [ ] C.9 T-C4: newly selected workspace bootstraps itself (no fixture override — production default).
- [ ] C.10 T-C5: third consecutive failure degrades with Slice A's `repairDisposition`.
- [ ] C.11 T-C6 (§3.4 guard): budget stays monotonic across a chain through `enterRecovery` — `autoRepairAttempts===2`, not `1`.
- [ ] C.12 T-C7: durable-write failure (`storageSetFailure`) claims nothing, still throws, no dispatch.

GREEN (#11+#12, coupled by compilation):
- [ ] C.13 Rewrite `pauseWorkspace` (:2010-2022): claim+counter decided inside the atomic updater, armed dispatch `void`-ed in a `finally` after `await log(...)`; `catch` releases claim and rethrows (C6).
- [ ] C.14 Add `planAutoRepair` (pure, mirrors `retryJournal`), `runAutoRepair` (session/selection/claim-identity guards), `settleAfterAutoRepair` (re-drive or fail-closed degrade).
- [ ] C.15 Confirm T-C1-T-C7 green.

RED before #12's veto branch:
- [ ] C.16 T-C8: rebuild-shaped pause with an unacknowledged (`sent`) local intent degrades immediately on the FIRST pause, `autoRepairAttempts===0`, intent preserved, zero `/tree` fetches.

GREEN:
- [ ] C.17 Add the unacknowledged-intent veto branch to `planAutoRepair` (C7, spec.md:72). Confirm T-C8 green.

RED before #13-#15 (reset sites):
- [ ] C.18 T-C9: success resets the budget — fail once (attempts→1), heal, assert `autoRepairAttempts===0`, fail again → `recovering`, not `degraded`.

GREEN:
- [ ] C.19 Add `autoRepairAttempts = 0` reset in `markProjectionLive` (:1882), `doResyncWorkspace`'s live branch (:1079), `attemptSubtreeRecovery`'s success updater (:2278). Do NOT reset in `enterRecovery` (C3/T-C6 guard).
- [ ] C.20 Confirm T-C9 green.

Cleanup / hang-safety:
- [ ] C.21 In `resetRuntimeState` (:2483-2497, after `rebuildLocks.clear()`), release every claim then `autoRepairFlights.clear()` (inventory #16).
- [ ] C.22 Full-suite gate: `npm run test:projection` (all T-A/T-B/T-C + legacy suite) + `npm run typecheck` green; confirm process exits (no hang). Commit Slice C alone.

## Phase D: Delivery gate

- [ ] D.1 Confirm design §14's spec-delta amendments are already reflected in the current hand-amended `specs/extension-sync-convergence/spec.md` — verify no drift before opening PRs.
- [ ] D.2 MANDATORY, cannot be completed by sdd-apply — live manual production test required before merge to `develop` (design §13 script): (1) fresh workspace bootstraps without red dot; (2) backend down → local edit → backend back → self-heals without red dot; (3) backend stays down → red dot after exactly 2 attempts with "Rebuild required"; (4) `Personal (not synced)` content survives every automatic rebuild. Orchestrator gates the merge on this sign-off, not this task list.
