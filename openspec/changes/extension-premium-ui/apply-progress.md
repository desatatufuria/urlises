# Apply Progress: Extension Premium UI

## Mode

Standard

## Completed Tasks

- [x] 1.1 Create `extension/src/shared/ui/theme.css` with reusable tokens, surface classes, dark theme, and subtle motion states for popup/options.
- [x] 1.2 Create `extension/src/shared/ui/status.ts` with pure helpers for popup and workspace status models, online tone, and unseen-activity visibility.
- [x] 1.3 Update `extension/src/shared/types.ts` with optional `activitySignal`, `lastActivityAt`, and compact UI summary fields that stay backward-compatible.
- [x] 1.4 Update `extension/src/background/projection.ts` to set online/activity metadata on connect, replay, and live apply without changing sync semantics.
- [x] 1.5 Update `extension/src/background/service-worker.ts` to accept `ui/mark-activity-seen` and clear seen state through the existing message bridge.
- [x] 2.1 Refactor `extension/src/popup/popup.html` to remove inline-only styling and add premium sections for auth, session summary, workspace summary, status, and actions.
- [x] 2.2 Refactor `extension/src/popup/popup.ts` to render shared status models, online indicator, blue new-activity dot, and the zero-workspace empty state.
- [x] 2.3 Wire popup open/render acknowledgement in `extension/src/popup/popup.ts` using `ui/mark-activity-seen` after visible status is painted.
- [x] 3.1 Refactor `extension/src/options/options.html` into overview, degraded banner, workspace cards, diagnostics, and shared-theme hooks.
- [x] 3.2 Refactor `extension/src/options/options.ts` to render per-workspace hierarchy, online signal, new-activity cue, calm healthy cards, and explicit degraded recovery actions.
- [x] 3.3 Wire options load/render acknowledgement in `extension/src/options/options.ts` so unseen activity clears only after the premium status view is shown.
- [x] 3.4 Add toolbar icon badge signaling for unseen activity and degraded sync using existing background state.
- [x] 4.1 Add Node unit tests for `extension/src/shared/ui/status.ts` covering dark-surface models, online visibility, unseen-activity hide/show, and degraded emphasis rules.
- [x] 4.2 Extend `extension/tests/projection-behavior.test.mjs` for activity revision updates and `ui/mark-activity-seen` state transitions after replay/live events.
- [x] 4.2a Add focused status-helper coverage for toolbar badge precedence and clearing behavior.
- [x] 5.1 Update `README.md` and `docs/roadmap.md` with Gitflow slice intent, premium UI scope, and manual validation notes for popup/options/status only.
- [x] 5.2 Review touched extension files to confirm no backend/admin/bookmark-management scope leaked into the redesign before implementation closes.

## Remaining Tasks

- [ ] 4.3 Manual Chromium check: popup/options dark theme, readable hierarchy, calm state transitions, online dot visibility, blue indicator clear-on-open, and degraded prominence.

## Verification

| Check | Result |
|------|--------|
| `npm run build` | ✅ Pass |
| `npm run typecheck` | ✅ Pass |
| `npm run test:projection` | ✅ Pass (39 tests) |
| Manual Chromium premium UI check | ⏳ Not run in this apply batch |

## Latest Apply Notes

- Refined popup/options copy to remove marketing-heavy wording and keep labels shorter and more operational.
- Shifted the shared theme toward a Kanagawa-inspired palette with quieter contrast, softer accent blues, and muted warning/danger tones.
- Reformatted UI-visible timestamps to `Europe/Madrid` with automatic CET/CEST handling.
- Reworked diagnostics into a monospace log surface and added a bookmark-plus-sync extension icon set wired through `manifest.json`.
- Added workspace-level recent-activity summaries so popup/options can show which workspace changed, what folder/bookmark changed, and clear novelty once that status view is rendered.

## Files Changed

- `extension/src/shared/ui/theme.css`
- `extension/src/shared/ui/status.ts`
- `extension/src/shared/types.ts`
- `extension/src/shared/storage.ts`
- `extension/src/background/projection.ts`
- `extension/src/background/service-worker.ts`
- `extension/src/popup/popup.html`
- `extension/src/popup/popup.ts`
- `extension/src/options/options.html`
- `extension/src/options/options.ts`
- `extension/icons/icon-16.png`
- `extension/icons/icon-32.png`
- `extension/icons/icon-48.png`
- `extension/icons/icon-128.png`
- `extension/icons/icon-source.svg`
- `extension/tests/status-ui.test.mjs`
- `extension/tests/projection-behavior.test.mjs`
- `openspec/changes/extension-premium-ui/apply-progress.md`

## Workload / PR Boundary

- Mode: size:exception single PR
- Boundary: complete popup + options + status-surface redesign on `feature/extension-premium-ui`
- Review note: backend/admin scope remained untouched; remaining risk is manual UI validation only
