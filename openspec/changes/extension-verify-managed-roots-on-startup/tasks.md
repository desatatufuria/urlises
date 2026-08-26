# Tasks: Verify managed roots exist on startup

Sequencing note: all tasks are sequential — one file per phase (`projection.ts` in Phase 2,
`projection-behavior.test.mjs` in Phase 1), so no task pair is safely parallelizable.

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~150-180 (~40 prod incl. comments, ~120 test) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending (N/A — single PR, no chaining) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Verification branch + helper + 4 tests | PR 1 | `node --test extension/tests/projection-behavior.test.mjs` | Delete a managed folder in Chrome bookmarks, reload the unpacked extension, confirm the workspace rebuilds/pauses instead of staying falsely "live" | Delete the new `else` branch and `findUnresolvableManagedRoots`; additive, no persisted state |

Confirmed independently (not assumed from design.md): 1 file changed in `src`, 1 in `tests`,
~150-180 total lines — comfortably under the 400-line budget. Single PR, no chaining needed.

## Phase 1: RED Tests — `extension/tests/projection-behavior.test.mjs`

- [ ] 1.1 T-V1 (dangling root, no `onRemoved` fired — spec: "Dangling root detected"): seed 3 nodes, `removeBookmarkSubtree("workspace-node")`, `health:"live"`, `autoRepairAttempts:0`. Assert: diagnostic matches `resync required: managed root unresolvable at selection changed: workspace`; `autoRepairAttempts===1`; `repairDisposition==="rebuild"`; `workspaceChromeId` changes and resolves; `health!=="degraded"`. RED on `develop`.
- [ ] 1.2 T-V3 (already-degraded gets one fresh attempt — spec: "Already-degraded workspace gets a fresh rebuild attempt"): as 1.1, seed `health:"degraded"`, journal paused `"ambiguous-predecessor"`, `autoRepairAttempts:1`. Assert: rebuild-started diagnostic; `autoRepairAttempts===2`; one `/tree` fetch; `health!=="degraded"`. RED on `develop`.
- [ ] 1.3 T-V4 (exhausted budget degrades immediately — ADR-504): as 1.1, `autoRepairAttempts:2`. Assert: `health==="degraded"`; zero `/tree` fetches; zero rebuild-started diagnostics. RED on `develop` (health wrongly stays `"live"` today).
- [ ] 1.4 T-V2 (healthy workspace untouched — spec: "Healthy workspace is untouched by verification"): all 3 nodes resolve, `health:"live"`, `autoRepairAttempts:0`, working `/tree` handler registered. Assert: zero `/tree` fetches; `autoRepairAttempts`/`health` unchanged; journal not paused; `workspaceChromeId` unchanged; `autoRepairFlightCount()===0`. Regression guard — already passes pre-change; must stay GREEN through Phase 2.

## Phase 2: GREEN Implementation — `extension/src/background/projection.ts`

- [ ] 2.1 Add `findUnresolvableManagedRoots(projection)` immediately after `needsBootstrap` (~:2452): checks `root → organization → workspace` sequentially via `getNode`, no early exit, returns the array of missing kinds (ADR-501).
- [ ] 2.2 In `ensureWorkspaceProjection` (~:755): add explicit `return` after the bootstrap pause, then the new `else` branch calling the helper; on any miss, call `resyncWorkspace(workspaceId, "managed root unresolvable at ${reason}: ${unresolvable.join(', ')}")` (ADR-502).
- [ ] 2.3 Compile (`tsc`) so `extension/dist` reflects the change (tests import compiled output).
- [ ] 2.4 Run `node --test extension/tests/projection-behavior.test.mjs`; confirm T-V1/T-V3/T-V4 flip GREEN and T-V2 stays GREEN.

## Phase 3: Regression Verification

- [ ] 3.1 Run `projection-behavior.test.mjs`, `theme-preferences.test.mjs`, `public-config.test.mjs`; confirm the pre-existing `ensureWorkspaceProjection` call sites (`:893` empty selection, `:3511` bootstrap) are unaffected.
- [ ] 3.2 Diff against `develop`: confirm edits are confined to the new helper and the `ensureWorkspaceProjection` tail, and that `handleBookmarkRemoved` is untouched (spec: "Reactive removal detection is unaffected").

## Phase 4: Close-out

- [ ] 4.1 Check off the four `proposal.md` Success Criteria items once Phase 3 passes.
