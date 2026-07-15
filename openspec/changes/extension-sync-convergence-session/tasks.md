# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Remaining authored lines (tests + artifact update included) | 1,930–2,020 |
| Per-unit budget / correction reserve | 180–200 / 200–220 (PR4a0a, complete); 300–340 / 60–100 (PR4a0a2); 250–300 / 100–150 (PR4a0b); 330–380 / 20–70 thereafter |
| Delivery / chain | auto-forecast / stacked-to-main; target `develop` in order |
| Suggested chain | PR4a0a → PR4a0a2 → PR4a0b → PR4a1 → PR4a2 → PR4a3 → PR4b |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Progress: 30/42 semantic tasks complete — PR4a0a was complete at 30/40 before this two-task expansion; 12 redesigned tasks remain. Native checklist progress is 13/25 because legacy grouped checkboxes represent multiple semantic tasks.

| Unit (estimate / reserve) | Start → end; exclusions | Candidate files; RED matrix; commands/runtime evidence | Rollback boundary |
|---|---|---|---|
| PR4a0a ledger foundation (180–200 / 200–220) | 201-only ledger → generic 200/201 receipt/replay; exclude PATCH routing, events, extension | `backend/migrations/000008_sync_patch_idempotency.sql`, `backend/internal/httpapi/{idempotency,idempotency_test}.go`, `backend/internal/sync/{postgres,postgres_test}.go`. RED: 200 replay, canonical conflict, stable headers/nullable fixed ack, concurrent writers, crash/replay, 201 create. `cd backend && go test ./internal/httpapi ./internal/sync`; PostgreSQL harness replays after a later workspace event. | Migration + generic receipt executor/store/tests; expire 200 records before restoring old constraint. |
| PR4a0a2 prepared transaction foundation (300–340 / 60–100) | PR4a0a → unused executor-owned prepared PATCH seam; exclude migration, routes, extension, publishing invocation | `backend/internal/httpapi/{idempotency.go,idempotency_integration_test.go}`, `backend/internal/bookmarks/{service.go,service_test.go}`, `backend/internal/sync/{types.go,service.go,postgres.go,postgres_test.go}`; `openspec/changes/extension-sync-convergence-session/{tasks.md,apply-progress.md}` only when applied. `cd backend && go test ./internal/httpapi ./internal/bookmarks ./internal/sync`; PostgreSQL opposite-move harness. | Remove unused prepared executor/seam/helpers/tests; leave PR4a0a ledger and legacy routes unchanged. |
| PR4a0b complete-shape integration (250–300 / 100–150) | PR4a0a2 → folder/bookmark route wiring and post-commit invocation; exclude extension | `backend/internal/sync/{types,service,postgres,bookmark_routes,headers}.go`, `{bookmark_routes,postgres}_test.go`. RED: partial composition, replay/conflict, later-event-stable ack, no event/cursor advance, real mutation one event/cursor with auth/base-cursor/containment. `cd backend && go test ./internal/sync ./internal/bookmarks`; HTTP/PostgreSQL route harness proves no-op and mutation. | PATCH route wiring/tests; revert to unused prepared foundation, no route event semantics. |
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

## Phase 13: Prepared transaction foundation — PR4a0a2
- [ ] 13.1 RED: prove executor-owned tx identity; prepare-before-receipt authorization; no prepare mutation; rollback atomicity; first-writer/in-progress; `Execute` 201 compatibility; sorted opposing-move locks/no deadlock; external-`pgx.Tx` seam; and no route behavior.
- [ ] 13.2 GREEN: add `ExecutePrepared` with an `Execute` adapter; prepare only reads/locks/authorizes/contains/normalizes, never mutates/publishes, and returns fingerprint plus command; add external-`pgx.Tx` sync/bookmark prepare/apply seam with receipt scope→target `FOR UPDATE`→auth/containment→sorted sibling advisory→sibling rows `FOR UPDATE`→normalize/fingerprint locks; command returns result/post-commit publisher only for a mutation after commit, with no route invocation; prohibit nested `runMutation`/`PostgresStore.Update*`.

## Phase 14: Complete-shape integration — PR4a0b
- [ ] 14.1 RED: partial shape, replay/conflict, stable ack, no advance, and real-mutation regression.
- [ ] 14.2 GREEN: ledger-routed update/move retains auth/base-cursor/containment and one event/cursor.

## Phase 15: Intent foundation — PR4a1
- [ ] 15.1 RED: contained stable-ID capture, cursor-0 failure, and unpruned intent.
- [ ] 15.2 GREEN: bounded restart-safe outbox; remote update/move stays disabled.

## Phase 16: Receipt foundation — PR4a2
- [ ] 16.1 RED: receipt shape, hidden mismatch, duplicates, and restart intent.
- [ ] 16.2 GREEN: dormant versioned reducer and complete-node proof gate.

## Phase 17: Remote update/move — PR4a3
- [ ] 17.1 RED: complete proof/move tuple and ordering/restart/local-action cases.
- [ ] 17.2 GREEN: verified application/checkpointing without suppression.

## Phase 18: Repair enablement — PR4b
- [ ] 18.1 RED: invariant gate, diagnostics/retry/rebuild, failed-cursor blocking.
- [ ] 18.2 GREEN: matrix-gated repair; remove destructive normal resync.
