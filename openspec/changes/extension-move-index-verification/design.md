# Design: extension-move-index-verification

Surgical bugfix design. **Four production edits across two files** (one new pure export, one
import, two rewritten move branches) plus **two test-double corrections**, all inside
`extension/`. No new architecture, no backend or admin-web change, no persisted-format change,
no migration, no packaging change.

Everything below is written against the **current on-disk tree of branch
`fix/extension-move-index-verification`** (stacked on `fix/extension-create-ownership-url-normalization`
→ `fix/extension-sync-pause-recovery`). Every line number was re-read from disk for this design
and **supersedes the line numbers quoted in `proposal.md`**, several of which have drifted by the
two prior fixes. Line numbers are *pre-fix* so `sdd-tasks` can slice directly.

**This design is the mirror image of its two siblings.** They changed *comparison* logic and left
every outgoing Chrome argument byte-identical. This one changes *exactly one outgoing Chrome
argument* and leaves every comparison, receipt, and persisted value byte-identical. The
constraint table below is written to make that inversion structural rather than disciplinary.

---

## 1. Constraints this design is bound by

| # | Constraint | Source | How the design satisfies it structurally |
|---|---|---|---|
| C1 | The receipt must keep describing the **backend-logical** move (`move.oldIndex` / `move.index` = backend positions). The Chrome-coordinate adjustment must never reach `persistRemoteReceipt`, `expectedAfter`, `expectedSignatures`, `sameMove`, or `callbackMatches`. | proposal.md:31 | ADR-202 hoists one `const move` literal and feeds it to **both** `persistRemoteReceipt` (unchanged) and `chromeMoveIndex(move)` (new). The adjustment is a *return value*, never a stored field; there is no variable in scope that holds an adjusted receipt. |
| C2 | Only the *destination index* changes, and only for **same-parent forward** moves. Cross-parent moves, backward moves, and the index-less `moveNode` at `projection.ts:1124` keep byte-identical arguments. | proposal.md:15-16, :18 | ADR-201's helper is a single conditional expression whose guard is `from.parentId === to.parentId && to.index > from.index`; every other input returns `to.index` unchanged. `relocateToLocalOnly` (`:1124`) passes no `index` and does not call the helper. |
| C3 | `sameMove` / `sameShape` / `callbackMatches` / `exactIdentity` / receipt shape are **out of scope and untouched** — they are already correct. | proposal.md:7, :31 | No edit in `convergence.ts`. The change inventory (§7.1) lists it under *not touched*, and ADR-201 rejects `convergence.ts` as the helper's home precisely so that the adjusted value cannot become reachable from the comparison layer by a one-word import. |
| C4 | No persisted-schema change; a revert must leave journals readable and restores exactly today's behavior. | proposal.md:73 | Only a function argument and one new pure function. `ConvergenceJournal` / `RemoteReceipt` (`shared/types.ts:184-215`) untouched. |
| C5 | The test double must model real Chromium **before** the production fix lands, or the fix is untestable and the suite actively certifies the bug. | proposal.md:20, :26 | ADR-204 is sequenced as step 0 of §9 and is gated on the **existing** suite staying green, with the at-risk tests enumerated by name. |
| C6 | Already-stuck installs recover via manual Rebuild. No auto-repair-on-upgrade. | proposal.md:92 | §8 proves recovery through the existing `rebuildJournal` → `doResyncWorkspace` path. **No `rebuildJournal` change is needed** (§8.2) — unlike both siblings, this change adds nothing to `convergence.ts`. |
| C7 | Size budget: single small PR, well under the 800-line budget. | proposal.md:60 | ~14 changed lines of production code, ~20 changed lines across two test doubles, plus tests. |
| C8 | The root cause is an **assumption about Chrome's internal behavior**, not an observed local defect. It must not fail silently if that assumption is wrong on some Chrome version. | task brief item 4; proposal.md:46, :66 | ADR-203 adds a post-move read-back gate that converts any residual divergence into a loud, correctly-attributed `final-verification-failed` pause at the offending cursor. |

---

## 2. What the current code actually does (verified, not quoted from the proposal)

### 2.1 The two defective call sites

```ts
// extension/src/background/projection.ts:1363-1370  (CURRENT — folder)
  if (existing.parentId !== parentChromeId || existing.index !== folder.position) {
    if (!canPersistReceipt(projection.convergenceJournal ?? emptyJournal(), event.cursor)) { await pauseWorkspace(workspaceId, event.cursor, "receipt-capacity"); return true; }
    if (existing.parentId === undefined || existing.index === undefined) throw new RemoteApplyError("remote folder move predecessor is incomplete", existingContext, "ambiguous-predecessor");
    await persistRemoteReceipt(workspaceId, event, folder.id, chromeId, "folder", existing, { parentId: parentChromeId, index: folder.position, title: folder.name }, { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: folder.position });
    if (existing.title !== folder.name) await updateNode(chromeId, { title: folder.name });
    await moveNode(chromeId, { parentId: parentChromeId, index: folder.position });
    return true;
  }
```

```ts
// extension/src/background/projection.ts:1469-1476  (CURRENT — bookmark; structurally identical)
    await persistRemoteReceipt(workspaceId, event, bookmark.id, chromeId, "bookmark", existing, { parentId: parentChromeId, index: bookmark.position, title: bookmark.title, url: bookmark.url }, { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: bookmark.position });
    if (existing.title !== bookmark.title || existing.url !== bookmark.url) await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
    await moveNode(chromeId, { parentId: parentChromeId, index: bookmark.position });
    return true;
```

`moveNode` (`chrome-bookmarks.ts:83-94`) is a thin promise wrapper: it forwards `destination`
verbatim to `chrome.bookmarks.move` and rejects on `runtime.lastError`. It adds no semantics and
**must keep adding none** (ADR-201, rejected alternative b).

Both branches return `true` — `deferCheckpoint` — so `applyRemoteEnvelope:1234` does **not**
advance `lastCursor`. The cursor is advanced only later, by the `onMoved` callback path
(`consumeRemoteCallback:1521-1523`). **Everything in this incident follows from that: no
`onMoved`, no cursor.**

### 2.2 The Chromium contract (the assumption this whole change rests on)

`BookmarkModel::Move` interprets `destination.index` in the **pre-removal** coordinate space of
the destination parent:

```cpp
// components/bookmarks/browser/bookmark_model.cc — semantics, paraphrased
if (old_parent == new_parent && (index == old_index || index == old_index + 1))
  return;                                   // silent no-op: no mutation, no BookmarkNodeMoved
if (old_parent == new_parent && index > old_index)
  index--;                                  // pre-removal → post-removal
// ... move, then notify observers with the *decremented* index
```

Two consequences the extension depends on:

1. **`index == old_index + 1` is a silent no-op and emits no `onMoved`.** This is the incident.
2. **The observer/`onMoved` `index` is the post-move (decremented) index**, i.e. the same
   backend-logical number the receipt stores. This is why C1/C3 hold: `sameMove`
   (`convergence.ts:154`) is already comparing the right things and must not be touched.

The extension-API bound check is `index > parent->children().size()` → `kInvalidIndexError`. For a
same-parent move, `children().size()` still counts the moving node, so a valid final index
`d ≤ n-1` compensates to `d+1 ≤ n` and **can never go out of bounds** (§11 A-3 covers `d = n`).

**The boundary condition settled by `proposal.md:18`, and adopted here verbatim:**

```
sameParent && desired > oldIndex  →  desired + 1        (otherwise desired, unchanged)
```

This is not "only the `oldIndex + 1` case". It is the general same-parent forward rule, and it
subsumes the boundary case:

| Same-parent case | Passed today | Chrome result today | Passed post-fix | Chrome result post-fix |
|---|---|---|---|---|
| `d == old` | — | *branch not entered* (parent and index both match) | — | — |
| `d == old + 1` (**this incident**) | `old+1` | **no-op, no `onMoved`** | `old+2` | `> old` → decrement → `old+1` ✓ |
| `d > old + 1` | `d` | lands at `d-1` → callback mismatch | `d+1` | decrement → `d` ✓ |
| `d < old` (backward) | `d` | lands at `d` ✓ | `d` (unchanged) | `d` ✓ |
| cross-parent | `d` | lands at `d` ✓ | `d` (unchanged) | `d` ✓ |

