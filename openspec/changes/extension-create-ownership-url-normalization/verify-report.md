# Verification Report: extension-create-ownership-url-normalization

**Change**: extension-create-ownership-url-normalization
**Branch**: fix/extension-create-ownership-url-normalization (stacked on fix/extension-sync-pause-recovery, tip `df16196`)
**Mode**: openspec (proposal + spec + design + tasks, full artifact set)
**Verdict**: PASS

## 1. Completeness table (tasks.md)

| Phase | Task | State claimed | State verified |
|---|---|---|---|
| 1 RED | 1.1–1.5 | [x] | Test code present and matches design's named cases exactly |
| 2 GREEN (ADR-102) | 2.1–2.3 | [x] | `export function sameUrl` present, import updated |
| 3 GREEN (ADR-101) | 3.1–3.2 | [x] | `!sameUrl(node.url, ownership.url)` present, other 4 disjuncts untouched |
| 4 GREEN (ADR-103) | 4.1–4.3 | [x] | `operations` filter present; grep re-verified independently |
| 5 Completion gate | 5.1–5.3 | [x] | 215/215 tests, clean typecheck, both re-run independently by me |

16/16 checked, all confirmed against actual code/test state. No drift found.

## 2. Runtime evidence (executed independently in this pass)

- `cd extension && npm run test:projection` → **215/215 pass**, 0 fail, 0 skip (build runs first; compiled dist reflects current source).
- `cd extension && npm run typecheck` → exit 0, no diagnostics.

Both match the orchestrator's independently-reported results.

## 3. Production diff — byte-for-byte check against design.md

`git diff df16196 -- extension/src/background/convergence.ts extension/src/background/projection.ts` shows exactly:

- `convergence.ts`: `rebuildJournal` gains `const operations = (journal.operations ?? []).filter((operation) => operation.status === "done");` and `operations` added to the return spread — matches ADR-103's quoted diff verbatim. `function sameUrl` → `export function sameUrl`, body byte-identical — matches ADR-102's quoted diff verbatim.
- `projection.ts`: import list gains `sameUrl` (positioned alphabetically after `retryJournal`, before the `type RepairGate` import) — matches ADR-102. `finishRemoteCreate`'s guard: `!node ||` confirmed first disjunct, `parentId`/`index`/`title` clauses byte-identical and unreordered, only the URL clause changed from `node.url !== ownership.url` to `!sameUrl(node.url, ownership.url)` — matches ADR-101 verbatim, including the "invariant to preserve" (`!node ||` stays first).

No other lines in either file differ from the sibling-change tip. Total diff: convergence.ts +2/-1 net lines, projection.ts +2/-2 net lines — well inside the design's ~6-line production estimate and C7's budget claim.

## 4. Spec-to-test compliance matrix

### Requirement: Complete Create Ownership Proof

| Scenario | Covering test(s) | Verified GIVEN/WHEN/THEN match | Runtime result |
|---|---|---|---|
| Bare-origin create converges without pause | T-P1 (`create-ownership.test.mjs`) | Submits `url: "https://pruebs"`, overrides `bookmarks.get` to return `"https://pruebs/"` on read-back (exactly the GIVEN/WHEN), asserts `status === "done"`, not paused, no pause-reason, zero phantom mutations (THEN) | PASS |
| Folder create still verifies with undefined URL | T-P2 | Folder payload has no `url`; asserts `status === "done"`, not paused. Also covers the byte-identical-URL bookmark fast path (extra, not required by spec but consistent) | PASS |
| Title mismatch still pauses | T-P3 (title sub-case) | `get` override sets `title: "Wrong Title"`; asserts `status === "started"`, `phase === "paused"`, `pauseReason === "ambiguous-operation"` | PASS |
| Genuine parent, index, or URL mismatch still pauses | T-P3 (parentId, index, "genuinely different url" sub-cases) | Same pattern, 3 more sub-cases including a genuinely-different URL (`https://other.test/` vs `https://pruebs`) — directly pins the "over-normalizing hides a wrong-URL create" risk from proposal.md | PASS (4/4 sub-cases) |

Unit-level reinforcement: T-U7 (`convergence.test.mjs`) pins `sameUrl`'s `undefined`-safety and symmetry directly (`sameUrl(undefined,undefined)===true`, both-direction `undefined` false, symmetric on the incident pair `"https://pruebs"`/`"https://pruebs/"`).

