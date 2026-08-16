# Apply Progress: Extension Sync Convergence Session

## Cumulative Status
49/53 semantic tasks complete; native checkbox progress is 32/36. Delivery is `auto-chain`, stacked-to-`main`, with no `size:exception`.

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

## PR4a0a3a.2a — Blocked Before RED by Slice Cap
- Complete relocation forecast: 386 authored code/test lines (75 delete + 81 add for the kernel; 116 delete + 114 add for the isolated PostgreSQL proof), plus 4 task-checkbox lines and at least 12 merged apply-progress/evidence lines = **402 minimum**.
- This exceeds the autonomous 400-line cap before formatter/import-normalizer churn; no code or test file was edited, 13b.3a/13b.3b remain unchecked, and PostgreSQL was not touched.
- Required unblock: split the documented proof/harness relocation from the kernel move or authorize a different bounded task plan; no size exception is authorized.
- Deterministic evidence revision: `sha256:f0f8c34d3c98d4137110bd5ef15a14ce1c558e999e68dca098fe2cb540cd5bba` for the complete forecast tuple and blocked-before-RED decision.

## Generation 4, Ordinal 9 — Blocked Before RED
- Deterministic evidence revision: `sha256:0fb50ac74785fe544922c01f6f161d30b3c2009e6b9fb30f11a028ce9442d84b` for canonical tuple `ordinal=9`, `base=08ffff8`, `code_test_changes=0`, blocker identity, and tasks `13b.3,13b.4`.
- The required PR4a0a3a.2 contract cannot be completed within the autonomous <=400 authored-line slice: `bookmarks` already imports no `sync` code, while `sync` imports `bookmarks`; the only scope-lock/revalidation kernel is the unexported `syncapi.prepareScopesTx`.
- Therefore `bookmarks.Service.PrepareFolderPatchTx` / `PrepareBookmarkPatchTx` cannot consume that kernel without either exporting/inverting the package boundary or extracting a neutral package. Either route changes the approved kernel contract and requires new cross-package proof beyond the 380-line adapter estimate.
- No production or test file changed, no RED test was added, no task checkbox changed, and no runtime test was run. The working tree started clean at `08ffff8`; user-managed PostgreSQL was not touched.
- Required unblock: revise the design/package ownership and recalculate a complete code, PostgreSQL-proof, and artifact forecast before another apply attempt. This is the final allowed native attempt for the current objective.

## PR4a0a3a.2a.1 Copy + Proof — Complete
- [x] 13b.3a RED: the isolated-schema bookmarks PostgreSQL proof failed first with private kernel symbols undefined.
- [x] 13b.3b GREEN: added the production-unreachable private bookmarks copy with sorted/deduplicated advisory locks, locked rederivation, typed retryable drift, and zero-write behavior. The sync kernel and proof remain byte-for-byte unchanged.

| Evidence | Exact result |
|---|---|
| RED | `docker exec bookmarks ... go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`: FAIL, undefined `siblingScopeKey`, `prepareScopesTx`, `IsRetryablePrepareError`, and `PrepareScopeDriftError`. |
| GREEN / runtime harness | With existing PostgreSQL configuration resolved inside the `bookmarks` container, focused command: PASS (0.889s, isolated schema). |
| Full PostgreSQL proof | `go test ./internal/bookmarks ./internal/sync`: PASS (bookmarks 3.013s; sync 1.645s). |
| Rollback / cleanup | Revert only `backend/internal/bookmarks/prepare.go`, bookmarks proof, and these two task/progress marks. PostgreSQL remains running; no adapters, callers, routes, events, cursors, publishers, idempotency, migrations, or extension files changed. |

Evidence revision: `sha256:bf438fa8c311796e0164bcafbc9b20ea2c154dcdec22fd15be7c6b20fe50de3f`.

