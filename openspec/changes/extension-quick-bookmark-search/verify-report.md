# Verify Report: extension-quick-bookmark-search (Slice A only)

**Change**: extension-quick-bookmark-search
**Branch verified**: `feature/extension-quick-bookmark-search-slice-a` (single commit `1cc818f`), branched off tracker `feature/extension-quick-bookmark-search`
**Mode**: full artifact verification (proposal + spec + design + tasks), all present
**Scope note**: Slice B (workspace-scope filter + persisted toggle) is intentionally NOT implemented on this branch — verified absent, not half-done (see §5).
**Size**: 736 insertions / 68 deletions across 12 files — accepted `size:exception` over the 400-line default (orchestrator + user explicit acceptance); not re-flagged here, but its *content* is independently confirmed clean (§6).
**Verdict**: **PASS WITH WARNINGS** (0 CRITICAL, 2 WARNING, 0 SUGGESTION)

## Test / build evidence (independently re-run, not trusted from the apply report)

| Command | Result |
|---|---|
| `npm run test:projection` (build + `node --test tests/*.test.mjs`) | **260/260 pass, 0 fail**, exit 0, `duration_ms 4561` (re-run again during `npm run package`: 260/260 again) |
| `node --test tests/quick-search-results.test.mjs tests/release-allowlist.test.mjs` (focused) | **17/17 pass** (15 in quick-search-results, 2 in release-allowlist), exit 0 |
| `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | Clean, no output, **exit 0** |
| `npm run package` (`node scripts/package.mjs --release`) | **Success**, exit 0. Runs `test:projection` (260/260) then typecheck internally as gates, then builds the zip: `Chrome Web Store package created. Artifact: .../urlises-for-chrome-0.1.0.zip, Files: 39, Bytes: 75121` |

Apply's claimed 260/260 (up from a 243/243 baseline) is confirmed exactly: 243 + 17 new tests (15 `quick-search-results.test.mjs` + 2 `release-allowlist.test.mjs`) = 260.

## 1. Zip listing — independently inspected (`unzip -l` + `unzip -p manifest.json`), not trusted from the apply report

- `dist/quick-search/quick-search.js` — **present** (5490 bytes)
- `dist/quick-search/search-results.js` — **present** (3247 bytes)
- `src/quick-search/quick-search.html` — **present** (1046 bytes)
- `dist/quick-search/workspace-scope.js` — **absent**, confirmed (Slice B only, per ADR-508) — no such entry anywhere in the 39-file listing
- `manifest.json` `permissions` — **unchanged**, confirmed by parsing the zip's own `manifest.json`: `["bookmarks", "storage"]`
- `manifest.json` `commands.open-quick-search` — present, `suggested_key.default: "Alt+Shift+B"`, matches proposal D6/design §13

## 2. `git diff feature/extension-quick-bookmark-search..feature/extension-quick-bookmark-search-slice-a` — stat matches claim exactly

12 files, 736 insertions(+), 68 deletions(-) — matches the stated measurement byte-for-byte. Full file list: `manifest.json`, `package.mjs`, `release-allowlist.mjs` (new), `service-worker.ts`, `quick-search.html` (new), `quick-search.ts` (new), `search-results.ts` (new), `runtime.ts`, `theme.css`, `quick-search-results.test.mjs` (new), `release-allowlist.test.mjs` (new), `tasks.md`. Every file is directly attributable to this change; no unrelated/accidental content found (§6).

## 3. Spec scenario compliance (source-read against actual code, not inferred from titles)

| Requirement | Scenarios | Status | Evidence |
|---|---|---|---|
| Shortcut Invocation and Idempotent Window | First invocation opens; repeated invocation focuses | **PASS w/ WARNING** | `service-worker.ts`: `chrome.commands.onCommand` registered synchronously at top level; `openOrFocusQuickSearchWindow()` calls `getStoredWindowId` → `tryFocusWindow` (self-heal on reject) → `chrome.windows.create({type:"popup"})` on miss, storing the new id. Logic matches ADR-501 exactly and mirrors `popup.ts`'s shipped `openOrFocusCreateSecretWindow` pattern verbatim. **No automated test exercises this path** (none found in `tests/` for `openOrFocusQuickSearchWindow`/`onCommand`) — same untested-glue convention as the pre-existing `popup.ts` equivalent (design §2.5), and `tasks.md` A5.2 is transparent that interactive Chrome-load verification is deferred to manual QA, "not runnable in this sandboxed environment." Real end-to-end proof (open/focus/duplicate-prevention in an actual browser) is still outstanding. |
| Search Behavior (debounce ~120ms, empty-query hint, 50-cap + refine hint) | Typing shows results; empty query shows hint not default list; cap surfaces refine hint | **PASS** | `SEARCH_DEBOUNCE_MS = 120`; `capResults`/`toResultViews` unit-tested (cap + truncated flag, folder-dropping, order preservation) and pass at runtime. `onInput` calls `debouncer.cancel()` + `renderEmpty()` synchronously on empty query — never issues a search for `""`, matching ADR-505's "empty query short-circuits the debouncer." |
| Keyboard and Mouse Selection | ↓+Enter / click both open+close; Esc closes without opening | **PASS w/ WARNING** | `nextHighlightIndex` (wrap-around, empty→-1, default-0) is unit-tested. `onKeyDown`/click-delegate/`openResult`/`window.close()` DOM wiring in `quick-search.ts` is real and matches design (`preventDefault` on Arrow/Enter, `keydown` bound on `document` so Esc works regardless of focus, one delegated `click` listener per §8). **DOM glue itself is untested by design** (documented boundary, `create-secret.ts:6-10` precedent) — same manual-QA gap as above. |
| Persisted Workspace/Global Scope Toggle | (Slice B) | **N/A — correctly absent** | No `quickSearchScope`, no `quick-search/set-scope` message anywhere in the branch (`git grep` returned zero matches). |
| Workspace-Scope Membership via `backendIdByChromeId` | (Slice B) | **N/A — correctly absent** | No `workspace-scope.ts` file exists on this branch. |
| Opening a Selection Always Targets a New Tab | Opens new tab even if duplicate exists | **PASS** | `openResult` always calls `chrome.tabs.create({url, windowId})` (or `chrome.windows.create` fallback) — no `chrome.tabs.query` call anywhere in `quick-search.ts`, confirming no dedup/reuse logic was added, matching D5/spec's "regardless of whether the URL is already open elsewhere." |
| Release Packaging Includes Quick-Search Assets | Fails closed on missing referenced asset; allowlist-coverage check catches import-only modules | **PASS** | Fully proven by actual execution: `release-allowlist.test.mjs`'s 2 set-equality tests pass at runtime; `validateReferencedAssets`'s scan array now includes both `quick-search.html` and the pre-existing `create-secret.html` gap (confirmed fixed per proposal's explicit ask); `npm run package` succeeded end-to-end and the zip was independently inspected (§1). |

## 4. ADR-502 (tab host captured at invocation) — verified against actual source, not just tests

```ts
// service-worker.ts, as shipped on this branch
async function resolveTabHostWindow(): Promise<chrome.windows.Window | undefined> {
  try {
    const candidate = await chrome.windows.getLastFocused();
    return candidate.type === "normal" ? candidate : undefined;
  } catch {
    return undefined;
  }
}
```

- Called from inside `openOrFocusQuickSearchWindow()`, itself invoked synchronously from the top-level `onCommand` listener — i.e. captured **at invocation time**, before `chrome.windows.create` steals focus. Confirmed by reading the call order: `resolveTabHostWindow()` runs and its result is persisted to `chrome.storage.session` *before* the `getStoredWindowId`/`tryFocusWindow`/`windows.create` block.
- **No `{windowTypes}` filter used** — `chrome.windows.getLastFocused()` is called with no arguments; the `"normal"` check is done manually on the returned `candidate.type`, exactly matching the design's rejection of the deprecated filter.
- Confirmed idempotent: this key is deliberately excluded from the generalized `onRemoved` cleanup sweep (`TRACKED_WINDOW_ID_KEYS` contains only `CREATE_SECRET_WINDOW_ID_KEY` and `QUICK_SEARCH_WINDOW_ID_KEY`, not the target-window key), matching ADR-502's documented rationale that a stale target id is already handled by `chrome.tabs.create`'s own reject path in `quick-search.ts`.

**ADR-502 verdict: fully implemented as designed.**

## 5. ADR-505 (query sequencer) — verified wired into the actual search flow, not merely present as a pure function

```ts
// quick-search.ts, as shipped
function onInput(): void {
  const query = searchInput.value.trim();
  const token = sequencer.begin();          // called on every keystroke, including when query becomes empty
  ...
  debouncer.schedule(() => { void runSearch(query, token); });
}

