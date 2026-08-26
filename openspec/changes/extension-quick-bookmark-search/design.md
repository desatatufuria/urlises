# Design: extension-quick-bookmark-search

A keyboard-first search surface over the bookmark mirror the extension already maintains. **Two
chained slices**, all inside `extension/`: **Slice A** = `commands` entry + service-worker-owned
idempotent window + global `chrome.bookmarks.search` + open-in-new-tab + release packaging;
**Slice B** = workspace-scope membership filter + persisted `quickSearchScope` toggle. No backend
change, no `admin-web` change, no new permission, no sync-engine change, no migration.

Everything below is written against the **current on-disk tree of `develop`** (commit `9f34003`).
**Every line number was re-read from disk while writing this document**; they are *pre-change* so
`sdd-tasks` can slice directly. Where this design departs from `proposal.md`, it says so as an
explicit ADR with the evidence, following the precedent set by ADR-404/ADR-405 in
`openspec/changes/extension-auto-repair-before-degraded/design.md`.

---

## 1. Constraints this design is bound by

| # | Constraint | Source (verified) | How the design satisfies it |
|---|---|---|---|
| C1 | The search window must be openable from a context with **no DOM** — the service worker — not from a page like `create-secret` is. | `chrome.commands.onCommand` only fires in the background; `popup.ts:73-112` runs in the popup. | ADR-501: the open/focus/self-heal trio is *generalized* into `service-worker.ts`, keeping `popup.ts`'s exact shape (stored id → `windows.update` → catch → create). |
| C2 | `chrome.tabs.create` MUST target a **normal** window; a `type:"popup"` window cannot host tabs, and while the search window is focused it *is* the last-focused window. | `popup.ts:104` creates `type:"popup"`; D5. | ADR-502: the tab host is resolved and stored **at shortcut-invocation time**, before the popup steals focus. |
| C3 | `ExtensionState` MUST NOT be written from the search page. | `storage.ts:5` — `stateMutationQueue` is a **module-level** variable, so each context has its own queue; `storage.ts:49-56` is a read-modify-write of one storage key. | §4: `quick-search/set-scope` background message; the page never imports `updateState`. Proof in §4.1. |
| C4 | Workspace-scope membership MUST be O(1) per result and MUST exclude `Personal (not synced)`. | `mapping.ts:3-13`; the 8 `setMapping` call sites (`projection.ts:611,627,1187,1207,1390,1498,2477,2505`); `ensureLocalOnlyFolder` (`projection.ts:1127-1157`) never calls `setMapping`. | ADR-503, with the full evidence trail. |
| C5 | Packaging MUST fail closed when a new `dist/quick-search/*.js` is missing from `releaseAllowlist`. | **It currently does not** — see ADR-507. | ADR-507: extract the allowlist into an importable module and pin the already-true `src ↔ allowlist` 1:1 invariant with a test. |
| C6 | No new install-prompt permission. | `manifest.json:6` = `["bookmarks","storage"]`. `commands`, `chrome.windows.*`, `chrome.tabs.create` and `chrome.storage.session` all require none; only *reading* tab URL/title needs `"tabs"`, which this design never does. | §3, §5: only `id`/`type` are read from windows. |
| C7 | Each slice MUST be independently reviewable, revertable and under the 400-line budget. | `_shared/sdd-phase-common.md` §E. | ADR-508, including one hard ordering constraint the proposal does not mention. |

---

## 2. What the current code actually does (verified, not assumed)

### 2.1 The idempotent-window precedent, and why it must move

```ts
// extension/src/popup/popup.ts:73-79  (CURRENT)
async function openOrFocusCreateSecretWindow(): Promise<void> {
  const stored = await getStoredCreateSecretWindowId();          // chrome.storage.session
  if (stored !== undefined && (await tryFocusWindow(stored))) return;   // windows.update, catch → false
  await createCreateSecretWindow();                              // windows.create({type:"popup"}) + session.set
}
```

Three properties, all load-bearing and all preserved by ADR-501:

1. **Session-scoped tracking.** `chrome.storage.session` (`runtime.ts:21`) survives a service-worker
   eviction but not a browser restart — exactly the lifetime of a window id.
2. **Self-healing.** `tryFocusWindow` (`popup.ts:87-94`) treats a rejected `windows.update` as "the
   id is stale", which is correct even if the `onRemoved` listener never ran because the worker was
   asleep. `popup.ts:65-72` documents this explicitly.
3. **Centering is already pure.** `computeCenteredWindowPosition` (`window-geometry.ts:35-47`)
   returns `{}` when any bound is `undefined`, so the caller safely omits `left`/`top`. It is
   context-agnostic and reused verbatim from the worker.

### 2.2 The `onRemoved` cleanup, which is currently single-key

```ts
// extension/src/background/service-worker.ts:47-53  (CURRENT)
chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get<Record<string, unknown>>(CREATE_SECRET_WINDOW_ID_KEY).then((result) => {
    if (result[CREATE_SECRET_WINDOW_ID_KEY] === windowId) return chrome.storage.session.remove(CREATE_SECRET_WINDOW_ID_KEY);
  });
});
```

