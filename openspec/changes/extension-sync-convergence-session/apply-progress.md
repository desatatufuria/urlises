# Apply Progress: Extension Sync Convergence Session

## Cumulative Status
32/46 semantic tasks complete; native checkbox progress is 15/29. Delivery is `auto-chain`, stacked-to-`develop`, with no `size:exception`.

## Completed Foundations
- [x] 7.1–7.2: dormant journal/planner.
- [x] 8.1–8.2 and 9.1–9.2: deterministic Chrome harness and fidelity hardening.
- [x] 10.1–10.2 and 11.1–11.2: durable create/delete ownership.
- [x] 12.1 RED: PostgreSQL receipt tests first failed because `SafeResult` lacked semantic headers and a fixed acknowledgement cursor.
- [x] 12.2 GREEN: generic 200/201 receipt replay ledger; no PATCH route, event, cursor, or extension change.
- [x] 13a.1 RED: prepared-executor API contracts first failed because `IdempotencyScope`, `Prepared`, `PostCommit`, and `ExecutePrepared` were undefined.
- [x] 13a.2 GREEN: `ExecutePrepared` owns one transaction, receipt primitives, rollback, and returned-only post-commit hooks; legacy `Execute` remains compatible.

## PR4a0a3a Prepare Foundation — Blocked
- [ ] 13b.1 RED: not re-authored after the maintainer-authorized scope-first design reset. The historical undefined-API RED does not prove the amended locking contract.
- [ ] 13b.2 GREEN: no production or test code was added. PostgreSQL connectivity is resolved; safe proof decomposition is the only remaining blocker.

### Generation 2, Ordinal 4 — Final Attempt
- A temporary scope-first implementation and RED API test reached 267 authored lines before required PostgreSQL concurrency/drift/no-write coverage or progress artifacts.
- It was reverted rather than exceed the 400-line work-unit cap with incomplete proof. The IPv4-published `127.0.0.1:5433` endpoint still returned `connection refused` despite Compose reporting PostgreSQL healthy.

### Generation 3, Ordinal 5 — Connectivity Correction
- PostgreSQL reachability is resolved through the existing Docker service endpoint `postgres:5432`; the published IPv4 endpoint remains unreachable from this workspace and is not required.
- With all three PostgreSQL test URL variables set to `postgres://postgres:***@postgres:5432/shared_bookmark_sync?sslmode=disable`, `go test -v -count=1 ./internal/bookmarks -run 'Test(CreateFolderReordersRootSiblingsInPostgres|CreateBookmarkReordersFolderSiblingsInPostgres)$'` passed: `TestCreateFolderReordersRootSiblingsInPostgres` PASS and `TestCreateBookmarkReordersFolderSiblingsInPostgres` PASS (2/2).
- The discarded candidate consumed 267/400 authored lines and did not contain the required proof matrix, leaving 133 lines. A conservative lower bound for the missing work is 136 lines: 55 for bounded opposite- and same-scope deterministic blocking/no-deadlock harnesses; 36 for concurrent drift plus no-post-row-lock-scope-acquisition assertions; 30 for zero resource/order/event/cursor writes and legacy `Update*` compatibility assertions; and 15 for two task-checkbox changes plus cumulative apply-progress evidence. Therefore the remaining requirements exceed the available budget by at least 3 lines; this is a decomposition blocker, not a size-exception recommendation.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| Historical RED | `cd backend && go test ./internal/bookmarks ./internal/sync`: FAIL before the design reset because `PrepareFolderPatchTx` and `PrepareBookmarkPatchTx` were undefined. |
| Historical API RED | `cd backend && go test ./internal/bookmarks -run 'TestPrepareScope(KeysSortAndDeduplicate|DriftIsRetryable)$'`: FAIL (expected) before implementation because `prepareScopeKeys`, `IsRetryablePrepareError`, and `PrepareScopeDriftError` were undefined. |
| Resolved runtime harness | `docker compose ps postgres` reported `shared-bookmark-sync-postgres` healthy and `docker compose port postgres 5432` reported `0.0.0.0:5433`; this workspace resolves `postgres` to the Docker-network service endpoint. The maintainer-managed service was neither stopped nor restarted. |
| Focused PostgreSQL proof | With `DATABASE_URL`, `BOOKMARKS_TEST_DATABASE_URL`, and `SYNC_TEST_DATABASE_URL` set to the redacted `postgres://postgres:***@postgres:5432/shared_bookmark_sync?sslmode=disable`, `go test -v -count=1 ./internal/bookmarks -run 'Test(CreateFolderReordersRootSiblingsInPostgres|CreateBookmarkReordersFolderSiblingsInPostgres)$'`: PASS; `TestCreateFolderReordersRootSiblingsInPostgres` PASS; `TestCreateBookmarkReordersFolderSiblingsInPostgres` PASS (2/2). |
| Budget | 267-line incomplete candidate leaves 133 lines. Missing mandatory lower bound is 136 lines (55 concurrency/opposite/same-scope + 36 drift/no-post-row-lock + 30 zero-write/legacy + 15 tasks/apply-progress), exceeding capacity by 3 lines. |
| Rollback | No production/test code remains. Revert only this apply-progress artifact to remove the corrected blocker record. |
| Cleanup | 13b task checkboxes remain unchecked; no runtime command was run during this correction; `git diff --check` passes. |

## Next
Run `sdd-design`: under cached `auto-chain` / `stacked-to-main`, split PR4a0a3a into independently autonomous sub-slices with explicit interfaces, proof ownership, and rollback boundaries; then run `sdd-tasks`. PostgreSQL connectivity is resolved. Phase 13c+ remains untouched.
