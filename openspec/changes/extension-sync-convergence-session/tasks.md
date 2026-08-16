# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Remaining planned lines (tests + artifacts included) | 3,294–3,674; PR4a0b is 513 (282 + 231) |
| Per-unit budget / correction reserve | 180–200 / 200–220 (PR4a0a, complete); 180–240 / >=100 (PR4a0a2); 220 / 150 (.1); 215 / 185 (.2a.1); 211 / 189 (.2a.2); 230 / 170 (.2b); 245 / 155 (.2c); 220–300 / >=100 (.3b); 282 / 25 (.0b.1); 231 / 25 (.0b.2); 330–380 / 20–70 thereafter |
| Delivery / chain | auto-chain / stacked-to-main; target `develop` in order |
| Suggested chain | PR4a0a → PR4a0a2 → PR4a0a3a.1 → PR4a0a3a.2a.1 → PR4a0a3a.2a.2 → PR4a0a3a.2b → PR4a0a3a.2c → PR4a0a3b → PR4a0b.1 → PR4a0b.2 → PR4a1 → PR4a2 → PR4a3 → PR4b |
| Current `.2` subchain | 901 authored lines (215+211+230+245), 101 above the cached 800-line reviewer budget; each autonomous stacked slice is <=400. |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

The maintainer approved the `.2` aggregate reviewer-budget increase from 800 to 901 lines; this is not a `size:exception`; every slice remains <=400; delivery remains auto-chain/stacked-to-main.

Progress: 45/53 semantic tasks complete. Native checklist progress is 28/36. PR4a0b.1 folder PATCH vertical is complete.

| Unit (estimate / reserve) | Start → end; exclusions | Candidate files; evidence | Rollback boundary |
|---|---|---|---|
| PR4a0a ledger foundation (180–200 / 200–220) | 201-only ledger → generic 200/201 receipt/replay; exclude PATCH routing, events, extension | `backend/migrations/000008_sync_patch_idempotency.sql`, `backend/internal/httpapi/{idempotency.go,idempotency_test.go,idempotency_integration_test.go}`. RED: 200 replay, conflict, stable headers/ack, races/crash, 201 create. `cd backend && go test ./internal/httpapi ./internal/sync`; PostgreSQL later-event replay. | Migration + receipt executor/store/tests. |
| PR4a0a2 executor foundation (180–240 / >=100) | PR4a0a → unused `httpapi` prepared executor; exclude sync, bookmarks, routes, publisher, migration | `backend/internal/httpapi/{idempotency.go,idempotency_test.go,idempotency_integration_test.go}`. RED: same tx, prepare/auth before lookup, replay/conflict/in-progress, rollback, post-commit, 201 compatibility. `cd backend && go test ./internal/httpapi`; PostgreSQL executor scenario. | Prepared executor/primitives/tests only. |
| PR4a0a3a.1 scope-lock kernel (220 / 150) | PR4a0a2 → shared PostgreSQL kernel; exclude adapters, writes, routes, publisher, HTTP, migration | `backend/internal/sync/{postgres.go,postgres_integration_test.go}`. RED: opposite/same scope, no deadlock, drift, no late lock, zero writes. `cd backend && go test ./internal/sync`; PostgreSQL `postgres:5432`. | Kernel/helpers/tests only. |
| PR4a0a3a.2a.1 copy + proof (215 / 185) | `.1` (`08ffff8`) → private, production-unreachable bookmarks copy; retain sync kernel/proof; exclude adapters/apply/routes/events/cursors/publisher/HTTP/migration/extension | Create `backend/internal/bookmarks/prepare.go`; modify `backend/internal/bookmarks/service_integration_test.go`. RED then GREEN: equivalent isolated-schema PostgreSQL proof of opposite/same-scope blocking without `40P01`, dedupe, locked drift, no late lock, zero writes. `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`; real `postgres:5432`. No lower package may import `syncapi`. | Added bookmarks kernel/proof only. |
| PR4a0a3a.2a.2 duplicate removal (211 / 189) | `.2a.1` → sole private bookmarks kernel; exclude all `.2a.1` exclusions | Modify `backend/internal/sync/postgres.go` and `backend/internal/sync/postgres_integration_test.go`: delete only duplicate kernel/proof; retain and rerun bookmarks proof. `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1 && go test ./internal/sync`; real isolated-schema PostgreSQL plus compile/import/caller regression proof. | Sync duplicate kernel/proof deletion only; `.2a.1` remains. |
| PR4a0a3a.2b folder prepare (230 / 170) | `.2a.2` → `PrepareFolderPatchTx`; exclude bookmark apply/routes/events/cursors/publisher/HTTP/migration | `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}`. RED `cd backend && go test ./internal/bookmarks -run '^TestPrepareFolderPatchTx' -count=1`; real PostgreSQL proves tx, locks, normalized full patch/fingerprint/no-op, zero writes. | Folder API/helpers/tests; kernel remains. |
| PR4a0a3a.2c bookmark prepare (245 / 155) | `.2a.2`, stacked after `.2b` → `PrepareBookmarkPatchTx`; exclude folder changes/apply/routes/events/cursors/publisher/HTTP/migration | Same files. RED `cd backend && go test ./internal/bookmarks -run '^TestPrepareBookmarkPatchTx' -count=1`; real PostgreSQL proves tx, containment, normalized full patch/fingerprint/no-op, zero writes. | Bookmark API/helpers/tests; prior slices remain. |
| PR4a0a3b apply foundation (220–300 / >=100) | `.2c` → unused same-tx prepared apply; exclude prepare/lock changes, routes, HTTP, migration, publisher invocation | `backend/internal/bookmarks/{service.go,service_integration_test.go}`, `backend/internal/sync/{types.go,service.go,postgres.go,postgres_integration_test.go}`. RED: no-op, exact mutation/event/cursor, rollback, legacy compatibility. `cd backend && go test ./internal/bookmarks ./internal/sync`; PostgreSQL transaction harness. | Apply API/tests only. |
| PR4a0b.1 folder PATCH vertical (282 / 25) | `448eb1f` → idempotent complete-shape `PATCH /folders/{folderId}`; stacked to `develop`; exclude bookmark route, PR4a1, extension | `backend/cmd/api/main.go`, `backend/internal/sync/{types.go,service.go,postgres.go,bookmark_routes.go,headers.go,bookmark_routes_test.go,postgres_integration_test.go,handler_test.go}`. RED then GREEN: focused HTTP plus isolated-schema real PostgreSQL proves full-shape normalization, auth/base-cursor/containment, replay/conflict/stable ACK, no-op zero event/cursor/publication, mutation one event/cursor then post-commit. | Revert this folder bridge/route/tests/evidence only; legacy folder route returns. |
| PR4a0b.2 bookmark PATCH vertical (231 / 25) | PR4a0b.1 → idempotent complete-shape `PATCH /bookmarks/{bookmarkId}`; stacked to `develop`; exclude PR4a1, extension | Same sync files, limited to bookmark wiring/proof. RED then GREEN: focused HTTP plus isolated-schema real PostgreSQL proves URL/full-shape normalization, folder containment, and the folder-contract matrix. | Revert bookmark wiring/tests/evidence only; PR4a0b.1 remains correct. |
| PR4a1–PR4b (330–380 / 20–70 each) | Follow the existing outbox → receipts → apply → repair sequence | Extension paths; `cd extension && npm run build && node --test tests/convergence.test.mjs`; restart/callback/ordering/Retry-Rebuild harnesses. | Respective unit paths/tests. |

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

