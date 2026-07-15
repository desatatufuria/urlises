# Design: Extension Sync Convergence Session

## Technical Approach

Keep Slice A, integrated PR4a0a (`0a9bf44`), completed create/delete behavior, and the exact executor transaction model and lock order unchanged. The reverted combined PR4a0a2 is split into two independently reversible foundations before PR4a0b. No PATCH behavior changes until PR4a0b integrates both.

## Architecture Decisions

| Decision | Alternatives considered | Rationale |
|---|---|---|
| Split executor from domain preparation | Restore combined PR4a0a2 | The combined executor, lock harness, and external-transaction seam cannot retain correction reserve under 400 lines. |
| Prepare inside executor transaction | Pre-read fingerprint; route-owned receipt transaction | Canonical position and authorization depend on locked server state. Pre-read is stale; route ownership duplicates receipt semantics. |
| Sort sibling scope locks | Target-row lock; query-order locks | Opposing moves need a stable source/destination ordering to avoid deadlock. |

## Delivery Chain and Boundaries

`PR4a0a → PR4a0a2 → PR4a0a3 → PR4a0b → PR4a1 → PR4a2 → PR4a3 → PR4b`

| Slice | Estimate / reserve | Includes | Explicitly excludes | Rollback |
|---|---:|---|---|---|
| PR4a0a2 — executor foundation | 180–240 / >=100 | `httpapi` prepared executor and PostgreSQL tests | sync, bookmarks, routes, publisher invocation, migration | Remove unused generic API/tests; PR4a0a remains. |
| PR4a0a3 — domain transaction foundation | 240–310 / >=90 | bookmarks/sync tx prepare/apply seam and lock tests | idempotency executor changes, routes, publisher invocation, migration | Remove unused domain seam/tests; legacy `Update*` remains. |
| PR4a0b — route integration | 250–300 / >=100 | PATCH route adaptation, response headers, post-commit publisher invocation | extension and migration | Restore legacy PATCH routing; both foundations remain unused. |

## Interfaces / Contracts

PR4a0a2 adds the generic contract only:

```go
type IdempotencyScope struct { PrincipalID, Method, Route, Key string }
type PostCommit func(context.Context) error
type Prepared struct {
    Fingerprint string
    Command func(context.Context, pgx.Tx) (SafeResult, PostCommit, error)
}
type Prepare func(context.Context, pgx.Tx) (Prepared, error)
func (e *IdempotencyExecutor) ExecutePrepared(
    context.Context, IdempotencyScope, Prepare,
) (SafeResult, IdempotencyOutcome, PostCommit, error)
```

It owns validation, `Begin`/rollback/commit, the receipt-scope advisory lock, receipt decision/completion, safe response validation, replay/conflict/in-progress handling. `Execute` becomes a source-compatible adapter through the same receipt primitives; existing 201 behavior remains covered. `Prepare` may read, lock, authorize, validate containment, normalize, and fingerprint; it must not mutate or publish. `Command` mutates only in that supplied transaction and returns an optional post-commit closure.

PR4a0a3 owns a sync/bookmarks `PreparedPatch` value and `Prepare*PatchTx`/`ApplyPrepared*PatchTx` operations, not HTTP route wiring. Its value carries the canonical fingerprint plus an apply closure/result that PR4a0b adapts to `httpapi.Prepared`; this keeps `sync` independent of HTTP receipt policy and makes either foundation removable while unused. It must never call `runMutation` or `PostgresStore.Update*`, which begin independent transactions.

## Data Flow

```text
PR4a0b adapter -> ExecutePrepared scope lock
  -> PR4a0a3 Prepare*PatchTx -> target FOR UPDATE -> workspace auth/containment
  -> sorted sibling-scope advisory locks -> sibling rows FOR UPDATE -> normalize/fingerprint
  -> receipt replay/conflict or ApplyPrepared*PatchTx -> receipt completion -> commit
  -> route invokes post-commit publisher only for a created mutation
```

Lock order is fixed: (1) non-blocking receipt scope `(principal, method, route+resource, key)`; (2) target folder/bookmark `FOR UPDATE`; (3) derive workspace and require write access; (4) validate target parent/folder and folder ancestry; (5) blocking affected sibling-scope advisory locks sorted by `(kind, workspaceID, parentID-or-root)`, once if equal; (6) sibling rows `FOR UPDATE ORDER BY position,id`; (7) clamp/normalize and fingerprint. Authorization and containment precede receipt lookup.

## File Changes and Tests

| Slice | Exact files | PostgreSQL RED coverage |
|---|---|---|
| PR4a0a2 | `backend/internal/httpapi/idempotency.go`; `backend/internal/httpapi/idempotency_test.go`; `backend/internal/httpapi/idempotency_integration_test.go` | Same executor transaction; authorization/prepare before receipt lookup; replay and fingerprint conflict; rollback removes receipt/domain work; returned post-commit hook; existing 201 `Execute` compatibility. |
| PR4a0a3 | `backend/internal/bookmarks/service.go`; `backend/internal/bookmarks/service_integration_test.go`; `backend/internal/sync/types.go`; `backend/internal/sync/service.go`; `backend/internal/sync/postgres.go`; `backend/internal/sync/postgres_integration_test.go` | External `pgx.Tx` prepare/apply; target and sibling `FOR UPDATE`; authorization/containment; normalization; sorted scopes; opposite-move deadlock harness. |
| PR4a0b | `backend/internal/sync/bookmark_routes.go`; `backend/internal/sync/bookmark_routes_test.go`; `backend/internal/sync/headers.go`; `backend/internal/sync/postgres_integration_test.go` | Complete-shape no-op/replay/conflict, stable acknowledgement, no event/cursor/publish for no-op, and one event/cursor/publish for mutation. |

## Migration / Rollout

No migration follows integrated `000008_sync_patch_idempotency.sql`. PR4a0a2 and PR4a0a3 are unused foundations; neither alters external behavior. PR4a0b alone exposes durable PATCH acknowledgement behavior. No spec amendment is required.

## Threat Matrix

N/A — no shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Open Questions

None. Next phase: sdd-tasks updates the delivery plan only.
