# Delta for extension-sync-convergence

## MODIFIED Requirements

### Requirement: Isolation, Repair, and Diagnostics

Containment MUST be strict for all receipts, intents, callbacks, and effects. Durable create/delete behavior SHALL remain unchanged. Destructive normal resync (rematerialization via `doResyncWorkspace`) MUST NOT run inline from any of the eight automatic triggers that previously logged "automatic resync disabled" and paused — those pauses MUST instead carry `repairDisposition: "rebuild"` so the popup and the bounded auto-repair layer both see the action that can actually close the gap. Rematerialization MUST only ever run through the bounded, per-workspace-claimed, attempt-counted automatic repair layer (or the existing manual Rebuild action), and MUST NOT run while any local intent is unacknowledged. Diagnostics MUST explain pause, no-op, queued intent, cursor, and disposition without secrets.

(Previously: destructive normal resync MUST remain disabled until final repair/enablement — the pre-verification staging state superseded now that the resync-shaped triggers correctly disposition toward rebuild and rematerialization is only ever reachable through the bounded, budgeted, intent-preserving repair layer this change adds. Inline automatic resync itself remains disabled, unchanged from before.)

#### Scenario: Repair and diagnosis
- GIVEN a containment or verification failure during repair
- WHEN diagnostics are requested
- THEN only the affected workspace pauses and the reason is observable without secrets

#### Scenario: Resync-shaped pauses carry a rebuild disposition instead of resyncing inline
- GIVEN one of the eight automatic triggers (local mutation rejected, a synthetic root removed locally, a viewer exclusion applied, etc.) would previously have logged "automatic resync disabled" and paused
- WHEN the pause is persisted
- THEN no inline `doResyncWorkspace` call runs
- AND the persisted `repairDisposition` is `"rebuild"`, so the bounded auto-repair layer (or a manual Rebuild) is the only path that can close the gap

#### Scenario: Containment holds during automatic rematerialization
- GIVEN two workspaces share an organization or adjacent Chrome-ID structure
- WHEN one workspace's bounded auto-repair layer rematerializes it
- THEN it cannot affect or bypass containment for the other workspace

### Requirement: Verified Fail-Closed Sequencing

Workspace MUST checkpoint only after predecessor final-shape verification. Capacity, write, read, verification, promise, or ambiguity errors MUST cause no effect/checkpoint, pause, stop later live/replay cursor advancement, and retry the failed cursor. Replay at/below checkpoint MUST be refused. Before persisting the visible `degraded` signal, a pause MUST first attempt bounded automatic repair: a persisted per-workspace `autoRepairAttempts` counter, capped at 2, MUST increment atomically inside the same state update that decides to pause; while attempts remain, `health` MUST be `"recovering"` — never `"degraded"`, never left `"live"` — and repair MUST dispatch fire-and-forget, unawaited by `pauseWorkspace`'s caller. Every pause reason, including `captureLocalUpdateOrMove`'s direct journal pauses (`cursor-zero-read-failed`, `ambiguous-operation`, `stale-mapping`), MUST reach this same `health` signal. Only one repair chain MAY be in flight per workspace. `autoRepairAttempts` MUST reset to zero on any successful return to live/healthy. Once exhausted, the workspace MUST persist `"degraded"` with its `degradedReason` and a correct `repairDisposition`.

(Previously: pause set `degraded` immediately and unconditionally on first failure — no repair attempt, no `recovering` state, no attempt budget; `captureLocalUpdateOrMove`'s two direct journal pauses did not set `health` at all, leaving the workspace silently stuck while still reporting live. `enterRecovery`'s own give-up branch is unchanged by this requirement — it already sets `health` consistently and correctly carries no `repairDisposition`, since it never gates the journal; it is a separate, already-bounded repair layer for connectivity/reconnect failures, not a target of this consolidation.)

#### Scenario: Read failure at cursor zero
- GIVEN the node read fails while applying cursor zero
- WHEN a later live event or replay event arrives
- THEN it remains paused at zero with no later effect or advance

#### Scenario: First repair attempt shows recovering, not degraded
- GIVEN a workspace pauses with zero prior `autoRepairAttempts`
- WHEN the pause is persisted
- THEN `health` becomes `"recovering"`, not `"degraded"` or `"live"`
- AND repair dispatches without being awaited by the pause's caller

#### Scenario: Exhausted attempts degrade uniformly with a correct disposition
- GIVEN any pause reason, including `cursor-zero-read-failed`, `ambiguous-operation`, or `stale-mapping`, has attempted repair twice for the same persistent condition
- WHEN the third pause for that condition occurs
- THEN `health` becomes `"degraded"` with `degradedReason` and a correct `repairDisposition`, matching every other pause reason

#### Scenario: Success resets the budget for a later, unrelated failure
- GIVEN a workspace returns to live/healthy after automatic repair
- WHEN a later, different pause reason occurs
- THEN `autoRepairAttempts` starts again from zero for that new failure

#### Scenario: No concurrent repair chain per workspace
- GIVEN a repair chain is already in flight for a workspace, claimed synchronously in the same atomic update that decided to pause
- WHEN another pause reason occurs for that workspace before the chain settles
- THEN no second, concurrent chain is started
- AND the guard releases only once the chain fully settles — the reentrancy gap a prior discarded implementation got wrong, producing an unbounded, still-scheduling repair chain that never terminated

#### Scenario: An unacknowledged local intent vetoes automatic rebuild
- GIVEN a pause is disposed toward `"rebuild"` and the workspace holds a local intent that is not yet acknowledged by the backend
- WHEN the automatic repair layer would otherwise dispatch a rebuild
- THEN no automatic rebuild runs and the workspace degrades immediately instead
- AND the unacknowledged intent is preserved, since only a rebuild (automatic or manual) can discard it and this rule specifically prevents that from happening unattended

#### Scenario: Pause timing contract is unchanged
- GIVEN any of `pauseWorkspace`'s 9 existing callers triggers a pause
- WHEN the repair dispatch fires
- THEN the caller's return timing is unaffected, since the dispatch is fire-and-forget and not awaited