## Phase 13b: Prepare foundation — PR4a0a3a.1 → PR4a0a3a.2a.1/.2a.2/.2b/.2c
- [x] 13b.1 RED (PR4a0a3a.1): in `backend/internal/sync/postgres_integration_test.go`, fail for opposite/same-scope moves until `prepareScopeKeys`, scope locks, locked revalidation, retryable drift refusal, and no-post-row-lock scope acquisition exist; assert zero resource/order/event/cursor writes. Run `cd backend && go test ./internal/sync`; use deterministic PostgreSQL `postgres:5432`; rollback: kernel RED tests only.
- [x] 13b.2 GREEN (PR4a0a3a.1): in `backend/internal/sync/postgres.go`, add sorted/deduplicated scope advisory locking before target/sibling `FOR UPDATE`, locked scope rederivation, and bounded whole-tx retryable drift refusal; never acquire scopes after row locks. Run the same command/harness; rollback: kernel/helpers/tests only.
- [x] 13b.3a RED (PR4a0a3a.2a.1, native): in `backend/internal/bookmarks/service_integration_test.go`, add the equivalent isolated-schema PostgreSQL proof and make it fail before the copy; prove opposite/same-scope blocking without `40P01`, dedupe, locked drift, no late scope lock, and zero writes while sync kernel/proof remain. Run `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1` against real `postgres:5432`; rollback: bookmarks RED proof only.
- [x] 13b.3b GREEN (PR4a0a3a.2a.1, native): create `backend/internal/bookmarks/prepare.go` with an equivalent private caller-owned-`pgx.Tx` kernel; retain `backend/internal/sync/{postgres.go,postgres_integration_test.go}` and keep the bookmarks copy production-unreachable. GREEN: same PostgreSQL command passes; no lower package may import `syncapi`; rollback: added bookmarks kernel/proof only; exclude adapters/apply/routes/events/cursors/publisher/HTTP/migration.
- [x] 13b.3c NATIVE CLOSE (PR4a0a3a.2a.2): after `.2a.1`, delete only the duplicate kernel from `backend/internal/sync/postgres.go` and duplicate proof from `backend/internal/sync/postgres_integration_test.go`; do not add an artificial RED. Prove behavior/caller/import stability with `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1 && go test ./internal/sync` on real isolated-schema `postgres:5432`; rollback: sync deletion only.
- [x] 13b.3d RED (PR4a0a3a.2b, native; after `.2a.2`): in `backend/internal/bookmarks/service_integration_test.go`, `PrepareFolderPatchTx` first failed undefined; the PostgreSQL proof covers caller `pgx.Tx`, locked role/parent/ancestry path, trim/clamp/full `Folder`, stable fingerprint/no-op, zero writes, and unchanged `UpdateFolderTx`.
- [x] 13b.3e GREEN (PR4a0a3a.2b, native; after `.2a.2`): `backend/internal/bookmarks/{prepare.go,service_integration_test.go}` add immutable complete-shape `PreparedFolderPatch` and read-only `PrepareFolderPatchTx`; focused and full real-PostgreSQL proof pass. No `syncapi` import, bookmark preparation/apply, routes, events/cursors, publisher, HTTP idempotency, migrations, or extension changes were made; rollback is folder API/helpers/tests only.
- [x] 13b.3f RED (PR4a0a3a.2c, native; after `.2a.2`, stacked after `.2b`): in `backend/internal/bookmarks/service_integration_test.go`, `TestPrepareBookmarkPatchTx` failed first because `PrepareBookmarkPatchTx` and its patch helpers were undefined; its real-PostgreSQL proof covers caller `pgx.Tx`, locked role/folder containment, trimmed title/URL validation, clamped position/full `Bookmark`, fingerprint/no-op, zero writes, and unchanged `UpdateBookmarkTx`.
- [x] 13b.3g GREEN (PR4a0a3a.2c, native; after `.2a.2`): `backend/internal/bookmarks/{prepare.go,service_integration_test.go}` add immutable `PreparedBookmarkPatch` and read-only `PrepareBookmarkPatchTx`; focused and full real-PostgreSQL proof pass with zero writes. No `syncapi` import or folder/apply/routes/events/cursors/publisher/HTTP/migration/extension changes; rollback is bookmark API/helpers/tests only.

