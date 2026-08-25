```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:f7c5dc0852dddee4d11d62d8ce145611508491e75d8d8ca18caae4871a52e54f
verdict: pass_with_warnings
blockers: 0
critical_findings: 0
requirements: 1/1
scenarios: 6/7 (1 explicitly deferred, non-blocking — see WARNING W1)
test_command: cd extension && npm run test:projection
test_exit_code: 0
test_output_hash: sha256:883fe98696c53429315a98bfcf61524d41d9e7e37f4be52256148294fa1a35b2
build_command: cd extension && npm run typecheck
build_exit_code: 0
build_output_hash: sha256:b14f42d291e87e50ff764879ffd4acc01bc54f910faa8456e8a7832dde9776db
```

## Verification Report

**Change**: extension-move-index-verification
**Version**: spec delta `extension-sync-convergence` (1 ADDED Requirement, 7 scenarios)
**Mode**: Strict TDD

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 24 (7.1–7.4 counted individually) |
| Tasks complete | 23 |
| Tasks incomplete | 1 (7.3 — post-merge manual Rebuild on the real production workspace; explicitly deferred by design §11 A-1 and out of scope for automated verification) |

### Build & Tests Execution
**Build (typecheck)**: ✅ Passed
```text
cd extension && npm run typecheck
> tsc -p tsconfig.json --noEmit
(no output, exit 0)
```

**Tests**: ✅ 224 passed / ❌ 0 failed / ⚠️ 0 skipped
```text
cd extension && npm run test:projection
1..224
# tests 224
# pass 224
# fail 0
# duration_ms 2371.140707
```
Independently re-run in this session (not merely trusted from the apply report). Matches the orchestrator's independently reported 224/224 and the apply-progress's own final count (Phase 6.7).

**Coverage**: ➖ Not available (no coverage tool detected for `extension/`; informational only per skill rules — not a blocker).

### Spec Compliance Matrix
| Requirement | Scenario | Test | Result |
|---|---|---|---|
| Chrome-Correct Destination Index for Same-Parent Forward Moves | Forward-by-one same-parent folder move converges (production incident) | `projection-behavior.test.mjs > T-M2` | ✅ COMPLIANT |
| " | Forward-by-many same-parent move lands at the exact requested index | `chrome-move-index.test.mjs > T-M1` (table cases), `chrome-harness.test.mjs > T-F2`, `projection-behavior.test.mjs > T-M3` | ✅ COMPLIANT |
| " | Backward same-parent move is unchanged | `chrome-move-index.test.mjs > T-M1`, `chrome-harness.test.mjs > T-F3`, `projection-behavior.test.mjs > T-M4` | ✅ COMPLIANT |
| " | Cross-parent move is unchanged | `chrome-move-index.test.mjs > T-M1`, `chrome-harness.test.mjs > T-F3`, `projection-behavior.test.mjs > T-M5` | ✅ COMPLIANT |
| " | Bookmark moves get the same correction as folder moves | `projection-behavior.test.mjs > T-M3/T-M4/T-M5` (bookmark-typed) | ✅ COMPLIANT |
| " | Receipt verification machinery is untouched by the correction | `projection-behavior.test.mjs > T-M2/T-M3/T-M4/T-M5` (assert `receipt.move` carries the logical index, never the Chrome-adjusted one) + static: `convergence.ts` diff is empty | ✅ COMPLIANT |
| " | Stuck workspace self-heals on Rebuild | none (deliberately not attempted — design §9.3 "Deliberately not attempted" / F-5; task 7.3 left unchecked, requires live production access) | ⚠️ PARTIAL — explicitly deferred, not a blocker (see W1) |

**Compliance summary**: 6/7 scenarios compliant with a passing runtime test; 1/7 explicitly and validly deferred to a post-merge manual step, per design §11 A-1 and the orchestrator's explicit scope instruction.

