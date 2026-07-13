# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated authored changed lines | 2,910–3,740 |
| 400-line budget risk | High |
| Delivery / chain | auto-forecast / stacked-to-main; each unit merges to `develop` before the next starts |
| Units | PR1a → PR1b-auth → PR1b-ticket → PR1b-ws-upgrade → PR2a → PR2b → PR3 → PR4a1a 300–400 → PR4a1b 250–350 → PR4a2 300–400 → PR4b 350–400 |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Progress: 20/28. PR4a has no implementation or test changes; PR4a1 is split before apply.

```text
develop ← PR1a ← PR1b-auth ← PR1b-ticket ← PR1b-ws-upgrade ← PR2a REST ← PR2b WS/TTL ← PR3 journal ← PR4a1a create/delete ← PR4a1b update/move ← PR4a2 outbox ← PR4b repair
```

| Unit | Start → end; out of scope | Focused test; runtime harness | Rollback boundary |
|---|---|---|---|
| PR1a–PR2b | Completed session work. | Recorded in completed evidence. | Completed-unit boundaries. |
| PR3 | Completed dormant journal; legacy projection unchanged. | `cd extension && npm test -- convergence`; fake-storage restart. | Journal/module/types/gate. |
| PR4a1a | PR3 → durable create/delete ownership; no update/move/outbox/controls. | `cd extension && npm test -- convergence`; fake Chrome create/delete reorder/crash. | Create/delete ownership and gated wiring. |
| PR4a1b | PR4a1a → durable update/move ownership; no outbox/controls. | `cd extension && npm test -- convergence`; fake Chrome update/move reorder/restart. | Update/move ownership and gated wiring. |
| PR4a2 | PR4a1b → durable local-intent outbox/replay; no controls or destructive-resync removal. | `cd extension && npm test -- convergence`; fake Chrome repair/auth/restart. | Outbox/replay wiring and gated engine. |
| PR4b | PR4a2 → repair controls/enablement; no unrelated bookmarks. | `cd extension && npm test -- convergence`; Chromium Retry/Rebuild. | Controls, enablement, destructive-normal-resync removal. |

## Phase 1: PR1a — Refresh-family persistence/domain (complete)
- [x] 1.1 RED: hash-only rotation and response-loss.
- [x] 1.2 RED: reuse, revocation, and secret safety.
- [x] 1.3 Add persistence/domain only.
- [x] 1.4 Record DB and rollback evidence.

## Phase 2: PR1b-auth — Capability-gated auth endpoints (complete)
- [x] 2.1 RED: capability and refresh/logout errors.
- [x] 2.2 Wire endpoints; exclude WebSocket work.
- [x] 2.3 Record auth and rollback evidence.

## Phase 3: PR1b-ticket — Ticket issue and persistence (complete)
- [x] 3.1 RED: expiry, one-use, binding, and secrecy.
- [x] 3.2 Add `000007`, domain, and issue endpoint.
- [x] 3.3 Record DB and rollback evidence.

## Phase 4: PR1b-ws-upgrade — Ticket-consuming upgrade (complete)
- [x] 4.1 RED: protocol, authorization, legacy, and secrecy.
- [x] 4.2 Wire handler; preserve legacy path.

## Phase 5: PR2a — Extension renewable REST session (complete)
- [x] 5.1 RED: private session, refresh/replay, restart/pause.
- [x] 5.2 Implement REST coordinator and wiring.
- [x] 5.3 Record Chromium and rollback evidence.

## Phase 6: PR2b — Extension ticket WebSocket and TTL cutover (complete)
- [x] 6.1 RED: ticket transport, reconnect, pause, secrecy.
- [x] 6.2 Wire cutover and 15m TTL; retain legacy route.
- [x] 6.3 Record Chromium and rollback evidence.

## Phase 7: PR3 — Dormant convergence planner/journal (complete)
- [x] 7.1 RED: planner, queue, cap, migration, ambiguity.
- [x] 7.2 Add gated journal/checkpoints and evidence.

## Phase 8: PR4a1a — Durable create/delete ownership

Candidate paths: `extension/src/background/{projection,bookmark-listeners,convergence}.ts`, `extension/src/shared/{types,storage}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 8.1 RED: fake Chrome bus emits created/removed before mutator resolution and delayed, duplicate, reordered callbacks; prove reload after effect/before checkpoint, workspace isolation, and remote create/delete never mutates the backend.
- [ ] 8.2 Add journal ownership helpers; persist `started` before remote folder/bookmark create/delete, verify final tree before done/pause, and correlate `onCreated`/`onRemoved` by workspace/backend/Chrome/shape. Keep unmatched-local legacy flow and in-memory fallback for update/move and destructive resync.

## Phase 9: PR4a1b — Durable update/move ownership

Candidate paths: `extension/src/background/{projection,bookmark-listeners,convergence}.ts`, `extension/src/shared/{types,storage,api}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 9.1 RED: fake Chrome bus emits changed/moved before resolution and delayed, duplicate, reordered callbacks; prove final parent/index/title/url verification, restart, and workspace isolation.
- [ ] 9.2 Persist `started` before remote folder/bookmark update/move; correlate `onChanged`/`onMoved`, replace covered process-local pending operations after final verification, and keep planner/engine gated without an outbox.

## Phase 10: PR4a2 — Durable local intent outbox and exact-once replay

Candidate paths: `extension/src/background/{projection,bookmark-listeners,convergence}.ts`, `extension/src/shared/{types,storage,api}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 10.1 RED: local edits during repair, auth pause, and restart retain stable IDs; prove one replay/request, ack checkpoint, cap, and workspace isolation.
- [ ] 10.2 Queue unmatched local events during active repair; replay through existing idempotency headers once after convergence and resume after auth/restart, retaining the off gate and excluding Retry/Rebuild UI.

## Phase 11: PR4b — Repair controls and enablement

Candidate paths: `extension/src/background/{projection,convergence}.ts`, `extension/src/{shared,ui}/**`, `extension/tests/convergence.test.mjs`.

- [ ] 11.1 RED: ambiguous duplicates pause; bounded three-attempt recovery, scoped Retry/Rebuild, auth-checkpoint resume, and no destructive normal resync.
- [ ] 11.2 Add controls/backoff/auth resume; remove destructive normal resync and enable only after invariants/evidence pass.
