## Exploration: Auto-repair before showing the degraded/red-dot state

### Current State

**The visible red-dot signal is `ProjectionState.health === "degraded"`.** Confirmed at `extension/src/shared/ui/status.ts:232-263`: `tone = "attention"` and `cardClassName = "ui-card--degraded"` are driven exclusively by `projection.health === "degraded"`. Anything that wants to "attempt repair before showing degraded" must intercept every place that sets `health = "degraded"` — and there are **three**, not one:

1. **`pauseWorkspace(workspaceId, cursor, reason)`** — `extension/src/background/projection.ts:2010-2022`. Computes `repairDisposition` via `gateRemoteEffect` (`convergence.ts:102-104`: `"rebuild"` only if `reason === "bootstrap-required"`, else `"retry"`, upgraded to `"rebuild"` if a pending receipt exists), then unconditionally sets `status = "error"`, `health = "degraded"`, `degradedReason`, `degradedAt`.
2. **`enterRecovery`'s give-up branch** — `projection.ts:2024-2048`, specifically lines 2031-2037. When `recoveryAttemptCount + 1 > MAX_SILENT_RECOVERY_ATTEMPTS` (3, line 86), it sets `status = "error"`, `health = "degraded"`, `degradedReason`, `degradedAt` **directly**, without ever calling `pauseWorkspace`. It does **not** touch `convergenceJournal` or compute `repairDisposition` at all — so a workspace degraded via this path has no `repairDisposition` and the UI's repair-label logic (`status.ts:239`) falls back to `"Retry available"` by default, which may not reflect reality.
3. **`captureLocalUpdateOrMove`'s two direct journal mutations** — `projection.ts:437-452`. When a locally-changed/moved bookmark's chrome node is missing or outside the workspace, this sets `journal.phase = "paused"` and `pauseReason` (`"cursor-zero-read-failed"`, `"ambiguous-operation"`, `"stale-mapping"`) **directly on the journal, without ever setting `health` or `status`**. The projection can be left with `health` still `"live"` while the journal is actually paused (`applyRemoteEnvelope` line 1196 and `drainLocalIntentsNow` line 477 both early-return once `journal.phase === "paused"`, so nothing is silently making forward progress) — a pre-existing gap where the user never sees red at all for these two pause reasons today.

**Full `pauseWorkspace` call-site map** (12 raw call sites in `projection.ts`; grep confirms this exact list):

| Line | Call site | Category |
|---|---|---|
| 529 | `drainLocalIntentsNow` catch — a queued local-intent PATCH to the backend threw | (a) fresh/independent |
| 749 | `ensureWorkspaceProjection`, `needsBootstrap(latest)` true — first sync of a newly-selected workspace | (a) fresh, but arguably not a "failure" — `repairDisposition` always resolves to `"rebuild"` here |
| 928 | `resyncWorkspace` — **disabled stub**, always logs `"automatic resync disabled"` (line 929) and pauses. Reached from **8** distinct call sites: `handleBookmarkCreated` (567, 578), `handleBookmarkChanged` (624), `handleBookmarkMoved` (647), `handleBookmarkRemoved` (674, 682, 699), and `logRejectedMutation`'s default path (945) | (a) fresh triggers funneling into an intentionally-inert repair action |
| 1090 | `doResyncWorkspace` catch — an already-in-progress explicit rebuild (only caller: `rebuildWorkspace`) failed partway through | (b) internal give-up step of an already-attempted repair |
| 1198 | `applyRemoteEnvelope` — pending receipt + `canPersistReceipt` capacity exceeded during normal live/replay apply | (a) fresh/independent |
| 1271 | `applyRemoteEnvelope` catch-all — any remote-event apply failure | (a) fresh/independent — the single largest source of pauses |
| 1380, 1392 | `applyRemoteFolderUpsert` — receipt-capacity guard on move / on title-update | (a) fresh/independent, duplicated logic |
| 1490, 1503 | `applyRemoteBookmarkUpsert` — same guard, bookmark variant | (a) fresh/independent, duplicated logic |
| 2007 | `recoverWorkspace`, `mode === "resync"` — reached only after `enterRecovery` already said "continue", but the resync mode itself is a stub that immediately pauses | (b) internal step of a chain that decided to keep trying, whose actual "try" is disabled |
| 2213 | `recoverSubtreeThenWorkspace` terminal fallback — reached only after `attemptSubtreeRecovery` already failed, and after its own `enterRecovery` call already consumed a budget slot | (b) chain has exhausted its own internal fallback |

