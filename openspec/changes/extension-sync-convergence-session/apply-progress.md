# Apply Progress: Extension Sync Convergence Session

## Cumulative Status

30/40 semantic tasks complete; native checkbox progress is 13/23. Legacy PR1a–PR3, PR4h/PR4h2, create/delete ownership, and PR4a0a are complete. Delivery remains stacked-to-`develop`, no `size:exception`.

## PR4a0a Generic Receipt Ledger

- [x] 12.1 RED: PostgreSQL receipt tests first failed to compile because `SafeResult` could not carry semantic headers or a fixed acknowledgement cursor.
- [x] 12.2 GREEN: migration `000008` permits completed 200/201 receipts and nullable semantic headers/cursor; the executor persists/replays them under the existing lock, conflict, rollback, and 24-hour cleanup behavior. No PATCH route, event, cursor mutation, or extension code changed.

## PR3 Dormant Journal

- [x] 7.1 RED: `convergence.test.mjs` first failed because the pure module did not exist; it now proves planner, queue, cap, migration, and restart ambiguity.
- [x] 7.2: Added a version-1 per-projection journal and normalization while leaving the engine dormant.

## PR4h and PR4h2 Deterministic Chrome Harness

- [x] 8.1 RED: `timeout 15s node --test tests/chrome-harness.test.mjs` first failed with `ERR_MODULE_NOT_FOUND` for the helper.
- [x] 8.2 GREEN: added neutral fake Chrome bookmarks/storage/runtime, deterministic mutator scheduling, persisted revival, fetch recording, and explicit teardown self-tests.
- [x] 9.1–9.2: hardened the fake Chrome lifecycle, delayed queues, cloning, listener removal, and teardown proof.

## PR4a1a Create Ownership

- [x] 10.1–10.2: durable `started` create ownership, callback correlation, final-shape verification, bounded completed ownership, and create regression evidence are complete.

## PR4a1a Delete Ownership

- [x] 11.1 RED: `tests/delete-ownership.test.mjs` first failed with no delete operation; it covers folder/bookmark `started` persistence, early/delayed/duplicate/reordered/restart callbacks, absence plus mapping/type cleanup, cascade descendants, ambiguity, isolation, unmatched local deletes, and capacity.
- [x] 11.2 GREEN: persisted bounded delete ownership before `remove`/`removeTree`; listener ownership is checked before transient suppression; finalization requires node absence and cleanup proof, otherwise pauses `ambiguous-operation`.

## Work Unit Evidence

| Evidence | Exact result |
|---|---|
| PR3 RED/GREEN | `npm run build && node --test tests/convergence.test.mjs`: missing-module RED, then PASS 4/4. |
| PR3 storage/projection | `node --test tests/convergence.test.mjs tests/storage-serialization.test.mjs tests/projection-behavior.test.mjs`: PASS 40/40. |
| Focused GREEN | `timeout 15s node --test tests/chrome-harness.test.mjs`: PASS, 7/7; 0 skipped, 0 open handles. |
| Full extension | `timeout 30s npm run test:projection`: PASS, 62/62; 0 skipped. |
| Typecheck/build | `npm run typecheck && npm run build`: PASS. |
| Runtime/manual | N/A — deterministic Node harness is the runtime boundary; Chromium is not applicable. |
| Rollback | Remove `extension/tests/helpers/fake-chrome.mjs`, `extension/tests/chrome-harness.test.mjs`, and this progress entry; no production path changed. |
| PR4a1a-delete RED/GREEN | `npm run build && node --test tests/delete-ownership.test.mjs`: RED (4 failing assertions before implementation), then PASS 9/9. |
| PR4a1a-delete regressions | `node --test tests/create-ownership.test.mjs tests/convergence.test.mjs tests/projection-behavior.test.mjs`: PASS 54/54; `npm run typecheck && npm run test:projection`: PASS 90/90. |
| PR4a1a-delete runtime/rollback | Deterministic fake-Chrome callbacks/restart are the runtime boundary; rollback `projection.ts`, `types.ts`, `delete-ownership.test.mjs`, and these task/progress entries. |
| PR4a0a RED | `cd backend && go test ./internal/httpapi`: FAIL before implementation (`SafeResult.Headers` and `AckCursor` undefined). |
| PR4a0a focused/runtime GREEN | PostgreSQL harness: `go test ./internal/httpapi ./internal/sync`: PASS; covers 200 body/header/cursor replay, conflict, concurrent lock/in-progress, rollback/retry, 24-hour cleanup, and retained 201 creation. |
| PR4a0a full/quality/rollback | PostgreSQL-backed `go test ./...`: PASS; `go vet ./...` and `git diff --check`: PASS. Roll back migration/executor/tests together; remove or expire all 200 receipts before restoring the old 201-only constraint. |

## Next

PR4a0b complete-shape integration. Follow-up: `create-ownership.test.mjs` has a minor assertion weakness and is intentionally unchanged in this unit.
