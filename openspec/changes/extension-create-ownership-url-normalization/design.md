# Design: extension-create-ownership-url-normalization

Surgical bugfix design. **Three production edits across two files** (one predicate, one
filter, one export/import), all inside `extension/src/background/`. No new architecture, no
backend or admin-web change, no persisted-format change, no migration.

Everything below is written against the **current on-disk tree of branch
`fix/extension-create-ownership-url-normalization`** (stacked on `fix/extension-sync-pause-recovery`).
Every line number was re-read from disk for this design and supersedes the line numbers quoted in
`proposal.md`, several of which have drifted. Line numbers are *pre-fix* so `sdd-tasks` can slice
directly.

---

## 1. Constraints this design is bound by

| # | Constraint | Source | How the design satisfies it structurally |
|---|---|---|---|
| C1 | Canonicalization is **comparison-only**. The value passed to `chrome.bookmarks.create` (`projection.ts:1438`, `:1334`) and the value stored in `operation.ownership` / `fingerprint` (`projection.ts:1745`, `:1756`) must stay byte-identical to today. | proposal.md:17 | ADR-101 changes exactly one boolean sub-expression inside `finishRemoteCreate`. No value-producing site is touched, so C1 cannot be violated by this diff or by a later refactor of it. |
| C2 | Only `url` is normalized. `parentChromeId`, `index`, `title` keep strict `!==`. | proposal.md:12 | ADR-101 replaces one of five `||` clauses at `projection.ts:1768`; the other four are copied through unchanged in the diff. |
| C3 | Folder creates share `finishRemoteCreate` and must keep verifying with `url === undefined` on both sides. | proposal.md:12 | ADR-102 reuses `sameUrl`, whose first statement is `if (left === right) return true` (`convergence.ts:135`) — `undefined === undefined` short-circuits before any parse. Typed proof in §3.3. |
| C4 | No second canonicalizer. Reuse `canonicalUrlForComparison`. | proposal.md:12 | ADR-102 reuses the *predicate* (`sameUrl`), not just the canonicalizer, so there is exactly one place in the repo that defines "same URL modulo Chrome normalization". |
| C5 | No persisted-schema change; a revert must leave journals readable. | proposal.md:62 | `ConvergenceOperation` / `ConvergenceJournal` (`shared/types.ts:184-215`) are untouched. Only in-memory comparison logic plus one additional filter in an existing repair function. |
| C6 | Already-stuck installs must recover via manual Rebuild. No auto-repair-on-upgrade. | proposal.md:78 | ADR-103 adds the filter to `rebuildJournal` only — the function reached exclusively from the user-initiated `rebuildWorkspace` (`projection.ts:400-405`). `normalizeJournal` and `retryJournal` are untouched, so nothing repairs itself silently on read. |
| C7 | Size budget: single small PR, well under the 400-line review budget. | proposal.md:49 | ~6 changed lines of production code + tests appended to two existing test files. |

---

## 2. What the current code actually does (verified, not quoted from the proposal)

`proposal.md:5` cites `projection.ts:1758-1769` and `proposal.md:13` cites `convergence.ts:105-108`.
**Both have drifted.** Current, re-read from disk:

```ts
// extension/src/background/projection.ts:1763-1774  (CURRENT)
async function finishRemoteCreate(workspaceId: string, id: string, chromeId: string): Promise<void> {
  const node = await getNode(chromeId);
  await updateProjectionState(workspaceId, (projection) => {
    const journal = projection.convergenceJournal, operation = journal?.operations.find((item) => item.id === id), ownership = operation?.ownership;
    if (!journal || !operation || !ownership) return;
    if (!node || node.parentId !== ownership.parentChromeId || node.index !== ownership.index || node.title !== ownership.title || node.url !== ownership.url) { journal.phase = "paused"; journal.pauseReason = "ambiguous-operation"; return; }
    operation.chromeId = chromeId; operation.status = "done";
    if (journal.pauseReason === "ambiguous-operation") { journal.phase = "live"; journal.pauseReason = undefined; }
    const done = journal.operations.filter((item) => item.ownership && item.status === "done");
    if (done.length > 20) journal.operations = journal.operations.filter((item) => !done.slice(0, -20).includes(item));
  });
}
```

```ts
// extension/src/background/convergence.ts:111-115  (CURRENT — already carries the sibling change's localIntents filter)
export function rebuildJournal(journal: ConvergenceJournal): ConvergenceJournal {
  const receipts = normalizedReceipts((journal.receipts ?? []).filter((receipt) => receipt.status === "consumed"));
  const localIntents = (journal.localIntents ?? []).filter((intent) => intent.status === "acked");
  return { ...journal, phase: "replay", receipts, localIntents, repairDisposition: "rebuild", pauseReason: undefined, failedCursor: undefined };
}
```

Two non-obvious behaviors, both verified, that the rest of this design depends on:

**B1 — the pause at `:1768` is durable, and the unpause at `:1770` is a *compensation* for a
deliberate transient.** `updateState` (`shared/storage.ts:49-56`) is read-modify-**write**: it calls
`getState()` (`:51`), which runs `normalizeProjectionState` → `normalizeJournal`
(`shared/storage.ts:82-90`, `:89`) on every projection, then persists the result (`:53`).
`normalizeJournal:25` pauses with `"ambiguous-operation"` whenever **any** operation has
`status: "started"`. So between `startRemoteCreate`'s write (`projection.ts:1747-1759`) and
`finishRemoteCreate`'s write (`:1765`), the journal is *legitimately and durably* paused —
that is the crash-safety design, asserted by the existing test
`create-ownership.test.mjs:237-239`. Line `:1770` is what clears it once ownership is proven.
**Consequence: when the `url` comparison at `:1768` returns early, the transient pause is never
compensated and becomes permanent.** The bug is not "a pause is introduced"; it is "an
already-present pause is never lifted".

**B2 — `finishRemoteCreate` does not set `failedCursor`.** It writes `phase`/`pauseReason` only
(`:1768`). Two readings of the reported production state (`failedCursor: 11`) are possible; see
A-1 in §11. Both converge on the same trace and the same fix, so nothing in this design depends
on resolving it.

---

## 3. ADR-101 — Make only the `url` clause of `finishRemoteCreate`'s final-shape check normalization-aware

**Decision.** Replace exactly one of the five `||` clauses at `projection.ts:1768`.

```diff
-    if (!node || node.parentId !== ownership.parentChromeId || node.index !== ownership.index || node.title !== ownership.title || node.url !== ownership.url) { journal.phase = "paused"; journal.pauseReason = "ambiguous-operation"; return; }
+    if (!node || node.parentId !== ownership.parentChromeId || node.index !== ownership.index || node.title !== ownership.title || !sameUrl(node.url, ownership.url)) { journal.phase = "paused"; journal.pauseReason = "ambiguous-operation"; return; }
```

**Rationale.**

1. **The defect is exclusively a `url` defect.** `node.parentId`, `node.index` and `node.title`
   are echoed back by Chrome verbatim: `parentId`/`index` are ids and integers Chrome assigns and
   we then read back, and `title` is stored uninterpreted. `url` is the only field Chrome routes
   through GURL canonicalization. Widening the relaxation to any other field would weaken
   ownership proof for zero evidence (C2).
