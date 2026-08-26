# Tasks: Quick bookmark search via global shortcut

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Slice A ~340-375, Slice B ~230 (design.md §10) |
| 400-line budget risk | Medium (Slice A close to budget) |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 = Slice A → PR 2 = Slice B (stacked); A1/A2 fallback pre-authorized if Slice A's real diff crosses 400 at apply time (ADR-508) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending (design.md §16 recommends feature-branch-chain; orchestrator must confirm) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Shortcut, idempotent window, global search, open, packaging fix | PR 1 | `node --test extension/tests/quick-search-results.test.mjs extension/tests/release-allowlist.test.mjs` | Load unpacked, press Alt+Shift+B, verify open/focus/Enter/Esc; `npm run package` and inspect the zip | Remove `commands` key, `src/quick-search/`, and its allowlist entries — no other surface reads them |
| 2 | Workspace-scope filter, persisted toggle | PR 2 | `node --test extension/tests/quick-search-scope.test.mjs` | Toggle scope in the search window, confirm `Personal (not synced)` exclusion, restart the browser to confirm persistence | Revert toggle UI + `workspace-scope.ts` + its allowlist entry; `quickSearchScope` is additive, ignored by older code |

## Slice A (PR 1)

### Phase A1: Foundation
- [ ] A1.1 `extension/manifest.json`: add `commands.open-quick-search` (`Alt+Shift+B`, `chrome` scope)
- [ ] A1.2 `extension/src/shared/runtime.ts`: add `QUICK_SEARCH_WINDOW_ID_KEY`, `QUICK_SEARCH_TARGET_WINDOW_ID_KEY`

### Phase A2: Pure logic (TDD)
- [ ] A2.1 RED — `extension/tests/quick-search-results.test.mjs`: `capResults`, `toResultViews`, `nextHighlightIndex`, `createQuerySequencer`, `createDebouncer` (ADR-505/506)
- [ ] A2.2 GREEN — `extension/src/quick-search/search-results.ts`: implement the above, make A2.1 pass
- [ ] A2.3 RED — `extension/tests/release-allowlist.test.mjs`: `dist/**/*.js` ↔ allowlist set equality, both directions (ADR-507)
- [ ] A2.4 GREEN — `extension/scripts/release-allowlist.mjs`: extract `releaseAllowlist`, add `dist/quick-search/{quick-search,search-results}.js` + `src/quick-search/quick-search.html`; `package.mjs` imports it; make A2.3 pass

### Phase A3: Service worker + window
- [ ] A3.1 `extension/src/background/service-worker.ts`: `onCommand` listener, `openOrFocusQuickSearchWindow`, `getStoredWindowId`, `tryFocusWindow`, `resolveTabHostWindow` (ADR-501/502), local window-size constants
- [ ] A3.2 `extension/src/background/service-worker.ts`: generalize `onRemoved` cleanup to the tracked-key array

### Phase A4: Surface
- [ ] A4.1 `extension/src/quick-search/quick-search.html`: input, results `<ul>`, `aria-live` hint, remap footer
- [ ] A4.2 `extension/src/quick-search/quick-search.ts`: bootstrap, debounced search loop, render, keyboard/mouse selection, open via `tabs.create`+`windowId`, close (untested glue, §2.5)
- [ ] A4.3 `extension/src/shared/ui/theme.css`: `.ui-result-list`, `.ui-result--active`

### Phase A5: Packaging + verification
- [ ] A5.1 `extension/scripts/package.mjs`: add `quick-search.html` and `create-secret.html` to `validateReferencedAssets` scan array
- [ ] A5.2 Manual: verify open/focus/Enter/Esc and host-window-closed fallback; `npm run package`, inspect zip contents, confirm no new install-prompt permission

## Slice B (PR 2, stacked on Slice A)

### Phase B1: State (TDD)
- [ ] B1.1 `extension/src/shared/types.ts`: `QuickSearchScope` type + optional `quickSearchScope` on `ExtensionState`
- [ ] B1.2 RED — `extension/tests/quick-search-scope.test.mjs`: `collectManagedChromeIds` union+exclusion, `resolveScopeAvailability` fallback never persists, filter-before-cap, `setQuickSearchScope`/`getUiState` round-trip, legacy-state default normalization
- [ ] B1.3 GREEN — `extension/src/shared/storage.ts`: `defaultState().quickSearchScope = "workspace"`, `normalizeQuickSearchScope()`
- [ ] B1.4 GREEN — `extension/src/quick-search/workspace-scope.ts`: `collectManagedChromeIds`, `resolveScopeAvailability`, `filterByScope` (ADR-503/504)
- [ ] B1.5 GREEN — `extension/src/background/projection.ts`: `setQuickSearchScope`, shaped like `markActivitySeen`
- [ ] B1.6 GREEN — `extension/src/background/service-worker.ts`: `case "quick-search/set-scope"`; make B1.2 pass

### Phase B2: Surface + packaging
- [ ] B2.1 `extension/src/quick-search/quick-search.ts`: toggle wiring, scope filter in render pipeline, disabled-state rendering
- [ ] B2.2 `extension/src/quick-search/quick-search.html`: scope toggle markup + explanation `<p>`
- [ ] B2.3 `extension/src/shared/ui/theme.css`: toggle styling
- [ ] B2.4 `extension/scripts/release-allowlist.mjs`: add `dist/quick-search/workspace-scope.js` (ADR-508 — MUST land here, not Slice A)
- [ ] B2.5 Manual: toggle scope, confirm `Personal (not synced)` excluded in `workspace`/visible in `global`, restart browser to confirm persistence, confirm signed-out disabled state with explanation
