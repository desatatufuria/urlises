# Apply Progress: Extension Sync Convergence Session

## Cumulative Status
34/48 semantic tasks complete; native checkbox progress is 17/31. Delivery is `auto-chain`, stacked-to-`main`, with no `size:exception`.

## Completed Foundations
- [x] 7.1–7.2: dormant journal/planner.
- [x] 8.1–8.2 and 9.1–9.2: deterministic Chrome harness and fidelity hardening.
- [x] 10.1–10.2 and 11.1–11.2: durable create/delete ownership.
- [x] 12.1 RED: PostgreSQL receipt tests first failed because `SafeResult` lacked semantic headers and a fixed acknowledgement cursor.
- [x] 12.2 GREEN: generic 200/201 receipt replay ledger; no PATCH route, event, cursor, or extension change.
- [x] 13a.1 RED: prepared-executor API contracts first failed because `IdempotencyScope`, `Prepared`, `PostCommit`, and `ExecutePrepared` were undefined.
- [x] 13a.2 GREEN: `ExecutePrepared` owns one transaction, receipt primitives, rollback, and returned-only post-commit hooks; legacy `Execute` remains compatible.

## PR4a0a3a.1 Scope-Lock Kernel — Complete
- [x] 13b.1 RED: `TestPrepareScopesTxSerializesAndRefusesDrift` failed first with the kernel API undefined.
- [x] 13b.2 GREEN: typed sibling keys are sorted/deduplicated and transaction advisory-locked before the supplied target/sibling `FOR UPDATE`; locked rederivation returns typed retryable drift without writes.

### Generation 4, Ordinal 6
- Native revision: `sha256:7559266fc9c21b28c53fbedd9bd69969b8acf295cf945fd1e6ad0c70a453b4bd`.
- The bounded PostgreSQL harness proves same/opposite-order contention blocks then releases without deadlock, deduplicates a repeated key, rederives after a row lock, returns retryable drift, and preserves zero folders/bookmarks/events/cursors.

### Generation 4, Ordinal 7 — Design Artifact Correction
- Corrected the stale shared-kernel ownership statement to `sync`, explicitly naming `backend/internal/sync/postgres.go` and `backend/internal/sync/postgres_integration_test.go`.
- Corrected the stale next-step route to `sdd-apply` for PR4a0a3a.2 canonical folder/bookmark adapters.
- Evidence revision: `sha256:9c10da8514491d8d524fbf6f3d64d6053c38fcfb32a650a1d684ceb4bd9fd740` (full corrected `design.md`). No production/test file was modified and no test or runtime command ran during this artifact-only correction.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| RED | `cd backend && go test ./internal/sync -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`: FAIL (undefined `siblingScopeKey`, `prepareScopesTx`, retryable drift API). |
| Focused test / runtime harness | With `DATABASE_URL`, `SYNC_TEST_DATABASE_URL`, and `BOOKMARKS_TEST_DATABASE_URL` set to `postgres://postgres:***@postgres:5432/shared_bookmark_sync?sslmode=disable`, `cd backend && go test ./internal/sync -count=1`: PASS (1 package, real isolated-schema PostgreSQL). |
| Rollback | Revert `backend/internal/sync/postgres.go`, `backend/internal/sync/postgres_integration_test.go`, and these 13b artifact marks only; no adapter, resource/order, event, or cursor behavior is removed. |
| Cleanup / budget | User-managed PostgreSQL was not stopped or restarted. `gofmt` and `git diff --check` pass; retained diff is within 400 lines. |

## Next
Run `sdd-apply` for PR4a0a3a.2 only. Phase 13b.3+ remains untouched.

## Generation 4, Ordinal 9 — Blocked Before RED
- Deterministic evidence revision: `sha256:0fb50ac74785fe544922c01f6f161d30b3c2009e6b9fb30f11a028ce9442d84b` for canonical tuple `ordinal=9`, `base=08ffff8`, `code_test_changes=0`, blocker identity, and tasks `13b.3,13b.4`.
- The required PR4a0a3a.2 contract cannot be completed within the autonomous <=400 authored-line slice: `bookmarks` already imports no `sync` code, while `sync` imports `bookmarks`; the only scope-lock/revalidation kernel is the unexported `syncapi.prepareScopesTx`.
- Therefore `bookmarks.Service.PrepareFolderPatchTx` / `PrepareBookmarkPatchTx` cannot consume that kernel without either exporting/inverting the package boundary or extracting a neutral package. Either route changes the approved kernel contract and requires new cross-package proof beyond the 380-line adapter estimate.
- No production or test file changed, no RED test was added, no task checkbox changed, and no runtime test was run. The working tree started clean at `08ffff8`; user-managed PostgreSQL was not touched.
- Required unblock: revise the design/package ownership and recalculate a complete code, PostgreSQL-proof, and artifact forecast before another apply attempt. This is the final allowed native attempt for the current objective.
