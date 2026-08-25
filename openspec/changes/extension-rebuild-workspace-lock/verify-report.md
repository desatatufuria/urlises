# Verify Report: extension-rebuild-workspace-lock

**Change**: extension-rebuild-workspace-lock
**Branch**: fix/extension-rebuild-workspace-lock (off develop, both currently at 279b0fa)
**Mode**: Full artifact verification (proposal + spec + design + tasks), all tasks checked complete
**Verdict**: PASS WITH WARNINGS

## 1. Build/Test Evidence (independently re-executed, not trusted from tasks.md)

- `cd extension && npm run test:projection` (build + `node --test tests/*.test.mjs`, all 21 files, 228 subtests): **228/228 pass**, 0 fail, exit 0.
- `npm run typecheck`: clean, exit 0.
- Production diff vs `develop` is confined to exactly 3 files (`chrome-bookmarks.ts` +13/-4, `projection.ts` +17/-1, `projection-behavior.test.mjs` +192/-16... wait see exact numbers below); `git diff develop --stat -- extension/` shows no other extension file touched. `extension/src/shared/types.ts` has zero diff (rollback/no-schema-change claim confirmed).
- Production code is byte-for-byte identical to design.md's quoted ADR-301/302/303/304 snippets (confirmed via direct diff comparison, not just reading).

### Empirical RED/GREEN cross-validation (executed myself, three isolation runs against the real suite, not just tasks.md's log)

| Production state | Result |
|---|---|
| Full revert (neither `rebuildLocks` nor `managedPathQueue`) | 224 pass / **4 fail**: exactly T-R1, T-R2, T-R3, T-R4 — all four new tests, each with a substantive `AssertionError` (duplicate folder counts 2 vs 1, missing warn diagnostic, orphaned bookmark id 105 vs 107) |
| `managedPathQueue` only (chrome-bookmarks.ts fixed, projection.ts reverted) | 227 pass / 1 fail (T-R4 only, expected — needs ADR-304) |
| `rebuildLocks` only (projection.ts fixed, chrome-bookmarks.ts reverted) | 227 pass / 1 fail (**T-R3 only**) |
| Both fixes (current tree) | 228/228 pass |

All four isolation runs are deterministic (re-ran the full-revert case 3× with identical results). This directly proves genuine bug detection, not tautology, and confirms design's specific claim that T-R3 is "the test the per-workspace lock alone cannot make green."

## 2. Correction to the orchestrator's briefing