## Gate Correction — Private Bookmarks Symbols
- Preserved the historical `.2a.1` RED/GREEN evidence above unchanged, including its exported undefined names and timings.
- The bounded rerun renamed the bookmarks-only symbols to `prepareScopeDriftError` and `isRetryablePrepareError`; behavior is unchanged.
- Focused PostgreSQL proof: PASS (0.749s). Full PostgreSQL proof: bookmarks PASS (2.785s); sync PASS (cached).
- Synchronized the `.2a.2` route below without changing task counts or prior evidence.

## Next
Run `.2a.2` only, remove the duplicate sync kernel/proof, and rerun bookmarks plus sync PostgreSQL proof.

Gate correction evidence revision: `sha256:cb544e036b37eb39e1deec0d82e07a99fd3c2467cb8603d3608a97364d6d0d37`.

## PR4a0a3a.2a.2 Duplicate Removal — Complete
- [x] 13b.3c NATIVE CLOSE: deleted only the duplicate private scope-lock/revalidation kernel from `backend/internal/sync/postgres.go` and its duplicate PostgreSQL proof from `backend/internal/sync/postgres_integration_test.go`.
- No artificial RED was added: this is a close/removal slice whose behavior remains covered by the retained `.2a.1` bookmarks PostgreSQL proof.

| Evidence | Exact result |
|---|---|
| Focused PostgreSQL proof | With the existing healthy `postgres:5432` service, `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`: PASS (1.654s, isolated schema). |
| Full PostgreSQL proof | `cd backend && go test ./internal/bookmarks ./internal/sync`: PASS (bookmarks 8.868s; sync 2.855s). |
| Caller/import proof | CodeGraph reports no remaining `syncapi` kernel symbols; the sole `prepareScopesTx` has one caller in `backend/internal/bookmarks/service_integration_test.go`. `bookmarks` imports no `syncapi`. |
| Retained proof identity | `backend/internal/bookmarks/prepare.go` is `3b6b4e0788bb5c5d6a73fc63f0906d0ddf2c71af`; `backend/internal/bookmarks/service_integration_test.go` is `841b86e12e6cd076da9ee72776612a37267b8a56`; both equal `HEAD` with no diff. |
| Rollback | Revert only the sync deletions in `backend/internal/sync/postgres.go` and `backend/internal/sync/postgres_integration_test.go`, plus this task/progress mark; no adapters, callers, routes, events, cursors, publishers, idempotency, migrations, or extension files change. |

Deletion: 145 lines total (74 from `postgres.go`, 71 from `postgres_integration_test.go`). `gofmt` and `git diff --check` pass. PostgreSQL remains running.

Evidence revision: `sha256:6c1fdfa67f39aa5950f984cc90b46a86d5199f259dc43e8a0c6e2c8a1fa15638`.

## PR4a0a3a.2b Folder Preparation — Complete
- [x] 13b.3d RED: `TestPrepareFolderPatchTx` was written first and failed because `(*Service).PrepareFolderPatchTx` was undefined.
- [x] 13b.3e GREEN: preparation uses the private bookmarks scope-lock/revalidation kernel, locks the folder/parent/siblings, authenticates through the caller-owned transaction, validates ancestry, and only reads/normalizes the immutable complete original/final shapes.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| RED | `cd backend && go test ./internal/bookmarks -run '^TestPrepareFolderPatchTx$' -count=1`: FAIL (undefined `(*Service).PrepareFolderPatchTx` at two test call sites). |
| Focused GREEN / runtime harness | Against the existing healthy PostgreSQL service using its configured connection without recording credentials, `go test ./internal/bookmarks -run '^TestPrepareFolderPatchTx$' -count=1 -v`: PASS (0.738s, isolated schema). The scenario retains caller transaction ownership, proves role and descendant-parent rejection, trims the name, clamps position `99` to `1`, returns complete independent original/final shapes, produces a stable no-op fingerprint, and writes zero folders/orders/events/cursors. |
| Full PostgreSQL proof | `cd backend && go test ./internal/bookmarks ./internal/sync -count=1`: PASS (`bookmarks` 3.469s; `sync` 0.773s). |
| API / boundary proof | CodeGraph resolves exported `PrepareFolderPatchTx` and `PreparedFolderPatch` only in `backend/internal/bookmarks/prepare.go`; the kernel remains private and `bookmarks` has no `syncapi` import. No route, event, cursor, publisher, HTTP idempotency, migration, extension, bookmark prepare, or apply path changed. |
| Legacy proof | The focused test calls legacy `UpdateFolderTx` after preparation and confirms its existing trimmed-name behavior remains compatible. |
| Counts / parity | Implementation/test delta is 286 lines; complete work-unit delta is 312 authored additions/deletions, within the 400-line autonomous cap. Tasks move from 37/53 semantic and 20/36 native to 39/53 and 22/36; OpenSpec and Engram records are synchronized. |
| Rollback | Revert only `backend/internal/bookmarks/prepare.go`, `backend/internal/bookmarks/service_integration_test.go`, and the 13b.3d/e task/progress marks; the private kernel remains and no unrelated behavior is removed. |
| Cleanup | `gofmt` and `git diff --check` pass. PostgreSQL remains running. |

