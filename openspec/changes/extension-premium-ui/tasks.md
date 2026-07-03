# Tasks: Extension Premium UI

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 500-850 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 -> PR 2 -> PR 3 |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Shared theme, status helpers, UI metadata/message contract | PR 1 | Gitflow feature branch; tests/docs included |
| 2 | Premium popup surface on shared foundation | PR 2 | Base can follow PR 1; popup validation/docs included |
| 3 | Premium options/status surface and final docs | PR 3 | Base can follow PR 2; options validation/docs included |

## Phase 1: Foundation and Contracts

- [x] 1.1 Create `extension/src/shared/ui/theme.css` with reusable tokens, surface classes, dark theme, and subtle motion states for popup/options.
- [x] 1.2 Create `extension/src/shared/ui/status.ts` with pure helpers for popup and workspace status models, online tone, and unseen-activity visibility.
- [x] 1.3 Update `extension/src/shared/types.ts` with optional `activitySignal`, `lastActivityAt`, and compact UI summary fields that stay backward-compatible.
- [x] 1.4 Update `extension/src/background/projection.ts` to set online/activity metadata on connect, replay, and live apply without changing sync semantics.
- [x] 1.5 Update `extension/src/background/service-worker.ts` to accept `ui/mark-activity-seen` and clear seen state through the existing message bridge.

## Phase 2: Popup Premium Surface

- [x] 2.1 Refactor `extension/src/popup/popup.html` to remove inline-only styling and add premium sections for auth, session summary, workspace summary, status, and actions.
- [x] 2.2 Refactor `extension/src/popup/popup.ts` to render shared status models, online indicator, blue new-activity dot, and the zero-workspace empty state.
- [x] 2.3 Wire popup open/render acknowledgement in `extension/src/popup/popup.ts` using `ui/mark-activity-seen` after visible status is painted.

## Phase 3: Options Premium Surface

- [x] 3.1 Refactor `extension/src/options/options.html` into overview, degraded banner, workspace cards, diagnostics, and shared-theme hooks.
- [x] 3.2 Refactor `extension/src/options/options.ts` to render per-workspace hierarchy, online signal, new-activity cue, calm healthy cards, and explicit degraded recovery actions.
- [x] 3.3 Wire options load/render acknowledgement in `extension/src/options/options.ts` so unseen activity clears only after the premium status view is shown.
- [x] 3.4 Add toolbar icon badge signaling for unseen activity and degraded sync using existing background state.

## Phase 4: Focused Verification

- [x] 4.1 Add Node unit tests for `extension/src/shared/ui/status.ts` covering dark-surface models, online visibility, unseen-activity hide/show, and degraded emphasis rules.
- [x] 4.2 Extend `extension/tests/projection-behavior.test.mjs` for activity revision updates and `ui/mark-activity-seen` state transitions after replay/live events.
- [x] 4.2a Add focused status-helper coverage for toolbar badge precedence and clearing behavior.
- [ ] 4.3 Manual Chromium check: popup/options dark theme, readable hierarchy, calm state transitions, online dot visibility, blue indicator clear-on-open, and degraded prominence.

## Phase 5: Documentation and Boundaries

- [x] 5.1 Update `README.md` and `docs/roadmap.md` with Gitflow slice intent, premium UI scope, and manual validation notes for popup/options/status only.
- [x] 5.2 Review touched extension files to confirm no backend/admin/bookmark-management scope leaked into the redesign before implementation closes.