### Test → Scenario → Design Traceability (T-M1…T-F3)
| Test | File | Design ref | Scenario(s) covered | Assessment |
|---|---|---|---|---|
| T-M1 | `chrome-move-index.test.mjs` | §9.1 | Forward-by-one/many, backward, cross-parent, unreachable `index===oldIndex` guard-shape, purity/no-mutation (C1 unit guard) | 7-case table, real value assertions + `deepEqual` no-mutation check + integer totality check. Not trivial. |
| T-F1 | `chrome-harness.test.mjs` | §9.2 | The quirk itself: same-parent `oldIndex+1` is a silent no-op, zero `onMoved` delivered | Asserts unchanged child order AND zero delivered events after `settle()`. Real behavioral assertion, not a smoke test. |
| T-F2 | `chrome-harness.test.mjs` | §9.2 | Forward-by-many, pre-removal decrement | Asserts landed index 2 (not literal 3) and the exact `onMoved` payload `{oldIndex:0,index:2}` — proves pre-removal coordinate modeling, not a special-cased `+1` hack. |
| T-F3 | `chrome-harness.test.mjs` | §9.2 | Backward, cross-parent, index-less append, out-of-bounds | Four sub-cases, each a distinct real scenario with its own assertions (not a loop over a queryable/possibly-empty collection — each block is independently executed). |
| T-M2 | `projection-behavior.test.mjs` | §9.3 | Production incident (folder, forward-by-one) | Asserts (in order) landed index, receipt's *logical* `move` record (1, never Chrome-bound 2), consumption via `handleBookmarkMoved`, `lastCursor` advance, `pauseReason` stays undefined. Strong, ordered, multi-property assertion — the strongest test in the set. |
| T-M3 | `projection-behavior.test.mjs` | §9.3 | Forward-by-many, bookmark | Same shape as T-M2, bookmark-typed, guards against a fix that special-cases only `oldIndex+1`. |
| T-M4 | `projection-behavior.test.mjs` | §9.3 | Backward same-parent unchanged, bookmark | Asserts unmodified index + receipt logical value + consumption. |
| T-M5 | `projection-behavior.test.mjs` | §9.3 | Cross-parent unchanged, bookmark | Asserts parentId + index + receipt + consumption. |
| T-M6 | `projection-behavior.test.mjs` | §9.3 | ADR-203 read-back gate (C8 insurance) | Installs a legacy `chrome.bookmarks.move` override (bypasses the corrected double entirely, applies no decrement), restored in `finally`. Asserts `pauseReason==="final-verification-failed"`, `failedCursor===19`, and the diagnostic string contains both `requestedChromeIndex=2` and `observedIndex=2`. Real, non-trivial, exercises the actual gate. |

All nine named tests read and confirmed as real, correctly-behaving coverage — no tautologies, no ghost loops over possibly-empty collections, no assertion-free tests, no ratio problems (this suite uses in-file test doubles, not mock-call-count assertions).

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|---|---|---|
| ADR-201 `chromeMoveIndex` | ✅ Implemented | `chrome-bookmarks.ts:90`, exact formula `move.parentId === move.oldParentId && move.index > move.oldIndex ? move.index + 1 : move.index`, matches design verbatim. |
| ADR-202 hoisted `const move`, single-sourced | ✅ Implemented | Both branches (folder `:1364-1373`, bookmark `:1474-1483`) hoist `const move`, pass it unmodified to `persistRemoteReceipt`, pass `chromeMoveIndex(move)` only to `moveNode`. |
| ADR-203 read-back gate | ✅ Implemented | Both branches capture `moved`, throw `RemoteApplyError(..., "final-verification-failed")` with `requestedChromeIndex`/`observedIndex` diagnostic on mismatch. |
| ADR-204 Chromium-faithful doubles | ✅ Implemented | `fake-chrome.mjs:41` and `projection-behavior.test.mjs:149-172` both rewritten with pre-removal index, same-parent no-op, decrement, splice, renumber, bounds check — verified against design's replacement code line-by-line, not merely trusted. |
| C1 invariant (`chromeMoveIndex` never reaches `persistRemoteReceipt`/`sameMove`/`callbackMatches`) | ✅ Confirmed | Independent grep: exactly 4 call-site occurrences in `projection.ts` — 2 inside `moveNode(...)` destination literals, 2 inside the ADR-203 `requestedChromeIndex` diagnostic field. Zero occurrences as an argument to `persistRemoteReceipt` (both calls pass `move` unmodified, confirmed at lines 1368 and 1478). Zero occurrences in `convergence.ts` (diff is empty). |
| `convergence.ts` untouched | ✅ Confirmed | `git diff -- extension/src/background/convergence.ts` is empty. |
| `shared/types.ts` untouched | ✅ Confirmed | `git diff -- extension/src/shared/types.ts` is empty — corroborates the rollback claim ("single revert, no persisted-schema change"). |
| Diff size vs. proposal claim | ✅ Confirmed | `git diff --stat` on the 5 tracked files: 294 insertions(+), 6 deletions(-) — exact match to the orchestrator's independently reported figure. (`chrome-move-index.test.mjs` is a new untracked file and is not counted in this stat; its content was read and verified separately.) |