### Requirement: Rebuild Discards Stale Ownership Operations

| Scenario | Covering test(s) | Verified GIVEN/WHEN/THEN match | Runtime result |
|---|---|---|---|
| Rebuild discards a stuck started create operation | T-R4 (unit), T-P4 (integration through real `storage.updateState`/`getState`) | T-R4: fixture journal with one `started` create + one `done` create → `rebuildJournal` keeps only the `done` entry. T-P4: seeds the exact §8 stuck shape via `storage.updateState`, applies `rebuildJournal`, re-reads via `storage.getState()`, asserts no `started` operation survives | PASS (both) |
| Stuck workspace self-heals on Rebuild with no manual cleanup | T-R7 (pure property: `normalizeJournal(rebuildJournal(stuckJournal))` not paused/ambiguous-operation), T-P4 (asserts the round-tripped `storage.getState()` result is not paused, `pauseReason === undefined`) | T-R7 is exactly the §8.3-step-3 property expressed as a pure assertion; T-P4 exercises the same property through the actual `getState → normalizeJournal → persist` path (B1), not just the pure function | PASS (both) |

Reinforcement: T-R5 (no-op when all `done`, guards against an over-eager filter dropping `ownsRemoteCreate` suppression records) and T-R6 (`retryJournal` deliberately leaves `started` untouched — the asymmetry ADR-103's §5.2 argues for) both pass and are directly relevant regression guards named in design §9.1.

**All 6 scenarios across both requirements have real, correctly-behaving coverage** — every covering test exercises the literal GIVEN condition (via the `chrome.bookmarks.get` override injection point or direct fixture construction) and asserts the literal THEN condition, not a weaker proxy.

## 5. Named test case inventory (9 named cases, all present and passing)

T-U7, T-R4, T-R5, T-R6, T-R7 (`convergence.test.mjs`, lines 344–389) and T-P1, T-P2, T-P3 (4 parameterized sub-cases: title/parentId/index/url), T-P4 (`create-ownership.test.mjs`, lines 326–417) — all present, named exactly as design.md §9.1/§9.2 specifies, all passing in the 215/215 run.

## 6. RED-before-fix verification (by code inspection, per explicit request — not re-run against old code)

**T-P1.** Pre-fix `finishRemoteCreate` guard clause: `node.url !== ownership.url`. In T-P1, `ownership.url = "https://pruebs"` (the raw submitted value, per `startRemoteCreate` writing `ownership.url` verbatim) and the `bookmarks.get` override reports `node.url = "https://pruebs/"`. `"https://pruebs/" !== "https://pruebs"` is `true` in JS string comparison, so the disjunct is `true`, the whole `||` chain is `true`, and pre-fix code takes the early-return branch: sets `phase = "paused"`, `pauseReason = "ambiguous-operation"`, returns without setting `status = "done"`. This directly contradicts T-P1's assertions (`status === "done"`, `phase !== "paused"`, `pauseReason === undefined`). **T-P1 is logically guaranteed to have been RED pre-fix.**

**T-R7.** Pre-fix `rebuildJournal` body: `return { ...journal, phase: "replay", receipts, localIntents, repairDisposition: "rebuild", pauseReason: undefined, failedCursor: undefined };` — no `operations` key in the returned object, so the spread `...journal` (which runs first, before the explicit named keys override it) passes `operations` through completely untouched, still containing the `status: "started"` entry. `normalizeJournal` is then applied to this result: `journal.operations.some((operation) => operation.status === "started")` evaluates `true` for the retained stuck entry, so `normalizeJournal` returns `pause(journal, "ambiguous-operation")` — i.e. `phase: "paused"`, `pauseReason: "ambiguous-operation"`. This directly contradicts T-R7's assertions (`notEqual(phase, "paused")`, `notEqual(pauseReason, "ambiguous-operation")`). **T-R7 is logically guaranteed to have been RED pre-fix.**

Both reds are structural (not timing- or environment-dependent), so the claimed red-first TDD ordering in tasks.md 1.5/2.3/3.2 is credible by direct code-path analysis.

## 7. Test-injection pattern conformance

- `git diff df16196 -- extension/tests/helpers/fake-chrome.mjs` → **empty**. The fake was NOT touched, matching design's F-3 (explicitly deferred: making the fake canonicalize would break unrelated existing URL assertions across other test files).
- T-P1 and T-P3 both override `harness.chrome.bookmarks.get` locally, wrapping the original getter and only rewriting the field(s) under test for the matching created node — the exact pattern established by the pre-existing "remote create final-shape mismatch pauses..." test at lines 247–265 (`create-ownership.test.mjs:255-256` in design's citation). Confirmed identical shape: `const originalGet = harness.chrome.bookmarks.get; harness.chrome.bookmarks.get = (id, callback) => originalGet(id, (nodes) => callback(nodes.map(...)))`. No global or cross-file harness mutation.

## 8. Existing combined-mismatch test — untouched invariant guard

`git diff df16196 -- extension/tests/create-ownership.test.mjs` shows the entire diff is a pure append after the pre-existing final line (320); zero lines before that point were added, removed, or modified. The test "remote create final-shape mismatch pauses rather than completing ownership" (lines 247–265, unchanged) is therefore verified byte-identical to its pre-change form, and it passed in the independent 215/215 run. This confirms design's stated invariant: T-P3 splits the combined case per-field as new, additive coverage rather than replacing or narrowing the original combined-mismatch assertion — C2 (title/parentId/index stay exact-match) remains guarded by two independent tests, not one.

## 9. A-3 re-validation — `plan()` production call-site grep (independently re-run)

`rg -n '\bplan\b' extension/src` → 4 hits, identical set design/tasks claim:
1. `shared/types.ts:182` — `ConvergencePhase` union member `"plan"`
2. `convergence.ts:12` — `phase: "plan"` literal in `emptyJournal()`
3. `convergence.ts:62` — the `plan()` function declaration itself
4. `convergence.ts:120` — `phase: "plan"` literal in `checkpoint()`

**No call site of `plan(...)` exists outside test files.** Confirms A-3: `plan()`, and therefore all `adopt`/`reconcile`/`planned`-status operations, are unreachable in a persisted production journal, so ADR-103's exhaustiveness argument (only `create`/`delete` kinds are ever observed non-`done`) holds.

## 10. Sibling-change (fix/extension-sync-pause-recovery) boundary integrity

Diffing this branch's working tree against `df16196` (the sibling fix's tip) confirms `convergence.ts`'s only two changes are the `rebuildJournal` operations filter and the `sameUrl` export keyword. `canonicalUrlForComparison`, `sameShape`, `callbackMatches`, `shapeSignature`, `validReceipt`, `normalizeJournal`, `retryJournal`, `plan`, `createRemoteReceipt`, `reduceRemoteCallback` are all byte-identical to the sibling tip — nothing from `fix/extension-sync-pause-recovery` was altered. This matches design's explicit "Explicitly not touched" list in §7.1.

## 11. Rollback plan sanity check

`git diff df16196 --stat` touches exactly 4 files: `convergence.ts` (+2/-1 net), `projection.ts` (+2/-2 net), and two test files (pure appends, 144 lines, 0 deletions). No file under `extension/src/shared/` (where `ConvergenceOperation`/`ConvergenceJournal` types live) is touched — confirms proposal's "no persisted-schema change" claim. A single revert of these 4 files fully restores prior behavior with no migration or data-shape concern, exactly as the proposal states. (Note: `.devcontainer/devcontainer.json` also shows as modified in git status, but that change predates this session and is unrelated to this SDD change's scope — not part of this diff, not flagged as an issue.)

## Issues

**CRITICAL**: None.

**WARNING**: None.

**SUGGESTION**:
- F-1 (`ownsRemoteCreate`'s identical-class URL defect at `projection.ts:1832`, and its consuming-suppression interaction risk under concurrent sibling creates) is correctly deferred as documented follow-up — not a blocker for this change, but worth tracking as a fast-follow given it shares the same root cause class.
- `.devcontainer/devcontainer.json` shows as modified in the working tree outside this change's stated scope; harmless to this verification but worth a separate commit/rebase hygiene check before merge so the PR diff stays exactly the 4 files this change owns.

## Final Verdict: **PASS**

All 6 spec scenarios across both requirements have real, correctly-behaving test coverage exercising the literal GIVEN/WHEN/THEN. All 9 named test cases present and passing. Production diff is byte-identical to design's ADRs. Tasks 16/16 genuinely complete. Sibling-branch boundary intact. Rollback claim verified against the actual diff. No CRITICAL or WARNING issues found.
