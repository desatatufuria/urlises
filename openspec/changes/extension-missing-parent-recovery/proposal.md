# Proposal: Extension Missing Parent Recovery

## Intent
- Fix extension runtime failures during destructive folder/bookmark delete-move cascades where stale mappings or missing parents cause repeated local `HTTP 404: not found` retries, `Can't find parent bookmark for id`, and unsafe remote apply against stale Chrome state.

## Scope
### In Scope
- Bound missing-parent and stale-mapping recovery inside extension remote apply and local rejection handling.
- Reconcile affected subtree/workspace state before continuing folder/bookmark create, move, or delete paths during churn.
- Enter degraded state only after deterministic, bounded recovery fails.

### Out of Scope
- New sync product capabilities or broad backend redesign.
- General WU5 hardening outside this destructive-cascade runtime bug.

## Capabilities
### New Capabilities
- None.

### Modified Capabilities
- `extension-access-and-projection`: tighten destructive-cascade handling so missing-parent, stale-parent, and stale-mapping situations trigger bounded subtree/workspace recovery instead of repeated unsafe local mutations.

## Approach
- Keep the remediation extension-first on a dedicated Gitflow follow-up branch.
- Detect parent/mapping invalidation before remote `folder.created`, `folder.updated`, `bookmark.created`, `bookmark.updated`, move, and delete apply continues.
- Replace noisy repeated local move/delete retries with structured recovery: prune invalid mapping state, resync the affected subtree or workspace, then degrade only if the bounded recovery budget is exhausted.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `openspec/changes/extension-missing-parent-recovery/proposal.md` | New | Formal delta proposal for the runtime bug. |
| `extension/src/background/projection.ts` | Modified | Missing-parent detection, stale-mapping cleanup, cascade recovery, degraded thresholds. |
| `extension/src/shared/mapping.ts` | Modified | Safe mapping prune/rebuild helpers for subtree invalidation. |
| `extension/tests/projection-behavior.test.mjs` | Modified | Destructive churn, 404 rejection loop, stale-parent replay/apply coverage. |
| `README.md`, `docs/roadmap.md` | Modified | Document the remediation scope and Gitflow follow-up intent. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Over-recovering causes unnecessary full resync churn | Med | Prefer subtree-scoped recovery first; bound retries before degrade. |
| Partial cleanup leaves projection inconsistent | Med | Clear invalid mappings/exclusions atomically before reapply/resync. |

## Rollback Plan
- Revert the missing-parent recovery path and restore the previous live-sync remediation behavior, keeping existing diagnostics while removing the new cascade-specific recovery logic.

## Dependencies
- Current WU4 extension runtime and the in-progress `extension-live-sync-fix` remediation branch context.

## Success Criteria
- [ ] Missing-parent situations trigger structured subtree/workspace recovery instead of noisy repeated local mutation attempts.
- [ ] The extension does not loop on repeated 404 local move/delete rejections.
- [ ] Remote apply does not continue against stale parent state.
- [ ] Degraded state is entered deterministically only after bounded recovery fails.
