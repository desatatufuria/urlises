# Proposal: Verify managed roots exist on startup

## Intent

A live workspace ("BANCAMARCH") reported `health: "live"`, `status: "ready"`, no pause reason — while its `workspaceChromeId` pointed at a Chrome folder that no longer exists (`chrome.bookmarks.get` → "Can't find bookmark for id"). Its `backendIdByChromeId` map held 0-1 entries despite real content, so quick-search's `workspace` scope found nothing.

Cause: `handleBookmarkRemoved` (projection.ts:687-701) detects a removed managed root **only reactively**, from a live `onRemoved` event. MV3 evicts and restarts the worker constantly; a folder deleted while no worker is alive loses that event forever, and nothing re-derives the truth. `initializeBackground` (:173) calls `syncSelectedWorkspaces("startup")` with zero existence checks; `needsBootstrap` (:2450) only asks whether the ids are *set*, never whether they *resolve*. The workspace stays permanently and silently stuck.

## Scope

### In Scope
1. Existence verification of `rootChromeId` / `organizationChromeId` / `workspaceChromeId` via the existing non-throwing `getNode` (`chrome-bookmarks.ts:18`, returns `null` on miss).
2. Placement in `ensureWorkspaceProjection` (:755) — the uniform per-workspace choke point already reached from startup (:184), login (:196), and selection change (:406). It already reads `latest` and already awaits `pauseWorkspace` for `needsBootstrap`; the new check is the sibling `else` branch (ids set but dangling).
3. On any miss: call the existing `resyncWorkspace(workspaceId, ...)` — the identical path `handleBookmarkRemoved` uses, yielding `pauseWorkspace(..., "ambiguous-predecessor", { repair: "rebuild" })`.

### Out of Scope
- `handleBookmarkRemoved`'s reactive path — unchanged.
- Auto-repair budget/disposition/veto logic (ADR-404) — this only adds a trigger into the existing pipeline.
- The orphaned "BANCAMARCH > BANCAMARCH > pruebas" debris — pre-existing content, not a code defect.
- The five shipped sync fixes; periodic/interval re-verification; backend changes.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `extension-sync-convergence`: *Verified Fail-Closed Sequencing* — a projection MUST NOT report live while a tracked managed root is unresolvable; existence MUST be re-derived at every projection-ensure point, not only from live removal events.

## Approach

Await the checks inline. Justification from the code, not preference: `ensureWorkspaceProjection` is already fully awaited by `syncSelectedWorkspaces` and already awaits `pauseWorkspace` in its bootstrap branch — awaiting matches the surrounding contract. Cost is ≤3 `chrome.bookmarks.get` per selected workspace, once per worker start, before socket connect. Fire-and-forget stays where it already belongs: inside `pauseWorkspace`'s repair dispatch, untouched.

| # | Decision | Rationale |
|---|---|---|
| D1 | `ensureWorkspaceProjection`, not `initializeBackground` | Covers startup **and** selection change; runs per workspace uniformly; the `needsBootstrap` check next to it is the same class of question |
| D2 | Reuse `resyncWorkspace`, no parallel mechanism | Same disposition, same budget, same veto as the reactive path |
| D3 | Existence only (`getNode !== null`) | Smallest correct fix; structural/parentage validation deferred (see Q3) |
| D4 | Run only when `needsBootstrap` is false | That branch already pauses; no double pause, no wasted budget |

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `extension/src/background/projection.ts` | Modified | `ensureWorkspaceProjection` gains the verification branch |
| `extension/tests/projection-behavior.test.mjs` | Modified | Dangling-root-at-startup coverage |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Users see `recovering`/`degraded` where they saw (falsely) green | Med | Intended — that green was a lie; auto-repair heals silently first |
| Transient `chrome.bookmarks.get` failure triggers a needless rebuild | Low | `getNode` fails only on genuine absence; a rebuild is idempotent and budget-capped at 2 |
| Startup rebuild dispatches before the socket connects | Low | Verify in design that `doResyncWorkspace` depends on HTTP catalog, not the socket |
| Exhausted `autoRepairAttempts` degrades immediately at startup | Low | Correct fail-closed: two failed rebuilds means ask a human |

## Rollback Plan

Delete the verification branch in `ensureWorkspaceProjection`. Single-function, additive, no persisted state introduced; no migration.

## Dependencies

- Auto-repair layer (ADR-404, `{ repair: "rebuild" }`) already on `develop`.
- Branch `fix/extension-verify-managed-roots-on-startup` off `develop`.

## Success Criteria

- [x] A workspace whose `workspaceChromeId` no longer resolves is detected on the next worker start, without any `onRemoved` event. (T-V1, T-V3)
- [x] Detection routes through `resyncWorkspace` — no new pause reason, no new repair mechanism. (T-V1/T-V3: same `"ambiguous-predecessor"` + `{ repair: "rebuild" }` disposition)
- [x] A workspace with all roots resolving is untouched: no extra pause, no counter change, no re-materialization. (T-V2)
- [x] The reactive `handleBookmarkRemoved` path behaves identically to today. (untouched — confirmed byte-identical in the diff)

## Proposal question round — resolved by orchestrator

1. **Coverage window**: confirmed — startup + login + selection change only, no periodic timer or reconnect hook. MV3 restarting the worker frequently (observed constantly this session) already bounds the practical stuck window; a timer adds polling cost and complexity for a case the natural restart cadence already covers well enough. Revisit only if real usage shows workers staying alive unusually long.
2. **Already-degraded workspaces**: confirmed — verify them too. A degraded workspace's existing manual Rebuild path already re-derives everything unconditionally, so giving a dangling-root degraded workspace one fresh automatic attempt on the next start is consistent with that existing semantics, not a new cost class. Skipping verification when `health === "degraded"` would leave exactly the stuck-forever case this proposal exists to close.
3. **Existence vs. structure**: confirmed — existence only, deliberately deferred. Defining "correct parentage" requires deciding whether a user-moved managed folder is a violation or a legitimate reorganization, which is a separate product question with its own tradeoffs, not something to fold into a narrow, evidence-driven bugfix. The orphaned duplicate structure found during investigation is exactly this kind of pre-existing content-shape issue, out of scope here as already stated.