`chrome.storage.session.get`/`remove` both accept a `string[]`, so this generalizes to N tracked keys
without a second listener (§3.3).

### 2.3 `backendIdByChromeId` — exactly which chrome ids are keys

`setMapping` (`mapping.ts:3-13`) is the **only** writer of `backendIdByChromeId`, and it is called
from exactly eight sites, every one of them handling a node that has a backend id:
`projection.ts:611` / `:627` (local create acknowledged by the backend), `:1187` / `:1207`
(`materializeFolder` / bookmark materialization), `:1390` / `:1498` (remote folder/bookmark upsert),
`:2477` / `:2505` (subtree-recovery reuse).

Therefore the key set is **precisely the materialized, backend-managed nodes**, and it excludes:

- the `URLises` / organization / workspace shell folders (`rootChromeId`, `organizationChromeId`,
  `workspaceChromeId` are stored as scalars, never mapped);
- `Personal (not synced)` — `ensureLocalOnlyFolder` (`projection.ts:1127-1157`) stores its id only
  in `projection.localOnlyChromeId` (`:1154-1156`) and calls no `setMapping`;
- everything the user puts **inside** `Personal (not synced)` — that folder is passed as the
  exclusion list to `clearManagedChildrenWithSuppression` (`projection.ts:1075`, `:2380`), i.e. the
  sync engine deliberately never touches or maps its children.

**D2 is confirmed on evidence, not assumed.** Membership is `chromeId in backendIdByChromeId`.

### 2.4 The state a page can already see

`buildUiState` (`projection.ts:986-999`) returns the **entire** `ExtensionState` (only
`session.accessToken` is blanked at `:993`), including every projection's full
`backendIdByChromeId`. `popup.ts` already pays that cost on every open via `session/get`. So the
search page needs **no new message** to compute scope membership — one `session/get` at bootstrap,
the same call `create-secret.ts:103` makes.

### 2.5 The pure-module / DOM-glue coverage boundary

`create-secret.ts:6-10` states this repo's rule verbatim: entry files' DOM and `chrome.*` glue is not
unit tested; the pure logic they depend on is. `content-limit.ts`, `recipient-filter.ts`,
`advanced-toggle.ts`, `status-detail.ts`, `window-geometry.ts` are the existing instances, each with
a `tests/*.test.mjs` importing from `dist/`. D7 follows that rule; §7 keeps it.

---

## 3. ADR-501 — The search window is owned by the service worker

**Decision.** `openOrFocusQuickSearchWindow()` lives in `service-worker.ts`, not in a page, and is
driven by a top-level `chrome.commands.onCommand` listener.

```ts
// extension/src/background/service-worker.ts — new, next to the existing window bookkeeping
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-quick-search") return;
  void openOrFocusQuickSearchWindow().catch(() => undefined);
});

async function openOrFocusQuickSearchWindow(): Promise<void> {
  const host = await resolveTabHostWindow();                                   // ADR-502
  if (host?.id !== undefined) await chrome.storage.session.set({ [QUICK_SEARCH_TARGET_WINDOW_ID_KEY]: host.id });

  const stored = await getStoredWindowId(QUICK_SEARCH_WINDOW_ID_KEY);
  if (stored !== undefined && (await tryFocusWindow(stored))) return;          // same self-heal as popup.ts:87-94

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("src/quick-search/quick-search.html"),
    type: "popup",
    width: QUICK_SEARCH_WINDOW_WIDTH,
    height: QUICK_SEARCH_WINDOW_HEIGHT,
    focused: true,
    ...computeCenteredWindowPosition(host ?? {}, { width: QUICK_SEARCH_WINDOW_WIDTH, height: QUICK_SEARCH_WINDOW_HEIGHT }),
  });
  if (created?.id !== undefined) await chrome.storage.session.set({ [QUICK_SEARCH_WINDOW_ID_KEY]: created.id });
}
```

`getStoredWindowId(key)` and `tryFocusWindow(id)` are the `popup.ts:81-94` bodies, parameterized by
key. The listener is registered **synchronously at top level** so an evicted MV3 worker is woken and
still receives the command.

**Rejected alternatives.**

- *Duplicate `popup.ts`'s helpers into the page and have the page open itself.* Impossible: the
  command event is only delivered to the background.
- *Reuse `_execute_action` to open the toolbar popup.* Out of scope by `proposal.md:20`, and D1
  already rejects overloading the status surface.
- *Extract the open/focus helpers into `shared/` and refactor `popup.ts` to use them.* Rejected for
  this change: it would put a behavior-preserving refactor of a shipped, working surface inside a
  feature slice, inflating the diff and the blast radius for zero user value. The duplication is
  ~14 lines of `chrome.*` glue that the repo already treats as untested glue (§2.5). Recorded as a
  follow-up, not silently ignored.

---