### Coherence (Design)
| Decision | Followed? | Notes |
|---|---|---|
| ADR-201 (helper location, signature) | ✅ Yes | Placed in `chrome-bookmarks.ts` above `moveNode`, structural-record signature (not `(bool, number, number)`), matches rejected-alternatives reasoning. |
| ADR-202 (single-sourcing) | ✅ Yes | See Correctness table. |
| ADR-203 (read-back gate) | ✅ Yes | Mirrors the existing `:1494-1500` update-path precedent exactly, as claimed. |
| ADR-204 (double fidelity) | ✅ Yes | Both doubles rewritten with the same five rules in the same order, as designed. |
| C3 / §7.1 / §8.2 ("no `convergence.ts` edit needed, unlike both siblings") | ✅ Yes | Confirmed by empty diff. |
| §9 two-step TDD ordering (Step 0 → red T-M1/T-M2 → green ADR-201/202 → red T-M6 → green ADR-203 → regressions) | ✅ Corroborated (see TDD Compliance section — no commit history exists to replay literally; corroboration is via self-consistent test-count arithmetic and code-inspection reasoning) | See below. |

### TDD Compliance
| Check | Result | Details |
|---|---|---|
| TDD Evidence reported | ✅ | Found inline in `tasks.md` (Phases 1–7), not in a separate `apply-progress` artifact — no such file exists in `openspec/changes/extension-move-index-verification/`. Treated `tasks.md`'s per-task confirmation notes as the evidence trail; this is a graceful-degradation note, not a CRITICAL, since the actual evidence content is present and verifiable. |
| All tasks have tests | ✅ | 9/9 named tests (T-M1–T-M6, T-F1–T-F3) exist and were read in full. |
| RED confirmed (tests exist) | ✅ | All 9 test files/blocks exist on disk and were read verbatim. |
| GREEN confirmed (tests pass) | ✅ | Independently re-run in this session: 224/224 pass, exit 0 — cross-referenced against the reported final state (Phase 6.7: "224/224 pass, typecheck clean"). |
| Triangulation adequate | ✅ | T-M1 alone covers 7 distinct input classes with `deepEqual`-checked non-mutation; the 6 mapped-but-not-A-1 scenarios each have 2–3 independent covering tests across pure-unit, double-fidelity, and integration layers. |
| Safety Net for modified files | ✅ | Task 1.3: existing suite confirmed green (215/215) *before* any new test was written and *before* any production change — this is the exact C5 gate the design mandates. |

**Two-step TDD ordering — reasoning-based corroboration (no git history available):**

This branch has **zero commits for this change** — `git log`/`git reflog` show only the prior two sibling fixes committed; every file in this change is an uncommitted working-tree diff. Git history therefore offers **no direct replay evidence** for the RED→GREEN sequencing; the claim cannot be verified by inspecting commit boundaries, only by two indirect methods, both of which corroborate it:

