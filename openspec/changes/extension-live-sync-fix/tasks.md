# Tasks: Extension Live Sync Fix

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 420-560 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 -> PR 2 -> PR 3 |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Add projection health state and stop forced resync bootstrap | PR 1 | Extension runtime base slice; verify state persistence and reconnect entrypoints. |
| 2 | Add replay-first recovery, duplicate-safe remote apply, and degraded UI | PR 2 | Depends on PR 1; keep backend untouched unless current WS/replay contract proves insufficient. |
| 3 | Lock behavior with tests, manual validation notes, and docs | PR 3 | Depends on PR 2; include Gitflow/documentation updates for the remediation. |

## Phase 1: Runtime Foundation

- [x] 1.1 Update `extension/src/shared/types.ts` to add projection health fields (`health`, recovery counters, degraded reason/timestamps) without widening scope beyond live sync.
- [x] 1.2 Update `extension/src/shared/storage.ts` so `createProjectionState()` and state defaults persist the new health metadata safely.
- [x] 1.3 Refactor `extension/src/background/projection.ts` startup flow so bootstrap happens once and `connectWorkspace()` no longer forces full resync when `lastCursor` is trusted.

## Phase 2: Live Recovery and Remote Apply

- [x] 2.1 Update `extension/src/shared/websocket.ts` and `extension/src/background/projection.ts` to expose consistent ack/close/error lifecycle signals for bounded silent recovery.
- [x] 2.2 Implement replay-first recovery in `extension/src/background/projection.ts`: `live -> recovering -> live`, using full resync only for replay gaps, stale mapping repair, or repeated apply failure.
- [x] 2.3 Add duplicate-safe reconciliation in `extension/src/background/projection.ts` and `extension/src/shared/projection-helpers.ts` before any remote create/rebuild path for folders or bookmarks.
- [x] 2.4 Keep fallback behavior narrow in `extension/src/background/projection.ts`: degrade only after the bounded silent recovery budget is exhausted, not on the first disconnect.

## Phase 3: User Signal and Documentation

- [x] 3.1 Update `extension/src/options/options.ts` to show a visible degraded indicator only for `degraded` health and keep healthy live sync quiet.
- [x] 3.2 Document the live-sync runtime contract and fallback boundaries in `README.md`, including the extension-first/Gitflow remediation intent.
- [x] 3.3 Update `docs/roadmap.md` with the live-sync remediation scope, bounded recovery behavior, and backend-change guardrail.

## Phase 4: Tests and Manual Validation

- [x] 4.1 Extend `extension/tests/projection-behavior.test.mjs` for ack-to-replay sequencing, contiguous reconnect recovery, replay-gap resync fallback, and degraded-threshold behavior.
- [x] 4.2 Extend `extension/tests/storage-serialization.test.mjs` to verify new projection health fields persist and reload correctly.
- [x] 4.3 Add a manual validation checklist in `openspec/changes/extension-live-sync-fix/tasks.md` notes or adjacent implementation notes: remote change appears within seconds, silent recovery stays invisible, degraded UI appears only after bounded failure, and no duplicate Chrome nodes are created.

## Manual Validation Checklist

- [x] Remote shared folder/bookmark changes appear in Chrome within a few seconds without manual reload or manual resync.
- [ ] Brief websocket interruptions recover silently through reconnect/replay without showing a degraded message.
- [ ] The degraded indicator appears only after repeated silent recovery failure exhausts the bounded retry budget.
- [ ] Stale or missing mappings reuse the existing canonical Chrome node under the expected parent instead of creating duplicates.

Partial Chromium validation is complete: remote folder create, remote bookmark create, websocket delivery, and replay behavior were exercised successfully on the current branch. Interruption-specific recovery, degraded-threshold behavior, and duplicate-prevention repro coverage remain pending.