2. **`!node` stays first.** A missing node must still pause — `sameUrl(undefined, undefined)` would
   otherwise return `true` for folder creates and let a *deleted* node be claimed as owned. The
   `!node ||` guard short-circuits before any field access, so this ordering is load-bearing.
   **Invariant to preserve in review: `!node ||` must remain the first disjunct.**
3. **No `getNode` change.** `getNode` (`chrome-bookmarks.ts:5-16`) returns Chrome's stored node
   as-is. Canonicalizing at the read site would leak a canonical URL into `projection.ts`'s
   update/move branches (`:1473`, `:1478`) where it is compared against and written back to
   backend truth — a C1 violation. The comparison stays local to the predicate.

**Rejected alternatives.**

- *Canonicalize `ownership.url` at admission (`startRemoteCreate:1745`).* Rejected: `ownership` is
  serialized into `operation.fingerprint` (`:1745`, `:1756`) and read by `ownsRemoteCreate`
  (`:1832`); rewriting it changes persisted content and the operation identity of in-flight
  journals — a C1 and C5 violation, and exactly the release-day landmine the sibling design
  rejected as direction (a) (`extension-sync-pause-recovery/design.md:32-47`).
- *Drop the `url` check entirely.* Rejected: it is the only field that distinguishes two bookmarks
  with the same title in the same parent at the same index — which is precisely the adoption
  ambiguity the ownership record exists to rule out.
- *Compare `canonicalUrlForComparison(node.url ?? "") === canonicalUrlForComparison(ownership.url ?? "")`.*
  Rejected: collapses `undefined` (folder) and `""` (malformed bookmark) into the same value,
  silently violating C3's intent, and duplicates `sameUrl`'s logic (C4).

---

## 4. ADR-102 — Export `sameUrl` from `convergence.ts` rather than reimplementing the predicate in `projection.ts`

This is the one genuine fork in this change, and it is a **deliberate revision of the sibling
design**, which stated "`sameUrl` and `sameShape` stay private and are covered through the public
API" (`extension-sync-pause-recovery/design.md:507-508`). That statement was correct when
`convergence.ts` was the only consumer. It no longer is.

**Decision.** Change `convergence.ts:134` from `function sameUrl` to `export function sameUrl`, and
add `sameUrl` to the existing convergence import at `projection.ts:76`.

```diff
-function sameUrl(left: string | undefined, right: string | undefined): boolean {
+export function sameUrl(left: string | undefined, right: string | undefined): boolean {
   if (left === right) return true;
   if (left === undefined || right === undefined) return false;
   return canonicalUrlForComparison(left) === canonicalUrlForComparison(right);
 }
```

```diff
-import { canPersistReceipt, captureLocalIntent, createRemoteReceipt, emptyJournal, gateRemoteEffect, normalizedReceipts, rebuildJournal, reduceRemoteCallback, retryJournal, type RepairGate } from "./convergence.js";
+import { canPersistReceipt, captureLocalIntent, createRemoteReceipt, emptyJournal, gateRemoteEffect, normalizedReceipts, rebuildJournal, reduceRemoteCallback, retryJournal, sameUrl, type RepairGate } from "./convergence.js";
```

**Rationale.**

1. **One definition of "same URL", not two.** The system now has two independent sites asking the
   same question — `sameShape` (`convergence.ts:139-144`, receipt path) and `finishRemoteCreate`
   (`projection.ts:1768`, ownership path). Follow-up F-6 in the sibling design
   (`extension-sync-pause-recovery/design.md:581`) explicitly anticipates a future
   Chrome/WHATWG divergence being fixed "in `canonicalUrlForComparison` as a follow-up, and the
   single-call-site design makes that a one-function change". Reimplementing the three-line
   `undefined` guard in `projection.ts` breaks that promise: a future fix that has to change the
   *guard* rather than the *canonicalizer* would then need two edits, and the second one is easy
   to miss. C4 is satisfied in letter by importing only the canonicalizer, but satisfied in spirit
   only by importing the predicate.
2. **No module-boundary novelty.** `projection.ts:76` already imports nine values plus a type from
   `./convergence.js`. `convergence.ts` has a single type-only import (`convergence.ts:1`), zero
   runtime dependencies, and is the designated pure-logic module; `projection.ts` is its only
   production consumer. Adding a tenth pure function to that list is not a boundary change — it is
   the boundary working as designed.
3. **It converts a private helper into directly testable API.** `extension/tests/convergence.test.mjs`
   imports `../dist/background/convergence.js` directly with no `chrome` stub. Exporting `sameUrl`
   lets the `undefined`-safety property (C3) be pinned by a two-line unit test (T-U7) instead of
   being inferred through `reduceRemoteCallback`.
4. **The export list has no ordering or grouping convention to violate.** `convergence.ts` exports
   are interleaved with private helpers throughout the file (`:100-101` exported, `:122-126`
   private, `:127` exported, `:134` private). Flipping one keyword in place introduces no
   inconsistency.

**Rejected alternatives.**

- *Import only `canonicalUrlForComparison` and inline the guard at `projection.ts:1768`.* This was
  the proposal's literal wording (`proposal.md:12`). Rejected for reason 1, and because the
  inlined form is unreadable inside an already 5-clause single-line conditional:
  `(node.url === ownership.url || (node.url !== undefined && ownership.url !== undefined && canonicalUrlForComparison(node.url) === canonicalUrlForComparison(ownership.url)))`.
  The folder case (C3) becomes a subtle short-circuit buried in a 240-character line — the single
  most likely thing for a future editor to "simplify" incorrectly.
- *Add a new `ownershipMatchesNode(node, ownership)` helper to `convergence.ts`.* Rejected: it
  would drag `ConvergenceOperation["ownership"]` and `chrome.bookmarks.BookmarkTreeNode` into the
  comparison layer and would re-express the exact-match semantics of `parentChromeId`/`index`/
  `title` in a second place — a larger surface for no benefit, and it moves C2 enforcement away
  from the site a reviewer reads.
- *Move `finishRemoteCreate`'s predicate into `convergence.ts` wholesale.* Rejected: same as above,
  plus it would make a pure module depend on the Chrome node shape.

**Cost, stated honestly.** The public surface of `convergence.ts` grows by one function. `sameUrl`
is pure, total (it delegates to `canonicalUrlForComparison`, which is total by
`extension-sync-pause-recovery/design.md:111-127`), and has no persisted representation, so the
export carries no compatibility obligation.

### 4.3 C3 proof — `undefined` handling for folder creates, from the type definitions

- `ConvergenceOperation["ownership"]` (`shared/types.ts:191`) declares `url?: string`, so
  `ownership.url` is `string | undefined`. `startRemoteCreate` is called with `undefined` for the
  folder path (`projection.ts:1329`, argument 7) and with `bookmark.url` for the bookmark path
  (`:1433`); its parameter is typed `url: string | undefined` (`:1744`).
- `node` is `chrome.bookmarks.BookmarkTreeNode | null` (`chrome-bookmarks.ts:5`), whose `url` is
  optional — `string | undefined` after the `!node` guard.