Evidence revision: `sha256:5c3d340b20c6af3bb1ef07c117e0f862883ffe80132a67d5a1ba9b448269215b`.

## PR4a0a3a.2c Bookmark Preparation — Complete
- [x] 13b.3f RED: `TestPrepareBookmarkPatchTx` was written first and failed because `PrepareBookmarkPatchTx` and bookmark patch helpers were undefined.
- [x] 13b.3g GREEN: preparation uses the private bookmarks scope-lock/revalidation kernel, locks the bookmark/target folder/siblings, authenticates through the caller-owned transaction, validates target-folder containment, and only reads/normalizes immutable complete original/final shapes.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| RED | `cd backend && go test ./internal/bookmarks -run '^TestPrepareBookmarkPatchTx$' -count=1`: FAIL (undefined `(*Service).PrepareBookmarkPatchTx` and `bookmarksEqual`). |
| Focused GREEN / runtime harness | With the existing PostgreSQL configuration resolved inside a temporary build-stage test container on the compose network, without recording credentials: `go test ./internal/bookmarks -run '^TestPrepareBookmarkPatchTx$' -count=1 -v`: PASS (0.711s, isolated schema). Caller transaction ownership, role/folder-containment rejection, title/URL trim and HTTP(S) validation, clamp `99 -> 1`, complete shapes, stable no-op fingerprint, zero writes, and legacy compatibility proved. |
| Folder regression | `go test ./internal/bookmarks -run '^TestPrepareFolderPatchTx$' -count=1 -v`: PASS (0.713s, isolated schema). |
| Full PostgreSQL proof | `cd backend && go test ./internal/bookmarks ./internal/sync -count=1`: PASS (`bookmarks` 4.181s; `sync` 0.744s). |
| API / boundary proof | CodeGraph maps the preparation contract to `backend/internal/bookmarks/prepare.go`; the kernel remains private and `bookmarks` imports no `syncapi`. No folder, apply, route, event, cursor, publisher, HTTP idempotency, migration, or extension path changed. |
| Counts / parity | 285 implementation/test additions; 311 complete work-unit additions/deletions, below the 400-line cap. Tasks advance 39/53 -> 41/53 semantic and 22/36 -> 24/36 native; OpenSpec and Engram records are exact synchronized. |
| Rollback | Revert only bookmark additions in `backend/internal/bookmarks/prepare.go`, `backend/internal/bookmarks/service_integration_test.go`, and 13b.3f/g task/progress marks; folder preparation and the private kernel remain. |
| Cleanup | `gofmt` and `git diff --check` pass. PostgreSQL remains running. |

Evidence revision: `sha256:ea08aef1994cc2389a0056ec1ab65cebff0fd75f81a372510696e9315691ddfb`.

