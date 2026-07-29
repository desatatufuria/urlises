# Design: Extension Sync Convergence Session

## Technical Approach

Keep integrated PR4a0a (`0a9bf44`) and PR4a0a2 (`d9c63b6`) unchanged. The reverted 395-production-line PR4a0a3 is split at the prepared-state-machine boundary, not by folder versus bookmark: PR4a0a3a canonically prepares immutable locked state; PR4a0a3b applies only that state. PR4a0b is the first route-visible integration.

## Architecture Decisions

| Decision | Alternatives considered | Rationale |
|---|---|---|
| Prepare before apply | Combined PR4a0a3 | Measured size left no test/correction reserve. The split preserves one transaction and one lock algorithm. |
| Split by state-machine boundary | Folder PR then bookmark PR | Both entities share sibling locks and complete-shape normalization; entity splits duplicate and can diverge in those safety rules. |
| Immutable prepared value | Re-read/re-normalize during apply | Apply must use the exact locked canonical state and cannot introduce a second lock or normalization path. |

## Delivery Chain and Boundaries

`PR4a0a → PR4a0a2 → PR4a0a3a → PR4a0a3b → PR4a0b → PR4a1 → PR4a2 → PR4a3 → PR4b`

| Slice | Estimate / reserve | Includes | Explicitly excludes / independent rollback |
|---|---:|---|---|
| PR4a0a2 — executor foundation | 180–240 / >=100 | Integrated generic `ExecutePrepared` transaction owner | Already integrated; unchanged. |
| PR4a0a3a — prepare canonical state | 280–350 / >=50 | `PreparedPatch`; external-`pgx.Tx` folder/bookmark prepare methods; target/sibling locking and canonical final shape | No resource/order/event/cursor mutation, routes, publisher, HTTP idempotency, migration. Revert only prepare API/tests; legacy `Update*` remains. |
| PR4a0a3b — apply prepared state | 220–300 / >=100 | Apply the prepared state, event/cursor result and rollback proofs | No prepare/lock algorithm changes, routes, HTTP idempotency, migration, publisher invocation. Revert apply API/tests; PR4a0a3a remains unused. |
| PR4a0b — route integration | 250–300 / >=100 | Adapt `ExecutePrepared` + prepare + apply; invoke returned publisher after commit | No extension or migration. Restore legacy PATCH routing; both foundations remain unused. |

## Interfaces / Contracts

PR4a0a2 owns receipt locking, begin/rollback/commit, receipt completion, and returned `PostCommit`; `Prepare` never mutates or publishes. PR4a0a3a adds a sync-domain immutable `PreparedPatch` containing the canonical fingerprint, target identity/kind, locked transaction identity as feasible, complete final resource shape, deterministic sibling ordering/positions, no-op status, and data required to construct later event/cursor/publisher output.

`PrepareFolderPatchTx` and `PrepareBookmarkPatchTx` accept the caller's `pgx.Tx`, principal, target, and update input and return `PreparedPatch`; they never begin/commit a transaction. `ApplyPreparedFolderPatchTx` and `ApplyPreparedBookmarkPatchTx` accept that same `pgx.Tx` and prepared value, validate transaction/locked target identity as feasible, and return the mutation result plus publisher data without invoking it. Neither layer calls `runMutation` or `PostgresStore.Update*`, which create independent transactions. Legacy `Update*` behavior stays compatible.

## Data Flow

```text
PR4a0b -> ExecutePrepared (one tx / receipt lock)
  -> Prepare*PatchTx: target FOR UPDATE -> workspace/auth/containment/ancestry
  -> sorted sibling-scope advisory locks -> sibling rows FOR UPDATE ORDER BY position,id
  -> trim, validate, clamp, normalize full shape -> fingerprint -> PreparedPatch
  -> ApplyPrepared*PatchTx: no-op OR exact resource/order + one event/cursor
  -> receipt completion -> commit -> route invokes returned publisher
```

The lock sequence remains exact: receipt scope; target `FOR UPDATE`; workspace/write authorization; parent/folder containment and folder ancestry; affected source/destination sibling-scope advisory locks sorted by `(kind, workspaceID, parentID-or-root)` (once when equal); then sibling rows `FOR UPDATE ORDER BY position,id`. Prepare trims and validates names/URLs, clamps position, and normalizes the full final folder/bookmark shape before fingerprinting. Opposite moves block rather than deadlock.

## File Changes and Tests

| Slice | Candidate files | PostgreSQL RED coverage |
|---|---|---|
| PR4a0a3a | `backend/internal/bookmarks/service.go`; `backend/internal/bookmarks/service_integration_test.go`; `backend/internal/sync/types.go`; `backend/internal/sync/service.go`; `backend/internal/sync/postgres.go`; `backend/internal/sync/postgres_integration_test.go` | External tx prepare, target/sibling `FOR UPDATE`, authorization/containment/ancestry, sorted scopes, lock blocking/opposite moves, normalization/fingerprint, and no mutation of resource/order/event/cursor. |
| PR4a0a3b | Same service/postgres files and focused integration tests | Same-tx/locked-identity validation as feasible; no-op writes zero resource/order/event/cursor rows; mutation writes exact prepared state and exactly one event/cursor; rollback removes all; legacy `Update*` compatibility; publisher data returned, never invoked. |
| PR4a0b | `backend/internal/sync/bookmark_routes.go`; `backend/internal/sync/bookmark_routes_test.go`; `backend/internal/sync/headers.go`; `backend/internal/sync/postgres_integration_test.go` | Adapter, stable acknowledgement/replay/conflict, and post-commit publisher invocation only for created mutation. |

## Migration / Rollout

No migration. PR4a0a3a and PR4a0a3b are inert, independently reversible foundations; PR4a0b exposes behavior. No spec amendment is required.

## Threat Matrix

N/A — no shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Open Questions

None. Next phase: sdd-tasks updates delivery work units only.
