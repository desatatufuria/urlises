# Tasks: Extension Missing Parent Recovery

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 320-460 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 -> PR 2 |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Add subtree invalidation and bounded runtime recovery | PR 1 | Base = `feature/shared-bookmark-sync-mvp`; runtime helpers, apply paths, local loop stop. |
| 2 | Lock behavior with focused tests, docs, and manual repro notes | PR 2 | Base = PR 1 branch; keep validation/docs with the remediation slice. |

## Phase 1: Recovery Foundation

- [x] 1.1 Add scoped prune helpers in `extension/src/shared/mapping.ts` for affected subtree backend↔Chrome mappings and descendant exclusion cleanup.
- [x] 1.2 Add `RecoveryScope` derivation and parent/mapped-node validation helpers in `extension/src/background/projection.ts` using `getNode`, `getChildren`, and `getSubTree`.

## Phase 2: Runtime Remediation

- [x] 2.1 Update `applyRemoteFolderUpsert()` and `applyRemoteBookmarkUpsert()` in `extension/src/background/projection.ts` to block apply on missing/stale parents, invalidate the subtree, recover, then continue once.
- [x] 2.2 Update `applyRemoteFolderDelete()`, `applyRemoteBookmarkDelete()`, and `deleteChromeNode()` in `extension/src/background/projection.ts` to prune stale mappings deterministically after delete/move cascades.
- [x] 2.3 Update `handleBookmarkMoved()`, `handleBookmarkRemoved()`, and `logRejectedMutation()` in `extension/src/background/projection.ts` to abandon repeated local `404`/missing-parent retries and suppress stale subtree re-emission.
- [x] 2.4 Extend `recoverWorkspace()` / replay handling in `extension/src/background/projection.ts` with subtree-first escalation, workspace fallback, and bounded loop prevention without broad WU5 hardening.

## Phase 3: Focused Tests

- [x] 3.1 Extend `extension/tests/projection-behavior.test.mjs` for remote folder/bookmark upserts that hit a missing parent and recover the canonical subtree before apply resumes.
- [x] 3.2 Extend `extension/tests/projection-behavior.test.mjs` for local delete/move rejection loops so repeated `404` or parent-miss failures stop retrying and degrade only after the bounded ladder fails.
- [x] 3.3 Extend `extension/tests/projection-behavior.test.mjs` for stale delete mappings so descendant mappings/exclusions are pruned and replay does not recreate duplicates or loop.

## Phase 4: Documentation and Manual Validation

- [x] 4.1 Update `README.md` to document the narrow cascade-recovery rule set, Gitflow follow-up intent, and how to validate delete/move recovery manually.
- [x] 4.2 Update `docs/roadmap.md` to record this extension-only remediation as a focused follow-up, explicitly excluding broad WU5 hardening.
- [x] 4.3 Add implementation notes in this `tasks.md` change record for Chromium manual repro: delete nested folders, move children during churn, verify subtree recovery, verify no infinite `404` loop.

## Implementation Notes

- Runtime recovery stays extension-first inside `extension/src/background/projection.ts`; no backend contracts changed.
- `RecoveryScope`, subtree invalidation, and stale-mutation abandonment are intentionally limited to destructive delete/move cascade paths.
- `removeMappingsByBackendIds()` in `extension/src/shared/mapping.ts` provides deterministic subtree mapping cleanup before replay/rebuild.
- Automated coverage now proves stale folder mapping rebuild, missing parent subtree restoration, stale folder delete cleanup, and local delete rejection loop suppression.
- Chromium manual repro should still validate nested-folder delete churn, concurrent child moves during recovery, restored-parent gating before remote apply resumes, and no infinite local `HTTP 404` loop.

## Manual Validation Checklist

- [ ] Deleting nested managed folders does not recreate already deleted Chrome nodes during recovery.
- [ ] Remote create/move/delete waits for a restored canonical parent path before local apply continues.
- [ ] Repeated local delete/move failures stop after bounded recovery and only then show degraded state.
