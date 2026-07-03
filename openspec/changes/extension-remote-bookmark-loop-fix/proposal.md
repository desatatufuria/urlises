# Proposal: Extension Remote Bookmark Loop Fix

## Intent
- Fix the extension runtime bug where remote `bookmark.updated` / move apply in Chrome is re-emitted through local `onChanged` / `onMoved` listeners, sent back to the backend, and amplified into loop/churn/deadlock behavior.

## Scope
### In Scope
- Guard remote bookmark update/move apply so equivalent Chrome events are treated as remote side effects, not fresh local mutations.
- Keep Chrome bookmark order visually stable during replay/live remote reorder apply.
- Bound replay/live recovery so repeated local rejection loops do not continue after remote apply starts.

### Out of Scope
- Reworking the broader live-sync architecture or replacing replay/websocket contracts.
- General missing-parent recovery, non-bookmark entities, or Work Unit 5 hardening beyond this loop bug.

## Capabilities
### New Capabilities
- `extension-access-and-projection`: extension projection MUST suppress remote bookmark update/move feedback loops while preserving backend-authoritative ordering.

### Modified Capabilities
- None.

## Approach
- Keep the remediation extension-first on the current Gitflow follow-up branch chain.
- Harden `extension/src/background/projection.ts` remote apply and local listener coordination so Chrome events caused by `update`/`move` are correlated/suppressed beyond the current best-effort timing window.
- Add focused runtime tests for replay/live `bookmark.updated` and move apply, loop prevention, reorder stability, and degrade-only-on-true-failure behavior.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `openspec/changes/extension-remote-bookmark-loop-fix/proposal.md` | New | Formal remediation proposal. |
| `extension/src/background/projection.ts` | Modified | Remote apply suppression, loop guard, bounded recovery/degrade path. |
| `extension/src/background/bookmark-listeners.ts` | Modified | Listener/runtime coordination for remote-vs-local mutation handling. |
| `extension/tests/projection-behavior.test.mjs` | Modified | Remote update/move loop and reorder stability coverage. |
| `README.md`, `docs/roadmap.md` | Modified | Document the remediation scope and Gitflow follow-up intent. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Suppression hides a real local edit near remote apply timing | Med | Correlate by mapped node + operation context, not broad listener disable. |
| Reorder drift remains visible even when loop is stopped | Med | Assert final parent/index stability after remote move/update apply. |

## Rollback Plan
- Revert the remote bookmark loop guard and restore the current live-sync/missing-parent runtime behavior while keeping existing diagnostics.

## Dependencies
- Current WU4 extension runtime branch context, plus the prior `extension-live-sync-fix` and `extension-missing-parent-recovery` remediations.

## Success Criteria
- [ ] Remote bookmark update/move apply does not trigger an equivalent local mutation back to the backend.
- [ ] Remote reorder remains visually stable in Chrome after replay/live apply.
- [ ] Replay/live remote apply no longer causes repeated 404/deadlock loop churn.
- [ ] The extension degrades only on true unrecoverable runtime failure.
