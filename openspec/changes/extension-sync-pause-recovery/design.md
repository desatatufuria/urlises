# Design: extension-sync-pause-recovery

Surgical bugfix design. Four code changes, three files, all inside
`extension/src/background/`. No new architecture, no backend change, no persisted-format
change, no migration.

Everything below is written against the current tree; line numbers are the *pre-fix*
line numbers so `sdd-tasks` can slice directly.

---

## 1. Constraints this design is bound by

| # | Constraint | Source | How the design satisfies it structurally |
|---|---|---|---|
| C1 | Canonicalization is for **comparison only**. The value written into `before` / `expectedAfter` / `expectedSignatures`, and the value passed to `chrome.bookmarks.create`/`.update`, must be byte-identical to today. | proposal.md:10, 50 | ADR-001 picks direction (b): no value is ever rewritten, so C1 cannot be violated by a later refactor. |
| C2 | Only `url` gets normalization. `title` keeps strict `===`. | task brief | ADR-002: the canonicalizer's signature is `(raw: string) => string` and it is called from exactly one place, `sameUrl()`. There is no "canonicalize the shape" helper. |
| C3 | The canonicalizer must never throw on any URL the system accepts. | task brief | ADR-002: total function, `try/catch` → raw fallback. Accepted-URL space verified against `backend/internal/bookmarks/service.go:777-789`. |
| C4 | No persisted-format change; a revert must leave journals readable. | proposal.md:53-55 | `shapeSignature`, `expectedSignatures`, `RemoteReceipt`, and `ConvergenceJournal` are untouched. Only in-memory comparison logic and one filter change. |
| C5 | Size budget: single small PR. | proposal.md:59 | ~35 changed lines of production code + one new test file. |

---

## 2. ADR-001 — Canonicalize at comparison time (direction b), inside `convergence.ts`

**Decision.** Keep every stored and transmitted URL raw. Replace the raw signature-string
equality in `callbackMatches` (`extension/src/background/convergence.ts:121`) with a
structural, URL-normalization-aware comparison against `receipt.expectedAfter`.

**Rationale.**

1. **C1 becomes structural, not disciplinary.** Direction (a) requires canonicalizing at
   every site that builds a `ReceiptNodeShape` while keeping a *parallel raw variable* for
   the Chrome call — at `projection.ts:1373`, `1433/1438`, `1472/1473`, `1480/1483`. The
   task brief itself flags this as "the easiest thing for apply to get wrong". Direction
   (b) touches zero value-producing sites, so no reviewer or future editor can accidentally
   send a canonicalized URL to `chrome.bookmarks.update`.
2. **Direction (a) has a backwards-compatibility landmine that (b) does not.** If (a) were
   implemented *inside* `shapeSignature` (`convergence.ts:119`) — the obvious reading of
   "canonicalize wherever a signature input is built" — then every already-persisted
   receipt would fail `validReceipt` (`convergence.ts:123`, which recomputes
   `shapeSignature(receipt.before)` and compares it to the *stored* `expectedSignatures[0]`),
   because stored signatures were computed with the raw rule. `normalizeJournal`
   (`convergence.ts:25`) would then pause every workspace with `"ambiguous-operation"` on the
   first storage read after upgrade — including workspaces that are currently healthy, and
   including the `"consumed"` receipts that `rebuildJournal` (`convergence.ts:106`)
   deliberately preserves. That is a self-inflicted mass-pause on release day.
3. **Blast radius.** (b) is one function plus two small helpers; (a) is a cross-file audit.
4. **Rollback (C4).** Under (b) a revert restores exact prior behavior with no journal
   rewriting, because nothing was ever written differently.

**Rejected alternatives.**

- *(a) canonicalize at signature build.* Rejected for reasons 1-4 above. Note the proposal
  requires "either, not both" — (a) is explicitly not implemented.
