# Proposal: Quick bookmark search via global shortcut

## Intent

Finding a synced bookmark today means opening Chrome's bookmark manager or drilling the `URLises / Org / Workspace` folder tree by hand. The extension already maintains a complete, live local mirror of backend truth in `chrome.bookmarks`, so a keyboard-first search over it is pure client-side value. Goal: **press a shortcut, type, hit Enter, the bookmark opens.**

## Scope

### In Scope
1. **New `commands` entry** in `manifest.json` (`open-quick-search`, suggested `Alt+Shift+B`, default `chrome` scope), handled by `chrome.commands.onCommand` in the service worker.
2. **New surface** `extension/src/quick-search/{quick-search.html,quick-search.ts}` opened as `chrome.windows.create({type:"popup"})`, idempotent via a `QUICK_SEARCH_WINDOW_ID_KEY` session id — same pattern as create-secret.
3. **Search** through `chrome.bookmarks.search(query)`, debounced (~120 ms), capped result list, mouse **and** keyboard (↑/↓/Enter/Esc) selection.
4. **Persisted scope toggle** `quickSearchScope: "workspace" | "global"` on `ExtensionState`, written through a new `quick-search/set-scope` background message.
5. **Release packaging**: add the new `dist/quick-search/*.js` files plus `src/quick-search/quick-search.html` to `releaseAllowlist` (split across slices per design's ADR-508 ordering constraint — Slice A adds `quick-search.js`/`search-results.js`, Slice B adds `workspace-scope.js`, since `collectReleaseFiles` throws on any allowlisted-but-not-yet-built file), and add that HTML to `validateReferencedAssets`'s scan array (which today only scans popup/options — `create-secret.html` is an existing gap; fix both). Design also found the reverse gap unmitigated (see amended Risks row below) and closes it with a set-equality test.

### Out of Scope
- Backend / `admin-web` changes. Zero new manifest permissions.
- Sync engine, convergence journal, pause/repair/rebuild machinery.
- Custom ranking/fuzzy matching — Chrome's own ordering is used verbatim.
- `global`-scope shortcuts, `_execute_action` reuse, changes to the existing status popup.

## Capabilities

### New Capabilities
- `extension-quick-bookmark-search`: shortcut invocation, search surface, workspace/global scope, selection and open behavior.

### Modified Capabilities
None.

## Approach

| # | Decision | Rationale |
|---|---|---|
| D1 | Dedicated window, not `default_popup` | Toolbar popup is the status/diagnostics surface; repurposing it would clutter both |
| D2 | Membership test = `chromeId` is a key in any selected workspace's `backendIdByChromeId` | Already persisted, O(1), no `chrome.bookmarks.get` ancestor walk. Only materialized (managed) nodes are keys, so `Personal (not synced)` children are correctly excluded from `workspace` scope and visible in `global` |
| D3 | Toggle stored locally on `ExtensionState`, not `/me/preferences` | That endpoint's contract is `{uiTheme}` only; extending it means backend changes (non-goal) |
| D4 | Mutation via background message, never `updateState()` from the page | `storage.ts`'s serialization queue is per-context; two writers would clobber |
| D5 | Open with `chrome.tabs.create({url, windowId})` targeting the last focused **normal** window | A `type:"popup"` window cannot host tabs; explicit targeting avoids Chrome's ambiguous default |
| D6 | Not `Ctrl+Q` | Claimed by OS quit on Linux/macOS. Remappable at `chrome://extensions/shortcuts` |
| D7 | Pure logic split into `workspace-scope.ts` / `search-results.ts` | Matches `advanced-toggle.ts`, `content-limit.ts`, `window-geometry.ts` — unit-testable under `node --test tests/*.test.mjs` |

No framework, no new dependency — plain DOM/TS, consistent with `popup.ts` and `options.ts`.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `extension/src/quick-search/` | New | HTML + entry TS + 2 pure helper modules |
| `extension/manifest.json` | Modified | `commands` key (no `commands` key exists today, so no collision) |
| `extension/src/background/service-worker.ts` | Modified | `onCommand` listener, window open/focus, generalize `onRemoved` cleanup to both tracked window keys |
| `extension/src/background/projection.ts` | Modified | `setQuickSearchScope` |
| `extension/src/shared/{types,storage,runtime}.ts` | Modified | `quickSearchScope` field + default, window-id keys. Window size constants stay local to `service-worker.ts`, matching `popup.ts`'s existing `CREATE_SECRET_WINDOW_WIDTH/HEIGHT` split — not moved to `shared/runtime.ts` (corrected during design). |
| `extension/src/shared/ui/theme.css` | Modified | Result list / input styles |
| `extension/scripts/package.mjs` | Modified | `releaseAllowlist` + HTML reference scan |
| `extension/tests/` | New | Scope-filter and result-cap tests |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Suggested shortcut collides on some OS/user setup | Med | Chrome silently leaves it unbound; document the `chrome://extensions/shortcuts` remap path in the surface's empty state |
| New dist output omitted from `releaseAllowlist` → broken zip | Med | **Corrected during design (ADR-507):** `validateZipListing` only compares the zip against the allowlist itself, and `validateReferencedAssets` scans HTML `href`/`src` only — neither catches a module reachable solely via an ES `import` inside JS, so this mitigation as originally stated does not hold. Design instead extracts `releaseAllowlist` into its own module and adds a `dist/**/*.js` ↔ allowlist set-equality test, pinning the invariant directly rather than relying on either existing gate. |
| Bookmark created locally but not yet mapped is invisible in `workspace` scope | Low | Window is sub-second (`handleBookmarkCreated` maps on push); `global` scope always shows it |
| Estimated ~450 changed lines exceeds the 400-line review budget | **Med** | Two chained PRs: A = shortcut + window + global search + open; B = scope filter + persisted toggle |

## Rollback Plan

Per slice, additively. B: revert the toggle (surface falls back to `global`); persisted `quickSearchScope` is additive and ignored by older code. A: remove the `commands` key and the allowlist entries — no other surface reads them, and no sync-engine code is touched at any point.

## Dependencies

- Branch `feature/extension-quick-bookmark-search` off `develop` (Gitflow). No backend, migration, or release-order dependency.

## Success Criteria

- [ ] The shortcut opens the search window from any Chrome window; pressing it again focuses the existing one instead of duplicating it.
- [ ] Typing shows Chrome's matching bookmarks; Enter and click both open the selection and close the window.
- [ ] `workspace` scope shows only managed workspace bookmarks; `global` also shows personal and `Personal (not synced)` ones.
- [ ] The scope choice survives closing the window and restarting the browser.
- [ ] `npm run package` succeeds and the zip contains every new file.
- [ ] No new permission appears in the Chrome install prompt.

## Proposal question round — resolved by orchestrator

1. **Empty query behavior**: confirmed — show nothing plus a short hint. Listing recently-added bookmarks on an empty query adds a second, unrequested data path (needs its own "recent" query/sort) for a surface whose whole value is "type and go."
2. **Default scope on first run**: confirmed `workspace` — matches why this feature exists, and a new user's first experience should be the managed, curated set, not their entire personal bookmark bar mixed in.
3. **Signed-out / no-workspace state**: confirmed — surface still opens in `global` scope (Chrome's own bookmarks work regardless of this extension's session state), `workspace` visibly disabled with an explanation rather than hidden, so the toggle doesn't silently disappear.
4. **Duplicate URL already open in a tab**: confirmed — always open a new tab (D5 stands as proposed). Reusing an existing tab needs `tabs.query` by URL plus cross-window focus/activate handling for one edge case that a user can already resolve themselves (close the duplicate tab); not worth the added surface for this change.
5. **Result cap**: confirmed 50 with a "refine your search" hint — a sensible default, adjustable later if real usage shows it's wrong.