`d == old` with the same parent is **unreachable** in the move branch: the branch guard at
`:1363` / `:1469` requires `existing.parentId !== parentChromeId || existing.index !== position`.
Recorded because it is the one same-parent input for which the helper returns the no-op-producing
value, and a future refactor that widens the guard would reintroduce a silent stall.

### 2.3 How the no-op becomes a permanent stall (the exact cascade, corrected)

`proposal.md:13` compresses this into "replay guard at `projection.ts:1058` throws". The precise
chain, which `sdd-apply` and `sdd-verify` need in order to read production diagnostics:

1. Move branch persists a `pending` receipt (`:1366` / `:1472`), issues the no-op move, returns
   `true`.
2. `applyRemoteEnvelope:1234` skips the checkpoint. `lastCursor` stays at 18.
3. No `onMoved` ever fires, so `consumeRemoteCallback:1512` never runs. **The receipt is pending
   forever.**
4. Every subsequent live event returns at the pending-receipt gate `:1181` without checkpointing.
   The workspace is silently frozen while still reporting `phase: "live"`.
5. On **Rebuild**, `doResyncWorkspace:1056-1059` replays; the offending event returns at `:1181`
   (its receipt survived, see §8.2 for why it does *not*), or re-enters the move branch and defers
   again — either way `lastCursor < event.cursor` at `:1058` → `throw new Error("rebuild replay did
   not checkpoint")`.
6. `catch` at `:1082-1089` → `pauseWorkspace(workspaceId, lastCursor ?? 0, "chrome-effect-rejected")`.
   Note the cursor recorded is **`lastCursor` (18), not the offending event's cursor (19)** — the
   `failedCursor` in the field report under-reports by one. `pauseWorkspace:1990` then forces
   `repairDisposition: "rebuild"` because a pending receipt exists, which is why the UI keeps
   offering Rebuild and why `retryJournal:107` refuses to clear it.

**Forensic marker for `sdd-verify`:** `chrome-effect-rejected` with `failedCursor === lastCursor`
(not `lastCursor + 1`) and a pending `move` receipt in the journal is the signature of this defect.
A live-path failure would instead pause at `:1255` with `failedCursor === event.cursor`.

### 2.4 Why CI never caught it — and why `proposal.md:20` is incomplete

`proposal.md:20` names `tests/helpers/fake-chrome.mjs:41`. That is only half of it. **There are two
independent Chrome doubles in `extension/tests/`, and the one that hosts every existing
move-branch test is not the one the proposal names.**

```js
// extension/tests/helpers/fake-chrome.mjs:41  (CURRENT) — post-removal splice semantics
move(id, destination, callback) { const record = node(id), oldParentId = record.parentId, oldIndex = record.index, from = node(oldParentId), to = node(destination.parentId ?? oldParentId); from.children.splice(oldIndex, 1); normalize(from.id); record.parentId = to.id; to.children.splice(Math.max(0, Math.min(destination.index ?? to.children.length, to.children.length)), 0, id); normalize(to.id); complete("moved", [id, { parentId: to.id, oldParentId, index: record.index, oldIndex }], () => callback(view(id))); },
```

```js
// extension/tests/projection-behavior.test.mjs:149-154  (CURRENT) — no splice at all
    move(id, destination, callback) {
      const node = bookmarkNodes.get(id);
      Object.assign(node, destination);
      rebuildBookmarkChildren();
      callback(cloneNode(node));
    },
```

- `fake-chrome.mjs` removes first and *then* splices, so the requested index is interpreted in
  post-removal space — the exact opposite of Chromium — and it clamps instead of erroring.
- `projection-behavior.test.mjs` is **worse**: it assigns the requested `parentId`/`index` onto the
  node and renumbers nothing. The requested index is the resulting index *by construction*, and
  siblings keep stale, possibly duplicate indices (`rebuildBookmarkChildren:42` only *sorts*).
- **`projection-behavior.test.mjs` is the double behind every move-branch test that exists**
  (`:1588`, `:1756`, `:1830`). `fake-chrome.mjs`'s `move` is exercised only by
  `chrome-harness.test.mjs:27` and `:123`.

So the harness does not merely fail to catch the defect: under either double, `moveNode(id, {index:
oldIndex + 1})` is a *success*. A naive regression test written today passes before and after the
fix. ADR-204 makes both doubles faithful, and §9 sequences that as a prerequisite step with its own
green gate.

---

## 3. ADR-201 — One pure `chromeMoveIndex` rule, exported from `chrome-bookmarks.ts`, applied at the two call sites

**Decision.** Add one pure, total function to `extension/src/background/chrome-bookmarks.ts`,
immediately above `moveNode` (`:83`), and call it at `projection.ts:1368` and `:1474`.

```ts
// extension/src/background/chrome-bookmarks.ts — new export, placed directly above moveNode (~:83)

/**
 * Chromium's BookmarkModel::Move reads `destination.index` in the parent's *pre-removal*
 * coordinate space. For a same-parent move it silently no-ops when the index equals
 * `oldIndex` or `oldIndex + 1`, and decrements any index greater than `oldIndex`. Translating a
 * desired *final* index into that space means adding 1 to same-parent forward moves and leaving
 * every other case alone. Cross-parent and backward moves already coincide in both spaces.
 */
export function chromeMoveIndex(move: { oldParentId: string; oldIndex: number; parentId: string; index: number }): number {
  return move.parentId === move.oldParentId && move.index > move.oldIndex ? move.index + 1 : move.index;
}
```

`moveNode` (`:83-94`) is **not** modified: it remains the honest "forward `destination` to Chrome"
adapter.

**Rationale.**

1. **The quirk is a property of `chrome.bookmarks.move`, not of projection policy.**
   `chrome-bookmarks.ts` is the single adapter that owns every `chrome.bookmarks.*` call in the
   codebase; it is where a reader looks for "what does this Chrome API actually do". Placing the
   rule anywhere else scatters Chrome-API knowledge into policy code.
2. **This applies ADR-102's principle, not just its outcome.** The sibling change
   (`extension-create-ownership-url-normalization/design.md:122-171`) chose to export the
   *predicate* (`sameUrl`) rather than the primitive (`canonicalUrlForComparison`) so that exactly
   one place in the repo defines the rule. Same here: the export is the *rule*
   (`chromeMoveIndex`), not the primitive `+ 1`. A future Chrome-version divergence is then a
   one-function change, and ADR-203's gate is what would surface the need for it.
3. **`convergence.ts` is explicitly rejected as the home (C3).** `convergence.ts` has a single
   type-only import (`:1`) and zero Chrome knowledge by design; it is the module that owns
   `sameMove` (`:154`) and `callbackMatches` (`:147`). Putting a Chrome-coordinate translator there
   would place the adjusted value one word away from the comparison layer, which is precisely the
   leak C1 forbids. Keeping the two concepts in different modules makes the leak require a new
   cross-module import rather than a local typo.
4. **`projection.ts` is rejected as the home** for reason 1, and because `projection.ts` is ~2600
   lines and already the least reviewable file in the extension; a rule that belongs to an adapter
   should not be findable only by grepping the orchestrator.
5. **It is directly unit-testable with no `chrome` stub.** Verified: `chrome-bookmarks.ts` imports
   only `ROOT_FOLDER_TITLE` (`:1`) and touches `chrome.*` exclusively inside function bodies, so
   `import { chromeMoveIndex } from "../dist/background/chrome-bookmarks.js"` loads cleanly with no
   global. This is ADR-102 reason 3 applied verbatim, and it is what makes T-M1 a pure table test.
6. **No packaging change.** `dist/background/chrome-bookmarks.js` is already in the release
   allowlist (`extension/scripts/package.mjs:26`), so this change cannot reproduce the
   missing-module class of defect fixed by commit `3d8f0f1`.