Roughly half the call sites are fresh/independent triggers, and the other half (1090, 2007, 2213, plus `enterRecovery`'s give-up branch) are internal give-up/terminal steps of recovery logic that has already tried something else. Hooking auto-repair uniformly at every `pauseWorkspace` call — as both prior attempts did — means the terminal steps of `recoverSubtreeThenWorkspace` and `recoverWorkspace("resync")` would each independently re-dispatch a brand new repair action on top of a chain that already just failed one — exactly the loop the second attempt hit.

**Root-cause account for the `cursor 8` → `cursor 7` counter and the full-suite hang** (test: `tests/projection-behavior.test.mjs:2385`, `"connectWorkspace falls back from subtree recovery to workspace resync before degrading"`):

Two facts are proven from the current source (the discarded diff itself could not be inspected — it was never committed):

- **`updateState` (and therefore `updateProjectionState`, `pauseWorkspace`, `enterRecovery`) is already a serialized, atomic read-modify-write** (`shared/storage.ts:5, 49-56, 168-172`): every call chains onto a single module-level `stateMutationQueue` promise, so the entire `getState() → updater → chromeStorageSet()` cycle of one call always completes before the next queued one starts. The existing `recoveryAttemptCount` counter (read-and-incremented inside the updater at `projection.ts:2028`) demonstrably works correctly across repeated calls using exactly this pattern — this rules out a storage-layer race as the explanation.
- `getState()` itself is **not** part of that queue (`storage.ts:26-43` calls `chromeStorageGet` directly) — any code reading `getState()` outside an `updateProjectionState` updater gets a plain snapshot that can be stale by the time it's used, even though the storage layer never corrupts a write.

The most likely explanation for a counter reading `1, 1` instead of `1, 2` is that the discarded implementation tracked the attempt count in a bare module-level `Map<string, number>` (mirroring `pendingAutoRepairs`/`volatileRepairGates`'s *shape*, `projection.ts:79-85`, but not their serialization discipline), incremented from inside the fire-and-forget repair dispatch rather than inside the atomic updater that decides to pause. A plain Map read/increment has no queue backing it, so a second, nested `pauseWorkspace` call reached via the recovery chain (`pauseWorkspace → fire-and-forget retryWorkspace → replayWorkspaceDelta → recoverWorkspace("resync") → pauseWorkspace` again) can read the Map before the first dispatch's own increment executes, because `retryWorkspace`/`replayWorkspaceDelta` each await real `getState()`/network calls, yielding the microtask queue multiple times before ever touching the counter.

**Hang hypothesis**: `recoverWorkspace`'s `mode === "resync"` branch and `resyncWorkspace` are both unconditional stubs that always re-pause instead of resyncing. If auto-repair is dispatched fire-and-forget from every `pauseWorkspace` call with no per-workspace reentrancy guard, the chain `pauseWorkspace → retryWorkspace → replayWorkspaceDelta → recoverWorkspace("resync") → pauseWorkspace → …` is only bounded by a correctly-read attempt counter. If the counter has the staleness bug above, each fire-and-forget branch could independently believe it is "attempt 1 of 2" indefinitely, and nothing stops multiple overlapping fire-and-forget chains for the same workspace from being spawned in parallel each time `pauseWorkspace` is hit again before the previous chain's Map write lands — an unbounded, still-actively-scheduling (not classically deadlocked) chain of queued `stateMutationQueue` work, consistent with "0 output after 2+ minutes" rather than a deadlock.

**On reusing `MAX_SILENT_RECOVERY_ATTEMPTS`/`recoveryAttemptCount`:** Tempting but insufficient alone. It only gates the 4 call sites that reach `recoverWorkspace`/`recoverSubtreeThenWorkspace` — not the other 8 direct `pauseWorkspace` call sites, including the single largest source of pauses (1271, the catch-all remote-apply failure). Fixing `resyncWorkspace`'s stub and extending `MAX_SILENT_RECOVERY_ATTEMPTS` would satisfy "2 attempts before degrading" only for the reconnect/replay/resync family, silently leaving every other pause reason with zero auto-repair attempts — a direct violation of "applies to every pause reason." A new, separate, persisted counter is warranted, but it must follow `recoveryAttemptCount`'s proven-safe pattern (increment inside the `updateProjectionState` updater, reset on success at the same 3 sites `recoveryAttemptCount` resets at: `markProjectionLive` 1882, `doResyncWorkspace` success 1079, `attemptSubtreeRecovery` success 2278), not a bare in-memory Map.

The dead, currently-unused `ConvergenceJournal.attempts` field (`shared/types.ts:210`, initialized to 0 in `emptyJournal()`/`plan()`, never incremented or read anywhere else) is not a safe home either: `plan()` fully replaces the journal (resetting `attempts` to 0) as part of ordinary re-planning, which is not necessarily correlated with "the workspace successfully returned to live."

### Affected Areas

- `extension/src/background/projection.ts` — `pauseWorkspace` (2010), `enterRecovery` (2024), `recoverWorkspace` (1971), `recoverSubtreeThenWorkspace` (2175), `resyncWorkspace` (927), `retryWorkspace` (391), `rebuildWorkspace` (402), `doResyncWorkspace` (1005), `captureLocalUpdateOrMove` (435).
- `extension/src/background/convergence.ts` — `gateRemoteEffect`, `retryJournal`, `rebuildJournal` — whichever object holds the new counter must survive (or be deliberately reset by) journal transitions through these.
- `extension/src/shared/storage.ts` — `updateState`'s serialization guarantee is the safety net any new counter must rely on; do not introduce a second, unsynchronized counter store.
- `extension/src/shared/types.ts` — `ProjectionState` (217-241) and `ConvergenceJournal` (202-215).
- `extension/src/shared/ui/status.ts` (231-264) — repair-label text already branches on `repairDisposition`; `enterRecovery`'s give-up path currently has no `repairDisposition`, so consolidating the degrade paths would also fix that UI gap.
- `extension/tests/projection-behavior.test.mjs` — the 18 originally-broken tests, plus the failing scenario at line 2385, are the regression surface.

### Approaches

1. **Uniform hook at every `pauseWorkspace` call + reentrancy guard** — keep `pauseWorkspace` as the single choke point (extended so `enterRecovery`'s give-up branch and `captureLocalUpdateOrMove`'s two direct-journal pauses also route through it), add a persisted `autoRepairAttempts` counter incremented inside the atomic updater (mirroring `recoveryAttemptCount`), and add a per-workspace in-flight guard (reusing the existing `workspaceLocks`/`rebuildLocks`/`socketConnectFlights` Map pattern) so a repair action's own internal `pauseWorkspace` calls cannot spawn a second, competing auto-repair dispatch.
   - Pros: single choke point, matches "every pause cause" literally; reuses proven codebase patterns instead of inventing new ones.
   - Cons: needs care to avoid the recursion the second attempt hit; touches ~12 call sites plus 2 non-`pauseWorkspace` degrade paths.
   - Effort: Medium.

2. **Hook only at terminal/give-up sites, leave "fresh" pauseWorkspace calls untouched** — in practice collapses to almost the same set as approach 1, since 8 of 12 raw call sites are still "fresh" triggers that DO need repair-before-degrade per "every pause cause." Differs mainly in NOT re-triggering repair at 1090/2007/2213.
   - Pros: naturally avoids recursion without an explicit guard, since the loop-prone sites are excluded.
   - Cons: fragile classification by call-site identity, brittle to refactors; still needs the same atomic-counter fix.
   - Effort: Medium, higher design risk.

3. **Hook at the entry points that decide to start a recovery/mutation flow, above `pauseWorkspace`** — wrap the handful of true triggers so each independently retries its own operation up to 2 times before ever calling into `pauseWorkspace`/`recoverWorkspace`.
   - Pros: keeps `pauseWorkspace` itself simple, no recursion risk since the loop never re-enters it.
   - Cons: duplicates the 2-attempt loop across ~6-8 independent call sites, higher chance of inconsistent behavior, doesn't naturally cover `enterRecovery`'s give-up branch or `recoverSubtreeThenWorkspace`'s existing internal fallback without special-casing.
   - Effort: High.

### Recommendation

Approach 1, implemented carefully: consolidate the three degrade paths into one (`pauseWorkspace`), add a persisted `autoRepairAttempts: number` field on `ProjectionState` (sibling of `recoveryAttemptCount`, not inside `ConvergenceJournal`, so it survives journal replacements untouched), incremented and capped at 2 **inside** the same `updateProjectionState` updater that decides to pause (never in a bare Map), reset to 0 at the same 3 existing success sites `recoveryAttemptCount` already resets at, and gated by a per-workspace in-flight guard (new `autoRepairFlights: Map<string, Promise<void>>`, following the exact shape of `socketConnectFlights`) so a repair action's own downstream `pauseWorkspace` calls never spawn a second concurrent dispatch. Re-enable `resyncWorkspace`/`recoverWorkspace`'s resync stub to actually call `doResyncWorkspace` FIRST — otherwise "attempt Retry/Rebuild" for the resync-shaped failures is guaranteed to fail every time by construction.

### Risks

- Re-enabling the resync stub is a behavior change independent of the auto-repair feature and could reintroduce whatever issue caused it to be disabled; needs its own test coverage.
- `captureLocalUpdateOrMove`'s silent-pause gap (health never flips) is a pre-existing defect discovered during this exploration, not scoped by the two prior attempts — consolidating it into `pauseWorkspace` changes currently-shipped behavior and needs its own scrutiny/tests, separate from the auto-repair feature.
- The exact mechanism of the discarded implementation's counter bug and the full-suite hang could not be confirmed against the actual removed diff (it was never committed); the account above is a static-analysis-grounded reconstruction anchored to proven facts about `updateState`'s serialization and `recoveryAttemptCount`'s working pattern.
- 12 `pauseWorkspace` call sites plus 2 additional non-`pauseWorkspace` degrade paths is a wide blast radius; the 18-test regression surface from the first attempt should be treated as a floor, not a ceiling.

### Ready for Proposal

Yes, with one caveat resolved by the orchestrator directly (see below): why `resyncWorkspace` was disabled.