## 4. ADR-502 — The tab host is captured at invocation, not at open-time

**Decision.** The service worker resolves the *last focused normal window* the instant the shortcut
fires and stores its id in `chrome.storage.session` under `QUICK_SEARCH_TARGET_WINDOW_ID_KEY`. The
page reads that id when the user picks a result.

```ts
async function resolveTabHostWindow(): Promise<chrome.windows.Window | undefined> {
  try {
    const candidate = await chrome.windows.getLastFocused();
    return candidate.type === "normal" ? candidate : undefined;   // our own popup, or another extension's, is not a tab host
  } catch {
    return undefined;
  }
}
```

**Why not resolve it later.** By the time the user presses Enter, `chrome.windows.getLastFocused()`
returns the quick-search popup itself, because it is focused — that is the whole point of C2. A
`type:"popup"` window cannot host a tab, so a naive late resolution either errors or lets Chrome pick
an arbitrary window. Capturing at invocation is the only moment at which "the window the user was
working in" is unambiguous.

**Not overwriting on re-invocation.** If the shortcut is pressed while the search window is already
focused, `resolveTabHostWindow()` returns `undefined` (type is `"popup"`), so the previously stored
host id is left intact. That is why the `set` is guarded on `host?.id !== undefined`.

**No cleanup entry for this key.** If the host window is closed while the search window is open, the
stored id goes stale and `chrome.tabs.create` rejects — which is exactly the self-healing path §5
already implements. Adding it to the `onRemoved` sweep would be redundant bookkeeping for a case the
catch already covers.

**Rejected alternatives.**

- *`chrome.windows.getLastFocused({ windowTypes: ["normal"] })`.* `windowTypes` on
  `getLastFocused`/`getCurrent` is deprecated in the Chrome API; building the feature's core
  targeting on a deprecated filter is a needless future break.
- *Track focus continuously with `chrome.windows.onFocusChanged`.* An in-memory value dies with the
  MV3 worker; persisting on every focus change is a storage write per window switch, for a value
  that is only ever read once per invocation.
- *`chrome.tabs.create({ url })` with no `windowId`.* This is exactly the ambiguity D5 rejects, and
  §2's popup-focus problem makes it actively wrong here.

---

## 5. ADR-503 — Scope membership: one snapshot per window open, filtered before capping

**Decision.** At bootstrap the page issues one `session/get` (`create-secret.ts:103` precedent) and
collapses the response into a single `Set<string>`:

```ts
// extension/src/quick-search/workspace-scope.ts  (new, pure — no chrome.*, no DOM)
export function collectManagedChromeIds(
  state: Pick<ExtensionState, "selectedWorkspaceIds" | "projectionsByWorkspaceId">,
): Set<string> {
  const ids = new Set<string>();
  for (const workspaceId of state.selectedWorkspaceIds) {                 // selected, not "all known"
    const projection = state.projectionsByWorkspaceId[workspaceId];
    if (!projection) continue;                                            // selected but not yet bootstrapped
    for (const chromeId of Object.keys(projection.backendIdByChromeId)) ids.add(chromeId);
  }
  return ids;
}
```

**Multiple workspaces.** The membership test is the **union over `selectedWorkspaceIds`**, iterating
the selection list rather than `Object.keys(projectionsByWorkspaceId)`. `setSelectedWorkspaces`
(`projection.ts:398-404`) already prunes projections to the selection, so the two are normally equal
— but iterating the selection is invariant-independent and survives a projection that lingers after
a failed `removeWorkspaceProjection` (`:390-396`). Chrome ids are globally unique across the
bookmark tree, so a flat union needs no per-workspace disambiguation.

**Filter before cap, never after.** `chrome.bookmarks.search()` applies no result limit of its own,
so the pipeline order is fixed: `search → drop folders (no url) → scope filter → cap at 50`. Capping
first would show fewer than 50 workspace results whenever personal bookmarks crowd the head of
Chrome's ordering, silently hiding matches.

**Snapshot staleness is accepted, and already scoped.** The set is built once per window open, so a
bookmark mapped *while* the window is open is invisible in `workspace` scope until the next open.
This is exactly the Low risk row in `proposal.md:63`, whose mitigation (`global` always shows it)
holds unchanged.

**Rejected alternatives.**

- *A `quick-search/filter` message per keystroke.* A background round-trip on every debounced
  keystroke, to answer a question a local `Set` answers in O(1), and it would wake the worker
  repeatedly during typing.
- *Import `getState()` from `shared/storage.ts` in the page.* Reads are harmless, but importing that
  module into the page also drags in its `stateMutationQueue` and the temptation to write — the very
  thing C3/D4 forbids. `session/get` keeps the page a strict read-only consumer.
- *Walk ancestors with `chrome.bookmarks.get` to test containment.* O(depth) IPC per result per
  keystroke; D2 rejected it and the evidence in §2.3 confirms the map already answers it exactly.

---

## 6. ADR-504 — Scope fallback is computed at render time and never persisted

**Decision.**