- `sameUrl(left: string | undefined, right: string | undefined)` (`convergence.ts:134`) therefore
  typechecks exactly at the call site with no cast and no `??` coercion.
- **Folder create:** Chrome never assigns a `url` to a folder, so `node.url === undefined` and
  `ownership.url === undefined` → `left === right` at `convergence.ts:135` → `true`. The parser is
  never entered. Pinned by T-P2 and by the existing folder fixture in
  `create-ownership.test.mjs:107-128`, which must stay green.
- **Bookmark create where Chrome did not normalize** (the overwhelmingly common case, e.g.
  `https://remote.test/`): `left === right` → `true` on the same fast path, so the parser is not
  entered there either. **The canonicalizer runs only on the previously-broken path.** This bounds
  the behavioral blast radius of the whole change to inputs that fail today.
- **Mixed `undefined`** (a folder create that somehow produced a URL-bearing node, or vice versa):
  `convergence.ts:136` returns `false` → pause. Correctly preserved as a genuine mismatch.

---

## 5. ADR-103 — `rebuildJournal` must drop non-`done` operations

**Required, not optional** (`proposal.md:13`, `:34-39`). Without it the fix is invisible to every
already-affected install. §8 proves the current Rebuild not only fails to recover but actively
*throws*.

**Decision.** One added filter, mirroring the two already present:

```ts
export function rebuildJournal(journal: ConvergenceJournal): ConvergenceJournal {
  const receipts = normalizedReceipts((journal.receipts ?? []).filter((receipt) => receipt.status === "consumed"));
  const localIntents = (journal.localIntents ?? []).filter((intent) => intent.status === "acked");
  const operations = (journal.operations ?? []).filter((operation) => operation.status === "done");
  return { ...journal, phase: "replay", receipts, localIntents, operations, repairDisposition: "rebuild", pauseReason: undefined, failedCursor: undefined };
}
```

`(journal.operations ?? [])` matches the defensive style of the two lines above it;
`normalizeJournal:16` already guarantees `operations` is an array on any journal that came through
storage, but `rebuildJournal` is also called with `emptyJournal()` (`projection.ts:401`) and from
tests with hand-built literals.

**Retention rule chosen: keep `"done"`, drop everything else.** Symmetric with
`receipts → "consumed"` and `localIntents → "acked"` — in all three cases the terminal status is
kept for its dedupe/suppression value and non-terminal records are discarded.

### 5.1 Safety per operation kind — verified against production reachability, not assumed

`ConvergenceOperation["kind"]` is `"create" | "adopt" | "reconcile" | "delete"`
(`shared/types.ts:186`); `status` is `"planned" | "started" | "done"` (`:190`).

| Kind | Produced by | Statuses reachable in a **persisted** journal | Safe to drop when non-`done`? |
|---|---|---|---|
| `create` | `startRemoteCreate` (`projection.ts:1756`) | `started` → `done` | **Yes** — see (a) |
| `delete` | `startRemoteDelete` (`projection.ts:1791`) | `started` → `done` | **Yes** — see (b) |
| `adopt` | `plan()` only (`convergence.ts:87`) | *none* — see (c) | Vacuous |
| `reconcile` | `plan()` only (`convergence.ts:87`) | *none* — see (c) | Vacuous |
| `planned` status | `plan()` only (`convergence.ts:87`, `:90`) | *none* — see (c) | Vacuous |

**(c) The planner is dead code in production.** `plan()` (`convergence.ts:62-93`) is the only
producer of `status: "planned"` and of kinds `adopt`/`reconcile`. Grepping `\bplan\b` across
`extension/src` returns four hits: the `"plan"` phase literal (`convergence.ts:12`), the
declaration (`:62`), the `"plan"` phase assignment in `checkpoint` (`:119`), and the
`ConvergencePhase` union (`shared/types.ts:182`). **`plan()` has no call site outside
`extension/tests/convergence.test.mjs`.** No persisted journal can contain a `planned` operation
or an `adopt`/`reconcile` operation. The filter is therefore exhaustively characterized by rows
(a) and (b).

**(a) `create`.** `startRemoteCreate` admits at `status: "started"` (`projection.ts:1756`);
`finishRemoteCreate` is the sole transition to `"done"` (`:1769`). A persisted `started` create
means one of: (i) the shape check at `:1768` failed — **this incident**; (ii) the service worker
died between `:1433` and `:1451`. In case (i) the Chrome node exists but ownership was never
proven; in case (ii) the Chrome node may or may not exist. Rebuild resolves both by construction:
`doResyncWorkspace` wipes all mappings (`projection.ts:1019-1027`), deletes every managed child
(`clearManagedChildrenWithSuppression`, `:1041`) and rematerializes the entire subtree from the
backend tree (`:1051-1053` → `materializeFolder:1132-1150` → `materializeBookmark:1152-1164`).
The Chrome node the stale operation claimed ownership of **no longer exists** after `:1041`, so
the record is not merely undeliverable — it is meaningless. Retaining it can only re-pause.

**(b) `delete`.** `deleteChromeNode` (`projection.ts:1650-1669`) is a straight-line await chain:
`startRemoteDelete` (`:1659`, admits `"started"` at `:1791`) → `withSuppression(removeTree|removeNode)`
(`:1661-1667`) → `finishRemoteDelete` (`:1668`). **The exact line that marks a delete operation
done is `projection.ts:1811`** (`current.status = "done"; if (…pauseReason === "ambiguous-operation") { …phase = "live"; …pauseReason = undefined; }`), reached only after the guard at `:1799`
(`await getNode(ownership.chromeId)` must be falsy — i.e. Chrome really removed the node) and the
mapping-cleanliness check at `:1808-1809`. Deletes additionally have a **second** termination path
that creates lack: `ownsRemoteDelete` (`:1817-1824`) calls `finishRemoteDelete` for any still-
`started` delete op observed on the `onRemoved` callback (`:1821`).

  This is the precise form of `proposal.md:79`'s claim, and it is slightly different from how the
  proposal words it. Both start/finish pairs are straight-line; the real asymmetry is
  **verification surface**: delete's proof of completion is *"the node is gone"* (`:1799`) — an
  existence test with no value comparison and therefore **no normalization surface at all**.
  Chrome cannot canonicalize a node back into existence. Create's proof is a four-field value
  comparison (`:1768`), of which `url` is normalization-exposed. That is why only `create`
  operations are observed sitting in `"started"` in production journals, and why no `delete`
  operation can ever be wedged by this class of defect.

  A `delete` op *can* still be persisted as `started` — worker death between `:1659` and `:1668`,
  or a genuine failure at `:1799`/`:1809`. Dropping it at Rebuild is safe: everything
  `finishRemoteDelete` would have done is superseded by Rebuild itself — mapping removal
  (`:1807`) by the wipe at `projection.ts:1024-1026` and `removeMappingsByChromeIds` at `:1043`;
  exclusion pruning (`:1810`) by `pruneExclusions(projection, validIds)` at `:1031`; the Chrome
  node itself by `:1041`. There is **no state a stuck delete operation would have cleaned up that
  survives a rebuild.**