**Signature choice — a move record, not `(sameParent, oldIndex, desiredIndex)`.** The task brief
suggested `chromeMoveIndex(sameParent: boolean, oldIndex: number, desiredIndex: number)`. Rejected:

- A leading boolean is boolean-blind at the call site and invites silent transposition of two
  adjacent `number` arguments — the exact failure mode this change exists to eliminate.
- It forces each call site to *recompute* `parentChromeId === existing.parentId`, creating a second
  place where same-parent-ness is decided.
- The record form is structurally identical to the receipt's `move` field, which is what enables
  ADR-202's single-sourcing guarantee. The parameter is declared **structurally**, not as
  `RemoteReceipt["move"]`, so `chrome-bookmarks.ts` acquires no dependency on `shared/types.ts` or
  on the convergence layer while still accepting the receipt's own object.

**Rejected alternatives.**

- *(a) Fold the compensation into `moveNode` by re-reading the node.* `moveNode` would call
  `getNode(id)` to learn `oldParentId`/`oldIndex`, making the fix impossible to forget at any call
  site. **Rejected — and this is the sharpest fork in the design.** Both call sites already hold a
  freshly read `existing` (`:1351`, `:1455`) and have already asserted its `parentId`/`index` are
  defined (`:1365`, `:1471`); more importantly, they have already *persisted those exact values as
  `move.oldIndex` in the receipt*. A second, independent read inside `moveNode` could observe a
  different state than the receipt attests to, so the compensation would be computed against a
  predecessor the receipt does not describe, and the resulting `onMoved` would legitimately fail
  `sameMove`. That trades a deterministic off-by-one for a non-deterministic one. It also adds an
  IPC round trip to every move and gives `moveNode` a hidden read, breaking the adapter's
  one-call-one-API-call contract.
- *(b) A `moveNodeToFinalIndex(id, move)` wrapper that computes and calls.* Rejected: it hides the
  argument a reviewer must check. The house style established by both siblings is a one-expression
  diff at the decision site (`design.md:86-87` of the create-ownership sibling), not a new wrapper
  that makes the diff smaller and the review harder.
- *(c) Put the helper in `convergence.ts`.* Rejected — see rationale 3 (C3 violation risk).
- *(d) Clamp instead of compensate* (`Math.min(desired + 1, childCount)`). Rejected: clamping is
  what the current test doubles do and it converts an out-of-range backend position from a loud
  Chrome error into a silent landing at the wrong index — reintroducing the whole failure class.
  §11 A-3 documents the one input where this fix changes *which* error is raised.

---

## 4. ADR-202 — Hoist the move record so the receipt and the Chrome call are provably single-sourced

**Decision.** At both sites, extract the inline `move` object literal into a `const` and pass the
*same object* to `persistRemoteReceipt` (unchanged semantics) and to `chromeMoveIndex`.

```diff
// extension/src/background/projection.ts:1366-1368  (folder)
-    await persistRemoteReceipt(workspaceId, event, folder.id, chromeId, "folder", existing, { parentId: parentChromeId, index: folder.position, title: folder.name }, { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: folder.position });
+    const move = { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: folder.position };
+    await persistRemoteReceipt(workspaceId, event, folder.id, chromeId, "folder", existing, { parentId: parentChromeId, index: folder.position, title: folder.name }, move);
     if (existing.title !== folder.name) await updateNode(chromeId, { title: folder.name });
-    await moveNode(chromeId, { parentId: parentChromeId, index: folder.position });
+    const moved = await moveNode(chromeId, { parentId: parentChromeId, index: chromeMoveIndex(move) });
```

```diff
// extension/src/background/projection.ts:1472-1474  (bookmark — identical shape)
-    await persistRemoteReceipt(workspaceId, event, bookmark.id, chromeId, "bookmark", existing, { parentId: parentChromeId, index: bookmark.position, title: bookmark.title, url: bookmark.url }, { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: bookmark.position });
+    const move = { oldParentId: existing.parentId, oldIndex: existing.index, parentId: parentChromeId, index: bookmark.position };
+    await persistRemoteReceipt(workspaceId, event, bookmark.id, chromeId, "bookmark", existing, { parentId: parentChromeId, index: bookmark.position, title: bookmark.title, url: bookmark.url }, move);
     if (existing.title !== bookmark.title || existing.url !== bookmark.url) await updateNode(chromeId, { title: bookmark.title, url: bookmark.url });
-    await moveNode(chromeId, { parentId: parentChromeId, index: bookmark.position });
+    const moved = await moveNode(chromeId, { parentId: parentChromeId, index: chromeMoveIndex(move) });
```

**Rationale — this is how C1 stops being a discipline problem.**

1. **`persistRemoteReceipt` is called with the identical object it is called with today.** The
   argument is `move`, unmodified; the adjusted number exists only as the return value of
   `chromeMoveIndex(move)`, consumed immediately as a function argument and never assigned to
   anything the receipt can see. There is no `adjustedMove` variable for a future editor to hand to
   `persistRemoteReceipt` by mistake.
2. **The compensation's `oldIndex` is provably the receipt's `oldIndex`** — same object, same
   statement block. This is the property alternative (a) in ADR-201 cannot offer.
3. **`sameMove` keeps matching without a single edit.** Chrome reports `onMoved` with the
   *post-move* index (§2.2 consequence 2), which equals `move.index` (the backend position), and
   `oldIndex` equals `move.oldIndex`. The callback's node shape likewise reports the final index,
   which equals `expectedAfter.index`. **`convergence.ts` is untouched, and that is a load-bearing
   property, not an omission.**
4. **Type narrowing is preserved.** `existing` is `const`-bound (`:1351` / `:1455`), `!existing`
   throws (`:1352` / `:1456`), and `existing.parentId === undefined || existing.index === undefined`
   throws (`:1365` / `:1471`). The current code already relies on that narrowing to pass
   `existing.parentId` into `persistRemoteReceipt`'s `{ oldParentId: string; oldIndex: number; ... }`
   parameter (`:1532`), so hoisting the literal cannot introduce a typecheck regression. The
   inferred type of `move` is exactly `chromeMoveIndex`'s structural parameter type.

**Invariant to preserve in review:** `persistRemoteReceipt`'s last argument must be `move`, and
`chromeMoveIndex(...)` must appear **only** inside the `moveNode` destination literal. Any other
occurrence of `chromeMoveIndex` in `projection.ts` is a C1 violation.

---

## 5. ADR-203 — A post-move read-back gate, mirroring the existing final-verification precedent

**This is the one place where this design takes a heavier defensive posture than either sibling,
and the reason is stated plainly: the siblings' fixes were pure comparison changes with no external
behavioral assumption; this one is a bet on Chrome's internals (C8).**

**Decision.** After `moveNode` resolves, assert the node actually landed where the receipt says it
should, and throw `final-verification-failed` if it did not.

```ts
    const moved = await moveNode(chromeId, { parentId: parentChromeId, index: chromeMoveIndex(move) });
    if (moved.parentId !== move.parentId || moved.index !== move.index) {
      throw new RemoteApplyError("remote folder move landed at an unexpected index", { ...existingContext, requestedChromeIndex: chromeMoveIndex(move), observedIndex: moved.index }, "final-verification-failed");
    }
    return true;
```

(identical in the bookmark branch, with `"remote bookmark move landed at an unexpected index"`.)

**Rationale.**

1. **It is not a new pattern — it is the pattern already in this function, 20 lines below.**
   `projection.ts:1494-1500` already performs exactly this read-back for the *update* path, with
   the same error class and the same `"final-verification-failed"` gate:
   ```ts
   const finalNode = await getNode(chromeId);
   if (!finalNode) throw new RemoteApplyError("remote bookmark missing after apply", existingContext, "complete-node-read-failed");
   if (finalNode.parentId !== parentChromeId || finalNode.index !== bookmark.position) throw new RemoteApplyError("remote bookmark final parent/index mismatch after apply", existingContext, "final-verification-failed");
   ```
   The move branch returns at `:1475` *before* reaching it, so the branch that actually moves things
   is the only one with no verification at all. The folder path has none anywhere. **This ADR closes
   an asymmetry rather than inventing a policy.**