```ts
export function resolveScopeAvailability(
  state: Pick<ExtensionState, "session" | "selectedWorkspaceIds">,
  persisted: QuickSearchScope,
): { workspaceEnabled: boolean; effectiveScope: QuickSearchScope; disabledReason?: string } {
  const workspaceEnabled = Boolean(state.session) && state.selectedWorkspaceIds.length > 0;
  if (workspaceEnabled) return { workspaceEnabled, effectiveScope: persisted };
  return {
    workspaceEnabled,
    effectiveScope: "global",
    disabledReason: state.session
      ? "Select a workspace in Options to search only synced bookmarks."
      : "Sign in from the URLises popup to search only synced bookmarks.",
  };
}
```

**Rationale.** The spec requires both "the choice MUST survive" and "signed out → `workspace` is
visibly disabled, `global` still works". If the fallback were *written* to storage, a single
signed-out invocation would destroy a `workspace` preference the user set deliberately, and it would
silently come back as `global` after signing in again. Computing the fallback at render time keeps
the persisted value the user's intent and the rendered value the reachable truth.

The control is rendered **disabled with the reason visible**, never hidden — proposal question round
#3, confirmed.

Note the deliberate split: availability keys on *session + selection*, **not** on
`managedChromeIds.size > 0`. A freshly selected workspace that is still bootstrapping has an empty
map; that is an "no results yet" condition (handled by the empty-results hint in §8), not a "this
scope does not apply to you" condition.

---

## 7. ADR-505 — Debounce is not enough: an explicit query sequencer

**Decision.** `search-results.ts` owns three pure pieces, all unit-testable under `node --test`:

```ts
// extension/src/quick-search/search-results.ts  (new, pure — no chrome.*, no DOM)
export const RESULT_CAP = 50;
export const SEARCH_DEBOUNCE_MS = 120;

export interface SearchResultView { id: string; title: string; url: string }

export function toResultViews(nodes: { id: string; title?: string; url?: string }[]): SearchResultView[];
export function capResults(views: SearchResultView[], cap?: number): { results: SearchResultView[]; truncated: boolean };
export function nextHighlightIndex(current: number, key: "ArrowUp" | "ArrowDown", length: number): number;
export function createDebouncer(delayMs: number): { schedule(run: () => void): void; cancel(): void };
export function createQuerySequencer(): { begin(): number; isLatest(token: number): boolean };
```

**Why a sequencer, when there is already a debouncer.** Debouncing bounds *how often* a search
starts; it does nothing about *what order results come back in*. `chrome.bookmarks.search()` is
async IPC: a search for `"do"` issued at t=0 and one for `"docs"` issued at t=130 can resolve in
either order, and the later-resolving stale response would overwrite the fresh list — with the
highlight index pointing into a list the user is no longer looking at, one keystroke before they
press Enter. **Opening the wrong URL is the failure mode**, which makes this a correctness
requirement, not polish. A monotonic token compared after every `await` closes it in four lines and
is trivially testable:

```ts
const token = sequencer.begin();
const nodes = await chrome.bookmarks.search(query);
if (!sequencer.isLatest(token)) return;    // a newer keystroke already won; drop this response
```

`begin()` is also called from the `input` handler, so an in-flight search is invalidated the moment
the user types again, including when the new query is empty.

**Empty query short-circuits the debouncer.** `debouncer.cancel()` then render-empty, so clearing the
input never leaves 120 ms of stale results on screen and never issues a search for `""`.

**`toResultViews` drops folders.** `chrome.bookmarks.search` matches titles, so it returns folders
(no `url`); they are not openable and are filtered out before the scope filter and the cap.

---

## 8. ADR-506 — The first result is highlighted by default

**Decision.** After every render with a non-empty list, `highlightIndex = 0`. `nextHighlightIndex`
wraps (`ArrowDown` at the last item → 0) and returns `-1` for an empty list.

**Rationale.** `proposal.md:5` states the goal as "**press a shortcut, type, hit Enter, the bookmark
opens**". Requiring a `↓` press first would contradict the change's own stated intent for the most
common path. The spec's "↓ then Enter" scenario remains satisfied — it is one of two accepted paths,
not an exclusive one. Recorded here rather than assumed, because it is a behavioral choice the spec
does not spell out.

**Render states** (the full table the entry file implements):

| Condition | List | Hint |
|---|---|---|
| Empty query | cleared | `Type to search your bookmarks.` |
| Query, zero matches in scope | cleared | `No bookmarks match "{query}".` |
| 1..50 matches | n rows, row 0 highlighted | — |
| >50 matches | 50 rows | `Showing the first 50 — refine your search.` |
| `workspace` unavailable | (global results) | `disabledReason` from ADR-504, next to the disabled control |
| Always (footer) | — | `Shortcut not working? Remap it at chrome://extensions/shortcuts` |

The footer is `proposal.md:61`'s mitigation. It is rendered as **plain text, not an `<a href>`** —
Chrome blocks link navigation to `chrome://` URLs from an extension page, so a link would look
actionable and do nothing.