**Why retained `"done"` operations are still worth keeping.** They are read by `ownsRemoteCreate`
(`projection.ts:1833`: `operation.status === "done" && operation.chromeId === id`) to suppress a
very late duplicate `onCreated` for an already-mapped node — the property pinned by
`create-ownership.test.mjs:178-192`. After a rebuild every retained `chromeId` is dead, so the
records are inert rather than useful; they are retained anyway to keep the diff minimal, to keep
the function shape symmetric with the two filters above it, and to preserve the last-20 pruning
window at `projection.ts:1771-1772`.

### 5.2 Interaction with `startRemoteCreate`'s overflow eviction — orthogonal, and strictly relieving

`startRemoteCreate:1751-1755`:

```ts
const maximum = existing ? 500 : 499;
while (journal.operations.length > maximum) {
  const oldestDone = journal.operations.findIndex((operation) => operation.id !== id && operation.ownership && operation.status === "done");
  if (oldestDone < 0) { journal.phase = "paused"; journal.pauseReason = "operation-overflow"; projection.convergenceJournal = journal; return; }
  journal.operations.splice(oldestDone, 1);
}
```

1. **Different lifecycle points.** The eviction loop runs at *admission time*, inside
   `startRemoteCreate`, on the live path. The rebuild filter runs at *repair time*, inside
   `rebuildWorkspace` (`projection.ts:401`). They never execute in the same `updateState`
   transaction (`shared/storage.ts:49-56` serializes mutations via `enqueueStateMutation`).
2. **The filter only shrinks `operations.length`.** It therefore makes the `while` condition
   *less* likely to hold and the `oldestDone < 0` overflow pause *less* likely to fire. It cannot
   push the journal over a cap.
3. **The filter never removes the eviction loop's fuel.** The loop can only evict entries with
   `ownership && status === "done"` — exactly the set the filter *retains*. It removes only the
   entries the loop considers non-evictable. Post-rebuild, 100% of retained operations are
   evictable, which is the best possible state for the loop.
4. **Same one-directional relationship with `normalizeJournal`'s cap** (`convergence.ts:17`,
   `operations.length > 500` → `pause(…, "operation-overflow")`): fewer operations, never more.

**Conclusion: orthogonal, and monotonically improving where they touch.** No coordination needed.

**Not touched: `retryJournal` (`convergence.ts:105-110`).** Retry does not wipe mappings and does
not delete Chrome nodes, so a `started` operation there may still refer to a live node whose
ownership is genuinely unresolved. Dropping it would silently forfeit ownership proof and let
`ownsRemoteCreate:1833` fall through to a duplicate backend mutation. Retry's existing behavior
already forces `repairDisposition: "rebuild"` for the unsafe cases (`:107-108`), which routes the
user to the function that *does* clear them. This asymmetry mirrors the sibling design's
`localIntents` decision (`extension-sync-pause-recovery/design.md:327-328`) and is pinned by T-R6.

---

## 6. ADR-104 — `normalizeJournal` is deliberately left alone; the residual transient is pre-existing and self-clearing

**Question addressed:** after `rebuildJournal` drops non-`done` operations, can `normalizeJournal`
(`convergence.ts:25`) see a stale `"started"` operation again on a subsequent read, before replay
re-populates it?

**Decision.** No change to `normalizeJournal`. Traced answer below.

**Trace, post-fix, in transaction order.** Recall B1: every `updateProjectionState` →
`updateState` → `getState()` re-runs `normalizeJournal` and then persists the normalized result.

| # | Site | Journal state entering `normalizeJournal` | Verdict at `convergence.ts:25` |
|---|---|---|---|
| 1 | `rebuildWorkspace:401`, inside `updateState`'s `getState()` at `storage.ts:51` | stored journal, still holding the stale `started` create | `paused`/`ambiguous-operation` — **then immediately overwritten** by `rebuildJournal`, which sets `phase: "replay"`, `pauseReason: undefined` and (new) `operations: [done…]`. The write at `storage.ts:53` persists the rebuilt journal. |
| 2 | first `getState()` in `doResyncWorkspace:1000` | no `started` operations | first disjunct `false`. Second disjunct `receipts.some(r => !validReceipt(r))`: `rebuildJournal` retained only `"consumed"` receipts, and `validReceipt` (`convergence.ts:154`) accepts `"consumed"` when both stored signatures still match — they were computed by the unmodified `shapeSignature` (`:126`). `false`. → **no pause** |
| 3 | every read during the wipe/materialize phase (`:1009`, `:1019`, `:1030`, `:1042`, `:1141`, `:1161`, …) | unchanged: `materializeFolder`/`materializeBookmark` write **mappings only** (`:1141-1143`, `:1161-1163`) and never touch `convergenceJournal` | **no pause** |
| 4 | replay loop `:1055-1059` | see below | see below |
| 5 | finalize `:1061-1078` | forces `phase = "live"`, `pauseReason`/`failedCursor` `undefined` (`:1067-1071`) | terminal |

**Step 4 in detail.** For each replayed event, `applyRemoteBookmarkUpsert` calls
`reconcileBookmarkChromeNode` (`:1424`). Because step 3 already materialized every node present in
the freshly fetched backend tree and set its mapping, `reconcileBookmarkChromeNode:2325-2330`
finds `mappedId`, `getNode(mappedId)` succeeds, and it **returns the mapped id** — so the create
branch (`:1428-1453`) is not entered and `startRemoteCreate` is never called. **No new `started`
operation is created during the dominant replay path.** (The event instead falls through to the
update/move branches at `:1455-1493`, which are receipt-based and were fixed by the sibling
change.)

The create branch *can* still run during replay for an event whose entity is absent from the
current tree snapshot — e.g. a `bookmark.created` at cursor *n* for a node deleted at cursor *m > n*,
or an entity excluded by `isExcluded` (`:1134`, `:1154`). In that case `startRemoteCreate` writes
`started` (`:1756`) and every read until `finishRemoteCreate` (`:1451`) normalizes to
`paused`/`ambiguous-operation` — including the `setMapping` write at `:1448-1450`. That window is
closed within the same await chain by `:1770`.

**Verdict.**

- **No stale-operation re-pause window exists.** The set of `started` operations is empty from the
  end of transaction 1 onward, and the only writer that can re-populate it (`startRemoteCreate`)
  is followed unconditionally by `finishRemoteCreate` in the same straight-line function body
  (`projection.ts:1433` → `:1451`; folder path `:1329` → `:1347`).
- **A transient `started`-operation pause during a *fresh* create is real, pre-existing, deliberate
  and out of scope.** It is the durable-ownership property the codebase intentionally has
  (`create-ownership.test.mjs:214-245`), it is compensated at `:1770`, and it only survives a
  crash — which is exactly when a human-initiated Rebuild is the intended remedy (C6). Removing it
  would require redesigning the workspace-wide pause gate, explicitly ruled out by
  `proposal.md:80`.
