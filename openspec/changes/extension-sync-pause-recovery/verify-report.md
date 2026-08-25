# Verify Report: extension-sync-pause-recovery

Branch `fix/extension-sync-pause-recovery`. Verified against proposal.md, specs/extension-sync-convergence/spec.md, design.md, tasks.md, and the actual diff in `extension/src/background/{convergence.ts,projection.ts}` and `extension/tests/{convergence.test.mjs,projection-behavior.test.mjs}`.

## Verdict: PASS for automatable scope. 0 CRITICAL, 0 WARNING, 2 SUGGESTION.

Independently re-ran `cd extension && npm run test:projection` → **203/203 pass**, and `npm run typecheck` → **clean**. Re-derived the diff myself (`git diff --stat`: convergence.ts +41/-, projection.ts +21/-13, convergence.test.mjs +181/-4, projection-behavior.test.mjs +7/-4) and it matches design.md's change inventory (§7.2, 7 items) exactly.

---

## 1. Spec-scenario → test mapping (all 9 scenarios covered)

**Requirement: Suppressed Local Capture for Remote-Initiated Writes** (spec.md:5-30)

| Scenario | Enforced by | Test evidence |
|---|---|---|
| Successful update suppressed like create | ADR-004 (`projection.ts:1481-1491` `withSuppression`) | Pre-existing integration test `"remote bookmark update side effects are not re-emitted as local changes"` (projection-behavior.test.mjs:1486, unchanged) — asserts `bookmarkPatchCalls === 0` after a matching remote update round-trips through Chrome's real callback path |
| Own write never misattributed on mismatch | ADR-003 (`convergence.ts:29-33` `"rejected"` disposition) | T-I1 (unit, `localIntents.length === 0` + `cursor === receipt.cursor`) **and** integration test `"remote update pauses at a hidden-field verification failure"` (projection-behavior.test.mjs:1546, unchanged) — asserts pause at `failedCursor: 8`, `lastCursor` stays 7, no phantom write |
| Genuine local edit still captured | ADR-003 (`"intent"` branch unchanged) | T-I2, T-I3 |
| Rebuild discards stale local intents | ADR-005 (`convergence.ts:112-114` `rebuildJournal` filter) | T-R1, T-R2 (unit) **and** integration test `"Retry keeps an unproven receipt paused and Rebuild is the only destructive workspace action, dropping stale queued local intents"` (projection-behavior.test.mjs:1055, modified from `length,1` → `length,0`) |

**Requirement: Complete Callback Proof (MODIFIED)** (spec.md:34-74)

