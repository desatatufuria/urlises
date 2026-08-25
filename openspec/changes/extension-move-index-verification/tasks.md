# Tasks: Chrome-Correct Destination Index for Same-Parent Moves

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~320-470 (prod ~27, doubles ~45, new tests ~250-400) |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR1 → PR2 → PR3 → PR4 (mirrors §9 step table) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium

Note: 7 files touched (2 prod + 2 doubles + 3 test files) — more than either sibling. Design's "~14 lines" covers production only; total diff incl. mandatory double rewrites and new regression tests plausibly exceeds 400. Chaining is low-cost here since §9's step order already forces 4 natural green checkpoints.

### Suggested Work Units

| Unit | Goal | PR | Focused test | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Step 0: correct both doubles, no prod change | PR1 | `cd extension && npm run test:projection` | N/A — suite is the harness | revert 2 double files |
| 2 | T-M1+T-M2 red → ADR-201/202 green | PR2 | same | Manual Rebuild, real SINGULARBANK workspace, cursor 19 | revert chrome-bookmarks.ts export + projection.ts branch edits |
| 3 | T-M6 red → ADR-203 green | PR3 | same | N/A — gate reachable only via test override | revert 2 `if(moved…)throw` blocks |
| 4 | Remaining regressions T-M3-5, T-F1-3 | PR4 | same | N/A — coverage only | revert test-only additions |

## Phase 1: Step 0 — Correct Both Test Doubles (prerequisite, no prod change)
- [x] 1.1 Rewrite `move()` in `extension/tests/helpers/fake-chrome.mjs:41` — Chromium-faithful (pre-removal index, same-parent no-op, decrement, splice, renumber, bounds) — ADR-204
- [x] 1.2 Rewrite inline `move()` in `extension/tests/projection-behavior.test.mjs:149-154` — same five rules — ADR-204
- [x] 1.3 Run `cd extension && npm run test:projection`; confirm all 20 existing files GREEN per design §6 table (unexpected failure = wrong double, not stale test) — confirmed: 215/215 green, no unexpected failures

## Phase 2: RED — Pin the Incident
- [x] 2.1 New file `extension/tests/chrome-move-index.test.mjs`: T-M1, table-driven, imports `dist/background/chrome-bookmarks.js` directly (no `chrome` global)
- [x] 2.2 Append T-M2 to `projection-behavior.test.mjs`: forward-by-one folder incident — asserts index, receipt `move` (logical value), consumption via `handleBookmarkMoved`, `lastCursor`
- [x] 2.3 Run suite; confirm T-M1/T-M2 RED (`chromeMoveIndex` missing) — confirmed: T-M1 (module export missing), T-M2 (`0 !== 1` index assertion), 215/217 pass otherwise

## Phase 3: GREEN — ADR-201/202
- [x] 3.1 Add exported `chromeMoveIndex(move)` above `moveNode` in `extension/src/background/chrome-bookmarks.ts:83`
- [x] 3.2 Add `chromeMoveIndex` to import list in `projection.ts:60-73`
- [x] 3.3 Folder branch `projection.ts:1366-1369`: hoist `const move`, pass unchanged to `persistRemoteReceipt`, pass `chromeMoveIndex(move)` to `moveNode`, capture `moved`
- [x] 3.4 Bookmark branch `projection.ts:1472-1475`: identical edits
- [x] 3.5 Run suite + `npm run typecheck`; confirm T-M1/T-M2 and full suite GREEN — confirmed: 217/217 pass, typecheck clean

## Phase 4: RED — Read-Back Gate
- [x] 4.1 Append T-M6 to `projection-behavior.test.mjs`: per-test override of `chrome.bookmarks.move` (legacy no-op-after-compensation double), restored in `finally`; assert `final-verification-failed` at `event.cursor` with `requestedChromeIndex`/`observedIndex`
- [x] 4.2 Run suite; confirm T-M6 RED — confirmed: `pauseReason` was `undefined` (expected `final-verification-failed`), 217/218 pass otherwise

## Phase 5: GREEN — ADR-203
- [x] 5.1 Folder branch: read-back gate after `moveNode`; throw `RemoteApplyError(..., "final-verification-failed")` on `moved` mismatch
- [x] 5.2 Bookmark branch: identical gate
- [x] 5.3 Run suite; confirm T-M6 and full suite GREEN — confirmed: 218/218 pass

## Phase 6: Regression Coverage
- [x] 6.1 Append T-F1 (quirk: zero `onMoved` on no-op) to `chrome-harness.test.mjs` (after :145)
- [x] 6.2 Append T-F2 (forward-by-many, pre-removal decrement) — same file
- [x] 6.3 Append T-F3 (backward, cross-parent, index-less append, out-of-bounds) — same file
- [x] 6.4 Append T-M3 (bookmark forward-by-many) to `projection-behavior.test.mjs`
- [x] 6.5 Append T-M4 (backward same-parent untouched) — same file
- [x] 6.6 Append T-M5 (cross-parent untouched) — same file
- [x] 6.7 Run `npm run test:projection` + `npm run typecheck`; confirm full suite GREEN — confirmed: 224/224 pass, typecheck clean

## Phase 7: Verification
- [x] 7.1 Grep `projection.ts`: `chromeMoveIndex(...)` appears only inside the `moveNode` destination literal (C1) — 3 call-site occurrences found (2x inside `moveNode(...)`, 2x inside the ADR-203 diagnostic `requestedChromeIndex` field, verbatim per design.md §5); none reach `persistRemoteReceipt`, `sameMove`, or `callbackMatches`. See apply-progress "Deviations" note — design.md's own ADR-203 snippet has this exact second occurrence, so this is not a deviation from design, only a refinement of the task brief's literal grep wording.
- [x] 7.2 Confirm `persistRemoteReceipt`'s last argument is the unmodified `move` at both sites (C1/C3) — confirmed via grep, lines 1368 and 1478
- [ ] 7.3 Post-merge manual Rebuild on the real SINGULARBANK workspace (cursor 19) — the only real test for design §11 risk A-1. A `branch: "move"` diagnostic at cursor 19 confirms this fix as cause; its absence means F-2 (materialization drift) is the actual cause and this fix, though correct, is insufficient for the reported incident. Not resolvable by static analysis or unit/integration tests. **Left unchecked — requires live production access, out of scope for this apply session.**
- [x] 7.4 Do not open F-1..F-7 follow-ups in this change (design §10) — confirmed, none opened