## PR4a0a3b Prepared Apply Foundation — Complete
- [x] 13c.1 RED: same-transaction prepared-apply integration contracts were written first. The focused package command failed at compile time because the bookmarks and sync prepared-apply APIs did not exist.
- [x] 13c.2 GREEN: added caller-owned transaction APIs that consume the prepared final shapes, produce no write/event/cursor for no-op patches, record exactly one event/cursor for mutations, and return uninvoked `PostCommit` publisher data. Preparation/locking and legacy `Update*` remain unchanged.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| RED | `cd backend && go test ./internal/bookmarks ./internal/sync -count=1`: FAIL before production changes; undefined `ApplyPreparedFolderPatchTx` / `ApplyPreparedBookmarkPatchTx` in both packages. |
| Focused GREEN / runtime harness | `docker exec -e GOMODCACHE=/tmp/gomodcache -e DATABASE_URL=<redacted> -w /workspace/backend bookmarks go test ./internal/bookmarks -run '^TestApplyPreparedPatchesTxUsesPreparedFinalShapes$' -count=1 -v`: PASS (0.680s); `... go test ./internal/sync -run '^TestApplyPreparedPatchesTxRecordsOnlyMutationsAndReturnsPostCommit$' -count=1 -v`: PASS (0.738s). Both tests ran against real isolated-schema PostgreSQL at the healthy `postgres:5432` service. |
| Full PostgreSQL proof | `docker exec -e GOMODCACHE=/tmp/gomodcache -e DATABASE_URL=<redacted> -w /workspace/backend bookmarks go test ./internal/bookmarks ./internal/sync -count=1`: PASS (`bookmarks` 5.116s; `sync` 1.549s). |
| Contract proof | No-op returns the prepared resource without writes, event, cursor, or post-commit data. Mutation persists the prepared resource/order, produces one `bookmark.updated` event/cursor, returns publisher/event data without calling the publisher, and rollback removes resource/event/cursor changes. Both legacy `UpdateFolderTx` and `UpdateBookmarkTx` remain compatible. |
| Rollback | Revert only `backend/internal/bookmarks/service.go`, `backend/internal/bookmarks/service_integration_test.go`, `backend/internal/sync/{types.go,service.go,postgres.go,postgres_integration_test.go,bookmark_routes_test.go,handler_test.go}`, and the 13c task/progress marks. Preparation/locking, routes, HTTP idempotency, migrations, publisher invocation, and extension behavior remain untouched. |
| Cleanup / budget | `gofmt` and `git diff --check` pass. Code/test delta: 327 authored additions/deletions; complete slice including these artifacts is 356, within the 400-line cap. PostgreSQL was not stopped or restarted. |
| API / path evidence | CodeGraph resolves bookmarks apply APIs at `backend/internal/bookmarks/service.go:271` and `:517`, and sync `Store` APIs at `backend/internal/sync/types.go:79–80`, forwarded by `service.go` and covered by the PostgreSQL integration test. `bookmark_routes_test.go` and `handler_test.go` contain only compile-only no-op methods required because their `fakeStore` / `replayStore` implement the expanded `Store` interface; no route or handler production code changed. |
| Deterministic count | Exact `git diff --numstat` accounting: `44+62+7+(10+1)+(44+4)+126+9+20+(22+1)+(3+3) = 356` additions plus deletions. |

Evidence revision: `sha256:358d0f30edb6d401d52204ed172c7a68d3f0ac55ec624a74c7e50bfef4596a26`.

## Next
Run `sdd-apply` for PR4a0b only.

