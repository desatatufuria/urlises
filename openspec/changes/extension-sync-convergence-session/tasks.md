# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Remaining authored lines (tests + artifact update included) | 2,970–3,300 |
| Per-unit budget / correction reserve | 180–200 / 200–220 (PR4a0a, complete); 180–240 / >=100 (PR4a0a2); 220 / 150 (PR4a0a3a.1); 315 / 85 (.2a); 230 / 170 (.2b); 245 / 155 (.2c); 220–300 / >=100 (PR4a0a3b); 250–300 / 100–150 (PR4a0b); 330–380 / 20–70 thereafter |
| Delivery / chain | auto-chain / stacked-to-main; target `develop` in order |
| Suggested chain | PR4a0a → PR4a0a2 → PR4a0a3a.1 → PR4a0a3a.2a → PR4a0a3a.2b → PR4a0a3a.2c → PR4a0a3b → PR4a0b → PR4a1 → PR4a2 → PR4a3 → PR4b |
| Current .2 subchain | 790 authored lines total against the 800-line review budget; each autonomous slice is <=400 (315 / 230 / 245) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Progress: 34/52 semantic tasks complete. Native checklist progress is 17/35: legacy grouped checkboxes represent multiple semantic tasks; replacing two unchecked native items with six separate .2a/.2b/.2c RED/GREEN items adds four unchecked semantic and native denominator entries only.

| Unit (estimate / reserve) | Start → end; exclusions | Candidate files; RED matrix; commands/runtime evidence | Rollback boundary |
|---|---|---|---|
| PR4a0a ledger foundation (180–200 / 200–220) | 201-only ledger → generic 200/201 receipt/replay; exclude PATCH routing, events, extension | `backend/migrations/000008_sync_patch_idempotency.sql`, `backend/internal/httpapi/{idempotency.go,idempotency_test.go,idempotency_integration_test.go}`. RED: 200 replay, canonical conflict, stable headers/nullable fixed ack, concurrent writers, crash/replay, 201 create. `cd backend && go test ./internal/httpapi ./internal/sync`; PostgreSQL harness replays after a later workspace event. | Migration + generic receipt executor/store/tests; expire 200 records before restoring old constraint. |
| PR4a0a2 executor foundation (180–240 / >=100) | PR4a0a → unused `httpapi` prepared executor; exclude sync, bookmarks, routes, publisher invocation, migration | `backend/internal/httpapi/{idempotency.go,idempotency_test.go,idempotency_integration_test.go}`. RED: same tx; prepare/auth before receipt lookup; replay/conflict/in-progress; atomic rollback; returned/not-invoked post-commit; 201 `Execute` compatibility. `cd backend && go test ./internal/httpapi`; PostgreSQL executor scenario. | Remove only prepared executor, private receipt primitives, and tests; retain PR4a0a ledger and legacy `Execute`. |
| PR4a0a3a.1 scope-lock/revalidation kernel (220 / 150) | PR4a0a2 → shared PostgreSQL kernel; exclude prepared adapters, resource/order/event/cursor mutation, routes, publisher, HTTP idempotency, migration | `backend/internal/sync/{postgres.go,postgres_integration_test.go}`. RED: opposite/same-scope blocking, no deadlock, drift/retry, no post-row-lock scope acquisition, zero writes. `cd backend && go test ./internal/sync`; deterministic PostgreSQL `postgres:5432` harness. | Kernel/helpers/tests only. |
| PR4a0a3a.2a kernel relocation (315 / 85) | `.1` (`08ffff8`) → private `bookmarks` kernel; exclude patches/apply/routes/events/cursors/publisher/HTTP/migration | Move `sync/{postgres.go,postgres_integration_test.go}` kernel/proof to `bookmarks/{prepare.go,service_integration_test.go}`. RED `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`; real isolated-schema PostgreSQL at `postgres:5432` proves contention, dedupe, drift, no late lock, zero writes. | Revert relocated kernel/proof only; no lower package imports `syncapi`. |
| PR4a0a3a.2b folder prepare (230 / 170) | `.2a` → `PrepareFolderPatchTx`; exclude bookmark adapter/apply/routes/events/cursors/publisher/HTTP/migration | `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}`. RED `cd backend && go test ./internal/bookmarks -run '^TestPrepareFolderPatchTx' -count=1`; real PostgreSQL `postgres:5432` proves tx, locks, normalized full patch/fingerprint/no-op and zero writes. | Revert folder API/helpers/tests; kernel remains; no `syncapi` import. |
| PR4a0a3a.2c bookmark prepare (245 / 155) | `.2a` → `PrepareBookmarkPatchTx`; stacked after `.2b`, semantically independent; exclude folder changes/apply/routes/events/cursors/publisher/HTTP/migration | `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}`. RED `cd backend && go test ./internal/bookmarks -run '^TestPrepareBookmarkPatchTx' -count=1`; real PostgreSQL `postgres:5432` proves tx, containment, normalized full patch/fingerprint/no-op and zero writes. | Revert bookmark API/helpers/tests; `.2a/.2b` remain; no `syncapi` import. |
| PR4a0a3b apply foundation (220–300 / >=100) | `.2c` → unused same-tx prepared apply; exclude prepare/lock changes, routes, HTTP idempotency, migration, publisher invocation | `backend/internal/bookmarks/{service.go,service_integration_test.go}`, `backend/internal/sync/{types.go,service.go,postgres.go,postgres_integration_test.go}`. RED: zero-write no-op, exact prepared mutation/one event-cursor, rollback, legacy compatibility. `cd backend && go test ./internal/bookmarks ./internal/sync`; PostgreSQL transaction harness. | Remove only apply API/tests; retain unused prepare foundation and legacy `Update*`. |
| PR4a0b complete-shape integration (250–300 / 100–150) | PR4a0a2 + PR4a0a3a + PR4a0a3b → folder/bookmark route wiring and post-commit invocation; exclude extension | `backend/internal/sync/{types,service,postgres,bookmark_routes,headers}.go`, `backend/internal/sync/{bookmark_routes_test.go,postgres_integration_test.go}`. RED: partial composition, replay/conflict, later-event-stable ack, no event/cursor advance, real mutation one event/cursor with auth/base-cursor/containment. `cd backend && go test ./internal/sync ./internal/bookmarks`; HTTP/PostgreSQL route harness proves no-op and mutation. | PATCH route wiring/tests; revert to unused prepared foundations, no route event semantics. |
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

