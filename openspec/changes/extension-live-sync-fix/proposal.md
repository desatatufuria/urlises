# Proposal: Extension Live Sync Fix

## Intent
- Close the WU4 runtime gap where remote shared-folder/bookmark changes are eventually recovered by replay/resync but do not appear reliably in Chrome as healthy realtime live sync.

## Scope
### In Scope
- Make remote changes appear automatically in Chrome within a few seconds, without manual reload or manual resync.
- Harden live subscription/apply/runtime recovery so replay/resync stays a fallback path, not the normal visible sync path.
- Add degraded-state signaling in the extension when silent recovery cannot maintain healthy live sync.

### Out of Scope
- New product capabilities outside live-sync reliability.
- Broad backend redesign; backend changes are allowed only if strictly required to unblock reliable live delivery or degraded-state detection.

## Capabilities
### New Capabilities
- None.

### Modified Capabilities
- `extension-access-and-projection`: tighten runtime expectations for automatic remote apply, silent recovery, degraded-state indication, and duplicate-prevention in managed Chrome projection.
- `bookmark-sync-projection`: clarify that replay/resync is recovery-only during healthy operation and may support minimal runtime signals needed for reliable live delivery.

## Approach
- Start in the extension/runtime layer: inspect websocket subscription health, remote apply suppression, mapping reconciliation, and reconnect/apply sequencing.
- Preserve replay/resync as bounded recovery for gaps, stale mappings, or reconnects; do not rely on it as the steady-state user experience.
- Surface a visible degraded indicator only when silent recovery cannot restore healthy live sync promptly.

## Affected Areas
| Area | Impact | Description |
|------|--------|-------------|
| `openspec/changes/extension-live-sync-fix/proposal.md` | New | Formal WU4 remediation proposal. |
| `extension/src/background/*` | Modified | Live subscription, remote apply, reconnect, mapping, and recovery runtime. |
| `extension/src/options/*` | Modified | Degraded/live-sync diagnostics indicator if needed. |
| `backend/internal/sync/*` | Modified | Only if minimal replay/live-delivery contract adjustments are strictly required. |
| `README.md`, `docs/roadmap.md` | Modified | Document remediation scope and runtime expectations. |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Duplicate Chrome nodes appear for one canonical backend node | Med | Enforce idempotent remote apply and mapping reconciliation before create/rebuild. |
| Silent live-sync failure hides degraded runtime | Med | Add explicit degraded-state signal after bounded recovery attempts. |

## Rollback Plan
- Disable the new live-sync hardening path, keep snapshot + replay/resync recovery behavior, and retain degraded diagnostics while reverting runtime changes.

## Dependencies
- Existing WU4 branch/runtime, WebSocket connectivity, replay endpoint, and Gitflow follow-up branch intent for this remediation.

## Success Criteria
- [ ] Remote folder/bookmark changes appear in Chrome automatically within a few seconds, without manual reload or manual resync.
- [ ] Healthy live sync uses websocket/runtime apply as the normal visible path; replay/resync remains fallback recovery only.
- [ ] The extension does not create duplicate folders/bookmarks in Chrome when the backend has a single canonical node.
- [ ] Recovery avoids unauthorized loops, stale-mapping loops, and repeated self-triggered resync churn.
- [ ] When healthy live sync cannot be maintained silently, the extension shows a visible degraded-state indicator.
