# Tasks: Normalization-Aware Remote-Create Ownership Verification

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~150-220 (≈6 production, rest test code appended to 2 existing files) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

Design's ~6-line production estimate confirmed (1 export keyword, 1 import-list entry, 1 predicate clause, 1 filter line). Test additions (9 named cases across 2 files, reusing existing helpers/harness) stay well under budget even generously estimated. `ask-on-risk` triggers a decision only when risk is elevated; Low risk needs none — proceed as a single PR. `stacked-to-main` reflects this branch's existing base on `fix/extension-sync-pause-recovery`, not internal splitting.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | ADR-101/102/103 + full test plan | PR 1 (only PR) | `cd extension && npm run test:projection` | Real `chrome`/`fetch` fakes via `create-ownership.test.mjs` (`applyRemoteEnvelope`) — no N/A needed | Single revert of the change branch; no persisted-schema change (proposal.md Rollback Plan) |

## Phase 1: RED — test-first coverage (spec: Complete Create Ownership Proof, Rebuild Discards Stale Ownership Operations)

- [x] 1.1 `convergence.test.mjs` append after :340 — T-U7: `sameUrl` exported, `undefined`-safe both directions, symmetric on the incident pair
- [x] 1.2 `convergence.test.mjs` append — T-R4 (stuck-`started` fixture keeps only `done`), T-R5 (all-`done` passes through unchanged, `deepEqual`), T-R6 (`retryJournal` leaves `started` untouched)
- [x] 1.3 `convergence.test.mjs` append — T-R7: `normalizeJournal(rebuildJournal(stuckJournal))` is not paused/`ambiguous-operation`
- [x] 1.4 `create-ownership.test.mjs` append after :322 — T-P1 (bare-origin create, `chrome.bookmarks.get` override per F-3, not global fake-chrome edit), T-P2 (folder `url: undefined` + byte-identical fast path), T-P3 (title/parentId/index/genuine-url-mismatch each still pause), T-P4 (rebuild round-trip through real `storage.updateState`/`getState`)
- [x] 1.5 Run `cd extension && npm run test:projection` on the unmodified tree; confirm T-R7 and T-P1 fail RED before any production edit (design §9 mandate)

## Phase 2: GREEN — ADR-102, export `sameUrl`

- [x] 2.1 `convergence.ts:134` — `function sameUrl` → `export function sameUrl` (body unchanged)
- [x] 2.2 `projection.ts:76` — add `sameUrl` to the `./convergence.js` import list, alphabetically after `retryJournal`
- [x] 2.3 Run test:projection; confirm T-U7 passes; T-P1/T-R7 still red (expected)

## Phase 3: GREEN — ADR-101, normalization-aware url clause

- [x] 3.1 `projection.ts:1768` — replace `node.url !== ownership.url` with `!sameUrl(node.url, ownership.url)`; `!node ||` stays first disjunct; `parentId`/`index`/`title` clauses byte-identical
- [x] 3.2 Run test:projection; confirm T-P1, T-P2, T-P3 pass; T-R4-R7/T-P4 still red until Phase 4

## Phase 4: GREEN — ADR-103, rebuildJournal drops non-`done` operations

- [x] 4.1 Re-run `grep -rn '\bplan\b' extension/src` to revalidate A-3 (no `plan()` production call site); stop and re-examine `adopt`/`reconcile`/`planned` handling if one appears — reconfirmed: 4 hits, none a call site (`"plan"` phase literal, `plan()` declaration, `"plan"` phase assignment in `checkpoint`, `ConvergencePhase` union)
- [x] 4.2 `convergence.ts:111-115` — add `const operations = (journal.operations ?? []).filter((operation) => operation.status === "done");`, return `operations` in the spread, mirroring the `receipts`/`localIntents` filters
- [x] 4.3 Run test:projection; confirm T-R4-R7 and T-P4 pass; existing T-R1/T-R2 and `create-ownership.test.mjs:247-265` combined-mismatch case stay green

## Phase 5: Completion gate

- [x] 5.1 Run `cd extension && npm run test:projection` full suite — 21 pre-existing files + 9 new cases green (215/215)
- [x] 5.2 Run `cd extension && npm run typecheck` — green (no output, exit clean)
- [x] 5.3 Confirm no separate documentation task is needed: comparison-only bugfix, no schema/API/backend-contract change (design §12); `create-ownership.test.mjs`'s chrome-fake + `applyRemoteEnvelope` integration coverage already supersedes manual verification (design §9 corrects the sibling design's infeasibility claim)