2. **It is the only available detector of the exact failure mode.** A Chromium no-op emits no
   `onMoved`, so nothing downstream can observe it; but the no-op *does* leave the node at
   `oldIndex`, and `chrome.bookmarks.move` still invokes its callback with the node's current
   state. `moved.index !== move.index` therefore detects a silent no-op with certainty, at the
   moment it happens, at the offending cursor.
3. **It converts a mis-attributed failure into an attributable one.** Today: pending receipt →
   frozen workspace → `chrome-effect-rejected` at `lastCursor` on a later Rebuild, with the error
   *discarded* by the bare `catch {` at `:1082` (§10 F-3). Post-ADR-203: an immediate
   `final-verification-failed` at `event.cursor`, with `requestedChromeIndex` and `observedIndex` in
   the diagnostic. If Chrome ever changes the quirk (removing it, or moving the boundary), the
   compensation overshoots by one and this gate fires loudly instead of stalling silently. **That is
   the whole answer to C8.**
4. **Zero extra I/O.** The check reads `moveNode`'s own resolved node rather than issuing a second
   `getNode`. Chrome's move callback returns the node read from the model *after* the mutation, so
   the two are equivalent; the resolved value is cheaper and is the value Chrome itself reports.
   *Rejected alternative:* re-read via `getNode(chromeId)` for symmetry with `:1494`. Rejected —
   an extra IPC per move, an extra `null` branch, and no additional evidence, since a no-op returns
   the unchanged node either way.
5. **It cannot fire on any path that works today.** Cross-parent and backward moves land exactly on
   the requested index (§2.2 table), and out-of-range positions already reject inside `moveNode`
   (`chrome-bookmarks.ts:87-88`) before the check is reached. The three existing move tests
   (`projection-behavior.test.mjs:1588`, `:1756`, `:1830`) are all cross-parent and stay green —
   confirmed against the corrected doubles in §9.

**Consequences stated honestly.**

- The receipt is already persisted when the gate throws (it must be — "persist before effect" is
  the crash-safety invariant pinned by the test name at `:1756`). So a fired gate leaves a pending
  receipt and forces `repairDisposition: "rebuild"` (`:1990`). That is identical to the existing
  `:1499` behavior and is the correct outcome: a move whose landing site is unknown must not be
  papered over.
- If the gate ever fires *spuriously* while the move actually succeeded, a real `onMoved` may still
  arrive and consume the receipt afterwards (`consumeRemoteCallback` has no phase gate). The
  workspace stays paused until Rebuild. Pre-existing behavior of the `:1499` gate; not widened here.
- **No retry, no corrective second move, no `getChildren()` re-verification.** `proposal.md:32`
  rejects re-verifying moves via `getChildren()` and relaxing same-parent matching; this ADR does
  neither. It is a one-comparison assertion on a value already in hand.

---

## 6. ADR-204 — Both Chrome doubles become Chromium-faithful; no flag, no opt-in

**Decision.** Rewrite `move` in **both** test doubles to model pre-removal indices, the same-parent
no-op (with `onMoved` suppressed where the double has event plumbing), the post-removal decrement,
sibling renumbering, and the out-of-bounds error. No `enforceStrictIndices`-style opt-in flag.

```js
// extension/tests/helpers/fake-chrome.mjs:41  (REPLACEMENT)
    move(id, destination, callback) {
      const record = node(id), oldParentId = record.parentId, oldIndex = record.index;
      const from = node(oldParentId), to = node(destination.parentId ?? oldParentId), sameParent = to.id === oldParentId;
      let index = destination.index ?? to.children.length;                 // pre-removal space: same-parent still contains `id`
      if (index < 0 || index > to.children.length) throw new Error("Index out of bounds.");
      if (sameParent && (index === oldIndex || index === oldIndex + 1)) { callback(view(id)); return; }   // Chromium silent no-op: no onMoved
      if (sameParent && index > oldIndex) index -= 1;
      from.children.splice(oldIndex, 1); normalize(from.id);
      record.parentId = to.id;
      to.children.splice(index, 0, id); normalize(to.id);
      complete("moved", [id, { parentId: to.id, oldParentId, index: record.index, oldIndex }], () => callback(view(id)));
    },
```

```js
// extension/tests/projection-behavior.test.mjs:149-154  (REPLACEMENT)
    move(id, destination, callback) {
      rebuildBookmarkChildren();
      const node = bookmarkNodes.get(id);
      const oldParentId = node.parentId, oldIndex = node.index;
      const parent = bookmarkNodes.get(destination.parentId ?? oldParentId);
      const sameParent = parent.id === oldParentId;
      const siblings = parent.children ?? [];
      let index = destination.index ?? siblings.length;
      if (index < 0 || index > siblings.length) {
        globalThis.chrome.runtime.lastError = { message: "Index out of bounds." };
        callback(undefined);
        globalThis.chrome.runtime.lastError = null;
        return;
      }
      if (sameParent && (index === oldIndex || index === oldIndex + 1)) { callback(cloneNode(node)); return; }
      if (sameParent && index > oldIndex) index -= 1;
      const source = (bookmarkNodes.get(oldParentId)?.children ?? []).filter((child) => child.id !== id);
      source.forEach((child, position) => { child.index = position; });
      const target = sameParent ? source : (parent.children ?? []).slice();
      target.splice(index, 0, node);
      node.parentId = parent.id;
      target.forEach((child, position) => { child.index = position; });
      rebuildBookmarkChildren();
      callback(cloneNode(node));
    },
```

**Notes that make these correct rather than merely plausible.**

- `rebuildBookmarkChildren` (`:20-45`) rebuilds each parent's `children` array from `parentId` and
  **sorts by `index` without renumbering**, and it pushes the *same* node objects (not clones), so
  assigning `child.index = position` mutates the store. The rewrite is the first `move` in that
  double that leaves indices dense — which is exactly the property every index assertion depends on.
- The `lastError` / `callback(undefined)` shape mirrors that double's own `create` (`:132-137`) and
  is what `moveNode` (`chrome-bookmarks.ts:86-88`) converts into a rejected promise.
  `fake-chrome.mjs` throws instead, matching *its* house style (`:34`, `:39`).
- The no-op path bypasses the mutator phase machinery (`complete`, `:23-29`) **by design**: there is
  no event to schedule. No existing test performs a move in `"held"`/`"delayed"` mode that would be
  a no-op (`chrome-harness.test.mjs:119-123` moves cross-parent under `"delayed"`), so the phase
  contract is untouched.
- `destination.index ?? to.children.length` preserves the index-less append used by
  `relocateToLocalOnly` (`projection.ts:1124`). For a same-parent index-less move the pre-removal
  default `n` compensates through `index > oldIndex → n-1`, i.e. "append to the end", matching
  Chrome.

**Every existing test that reaches either double's `move`, enumerated and adjudicated** (this is the
C5 evidence, produced by reading each test, not by grep count):

