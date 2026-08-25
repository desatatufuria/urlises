# Tasks: Serialize Rebuild so managed folder identity stops churning

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~140 (≈50 production, ≈12 test double, ≈80 new tests+import) |
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
| 1 | Full change (2 locks + 1 log + tests) | PR 1 | `cd extension && npm run test:projection` | N/A — no browser E2E harness in repo (design §11) | Single revert of the branch merge; locks are in-memory only, no schema/persisted change |

## Phase 1: Step 0 — test-double fidelity gate (must land first, no-op)

- [x] 1.1 `tests/projection-behavior.test.mjs:10` — add `let asyncBookmarkCallbacks = false;` (ADR-305)
- [x] 1.2 `tests/projection-behavior.test.mjs:130-142` — wrap `create`'s body in `run()`; `if (asyncBookmarkCallbacks) setTimeout(run, 0); else run();`
- [x] 1.3 `tests/projection-behavior.test.mjs:421` — reset `asyncBookmarkCallbacks = false` in `resetRuntime`
- [x] 1.4 GATE: run `npm run test:projection`; confirm 100% green as a no-op before writing any new test (224/224 pass)

## Phase 2: RED — same-workspace rebuild race (T-R1, T-R2)

- [x] 2.1 Append T-R1 (design §11 table, exact assertions): `asyncBookmarkCallbacks = true`, two unawaited `rebuildWorkspace("workspace-1")`, `Promise.all`, no `await` between calls — DEVIATION: implemented as a first-bootstrap burst (no pre-established path) plus a follow-up rebuild, with global (not org-scoped) folder counts; see Deviations section
- [x] 2.2 Append T-R2 (design §11 table): same shape, bookmark seeded in local-only folder after the burst, then a follow-up rebuild proves it is not orphaned — DEVIATION: see Deviations section
- [x] 2.3 GATE: run suite; confirm T-R1 and T-R2 both fail (RED) before landing #1/#2/#4 (both confirmed RED with meaningful assertion failures: duplicate "Org" folder count 2 vs 1; seeded bookmark orphaned under abandoned duplicate id 105 vs expected 107)

## Phase 3: GREEN — rebuild lock (changes #1, #2, #4)

- [x] 3.1 `projection.ts:143` (insert after) — `const rebuildLocks = new Map<string, WorkspaceResyncLock>();` (ADR-301)
- [x] 3.2 `projection.ts:401-406` — rewrite `rebuildWorkspace`: capture `let resynced = false;`, route `doResyncWorkspace` through `runCoalescedWorkspaceTask(rebuildLocks, workspaceId, "explicit rebuild", async (reason) => { resynced = await doResyncWorkspace(workspaceId, reason, "recovering"); })`; `if (resynced) await connectWorkspace(workspaceId);` (ADR-301/302)
- [x] 3.3 `projection.ts:2480` (insert after `workspaceLocks.clear()`) — `rebuildLocks.clear();` in `resetRuntimeState` (ADR-301)
- [x] 3.4 GATE: run suite; confirm T-R1, T-R2 GREEN, no regressions (226/226 pass)

## Phase 4: RED — cross-workspace shared-root race (T-R3)

- [x] 4.1 `tests/projection-behavior.test.mjs:274` — add `ROOT_FOLDER_TITLE` to existing `dist/shared/runtime.js` import
- [x] 4.2 Append T-R3 (design §11 table): two projections in org `"Org"`, both `rebuildWorkspace` unawaited, `Promise.all`
- [x] 4.3 GATE: run suite; confirm T-R3 fails (RED) before landing #5/#6 (RED confirmed: duplicate "Org" folder count 2 vs expected 1; root folder happened not to duplicate in this run's interleaving but org did, still a genuine cross-workspace regression)

## Phase 5: GREEN — managed-path FIFO queue (changes #5, #6)

- [x] 5.1 `chrome-bookmarks.ts:3` (insert after `LEGACY_ROOT_FOLDER_TITLE`) — module-private `managedPathQueue` + `enqueueManagedPathTask<T>` promise-chain helper (ADR-303)
- [x] 5.2 `chrome-bookmarks.ts:133-139` — wrap `ensureManagedPath`'s full body in `enqueueManagedPathTask(async () => {...})`; leave `ensureManagedRoot`/`ensureFolderByTitle` untouched (ADR-303)
- [x] 5.3 GATE: run suite; confirm T-R3 GREEN, no regressions (227/227 pass)

## Phase 6: RED — unresolvable local-only folder (T-R4)

- [x] 6.1 Append T-R4 (design §11 table): pre-seed full managed path + stale-absent `localOnlyChromeId`, one awaited rebuild; also assert T-R1's clean run logs no `warn` (C5)
- [x] 6.2 GATE: run suite; confirm T-R4 fails (RED) before landing #3 (RED confirmed: no warn diagnostic present; T-R1's C5 no-warn assertion already GREEN)

## Phase 7: GREEN — diagnostic log (change #3)

- [x] 7.1 `projection.ts:1093-1114` — in `ensureLocalOnlyFolder`, add `unresolved: "missing"|"reparented"|undefined`, set when persisted `existingId` doesn't resolve under `workspaceChromeId`; `log(`sync:${workspaceId}`, ..., "warn")` after `folderNode` resolves, before `updateProjectionState` (ADR-304)
- [x] 7.2 GATE: run suite; confirm T-R4 GREEN and existing no-warn assertion (`:1153`) still passes (228/228 pass)

## Phase 8: Final verification

- [x] 8.1 Run full `npm run test:projection`; confirm zero regressions across old + new tests (228/228 pass; `npm run typecheck` also clean)
- [x] 8.2 Diff-review against design §9 change inventory; confirm only the 2 files + test file changed; `backend/`, `admin-web/` untouched (confirmed via `git status --short`/`git diff --stat`)