**Selection wiring** follows `create-secret.ts:81-97` verbatim: **one delegated `click` listener on
the `<ul>`**, reading `data-index` from `event.target.closest("[data-index]")`. Per-item listeners
would leak because the list is rebuilt on every render. `keydown` is bound on `document` (not the
input) so `Esc` works regardless of focus, while the input keeps focus so typing is uninterrupted;
`ArrowUp`/`ArrowDown`/`Enter` call `preventDefault()` to stop caret movement and implicit submit.

---

## 9. ADR-507 — **Deviation**: the proposal's packaging mitigation does not hold

This is the design's only substantive departure from `proposal.md`, and it is evidence-driven.

**The claim under test.** `proposal.md:62` mitigates "New dist output omitted from `releaseAllowlist`
→ broken zip" with: *"`validateZipListing` fails closed, so it is caught at package time."*

**That is false for this exact failure mode.** Traced through the real code:

1. `collectReleaseFiles()` (`package.mjs:212-221`) returns `[...releaseAllowlist]` — it never reads
   the filesystem for *extra* files.
2. `stageFiles`/`createZip` (`:348-393`) copy exactly that list.
3. `validateZipListing(listing, releaseFiles)` (`:479-499`) compares the **zip contents** against the
   **allowlist**. If `dist/quick-search/search-results.js` is in neither, both sides agree and the
   check passes.
4. `validateReferencedAssets` (`:276-295`) scans HTML for `href|src` attributes only (`:282`). It is
   **not transitive**: `quick-search.html` references `quick-search.js`, but `search-results.js` and
   `workspace-scope.js` enter only through ES `import` statements inside the JS, which nothing
   parses.

Net effect: omitting a helper module from the allowlist produces a zip that passes every gate and is
**broken at runtime on install** — a store-visible failure, discoverable only by loading the zip.
`assertRegularFile` (`:223-244`) catches the opposite mistake (allowlisted-but-missing), which is
what makes the risk feel covered when it is not.

**Decision.** Close it with the smallest change that pins an invariant the repo *already* upholds:

- Move the array to `extension/scripts/release-allowlist.mjs` (`export const releaseAllowlist = [...]`)
  and import it in `package.mjs`. Necessary because `package.mjs` calls `main()` at module scope
  (`:505-508`), so a test cannot import it without running a full packaging run.
- Add `extension/tests/release-allowlist.test.mjs`: after `npm run build`, walk `dist/` and assert
  the set of emitted `.js` files equals the `dist/…` entries in the allowlist, in both directions.

**Why this is proportionate.** The invariant is already exactly true today and verifiable by
counting: 27 `src/**/*.ts` files, 27 `dist/**` allowlist entries (`package.mjs:25-51`), a perfect 1:1
map across `background` (5), `create-secret` (3), `options` (2), `popup` (3), `shared` (14). The test
does not invent policy; it pins the policy the maintainers have been applying by hand. Cost is ~10
lines of mechanical move plus ~25 lines of test, and `test:projection` already runs `npm run build`
first (`package.json:10`), so `dist/` is guaranteed present. `npm run package --release` runs
`typecheck` and `test:projection` as gates (`package.mjs:137-151`), so the new test becomes a
**packaging gate** automatically.

**Also in scope, unchanged from the proposal.** `validateReferencedAssets`'s scan array
(`package.mjs:280`) gains `src/create-secret/create-secret.html` and
`src/quick-search/quick-search.html`. Verified safe to land immediately: `create-secret.html`
references only `../shared/ui/theme.css` → `src/shared/ui/theme.css` (allowlist `:60`) and
`../../dist/create-secret/create-secret.js` → `dist/create-secret/create-secret.js` (allowlist `:31`),
so adding it to the scan is a no-op on the current tree and cannot break `npm run package` on its own.

**Rejected alternatives.**

- *Leave it to a task-list checklist.* That is the process that produced the gap in the first place;
  the proposal's own risk table rates the likelihood **Med**.
- *Teach `package.mjs` to parse ES `import` graphs.* Materially more code and a new parser to
  maintain, for no more coverage than the set-equality check (every emitted module is allowlisted
  ⟹ every imported module is allowlisted).
- *Glob `dist/**` into the allowlist automatically.* Rejected: the explicit allowlist is this
  packager's whole security model (`:246-274`, `:479-499`). Auto-including build output would let a
  stray file ship. The test asserts the two agree; it does not merge them.

---

## 10. ADR-508 — Slicing: the proposal's A/B cut stands, with one hard ordering constraint

**Confirmed.** Slice A (shortcut + window + global search + open + packaging) is autonomously
valuable and shippable: the surface works end to end in `global` scope with no toggle. Slice B adds
the filter and the persisted preference. Rollback is per `proposal.md:66-68` and unchanged.

