# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Remaining lines | 810–860 (PR4a3: 272 + 208; PR4b: 330–380) |
| 400-line budget risk | High; units <=400 |
| Suggested chain | PR4a3.1 update → PR4a3.2 move → PR4b, stacked to `develop` |
| Delivery / chain | auto-chain / stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Progress: 55/55 semantic tasks complete; 18/18 checked task blocks cover 38/38 native subtasks. PR4b repair enablement is complete.

| Unit | Goal | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|
| PR4a3.1 (272 / 128 reserve) | Verified update only; move stays intent-queued. | `cd extension && npm run build && node --test tests/convergence.test.mjs` | `cd extension && npm run test:projection` (deterministic harness) | `convergence.ts`, `projection.ts`, `types.ts`, convergence/projection tests, 17.1 marks. |
| PR4a3.2 (208 / 192 reserve) | Verified move; builds on update unchanged. | `cd extension && npm run build && node --test tests/convergence.test.mjs` | `cd extension && npm run test:projection` (deterministic harness) | Move-only same-file/test changes and 17.2 marks; update remains correct. |
| PR4b (330–380 / 20–70 reserve) | Matrix-gated repair, diagnostics, Retry/Rebuild; no destructive resync. | `cd extension && npm run build && node --test tests/convergence.test.mjs` | `cd extension && npm run test:projection` (deterministic harness) | Repair/diagnostic paths, tests, and 18 marks only. |

## Completed history (49 semantic / 32 native)
- [x] 1.1–1.4 Refresh-family persistence/domain; RED, GREEN, rollback evidence.
- [x] 2.1–2.3 Auth endpoints; 3.1–3.3 ticket issue/persistence; 4.1–4.2 WebSocket upgrade.
- [x] 5.1–5.3 REST renewal; 6.1–6.3 ticket WebSocket/TTL.
- [x] 7.1–7.2 journal/planner; 8.1–8.2 harness; 9.1–9.2 fidelity.
- [x] 10.1–10.2 create ownership; 11.1–11.2 delete ownership.
- [x] 12.1 RED and 12.2 GREEN receipt ledger.
- [x] 13a.1 RED and 13a.2 GREEN prepared executor.
- [x] 13b.1–13b.3g scope-lock, copy/close, folder/bookmark preparation.
- [x] 13c.1 RED and 13c.2 GREEN prepared apply.
- [x] 14.1 folder and 14.2 bookmark complete PATCH verticals.
- [x] 15.1 RED and 15.2 GREEN durable local-intent outbox.
- [x] 16.1 RED and 16.2 GREEN dormant versioned receipt reducer.

## Phase 17: Remote update/move — split PR4a3
- [x] 17.1a RED (PR4a3.1): in `extension/tests/{convergence,projection-behavior}.test.mjs`, fail for update complete-node/ack proof; hidden mismatch, duplicate/reorder, restart, and local reversion queue intent without effect/checkpoint.
- [x] 17.1b GREEN (PR4a3.1): in `extension/src/{shared/types.ts,background/convergence.ts,background/projection.ts}`, persist one pending update receipt before Chrome effect; consume only its exact callback, verify predecessor/final shape, then checkpoint; leave moves intent-queued.
- [x] 17.2a RED (PR4a3.2): in `extension/tests/{convergence,projection-behavior}.test.mjs`, fail for exact move old/new parent/index and workspace proof, sequence/restart ordering, duplicate/reorder, and reversion intent queueing.
- [x] 17.2b GREEN (PR4a3.2): extend the same files to persist and verify one move receipt, apply only after exact tuple/containment proof, checkpoint after verification, and queue every nonmatching callback as intent.

## Phase 18: Repair enablement — PR4b
- [x] 18.1 RED: in `extension/tests/{convergence,projection-behavior}.test.mjs`, fail for capacity/write/read/verification/promise/ambiguity pause, failed-cursor blocking, workspace-scoped diagnostics, Retry/Rebuild, and disabled destructive normal resync.
- [x] 18.2 GREEN: in `extension/src/background/{convergence.ts,projection.ts}`, add matrix-gated repair and secret-free diagnostics; pause only the affected workspace, retain intents, and never advance or destructively resync after a failed gate.
