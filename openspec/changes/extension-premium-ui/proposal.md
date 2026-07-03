# Proposal: Extension Premium UI

## Proposal question round
- Assumption: phase 1 covers popup, options, and live-status affordances only; background sync contracts stay intact.
- Assumption: “premium” means stronger hierarchy, calmer motion, and clearer status—not decorative complexity.

## Intent
- Reposition the extension as a premium product experience by redesigning popup, options, and status touchpoints so sync state feels elegant, trustworthy, and easier to understand.

## Scope
### In Scope
- Premium visual refresh for popup, options, toolbar icon badge, and live-status surfaces.
- Dark theme, subtle motion, stronger hierarchy, and scalable design-system direction.
- Status affordances: subtle online presence, toolbar badge signaling, and blue new-activity indicator when fresh events arrive.

### Out of Scope
- Backend sync contract changes, admin/product management UI, or generic Work Unit 5 hardening.
- Expanding into full bookmark-management features beyond current extension responsibilities.

## Capabilities
### New Capabilities
- `extension-premium-ui-experience`: Theme system, reusable surface primitives, motion rules, and cross-surface status affordances for the extension UI.

### Modified Capabilities
- `extension-access-and-projection`: Popup/options experience, session/workspace summaries, and visibility of projection health/status.

## Approach
- Introduce a reusable UI foundation for color, spacing, typography, and component states across popup/options.
- Keep motion subtle and purposeful around transitions, status changes, and fresh activity.
- Extend extension state/UI contracts only as needed to expose online presence and recent-event indicators without changing core sync semantics.

## Affected Areas
| Area | Impact | Description |
|------|--------|-------------|
| `openspec/changes/extension-premium-ui/proposal.md` | New | Proposal contract for spec/design. |
| `extension/src/popup/*` | Modified | Premium popup layout, session summary, status presentation. |
| `extension/src/options/*` | Modified | Premium settings/status UX, hierarchy, diagnostics presentation. |
| `extension/src/shared/types.ts`, `extension/src/background/projection.ts` | Modified | UI-facing status state for online/new-activity affordances. |
| `README.md`, `docs/roadmap.md` | Modified | Document Gitflow intent and redesign scope. |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Visual polish obscures sync health | Med | Make status hierarchy explicit and motion secondary to clarity. |
| Redesign scope expands into full product rewrite | High | Keep first slice limited to popup/options/status surfaces and reusable foundations. |

## Rollback Plan
- Revert new UI/theme/status-layer changes to the current functional surfaces while preserving existing sync/runtime behavior and documentation accuracy.

## Dependencies
- Gitflow branch intent: `feature/extension-premium-ui`; documentation updates ship with the redesign slice.

## Success Criteria
- [ ] Popup and options feel materially more polished, readable, and cohesive across light/dark use.
- [ ] Online status and new-activity indicators communicate sync freshness without noisy alerts.
- [ ] The redesign establishes reusable UI foundations for later extension surfaces.