## Phase 13a: Executor foundation — PR4a0a2
- [x] 13a.1 RED: in `backend/internal/httpapi/idempotency_{test,integration_test}.go`, prove same executor tx; prepare/auth before receipt lookup; replay/conflict/in-progress; atomic rollback; returned but never invoked post-commit; and existing-201 `Execute` compatibility via PostgreSQL.
- [x] 13a.2 GREEN: in `backend/internal/httpapi/idempotency.go`, add only `IdempotencyScope`, `Prepared`, `Prepare`, `Command`, `PostCommit`, `ExecutePrepared`, private shared receipt primitives, and an `Execute` adapter; prepare is read/lock/auth only, command is transactional, no sync/bookmarks/routes/publisher/migration.

## Phase 13b: Prepare foundation — PR4a0a3a.1 → PR4a0a3a.2a/.2b/.2c
- [x] 13b.1 RED (PR4a0a3a.1): in `backend/internal/sync/postgres_integration_test.go`, fail for opposite/same-scope moves until `prepareScopeKeys`, scope locks, locked revalidation, retryable drift refusal, and no-post-row-lock scope acquisition exist; assert zero resource/order/event/cursor writes. Run `cd backend && go test ./internal/sync`; use deterministic PostgreSQL `postgres:5432`; rollback: kernel RED tests only.
- [x] 13b.2 GREEN (PR4a0a3a.1): in `backend/internal/sync/postgres.go`, add sorted/deduplicated scope advisory locking before target/sibling `FOR UPDATE`, locked scope rederivation, and bounded whole-tx retryable drift refusal; never acquire scopes after row locks. Run the same command/harness; rollback: kernel/helpers/tests only.
- [ ] 13b.3a RED (PR4a0a3a.2a, native): move `TestPrepareScopesTxSerializesAndRefusesDrift` to `backend/internal/bookmarks/service_integration_test.go`; fail until relocated private kernel preserves opposite/same-scope blocking, dedupe, drift, no late scope lock, and zero writes. Run `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`; real isolated-schema PostgreSQL `postgres:5432`; rollback: moved RED proof only.
- [ ] 13b.3b GREEN (PR4a0a3a.2a, native): relocate `siblingScopeKey`, `prepareScopesTx`, sorting/locking, drift classifier, and proof from `backend/internal/sync/{postgres.go,postgres_integration_test.go}` to `backend/internal/bookmarks/{prepare.go,service_integration_test.go}`; preserve caller-owned `pgx.Tx`, acyclic imports, and zero writes. GREEN: same command/harness passes; rollback: relocation only; exclude all adapters/apply/routing/events/cursors/publisher/HTTP/migration.
- [ ] 13b.3c RED (PR4a0a3a.2b, native): in `backend/internal/bookmarks/service_integration_test.go`, fail `PrepareFolderPatchTx` for caller `pgx.Tx`, locked role/parent/ancestry, trim/clamp/full `Folder`, fingerprint/no-op, zero writes, and unchanged `UpdateFolderTx`. Run `cd backend && go test ./internal/bookmarks -run '^TestPrepareFolderPatchTx' -count=1`; real PostgreSQL `postgres:5432`; rollback: folder RED tests only.
- [ ] 13b.3d GREEN (PR4a0a3a.2b, native): in `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}`, add immutable `PreparedFolderPatch` and read-only `PrepareFolderPatchTx` on `.2a`; GREEN: same command/harness passes with zero writes. Rollback: folder API/helpers/tests; exclude bookmark/apply/routes/events/cursors/publisher/HTTP/migration and any `syncapi` import.
- [ ] 13b.3e RED (PR4a0a3a.2c, native): in `backend/internal/bookmarks/service_integration_test.go`, fail `PrepareBookmarkPatchTx` for caller `pgx.Tx`, locked role/folder containment, trimmed title/URL validation, clamped position/full `Bookmark`, fingerprint/no-op, zero writes, and unchanged `UpdateBookmarkTx`. Run `cd backend && go test ./internal/bookmarks -run '^TestPrepareBookmarkPatchTx' -count=1`; real PostgreSQL `postgres:5432`; rollback: bookmark RED tests only.
- [ ] 13b.3f GREEN (PR4a0a3a.2c, native): in `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}`, add immutable `PreparedBookmarkPatch` and read-only `PrepareBookmarkPatchTx` on `.2a`, stacked after `.2b` but independent of it. GREEN: same command/harness passes with zero writes; rollback: bookmark API/helpers/tests; exclude folder/apply/routes/events/cursors/publisher/HTTP/migration and any `syncapi` import.

## Phase 13c: Apply foundation — PR4a0a3b (after PR4a0a3a.2c)
- [ ] 13c.1 RED: in `backend/internal/{bookmarks/service_integration_test.go,sync/postgres_integration_test.go}`, prove same-tx prepared apply: no-op has zero writes; mutation writes exact prepared resource/order and one event/cursor; publisher data is returned, not invoked; rollback removes all; legacy `Update*` remains compatible. Run `cd backend && go test ./internal/bookmarks ./internal/sync`; rollback: remove only these RED tests.
- [ ] 13c.2 GREEN: in `backend/internal/bookmarks/service.go` and `backend/internal/sync/{types.go,service.go,postgres.go}`, add `ApplyPreparedFolderPatchTx`/`ApplyPreparedBookmarkPatchTx` consuming the same prepared state/tx and returning uninvoked publisher data; make no prepare/lock changes and add no routes, HTTP idempotency, or migration. Run the same command; rollback: remove only apply API/tests, retaining prepare and legacy `Update*`.

## Phase 14: Complete-shape integration — PR4a0b
- [ ] 14.1 RED: after PR4a0a2 + PR4a0a3a.2c + PR4a0a3b, prove partial shape, replay/conflict, stable ack, no advance, and real mutation regression.
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