- **`:1770` sets `phase = "live"`, not back to `"replay"`.** Verified harmless: the only phase gate
  in the replay path is `applyRemoteEnvelope:1180` (`phase === "paused"` → return), which `"live"`
  passes, and `doResyncWorkspace:1067-1071` forces `"live"` at the end regardless. Pre-existing
  behavior, unchanged here; noted so a reviewer does not read it as a new inconsistency.

**Rejected alternative:** make `normalizeJournal:25` ignore `started` operations younger than some
TTL, or scope its pause to the owning workspace. Rejected — that is the pause-gate redesign
excluded by `proposal.md:80` and would weaken the crash-safety invariant pinned by
`create-ownership.test.mjs:237-239`.

---

## 7. Component and data-flow map

```
 backend event log (immutable, raw url "https://pruebs")
        │
        ▼  replayEvents / socket
 applyRemoteEnvelope                              projection.ts:1166
        ├─ cursor gate            :1177   (event.cursor <= lastCursor → return)
        ├─ PAUSE GATE             :1180   (phase === "paused" → return)  ◄── workspace-wide blocker
        ├─ pending-receipt gate   :1181
        ▼
 applyRemoteBookmarkUpsert                        projection.ts:1378
        ├─ reconcileBookmarkChromeNode  :1424 → :2318-2344
        │     └─ mapped short-circuit   :2325-2330   ◄── why replay never re-enters the create branch
        ├─ CREATE branch  :1428-1453
        │     ├─ startRemoteCreate      :1433 → :1744-1761
        │     │     └─ push { status: "started", ownership:{ …, url: RAW } }  :1756   [UNCHANGED — C1]
        │     │        └─ every later getState() → normalizeJournal:25 → paused/ambiguous-operation  (B1)
        │     ├─ withSuppression(createBookmark(RAW url))  :1435-1447          [UNCHANGED — C1]
        │     │        └─ Chrome canonicalizes → stores "https://pruebs/"
        │     ├─ setMapping             :1448-1450
        │     └─ finishRemoteCreate     :1451 → :1763-1774
        │           ├─ getNode(chromeId)                :1764  → url "https://pruebs/"
        │           ├─ four-field shape check           :1768  ◄── ADR-101 (url clause only)
        │           │     └─ sameUrl → canonicalUrlForComparison    convergence.ts:134 / :127  ◄── ADR-102
        │           ├─ status = "done"                  :1769
        │           └─ CLEAR the transient pause        :1770  ◄── the line the bug prevents reaching
        ├─ move branch    :1469-1476   [unchanged; receipt-based, sibling change]
        └─ update branch  :1478-1493   [unchanged; receipt-based, sibling change]

 rebuildWorkspace (user clicks Rebuild)            projection.ts:400-405
        ├─ rebuildJournal                          convergence.ts:111-115  ◄── ADR-103
        │     └─ operations.filter(status === "done")
        └─ doResyncWorkspace                       projection.ts:999-1090
              ├─ wipe mappings                     :1019-1027
              ├─ clearManagedChildrenWithSuppression :1041
              ├─ materializeFolder / materializeBookmark :1051-1053 / :1132-1164
              └─ replay from cursor 0              :1055-1059  (assertion at :1058)
```

### 7.1 Change inventory

| # | File:line (pre-fix, verified on disk) | Change | ADR |
|---|---|---|---|
| 1 | `extension/src/background/convergence.ts:134` | `function sameUrl` → `export function sameUrl` (body unchanged) | 102 |
| 2 | `extension/src/background/convergence.ts:111-115` | `rebuildJournal` adds `const operations = (journal.operations ?? []).filter((operation) => operation.status === "done");` and returns `operations` in the spread | 103 |
| 3 | `extension/src/background/projection.ts:76` | add `sameUrl` to the existing `./convergence.js` import list (alphabetically after `retryJournal`) | 102 |
| 4 | `extension/src/background/projection.ts:1768` | `node.url !== ownership.url` → `!sameUrl(node.url, ownership.url)`; the other four disjuncts and their order are byte-identical | 101 |
| 5 | `extension/tests/convergence.test.mjs` (append after `:340`) | T-U7, T-R4, T-R5, T-R6 | §9 |
| 6 | `extension/tests/create-ownership.test.mjs` (append after `:322`) | T-P1, T-P2, T-P3, T-P4 | §9 |

**Explicitly not touched:** `canonicalUrlForComparison`, `sameShape`, `callbackMatches`,
`shapeSignature`, `validReceipt`, `normalizeJournal`, `retryJournal`, `plan`, `createRemoteReceipt`,
`reduceRemoteCallback`, `startRemoteCreate`, `startRemoteDelete`, `finishRemoteDelete`,
`ownsRemoteCreate` (see F-1), `getNode`, `withSuppression`, `isSuppressed`, `doResyncWorkspace`,
`shared/types.ts`, `shared/storage.ts`, `extension/tests/helpers/fake-chrome.mjs` (see F-3),
anything under `backend/` or `admin-web/`.

---

## 8. Self-heal proof — the production workspace, traced end to end

Subject: workspace `SINGULARBANK / "Jira"`, backendId `9960591e-a669-4360-ae8b-a53f4896eb76`,
url `https://pruebs`, operation `status: "started"`, cursor 11,
`pauseReason: "ambiguous-operation"`.

### 8.1 How it got stuck (current build)

1. Replay/live apply reaches cursor 11, `bookmark.created`, `url: "https://pruebs"`. No mapping
   exists → `reconcileBookmarkChromeNode:2337` returns `undefined` → create branch `:1428`.
2. `startRemoteCreate:1433` writes operation id `11:9960591e-…:create` with
   `ownership.url = "https://pruebs"` (raw, `:1745`/`:1756`), `status: "started"`.
   From this write on, every `getState()` normalizes the journal to
   `paused`/`ambiguous-operation` (`convergence.ts:25`) **and persists it** (`storage.ts:51-53`).
3. `withSuppression(createBookmark(parentChromeId, title, "https://pruebs", position))`
   (`:1435-1447`). Chrome's GURL canonicalizes and stores `"https://pruebs/"`.
4. `setMapping` (`:1448-1450`).
5. `finishRemoteCreate:1451` → `getNode` returns `url: "https://pruebs/"` (`:1764`) →
   `:1768`: `node.url !== ownership.url` is `"https://pruebs/" !== "https://pruebs"` → **`true`** →
   early `return` with the pause left in place. `:1769`/`:1770` are never reached.
   **The operation is now permanently `started` and the workspace permanently paused.**
6. Back in `applyRemoteEnvelope`, the create branch returned `false` (`:1452`), so
   `deferCheckpoint` is `false` and `:1233-1234` advances `lastCursor` to 11 even though the
   journal is paused. Every later event is dropped at the pause gate `:1180` — matching the
   report that a later, correctly-terminated bookmark also never synced.

### 8.2 Why Rebuild does not help today — and actually throws

With the current `rebuildJournal` the `...journal` spread preserves `operations`
(`convergence.ts:114`), so:

1. `rebuildWorkspace:401` clears `phase`/`pauseReason` — but the `started` operation survives.
2. The **very next** `getState()` — `doResyncWorkspace:1000` — re-runs `normalizeJournal:25`,
   sees `status === "started"`, and re-pauses. The next `updateProjectionState`
   (`:1009`) persists that pause (`storage.ts:53`).
