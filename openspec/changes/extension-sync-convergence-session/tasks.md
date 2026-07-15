# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Remaining authored lines (tests + artifact update included) | 1,650 |
| Per-unit budget / correction reserve | 270–380 / 20–70 |
| Delivery / chain | auto-forecast / stacked-to-main; target `develop` in order |
| Suggested chain | PR4a0 → PR4a1 → PR4a2 → PR4a3 → PR4b |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Progress: 28/38 — 28 completed legacy tasks in Phases 1–11; 10 newly expanded tasks are unchecked. No new implementation task is complete.

| Unit (estimate) | Start → end; exclusions | Focused RED/GREEN evidence; runtime evidence | Rollback boundary |
|---|---|---|---|
| PR4a0 backend no-op (270) | Existing routes → complete-shape update/move acknowledgement; no extension wiring | `cd backend && go test ./internal/sync ./internal/bookmarks`; replay same key/shape proves no event/cursor advance | backend no-op comparison/idempotency/tests |
| PR4a1 outbox (330) | PR4a0 → durable local capture, disabled remote update/move; no receipt consumption | `cd extension && npm run build && node --test tests/convergence.test.mjs`; fake-worker restart delivers one stable intent/no-op once | intent types/storage/listener capture/tests |
| PR4a2 receipts (340) | PR4a1 → dormant per-node receipt/last-ack state; no remote effect | `cd extension && npm run build && node --test tests/convergence.test.mjs`; fake callback proves one exact pending receipt only | receipt reducer/types/storage/tests |
| PR4a3 apply (380) | PR4a2 → gated remote update/move and verified cursor; no repair controls | `cd extension && npm run build && node --test tests/convergence.test.mjs`; fake Chrome early/delayed/reordered/restart matrix | update/move gate, reducer, listeners/tests |
| PR4b repair (330) | PR4a3 invariants green → enable repair/controls and remove destructive normal resync; no unrelated UX | `cd extension && npm run build && node --test tests/convergence.test.mjs`; scoped Retry/Rebuild and failed-cursor recovery | enablement/controls/resync path/tests |

## Completed legacy phases (preserved: 28/28)
- [x] 1.1–1.4 Refresh-family persistence/domain; RED, implementation, rollback evidence.
- [x] 2.1–2.3 Capability-gated auth endpoints; RED, wiring, evidence.
- [x] 3.1–3.3 Ticket issue/persistence; RED, migration/domain, evidence.
- [x] 4.1–4.2 Ticket-consuming WebSocket upgrade; RED and compatible wiring.
- [x] 5.1–5.3 Renewable REST session; RED, coordinator, Chromium evidence.
- [x] 6.1–6.3 Ticket WebSocket/TTL; RED, cutover, evidence.
- [x] 7.1–7.2 Dormant journal/planner; RED and gated checkpoints.
- [x] 8.1–8.2 Deterministic Chrome ownership harness.
- [x] 9.1–9.2 Harness fidelity hardening.
- [x] 10.1–10.2 Durable create ownership.
- [x] 11.1–11.2 Durable delete ownership.

## Phase 12: Backend contract — PR4a0
Candidate: `backend/internal/{bookmarks/service.go,sync/{service,postgres,handler}.go,sync/*_test.go}`, `tasks.md`.
- [ ] 12.1 RED: folder/bookmark title/url/parent/index complete-shape no-op; same idempotency key/shape acknowledges, different shape rejects; assert no event/cursor advance.
- [ ] 12.2 GREEN: compare canonical final shape before mutation/publish; retain idempotency header semantics; record focused/runtime evidence in this artifact.

## Phase 13: Intent foundation — PR4a1
Candidate: `extension/src/{shared/{types,storage,api}.ts,background/{bookmark-listeners,projection,convergence}.ts}`, `extension/tests/{convergence,helpers/fake-chrome}.test.mjs`, `tasks.md`.
- [ ] 13.1 RED: stable-ID, workspace-contained intent capture; two workspaces with equivalent Chrome-like IDs; capacity/read/final failure at cursor 0 plus later live envelope; unacknowledged intent never prunes.
- [ ] 13.2 GREEN: bounded persisted outbox, restart and exact-once/no-op delivery; keep remote update/move disabled and record evidence.

## Phase 14: Receipt foundation — PR4a2
Candidate: Phase 13 extension paths and `tasks.md`.
- [ ] 14.1 RED: durable per-node serialized receipt/last-ack shape; title-only or URL-only callback with hidden full-node mismatch queues; exact duplicate before/after consumption; pending receipt plus queued intent restart.
- [ ] 14.2 GREEN: add versioned receipt reducer and complete-node proof gate, dormant from remote effects; record evidence.

## Phase 15: Remote update/move — PR4a3
Candidate: Phase 13 extension paths and `tasks.md`.
- [ ] 15.1 RED: partial full-node proof and move old/new tuple; callbacks early/delayed/reordered/restart; immediate local action after consumption, return to older title/URL, repeated old move, and two sequential node transitions queue correctly.
- [ ] 15.2 GREEN: receipt+outbox application verifies before checkpoint; replay `currentCursor` cannot pass failure; post-consumption routing has no timers/suppression; record evidence.

## Phase 16: Repair enablement — PR4b
Candidate: `extension/src/{background/{projection,convergence}.ts,shared/{types,storage}.ts,ui/**}`, `extension/tests/convergence.test.mjs`, `tasks.md`.
- [ ] 16.1 RED: invariant gate, scoped diagnostics/retry/rebuild, and cursor-0 failure blocks later live/replay effect/advance; preserve create/delete behavior.
- [ ] 16.2 GREEN: enable repair only after matrix passes; remove destructive normal resync; retain failed cursor/outbox and record evidence.
