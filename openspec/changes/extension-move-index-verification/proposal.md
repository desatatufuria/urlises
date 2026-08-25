# Proposal: Chrome-Correct Destination Index for Same-Parent Moves

## Intent

The same customer workspace ("Jira", SINGULARBANK), after the two prior URL fixes advanced it from cursor 11 to 18, is now permanently stuck at cursor 19 on a **folder reorder within one parent**: `INTRO` from index 0 to index 1 under workspace root `69096`. The receipt stays `status: "pending"` forever, every Rebuild replays the same `eventId` and ends at `pauseReason: "chrome-effect-rejected"`. No URL is involved (both signature slots are `null`).

**This is not the URL class of defect.** `sameMove`, `sameShape`, and `callbackMatches` (`convergence.ts:140-155`) are correct. The effect issued to Chrome is wrong.

Chromium's `BookmarkModel::Move` interprets `destination.index` in the **pre-removal** coordinate space for same-parent moves: it early-returns as a silent no-op when `index == oldIndex || index == oldIndex + 1`, and otherwise decrements `index` when `index > oldIndex`. Both move branches pass the desired *final* index straight through (`projection.ts:1368`, `:1474`):

| Same-parent move | Code passes | Real Chrome result | Observed failure |
|---|---|---|---|
| 0 → 1 (this incident) | `index: 1` | **no-op, `onMoved` never fires** | receipt pending → replay guard at `projection.ts:1058` throws → `chrome-effect-rejected`, forever |
| 0 → 2 | `index: 2` | lands at index **1** | callback mismatches receipt → `final-verification-failed` |
| backward (3 → 1) | `index: 1` | lands at 1 | correct today |
| cross-parent | `index: n` | lands at n | correct today |

Correct call: `sameParent && desired > oldIndex ? desired + 1 : desired`.

**Why CI never caught it**: the test fake (`tests/helpers/fake-chrome.mjs:41`) implements *post-removal* splice semantics, so the buggy call looks correct there. The harness actively encodes the wrong model.

## Scope

### In Scope
- One shared destination-index translation applied at both move call sites (folder `projection.ts:1363-1369`, bookmark `:1469-1476`). Both have the identical defect.
- Correct `fake-chrome.mjs` `move()` to model real Chromium semantics (pre-removal index, no-op early return, `onMoved` suppressed on no-op). **Prerequisite** — without it the correct fix fails the suite.
- Regression tests for the untested same-parent axis: forward-by-one (the incident), forward-by-many, backward, cross-parent unchanged.
- Empirical confirmation in a real browser before implementation (see Approach).

### Out of Scope
- `sameMove` / `sameShape` / `callbackMatches` / receipt shape — unchanged. The receipt's logical `move.index` already equals the post-move index Chrome reports.
- Re-verifying moves via `getChildren()`, or relaxing same-parent matching. Both were considered and **rejected**: they paper over a deterministic off-by-one with unconditional re-reads or weaker proof, contradicting the `extension-sync-convergence` "Complete Callback Proof" requirement.
- Retry/settle strategies for MDN's async-ordering warning. `doResyncWorkspace` (`:1056-1059`) already `await`s each apply sequentially, so that warning does not explain a deterministic, Rebuild-immune stall.
- `sameUrl` / `canonicalUrlForComparison` / `finishRemoteCreate`. Backend `position` semantics (not implicated — backend positions are correct; only the Chrome call is).

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `extension-sync-convergence`: a remote move MUST issue the Chrome destination index that actually produces the requested final position, so same-parent reorders emit a matching `onMoved` and converge.

## Approach

1. **Falsify first.** Confirm in a real Chrome that `move(id, {parentId: same, index: oldIndex + 1})` is a no-op emitting no `onMoved`. This proposal's root cause is derived from Chromium source semantics; implementation must not start until observed. If falsified, the fallback is a post-move read-back that converts the silent no-op into a diagnosable gate.
2. Fix the fake to match observed Chrome; the incident test must then fail (red).
3. Add the translation helper at both call sites; test goes green.

Existing move tests are all cross-parent, so ripple is expected to be near zero.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `extension/src/background/projection.ts` | Modified | Destination index at both move branches |
| `extension/tests/helpers/fake-chrome.mjs` | Modified | Chromium-accurate `move()` |
| `extension/tests/projection-behavior.test.mjs` | Modified | Same-parent move regressions |

Estimated well under the 800-line budget.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Chromium semantics differ from source reading | Medium | Gate implementation on step 1; fallback path defined |
| Corrected fake breaks existing tests | Low | All current move tests are cross-parent, where both models agree |
| Firefox/Edge index semantics differ | Low | Chromium-based Edge shares the model; note as follow-up, not this fix |
| Already-stuck installs stay stuck | Medium | Manual Rebuild re-enters the move branch and now succeeds — verify explicitly |

## Rollback Plan

Single revert of the branch. No persisted-schema change: only the argument passed to `chrome.bookmarks.move` and test-only code change. Reverting restores the stall for same-parent forward moves.

## Dependencies

- Stacked on `fix/extension-create-ownership-url-normalization` → `fix/extension-sync-pause-recovery`. No code dependency on either; stacking is delivery-ordering only, so this can rebase onto `develop` if the parents merge first.

## Success Criteria

- [ ] A same-parent forward-by-one folder move emits `onMoved`, consumes its receipt, and checkpoints.
- [ ] Forward-by-many lands at the exact requested index.
- [ ] Backward and cross-parent moves are unchanged.
- [ ] Bookmark moves get the same fix and coverage.
- [ ] The affected workspace advances past cursor 19 after a manual Rebuild.
- [ ] Corrected fake reproduces the production failure before the fix.

## Proposal question round — for orchestrator/user review

Assumptions taken; correct any that are wrong:

1. **Recovery** is manual Rebuild (consistent with the two prior fixes); no auto-repair-on-upgrade.
2. **Bookmark moves are in scope** even though only a folder was reported, since the defect is in the shared call pattern and shipping folders-only leaves a known live bug.
3. **No defensive post-move read-back** is added while the deterministic cause holds; it is the fallback only if step 1 falsifies the root cause. Confirm you prefer the minimal fix over an added safety net.
4. **Non-Chromium browsers** are out of scope for this fix.
