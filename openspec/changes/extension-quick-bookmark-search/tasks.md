# Tasks: Quick bookmark search via global shortcut

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Slice A ~340-375 (design.md §10, estimate); **actual measured at apply time: 716 additions + 48 deletions = 764 lines** (`git diff --cached --stat -- extension`), Slice B ~230 (not yet applied) |
| 400-line budget risk | **High — realized.** ADR-508's pre-authorized A1/A2 escape hatch condition ("if Slice A's real diff crosses 400 at apply time") is triggered. Apply proceeded as a single unit on the pre-existing `feature/extension-quick-bookmark-search-slice-a` branch (already branched off the tracker branch per Feature Branch Chain, per explicit orchestrator instruction at apply time) rather than retroactively splitting into A1/A2, since that branch/commit boundary was already fixed before this apply batch started. Flagged here for the orchestrator/maintainer to decide whether this PR should still be split before review. |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 = Slice A → PR 2 = Slice B (stacked); A1/A2 fallback pre-authorized if Slice A's real diff crosses 400 at apply time (ADR-508) — **triggered, see above** |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain (evidenced by branch topology: `feature/extension-quick-bookmark-search-slice-a` off tracker `feature/extension-quick-bookmark-search`, per orchestrator's explicit apply-time instruction) |

Decision needed before apply: Yes — resolved at apply time by explicit orchestrator instruction (dedicated slice-a branch, single commit); budget overage documented above for maintainer review before merge/PR.
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High (realized — see note above)

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Shortcut, idempotent window, global search, open, packaging fix | PR 1 | `node --test extension/tests/quick-search-results.test.mjs extension/tests/release-allowlist.test.mjs` | Load unpacked, press Alt+Shift+B, verify open/focus/Enter/Esc; `npm run package` and inspect the zip | Remove `commands` key, `src/quick-search/`, and its allowlist entries — no other surface reads them |
| 2 | Workspace-scope filter, persisted toggle | PR 2 | `node --test extension/tests/quick-search-scope.test.mjs` | Toggle scope in the search window, confirm `Personal (not synced)` exclusion, restart the browser to confirm persistence | Revert toggle UI + `workspace-scope.ts` + its allowlist entry; `quickSearchScope` is additive, ignored by older code |

## Slice A (PR 1)

### Phase A1: Foundation
- [x] A1.1 `extension/manifest.json`: add `commands.open-quick-search` (`Alt+Shift+B`, `chrome` scope)
- [x] A1.2 `extension/src/shared/runtime.ts`: add `QUICK_SEARCH_WINDOW_ID_KEY`, `QUICK_SEARCH_TARGET_WINDOW_ID_KEY`

### Phase A2: Pure logic (TDD)
- [x] A2.1 RED — `extension/tests/quick-search-results.test.mjs`: `capResults`, `toResultViews`, `nextHighlightIndex`, `createQuerySequencer`, `createDebouncer` (ADR-505/506)
- [x] A2.2 GREEN — `extension/src/quick-search/search-results.ts`: implement the above, make A2.1 pass
- [x] A2.3 RED — `extension/tests/release-allowlist.test.mjs`: `dist/**/*.js` ↔ allowlist set equality, both directions (ADR-507)
- [x] A2.4 GREEN — `extension/scripts/release-allowlist.mjs`: extract `releaseAllowlist`, add `dist/quick-search/{quick-search,search-results}.js` + `src/quick-search/quick-search.html`; `package.mjs` imports it; make A2.3 pass (fully green once A4.2 emits `dist/quick-search/quick-search.js`)

### Phase A3: Service worker + window
- [x] A3.1 `extension/src/background/service-worker.ts`: `onCommand` listener, `openOrFocusQuickSearchWindow`, `getStoredWindowId`, `tryFocusWindow`, `resolveTabHostWindow` (ADR-501/502), local window-size constants
- [x] A3.2 `extension/src/background/service-worker.ts`: generalize `onRemoved` cleanup to the tracked-key array

### Phase A4: Surface
- [x] A4.1 `extension/src/quick-search/quick-search.html`: input, results `<ul>`, `aria-live` hint, remap footer
- [x] A4.2 `extension/src/quick-search/quick-search.ts`: bootstrap, debounced search loop, render, keyboard/mouse selection, open via `tabs.create`+`windowId`, close (untested glue, §2.5)
- [x] A4.3 `extension/src/shared/ui/theme.css`: `.ui-result-list`, `.ui-result--active`

### Phase A5: Packaging + verification
- [x] A5.1 `extension/scripts/package.mjs`: add `quick-search.html` and `create-secret.html` to `validateReferencedAssets` scan array
- [x] A5.2 Manual (automated portion): `npm run package` succeeds end to end; zip inspected — contains `dist/quick-search/quick-search.js`, `dist/quick-search/search-results.js`, `src/quick-search/quick-search.html`; manifest `permissions` unchanged (`["bookmarks","storage"]`), `commands.open-quick-search` present. Interactive Chrome-load verification (shortcut open/focus/Enter/Esc, host-window-closed fallback) requires a real browser session and is deferred to manual QA — not runnable in this sandboxed environment.

## Slice B (PR 2, stacked on Slice A)

### Phase B1: State (TDD)
- [x] B1.1 `extension/src/shared/types.ts`: `QuickSearchScope` type + optional `quickSearchScope` on `ExtensionState`
- [x] B1.2 RED — `extension/tests/quick-search-scope.test.mjs`: `collectManagedChromeIds` union+exclusion, `resolveScopeAvailability` fallback never persists, filter-before-cap, `setQuickSearchScope`/`getUiState` round-trip, legacy-state default normalization
- [x] B1.3 GREEN — `extension/src/shared/storage.ts`: `defaultState().quickSearchScope = "workspace"`, `normalizeQuickSearchScope()`
- [x] B1.4 GREEN — `extension/src/quick-search/workspace-scope.ts`: `collectManagedChromeIds`, `resolveScopeAvailability`, `filterByScope` (ADR-503/504)
- [x] B1.5 GREEN — `extension/src/background/projection.ts`: `setQuickSearchScope`, shaped like `markActivitySeen`
- [x] B1.6 GREEN — `extension/src/background/service-worker.ts`: `case "quick-search/set-scope"`; make B1.2 pass

### Phase B2: Surface + packaging
- [x] B2.1 `extension/src/quick-search/quick-search.ts`: toggle wiring, scope filter in render pipeline, disabled-state rendering
- [x] B2.2 `extension/src/quick-search/quick-search.html`: scope toggle markup + explanation `<p>`
- [x] B2.3 `extension/src/shared/ui/theme.css`: toggle styling
- [x] B2.4 `extension/scripts/release-allowlist.mjs`: add `dist/quick-search/workspace-scope.js` (ADR-508 — MUST land here, not Slice A)
- [x] B2.5 Manual (automated portion): `npm run package` succeeded end to end; zip inspected — contains `dist/quick-search/workspace-scope.js`; manifest `permissions` unchanged (`["bookmarks","storage"]`). Interactive Chrome-load verification (toggle scope, `Personal (not synced)` exclusion, browser-restart persistence, signed-out disabled state) requires a real browser session and is deferred to manual QA — not runnable in this sandboxed environment.