**Constraint the proposal does not state, and that would break Slice A if ignored.**
`collectReleaseFiles` (`package.mjs:212-221`) calls `assertRegularFile` for **every** allowlist entry
and throws `Required release file is missing` when one is absent. Therefore the allowlist entry for
`dist/quick-search/workspace-scope.js` **MUST land in Slice B**, not A — `proposal.md:14` describes
all "3 new `dist/quick-search/*.js` files" as one packaging change, which would make Slice A's
`npm run package` fail. Split: **A adds `quick-search.js` + `search-results.js` + the HTML; B adds
`workspace-scope.js`.** ADR-507's test enforces this in both directions and turns the mistake into a
fast red test instead of a broken zip.

**Budget forecast** (authored additions + deletions, for `sdd-tasks` to refine):

| Slice | Estimate | Composition |
|---|---|---|
| A | ~340-375 | `service-worker.ts` +45, `quick-search.ts` +110, `search-results.ts` +70, `quick-search.html` +35, `theme.css` +15, `manifest.json` +8, `runtime.ts` +10, `package.mjs`/`release-allowlist.mjs` +15, tests +70 |
| B | ~230 | `workspace-scope.ts` +55, `quick-search.ts` +45, `types/storage/projection/service-worker` +28, `quick-search.html` +10, `theme.css` +10, tests +80 |

Slice A is under budget but close. **Pre-authorized escape hatch if A's real diff crosses 400 at
apply time**: split it into A1 (shortcut + idempotent window + global search + *mouse* click-to-open
+ packaging) and A2 (keyboard nav ↑/↓/Enter/Esc, result cap + refine hint, empty-query hint). Both
halves are independently demonstrable and independently revertable; A1 ships a working
click-to-search surface, A2 makes it keyboard-first. This is a fallback, not the plan — the two-slice
cut remains the recommendation.

---

## 11. Data flow

```
  ┌─ Alt+Shift+B ──────────────────────────────────────────────────────────┐
  │                                                                        │
  ▼                                                                        │
chrome.commands.onCommand  (service-worker.ts, top-level listener)         │
  │                                                                        │
  ├─ resolveTabHostWindow() ──► storage.session[QUICK_SEARCH_TARGET_…]     │  ADR-502
  │                                                                        │
  └─ storage.session[QUICK_SEARCH_WINDOW_ID] ──► windows.update ──(ok)─────┘  focus, done
                    │
                    └──(reject / absent)──► windows.create({type:"popup"}) ──► store id

quick-search.ts  (page)
  bootstrap: sendMessage("session/get") ─► UiState
     ├─ uiTheme                         ─► documentElement.dataset.theme
     ├─ quickSearchScope + session/selection ─► resolveScopeAvailability()   ADR-504
     └─ projectionsByWorkspaceId        ─► collectManagedChromeIds() ─► Set  ADR-503

  input ─► sequencer.begin() ─► debounce 120ms ─► chrome.bookmarks.search(q)
              │                                          │
              │                                          ▼
              │                       toResultViews ─► scope filter ─► capResults(50)
              │                                          │
              └────── isLatest(token)? ──(no)─► drop ────┘  ADR-505
                                                           │
                                                           ▼
                                                     render + highlight 0

  Enter / click ─► storage.session[QUICK_SEARCH_TARGET_…] ─► tabs.create({url, windowId})
                                                     │              │
                                              (reject)│              └► windows.update({focused:true})
                                                     ▼                        │
                                        windows.create({url, focused})        ▼
                                                     └──────────────► window.close()
                                                                            │
                                                        windows.onRemoved ──┘ ─► clear tracked keys
```

---

## 12. File changes

### Slice A

