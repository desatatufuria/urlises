# Design: Extension Sync Convergence Session

## Technical Approach

**Split decision:** under `auto-chain` / stacked-to-main, replace PR4a0a3a with **PR4a0a3a.1 scope-lock kernel** then **PR4a0a3a.2 canonical prepared adapters**. The 267-line discarded candidate plus the 136-line proof lower bound makes one <=400-line slice impossible. Keep PR4a0a/PR4a0a2, PR4a0a3b apply, PR4a0b routes, and extension phases unchanged. Capture apply-progress SHA-256 `c3e23f05ba8f71e1b800c3508232ff3f25ad1dfae23a6f3c53b840c5c745ee79`; this phase must not alter it.

## Architecture Decisions

| Option | Tradeoff | Decision / rationale |
|---|---|---|
| One prepare slice | At least 403 authored lines | Reject: exceeds the non-exception cap. |
| Separate folder/bookmark locking | Duplicates a concurrency invariant | Reject: drift risks divergent lock order. |
| Shared `sync` kernel, then adapters | First slice is intentionally inert | Choose: `.1` owns the shared `sync` kernel in `backend/internal/sync/postgres.go`, with its proof in `backend/internal/sync/postgres_integration_test.go`; one owner preserves one ordering rule. |
| Workspace-wide lock / target-first lock | Over-serialization / proven opposite-move cycle | Reject. |

## Data Flow

```text
read-only target -> source/destination ScopeKey -> sorted, deduped advisory locks
-> target FOR UPDATE -> locked scope comparison -> sibling rows (position,id)
-> adapter validation/canonical shape/fingerprint -> immutable PreparedPatch
```

`ScopeKey` is `(kind, workspaceID, parentID-or-root/folderID)`. Drift returns a typed retryable error, rolls back the whole prepared transaction, and retries from discovery; no scope is acquired after a row lock. This preserves scope-first semantics without resource/order/event/cursor writes.

## Sub-slices

| Slice | Start -> end / exact dependency | Interfaces and candidate files | Owned RED/GREEN proof; estimate + reserve | Rollback / exclusions |
|---|---|---|---|---|
| **PR4a0a3a.1 kernel** | PR4a0a2 -> inert, reusable PostgreSQL scope-lock/revalidation kernel. Depends only on PR4a0a2. | Internal `ScopeKey`, sorted/deduped `lockScopesTx`, `PrepareScopeDriftError`, `IsRetryablePrepareError`, and snapshot/revalidation seam in `backend/internal/sync/postgres.go`; tests in `backend/internal/sync/postgres_integration_test.go`. | RED/GREEN: deterministic opposite moves sharing scopes block/release without `40P01`; same scope locks once; target/source/destination drift is typed retryable and rolls back; no post-row-lock scope acquisition; no writes. **220 + 150 = 370**. | Revert kernel/tests only. Excludes `PreparedPatch`, normalization, auth/containment/ancestry, fingerprint, sync store, routes, events/cursors, and apply. |
| **PR4a0a3a.2 adapters** | Kernel -> immutable folder and bookmark prepared adapters; depends exactly on merged PR4a0a3a.1. | `PrepareFolderPatchTx` / `PrepareBookmarkPatchTx` consume the kernel in `bookmarks/service.go`; canonical `PreparedPatch` and store-facing adapters in `sync/{types.go,service.go,postgres.go}`; integration tests in both package test files. | RED/GREEN: external `pgx.Tx`; locked auth, containment, ancestry; trim/URL/position normalization; complete final shape, stable fingerprint, and no-op; legacy `Update*` compatibility; prepare zero resource/order/event/cursor writes. Kernel concurrency tests are not duplicated. **240 + 140 = 380**. | Revert adapters/tests only; kernel remains inert and safe. Excludes apply, `ExecutePrepared` route wiring, publisher invocation, HTTP idempotency, migrations, extension. |

## Interfaces / Contracts

The kernel is internal to `sync`; adapters must not reimplement scope ordering. `Prepare*PatchTx(ctx, tx pgx.Tx, ...)` retains caller transaction ownership and returns immutable state only after locked revalidation. Its retryable drift classification is private to prepare/executor integration. `ApplyPrepared*PatchTx`, route adaptation, event/cursor creation, and publishing remain PR4a0a3b/PR4a0b work.

## Testing Strategy

Use the existing isolated-schema PostgreSQL integration harness with `BOOKMARKS_TEST_DATABASE_URL`, `SYNC_TEST_DATABASE_URL`, and `DATABASE_URL` at `postgres:5432`; use separate transactions, release channels, bounded contexts, and `testing.Short()` skips. Run `cd backend && go test ./internal/bookmarks ./internal/sync`. Slice .1 owns deadlock/drift/no-write proof; .2 owns canonical domain proof.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/sync/postgres.go` | Modify | .1 scope-lock/revalidation kernel. |
| `backend/internal/sync/postgres_integration_test.go` | Modify | .1 kernel proof. |
| `backend/internal/sync/{types.go,service.go,postgres.go}` | Modify | .2 canonical adapter types only. |
| `backend/internal/sync/postgres_integration_test.go` | Modify | .2 bookmark/store proof. |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary changes.

## Migration / Rollout

No migration required. Each inert sub-slice is independently reversible.

## Open Questions

None. `sdd-apply` must execute PR4a0a3a.2 canonical folder/bookmark adapters; retain all later phases unchanged.