1. **Self-consistent test-count arithmetic**, taken directly from `tasks.md`'s own confirmation notes and cross-checked against the file system:
   - Step 0 (doubles corrected, no new test, no prod change): 215/215 green — 20 pre-existing test files on disk match (`ls extension/tests/*.test.mjs` minus `chrome-move-index.test.mjs` = 20).
   - Step 1 (T-M1 + T-M2 added): 215/217 pass — exactly +2 tests, exactly 2 reported as red.
   - Step 2 (ADR-201/202 land): 217/217 green.
   - Step 3 (T-M6 added): 217/218 pass — exactly +1 test, exactly 1 reported as red.
   - Step 4 (ADR-203 lands): 218/218 green.
   - Step 5 (T-F1–3, T-M3–5 added): 224/224 green — exactly +6 tests (matches this session's independently-run 224/224).
   Every delta is arithmetically exact; a fabricated or reordered narrative would be very unlikely to produce six internally consistent counts in a row.
2. **Code-inspection reasoning** — could T-M1/T-M2 have logically been red against pre-fix code, and T-M6 red before the gate existed?
   - **T-M1**: imports `chromeMoveIndex` from `../dist/background/chrome-bookmarks.js`. Pre-ADR-201, that export does not exist — the import itself fails module resolution, which `node:test` reports as a failing test. Logically red.
   - **T-M2**: under the Step-0-corrected `fake`/inline double, a same-parent request for `index: oldIndex+1` (the literal, pre-ADR-201 argument) is a no-op by the corrected double's own new no-op branch — the node stays at index 0, and the assertion `bookmarkNodes.get("intro-node")?.index === 1` fails. Logically red, and *only* because Step 0 already landed (this is why Step 0 must precede Step 1 — pre-Step-0, the old lenient double would have made this same call incorrectly succeed, which is the entire premise of C5/ADR-204).
   - **T-M6**: installs a "legacy" `chrome.bookmarks.move` override that applies the ADR-201-compensated index (2) *literally*, landing the node at index 2 instead of the receipt's logical 1. Pre-ADR-203, nothing compares `moved.index` to `move.index`; the function returns `true` unconditionally and no exception is thrown, so `pauseReason` remains `undefined`, not `"final-verification-failed"`, and the test's assertion fails. Logically red.
   Both mechanisms hold up under independent reasoning, not just by trusting the report.

### Deviations Assessment (task brief vs. actual apply)

**(a) Added `test.after()` cleanup hook in `projection-behavior.test.mjs`.** Read at `:462-469`. It calls `projectionTestHooks.resetRuntimeState()` — the **exact same function** already called in the file's existing `test.beforeEach` (`:458-460`, delegating to `resetRuntime()` at `:414-424`). The only behavioral difference is that it also runs once *after* the last test, closing a workspace socket/keepalive timer that would otherwise have no subsequent `beforeEach` to close it (a pre-existing test-harness gap exposed only because a new test now lands at the end of the file). This is a **legitimate, minimal, well-justified test-infrastructure fix** — it introduces no new mechanism, reuses an already-audited cleanup path, and does not touch production code or test semantics. **Not a design deviation; no rework needed.**

**(b) `chromeMoveIndex` grep invariant's second occurrence.** Confirmed independently (see Correctness table): the ADR-203 diagnostic field `requestedChromeIndex: chromeMoveIndex(move)` is a second, legitimate occurrence, present in design.md's own ADR-203 code snippet (§5, verbatim) — it is not something the apply phase invented. The task brief's simplified wording ("appears only inside the `moveNode` destination literal") undercounted this from the start; the actual C1 invariant that matters — **never reaches `persistRemoteReceipt`, `sameMove`, or `callbackMatches`** — holds precisely. **Not a design deviation; the task brief's wording was the imprecise artifact, not the code.**

One **minor documentation nit** found: task 7.1's own note says "**3** call-site occurrences found (2x inside `moveNode(...)`, 2x inside the ADR-203 diagnostic...)" — 2+2=4, not 3. My independent grep confirms **4** total call-site occurrences (excluding the import line). The undercount is arithmetic-only in the task note text; the underlying enumeration (2 + 2) and the invariant itself are both correct. Flagged as WARNING W2 below — cosmetic, does not affect the actual C1 guarantee.

### Issues Found

**CRITICAL**: None.

**WARNING**:
- **W1** — Spec scenario "Stuck workspace self-heals on Rebuild" has no automated covering test (design §9.3 "Deliberately not attempted", tracked as follow-up F-5; task 7.3 explicitly left unchecked, requiring live production access to the real SINGULARBANK workspace at cursor 19). This is also design §11's A-1 risk: whether this fix alone recovers the actual reported production incident, or whether follow-up F-2 (materialization drift) is additionally required, is undecidable from static analysis or the test suite — the design says so explicitly, and the underlying mechanism (T-M2, ADR-201/202/203) is otherwise fully proven. **Per explicit instruction, this is not resolved here and is not treated as a blocker; it is an accepted, explicitly-flagged open item for post-merge production verification.**
- **W2** — `tasks.md` task 7.1's self-reported call-site count ("3 call-site occurrences") is arithmetically inconsistent with its own enumeration ("2x... 2x...") = 4. Independently confirmed the correct count is 4. Cosmetic; the invariant it describes is correctly verified.
- **W3** — No dedicated `apply-progress` artifact exists as a separate file in `openspec/changes/extension-move-index-verification/`; TDD/apply evidence lives inline in `tasks.md`'s per-phase notes instead. Sufficient to verify against in this case (evidence content is complete and self-consistent), but is a process gap relative to the usual two-artifact (`tasks.md` + `apply-progress`) convention.
- **W4** — No commit history exists for this change (all changes are an uncommitted working-tree diff on `fix/extension-move-index-verification`), so the mandatory two-step TDD ordering could not be verified by literal commit-boundary replay — only by the arithmetic and code-inspection reasoning documented above, both of which corroborate the claimed ordering without contradiction.

**SUGGESTION**:
- Consider committing the change in phase-aligned commits (mirroring §9's 5-step table) before merge, both to make TDD ordering independently auditable in the future and because `tasks.md`'s own suggested work-unit split (PR1–PR4) implies commit-level checkpoints were intended.
- Coverage tooling is not available for `extension/`; not a blocker, but would strengthen future verify passes for this module.

### Verdict
**PASS WITH WARNINGS**
Production code, both test doubles, and all nine named tests (T-M1–T-M6, T-F1–T-F3) match design.md's ADR-201/202/203/204 exactly; the C1 invariant, `convergence.ts`/`shared/types.ts` non-interference, and the diff-size claim are all independently confirmed; 224/224 tests and typecheck pass in a fresh run. The only open items are explicitly pre-flagged, non-code, non-blocking: the production self-heal proof (W1/A-1, deferred to post-merge manual verification by design itself) and two minor documentation nits (W2, W3) plus the inherent limit of verifying TDD ordering without commit history (W4).
