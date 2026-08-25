# Exploration: extension-sync-pause-recovery

## 1. Confirmed root cause #1 — URL-normalization mismatch is real and exact

`extension/src/background/projection.ts:1478-1487` (bookmark update branch, no move):

```ts
const updateReceipt = existing.title !== bookmark.title || existing.url !== bookmark.url;
if (updateReceipt) await persistRemoteReceipt(workspaceId, event, bookmark.id, chromeId, "bookmark", existing,
  { parentId: existing.parentId!, index: existing.index!, title: bookmark.title, url: bookmark.url });
...
if (existing.title !== bookmark.title || existing.url !== bookmark.url) {
  await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
}
```

The **same unnormalized `bookmark.url`** (raw string from the backend event payload, e.g. `"https://admin.com"`) is used both to build the receipt's `expectedAfter` shape and as the literal argument to `chrome.bookmarks.update`. `chrome-bookmarks.ts` (`updateNode`, `createBookmark`, lines 44-81) is a pure pass-through promise wrapper — there is no normalization anywhere in the extension code, confirmed by grep (only unrelated `backendUrl.replace(/\/$/, "")` hits in `session.ts`/`api.ts`).

Chrome's own bookmarks store silently appends a trailing slash to bare-origin URLs. The live callback path proves this: `handleBookmarkChanged` (`projection.ts:606-627`) re-fetches the node fresh via `getNode(id)` (`chrome-bookmarks.ts:5-16`, a real `chrome.bookmarks.get` call) — i.e. it reads Chrome's own normalized value — and passes it to `consumeRemoteUpdate` → `reduceRemoteCallback` → `callbackMatches` (`convergence.ts:121`), which does `shapeSignature(callback.node) === receipt.expectedSignatures[1]`. `shapeSignature` (`convergence.ts:119`) is `JSON.stringify([parentId, index, title, url])` — exact string equality, no normalization. Since `expectedSignatures[1]` was built from the un-normalized `"https://admin.com"` and Chrome reports back `"https://admin.com/"`, this comparison **can never succeed** for this class of URL. This is deterministic and permanent, not flaky.

**Bonus latent bug found here (item 5):** because the match fails, `handleBookmarkChanged` falls through past `consumeRemoteUpdate` (returns `false`) to `captureLocalUpdateOrMove` (`projection.ts:429-458` via line 621), which queues a **phantom local intent** treating the extension's own programmatic Chrome update as if it were a genuine user edit, to be pushed back to the backend. Unlike the create path (`withSuppression(...)`, line 1435), the update-branch `updateNode` call (line 1483) is **not** wrapped in `withSuppression`, so this misattribution is unguarded. `drainLocalIntentsNow` (`projection.ts:466-471`) does gate on `phase === "paused"`, so this queued intent sits inert while paused — but it will be drained and pushed to the backend as a "local edit" the moment the workspace unpauses, which is a second-order risk worth a design note (a stale/spurious write-back once recovery finally succeeds).

## 2. Resolving the `retry` vs `rebuild` disposition discrepancy

Fully resolved, with exact call sites:

- `gateRemoteEffect` (`convergence.ts:96-98`) does default to `repairDisposition: "retry"` for any reason other than `"bootstrap-required"` — the earlier citation was correct but incomplete.
- **`pauseWorkspace` itself immediately overrides this** (`projection.ts:1981-1986`):
  ```ts
  await updateProjectionState(workspaceId, (projection) => {
    projection.convergenceJournal = gateRemoteEffect(projection.convergenceJournal ?? emptyJournal(), cursor, reason);
    if (projection.convergenceJournal.receipts?.some((receipt) => receipt.status === "pending")) projection.convergenceJournal.repairDisposition = "rebuild";
    ...
  });
  ```
  Any time a receipt is stuck `"pending"` (exactly our case), the persisted disposition becomes `"rebuild"` regardless of what `gateRemoteEffect` initially set. `retryJournal` (`convergence.ts:99-104`) independently enforces the same override on the read side. So **both write-time and read-time paths agree**: a pending receipt always forces `"rebuild"`. This is why every production dump shows `"rebuild"`, never `"retry"`, for this bookmark.
