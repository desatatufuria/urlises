# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Remaining authored lines (tests + artifact update included) | 1,740–1,770 |
| Per-unit budget / correction reserve | 180–200 / 200–220 (PR4a0a); 180–190 / 210–220 (PR4a0b); 270–380 / 20–70 thereafter |
| Delivery / chain | auto-forecast / stacked-to-main; target `develop` in order |
| Suggested chain | PR4a0a → PR4a0b → PR4a1 → PR4a2 → PR4a3 → PR4b |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Progress: 30/40 — 28 completed legacy tasks and PR4a0a are complete; native checklist progress is 13/23. Ten redesigned tasks remain.

| Unit (estimate / reserve) | Start → end; exclusions | Candidate files; RED matrix; commands/runtime evidence | Rollback boundary |
|---|---|---|---|
| PR4a0a ledger foundation (180–200 / 200–220) | 201-only ledger → generic 200/201 receipt/replay; exclude PATCH routing, events, extension | `backend/migrations/000008_sync_patch_idempotency.sql`, `backend/internal/httpapi/{idempotency,idempotency_test}.go`, `backend/internal/sync/{postgres,postgres_test}.go`. RED: 200 replay, canonical conflict, stable headers/nullable fixed ack, concurrent writers, crash/replay, 201 create. `cd backend && go test ./internal/httpapi ./internal/sync`; PostgreSQL harness replays after a later workspace event. | Migration + generic receipt executor/store/tests; expire 200 records before restoring old constraint. |
| PR4a0b complete-shape integration (180–190 / 210–220) | PR4a0a → folder/bookmark PATCH transaction; exclude extension | `backend/internal/sync/{types,headers,service,postgres,bookmark_routes}.go`, `{bookmark_routes,postgres}_test.go`. RED: partial composition, replay/conflict, later-event-stable ack, no event/cursor advance, real mutation one event/cursor with auth/base-cursor/containment. `cd backend && go test ./internal/sync ./internal/bookmarks`; HTTP/PostgreSQL harness proves no-op and mutation. | PATCH composition/routes/tests; revert to generalized ledger, no event semantics. |
| PR4a1 outbox (330 / 70) | PR4a0b → capture; no consumption | extension outbox paths; `cd extension && npm run build && node --test tests/convergence.test.mjs`; restart harness. | intent capture/tests |
| PR4a2 receipts (340 / 60) | PR4a1 → dormant receipts; no effects | PR4a1 paths; same command; callback harness. | receipt reducer/tests |
| PR4a3 apply (380 / 20) | PR4a2 → gated update/move; no repair | PR4a1 paths; same command; ordering/restart harness. | application/tests |
| PR4b repair (330 / 70) | PR4a3 → repair; no UX outside scope | repair paths; same command; Retry/Rebuild harness. | repair/tests |

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

## Phase 12: Ledger foundation — PR4a0a
- [x] 12.1 RED: safe 200+201 receipt/replay, conflict, stable cursor/headers, race/crash, and 201-create tests.
- [x] 12.2 GREEN: generalize ledger transaction; no PATCH routing/events; record rollback/evidence.

## Phase 13: Complete-shape integration — PR4a0b
- [ ] 13.1 RED: partial shape, replay/conflict, stable ack, no advance, and real-mutation regression.
- [ ] 13.2 GREEN: ledger-routed update/move retains auth/base-cursor/containment and one event/cursor.

## Phase 14: Intent foundation — PR4a1
- [ ] 14.1 RED: contained stable-ID capture, cursor-0 failure, and unpruned intent.
- [ ] 14.2 GREEN: bounded restart-safe outbox; remote update/move stays disabled.

## Phase 15: Receipt foundation — PR4a2
- [ ] 15.1 RED: receipt shape, hidden mismatch, duplicates, and restart intent.
- [ ] 15.2 GREEN: dormant versioned reducer and complete-node proof gate.

## Phase 16: Remote update/move — PR4a3
- [ ] 16.1 RED: complete proof/move tuple and ordering/restart/local-action cases.
- [ ] 16.2 GREEN: verified application/checkpointing without suppression.

## Phase 17: Repair enablement — PR4b
- [ ] 17.1 RED: invariant gate, diagnostics/retry/rebuild, failed-cursor blocking.
- [ ] 17.2 GREEN: matrix-gated repair; remove destructive normal resync.