- *(a') canonicalize only the values stored in the receipt, keeping raw for the Chrome call.*
  Technically satisfies the letter of C1 but creates a receipt whose `expectedAfter.url`
  differs from the argument actually sent to Chrome, which makes the receipt a worse
  forensic record and doubles the number of URL variables in `applyRemoteBookmarkUpsert`.
- *(c) reconciliation redesign / (d) force-unpause.* Out of scope per proposal.md:15-16.

**Consequence to be explicit about:** `callbackMatches` will no longer compare against
`receipt.expectedSignatures[1]`. That is not a weakening of tamper detection, because
`callbackMatches` already calls `validReceipt(receipt)` first, and `validReceipt`
(`convergence.ts:123`) asserts `expectedSignatures[1] === shapeSignature(receipt.expectedAfter)`.
So `expectedAfter` is provably the same content the stored signature attests to. **Invariant
to preserve in review: `callbackMatches` must keep `validReceipt(receipt) &&` as its first
conjunct.**

---

## 3. ADR-002 — The canonicalizer is WHATWG `new URL(raw).href`, total, url-only

**Decision.** Do not hand-roll the trailing-slash rule. Canonical form is
`new URL(raw).href`, applied symmetrically to both sides, with a raw-equality fast path and
a raw fallback on parse failure.

```ts
// extension/src/background/convergence.ts — new exported helper, placed next to shapeSignature (~line 119)
export function canonicalUrlForComparison(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}
```

**Rationale.**

1. **Bounded, not unbounded.** The task brief flags an ad-hoc canonicalizer as a real risk.
   The boundary here is a *spec* (WHATWG URL parsing/serialization), not a growing list of
   guesses. Chrome's bookmark store canonicalizes through GURL, which is the same
   canonicalizer family that Blink exposes as `new URL()` — so this is the closest available
   proxy for "what Chrome did to my string", not an invented rule.
2. **It covers the confirmed case and the enumerated speculative ones in one stroke**, with
   no per-rule code:
   - trailing slash on bare origin — `https://admin.com` → `https://admin.com/` (**the confirmed incident**, exploration.md:19)
   - default port stripping — `https://x:443/a` → `https://x/a`, `http://x:80/` → `http://x/`
   - scheme/host lowercasing — `HTTPS://Admin.COM/` → `https://admin.com/`
   - IDN → punycode — `https://ñ.com` → `https://xn--ida.com/` (Chrome stores punycode)
   - percent-encoding of characters WHATWG requires encoding in the path/query
3. **It does not over-collapse (proposal.md:50).** WHATWG serialization preserves path,
   query, fragment, and credentials, and does *not* decode existing percent-escapes — so
   `https://x/a%2Fb` and `https://x/a/b` stay distinct. The only distinctions it erases are
   distinctions Chrome itself erases; since Chrome's stored value is the ground truth we are
   comparing against, erasing exactly those is correct by construction.
4. **C2 is enforced by call-site discipline that is trivial to review:** the helper takes a
   `string` URL, not a shape. `title` is compared with `===` in `sameShape` below.

**C3 verification — the accepted-URL space.**

- Backend gate (`backend/internal/bookmarks/service.go:777-789`, called from `service.go:377`,
  `service.go:476`, `prepare.go:323`): `url.ParseRequestURI` must succeed, scheme must be
  `http`/`https`, host must be non-empty. Every string in that set is an absolute URL with a
  special scheme, which the WHATWG parser accepts — `new URL()` cannot throw on it.
- Live-callback side: URLs come from `getNode()` (`chrome-bookmarks.ts:5-16`), i.e. strings
  Chrome already parsed and stored. Non-`http(s)` bookmark URLs a user may have locally
  (`javascript:`, `file:`, `chrome://`) also parse without throwing.
- `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.ts` (the import path from the
  bookmark-management change) **does not exist in this tree yet** — that change is still an
  unapplied `openspec/changes/workspace-bookmark-management/` proposal. Its URLs reach the
  extension only after passing the same backend `validateURL`, so it cannot widen the space.
- The residual "cannot parse" cases (empty string, whitespace-only) are handled by the
  `catch` → raw fallback, which degrades to today's exact behavior. **The canonicalizer has
  no throwing path.**
- Folders have `url === undefined`; `sameUrl` short-circuits on `left === right` before any
  parse (`undefined === undefined` → `true`), so folder receipts never enter the parser.

**Rejected alternative:** hand-rolled `url.replace(/^(https?:\/\/[^/]+)$/, "$1/")`. Fixes
only the one confirmed symptom, is a permanent invitation to accrete more regex rules, and
would leave the `:443`/case/punycode variants as future incidents of the exact same shape.

**Deliberately deferred (documented, not implemented):** no attempt is made to model
Chrome-specific behavior that WHATWG does *not* perform (e.g. Chrome's display-time
`https://` elision, or any future GURL divergence). If such a case surfaces, it belongs in
`canonicalUrlForComparison` as a follow-up, and the single-call-site design makes that a
one-function change.

---

## 4. ADR-003 — A mismatched callback for a *known* receipt must not become local intent

**This is a correction to exploration.md:21.** The exploration attributes the phantom local
intent to `captureLocalUpdateOrMove` (`projection.ts:621`, reached via `projection.ts:429-458`).
Verified against the source: that is the **second, downstream** capture. The **primary**
capture happens *upstream* of any suppression check:

```
projection.ts:612   await consumeRemoteUpdate(...)         ← runs FIRST
  → projection.ts:1507 consumeRemoteCallback
    → convergence.ts:29 reduceRemoteCallback
      → convergence.ts:32 captureLocalIntent(...)          ← intent queued HERE, unconditionally on non-match
projection.ts:613   if (isSuppressed(id)) return;          ← runs SECOND
projection.ts:621   captureLocalUpdateOrMove(...)          ← the capture exploration.md cited
```

Because `isSuppressed` is checked at `projection.ts:613`, *after* `consumeRemoteUpdate` at
`:612`, **adding `withSuppression` to the update branch does not prevent the primary
capture.** ADR-004 alone therefore cannot satisfy proposal.md:27 ("a failed remote-update
match MUST NOT queue the extension's own write as local intent") or success criterion
proposal.md:65. ADR-003 is required.

**Decision.** Add a third disposition to `reduceRemoteCallback`. When a pending receipt
matches on identity (`exactIdentity`) but fails `callbackMatches`, the callback is *by
definition* the extension's own remote write landing in an unexpected shape — never a user
edit. Return `"rejected"` and capture **no** intent. `"intent"` is reserved for callbacks
with no receipt at all, i.e. genuine local edits.

```ts
// convergence.ts:29 — replaces the current two-disposition version
export function reduceRemoteCallback(
  journal: ConvergenceJournal,
  callback: RemoteCallback,
): { journal: ConvergenceJournal; disposition: "consumed" | "rejected" | "intent"; cursor?: number } {
  const receipts = journal.receipts ?? [],
    match = receipts.find((receipt) => receipt.status === "pending" && exactIdentity(receipt, callback));
  if (match && callbackMatches(match, callback))
    return { disposition: "consumed", journal: { ...journal, receipts: receipts.map((receipt) => receipt === match ? { ...receipt, status: "consumed" } : receipt) } };
  if (match) return { disposition: "rejected", journal: { ...journal, receipts }, cursor: match.cursor };
  return { disposition: "intent", journal: captureLocalIntent({ ...journal, receipts }, callback) };
}
```

Caller update at `projection.ts:1516-1522`:

```ts
    if (result.disposition === "consumed") {
      const pendingReceipt = result.journal.receipts?.find((receipt, index) => before[index]?.status === "pending" && receipt.status === "consumed");
      if (pendingReceipt) projection.lastCursor = Math.max(projection.lastCursor, pendingReceipt.cursor);
      consumed = true;
    } else if (result.disposition === "rejected") {
      projection.convergenceJournal = gateRemoteEffect(result.journal, result.cursor ?? projection.lastCursor, "final-verification-failed");
    }
```

Notes for `sdd-apply`:

- The pause behavior is **unchanged**: a rejected callback still gates with
  `"final-verification-failed"` at the receipt's cursor. Only the intent capture is dropped.
- The existing predicate at `projection.ts:1520` re-derived the match with
  `workspaceId && backendId && chromeId` but **omitted `type`**; `exactIdentity`
  (`convergence.ts:120`) includes `type`. Routing on `result.disposition` unifies the two and
  is a deliberate, very slight tightening.
- `before` (`projection.ts:1510`) is still needed by the `"consumed"` branch — do not delete it.
- Only caller of `reduceRemoteCallback` is `projection.ts:1511` (verified by grep), so the
  return-type widening is contained.

**Rejected alternative:** check `isSuppressed(id)` before `consumeRemoteUpdate` at
`projection.ts:612`. Rejected — `isSuppressed` is *consuming* (`projection.ts:2546` deletes on
read) and an early return would skip receipt consumption entirely, so the receipt would never
clear and `lastCursor` would never advance. That would make the primary bug worse.

**Residual risk (accepted, matches proposal.md:51 row 3):** if a user genuinely edits a
bookmark in the ~sub-second window while a receipt for that exact node is pending, the edit is
discarded rather than queued. Today that edit is queued but then pauses the workspace, and
`drainLocalIntentsNow` (`projection.ts:471`) refuses to drain while paused — so it is already
never delivered. The change converts "silently retained but undeliverable, and re-emitted at
an arbitrary later unpause" into "discarded at the moment the workspace pauses". That is
strictly better for data integrity.

---

## 5. ADR-004 — Mirror `withSuppression` onto the update branch (defense in depth)

`withSuppression` (`projection.ts:2517-2537`) verified, not guessed:

- Signature: `withSuppression<T>(operation: () => Promise<T>, explicitIds?: string[]): Promise<T>`.
- `explicitIds` are added to the module-level `suppressedChromeIds` set (`projection.ts:82`)
  **before** the operation runs (`:2519-2521`).
- If the resolved value is an object with an `id`, that id is *also* suppressed (`:2524-2528`)
  — which is how the create branch covers the not-yet-known new chromeId.
- Release is a `finally` + `setTimeout(..., 250)` (`:2530-2536`) — a fixed 250 ms window, and
  ids are released even when the operation throws.
- Consumption is one-shot: `isSuppressed` deletes on read (`projection.ts:2539-2548`).

**Decision.** Replace `projection.ts:1481-1487` with an exact structural mirror of the create
branch at `projection.ts:1435-1447`, passing `[chromeId]` explicitly:

```ts
  if (existing.title !== bookmark.title || existing.url !== bookmark.url) {
    await withSuppression(
      async () => {
        try {
          return await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
        } catch (error) {
          throw createRemoteApplyError(error, existingContext);
        }
      },
      [chromeId],
    );
  }
```

- The existing outer `try/catch` at `:1481`/`:1485-1487` is folded inside the callback, exactly
  as the create branch folds its own (`:1437-1444`). Error semantics are byte-for-byte
  preserved: same `createRemoteApplyError(error, existingContext)`.
- `[chromeId]` is passed explicitly rather than relying on the `result.id` auto-add, because
  the auto-add path never runs when `updateNode` throws, and the id must be released either way.
- **No new suppression window is introduced** (proposal.md:51 row 3): same helper, same 250 ms,
  same one-shot consumption as the create branch already ships.

**What this actually buys, stated honestly.** Given ADR-003, the primary capture is already
gone. ADR-004 covers the *residual* paths where `consumeRemoteUpdate` returns `false` with **no**
pending receipt for that identity — e.g. a duplicate `onChanged`, a callback arriving after
`pruneReceipts` (`convergence.ts:124`) dropped the record, or a `title`-only update whose receipt
was already consumed. In those cases `projection.ts:613` now short-circuits before
`captureLocalUpdateOrMove` (`:621`). It also removes the asymmetry with the create branch that
made the update branch surprising to read.

**Ordering safety proof (must not regress checkpointing):** suppression must not block receipt
consumption. It cannot, because `consumeRemoteUpdate` runs at `projection.ts:612`, *before*
`isSuppressed` at `:613`. On a successful match the handler returns at `:612` and the suppression
flag is never consumed — it simply expires via the 250 ms timer. `lastCursor` still advances at
`projection.ts:1518`.

**Deliberately NOT included — the move branch (`projection.ts:1473`).** It has the same unwrapped
`updateNode`, but wrapping it would not help and would hide a *different* latent bug:
`persistRemoteReceipt` at `:1472` stores `move`, so `callbackMatches` (`convergence.ts:121`)
requires `callback.kind === "moved"`; the intermediate `updateNode` at `:1473` fires an
`onChanged` first, which matches on identity but fails the kind test → `"rejected"` → pause. That
fires *inside* `consumeRemoteUpdate`, upstream of any suppression check, so `withSuppression`
cannot fix it. Post-ADR-003 it no longer queues a phantom intent, but a remote event that both
moves *and* retitles/re-URLs a bookmark can still spuriously pause. **Out of scope; recorded as
follow-up F-2 below.**

---

## 6. ADR-005 — `rebuildJournal` must drop queued local intents

**Discovered during design; required for proposal.md success criterion 2.** Without it, the
already-stuck production workspaces do **not** recover on Rebuild, and the fix looks like it
worked for about one second.

Trace: every failed match since the incident began queued a phantom intent
(`convergence.ts:32`). `rebuildJournal` (`convergence.ts:105-108`) spreads `...journal` and
therefore **preserves `localIntents`**, while `doResyncWorkspace` wipes every mapping
(`projection.ts:1024-1026`) and re-creates every managed node with fresh chromeIds
(`projection.ts:1041`, `1051-1053`, `1055-1059`). The intent's `eventId` embeds its chromeId
(`convergence.ts:44`), so each of the ~12 observed rebuilds queued a *distinct* intent pointing at
a now-dead chromeId — the dedupe at `convergence.ts:45` never collapses them.

Then `rebuildWorkspace` calls `connectWorkspace` (`projection.ts:403`) → socket ack →
`drainLocalIntents` (`projection.ts:818`) → `drainLocalIntentsNow` → the identity check at
`projection.ts:476-480` (`projection.backendIdByChromeId[deadChromeId] !== backendId`) throws →
catch at `projection.ts:520-525` → `pauseWorkspace(..., "ambiguous-predecessor")`. **The workspace
re-pauses seconds after a successful rebuild, with a different pause reason.**

**Decision.** One line in `rebuildJournal`:

```ts
export function rebuildJournal(journal: ConvergenceJournal): ConvergenceJournal {
  const receipts = normalizedReceipts((journal.receipts ?? []).filter((receipt) => receipt.status === "consumed"));
  const localIntents = (journal.localIntents ?? []).filter((intent) => intent.status === "acked");
  return { ...journal, phase: "replay", receipts, localIntents, repairDisposition: "rebuild", pauseReason: undefined, failedCursor: undefined };
}
```

**Rationale.** Rebuild's existing contract is already destructive to local state: it deletes all
managed Chrome children (`projection.ts:1041`) and rematerializes from backend truth. Any queued,
un-pushed local edit's *Chrome node is destroyed by rebuild regardless* — only the undeliverable
intent record survived. Keeping it is the inconsistency; dropping it is what the surrounding
operation already means. The filter mirrors the receipts filter on the line above (`"consumed"` /
`"acked"`), so the shape of the function is unchanged. `"acked"` records are retained to preserve
the dedupe/eviction history at `convergence.ts:45-51`.

`retryJournal` (`convergence.ts:99-104`) is **not** touched: retry does not wipe mappings, so its
intents remain dispatchable.

**Rejected alternative:** harden `drainLocalIntentsNow` to discard unresolvable intents instead of
pausing. Broader blast radius (live dispatch path, four distinct pre-flight failure modes at
`projection.ts:476-494`), and unnecessary once no new phantom intents are produced (ADR-003) and
existing ones are cleared on rebuild (ADR-005). Recorded as follow-up F-3.

---

## 7. Component and data-flow map

```
 backend event log (immutable, raw URL "https://admin.com")
        │
        ▼  replayEvents / socket
 applyRemoteEnvelope                      projection.ts:1166
        │  (paused gate :1180, pending-receipt gate :1181)
        ▼
 applyRemoteBookmarkUpsert                projection.ts:1378
        ├─ create branch  :1428-1453  → withSuppression(createBookmark)      [unchanged]
        ├─ move branch    :1469-1476  → persistRemoteReceipt + updateNode + moveNode  [unchanged, see F-2]
        └─ update branch  :1478-1487
              ├─ persistRemoteReceipt(raw url)  :1480 ──► createRemoteReceipt  convergence.ts:28
              │                                            └─ shapeSignature (RAW)     :119   [UNCHANGED — C1/C4]
              └─ withSuppression(updateNode(raw url))  ◄── ADR-004
                                   │
                    chrome.bookmarks.update  (Chrome canonicalizes → "https://admin.com/")
                                   │  onChanged
                                   ▼
 handleBookmarkChanged                     projection.ts:606
        ├─ getNode(id)  → Chrome's canonical url          :611
        ├─ consumeRemoteUpdate                            :612
        │     └─ consumeRemoteCallback                    :1507
        │           └─ reduceRemoteCallback               convergence.ts:29  ◄── ADR-003
        │                 ├─ exactIdentity                :120  [unchanged]
        │                 └─ callbackMatches              :121  ◄── ADR-001/002
        │                       └─ sameShape → sameUrl → canonicalUrlForComparison
        ├─ isSuppressed(id)  → early return               :613  ◄── activated by ADR-004
        └─ captureLocalUpdateOrMove                       :621  [now unreachable for our own writes]
```

### 7.1 Exact new code in `convergence.ts`

Placed adjacent to `shapeSignature` (`convergence.ts:119`), which stays **exactly as it is**:

```ts
function shapeSignature(shape: ReceiptNodeShape): string { /* UNCHANGED — still raw */ }

function callbackMatches(receipt: RemoteReceipt, callback: RemoteCallback): boolean {
  return validReceipt(receipt)
    && sameShape(callback.node, receipt.expectedAfter)
    && (callback.kind === "changed"
      ? receipt.move === undefined
      : receipt.move !== undefined && callback.move !== undefined && sameMove(receipt.move, callback.move));
}

function sameShape(actual: ReceiptNodeShape, expected: ReceiptNodeShape): boolean {
  return (actual.parentId ?? null) === (expected.parentId ?? null)
    && (actual.index ?? null) === (expected.index ?? null)
    && actual.title === expected.title          // C2: strict equality, never normalized
    && sameUrl(actual.url, expected.url);
}

function sameUrl(left: string | undefined, right: string | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return canonicalUrlForComparison(left) === canonicalUrlForComparison(right);
}
```

- `?? null` on `parentId`/`index` reproduces `shapeSignature`'s null-coalescing semantics exactly,
  so nothing about identity comparison shifts.
- `sameUrl` is symmetric: both sides are canonicalized, so it works regardless of which side
  happens to hold Chrome's form.
- `validReceipt` (`convergence.ts:123`) is **not** modified — it keeps using raw `shapeSignature`,
  which is what makes ADR-001 reason 2 hold and keeps existing persisted journals valid.

### 7.2 Change inventory

| # | File:line (pre-fix) | Change | ADR |
|---|---|---|---|
| 1 | `extension/src/background/convergence.ts:119` (insert after) | Add exported `canonicalUrlForComparison`, private `sameUrl`, private `sameShape` | 001/002 |
| 2 | `extension/src/background/convergence.ts:121` | `callbackMatches` compares `sameShape(callback.node, receipt.expectedAfter)` instead of `shapeSignature(callback.node) === receipt.expectedSignatures[1]` | 001 |
| 3 | `extension/src/background/convergence.ts:29-33` | `reduceRemoteCallback` gains `"rejected"` + optional `cursor` | 003 |
| 4 | `extension/src/background/convergence.ts:105-108` | `rebuildJournal` filters `localIntents` to `"acked"` | 005 |
| 5 | `extension/src/background/projection.ts:1516-1522` | route on `result.disposition === "rejected"` | 003 |
| 6 | `extension/src/background/projection.ts:1481-1487` | wrap `updateNode` in `withSuppression(..., [chromeId])` | 004 |
| 7 | `extension/tests/convergence.test.mjs` | new test file | §9 |

Not touched: `shapeSignature`, `validReceipt`, `createRemoteReceipt`, `normalizeJournal`,
`exactIdentity`, `sameMove`, `pruneReceipts`, `gateRemoteEffect`, `retryJournal`,
`persistRemoteReceipt`, `chrome-bookmarks.ts`, `bookmark-listeners.ts`, `options.ts`,
`service-worker.ts`, `shared/types.ts`, anything under `backend/` or `admin-web/`.

---

## 8. Self-heal proof — why no migration is needed

Stated as testable design properties, each with its enforcing citation.

**P1 — Receipts are reconstructed, never restored.** `persistRemoteReceipt`
(`projection.ts:1527-1539`) derives receipt content solely from `event` + `bookmark` +
freshly-read `existing`. `rebuildJournal` (`convergence.ts:106`) discards pending receipts, and
`doResyncWorkspace` replays from cursor 0 (`projection.ts:1055`). Therefore no stuck receipt from
a prior build can survive into, or influence, a post-fix run. *Test:* covered by inspection +
T-C1 below (a receipt built from a raw bare-origin URL is consumed by a canonical callback), which
is exactly the reconstructed state.

**P2 — The poisoned cursor now clears.** Full trace for the production workspace:

1. User clicks **Rebuild** (`options.ts:143,146-147`) → `projection/rebuild` →
   `service-worker.ts:79-80` → `rebuildWorkspace` (`projection.ts:400-405`).
2. `rebuildJournal` (`projection.ts:401`): `phase` `"paused"` → `"replay"`, `pauseReason`/
   `failedCursor` cleared, pending receipts dropped, **and (ADR-005) queued phantom intents
   dropped**.
3. `doResyncWorkspace(..., "explicit rebuild", "recovering")` (`projection.ts:999`): fetches the
   backend tree (`:1016`), wipes mappings (`:1024-1026`), clears managed children (`:1041`),
   rematerializes folders (`:1051-1053`).
4. Replay from cursor 0 (`projection.ts:1055-1059`). Events before the poisoned cursor apply as
   before.
5. Poisoned event (cursor 3, `bookmark.updated`, url `"https://admin.com"`) →
   `applyRemoteBookmarkUpsert` → update branch. `existing.url` is `"https://admin.com/"`,
   `bookmark.url` is `"https://admin.com"`, so `updateReceipt === true` (`:1478`) — the raw `!==`
   at `:1478` is deliberately left alone; a redundant `chrome.bookmarks.update` is harmless.
6. `persistRemoteReceipt` (`:1480`) stores `expectedAfter.url = "https://admin.com"` **raw** (C1).
   `withSuppression(updateNode(...))` (ADR-004) sends the **raw** value to Chrome (C1).
7. Chrome stores `"https://admin.com/"` and fires `onChanged` → `handleBookmarkChanged`
   (`projection.ts:606`) → `getNode` returns `"https://admin.com/"` (`:611`) →
   `consumeRemoteUpdate` (`:612`) → `reduceRemoteCallback` → `exactIdentity` matches →
   `callbackMatches` → `sameShape` → `sameUrl("https://admin.com/", "https://admin.com")` →
   `new URL(...).href` on both → `"https://admin.com/" === "https://admin.com/"` → **`true`**.
8. Disposition `"consumed"`; `projection.lastCursor = max(lastCursor, receipt.cursor)`
   (`projection.ts:1517-1518`).
9. Back in the replay loop, the assertion `lastCursor < event.cursor` (`projection.ts:1058`) now
   passes, so replay proceeds to cursor 4+ — including the user's later trailing-slash edit that
   has been unreachable in the log.
10. `doResyncWorkspace` completes (`:1061-1078`): `phase = "live"`, `pauseReason = undefined`,
    `failedCursor = undefined`, `status = "ready"`.
11. `connectWorkspace` (`projection.ts:403`) → socket ack → `drainLocalIntents`
    (`projection.ts:818`) finds **no queued intents** (P3), so it is a no-op instead of the
    re-pause described in ADR-005.

**P3 — Recovery is not re-poisoned by leftover intents.** After step 2 the journal's
`localIntents` contains only `"acked"` records; `drainLocalIntentsNow` selects on
`status !== "acked"` (`projection.ts:472`) and therefore returns immediately at `:473`.

**P4 — No new stuck state is created going forward.** For any future bare-origin (or
default-port/case/IDN-variant) bookmark, step 7 succeeds on the first live apply, so
`deferCheckpoint` clears the same tick the callback lands and `applyRemoteEnvelope` never reaches
its catch at `projection.ts:1246-1260`.

**Pre-existing timing dependency (documented, unchanged, out of scope).** Steps 7-9 rely on the
`onChanged` listener running before the replay loop's assertion at `projection.ts:1058`. The
intervening `await getNode(chromeId)` (`:1489`) and `await updateProjectionState` (`:1233`) yield
to the event loop, which is why non-bare-origin bookmarks converge in production today. **This
design does not change that timing; it only changes the outcome of the comparison the timing
already depends on.** Tests must therefore assert on settled journal state, not on synchronous
call ordering.

---

## 9. Test strategy (Strict TDD — red first)

**Harness reality check.** `extension/` has **zero** test files today (`extension/**/*.test.ts`
and `extension/**/*.mjs` both return nothing). But a harness is already *declared and wired into
CI*: `extension/package.json:10` — `"test:projection": "npm run build && node --test tests/*.test.mjs"`
— and `.github/workflows/ci.yml:72` runs it. The `extension/tests/` directory does not exist, so
that glob currently matches nothing. **Use this harness; do not introduce vitest into
`extension/`.** (`vitest`/jsdom belongs to `admin-web`; the jsdom zero-layout limitation from
earlier this session is a DOM-layout constraint and is irrelevant here — background-script logic
never touches layout.) `sdd-apply` should confirm `npm run test:projection` exits non-zero on a
red test before writing the fix, since a previously-empty glob may have been masking the step.

**Unit level — `extension/tests/convergence.test.mjs` (new), `node:test`, imports
`../dist/background/convergence.js`.** `convergence.ts` has only a type-only import
(`convergence.ts:1`), so the compiled module has **no runtime dependencies and needs no `chrome`
stub** — it is genuinely pure and directly loadable.

Requires exporting `canonicalUrlForComparison` (already specified as `export` in §3). `sameUrl`
and `sameShape` stay private and are covered through the public API.

*Canonicalizer, direct (table-driven):*

- T-U1 `"https://admin.com"` and `"https://admin.com/"` → equal canonical form **(the confirmed incident)**
- T-U2 `"https://x:443/a"` ≡ `"https://x/a"`; `"http://x:80/"` ≡ `"http://x/"`
- T-U3 `"HTTPS://Admin.COM/"` ≡ `"https://admin.com/"`
- T-U4 distinct URLs stay distinct: `"https://x/a"` vs `"https://x/b"`; `"https://x/a%2Fb"` vs `"https://x/a/b"`; `"https://x/?q=1"` vs `"https://x/"`; `"https://x/#a"` vs `"https://x/#b"`
- T-U5 **totality (C3)**: `""`, `"   "`, `"not a url"`, `"javascript:void(0)"`, `"file:///tmp/x"`, `"chrome://bookmarks"` — must return without throwing; unparseable inputs return the raw input unchanged
- T-U6 idempotence: `f(f(x)) === f(x)` for every T-U1..T-U5 input

*Comparison behavior, through the public API (`createRemoteReceipt` + `reduceRemoteCallback`):*

- T-C1 **regression for the incident** — receipt built with `expectedAfter.url = "https://admin.com"`; callback node with `url = "https://admin.com/"`, same parentId/index/title → `disposition === "consumed"`, receipt `status === "consumed"`, `localIntents` empty
- T-C2 identical raw URLs still consume (no behavior change for the common case)
- T-C3 **C2 guard** — same URL, *different title* → **not** consumed. Must be `"rejected"`. Fails loudly if someone ever routes `title` through a canonicalizer.
- T-C4 genuinely different URL (`https://other.com/`) → `"rejected"`, not `"consumed"`
- T-C5 different `parentId` / different `index` → not consumed
- T-C6 folder receipt (`url === undefined` on both sides) → consumed on title match; the parser is never invoked
- T-C7 move semantics preserved: `kind: "changed"` against a receipt with `move` → not consumed; `kind: "moved"` with matching `move` and a canonically-equal url → consumed
- T-C8 `validReceipt` gate intact: a receipt whose `expectedSignatures[1]` has been tampered with → never consumed, even when the shape matches

*ADR-003 (no phantom intent):*

- T-I1 identity-matching but shape-mismatching callback → `disposition === "rejected"`, returned `cursor === receipt.cursor`, and **`journal.localIntents` unchanged (length 0)**
- T-I2 callback with **no** pending receipt for that identity → still `"intent"`, and the intent **is** queued (genuine local edits must not regress)
- T-I3 identity mismatch on `type` only (folder vs bookmark) → `"intent"`, not `"rejected"`

*ADR-005 (rebuild clears queued intents):*

- T-R1 `rebuildJournal` on a journal with `["queued", "sent", "acked"]` intents → only `"acked"` survives
- T-R2 `rebuildJournal` still drops pending receipts, keeps consumed ones, clears `pauseReason`/`failedCursor`, sets `phase: "replay"` and `repairDisposition: "rebuild"` (guards against regressing `convergence.ts:105-108`)
- T-R3 `retryJournal` leaves `localIntents` untouched (asserts the deliberate asymmetry)

*Backwards compatibility (ADR-001 reason 2 — the release-day landmine):*

- T-B1 a receipt whose `expectedSignatures` were produced by the **pre-fix raw** `shapeSignature`
  (hand-written literal string in the fixture, not computed) still passes `validReceipt` — assert
  via `normalizeJournal` **not** returning `phase: "paused"` / `pauseReason: "ambiguous-operation"`.
  This is the test that would have caught a naive direction-(a) implementation.

**Integration level — deliberately not attempted, with justification.**
`applyRemoteBookmarkUpsert` is module-private and `projection.ts` transitively imports
`shared/api.js` (fetch), `shared/websocket.js`, `shared/storage.js` (`chrome.storage`), and
`shared/session.js` (`projection.ts:1-76`). Driving it would require standing up an in-memory
`chrome.storage.local` + `chrome.bookmarks` double, a `fetch` double, and a websocket double —
disproportionate to a one-call wrapping change and beyond the proposal's size budget
(proposal.md:59). Mitigation:

- The **capability** in proposal.md:27 is fully covered at the pure level by T-I1/T-I2 (ADR-003 is
  what actually enforces it — see §4).
- ADR-004's correctness is argued structurally in §5 from the verified `withSuppression`
  implementation (`projection.ts:2517-2537`) and the `:612`-before-`:613` ordering, and is
  enforced at review time by the "exact mirror of `projection.ts:1435-1447`" requirement.
- Add one **manual verification step** to the tasks: load the unpacked build, create a bare-origin
  bookmark remotely, rename it, and confirm the workspace stays `live` with no queued intent in
  the options-page diagnostics.
- Recorded as follow-up **F-1**: a `chrome.*` test double for background integration tests.

**Definition of done for tests:** `cd extension && npm run test:projection` green; `npm run
typecheck` green (the `reduceRemoteCallback` return-type widening is the only typecheck-relevant
signature change).

---

## 10. Out of scope / follow-ups

| ID | Item | Why deferred |
|----|------|--------------|
| F-1 | `chrome.*` test double enabling background-script integration tests | Infrastructure; disproportionate to this bugfix |
| F-2 | Move branch (`projection.ts:1472-1474`) spuriously pauses when a remote event both moves and retitles/re-URLs a bookmark: the intermediate `updateNode` fires `onChanged` against a `move` receipt → `"rejected"` → `gateRemoteEffect`. Discovered during this design; **not** the reported incident and **not** fixable by suppression (fires upstream of `projection.ts:613`) | Different defect, different mechanism, needs its own proposal |
| F-3 | Harden `drainLocalIntentsNow` (`projection.ts:466-528`) to discard permanently-undeliverable intents instead of pausing with `"ambiguous-predecessor"` | Broader blast radius; unnecessary once ADR-003 + ADR-005 ship |
| F-4 | Force-unpause / operator escape hatch (exploration direction d) | proposal.md:15 |
| F-5 | Reconciliation redesign (exploration direction c) | proposal.md:16 |
| F-6 | Chrome-specific normalizations WHATWG does not perform, if any surface | ADR-002; single call site makes it a one-function change |

---

## 11. Risks and assumptions requiring validation

| Risk / assumption | Severity | Validation |
|---|---|---|
| **Assumption:** Chrome's GURL canonicalization is a superset-compatible match for WHATWG `new URL().href` for `http(s)` bookmark URLs | Med | T-U1..T-U4 pin the confirmed and enumerated cases; F-6 is the escape hatch if a divergence appears. `sameUrl`'s raw fast path means any divergence degrades to today's behavior, never worse. |
| **Assumption:** no persisted journal contains a receipt whose stored `expectedSignatures` disagree with its `before`/`expectedAfter` | Med | T-B1 asserts the pre-fix-signature compatibility path explicitly. `shapeSignature`/`validReceipt` are unmodified, so this is preserved by construction. |
| ADR-003 discards a genuine user edit racing a pending receipt | Low | Already undeliverable today (paused-gate at `projection.ts:471`); §4 argues the change is a strict improvement |
| ADR-005 discards a queued local edit at explicit Rebuild | Low | Rebuild already destroys the underlying Chrome node (`projection.ts:1041`); the edit was lost either way |
| 250 ms suppression window swallows a real user edit immediately after a remote update | Low | Pre-existing, identical to the create branch; no new window (proposal.md:51) |
| `extension/tests/` glob currently matches nothing, so CI's `test:projection` step may be silently vacuous | Low | Tasks must confirm the step goes red on a failing test before the fix lands |
| Timing race between `onChanged` and the replay assertion (`projection.ts:1058`) | Med, pre-existing | Explicitly unchanged by this design (§8); tests assert settled state, not ordering. Not in scope. |
| **Correction to exploration.md:21** — the primary phantom-intent capture is `convergence.ts:32`, not `captureLocalUpdateOrMove`; the proposal's "minimal fix: mirror the create branch" is therefore **necessary but not sufficient** | High (scope) | Resolved by ADR-003; ADR-004 retained as defense in depth. Flagged for the proposal author. |