## Phase 13c: Apply foundation — PR4a0a3b (after PR4a0a3a.2c)
- [x] 13c.1 RED: in `backend/internal/{bookmarks/service_integration_test.go,sync/postgres_integration_test.go}`, prove same-tx prepared apply: no-op has zero writes; mutation writes exact prepared resource/order and one event/cursor; publisher data is returned, not invoked; rollback removes all; legacy `Update*` remains compatible. Run `cd backend && go test ./internal/bookmarks ./internal/sync`; rollback: remove only these RED tests.
- [x] 13c.2 GREEN: in `backend/internal/bookmarks/service.go` and `backend/internal/sync/{types.go,service.go,postgres.go}`, add `ApplyPreparedFolderPatchTx`/`ApplyPreparedBookmarkPatchTx` consuming the same prepared state/tx and returning uninvoked publisher data; make no prepare/lock changes and add no routes, HTTP idempotency, or migration. Run the same command; rollback: remove only apply API/tests, retaining prepare and legacy `Update*`.

## Phase 14: Complete-shape integration — PR4a0b
- [x] 14.1 PR4a0b.1 folder vertical (base `448eb1f` → `develop`): RED then GREEN only `PATCH /folders/{folderId}` through `ExecutePrepared`, adding its route/bridge/ACK wiring and focused HTTP + isolated-schema real PostgreSQL proof. Preserve HTTP/auth/base-cursor/containment, receipt conflict/idempotency, full-shape/no-op zero event/cursor/publication, mutation one event/cursor and post-commit ordering; same-key replay returns identical status/body/headers/ack. Forecast 94 production + 152 proof + 1 task + 10 progress + 25 reserve = 282; update task/progress artifacts with exact OpenSpec/Engram parity, record passing focused command/harness and rollback, run cleanup/no-skip checks; no bookmark, PR4a1, or extension work.
- [x] 14.2 PR4a0b.2 bookmark vertical (after PR4a0b.1 → `develop`): RED then GREEN only `PATCH /bookmarks/{bookmarkId}` through `ExecutePrepared`, adding bookmark-only route/bridge/ACK wiring and focused HTTP + isolated-schema real PostgreSQL proof. Preserve the same HTTP/auth/conflict/idempotency/no-op/transaction/post-commit contracts, plus URL/full-shape normalization and folder containment; forecast 63 production + 132 proof + 1 task + 10 progress + 25 reserve = 231. Update task/progress artifacts with exact OpenSpec/Engram parity, record focused proof/harness, rollback, cleanup/no-skip evidence; no PR4a1 or extension work.

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