3. The wipe/materialize steps still run (they do not consult the journal).
4. Replay loop `:1055-1059`. Events with `cursor <= lastCursor` return at `:1177` and pass the
   assertion at `:1058` trivially. The first event with `cursor > lastCursor` hits the pause gate
   at `:1180`, returns without checkpointing, and `:1058`
   (`if (lastCursor < event.cursor) throw new Error("rebuild replay did not checkpoint")`) **throws**.
5. `catch` at `:1082-1088` → `pauseWorkspace(…, "chrome-effect-rejected")` (`:1986-1998`, which
   *does* set `failedCursor`) → `doResyncWorkspace` returns `false` → `rebuildWorkspace:403` skips
   `connectWorkspace`.

**This is a falsifiable prediction of the current build**, and it is the reason repeated Rebuilds
in the field never recovered the workspace. It also confirms `proposal.md:34-39` and, independently,
justifies ADR-103 as mandatory rather than defensive.

### 8.3 Post-fix recovery, step by step

1. **User clicks Rebuild** → `rebuildWorkspace:400` → `updateProjectionState:401`.
   `updateState`'s internal `getState()` normalizes the stored journal to
   `paused`/`ambiguous-operation`; `rebuildJournal` is then applied to that value and (ADR-103)
   **drops the `started` create operation**, sets `phase: "replay"`,
   `pauseReason: undefined`, `failedCursor: undefined`, `repairDisposition: "rebuild"`, retains
   only `"consumed"` receipts and `"acked"` intents. `storage.ts:53` persists it.