The orchestrator's framing — "5 tests now in projection-behavior.test.mjs (T-R1, T-R2 as redesigned, T-R3, T-R4, plus the added 5th test)" — is **factually inaccurate** and I want to flag this explicitly rather than pass it through. `git diff develop -- extension/tests/projection-behavior.test.mjs | rg '^\+test\('` shows exactly **4** new `test(...)` blocks, matching design §11's table 1:1 by count. What the orchestrator calls "the added 5th test" — `"a concurrent rebuild burst never orphans the local-only folder's contents"` — is not a bonus test; it is literally **T-R2**, whose name in design §11's table is verbatim `a concurrent rebuild burst never orphans the local-only folder's contents`. Only its internal shape changed (content seeded *after* the initial burst plus a sequential follow-up rebuild, rather than seeded *before* a single burst), exactly as tasks.md 2.2's own DEVIATION note says. Test count: 224 (baseline, task 1.4) → 226 (phase 3, +T-R1/T-R2) → 227 (phase 4/5, +T-R3) → 228 (phase 6/7, +T-R4). There are 4 new tests, not 5. This doesn't change the substance of the verification, but the "5th test" framing should not be repeated downstream.

## 3. Test genuineness (item 1)

All 4 tests were checked line-by-line and empirically forced RED via the isolation matrix above:

- **T-R1** (`concurrent rebuilds of one workspace produce a single managed folder with a stable chrome id`): fires two unawaited `rebuildWorkspace("workspace-1")` calls against a **first-ever-sync** projection (`createEditorProjection()` has no `workspaceChromeId`/`rootChromeId`/`organizationChromeId`/`localOnlyChromeId` set — confirmed by reading `createProjection`'s defaults), so both flights genuinely race on folder creation, not on an already-resolved path. Asserts global folder counts, `workspaceChromeId` stability across a same-tick burst *and* a subsequent sequential rebuild, single local-only folder, and (embedded) the C5 no-warn assertion. **Fails pre-fix** with a real duplicate-folder count (2 vs 1), not a vacuous assertion.
- **T-R2** (`a concurrent rebuild burst never orphans the local-only folder's contents`): seeds a real bookmark into whichever local-only folder survives the first-bootstrap burst, then runs one more sequential rebuild and asserts the bookmark is still reachable under the projection's *current* `localOnlyChromeId`. **Fails pre-fix** with the seeded bookmark's parent resolving to an abandoned duplicate id (`105`) instead of the projection's tracked id (`107`) — this is the literal orphaned-content field symptom, and the assertion is not a tautology (it fails for a concrete, wrong id, not just "something is missing").
- **T-R3** (`concurrent rebuilds of two workspaces in one organization share one root and one organization folder`): two different workspaces in the same org, fired unawaited. Asserts single root/org folder and that both projections reference the *same* `rootChromeId`/`organizationChromeId`. **Fails pre-fix and fails with `rebuildLocks`-only** (per-workspace lock structurally cannot help two different workspace IDs) — this is the one test that cleanly isolates ADR-303's necessity.
- **T-R4** (`an unrecognizable local-only folder is logged before its identity is replaced`): pre-seeds a full real managed path plus a genuinely absent stale `localOnlyChromeId`, one **awaited** rebuild, asserts a `warn` diagnostic naming the stale id and `reused title match`, plus reuse (not recreation) of the pre-seeded folder. **Fails pre-fix** (no diagnostic at all — `notStrictEqual` against `undefined`).

Conclusion: all 4 tests are real, evidence-producing regression tests, verified by direct execution against reverted code, not by trusting tasks.md's self-report.

## 4. Spec scenario compliance matrix (item 2)

8 scenarios across 3 requirements, counted directly from `specs/extension-sync-convergence/spec.md`.

| Requirement | Scenario | Status | Evidence |
|---|---|---|---|
| Serialized Rebuild Per Workspace | Concurrent rebuilds of one workspace converge to one folder | **PASS** | T-R1, empirically RED pre-fix / GREEN post-fix |
| Serialized Rebuild Per Workspace | Rebuild lock is a distinct domain from the drain lock | **UNTESTED** (structural only) | No test fires a drain and a rebuild concurrently for the same workspace to prove non-interference. Verified instead by direct inspection: `rebuildLocks` is a separate `Map` instance (diff confirmed) and `drainLocalIntents`'s 3 call sites (`:465`,`:824`,`:884`) are all lexically outside `doResyncWorkspace` (`:1005-1096`) — grepped exhaustively, no other reference to the identifier exists in the file |
| Serialized Rebuild Per Workspace | Rebuild lock map resets with workspace locks | **UNTESTED** (structural only) | `rebuildLocks.clear();` confirmed added next to `workspaceLocks.clear()` in `resetRuntimeState`. No dedicated test verifies this — but neither does the pre-existing `workspaceLocks.clear()` have one; this matches existing project convention, not a new gap |
| Serialized Rebuild Per Workspace | No backend/persisted-schema change | **PASS (by diff)** | `shared/types.ts` has zero diff; all 224 pre-existing tests (many asserting exact fetch payloads) still pass unmodified |
| Serialized Managed Root and Organization Folder Creation | Concurrent rebuilds of two workspaces share one root/org folder | **PASS** | T-R3, cleanly isolated — empirically the *only* one of the 4 new tests that fails with `rebuildLocks` alone and passes only once `managedPathQueue` lands |
| Serialized Managed Root and Organization Folder Creation | Same-workspace race and cross-workspace race use different mechanisms | **WARNING — partially proven** | See §5 below |
| Diagnostic Log on Unrecognized Local-Only Folder | Missing local-only folder is logged before recreation | **WARNING — partially covered** | See §5 below |
| Diagnostic Log on Unrecognized Local-Only Folder | Recognized local-only folder needs no diagnostic | **PASS** | Covered twice: the untouched pre-existing test (now at `:1325`, was design's cited `:1153`) plus T-R1's own follow-up sequential rebuild, which genuinely re-enters `ensureLocalOnlyFolder`'s early-return (`existingId` found, parent matches) branch and then asserts no `warn` diagnostic |

No CRITICAL findings — every scenario is either passing with a genuine covering test, or covered only structurally with a documented, low-risk rationale (single-line, symmetric-with-existing-pattern additions).

## 5. Findings needing attention (WARNING, not CRITICAL)

### 5.1 The "different mechanisms" scenario is not cleanly isolated by tests
I ran the 3-way isolation matrix in §1 specifically to test this claim. It is **true** that `rebuildLocks` alone is sufficient for T-R1/T-R2 and that `managedPathQueue` alone is *necessary* (not sufficient without it) for T-R3 — that part of design §5/§8's framing holds. But it is **not proven** that the same-workspace race in T-R1/T-R2 is prevented *specifically and only* by `rebuildLocks` as opposed to `managedPathQueue`: empirically, `managedPathQueue` **alone** (no `rebuildLocks` at all) also makes T-R1 and T-R2 pass, deterministically, across 3 repeated runs. So there is currently no test that would fail if a future refactor accidentally deleted `rebuildLocks` while `managedPathQueue` stayed — the suite would stay green. `rebuildLocks`'s distinct justification (avoiding a `workspaceLocks`/drain-lock deadlock, ADR-301 rationale 3a/3b) is real but is argued narratively in design.md, not regression-tested. This is the same *class* of gap the apply agent already disclosed for the original T-R1/T-R2 shape — a plausible-looking design claim that, when actually forced empirically, turns out weaker than stated. Recommend (non-blocking): a follow-up test that seeds an in-flight `drainLocalIntents` (holding `workspaceLocks` for the workspace) concurrently with a `rebuildWorkspace` call, to positively exercise scenario 2 of Requirement 1 and to give `rebuildLocks` a test that would actually fail without it.

### 5.2 Diagnostic-log spec scenario only covers the "reuse" sub-path, not the literal "create" sub-path
Spec Scenario "Missing local-only folder is logged before recreation" says: "...AND a new local-only folder is created afterward, exactly as before this change." T-R4, as written, pre-seeds an existing folder with the correct title under the workspace root, so `ensureLocalOnlyFolder`'s fallback takes the `reused ?? create` ternary's `reused` branch (test asserts the message contains `reused title match`, and `projection.localOnlyChromeId` ends up equal to the *pre-existing* folder's id, not a newly-minted one). There is no test combining "stale/unresolvable persisted id" with "no title-matched folder exists" — i.e., the literal creation path the spec's own scenario text describes is untested for the new diagnostic. The `createFolder` call itself is well-covered by pre-existing, unrelated tests, so production risk is low, but strictly the scenario as worded is only partially demonstrated. Recommend (non-blocking): add or note as a residual gap.

## 6. Design proofs re-examined under the precedent set by the T-R1/T-R2 deviation (item 7)

Per the orchestrator's explicit ask to not take design.md's remaining proofs at face value given the disclosed test-plan gap, I independently re-verified rather than re-read:

- **§8 lock-order proof (`rebuildLocks → managedPathQueue → stateMutationQueue`, acyclic)**: **holds up**, verified by full-file inspection of `chrome-bookmarks.ts` (all 224 lines read) — it imports only `ROOT_FOLDER_TITLE` from `shared/runtime.js`, has zero references to `getState`/`updateState`/any storage import, and its only chrome API surface is `chrome.bookmarks.*`. Since `rebuildLocks` is a module-private `const` in `projection.ts` (grepped: only 3 references — declaration, use, clear — never exported), `chrome-bookmarks.ts` cannot structurally reach it. Also independently confirmed `doResyncWorkspace`'s body (`:1005-1096`) contains none of `drainLocalIntents`'s 3 call sites. This is a genuinely provable, not merely narrated, claim — it holds.
- **§10.2 self-heal proof for the `Personal (not synced)` symptom, "pinned by T-R1/T-R2"**: **holds up** — T-R1's follow-up sequential rebuild after the burst and T-R2's orphan-survival check both concretely exercise the exact mechanism described (`ensureLocalOnlyFolder`'s early return via a resolved `existingId`, `clearManagedChildrenWithSuppression`'s `excludeIds` preserving it).
- **§10.1 self-heal proof for pre-existing duplicate folders** ("the workspace re-binds to one specific duplicate... via `children.find()`'s stable index order"): **not covered by any test**, and this is the one place I'd flag as sharing the same class of unverified optimism the test-plan gap did. Nothing in the 4 new tests (all of which start from a clean or first-bootstrap tree) exercises a scenario with pre-existing duplicate folders already present before a post-fix rebuild. The claim itself is plausible (Chrome's `getChildren` does return array order == index order, and nothing in this change reorders folders), but it is asserted, not demonstrated. This is explicitly lower-stakes than the T-R1/T-R2 gap because proposal.md explicitly scopes "cleanup of existing orphaned duplicates" as **out of scope**, so §10.1 is a narrative bonus, not a requirement the change must satisfy — I'm flagging it as a SUGGESTION, not a WARNING, precisely because of that explicit scoping.

## 7. Issues summary

- **CRITICAL**: none.
- **WARNING** (2): §5.1 same-workspace mechanism attribution not test-isolated; §5.2 diagnostic-log spec scenario's literal "create" sub-path untested.
- **SUGGESTION** (2): §10.1's self-heal duplicate-resolution claim is unverified by any test (acceptable given explicit out-of-scope status); orchestrator's "5th test" framing should be corrected to "T-R2, redesigned" in any downstream summary/PR description to avoid overstating test-plan changes.

## 8. Tasks/apply-progress cross-check

All 8 phases in tasks.md are checked complete `[x]`. Every GATE claim in tasks.md (RED counts, GREEN counts, exact assertion failure messages) was independently reproduced byte-for-byte by my own re-execution (224/4, 226/2 fixed etc., final 228/228). No discrepancy between the recorded apply history and the actual current test output.
