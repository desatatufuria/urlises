# Tasks: Fix permanent sync pause caused by URL-normalization mismatch

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~55 production (convergence.ts ~30, projection.ts ~22, harness sanity ~3) + ~180-250 new test file (21 named cases) ≈ 250-320 total |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | ADR-001–005 fix + full regression suite | PR 1 | `cd extension && npm run test:projection` | Manual: load unpacked build, rename remote bare-origin bookmark, confirm no pause/queued intent (task 7.1) | Single revert of branch merge; no persisted-format change (`shapeSignature`, `RemoteReceipt`, journal untouched) |

## Phase 1: Harness Sanity (Foundation)
- [x] 1.1 DEVIATION: `extension/tests/` already exists with 18 test files incl. `convergence.test.mjs` (182 tests, baseline green) — design's "zero test files" premise is stale for this tree. Sanity re-verified anyway: appended a deliberately failing placeholder test, ran `npm run test:projection`, confirmed exit code 1 / `fail 1`, then reverted the placeholder. Harness is proven non-vacuous.

## Phase 2: ADR-001/002 — Canonicalized URL comparison (convergence.ts)
- [x] 2.1 RED: added T-U1–T-U6 (canonicalizer, design §9) + T-C1, T-C2, T-C5, T-C6, T-C7, T-B1 to `convergence.test.mjs`; ran test:projection, confirmed red (8 failing: T-U1-U6 "canonicalUrlForComparison is not a function", T-C1 and T-C7 shape mismatch on raw comparison; T-C2/C5/C6/B1 passed unaffected).
- [x] 2.2 GREEN: added exported `canonicalUrlForComparison`, private `sameUrl`, private `sameShape` to `convergence.ts` after `shapeSignature` (~line 119), exact code per design §3/§7.1.
- [x] 2.3 GREEN: rewired `callbackMatches` (`convergence.ts:121`) to `validReceipt(receipt) && sameShape(...)` instead of raw `shapeSignature`/`expectedSignatures[1]` equality; kept `validReceipt(receipt) &&` as first conjunct (ADR-001 invariant).
- [x] 2.4 Ran test:projection; confirmed T-U1–U6, T-C1/C2/C5/C6/C7, T-B1 green (194/194 total, no regressions).

## Phase 3: ADR-003 — "rejected" disposition, no phantom intent (convergence.ts, projection.ts)
- [x] 3.1 RED: added T-C3, T-C4, T-C8, T-I1, T-I2, T-I3 to convergence.test.mjs; confirmed red (6 failing: no `"rejected"` disposition yet). DEVIATION (necessary, not a design gap): 3 pre-existing tests in `convergence.test.mjs` (predating this change) encoded the exact pre-fix buggy `"intent"` behavior for identity-matched/shape-mismatched callbacks — updated their assertions in the same RED step to the ADR-003-mandated `"rejected"` outcome, since that is literally the incident behavior being corrected (design assumed no pre-existing test file; this tree already had one).
- [x] 3.2 GREEN: added `"rejected"` disposition + optional `cursor` to `reduceRemoteCallback` (`convergence.ts:29-33`), exact code per design §4.
- [x] 3.3 GREEN: updated caller (`projection.ts:1516-1522`) to route `result.disposition === "rejected"` → `gateRemoteEffect(result.journal, result.cursor ?? projection.lastCursor, "final-verification-failed")`; kept `"consumed"` branch and `before` (`:1510`) intact.
- [x] 3.4 Ran test:projection; confirmed T-C3/C4/C8, T-I1/I2/I3 green, plus all 3 updated pre-existing tests green (200/200 total, no regressions).

## Phase 4: ADR-004 — Suppression mirror on update branch (projection.ts)
- [x] 4.1 Replaced `projection.ts:1481-1487`: wrapped `updateNode(chromeId, {...})` in `withSuppression(..., [chromeId])`, exact structural mirror of the create branch (`:1435-1447`); folded the existing try/catch inside the callback; preserved `createRemoteApplyError(error, existingContext)` byte-for-byte.
- [x] 4.2 Ran test:projection; confirmed no regression (200/200). DEVIATION FROM DESIGN (favorable): design §9 states integration-level coverage of the update branch is infeasible/disproportionate and was deliberately not attempted — false for this tree. `tests/projection-behavior.test.mjs` already has a full `chrome.bookmarks`/`MockWebSocket` harness (`projectionTestHooks.applyRemoteEnvelope`, `handleBookmarkChanged`) that drives `applyRemoteBookmarkUpsert`'s update branch end-to-end, e.g. "remote update pauses at a hidden-field verification failure" (line ~1543), which passed unchanged, confirming genuine mismatches still gate/pause through the suppressed branch exactly as before.

## Phase 5: ADR-005 — Rebuild drops queued intents (convergence.ts)
- [x] 5.1 RED: added T-R1, T-R2, T-R3 to convergence.test.mjs; confirmed red (T-R1, T-R2 failing; T-R3 passed since `retryJournal` was already untouched).
- [x] 5.2 GREEN: in `rebuildJournal` (`convergence.ts:105-108`), filtered `localIntents` to `status === "acked"` only, mirroring the existing receipts filter; left `retryJournal` untouched; exact code per design §6.
- [x] 5.3 Ran test:projection; confirmed T-R1/R2/R3 green. DEVIATION (necessary, favorable): this surfaced a 4th pre-existing test in `tests/projection-behavior.test.mjs` — "Retry keeps an unproven receipt paused and Rebuild is the only destructive workspace action" — that reproduces the exact production incident end-to-end (a queued, non-acked local intent set up pre-rebuild, asserted to survive `rebuildWorkspace()` with `localIntents.length === 1`). Updated the assertion to `0` per ADR-005 and renamed the test to say so; this is now a genuine, already-wired end-to-end regression test of design §8's P2/P3 self-heal property, stronger than the pure-unit coverage design anticipated. All 203/203 tests green.

## Phase 6: Verification Gate
- [x] 6.1 Ran `cd extension && npm run test:projection`: full suite green — 203/203 (0 fail), includes all 21 named cases (T-U1-U6, T-C1-C8, T-I1-I3, T-R1-R3, T-B1) plus harness sanity plus 4 updated pre-existing tests plus zero regressions across the rest of the extension suite.
- [x] 6.2 Ran `npm run typecheck` in `extension/`: green, no errors (`reduceRemoteCallback` return-type widening was the only typecheck-relevant signature change; caller in `projection.ts` already narrowed correctly).

## Phase 7: Manual Verification (not automatable by sdd-verify)
- [ ] 7.1 NOT COMPLETED — requires human verification. sdd-apply has no browser access. Human/follow-up must: load the unpacked extension build, create a bare-origin bookmark remotely, rename it, confirm the workspace stays `live` with no queued intent in options-page diagnostics.