| Scenario | Enforced by | Test evidence |
|---|---|---|
| Hidden URL differs | `sameShape`/`sameUrl` (ADR-001/002) | T-I1; also the renamed pre-existing unit test `"...rejects hidden-field mismatches without queuing a phantom intent"` (convergence.test.mjs:89) |
| Adversarial Chrome-like ID | `exactIdentity` (unchanged, `type` included) | Pre-existing test at convergence.test.mjs:220 (T-I3 also covers the `type`-only mismatch case newly routed through disposition) |
| Bare-origin URL converges without pause | `canonicalUrlForComparison` + `sameUrl` (ADR-001/002) | T-C1 (unit, the named regression case) — no integration-level bare-origin test exists (see §3 below) |
| Genuine URL mismatch still queues | `sameUrl` raw fallback / non-normalization difference | T-C4 |
| Title normalization not applied | `sameShape`'s strict `actual.title === expected.title` | T-C3 |
| Normalization never touches stored/sent values | ADR-001 structural guarantee (comparison-only helper, zero value-producing call sites) | Not independently unit-tested (by design — it's a structural property, not a runtime one), but verified directly against the diff: `persistRemoteReceipt` call at `projection.ts:1480` and `updateNode` call at `projection.ts:1483` (inside the new `withSuppression` wrapper) both still pass `bookmark.url` raw — confirmed by reading the diff hunk, `canonicalUrlForComparison` is called from exactly one place (`sameUrl`, `convergence.ts:139`), verified by `rg -n "canonicalUrlForComparison" extension/src` |
| Stuck workspace self-heals on Rebuild | ADR-003 + ADR-005 combined (P1-P4, design §8) | T-R1/R2 (unit) + the modified integration test above, which is the closest thing to an end-to-end self-heal proof this harness supports |

All 21 named test IDs (T-U1–U6, T-C1–C8, T-I1–I3, T-R1–R3, T-B1) are present in `convergence.test.mjs` — confirmed by direct read of the diff, not by trusting the count in tasks.md. Every scenario in spec.md has at least one directly-attributable test; three of the higher-risk ones (suppressed-write success, own-write-never-misattributed, rebuild-discards-intents) have *both* a pure-unit test and an unchanged pre-existing integration test exercising the real Chrome-callback/WebSocket path, which is stronger coverage than design.md's own harness-reality-check anticipated.

## 2. Call-site audit for `reduceRemoteCallback`'s widened return type

`rg -n "reduceRemoteCallback" extension/ -g '!node_modules'` returns exactly:
- `convergence.ts:29` — the definition
- `projection.ts:76` — the import
- `projection.ts:1516` — the **only** production call site (inside `consumeRemoteCallback`)
- 20 call sites in `convergence.test.mjs` (test code, not production)

Confirmed: **no other caller exists.** The `projection.ts:1516` call site was updated in the same diff to route on `result.disposition === "rejected"` explicitly (replacing the old `before.some(...)` re-derivation that omitted `type` from the identity check — design.md's ADR-003 notes this as "a deliberate, very slight tightening"). No silent old-two-value-type assumption survives anywhere in the tree. Design.md's claim ("Only caller ... verified by grep") is accurate and independently reproduced here.

## 3. Integration-harness-infeasibility claim — accurate, but incompletely exploited

Confirmed by reading `projection-behavior.test.mjs`: a `globalThis.chrome = { bookmarks: {...}, runtime: {...} }` mock (lines 77-135) and a `MockWebSocket` class (line 168) are already wired, and `handleBookmarkChanged`/`projectionTestHooks.applyRemoteEnvelope` are imported and exercised extensively (60+ call sites) throughout the file. Design §9's "integration level — deliberately not attempted" rationale is **factually wrong for this tree** (it was written against a stale "extension/ has zero test files" premise that tasks.md Phase 1 already flags as stale). The apply agent's claim is accurate, not overstated: this harness genuinely drives `applyRemoteBookmarkUpsert` end-to-end, including the exact ADR-003/ADR-004 code path (`"remote bookmark update side effects are not re-emitted as local changes"` and `"remote update pauses at a hidden-field verification failure"`, both pre-existing and passing unchanged).

**Real residual gap, not closed by the apply agent's reuse:** neither of those two reused tests, nor any other integration test in the file, exercises the **bare-origin URL** case specifically — every URL literal in the existing "update" integration tests (`https://example.com/after`, `.../hidden`, `.../final`) has a path component, so Chrome's mock node never needs the trailing-slash normalization this whole change exists to fix. The two reused tests validate ADR-003 (rejected-not-intent) and ADR-004 (suppression) end-to-end correctly, but T-C1 (the actual bare-origin regression, spec's headline scenario "Bare-origin URL converges without pause") is **only unit-tested**, never integration-tested. This is a real, narrow gap — not a blocker (T-C1 exercises the exact production defect at the level where the fix lives, `sameUrl`/`canonicalUrlForComparison`, and the design's own P1-P4 proof plus the reused pause/suppression integration tests jointly cover everything else in the path), but it means "the confirmed incident, end-to-end through the mock Chrome API" is not literally proven, only "the confirmed incident, at the comparison function" plus "the surrounding plumbing, with non-bare-origin URLs." Flagged as **SUGGESTION**, not CRITICAL/WARNING: closing it would mean adding one bare-origin variant of the existing "remote bookmark update" integration test class — cheap, but out of the original scope contract and not required for correctness given T-C1's unit-level precision.

## 4. Task 7.1 (manual verification)

Correctly left unchecked, correctly scoped as human/browser-only (`tasks.md:53-54`). This does **not** block a PASS verdict for the automatable scope — 16/17 tasks complete is the expected, correct state per the apply-progress artifact, and the one open item is explicitly gated on tooling this pipeline does not have (browser + unpacked extension load).

**Explicit for the record:** shipping this fix does **not** automatically recover the real stuck "Jira" workspace. Design §8 (P1-P4) proves the mechanism self-heals *on Rebuild*, but recovery requires, in order: (1) this fix merged and released, (2) task 7.1's manual browser verification performed at least once against a real Chrome instance to validate the mock-harness assumptions against actual GURL/WHATWG behavior (T-U1-U4 were cross-checked against Node's `URL` implementation in this verification pass and match design's claimed outputs exactly, but Node's `URL` and Chrome's GURL are not guaranteed byte-identical for every edge case — this is design's own explicitly-flagged Med-severity assumption, §11 row 1), and (3) an actual operator/support **Rebuild click** on the live stuck workspace after release — there is no automatic retry (proposal.md:43, "Operational Note"). None of this is a gap in the change; it is accurately and explicitly documented in proposal.md and tasks.md already, and this report reiterates it so a PASS verdict here is not misread as "production is already fixed."

## 5. Rollback-plan claim (proposal.md:53-55) vs. actual diff

Claim: "No schema, persisted-format, or backend change; journals and receipts remain readable by the prior build."

Verified:
- `git diff --stat backend/ admin-web/` → **empty**. No backend or admin-web changes anywhere in the working tree.
- `RemoteReceipt`, `ConvergenceJournal`, `ReceiptNodeShape` type definitions: zero diff hunks touch them (confirmed via full `git diff` read of `convergence.ts`) — only function *bodies* changed (`reduceRemoteCallback`, `rebuildJournal`, plus three new private/exported functions).
- `shapeSignature` (the actual persisted-signature producer) and `validReceipt` (the reader/gate on stored signatures): **byte-identical**, zero diff. This is what makes the rollback claim true — nothing about what gets written to storage changed, only in-memory comparison and one filter in `rebuildJournal`.
- `rebuildJournal`'s new `localIntents` filter is a pure in-memory transform applied at rebuild time, not a change to what's persisted at rest; a reverted build reading an already-rebuilt journal (with intents already dropped) sees a strict subset of what it would have seen pre-fix, which is forward-compatible with the old reader.

Claim holds. No discrepancy found.

## 6. Independent spot-checks beyond the orchestrator's summary

- Re-verified all of ADR-002's canonicalization claims against Node's actual `new URL()` output (not just trusted from design.md prose): trailing-slash, default-port-stripping, case-lowering, and percent-encoding-preservation (`%2Fb` vs `/b` stay distinct) all reproduce exactly as design.md §3 claims.
- Confirmed `validReceipt(receipt) &&` remains the first conjunct in `callbackMatches` (ADR-001's stated invariant) — present in the diff, unchanged position.
- Confirmed `canPersistReceipt`/`captureLocalIntent`/`createRemoteReceipt`/`emptyJournal`/`gateRemoteEffect`/`normalizedReceipts`/`retryJournal` — the full list of "not touched" functions design.md §7.2 names — have no diff hunks against them in `convergence.ts`.
- Confirmed the 4 modified/renamed pre-existing tests (2 in convergence.test.mjs, 2 in projection-behavior.test.mjs — tasks.md undercounts this slightly by describing it as "3 pre-existing" in Phase 3 plus "a 4th" in Phase 5, which totals 4 and matches; no discrepancy, just noting the phrasing across two checklist entries could read as ambiguous on first pass) are all genuine correctness updates to the new spec'd disposition semantics, not weakenings: every one still asserts a failure path fails (pending/paused), only the specific label and phantom-intent count changed to match ADR-003/005's intent.

## Tasks.md checklist state vs. actual code state

16/17 checked, 1 explicitly and correctly open (7.1, manual). No checked task claims something the diff doesn't support; no unchecked task hides completed work. Deviation notes in Phase 1, 3, 4, 5 are all independently verifiable against the diff and were checked directly rather than taken on faith.

## Files reviewed

- `openspec/changes/extension-sync-pause-recovery/proposal.md`
- `openspec/changes/extension-sync-pause-recovery/specs/extension-sync-convergence/spec.md`
- `openspec/changes/extension-sync-pause-recovery/design.md`
- `openspec/changes/extension-sync-pause-recovery/tasks.md`
- `extension/src/background/convergence.ts` (diff)
- `extension/src/background/projection.ts` (diff)
- `extension/tests/convergence.test.mjs` (diff, full new-test-block read)
- `extension/tests/projection-behavior.test.mjs` (diff + surrounding harness read, lines 1-240, 1483-1600)