async function runSearch(query: string, token: number): Promise<void> {
  let nodes = await chrome.bookmarks.search(query).catch(() => []);
  if (!sequencer.isLatest(token)) return;   // stale response dropped before any render
  ...
}
```

`sequencer.begin()` is called synchronously in the `input` handler (invalidating any in-flight search the instant the user types again, including on empty query per ADR-505's explicit note) and `sequencer.isLatest(token)` gates the render after the async `chrome.bookmarks.search` resolves. This is real wiring, not dead code — confirmed by reading both call sites directly.

**ADR-505 verdict: fully implemented and wired, not just an unused pure function.**

## 6. Diff content check — no unrelated/accidental changes despite the accepted size exception

Read the full diff for every one of the 12 changed files. All content is directly attributable to this change:
- `manifest.json`: only the new `commands` key added; `permissions` line untouched.
- `service-worker.ts`: new `onCommand` listener + `openOrFocusQuickSearchWindow`/`resolveTabHostWindow`/`getStoredWindowId`/`tryFocusWindow` + generalized `onRemoved` sweep (single-key → array) — no unrelated refactor.
- `package.mjs`: `releaseAllowlist` array extracted verbatim (byte-identical contents plus the two new entries) into the new `release-allowlist.mjs`; `validateReferencedAssets`'s scan array gains exactly the two documented HTML paths.
- `runtime.ts`, `theme.css`: additive-only, new keys/classes, no edits to existing lines beyond the insertion point.
- `tasks.md`: only checkbox state and the review-workload-forecast prose updated to reflect what actually happened at apply time (budget-overage note, chain-strategy resolution) — no scope creep.
- No `.github`, `.devcontainer`, or unrelated backend/admin-web files touched (`git diff --stat` confirms only `extension/` and `openspec/changes/extension-quick-bookmark-search/tasks.md`).

**Diff content verdict: clean, matches its stated scope exactly; the accepted size exception is not masking unrelated changes.**

## Issues

### CRITICAL
None.

### WARNING
1. **Shortcut invocation/idempotent-window and keyboard+mouse selection end-to-end behavior have no automated runtime test.** The underlying pure logic (`nextHighlightIndex`, `capResults`, `createQuerySequencer`, `createDebouncer`) is fully unit-tested and passes (260/260), and the DOM/`chrome.*` glue matches the design and an already-shipped precedent (`popup.ts`'s equivalent window bookkeeping) that is *also* untested in this codebase — so this is a pre-existing, evidence-based convention, not a new gap introduced by this change. However, real end-to-end proof (does the shortcut actually open/focus a window in a live browser; does Enter/click/Esc actually behave as specified) is still outstanding — `tasks.md` A5.2 is transparent that this manual QA step has not been performed ("not runnable in this sandboxed environment"). Recommend performing the deferred manual QA pass before merge, or explicitly accepting the residual risk the same way the pre-existing `popup.ts` pattern already is.
2. **`resolveTabHostWindow`/`openOrFocusQuickSearchWindow` are unreachable from `node --test`** (service worker code that depends on `chrome.*` globals not present in the test harness) — same category as WARNING 1, listed separately because it is specifically the ADR-502 mechanism under review-request scrutiny. No code defect found; flagged purely as a residual runtime-verification gap.

### SUGGESTION
None.

## Task completion

All 13 Slice A tasks (A1.1–A5.2) are marked `[x]` in `tasks.md` and each is independently confirmed to match real code: manifest key, runtime constants, RED/GREEN pure-logic pair, RED/GREEN allowlist pair, service-worker wiring, HTML/CSS/entry-file surface, and packaging fix are all present and correspond to committed source. Slice B tasks (B1.1–B2.5) are correctly left unchecked and correctly absent from the code.

## Final Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 2 WARNING (both the same underlying residual-manual-QA gap, viewed from two angles), 0 SUGGESTION. No blocking issues found. The 2 warnings do not block proceeding to archive for Slice A given they mirror a pre-existing, already-accepted codebase convention and are transparently tracked in `tasks.md`; they should be resolved (or explicitly waived again) before this PR is merged/released in a real browser.