| Test | Double | Move performed | Old model | Faithful model | Verdict |
|---|---|---|---|---|---|
| `chrome-harness.test.mjs:23-31` "workspace trees preserve parent and index order" | `fake-chrome` | **same-parent backward**, `"B"` from index 1 → 0 under `workspace:one` | remove+splice at 0 → `["B","A"]`, `moved.index === 0` | `0 !== 1` and `0 !== 2` → not a no-op; `0 > 1` false → no decrement → `["B","A"]`, index 0 | **green, unchanged.** The only same-parent move in the whole suite, and it is backward — the direction both models agree on |
| `chrome-harness.test.mjs:111-145` "timers, IDs, events, fetch filtering…" | `fake-chrome` | cross-parent, node `41` from `workspace:one` (index 2) → `"2"` index 0; asserts `onMoved` info `{parentId:"2", oldParentId:"workspace:one", index:0, oldIndex:2}` (`:127`) and the removed-node view (`:128`) | as asserted | cross-parent → no no-op test, no decrement; identical splice and identical `moved` payload | **green, unchanged** |
| `projection-behavior.test.mjs:1588-1605` "remote folder move persists and waits for its exact complete callback" | inline | cross-parent `folder-a` → `folder-b`, index 0 | `Object.assign` | splice; `folder-a` left empty, `folder-b` index 0 | **green, unchanged** |
| `projection-behavior.test.mjs:1756-1828` "remote bookmark move persists before effect…" (asserts `movedNode.index === 0` at `:1809`) | inline | cross-parent `folder-a` → `folder-b`, index 0 | `Object.assign` → index 0 | splice → index 0 | **green, unchanged** |
| `projection-behavior.test.mjs:1830-1888` "combined remote bookmark update and move…" (deep-equals the whole node at `:1881`) | inline | cross-parent `folder-a` → `folder-b`, index 0 | `{…, parentId:"folder-b", index:0}` | same, and now with dense sibling indices | **green, unchanged** |
| `projection-behavior.test.mjs:1101-1127` "creating a bookmark directly at the workspace root relocates it…" | inline | cross-parent, **no `index`** (`relocateToLocalOnly:1124`) | keeps stale index 0 | appends at `children.length`; asserts membership only (`:1121-1122`) | **green, unchanged** |
| `projection-behavior.test.mjs:1191-1209` "editing, moving within, or removing a bookmark inside the local-only folder…" | — | calls `handleBookmarkMoved` **directly**; never touches the double's `move` | — | — | **unaffected** |

**No existing test passes only because of the lenient semantics.** The corrected doubles change
observable outcomes for exactly one input class — same-parent forward moves — and the suite
contains none today. That is the same "all current move tests are cross-parent" claim
`proposal.md:67` makes, now verified per-test and extended to cover the double the proposal did not
know about.

**Rejected alternative:** gate the fidelity behind a flag like the existing
`enforceStrictIndices` (`projection-behavior.test.mjs:10`, `:132`, used only at `:1288`). Rejected —
`enforceStrictIndices` exists because strict `create` bounds would break *many* setup helpers that
seed trees loosely; the move audit above shows the faithful `move` breaks **nothing**, so an opt-in
flag would only preserve the ability to write a test against semantics Chrome does not have. That
ability is what produced this incident.

---

## 7. Component and data-flow map

```
 backend event log  (cursor 19: folder.updated INTRO, parentId=null, position 1)
        │
        ▼  replayEvents / socket
 applyRemoteEnvelope                                  projection.ts:1166
        ├─ cursor gate               :1177   (event.cursor <= lastCursor → return)
        ├─ pause gate                :1180
        ├─ PENDING-RECEIPT GATE      :1181   ◄── where the frozen workspace silently exits, forever
        ▼
 applyRemoteFolderUpsert                              projection.ts:1281
        ├─ reconcileFolderChromeNode        :1320
        ├─ getNode(chromeId) → existing     :1351     (oldParentId / oldIndex source of truth)
        ├─ branch selector                  :1357/:1363   (parent !== || index !== position)
        └─ MOVE BRANCH  :1363-1369
              ├─ canPersistReceipt          :1364
              ├─ complete-predecessor guard :1365     (parentId/index defined → narrows types)
              ├─ const move = {...}                   ◄── ADR-202 (single source)
              ├─ persistRemoteReceipt(…, move)  :1366 → :1532  [UNCHANGED — C1]
              │      └─ createRemoteReceipt   convergence.ts:28
              │            └─ shapeSignature  :127            [UNCHANGED — C3]
              ├─ updateNode(title)           :1367  [UNCHANGED; see F-1]
              ├─ moveNode(chromeId, { parentId, index: chromeMoveIndex(move) })  :1368  ◄── ADR-201
              │      └─ chrome.bookmarks.move  chrome-bookmarks.ts:85
              │            └─ BookmarkModel::Move  (pre-removal index; no-op at oldIndex+1)
              ├─ READ-BACK GATE  moved.parentId/index vs move   ◄── ADR-203 (new)
              │      └─ throw RemoteApplyError(…, "final-verification-failed")
              └─ return true  (deferCheckpoint)  :1369
                                   │
                     Chrome fires onMoved (post-move index)
                                   ▼
 handleBookmarkMoved → consumeRemoteMove              projection.ts:1508
        └─ consumeRemoteCallback                      :1512
              └─ reduceRemoteCallback                 convergence.ts:29   [UNCHANGED]
                    ├─ exactIdentity                  :146               [UNCHANGED]
                    └─ callbackMatches                :147               [UNCHANGED]
                          ├─ sameShape → sameUrl      :140 / :135        [UNCHANGED]
                          └─ sameMove                 :154               [UNCHANGED — C1/C3]
              └─ lastCursor = max(lastCursor, receipt.cursor)  :1522-1523

 applyRemoteBookmarkUpsert  :1378   — move branch :1469-1475 is structurally identical;
                                      the update path's existing read-back at :1494-1500 is the
                                      precedent ADR-203 mirrors and is itself untouched.
```

### 7.1 Change inventory

| # | File:line (pre-fix, verified on disk) | Change | ADR |
|---|---|---|---|
| 1 | `extension/src/background/chrome-bookmarks.ts:83` (insert above) | Add exported pure `chromeMoveIndex`; `moveNode` body unchanged | 201 |
| 2 | `extension/src/background/projection.ts:60-73` | Add `chromeMoveIndex` to the existing `./chrome-bookmarks.js` import list (alphabetically first, before `clearChildren`) | 201 |
| 3 | `extension/src/background/projection.ts:1366-1369` | Folder move branch: hoist `const move`, pass `chromeMoveIndex(move)` to `moveNode`, capture `moved`, add the read-back gate | 202/203 |
| 4 | `extension/src/background/projection.ts:1472-1475` | Bookmark move branch: same three edits | 202/203 |
| 5 | `extension/tests/helpers/fake-chrome.mjs:41` | Chromium-faithful `move` | 204 |
| 6 | `extension/tests/projection-behavior.test.mjs:149-154` | Chromium-faithful `move` | 204 |
| 7 | `extension/tests/chrome-move-index.test.mjs` (new file) | T-M1 pure table test | §9.1 |
| 8 | `extension/tests/chrome-harness.test.mjs` (append after `:145`) | T-F1..T-F3 double-fidelity tests | §9.2 |
| 9 | `extension/tests/projection-behavior.test.mjs` (append after `:2616`) | T-M2..T-M6 integration regressions | §9.3 |

**Explicitly not touched:** all of `extension/src/background/convergence.ts` (`sameMove`,
`callbackMatches`, `sameShape`, `sameUrl`, `canonicalUrlForComparison`, `shapeSignature`,
`validReceipt`, `exactIdentity`, `reduceRemoteCallback`, `normalizeJournal`, **`rebuildJournal`**,
`retryJournal`, `gateRemoteEffect`); `moveNode` itself; `persistRemoteReceipt` (`:1532`);
`consumeRemoteCallback` (`:1512`); the update-path read-back (`:1494-1500`);
`relocateToLocalOnly` (`:1124`); `withSuppression` / `isSuppressed`; `doResyncWorkspace`;
`materializeFolder` / `materializeBookmark`; `shared/types.ts`; `shared/storage.ts`;
`extension/scripts/package.mjs`; anything under `backend/` or `admin-web/`.

**Unlike both siblings, this change adds nothing to `convergence.ts` and needs no `rebuildJournal`
edit.** §8.2 proves why.

---

## 8. Self-heal proof — the production workspace at cursor 19, traced end to end

Subject: folder `INTRO`, workspace root (Chrome id differs on every rebuild attempt),
`oldIndex 0 → requested index 1`, same parent, receipt `status: "pending"`, repeated Rebuild ending
in `pauseReason: "chrome-effect-rejected"` across ~5 observed attempts.

### 8.1 How it got stuck (current build)

1. Cursor 19, `folder.updated`, INTRO, `position: 1`. Mapping exists →
   `reconcileFolderChromeNode:1320` returns the chromeId → `existing.index === 0 !== 1` → move
   branch `:1363`.