| File | Action | Description |
|---|---|---|
| `extension/manifest.json` | Modify | Add `commands.open-quick-search` (§13). No permission change. |
| `extension/src/shared/runtime.ts` | Modify | `QUICK_SEARCH_WINDOW_ID_KEY`, `QUICK_SEARCH_TARGET_WINDOW_ID_KEY`, documented like `CREATE_SECRET_WINDOW_ID_KEY` (`:16-21`). |
| `extension/src/background/service-worker.ts` | Modify | `chrome.commands.onCommand` listener; `openOrFocusQuickSearchWindow` + `getStoredWindowId` + `tryFocusWindow` (ADR-501); `resolveTabHostWindow` (ADR-502); generalize `onRemoved` (`:47-53`) to the tracked-key array; window size constants. |
| `extension/src/quick-search/quick-search.html` | Create | Search input, results `<ul>`, hint `<p aria-live="polite">`, footer. Loads `../../dist/quick-search/quick-search.js` and `../shared/ui/theme.css`, mirroring `create-secret.html:6,83`. |
| `extension/src/quick-search/quick-search.ts` | Create | Entry glue: bootstrap, debounced search loop, render, keyboard/mouse selection, open-and-close. Not unit tested, per §2.5. |
| `extension/src/quick-search/search-results.ts` | Create | Pure: `toResultViews`, `capResults`, `nextHighlightIndex`, `createDebouncer`, `createQuerySequencer` (ADR-505/506). |
| `extension/src/shared/ui/theme.css` | Modify | `.ui-result-list` (reusing `.ui-option-list`'s scroll shape, `:512-515`) and `.ui-result--active` highlight. |
| `extension/scripts/release-allowlist.mjs` | Create | Extracted `releaseAllowlist` (ADR-507) + `dist/quick-search/{quick-search,search-results}.js` + `src/quick-search/quick-search.html`. |
| `extension/scripts/package.mjs` | Modify | Import the allowlist; add both HTML files to the `:280` scan array. |
| `extension/tests/quick-search-results.test.mjs` | Create | Pure-module tests for `search-results.ts`. |
| `extension/tests/release-allowlist.test.mjs` | Create | `dist/**/*.js` ↔ allowlist set equality (ADR-507). |

### Slice B

| File | Action | Description |
|---|---|---|
| `extension/src/shared/types.ts` | Modify | `export type QuickSearchScope = "workspace" \| "global";` and optional `quickSearchScope?: QuickSearchScope` on `ExtensionState` (`:254-269`), alongside `uiTheme?` (`:265`). |
| `extension/src/shared/storage.ts` | Modify | `quickSearchScope: "workspace"` in `defaultState()` (`:7-24`); exported `normalizeQuickSearchScope()` applied in `getState()`'s return (`:32-42`), following `normalizeSecretReadSignal` (`:113-117`). |
| `extension/src/background/projection.ts` | Modify | `export async function setQuickSearchScope(scope)` — `updateState` + `getUiState()`, shaped exactly like `markActivitySeen` (`:268-280`). No backend call (D3). |
| `extension/src/background/service-worker.ts` | Modify | `case "quick-search/set-scope"` in the switch (`:55-108`). |
| `extension/src/quick-search/workspace-scope.ts` | Create | Pure: `collectManagedChromeIds`, `resolveScopeAvailability`, `filterByScope` (ADR-503/504). |
| `extension/src/quick-search/quick-search.ts` | Modify | Toggle wiring, scope filter in the render pipeline, disabled-state rendering. |
| `extension/src/quick-search/quick-search.html` | Modify | Scope toggle markup + explanation `<p>`. |
| `extension/src/shared/ui/theme.css` | Modify | Toggle styling (reuse `.ui-pill` / `.ui-button-ghost`). |
| `extension/scripts/release-allowlist.mjs` | Modify | `+ dist/quick-search/workspace-scope.js` (ADR-508 ordering constraint). |
| `extension/tests/quick-search-scope.test.mjs` | Create | Membership union, `Personal (not synced)` exclusion, availability/fallback, filter-then-cap ordering. |

**Minor deviation from `proposal.md:52`.** Window width/height constants stay **local to
`service-worker.ts`**, not in `shared/runtime.ts`. Evidence: `popup.ts:9-10` declares
`CREATE_SECRET_WINDOW_WIDTH/HEIGHT` locally in the opening context, while `runtime.ts` holds only
cross-context keys and URLs. Following the existing split keeps `runtime.ts` a shared-constants
module rather than a grab bag.

---

## 13. Interfaces / contracts

```jsonc
// extension/manifest.json — new top-level key. No `commands` key exists today, so no collision.
"commands": {
  "open-quick-search": {
    "suggested_key": { "default": "Alt+Shift+B" },
    "description": "Open URLises quick bookmark search"
  }
}
```

`global` is omitted, so the binding defaults to `chrome` scope (`proposal.md:10`). If Chrome finds
the chord already taken it silently leaves the command unbound — which is why §8's footer always
shows the `chrome://extensions/shortcuts` remap path. `commands` adds no install-prompt permission
(C6), and `collectManifestReferences` (`package.mjs:297-329`) reads no paths from it, so packaging is
unaffected by the key itself.

```ts
// Background message contract (Slice B). Page → background only; the page never writes state.
{ type: "quick-search/set-scope", payload: { scope: QuickSearchScope } } -> UiState
```

Handled in `service-worker.ts`'s switch exactly like `preferences/set-theme` (`:103-105`); unknown
types already fall through to the `:106-107` error branch, so an older worker paired with a newer
page rejects cleanly rather than silently no-op'ing.

### 13.1 Why the message, and not a page-side `updateState` (D4, proved)

`stateMutationQueue` (`storage.ts:5`) is a **module-level** variable. Each JavaScript context that
imports `shared/storage.js` — the worker, the popup, the options page, this new window — gets its
**own** queue instance. `updateState` (`:49-56`) is a `getState → updater → chromeStorageSet`
read-modify-write over one key (`STORAGE_KEY`). Two queues therefore provide **no mutual ordering**:
a page write that read its snapshot before a concurrent background write completes will persist its
whole stale `ExtensionState` — including `projectionsByWorkspaceId` — over the live one. The sync
engine writes constantly (`updateProjectionState`, every socket event), so the collision window is
not theoretical: the loss would be materialized bookmark mappings, i.e. a corrupted projection. The
background message keeps every mutation in the single worker-side queue, where the FIFO ordering is
total. D4 confirmed, with the mechanism named.

---

## 14. Testing strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit (A) | `capResults` cap + `truncated` flag; `toResultViews` drops folders and preserves Chrome's order; `nextHighlightIndex` wrap-around, empty list → `-1`, default 0; `createQuerySequencer` drops a stale token and accepts the latest; `createDebouncer` coalesces bursts and `cancel()` suppresses a pending run | `node --test tests/quick-search-results.test.mjs`, importing `../dist/quick-search/search-results.js`, matching `tests/window-geometry.test.mjs`. Timers via `t.mock.timers`. |
| Unit (A) | `dist/**/*.js` ↔ `releaseAllowlist` set equality, both directions | `tests/release-allowlist.test.mjs`; `test:projection` builds first (`package.json:10`) |
| Unit (B) | `collectManagedChromeIds` unions only selected workspaces and skips absent projections; a `Personal (not synced)` chrome id (absent from `backendIdByChromeId`) is excluded in `workspace` and present in `global`; `resolveScopeAvailability` returns `global` + reason when signed out and when signed in with zero selections, and never mutates the persisted value; scope filter runs **before** the cap | `tests/quick-search-scope.test.mjs` with hand-built `ExtensionState` fixtures |
| Integration (B) | `setQuickSearchScope("global")` persists and is returned by `getUiState()`; the default is `"workspace"` when nothing is stored; a legacy persisted state without the field normalizes to `"workspace"` | `tests/quick-search-scope.test.mjs` using the `globalThis.chrome` storage double from `tests/theme-preferences.test.mjs:7-14` |
| Manual (A) | Shortcut opens; second press focuses instead of duplicating; Enter opens the top hit in the previously-focused normal window and closes the search window; Esc closes without opening; closing the host window then selecting falls back to a new window | Load unpacked; documented in `tasks.md` |
| Manual (A) | `npm run package` succeeds; the zip contains every new file; the Chrome install prompt shows no new permission | `npm run package` then load the zip unpacked |

DOM glue in `quick-search.ts` is intentionally not unit tested — §2.5, the boundary
`create-secret.ts:6-10` states for this repo.

---

## 15. Threat matrix

Applicable only through `scripts/package.mjs`, which classifies files for release and spawns `zip`.
No routing, VCS, or PR automation is touched.

| Boundary | Minimum adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Documentation-like paths / executable-file classification | New allowlist entries and new HTML scan inputs are run through `getForbiddenReason` (`package.mjs:250-274`) and `resolveLocalReference` (`:331-346`) | **Applicable** | Classifier code is **unchanged**; only its inputs grow. New basenames (`quick-search.html`, `quick-search.js`, `search-results.js`, `workspace-scope.js`) trip none of the `.ts`/`.map`/`test`/`secret` heuristics and need no `knownSafeSecretBasenames` carve-out (`:270`). Both new HTML inputs reference only same-origin relative paths, so `resolveLocalReference`'s escape/backslash throws (`:334-344`) stay unreached on a clean tree and remain the fail-closed guard on a dirty one. | `tests/release-allowlist.test.mjs` (ADR-507) — set equality is the RED test for the real hazard, an emitted module silently absent from the allowlist. Unit-testing `getForbiddenReason` itself would require a second extraction from `package.mjs` and is out of this change's scope; the classifier is unmodified here. |
| Git repository selection | `git -C`, relative/absolute paths | **N/A** | This change runs no git command. | none |
| Commit state | staged, `commit -a`, empty index | **N/A** | No VCS automation. | none |
| Push state | tracking branch, first push, refspec | **N/A** | No VCS automation. | none |
| PR commands | `--head`, env prefix, composed commands | **N/A** | No PR automation. | none |

---

## 16. Migration / rollout

No migration. `quickSearchScope` is an additive optional field: `getState()` merges over
`defaultState()` (`storage.ts:28`) and the new normalizer coerces any absent or unrecognized value to
`"workspace"`, so a state persisted before this change upgrades in place and a downgrade simply
ignores the extra key. Slice A ships behind no flag — the surface is unreachable until the `commands`
key exists, and removing that key fully disables it. Gitflow: `feature/extension-quick-bookmark-search`
off `develop`, Slice B stacked on Slice A's branch per the Feature Branch Chain rule.

---

## 17. Open questions

None blocking. Residual items recorded rather than hidden:

- [ ] `openOrFocus` / `tryFocusWindow` are duplicated across `popup.ts` and `service-worker.ts` (~14
      lines of `chrome.*` glue). ADR-501 rejects extracting them inside this change; a follow-up may
      lift them into `shared/` once a third caller exists.
- [ ] `getForbiddenReason` remains untestable in isolation because `package.mjs` self-executes
      (`:505-508`). ADR-507 extracts only the allowlist; extracting the classifier is a separate,
      larger change.
- [ ] The managed-id snapshot is per window open (ADR-503). Accepted as `proposal.md:63`'s Low risk;
      revisit only if real usage shows the window is kept open for long stretches.