- Consequence in the UI: `options.ts:139-151` only renders the **"Retry" button at all when `repairDisposition !== "rebuild"`** (line 142-144: `... ? [["Rebuild", ...]] : [["Retry", ...], ["Rebuild", ...]]`). Since disposition is always `"rebuild"` here, the user in this scenario would only ever be offered the **Rebuild** button — "Retry" was structurally unavailable for this stuck workspace.

## 3. Exact call sites producing `pauseReason: "chrome-effect-rejected"`

Two, both confirmed:

- `projection.ts:1084` inside `doResyncWorkspace`'s catch block (lines 1082-1088) — a **hardcoded literal**, used generically for any failure during a full rebuild (tree fetch failure, path creation failure, or replay-checkpoint failure).
- `projection.ts:1248` inside `applyRemoteEnvelope`'s catch block — a fallback (`error instanceof RemoteApplyError ? error.gate : "chrome-effect-rejected"`), and `RemoteApplyError`'s own constructor default (`projection.ts:116`) is *also* `"chrome-effect-rejected"` — so it's effectively the generic/catch-all gate name across the whole file, not literally "Chrome rejected the API call."

For this specific bug, the mechanism that fires 1084 is: `doResyncWorkspace`'s own replay loop (lines 1055-1059) throws a plain `Error("rebuild replay did not checkpoint")` whenever `applyRemoteEnvelope` returns without an exception but also without advancing `lastCursor` past `event.cursor` — which is exactly what happens when `applyRemoteBookmarkUpsert` persists a new pending receipt (`deferCheckpoint = true`, line 1234 skips the cursor bump). This uncaught-by-`applyRemoteEnvelope`, caught-by-`doResyncWorkspace` throw is what turns "receipt never got consumed" into "workspace re-paused with `chrome-effect-rejected`."

## 4. Confirmed root cause #2 — sequential, cursor-gated replay-from-genesis (reframing the "stale replay" hypothesis)

Traced `rebuildWorkspace` (`projection.ts:400-405`) → `rebuildJournal` (`convergence.ts:105-108`, discards pending receipts, sets `phase: "replay"`) → `doResyncWorkspace(workspaceId, "explicit rebuild", "recovering")` (`projection.ts:999-1088`):

1. `getWorkspaceTree(...)` — a **real backend fetch** of current workspace state (line 1016).
2. Wipes `chromeIdByBackendId`/`backendIdByChromeId`/`entityTypeByBackendId` entirely (lines 1024-1026).
3. Clears all managed Chrome children and rematerializes **folders only** from the tree (lines 1040-1053) — bookmarks are not directly materialized from `tree`.
4. `replayEvents(state.settings.backendUrl, state.session, workspaceId, 0)` — replays the **entire historical event log from cursor 0**, applying each event in order via `applyRemoteEnvelope` (lines 1055-1059).
5. The loop requires each event to checkpoint (`lastCursor >= event.cursor`) before continuing; if not, it throws (line 1058) and the whole rebuild aborts back to `"chrome-effect-rejected"` (step 1084 above).

**This is important nuance versus the initial framing**: Rebuild *does* re-fetch current backend truth (both the tree and the full event log) — it is not blindly replaying a locally-cached queue. The actual defect is architectural: replay is **strictly sequential and cursor-ordered from genesis**, with no mechanism to skip or reconcile a single permanently-unresolvable historical event. Because cursor 3 (`eventId 13fc66a7...`, the trailing-slash-removal update for backendId `711176fd...`) can never satisfy the un-normalized signature match, the replay loop **never reaches any later event**, including whatever cursor the user's subsequent trailing-slash-*add* edit produced. This is why editing the bookmark in admin-web had zero observable effect: the fix is sitting in the backend event log at a cursor the extension will never get to.

