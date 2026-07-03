# Design: Extension Missing Parent Recovery

## Technical Approach

Keep the fix extension-first and narrow to destructive cascade recovery in `extension/src/background/projection.ts`. The runtime will validate mapped nodes and expected parents before remote create/move/delete continues, prune stale subtree mappings before retry, and run a deterministic recovery ladder: subtree first, workspace second, degraded last. This refines the live-sync recovery design without broadening into generic WU5 hardening.

## Architecture Decisions

### Decision: Parent validation gates remote apply

**Choice**: `applyRemoteFolderUpsert`, `applyRemoteBookmarkUpsert`, and delete branches validate the mapped node plus expected parent Chrome node before local mutation.
**Alternatives considered**: Keep current optimistic apply and let Chrome errors trigger generic resync.
**Rationale**: Current failures show that stale parent state is known too late; validation must happen before `create*`, `moveNode`, `remove*`, or delete continuation.

### Decision: Subtree invalidation is mapping-first and bounded

**Choice**: Add mapping helpers that prune one affected backend subtree (backend IDs, Chrome IDs, exclusions only for deleted canonical descendants) before replaying or rebuilding that scope.
**Alternatives considered**: Full projection wipe; keep stale mappings until workspace resync finishes.
**Rationale**: The bug is localized to missing parent / stale mapping cascades. Subtree-first recovery limits churn and prevents stale IDs from causing repeated 404 or parent-miss loops.

### Decision: Abandon repeated local mutations after one failed recovery path

**Choice**: Local move/delete rejection handling records the failed target subtree, suppresses immediate re-emission for the invalidated nodes, and escalates to subtree recovery instead of retrying the same backend mutation.
**Alternatives considered**: Re-issue the same API mutation after each resync.
**Rationale**: The reported defect is a loop. Recovery must be idempotent and stop retrying a mutation whose Chrome context is already invalid.

## Data Flow

```text
remote/local mutation
  -> validate mapped node + expected parent
  -> if valid: apply normally
  -> if invalid: invalidate affected subtree mappings
  -> bounded subtree recovery
  -> if canonical parent restored: re-read state and continue once
  -> else workspace recovery
  -> if workspace recovery fails budget: degraded
```

Runtime sequence:
1. Derive recovery scope from event payload or rejected local mutation (`entityId`, parent backend ID, mapped Chrome ID).
2. Validate current mapping and expected parent Chrome node with `getNode/getChildren/getSubTree` before apply continues.
3. If parent or mapped node is missing/stale, prune the affected subtree mapping state immediately.
4. Mark the local mutation attempt abandoned/suppressed for that scope so `handleBookmarkMoved` / `handleBookmarkRemoved` cannot loop on the same stale IDs.
5. Run bounded subtree recovery: fetch canonical tree, rebuild only the affected parent subtree under the existing workspace root, then replay from the last trusted cursor.
6. Escalate to existing workspace resync only when subtree recovery cannot restore a canonical parent path.
7. Enter degraded state only after subtree recovery plus workspace recovery exhaust the existing silent recovery budget.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `openspec/changes/extension-missing-parent-recovery/design.md` | Create | Technical design for the cascade-recovery slice. |
| `extension/src/background/projection.ts` | Modify | Add parent validation, subtree invalidation, mutation abandonment, subtree-first recovery, and escalation sequencing. |
| `extension/src/shared/mapping.ts` | Modify | Add scoped mapping prune helpers for subtree invalidation and stale parent cleanup. |
| `extension/tests/projection-behavior.test.mjs` | Modify | Cover stale parent detection, 404 loop termination, subtree-first recovery, and degraded escalation. |
| `README.md` / `docs/roadmap.md` | Modify | Document the narrow Gitflow remediation and runtime recovery rules. |

## Interfaces / Contracts

```ts
type RecoveryScope = {
  workspaceId: string;
  entityBackendId?: string;
  parentBackendId?: string;
  mappedChromeId?: string;
  reason: "missing-parent" | "stale-mapping" | "local-404";
};

// projection.ts runtime rules
validateParent(scope) => "valid" | "recover-subtree" | "recover-workspace";
invalidateSubtreeMappings(scope): void;
recoverSubtree(scope): Promise<"restored" | "escalate">;
abandonLocalMutation(scope): void;
```

Contract rules:
- Remote apply MUST NOT continue when the expected parent Chrome node is absent.
- Local move/delete handlers MUST stop retrying the same stale mutation after recovery begins.
- Workspace recovery remains the fallback, not the first response.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Scoped mapping prune behavior | Extend `mapping.ts` tests or focused projection helper tests for subtree invalidation. |
| Integration | Remote upsert/delete with missing parent or stale child mapping | Extend `projection-behavior.test.mjs` with mocked Chrome tree + replay/tree fetch responses. |
| E2E | Delete-move cascade no longer loops and degrades only after bounded recovery | Manual Chromium repro against the local backend until broader E2E tooling exists. |

## Migration / Rollout

No data migration required. Roll out on the Gitflow follow-up branch for this extension-only remediation.

## Open Questions

- [ ] Should subtree recovery rebuild from the nearest valid managed ancestor or always from the missing parent's direct parent snapshot segment?