2. Receipt persisted (`:1366`) with `move = { oldParentId: root, oldIndex: 0, parentId: root, index: 1 }`.
   `existing.title === folder.name` (INTRO was reordered, not renamed), so `:1367` is skipped —
   which is also why follow-up F-1 is not implicated here.
3. `moveNode(chromeId, { parentId: root, index: 1 })` (`:1368`). `index === oldIndex + 1` →
   **Chromium silent no-op. No mutation. No `onMoved`.** The promise still resolves with the node,
   so nothing throws.
4. Branch returns `true`; `:1234` skips the checkpoint; `lastCursor` stays 18.
5. The receipt can never be consumed. Every later event exits at `:1181`. Rebuild throws at `:1058`
   and pauses at `:1084` with `chrome-effect-rejected` and `failedCursor === 18`. Deterministic on
   every attempt, because every input is deterministic — matching the ~5 identical observations.

### 8.2 Does `rebuildJournal` need a receipts-side fix? **No — verified.**

```ts
// extension/src/background/convergence.ts:111-116  (CURRENT, already carries both siblings' filters)
export function rebuildJournal(journal: ConvergenceJournal): ConvergenceJournal {
  const receipts = normalizedReceipts((journal.receipts ?? []).filter((receipt) => receipt.status === "consumed"));
  const localIntents = (journal.localIntents ?? []).filter((intent) => intent.status === "acked");
  const operations = (journal.operations ?? []).filter((operation) => operation.status === "done");
  return { ...journal, phase: "replay", receipts, localIntents, operations, repairDisposition: "rebuild", pauseReason: undefined, failedCursor: undefined };
}
```

The receipts filter keeps **only** `"consumed"`, so a `"pending"` receipt is dropped by
construction — it has been since before either sibling change, and `extension-sync-pause-recovery`
ADR-005 relied on that same line. A `"pending"` receipt is a *different category* from the
`"started"` operations the second sibling had to add a filter for: operations were preserved by the
`...journal` spread, receipts never were. **No convergence-layer edit is required by this change**,
and `sdd-apply` must not add one.

`retryJournal:107` deliberately refuses to clear pending receipts (it forces
`repairDisposition: "rebuild"` instead), which is why the field workspace only ever offers Rebuild
and why Retry has never helped. Correct and unchanged.

### 8.3 Post-fix recovery, step by step

1. **User clicks Rebuild** → `rebuildWorkspace:400-405` → `rebuildJournal` (`:401`): pending
   receipt **dropped** (§8.2), `phase: "replay"`, `pauseReason`/`failedCursor` cleared,
   `repairDisposition: "rebuild"`. `volatileRepairGates.delete` (`:402`) →
   `doResyncWorkspace(…, "explicit rebuild", "recovering")` (`:403`).
2. `doResyncWorkspace:999-1053`: backend tree fetched (`:1016`), managed path ensured (`:1017`),
   **all mappings wiped** (`:1024-1026`), exclusions pruned (`:1031`), local-only folder preserved
   (`:1040`), **every managed Chrome child deleted** (`:1041`) — the INTRO node from the failed
   attempt included — mappings for removed ids dropped (`:1043`), then folders rematerialized from
   backend truth (`:1051-1053` → `materializeFolder:1132-1150`), each created with
   `createFolder(parent, name, folder.position)` (`:1138`). Fresh chromeIds every time, which is
   exactly why the reported workspace-root chromeId varies per attempt.
3. **`lastCursor` is NOT reset by rebuild** — verified: `doResyncWorkspace:999-1059` never writes
   `lastCursor` before the replay loop. Replay is requested from cursor 0 (`:1055`), but every event
   with `cursor <= 18` returns immediately at `:1177` and therefore satisfies the `:1058` assertion
   trivially. **Only cursor 19 and later are actually applied.** This is the single most important
   fact for reading this trace, and it is not stated in `proposal.md`.
4. **Cursor 19 is applied against a freshly materialized tree.** Two readings, both of which
   converge post-fix:
   - **(i) Materialization reproduced position 1.** Backend positions for the workspace root are
     dense and no sibling is excluded, so INTRO was created at index 1. Then
     `existing.index === 1 === folder.position` and `existing.parentId === parentChromeId` → **the
     move branch is not entered at all**. `updateReceipt = existing.title !== folder.name` is
     `false` → the function returns `false` → `:1234` checkpoints `lastCursor = 19` → the `:1058`
     assertion passes → replay continues to 20+.
   - **(ii) Materialization did not reproduce position 1.** `filterFoldersForProjection`
     (`shared/projection-helpers.ts:22-36`) drops locally excluded folders *before* materialization,
     and `materializeFolder` still passes the raw backend `folder.position` to `createFolder`, so an
     excluded or sparse-positioned sibling shifts INTRO to index 0. Cursor 19 then enters the move
     branch as **same-parent forward 0 → 1 — the identical no-op — on every rebuild attempt.**
     Post-fix, `chromeMoveIndex` sends `2`, Chrome decrements to `1`, the node lands at index 1, the
     ADR-203 gate passes, `onMoved` fires with `{oldIndex: 0, index: 1}`, `exactIdentity` +
     `sameMove` + `sameShape` all match the **freshly created** receipt from this replay (never the
     old stuck one, which step 1 deleted), disposition `"consumed"`, and
     `consumeRemoteCallback:1522-1523` sets `lastCursor = 19` before the `:1058` assertion is
     evaluated.
   **The ~5 identical rebuild failures are evidence for reading (ii)**, since reading (i) would
   have recovered the workspace the first time the two sibling fixes cleared the journal. §11 A-1
   records the residual ambiguity and the one alternative explanation that this fix would *not*
   resolve.
5. Replay proceeds past 19; `:1061-1078` sets `lastCursor = replay.currentCursor`,
   `status: "ready"`, `phase: "live"`, clears `pauseReason`/`failedCursor`; `doResyncWorkspace`
   returns `true` → `connectWorkspace` (`:403`).

### 8.4 Which change rescues which population

| | already-stuck install (cursor 19) | future same-parent reorder on the live path |
|---|---|---|
| ADR-201/202 (index compensation) | **required under reading (ii)**; inert under reading (i) | **prevents the wedge entirely** |
| ADR-203 (read-back gate) | inert when the compensation works; converts an unexpected Chrome to a diagnosable pause | same |
| `rebuildJournal` | **no change needed** — it already drops pending receipts (§8.2) | n/a |

### 8.5 Forward property

For any future same-parent reorder on the live path: move branch → receipt persisted with logical
indices → `chromeMoveIndex` sends the compensated index → Chrome moves and emits `onMoved` with the
logical index → read-back gate passes → `callbackMatches` consumes → `lastCursor` advances in the
same tick the callback lands. **No pending receipt survives an apply, so the freeze at `:1181`
becomes unreachable for this class.** Pinned by T-M2/T-M3.

### 8.6 Timing dependency (pre-existing, documented, unchanged)

The rebuild path's assertion at `:1058` requires the `onMoved` handler to have run before it is
evaluated. Between `moveNode` and the assertion there are the ADR-203 comparison, the
`updateProjectionState` write at `:1233` and the `getState()` at `:1058`, each a real
`chrome.storage.local` round trip, which is why replayed moves converge in the field today. **This
design does not change that timing; it only changes whether an `onMoved` is emitted at all.** Tests
must assert on settled journal state, never on synchronous call ordering — the same rule the
`extension-sync-pause-recovery` design set at its §8.

---

## 9. Test strategy (Strict TDD — and a mandatory two-step ordering)

**Harness reality check.** Runner: `extension/package.json:10` —
`"test:projection": "npm run build && node --test tests/*.test.mjs"`. Command:
`cd extension && npm run test:projection`. Framework: `node:test` + `node:assert/strict`. Tests
import compiled output from `../dist/`, and the script chains `npm run build`, so a red test proves
the rebuild happened. **Do not introduce vitest into `extension/`.** 20 test files exist under
`extension/tests/` plus the two doubles catalogued in §2.4.