## PR4a0b.1 Folder PATCH Vertical — Complete
- [x] 14.1 routes only `PATCH /folders/{folderId}` through `ExecutePrepared`, the prepared folder bridge, receipt replay/conflict handling, stored acknowledgement headers, and post-commit publication. Bookmark PATCH remains on its legacy `UpdateBookmark` route path.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| RED | `cd backend && go test ./internal/sync -run '^TestFolderPatchRouteExecutesPreparedTransaction$' -count=1`: FAIL before route work because `RegisterBookmarkRoutes` did not accept the executor. |
| Focused HTTP / PostgreSQL runtime harness | `docker exec -e GOMODCACHE=/tmp/gomodcache -e DATABASE_URL=<redacted> -w /workspace/backend bookmarks go test ./internal/sync -run '^TestFolderPatchRouteExecutesPreparedTransaction$' -count=1 -v`: PASS (0.626s, no skip, isolated schema). It proves normalized mutation, stable replay body/headers/ack, conflict, no-op zero writes/publication, containment/forbidden/base-cursor error mapping, and publication after committed event visibility. |
| Regression | `docker exec -e GOMODCACHE=/tmp/gomodcache -e DATABASE_URL=<redacted> -w /workspace/backend bookmarks go test ./internal/bookmarks ./internal/sync -count=1 -v`: PASS (`bookmarks` 4.737s; `sync` 2.011s). `go test ./cmd/api -count=1`: PASS. |
| Cleanup / rollback | PostgreSQL catalog count for `sync_scope_test_%`: `0` before and after the focused harness. Revert only `backend/cmd/api/main.go`, `backend/internal/sync/{types.go,service.go,postgres.go,headers.go,bookmark_routes.go,bookmark_routes_test.go,handler_test.go,postgres_integration_test.go}`, and these 14.1 marks; bookmark PATCH remains unchanged. |

Evidence revision: `sha256:818b2236bf8c805d7cd8dcbbaffeef2da9852815c1b1bb644df1c997e3705b72`; settlement must remediate `sha256:fc06f6bd1aebf353e40755e3f07acb97dc7f0b99134693c22e2d99e6977ffabc` exactly once.

## PR4a0b.2 Bookmark PATCH Vertical — Complete
- [x] 14.2 routes only `PATCH /bookmarks/{bookmarkId}` through `ExecutePrepared`, the prepared bookmark bridge, receipt replay/conflict handling, stored acknowledgement headers, and post-commit publication. Folder PATCH remains unchanged.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| Focused HTTP / PostgreSQL runtime harness | `docker exec -e GOMODCACHE=/tmp/gomodcache -e DATABASE_URL=<redacted> -w /workspace/backend bookmarks go test ./internal/sync -run '^TestBookmarkPatchRouteExecutesPreparedTransaction$' -count=1 -v`: PASS (0.66s, no skip, isolated schema). It proves normalized title/URL full shape, stable replay body/headers/ack, conflict, no-op zero writes/publication, foreign-folder containment, forbidden/base-cursor mapping, one event/cursor, and post-commit event visibility. |
| Folder regression | `docker exec -e GOMODCACHE=/tmp/gomodcache -e DATABASE_URL=<redacted> -w /workspace/backend bookmarks go test ./internal/sync -run '^TestFolderPatchRouteExecutesPreparedTransaction$' -count=1 -v`: PASS (0.60s, no skip, isolated schema). |
| Regression | `docker exec -e GOMODCACHE=/tmp/gomodcache -e DATABASE_URL=<redacted> -w /workspace/backend bookmarks go test ./internal/bookmarks ./internal/sync -count=1 -v`: PASS (`bookmarks` 4.820s; `sync` 2.804s). `go test ./cmd/api -run '^$' -count=1`: PASS. |
| Cleanup / rollback | PostgreSQL catalog count for `sync_scope_test_%`: `0` before and after all runtime tests. Revert only `backend/internal/sync/{types.go,service.go,postgres.go,bookmark_routes.go,bookmark_routes_test.go,handler_test.go,postgres_integration_test.go}` and these 14.2 artifact marks; folder PATCH remains correct. |

Final slice accounting relative to `b04d5ac`: 169 additions + 6 deletions = 175 changed lines; `gofmt` and `git diff --check` pass. Native attempt token `sha256:72929f3bd45880a4adda31a7a372961f07f7ed638c349809195835df7224ece8` was not mutated.

