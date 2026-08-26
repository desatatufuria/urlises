# Delta for extension-quick-bookmark-search

## ADDED Requirements

### Requirement: Shortcut Invocation and Idempotent Window

The system MUST register a `commands` entry (`open-quick-search`) that opens a dedicated popup-type search window. If that window is already open, the system MUST focus it instead of creating a duplicate.

#### Scenario: First invocation opens the window
- GIVEN no quick-search window is open
- WHEN the user triggers the shortcut
- THEN a new popup-type search window opens and gets focus

#### Scenario: Repeated invocation focuses instead of duplicating
- GIVEN the quick-search window is already open
- WHEN the user triggers the shortcut again
- THEN the existing window is focused and no second window is created

### Requirement: Search Behavior

The system MUST search `chrome.bookmarks` as the user types, debounced by ~120ms. An empty query MUST show no results plus a short hint, never a default/recent listing. Results MUST be capped at 50; when matches exceed the cap, a "refine your search" hint MUST be shown.

#### Scenario: Typing shows matching results
- GIVEN the search window is open
- WHEN the user types a query
- THEN after the debounce interval, matching bookmarks from the active scope are shown

#### Scenario: Empty query shows a hint, not a default list
- GIVEN the search input is empty
- WHEN no query has been entered
- THEN no results are shown and a short hint prompts the user to type

#### Scenario: Result cap surfaces a refine hint
- GIVEN a query matches more than 50 bookmarks in the active scope
- WHEN results are rendered
- THEN at most 50 results are shown and a "refine your search" hint is displayed

### Requirement: Keyboard and Mouse Selection

The system MUST support ↑/↓ to move the highlight, Enter to open the highlighted result, and Esc to close the window without opening anything. A mouse click on a result MUST behave identically to keyboard-select-then-Enter. Opening a result via either method MUST close the window.

#### Scenario: Keyboard and mouse selection both open and close
- GIVEN a results list is displayed
- WHEN the user either presses ↓ then Enter, or clicks a result
- THEN the selected bookmark opens and the search window closes

#### Scenario: Escape closes without opening
- GIVEN the search window is open, with or without results
- WHEN the user presses Esc
- THEN the window closes and no bookmark is opened

### Requirement: Persisted Workspace/Global Scope Toggle

The system MUST persist `quickSearchScope` (`"workspace"` | `"global"`) on `ExtensionState`, mutated only through a background message, never a direct page-side write. Default MUST be `"workspace"` on first run, and the choice MUST survive closing the window and restarting the browser. When signed out or with no workspace, `workspace` scope MUST be visibly disabled with an explanation, and the surface MUST still work in `global` scope.

#### Scenario: Default scope on first run, persisted across restart
- GIVEN no scope preference has ever been set
- WHEN the search window opens for the first time, the user switches to `global`, and the browser later restarts
- THEN the initial scope was `workspace` and the scope after restart is `global`

#### Scenario: Signed-out state disables workspace scope with explanation
- GIVEN the user is signed out or has no workspace
- WHEN the search window opens
- THEN `workspace` scope is shown disabled with an explanation, and `global` scope remains usable

### Requirement: Workspace-Scope Membership via backendIdByChromeId

When scope is `workspace`, the system MUST include only bookmarks whose `chromeId` is a key in the selected workspace's `backendIdByChromeId` map. `Personal (not synced)` nodes are not materialized and MUST NOT be keys in that map, so they MUST be excluded from `workspace` scope and visible in `global` scope.

#### Scenario: Personal (not synced) node excluded from workspace, visible in global
- GIVEN a bookmark under `Personal (not synced)` whose `chromeId` is not a key in any workspace's `backendIdByChromeId`
- WHEN scope is `workspace`
- THEN that bookmark is excluded from results, and WHEN scope is `global` it is included

### Requirement: Opening a Selection Always Targets a New Tab

Opening a selected bookmark MUST use `chrome.tabs.create` targeting the last focused normal window, regardless of whether the URL is already open elsewhere.

#### Scenario: Selection opens in a new tab even if a duplicate exists
- GIVEN a bookmark's URL is already open in another tab
- WHEN the user selects that bookmark
- THEN a new tab opens with that URL in the last focused normal window, and the duplicate tab is left untouched

### Requirement: Release Packaging Includes Quick-Search Assets

`releaseAllowlist` MUST include the built quick-search dist files and `src/quick-search/quick-search.html`. `validateReferencedAssets`'s HTML scan array MUST include `quick-search.html` and the pre-existing gap `create-secret.html`, so packaging fails closed when an HTML-referenced asset is missing from disk. Separately, since `validateReferencedAssets`'s HTML scan is not transitive over ES `import` statements inside JS modules, the set of emitted `dist/**/*.js` files MUST be independently verified to equal exactly the `dist/…` entries in `releaseAllowlist`, so a helper module reachable only via `import` (not `href`/`src`) cannot silently ship omitted from the allowlist.

#### Scenario: Packaging fails closed on a missing referenced asset
- GIVEN `quick-search.html` or `create-secret.html` references an asset missing from disk
- WHEN `validateReferencedAssets` runs during packaging
- THEN packaging fails instead of producing an incomplete zip

#### Scenario: A module omitted from the allowlist is caught even without an HTML reference
- GIVEN a built `dist/quick-search/*.js` module exists on disk but is absent from `releaseAllowlist`
- WHEN the allowlist-coverage check runs
- THEN it fails instead of silently producing a zip that is broken only at runtime on install