**Step 0 is a hard gate and is not a test-writing step (C5).** The fake corrections (ADR-204) land
**first**, alone, with **no production change and no new test**, and
`cd extension && npm run test:projection` must be **green** across all 20 existing files before a
single new assertion is written. §6's table is the pre-computed expectation for that run; any
failure outside those seven rows means the corrected `move` is wrong, not that a test was stale.
Only then does red-first begin — because until then, "red" is unobtainable: both doubles make the
buggy call succeed.

Ordering for `sdd-apply`, non-negotiable:

| Step | Action | Expected state |
|---|---|---|
| 0 | Correct both doubles (inventory #5, #6) | existing suite **green**, no production change |
| 1 | Write T-M1 (pure) and T-M2 (integration incident) | **red** — `chromeMoveIndex` does not exist; INTRO stays at index 0 |
| 2 | Land ADR-201 + ADR-202 (inventory #1-#4, minus the read-back gate) | T-M1, T-M2 **green**; full suite green |
| 3 | Write T-M6 (read-back gate, hostile-`move` override) | **red** — no gate exists yet |
| 4 | Land ADR-203 (the two `if (moved…) throw` blocks) | T-M6 **green**; full suite green |
| 5 | Add the remaining regressions T-M3..T-M5, T-F1..T-F3 | green |

### 9.1 `extension/tests/chrome-move-index.test.mjs` (new) — pure, no `chrome` global

Imports `../dist/background/chrome-bookmarks.js` directly (§3 rationale 5).

- **T-M1** *(table-driven, the rule itself)* — for `oldParentId: "p"`:
  - same parent, `oldIndex 0 → index 1` ⇒ **2** *(the incident)*
  - same parent, `oldIndex 0 → index 2` ⇒ **3**; `oldIndex 1 → index 5` ⇒ **6**
  - same parent, `oldIndex 3 → index 1` ⇒ **1** (backward, unchanged)
  - same parent, `oldIndex 2 → index 2` ⇒ **2** (unreachable in production; pinned so the guard's
    shape is explicit — see §2.2)
  - cross-parent, `oldIndex 0 → index 1` ⇒ **1**; cross-parent `oldIndex 5 → index 0` ⇒ **0**
  - purity: the input object is `deepEqual` to its literal after the call (**no mutation** — this is
    the C1 guard at the unit level, since the same object is the receipt's `move`)
  - totality: never returns `NaN`/`undefined` for any of the above; the return is always
    `index` or `index + 1`

### 9.2 `extension/tests/chrome-harness.test.mjs` (append after `:145`) — double fidelity

These pin ADR-204 in `fake-chrome.mjs`, which is the double with real event plumbing and is
therefore the only place the "no `onMoved`" half of the contract is observable.

- **T-F1** *(the quirk)* — same-parent move of the index-0 child to `index: 1` with an `onMoved`
  listener attached: the callback resolves, the child order is **unchanged**, and **zero `onMoved`
  events are delivered** (checked after `harness.mutators.settle()`).
- **T-F2** *(forward-by-many, pre-removal decrement)* — four children; move index 0 to `index: 3`:
  lands at index **2**, and `onMoved` reports `{ oldIndex: 0, index: 2 }`. This is the assertion that
  proves the fake models pre-removal coordinates rather than merely special-casing `oldIndex + 1`.
- **T-F3** *(unchanged directions + bounds)* — same-parent backward `2 → 0` lands at 0 and emits
  `onMoved`; cross-parent `index: 0` lands at 0 with the source parent renumbered dense;
  index-less same-parent move appends to the end; `index > children.length` throws
  `Index out of bounds.`
- Existing `chrome-harness.test.mjs:23-31` and `:111-145` **must stay green** (§6 table rows 1-2).

### 9.3 `extension/tests/projection-behavior.test.mjs` (append after `:2616`) — integration

All reuse the file's existing `createBookmarkNode` / `rebuildBookmarkChildren` /
`createEditorProjection` / `createSyncEvent` / `MockWebSocket` helpers and the shape of the existing
move tests at `:1588` and `:1756`.

- **T-M2** *(the production incident, folder, forward-by-one)* — seed `workspace-node` with
  `intro-node` (`INTRO`, index 0) and `other-node` (index 1); emit
  `folder.updated { id: "folder-intro", parentId: null, name: "INTRO", position: 1 }` at cursor 19
  with `lastCursor: 18`. Assert, **in this order**:
  1. `bookmarkNodes.get("intro-node").index === 1` — **the red assertion**; pre-fix the corrected
     double leaves it at 0;
  2. the receipt is `pending` with `move === { oldParentId: "workspace-node", oldIndex: 0, parentId: "workspace-node", index: 1 }`
     — **C1: the persisted record carries the logical `1`, never the Chrome-facing `2`**;
  3. after `handleBookmarkMoved("intro-node", { parentId: "workspace-node", oldParentId: "workspace-node", index: 1, oldIndex: 0 })`,
     the receipt is `consumed` and `lastCursor === 19`;
  4. `journal.pauseReason === undefined` and `localIntents.length === 0`.
- **T-M3** *(forward-by-many, bookmark)* — bookmark at index 0 among four siblings, remote
  `position: 3`; assert the node lands at index **3** (not 2), receipt `move.index === 3`, and the
  matching `onMoved` consumes it. Guards against a fix that special-cases only `oldIndex + 1`.
- **T-M4** *(backward same-parent is untouched)* — node at index 3 → `position: 1`; lands at 1,
  consumes, `lastCursor` advances. Would fail if the compensation were applied unconditionally.
- **T-M5** *(cross-parent is untouched)* — the property already covered by `:1756`, restated at
  index > 0: `folder-a[0] → folder-b` at `position: 1` with one existing child in `folder-b`; lands
  at 1. Would fail if the compensation ignored the parent comparison.
- **T-M6** *(ADR-203 gate — the C8 insurance)* — override `chrome.bookmarks.move` for this test
  only with a "legacy Chrome" implementation that ignores the compensation (i.e. reproduces the
  no-op for `index === oldIndex + 1` *after* the +1, simulating a Chrome that dropped the quirk and
  therefore lands the node one slot too far), restoring it in a `finally`. Assert the workspace
  pauses with `pauseReason === "final-verification-failed"` at `failedCursor === event.cursor`, and
  that the diagnostic entry carries `requestedChromeIndex` and `observedIndex`. **Red before ADR-203
  lands** (today the mismatch is silent). This is the in-repo override pattern established by
  `create-ownership.test.mjs:255-256`, applied to `move` instead of `get`.

**Deliberately not attempted:** a full `rebuildWorkspace` integration test of §8.3. It would need
`getWorkspaceTree`, `ensureManagedPath` and `replayEvents` fetch doubles queued in exact order plus
a socket double, to prove a path whose distinctive step (cursor 19 re-entering the move branch
against a rematerialized tree) is already isolated by T-M2. Inherited follow-up F-4 from the
create-ownership sibling; recorded again as F-5.

**Definition of done.** `cd extension && npm run test:projection` green (all existing files plus
the new cases) and `cd extension && npm run typecheck` green. The only typecheck-relevant change is
the new export and the two hoisted `const move` bindings; `moveNode`'s signature is unchanged.

---

## 10. Out of scope / follow-ups

| ID | Item | Why deferred |
|----|------|--------------|
| **F-1** | Inherited from `extension-sync-pause-recovery` F-2: the move branch's intermediate `updateNode` (`projection.ts:1367`, `:1473`) fires `onChanged` against a `move` receipt → `callbackMatches` fails the kind test → `"rejected"` → pause, for any remote event that both moves *and* renames. Still present on this branch. **Not implicated in this incident** (INTRO was reordered, not renamed — §8.1 step 2) | Different defect, different mechanism, needs its own proposal |
| **F-2** | `materializeFolder` (`projection.ts:1138`) passes raw backend `folder.position` to `createFolder` after `filterFoldersForProjection` has removed excluded siblings, so a locally excluded folder can shift or invalidate every later sibling's index during rebuild. **This is reading (ii) of §8.3 and the most likely reason the field workspace's rebuilds were deterministic.** A dense-index materialization would make rebuild idempotent with respect to exclusions | Changes rebuild's materialization contract; needs its own proposal and its own evidence |
| **F-3** | `doResyncWorkspace`'s `catch {` (`projection.ts:1082`) **discards the error entirely** before pausing with `chrome-effect-rejected`. Every rebuild failure in the field is therefore causeless in the diagnostics, which is why §8.3's two readings cannot be told apart from the reported logs | One-line observability fix, but out of this proposal's scope (`proposal.md:24-34`); it would materially improve `sdd-verify`'s evidence for this very change |
| F-4 | Non-Chromium browsers (Firefox interprets the destination index in post-removal space and has no no-op quirk). Chromium-based Edge shares this model | `proposal.md:95`; a port would need `chromeMoveIndex` to become browser-conditional, which is exactly why it is a single named rule |
| F-5 | End-to-end `rebuildWorkspace` integration test with fetch + socket doubles | Inherited F-4 from the create-ownership sibling; disproportionate, and T-M2 isolates the property |
| F-6 | Workspace-wide freeze blast radius: one pending receipt silently blocks every later event at `:1181` while the workspace still reports `phase: "live"` and `health: "live"`. There is no timeout, no diagnostic, and no UI signal until a Rebuild fails | Pre-existing resilience gap, not a bugfix; ADR-203 removes this change's contribution to it but not the mechanism |
| F-7 | `chrome.bookmarks.create` shares the index space but **not** the quirk (there is no old index); no compensation is needed or added there | Recorded so a future reader does not "fix" `createFolder`/`createBookmark` by symmetry |

---

## 11. Risks and assumptions requiring validation

| Risk / assumption | Severity | Validation |
|---|---|---|
| **A-1 — the ~5 deterministic rebuild failures are explained by reading (ii) of §8.3.** The alternative is that materialization itself throws (`createFolder` with a position beyond the current child count → `Index out of bounds` → the bare `catch` at `:1082` → the same `chrome-effect-rejected`), in which case rebuild fails **before ever reaching cursor 19** and this change does **not** recover that install | **High (scope)** | Cannot be distinguished from the reported logs today because of F-3. `sdd-verify` must check the post-fix rebuild's *diagnostics*, not just its pause reason: reading (ii) produces a `branch: "move"` diagnostic for cursor 19 (`logRemoteApplyDiagnostic:1362`); the alternative produces none. If the alternative holds, F-2 becomes the required fix and this change is still correct but insufficient. **Flagged for the proposal author — `proposal.md:69` treats "already-stuck installs stay stuck" as a *medium* risk to "verify explicitly"; this is that verification, and it is not fully resolvable pre-merge.** |
| **A-2 — Chromium's `BookmarkModel::Move` really no-ops at `index == oldIndex + 1` and decrements above `oldIndex`.** Everything in §3 depends on it | Med | `proposal.md:46` gates implementation on observing it in a real browser; the task brief reports two independent external corroborations. **ADR-203 is the structural mitigation**: if the assumption is wrong in either direction, the read-back fires at the offending cursor with `requestedChromeIndex`/`observedIndex` instead of stalling. T-M6 pins that the gate works |
| **A-3 — the compensated index can never be rejected as out of bounds.** Proven for any valid final index `d ≤ n-1` (§2.2). The exception: a backend `position === n` (i.e. already out of range for a same-parent final index). Today Chrome accepts `n` (`n > n` is false), decrements, and silently lands the node last, producing a callback mismatch → `final-verification-failed`. Post-fix `n+1 > n` → Chrome errors → `moveNode` rejects → **`chrome-effect-rejected` instead** | Low | Both outcomes are a pause; only the reason changes, and only for a backend/projection divergence that is already broken. Deliberately **not** clamped (ADR-201 rejected alternative d). Recorded so `sdd-verify` does not read the reason change as a regression |
| Corrected doubles break an existing test | Low | §6 enumerates every test that reaches either `move`, with the per-test verdict. Step 0 of §9 is the gate |
| The corrected `projection-behavior.test.mjs` double diverges from the corrected `fake-chrome.mjs` double | Med | Two hand-written doubles for one API is the root cause of §2.4. Both are corrected in one change with the same five rules in the same order (bounds → no-op → decrement → splice → renumber). Consolidating them is worth its own housekeeping change; not attempted here |
| ADR-203 fires spuriously and pauses a workspace whose move actually succeeded | Low | The gate compares Chrome's own post-move report against the receipt the callback will be matched against; if they disagree, the callback would have been rejected anyway (`convergence.ts:147`) — the gate only makes it happen sooner, at the right cursor, with a diagnostic |
| A future editor passes the adjusted index to `persistRemoteReceipt` | Low | ADR-202's single `const move` leaves no adjusted value in scope. Review invariant stated in §4; T-M2 assertion 2 pins the persisted `move.index === 1` while the Chrome call used `2` |
| Branch stacking: this change is only correct on top of both siblings | Resolved | `rebuildJournal`'s three filters (`convergence.ts:112-114`) confirmed present on disk; §8.3 step 1 depends on the receipts filter (pre-existing) and step 2's clean journal depends on the operations/intents filters (siblings). No *code* dependency — `chromeMoveIndex` is self-contained — so a rebase onto `develop` compiles, but the self-heal trace would not hold there |
| `openspec/config.yaml` records `strict_tdd: false` and `testing.test_runner.available: false` (detected 2026-06-30) | Low | Stale for `extension/`, as the create-ownership sibling already recorded (`design.md:747-751`). §9 follows the real harness and this session's Strict TDD. Re-detecting the testing config remains a separate housekeeping change |

---

## 12. Threat matrix and project-rule compliance

**Threat matrix: N/A — confirmed, not skipped.** The change introduces no routing, shell command,
subprocess, VCS/PR automation, executable-file classification, credential handling, or
process-integration boundary. The production diff is one pure arithmetic function plus two
comparisons inside an existing Chrome-extension background module; the remaining diff is test-only.
No new module reaches the release package (`scripts/package.mjs:26` already allowlists
`dist/background/chrome-bookmarks.js`), so the packaging-integrity surface is unchanged. No matrix
rows apply; no matrix-derived tasks are generated.

**`openspec/config.yaml` `rules.design` compliance:**

- *"Keep the backend modular and document sync/event consistency rules."* No backend change. The
  sync/event consistency rules this change touches are documented explicitly:
  - **the deferred-checkpoint rule** — a move branch returns `true`, so `lastCursor` advances only
    when the matching `onMoved` is consumed (`:1234` vs `:1522-1523`); an effect that emits no
    callback therefore freezes the cursor by design (§2.1, §2.3);
  - **the persist-before-effect rule** — the receipt is written before the Chrome call and is never
    rewritten afterwards, which is why ADR-203 gates *after* the effect rather than moving the
    receipt (§5);
  - **the coordinate-space rule (new, and the substance of this change)** — receipts, backend
    positions, `onMoved` payloads and `sameMove` all speak **post-move/backend-logical** indices;
    `chrome.bookmarks.move`'s `destination.index` alone speaks **pre-removal** indices, and
    `chromeMoveIndex` is the single, named, tested boundary between the two (§2.2, ADR-201/202);
  - **the pending-receipt gate** (`:1181`) and the **rebuild checkpoint assertion** (`:1058`),
    both unchanged, plus the rebuild retention rule for receipts/intents/operations
    (`convergence.ts:112-114`, unchanged — §8.2).
- *"Document contracts between the Go backend and Chrome extension."* **The backend↔extension
  contract is unchanged.** The backend remains the source of truth for logical positions; the
  extension continues to store and compare those exact numbers, and now translates them correctly
  when — and only when — handing them to `chrome.bookmarks.move`. No API surface, event payload,
  envelope shape, or persisted schema on either side is modified. The one contract *clarified* by
  this design, and worth carrying into the spec delta, is that **`FolderResource.position` /
  `BookmarkResource.position` are final-position semantics in the destination parent, never Chrome
  destination indices.**