This also fully explains the "same eventId replayed ~12 times, new chromeId each time" pattern: every click of Rebuild wipes the mapping (step 2) and rebuilds from scratch (step 4), so the bookmark is freshly re-created (new chromeId, e.g. 68702 → 68776) and immediately re-fails on the same historical cursor-3 event, producing a **byte-identical receipt** every time (since `eventId`/`cursor`/`before`/`expectedAfter` are all derived from the same immutable historical event — not from any local cache). Round 1 and round 2 dumps being byte-identical 12 minutes and several Rebuild clicks apart is the expected, deterministic outcome of this mechanism, not evidence of a stale cache being used instead of a refetch.

## 5. `retryJournal`/`rebuildJournal` wiring and self-heal capability

- `rebuildJournal` is **not dead code** — fully wired: options page "Rebuild" button (`options.ts:143,146-147`) → `sendMessage({type: "projection/rebuild"})` → `service-worker.ts:79-80` → `rebuildWorkspace` (`projection.ts:400-405`), which calls both `rebuildJournal` and `doResyncWorkspace`.
- `retryJournal`/`retryWorkspace` (`projection.ts:389-398`) is also wired but, as shown in §2, becomes a silent no-op whenever a receipt is pending: `retryJournal` returns `phase` still `"paused"` in that case (`convergence.ts:101-103`), so `retryable` stays `false` and `retryWorkspace` early-returns at line 394 without calling `replayWorkspaceDelta` at all.
- **No code path ever clears a `"pending"` receipt other than an exact `callbackMatches` signature match** (`convergence.ts:30-31`). `rebuildJournal` discards pending receipts from the *persisted journal* (`convergence.ts:106`), but this doesn't equal recovery — the very next full replay from cursor 0 immediately reconstructs an identical pending receipt from the same historical event, because `persistRemoteReceipt` derives its content purely from `event`/`bookmark` at replay time, not from any surviving journal state.
- **Self-heal implication (important for design):** because replay always reconstructs the receipt deterministically from the immutable historical event, a code fix to `shapeSignature`/`callbackMatches` (normalizing at comparison time) would **self-heal every currently-stuck production workspace** on the very next Rebuild click — no manual data migration or `receipts` array purge needed. There is no scheduled/automatic retry (`chrome.alarms`, `setInterval`, cron — none found via grep), so an operator/user action (one more Rebuild click, or a support-triggered one) is still required after any fix ships; workspaces do not self-heal proactively without that trigger.
- `applyRemoteEnvelope` (`projection.ts:1180`) has the unconditional `if (projection.convergenceJournal?.phase === "paused") return;` early-return confirmed exactly as described in the bug report — this is what silently drops all live socket events for a paused workspace.

## 6. Fix directions — comparison