2. `volatileRepairGates.delete(workspaceId)` (`:402`) → `doResyncWorkspace(…, "explicit rebuild", "recovering")` (`:403`).
3. `doResyncWorkspace:1000` `getState()` → `normalizeJournal:25`: **no `started` operation, no
   invalid receipt → no pause** (transaction 2 of §6's table). This is the single step that
   ADR-103 changes, and everything downstream follows from it.
4. Backend tree fetched (`:1016`); managed path ensured (`:1017`); mappings wiped (`:1019-1027`);
   exclusions pruned (`:1031`); **all managed Chrome children deleted** (`:1041`) — including the
   `https://pruebs/` node the stale operation had claimed; mappings for removed ids dropped
   (`:1043`).
5. Folders and bookmarks rematerialized from backend truth (`:1051-1053` →
   `materializeFolder:1132-1150` → `materializeBookmark:1152-1164`). **The `https://pruebs`
   bookmark is re-created here**, with a *fresh* chromeId, via
   `createBookmark(parentChromeId, title, "https://pruebs", position)` (`:1158`) — raw URL, C1
   preserved — and `setMapping` is written at `:1161-1163`. Chrome again stores `"https://pruebs/"`.
   **No ownership operation is involved on this path**: `materializeBookmark` does not call
   `startRemoteCreate`, so nothing can wedge here.
6. **Replay from cursor 0** (`:1055`). Events at or below `lastCursor` return early at `:1177`.
7. **Cursor 11 re-processed** (or skipped at `:1177` — see A-1; the outcome is identical because
   step 5 already materialized the node from the same backend truth the event carries).
   If processed: `reconcileBookmarkChromeNode:2325-2330` now finds `mappedId` from step 5 and
   `getNode` succeeds → **returns the mapped id** → the create branch `:1428` is **not** entered
   and **`finishRemoteCreate` does not run again**. Execution continues to `:1455`:
   `existing.url` is `"https://pruebs/"`, `bookmark.url` is `"https://pruebs"`, so
   `updateReceipt` (`:1478`) is `true` → a receipt is persisted and `updateNode` is issued → the
   resulting `onChanged` is matched by `callbackMatches` → `sameShape` → `sameUrl`
   (`convergence.ts:139-144`) → **consumed, thanks to the sibling change already on this branch**.
   This is the precise reason this fix is stacked on `fix/extension-sync-pause-recovery` rather
   than on `develop`: on `develop` alone, step 7 would immediately re-pause with
   `final-verification-failed`.
8. Replay proceeds past cursor 11 — the assertion at `:1058` passes because the journal is not
   paused and `lastCursor` advances at `:1233-1234` — and reaches the later, previously-unreachable
   events, including the correctly-terminated bookmark reported as missing.
9. `:1061-1078`: `lastCursor` raised to `replay.currentCursor`, `status = "ready"`,
   `phase = "live"`, `pauseReason`/`failedCursor` cleared. `doResyncWorkspace` returns `true` →
   `connectWorkspace` (`:403`).

**Answering the question in the brief explicitly:** at step 7 `reconcileBookmarkChromeNode` finds a
mapping — but a **fresh** one created moments earlier by `materializeBookmark` (step 5), *not* a
stale pre-rebuild mapping (those were wiped at `:1024-1026` and `:1043`). **`finishRemoteCreate`
never runs again for cursor 11.** Therefore the ADR-101 fix alone cannot rescue this install, and
ADR-103 alone (without ADR-101) would rescue it only until the next bare-origin create.
**Both changes are load-bearing, for different populations:**

| | already-stuck installs | future bare-origin creates |
|---|---|---|
| ADR-101 (`sameUrl` in `finishRemoteCreate`) | no effect (function not re-entered) | **prevents the wedge** |
| ADR-103 (`rebuildJournal` filter) | **enables recovery on Rebuild** | no effect (nothing to clear) |

### 8.4 Forward property

For any future bare-origin, default-port, mixed-case or IDN create arriving on the **live** path:
`reconcileBookmarkChromeNode` returns `undefined` → create branch → `startRemoteCreate` (transient
pause) → `createBookmark` → `finishRemoteCreate` → `:1768` now passes via `sameUrl` → `:1769` marks
`done` → `:1770` clears the transient pause → `:1233-1234` checkpoints. **No durable pause is ever
created.** Pinned by T-P1.

---

## 9. Test strategy (Strict TDD — red first)

**Harness reality check — the proposal's guess is wrong.** `proposal.md:47` names
`extension/src/background/__tests__/`. **That directory does not exist.** The real harness, verified
on disk:

- Runner: `extension/package.json:10` — `"test:projection": "npm run build && node --test tests/*.test.mjs"`.
  Command: `cd extension && npm run test:projection`. Framework: `node:test` + `node:assert/strict`.
  **Do not introduce vitest into `extension/`** (that belongs to `admin-web`).
- Tests import the **compiled** output (`../dist/background/convergence.js`,
  `../dist/background/projection.js`), so `npm run build` must precede — the `test:projection`
  script already chains it.
- 21 test files exist under `extension/tests/`, plus a full Chrome/fetch/WebSocket fake at
  `extension/tests/helpers/fake-chrome.mjs`.
- Two files are the correct homes: `extension/tests/convergence.test.mjs` (341 lines; pure-module
  unit tests, no `chrome` stub needed — `convergence.ts:1` is a type-only import) and
  `extension/tests/create-ownership.test.mjs` (323 lines; **full integration** via
  `createChromeHarness` + `projection.projectionTestHooks.applyRemoteEnvelope`).
  The sibling design's claim that integration tests are infeasible
  (`extension-sync-pause-recovery/design.md:548-556`) is obsolete on this branch — `create-ownership.test.mjs`
  already drives `applyRemoteEnvelope` end to end, including `finishRemoteCreate`.

**Critical harness fact for the red test.** `fake-chrome.mjs:39`'s `create` stores
`url: input.url` **verbatim** — the fake does **not** canonicalize like Chrome. A naive
integration test would therefore be green before the fix. The bug must be injected the same way
the existing final-shape test does it: by overriding `chrome.bookmarks.get` for the created node.
`create-ownership.test.mjs:255-256` is the established in-repo pattern:

```js
const originalGet = harness.chrome.bookmarks.get;
harness.chrome.bookmarks.get = (id, callback) => originalGet(id, (nodes) => callback(nodes.map((node) => node.id === created.id ? { ...node, url: "https://pruebs/" } : node)));
```

This is exactly the injection point `finishRemoteCreate` reads through (`getNode`,
`chrome-bookmarks.ts:5-16`), and it has zero blast radius on the other 20 test files. Mutating
`fake-chrome.mjs` to canonicalize globally is the more faithful fix but would break existing
assertions on `https://remote.test` / `https://local.test` / `https://b.test`; recorded as F-3.

### 9.1 `extension/tests/convergence.test.mjs` — append after line 340

*ADR-102 — `sameUrl` becomes public API:*

- **T-U7** `sameUrl` is exported and `undefined`-safe: `sameUrl(undefined, undefined) === true`
  (C3, folder create); `sameUrl("https://x/", undefined) === false`;
  `sameUrl(undefined, "https://x/") === false`; `sameUrl("https://pruebs/", "https://pruebs") === true`;
  `sameUrl("https://a/", "https://b/") === false`. Also asserts symmetry on the incident pair.

*ADR-103 — `rebuildJournal` drops non-`done` operations:*

- **T-R4** *(the incident, unit level)* — `rebuildJournal` on a journal whose `operations` are
  `[{status:"started", kind:"create", ownership:{…, url:"https://pruebs"}}, {status:"done", kind:"create"}]`
  keeps only the `done` entry, and the returned journal has `phase: "replay"`,
  `pauseReason: undefined`, `failedCursor: undefined`.
- **T-R5** *(no-op when nothing to clear)* — `rebuildJournal` on a journal whose operations are all
  `done` returns them **all**, in order, `deepEqual` to the input array. Guards against an
  over-eager filter silently discarding the `ownsRemoteCreate:1833` suppression records.
- **T-R6** *(the deliberate asymmetry)* — `retryJournal` leaves a `started` operation untouched.
  Mirrors the existing T-R3 (`convergence.test.mjs:335-340`).
- **T-R7** *(round-trip, the property that actually matters)* —
  `normalizeJournal(rebuildJournal(stuckJournal))` does **not** return
  `phase: "paused"` / `pauseReason: "ambiguous-operation"`. This is the §8.3-step-3 property
  expressed as a pure assertion, and it is the test that would have caught the incomplete fix
  (ADR-101 without ADR-103). It must also be run against the **current** code to confirm it goes
  red first.
- Existing T-R1 (`:312`) and T-R2 (`:322`) must stay green — the new filter must not perturb the
  receipts/intents behavior. T-R2's fixture journal has `operations: []`, so it is unaffected.

### 9.2 `extension/tests/create-ownership.test.mjs` — append after line 322

All four reuse the file's existing `runtime()` / `remoteEvent()` / `operation()` helpers
(`:73-105`) and the `waitForHeldCreate` + `bookmarks.get`-override pattern (`:92-101`, `:247-265`).

- **T-P1** *(the incident regression)* — remote `bookmark.created` with
  `url: "https://pruebs"`; `chrome.bookmarks.get` overridden to report `url: "https://pruebs/"`
  for the created node. Assert `operation.status === "done"`,
  `journal.phase !== "paused"`, `journal.pauseReason === undefined`, and
  `harness.fetch.mutationCount() === 0` (no phantom backend mutation). **Red before ADR-101.**
- **T-P2** *(C3 — folder create with `url: undefined`)* — remote `folder.created`, no `get`
  override; assert `operation.status === "done"` and the journal is not paused. Also assert a
  bookmark create whose reported url is byte-identical still completes (the `left === right` fast
  path). Green before and after — it is the regression guard for ADR-102's `undefined` handling.
- **T-P3** *(C2 — genuine mismatch still pauses)* — three cases via the same `get` override,
  parameterized: wrong `title`, wrong `parentId`, wrong `index` (with a *correct* url in each).
  Assert `operation.status === "started"`, `journal.phase === "paused"`,
  `journal.pauseReason === "ambiguous-operation"` for all three. This is the test that fails loudly
  if someone ever routes `title` through a canonicalizer. Note: the existing test at
  `create-ownership.test.mjs:247-265` already covers the combined wrong-parent/index/title case and
  **must stay green** — T-P3 splits it per-field so the ADR-101 diff cannot narrow C2 unnoticed.
  A fourth case — a *genuinely different* url (`https://other.test/` against
  `https://pruebs`) — must also still pause; this is the "over-normalizing hides a wrong-URL
  create" risk from `proposal.md:56`.
- **T-P4** *(ADR-103 through storage — the recovery property)* — seed a projection whose
  `convergenceJournal` holds the exact stuck shape from §8 (`status: "started"`, `kind: "create"`,
  `ownership.url: "https://pruebs"`), using the `storage.updateState` seeding pattern at
  `:198-204` / `:309-312`. Apply `convergence.rebuildJournal` through
  `storage.updateState`, then call `storage.getState()` and assert the round-tripped journal is
  **not** paused — i.e. `normalizeJournal` (`storage.ts:89`) does not re-pause it. This exercises
  the real `getState` → `normalizeJournal` → persist path (B1) rather than the pure function
  alone, and requires no `fetch` doubles.

**Deliberately not attempted:** a full `rebuildWorkspace` integration test. It would need
`getWorkspaceTree`, `ensureManagedPath`, and `replayEvents` fetch doubles queued in exact order
(`harness.fetch.respond` is a FIFO queue) plus a socket double — disproportionate to a 6-line
production diff, and its distinctive property is already isolated by T-R7 + T-P4. Recorded as F-4.

**Definition of done.** `cd extension && npm run test:projection` green (all 21 pre-existing files
plus the new cases); `cd extension && npm run typecheck` green. TDD ordering for `sdd-apply`:
T-R7 and T-P1 must be observed **red** against the unmodified tree before either production edit
lands. Note that `npm run test:projection` runs `npm run build` first, so a red test proves the
compiled `dist/` was rebuilt — the sibling design's "vacuous glob" concern
(`extension-sync-pause-recovery/design.md:594`) is resolved: the glob now matches 21 files.

---

## 10. Out of scope / follow-ups

| ID | Item | Why deferred |
|----|------|--------------|
| **F-1** | **`ownsRemoteCreate` (`projection.ts:1826-1836`) has the identical exact-string URL defect at `:1832` (`ownership.url === node.url`).** Discovered during this design. On a bare-origin create the shape match returns `false`, so `handleBookmarkCreated:549` falls through to `isSuppressed(node.id) \|\| isSuppressed(node.parentId)` (`:550`). Verified mitigation: `withSuppression` adds `parentChromeId` to the suppressed set **before** `createBookmark` runs (`:2523-2526`, called with `[parentChromeId]` at `:1446`), so `isSuppressed(node.parentId)` is `true` and no phantom local create is emitted. **But `isSuppressed` is consuming (`:2551`)**, so the parent's suppression token is spent by the wedged create and a sibling create in the same batch could slip through. Not the reported incident, not reachable by the reported repro, and fixing it means auditing the consuming-suppression contract | Different function, different failure mode, needs its own proposal. `proposal.md:11-15` scopes this change to `finishRemoteCreate` + `rebuildJournal` only |
| F-2 | The `updateReceipt` predicate at `projection.ts:1478` and the move-branch predicate at `:1473` still use raw `existing.url !== bookmark.url`, causing a harmless-but-redundant `chrome.bookmarks.update` on every replay of a bare-origin bookmark | Cosmetic/perf only; the resulting callback is now correctly consumed by the sibling change. Explicitly left alone by `extension-sync-pause-recovery/design.md:451` |
| F-3 | `extension/tests/helpers/fake-chrome.mjs:39` stores `url` verbatim, so the fake does not model Chrome's GURL canonicalization — which is *why* this class of bug is invisible to the existing suite | Making the fake faithful would break url assertions in several existing tests; needs its own change with a full sweep |
| F-4 | End-to-end `rebuildWorkspace` integration test (fetch + socket doubles) | Disproportionate; T-R7 + T-P4 isolate the property |
| F-5 | Workspace-wide pause gate (`projection.ts:1180`) blast radius: one wedged operation blocks every later event for the workspace | Explicitly confirmed out of scope, `proposal.md:80` |
| F-6 | Auto-repair-on-upgrade so affected users recover without clicking Rebuild | Explicitly confirmed out of scope, `proposal.md:78` — new resilience feature, not a bugfix |
| F-7 | Chrome-specific normalizations WHATWG does not perform | Inherited from `extension-sync-pause-recovery` ADR-002 / F-6; single call site keeps it a one-function change |

---

## 11. Risks and assumptions requiring validation

| Risk / assumption | Severity | Validation |
|---|---|---|
| **A-1 — provenance of the reported `failedCursor: 11`.** `finishRemoteCreate:1768` sets `phase`/`pauseReason` but **not** `failedCursor`. Either the "11" is the cursor prefix of the operation id (`${event.cursor}:${backendId}:create`, `:1745`) and `failedCursor` was written later by `pauseWorkspace` (`:1986-1998`), or `lastCursor` differs from 11 | Low | Does not affect the fix. §8.3 step 7 shows both readings converge: whether cursor 11 is re-applied or skipped at `:1177`, step 5 has already materialized the node from the same backend truth. `sdd-apply` should not encode an assumption about `lastCursor` in any test |
| **A-2 — Chrome's GURL canonicalization is a superset-compatible match for WHATWG `new URL().href`** | Med | Inherited from `extension-sync-pause-recovery` ADR-002 (`design.md:111-127`, T-U1..T-U6, already green on this branch). `sameUrl`'s `left === right` fast path (`convergence.ts:135`) means any divergence degrades to today's exact behavior, never worse |
| Over-normalization masks a genuinely wrong-URL create (`proposal.md:56`) | Low | T-P3's fourth case pins that `https://other.test/` vs `https://pruebs` still pauses. Canonicalization is comparison-only (C1): nothing sent to Chrome or persisted changes |
| Chrome normalizes a field beyond `url` (e.g. trims `title`) | Low | C2 keeps `title`/`parentId`/`index` at strict `!==`; T-P3 pins each independently. If such a case ever surfaces it is a new incident with new evidence, not a silent regression |
| ADR-103 drops a `started` operation that was genuinely in flight at the moment of Rebuild | Low | Rebuild deletes every managed Chrome child (`:1041`) and rematerializes from backend truth, so the node the operation claimed no longer exists. §5.1(a)/(b) enumerate every reachable kind/status pair |
| ADR-102 widens `convergence.ts`'s public surface | Low | Pure, total, no persisted representation; §4 reason 2 shows the import boundary is pre-existing. T-U7 pins the contract |
| **A-3 — `plan()` is dead in production.** ADR-103's exhaustiveness argument depends on it | Med | Verified by `\bplan\b` grep across `extension/src` (4 hits, none a call site). `sdd-apply` should re-run that grep; if a caller appears, `adopt`/`reconcile`/`planned` must be re-examined before the filter lands |
| The fake Chrome does not canonicalize, so an incorrectly written integration test is green from the start | Med | §9 mandates observing T-P1 **red** first via the `bookmarks.get` override; F-3 records the deeper fix |
| Branch stacking: this change is only correct on top of `fix/extension-sync-pause-recovery` | Resolved | `canonicalUrlForComparison` (`convergence.ts:127`) and `sameUrl` (`:134`) confirmed present on disk. §8.3 step 7 shows the recovery path *requires* the sibling's `callbackMatches` fix; landing this on `develop` alone would trade `ambiguous-operation` for `final-verification-failed` |

---

## 12. Threat matrix and project-rule compliance

**Threat matrix: N/A** — this change introduces no routing, shell command, subprocess, VCS/PR
automation, executable-file classification, or process-integration boundary. The diff is two
in-memory comparisons inside an existing Chrome-extension background module. No matrix rows apply;
no matrix-derived tasks are generated.

**`openspec/config.yaml` `rules.design` compliance:**

- *"Keep the backend modular and document sync/event consistency rules."* No backend change. The
  sync/event consistency rules this change touches are documented explicitly: the durable-ownership
  invariant (§2 B1 — `started` operation ⇒ journal normalizes to paused until proven), its
  compensation point (`projection.ts:1770`), the terminal-status retention rule shared by
  receipts/intents/operations at Rebuild (ADR-103), the workspace-wide pause gate
  (`projection.ts:1180`, unchanged), and the replay checkpoint assertion
  (`projection.ts:1058`).
- *"Document contracts between the Go backend and Chrome extension."* **The backend↔extension
  contract is unchanged.** The backend remains the source of raw URL truth: it validates and
  stores the user-supplied string, and the extension forwards that exact string to Chrome (C1).
  This change only teaches the extension that *Chrome's stored echo* of that string may differ by
  WHATWG-equivalent canonicalization. No API surface, event payload, or persisted schema on either
  side is modified. The `bookmark.created`/`bookmark.updated` envelope shape and the backend's URL
  validation gate are untouched.
- **Config staleness note (not a blocker):** `openspec/config.yaml` records
  `testing.test_runner.available: false` and `strict_tdd: false` (detected 2026-06-30). Both are
  now stale for `extension/`: a working runner exists (`extension/package.json:10`, 21 test files,
  wired into CI) and this session runs under Strict TDD. §9 follows the real harness and red-first
  ordering. Re-detecting the testing config is worth a separate housekeeping change.