## PR4a1 Intent Foundation — Complete
- [x] 15.1 RED: corrected the recovered RED tests to use the persisted `eventId` contract, capture complete node shape, assert the actual post-move node, and retain the 101st unacknowledged intent while paused.
- [x] 15.2 GREEN: local update/move callbacks now retain complete, contained, deterministic stable-ID intent without backend mutation; bounded retention prunes only acknowledged entries, cursor-zero node-read failure pauses explicitly, and remote update/move activation remains deferred to PR4a2+.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| RED | `cd extension && node --test tests/convergence.test.mjs`: FAIL (5 pass, 1 fail; `captureLocalIntent is not a function`). `cd extension && node --test tests/projection-behavior.test.mjs`: FAIL (33 pass, 2 fail; callbacks still emitted backend requests). |
| Focused GREEN | `cd extension && npm run build && node --test tests/convergence.test.mjs && node --test tests/projection-behavior.test.mjs`: PASS (TypeScript build; convergence 6/6; projection behavior 35/35). |
| Runtime harness | `cd extension && npm run test:projection`: PASS (build plus 94/94 deterministic extension runtime/projection tests). `npm run typecheck`: PASS. |
| Cleanup / budget | `git diff --check`: PASS. Relative to `be5a3ab`, code/test changes are 166 additions + 75 deletions = 241; including task/progress artifacts, authored changes are 185 additions + 79 deletions = 264, below 400. `npm run build` left no generated tracked or untracked output; pre-existing untracked `.docmanager/` and `SHA256SUMS.txt` were not modified. |
| Rollback | Revert only `extension/src/background/{convergence.ts,projection.ts}`, `extension/src/shared/types.ts`, `extension/tests/{convergence.test.mjs,projection-behavior.test.mjs}`, and these 15.1–15.2 artifact marks. Create/delete/session behavior and remote update/move activation remain outside this unit. |

Settlement evidence: active native token `sha256:79a779a7a9dd5c62fcdc22243432ffd90410dd88e976b8d076cd438266c1d9f3`, generation 21, ordinal 27 was not acquired, settled, reset, or otherwise mutated by this executor.

## PR4a2 Receipt Foundation — Complete
- [x] 16.1 RED: receipt-shape, hidden URL mismatch, duplicate callback, and persisted-restart tests first failed because `createRemoteReceipt` was undefined.
- [x] 16.2 GREEN: added a dormant, versioned receipt reducer with workspace/backend/Chrome/type identity, durable before/after shape signatures, event/cursor, pending/consumed state, exact move tuple proof, bounded terminal retention, and intent fallback. It is not wired to remote update/move application, checkpoints, suppression replacement, or repair.

## Work Unit Evidence
| Evidence | Exact result |
|---|---|
| Forecast / RED | Forecast before source edits: 83 additions+deletions (60 code/test + 23 artifacts), under 400. `cd extension && npm run build && node --test tests/convergence.test.mjs`: FAIL (6 pass, 3 fail; `createRemoteReceipt is not a function`). |
| Focused GREEN | `cd extension && npm run build && node --test tests/convergence.test.mjs`: PASS (9/9). It proves hidden URL mismatch queues intent without consumption, one exact pending move receipt consumes once, duplicate callback queues intent, and persisted restart retains receipt and intent. |
| Runtime harness | `cd extension && npm run test:projection`: PASS (build plus 97/97 deterministic repository-native tests). `npm run typecheck`: PASS. |
| Rollback / cleanup | Revert only `extension/src/background/convergence.ts`, `extension/src/shared/types.ts`, `extension/tests/convergence.test.mjs`, and these 16.1–16.2 artifact marks. `git diff --check`: PASS; build left no generated output. Pre-existing `.docmanager/` and `SHA256SUMS.txt` remain unmodified. |
| Settlement | Token `sha256:6902ac215da66db0f4c15facb5d017d5b32f2d6b52a4af7cf197cbe0244c483c` was supplied already acquired; no acquire, settle, reset, or ledger mutation was performed. |

Final accounting relative to `b2cfbb4`: 76 additions + 7 deletions = 83 changed lines. OpenSpec tasks are 32/36 native and 49/53 semantic; PR4a3 and later remain unchecked.
