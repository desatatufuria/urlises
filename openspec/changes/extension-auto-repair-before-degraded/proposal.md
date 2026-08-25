# Proposal: Auto-repair before showing the degraded state

## Intent

Any sync failure flips `ProjectionState.health` to `"degraded"` immediately (red dot, manual Retry/Rebuild). Most causes are transient. Users must self-diagnose failures the extension could heal itself. Goal: **2 silent auto-repair attempts for every pause cause before the user ever sees red.**

## Scope

### In Scope
1. **Slice A — re-enable resync**: restore `resyncWorkspace` to `runCoalescedWorkspaceTask(... doResyncWorkspace)` (stubbed by `f6daffc`, which shipped receipt verification and disabled healing during rollout; spec text "MUST remain disabled **until final repair/enablement**" confirms staged intent). Prerequisite: 8 call sites otherwise fail by construction.
2. **Slice B — one degrade path**: route `enterRecovery`'s give-up branch and `captureLocalUpdateOrMove`'s two direct journal pauses through `pauseWorkspace`.
3. **Slice C — bounded auto-repair**: persisted `autoRepairAttempts` on `ProjectionState`, capped at 2, plus in-flight guard and fire-and-forget dispatch.

### Out of Scope
- Backend / `admin-web` changes (extension-only).
- Reconciliation-model redesign; `MAX_SILENT_RECOVERY_ATTEMPTS` semantics.
- The four shipped fixes (`canonicalUrlForComparison`, `sameUrl`, `chromeMoveIndex`, `rebuildLocks`, `managedPathQueue`) — untouched; this adds a layer above the pause decision.
- User-configurable attempt count; repair telemetry/UI beyond existing labels.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `extension-sync-convergence`: *Isolation, Repair, and Diagnostics* (resync enabled under verified receipts); *Verified Fail-Closed Sequencing* (pause MUST attempt bounded silent repair before degrading; every pause reason MUST reach the degraded signal).

## Approach

Exploration Approach 1, confirmed. `pauseWorkspace` is the single choke point. Inside the same atomic `updateProjectionState` updater that decides to pause: read `autoRepairAttempts`; if `< 2`, increment, **claim the per-workspace `autoRepairFlights` entry synchronously in that same updater** (no `await` between decide and claim — this is what killed the prior attempt), keep `health` non-degraded, and dispatch the repair fire-and-forget. If `>= 2` or already claimed, persist `degraded` as today.

Key decisions:

| # | Decision | Rationale |
|---|---|---|
| D1 | Counter on `ProjectionState`, never a bare Map | `recoveryAttemptCount` proves the pattern; `updateState` serializes |
| D2 | Reset at the 3 existing reset sites (`markProjectionLive`, `doResyncWorkspace` success, `attemptSubtreeRecovery` success) | Reuses proven success signal |
| D3 | Guard released once in a `finally` after the whole chain settles (live, exhausted, or thrown) — never mid-chain | Downstream pauses inside a repair persist state but never re-dispatch |
| D4 | Dispatch stays **fire-and-forget** (settled decision, carried forward) | Blocking changed `pauseWorkspace` timing and broke 18 tests |
| D5 | `captureLocalUpdateOrMove` gap is **IN scope, required** | 2 pause reasons never reach degraded today, so auto-repair cannot intercept them; "every pause cause" is false without it |
| D6 | Slice A is a **separate reviewable commit with its own tests** | 8-call-site behavior change + spec-level change, independent of auto-repair; must not hide inside its diff |

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `extension/src/background/projection.ts` | Modified | `pauseWorkspace`, `enterRecovery`, `resyncWorkspace`, `recoverWorkspace`, `captureLocalUpdateOrMove`, `autoRepairFlights` |
| `extension/src/shared/types.ts` | Modified | `autoRepairAttempts` on `ProjectionState` (default 0 for existing persisted state) |
| `extension/src/shared/ui/status.ts` | Modified | give-up path now carries `repairDisposition` |
| `extension/tests/projection-behavior.test.mjs` | Modified | 18-test regression surface is a floor |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Re-enabled resync reintroduces the issue it was disabled for | Med | Slice A lands alone with its own tests; independently revertable |
| Reentrancy loop / suite hang recurs | Med | Synchronous claim in the atomic updater; guard asserted by a dedicated test before Slice C's dispatch is wired |
| Users see red where they saw (stuck) green | Med | Intended: exposes a silently stuck workspace; called out in spec delta |
| Repair masks a real verification bug | Low | Attempts logged; degraded reason preserved after exhaustion |
| Size exceeds the 400-line review budget | **High** | 3 chained PRs (A → B → C) |

## Rollback Plan

Per slice. C: revert the dispatch call (counter becomes inert). B: restore the two direct degrade paths. A: restore the stub one-liner. Persisted `autoRepairAttempts` is additive and ignored by older code.

## Dependencies

- Slice A precedes C. Branch `feature/extension-auto-repair-on-pause` off `develop` (Gitflow).

## Success Criteria

- [ ] Every pause cause, including `captureLocalUpdateOrMove`'s three reasons, attempts repair at most twice before degrading.
- [ ] Third consecutive failure degrades with a correct `repairDisposition`.
- [ ] Success resets the counter; a later failure gets a fresh budget of 2.
- [ ] No concurrent auto-repair chain per workspace; full suite completes without hanging.
- [ ] `pauseWorkspace` timing contract unchanged for its 9 existing callers.

## Proposal question round — resolved by orchestrator

1. **UI state during silent attempts**: `health: "recovering"` — this state already exists, is already visually distinct from both `"live"` and `"degraded"` in the popup/options UI (confirmed during exploration: its own card style and text, and it does not count toward the "needs attention" red-dot signal), and is exactly what `enterRecovery` already uses for its own bounded-retry window. Reusing it is a zero-new-UI-surface decision, not a "stay fully green" one — the user should be able to tell something is actively happening if they open the popup during the two attempts, just not be interrupted by it.
2. **Per-cause vs per-workspace budget**: per-workspace, reset on any return to live — confirmed as the correct choice, not just the "current assumption." Per-cause budgets would let one specific, genuinely unfixable pause reason get an unbounded stream of fresh 2-attempt budgets forever (a slow-motion version of the exact infinite-retry risk this whole design exists to avoid); per-workspace correctly treats "still broken after 2 tries" as a signal to stop and ask a human, regardless of whether the next failure happens to carry a different reason string.
3. **Slice A stays part of this change's chain, not a separate OpenSpec change**: it is a hard, non-optional prerequisite (the other slices cannot function without it) and the three slices together answer one coherent user request. Matches this session's established pattern for multi-unit changes (stacked branches within one tracked change, each independently committed/tested/reviewable) rather than splintering into unrelated changes. Its own-commit-with-own-tests requirement (D6) already gives it the independent reviewability that mattered about keeping it separate.
