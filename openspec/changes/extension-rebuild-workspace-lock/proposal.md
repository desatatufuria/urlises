# Proposal: Serialize Rebuild so managed folder identity stops churning

## Intent

Production symptom (v0.1.4 manual testing): repeated **Rebuild** clicks give the workspace folder a **new Chrome id each time**, and `Personal (not synced)` appears duplicated or freshly empty, with **no error**.

Confirmed root cause: `ensureFolderByTitle` (`chrome-bookmarks.ts:169`) is a read-then-write TOCTOU, called twice per resync by `ensureManagedPath` (`:133`). Neither `rebuildWorkspace` (`projection.ts:401`) nor `doResyncWorkspace` (`:1000`) holds a lock, unlike `drainLocalIntents` (`:463`), which already serializes via `runCoalescedWorkspaceTask(workspaceLocks, ...)`. Overlapping rebuilds both create the folder — Chrome permits duplicate-titled siblings — the last `updateProjectionState` wins, and the loser's folder plus its content is silently orphaned. `ensureLocalOnlyFolder` (`:1093`) then finds no `Personal (not synced)` under the new id and silently creates an empty one.

`doResyncWorkspace` has exactly one caller (`rebuildWorkspace`); automatic resync is disabled (`:922`), so the race is user-triggered only.

## Scope

### In Scope
- Serialize `doResyncWorkspace` per workspace inside `rebuildWorkspace` via the existing `runCoalescedWorkspaceTask` helper (generic runner, no timeout — suitable for long work).
- Use a **separate** lock map, not `workspaceLocks`. The lock stores no runner, so a rebuild arriving during a drain would be satisfied by a *drain* rerun (rebuild never happens), and vice versa. Reset it alongside `workspaceLocks` (`:2480`).
- Serialize the check-then-create sequence in `ensureManagedPath`: per-workspace locks do **not** cover two different workspaces racing on the same `ensureManagedRoot`/organization folder.
- Minimal diagnostic log in `ensureLocalOnlyFolder` when the persisted id is missing/reparented, stating whether it reused a title match or created a folder.
- Regression tests for concurrent (unawaited) rebuilds, same and cross workspace.

### Out of Scope
- Backend changes — Chrome-side folder creation has no backend involvement.
- Replacing exact-string title matching (rename-during-rebuild stays a documented residual).
- Drain-vs-rebuild mutual exclusion (status quo; separate lock domains avoid re-entrancy deadlock).
- Reconciliation redesign; the three shipped URL/index fixes.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `extension-sync-convergence`: concurrent Rebuild requests for a workspace MUST NOT produce duplicate managed folders or change workspace folder identity; an unrecognized local-only folder MUST be logged.

## Approach

Reuse the proven in-repo coalescing lock rather than inventing a primitive. Burst clicks collapse into the current run plus at most one follow-up; all callers await completion. `rebuildWorkspace` captures `doResyncWorkspace`'s boolean via closure, since the runner returns `void`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `extension/src/background/projection.ts` | Modified | Rebuild lock map; `ensureLocalOnlyFolder` diagnostic; runtime reset |
| `extension/src/background/chrome-bookmarks.ts` | Modified | Serialize `ensureManagedPath` check-then-create |
| `extension/tests/projection-behavior.test.mjs` | Modified | Concurrent-rebuild regressions |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Re-entrancy deadlock if a locked path re-enters the same key | Low | `doResyncWorkspace` never calls `drainLocalIntents`; `connectWorkspace` runs after the lock releases |
| Coalescing drops a wanted second rebuild | Low | Rerun always fires with latest reason; verified by existing coalescing test |
| Global `ensureManagedPath` lock serializes multi-workspace bootstrap | Low | Critical section is a few Chrome calls, no network |
| Orphaned duplicates from past incidents remain | Med | Fix is preventive; existing duplicates need manual cleanup — call out in release notes |

## Rollback Plan

Single revert of the branch merge. No schema, persisted-state, or backend change; locks are in-memory only.

## Dependencies

None. Gitflow: `fix/extension-rebuild-workspace-lock` off `develop`. Documentation impact: spec delta only. Size estimate: **small** (~60–120 changed lines with tests), single PR, well under the 800-line budget.

## Success Criteria

- [ ] Two concurrent rebuilds of one workspace produce one workspace folder and one stable `workspaceChromeId`.
- [ ] Concurrent rebuilds of two workspaces in one organization produce one root and one organization folder.
- [ ] Exactly one `Personal (not synced)` folder survives repeated and concurrent rebuilds.
- [ ] A local-only folder that cannot be recognized is logged before recreation.
- [ ] No backend diff.

## Proposal question round — resolved by orchestrator

1. **Burst-click UX**: coalescing (collapse to current run + at most one follow-up, every caller awaits) confirmed as the intended feel — matches the existing `drainLocalIntents` behavior users already experience, needs no new UI state.
2. **Cross-workspace `ensureManagedPath` scope**: stays in scope. Multiple workspaces per organization is the common case, not an edge case — shipping without it would leave the more likely duplicate (shared org folder) unfixed.
3. **`ensureLocalOnlyFolder` via `relocateToLocalOnly`**: stays OUT of scope for this change. It's a narrower, rarer race (a remote event landing mid-rebuild) than the one actually diagnosed and evidenced (user-triggered Rebuild bursts), and folding it in risks crossing into the drain/rebuild re-entrancy hazard this proposal deliberately avoids. Recorded as a follow-up, not silently dropped.
4. **Cleanup of existing orphaned duplicates**: out of scope — this is a preventive code fix, not a data migration. Manual cleanup (or a support-guided one-off script) is an operational matter, already called out in the Risks table.