| Direction | What it changes | Fixes existing stuck workspaces? | Independent / required? | Effort |
|---|---|---|---|---|
| (a) Normalize URLs everywhere a signature is computed (and before the Chrome API call) | `shapeSignature` input, `expectedAfter.url`, and the `url` passed to `createBookmark`/`updateNode` all go through one canonicalizer | Yes — self-heals on next Rebuild, since replay reconstructs receipts from the same historical event deterministically | One of (a)/(b) is **required**; this is the actual root cause of permanent, guaranteed non-recovery for bare-origin URLs | Medium — must audit every call site that builds a `ReceiptNodeShape` or calls the Chrome bookmarks API (both `convergence.ts` and `projection.ts`) |
| (b) Make `callbackMatches` tolerant of Chrome's known normalization (compare canonicalized values instead of raw signature strings) | Only the comparison function, not the values stored/sent | Yes — same self-heal property as (a) | Alternative implementation of the same required fix as (a); pick one, not both | Lower — single function change, but risks being incomplete if other Chrome normalizations exist (e.g. punycode, percent-encoding) that aren't enumerated |
| (c) Make paused-recovery re-fetch/compare against *current* backend state rather than replaying every historical event in strict order | Recovery would need to check "does the current backend truth already match what's live in Chrome" and checkpoint forward instead of requiring literal event-by-event signature confirmation | Partially — helps future poison events of *any* kind, not just this one | Independent, valuable but **not sufficient alone**: even with this, a genuinely irreconcilable single event (needing operator judgment) could still exist | High — this is close to a redesign of the reconciliation model (event-sourced replay vs. state-diff reconciliation), likely a design-phase decision, not a quick patch |
| (d) Add a genuine "force-unpause + full resync from backend" escape hatch for operators/support, bypassing receipt verification | Distinct from existing Retry/Rebuild, which are both still gated by the same sequential replay-and-signature-match requirement | Yes, unconditionally, but by design skips convergence guarantees for that one operation | Independent — a safety valve, valuable regardless of whether (a)/(b)/(c) ship | Low-medium — the harder part is UX/authz (should this be self-service or support-only, given it trusts Chrome's current state unconditionally) |

**Bottom line:** (a) or (b) is the blocking, required fix — without normalization-aware signature handling, this specific class of bookmark (any bare-origin URL, i.e. `https://host` with no path) is *structurally guaranteed* to get stuck the first time its title or URL changes, independent of any improvement to the recovery machinery. (c) and (d) are valuable, independent, defense-in-depth items that reduce blast radius for *other* future poison events but would not, on their own, fix this exact production incident, since Rebuild already does refetch backend truth — it just can never get past the poisoned cursor without a normalization-aware match.

## Files/lines cited (for sdd-design)

- `extension/src/background/convergence.ts:28,96-127` — receipt creation, signature computation, `retryJournal`/`rebuildJournal`, disposition logic
- `extension/src/background/projection.ts:389-405` (retry/rebuild entry points), `862-880` (`replayWorkspaceDelta`), `999-1088` (`doResyncWorkspace`, full rebuild path), `1166-1261` (`applyRemoteEnvelope`, pause gating), `1378-1497` (`applyRemoteBookmarkUpsert`, the exact unnormalized-URL call site), `1499-1539` (`consumeRemoteCallback`/`persistRemoteReceipt`), `1942-1990` (`recoverWorkspace`/`pauseWorkspace`)
- `extension/src/background/bookmark-listeners.ts:26-31` — `normalizeBookmarkChangeInfo` is a misleadingly-named field pick-through, not URL normalization
- `extension/src/background/chrome-bookmarks.ts:44-81` — confirmed pure pass-through to `chrome.bookmarks.*`, no normalization
- `extension/src/options/options.ts:139-151` — UI entry point (options page, not popup); Retry button conditionally hidden when disposition is `"rebuild"`
- `extension/src/background/service-worker.ts:73-81` — message routing for `projection/retry`, `projection/rebuild`, `projection/resync-all`

Note: no evidence of any UI affordance in `popup.ts`/`status-detail.ts` — the retry/rebuild controls live exclusively in the extension's options page, not its popup.

---

**Executive summary**: Confirmed with certainty that a permanent, deterministic URL-signature mismatch (`convergence.ts:119-123`, `projection.ts:1472-1483`) — Chrome silently appending a trailing slash to bare-origin URLs while the receipt's expected signature stays unnormalized — is the actual, sufficient root cause of the stuck workspace; the "stale replay" symptom is a secondary architectural property (strict sequential cursor-ordered replay-from-genesis in `doResyncWorkspace`, `projection.ts:999-1088`) that does correctly re-fetch backend truth but can never reach any event past the one poisoned cursor, so URL/signature normalization (direction a/b) is the required fix, with a manual force-unpause escape hatch (direction d) recommended as an independent safety net; a code fix alone should self-heal all currently-stuck workspaces on their next manual Rebuild click, with no data migration needed.

**Risks/blockers**: No automatic retry mechanism exists, so any fix requires a follow-up manual Rebuild click per stuck workspace (or a support-initiated one) to actually recover production data; the update path also queues a phantom local-edit intent back toward the backend once a workspace is unpaused (`captureLocalUpdateOrMove`, unguarded by `withSuppression`) that should be reviewed during design to avoid a stale write-back side effect.
