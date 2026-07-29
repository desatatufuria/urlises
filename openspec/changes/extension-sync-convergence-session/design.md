# Design: Extension Sync Convergence Session

## Technical Approach

Keep PR4a0a (`0a9bf44`) and PR4a0a2 (`d9c63b6`) unchanged. PR4a0a3a remains prepare-only and PR4a0a3b apply-only; PR4a0b remains the first route boundary. Correct PR4a0a3a by discovering tentative sibling scopes without locks, acquiring those scopes before every row lock, then refusing/retrying scope drift after locked revalidation. This removes the proven target-first opposite-move cycle while retaining complete-shape preparation.

## Architecture Decisions

| Option | Tradeoff | Decision / rationale |
|---|---|---|
| Target row before advisory scopes | Proven opposite moves cycle | Reject. A target holder can wait for the common scope while its peer holds it and waits on the other target/siblings. |
| Workspace-wide advisory lock | Safe but serializes unrelated sibling moves | Reject. It broadens contention beyond the affected collections. |
| Optimistic scope discovery, sorted locks, locked revalidation | A concurrent move can retry | Choose. It locks only affected scopes and never uses a stale target as authority. |
| Re-lock changed scopes after target lock | Reintroduces lock-order inversion | Reject. Scope drift aborts the transaction; the executor retries from discovery. |

## Lock and Data Flow

```text
snapshot target (read only) -> derive source + destination scope keys
  -> advisory keys sorted, deduplicated -> target row FOR UPDATE
  -> rederive/compare keys -> sibling rows FOR UPDATE ORDER BY position,id
  -> authorize/contain/ancestry -> canonical final shape -> PreparedPatch
```

For a folder, a scope key is `(folder, workspaceID, parentID-or-root)`; for a bookmark it is `(bookmark, workspaceID, folderID)`. The read-only snapshot supplies the source; the requested parent/folder (or unchanged source) supplies destination. Reject absent/invalid target input before locking. Sort the two keys lexically by `(kind, workspaceID, parent-or-folder)` and acquire each transaction advisory lock once when equal.

After scopes, lock the target with `FOR UPDATE`, then lock the union of source/destination sibling rows in deterministic scope order and `ORDER BY position,id` within each scope. Thus every prepare has one order: advisory scopes, target, sibling rows; shared scopes serialize opposite targets before either target row is held. The locked target is the authority: rederive source and destination keys from it and the request. If either key differs from discovery, return a private retryable `prepare scope drift` error, roll back, and restart the whole `ExecutePrepared` transaction; do not acquire another lock in that transaction. Revalidate workspace write authorization, destination containment, and folder non-descendancy from locked rows before trim/validate/clamp/full-shape normalization and fingerprinting. Prepare writes no resource, ordering, event, or cursor data.

## Interfaces / Contracts

`PrepareFolderPatchTx` and `PrepareBookmarkPatchTx` retain caller `pgx.Tx` ownership and return immutable `PreparedPatch` only after locked canonicalization. `ApplyPrepared*PatchTx` consumes that exact state in the same transaction and adds no prepare/lock path. Legacy `Update*` remains compatible; PR4a0b alone adapts `ExecutePrepared` and invokes returned publishing after commit.

## File Changes and Tests

| Slice | Candidate files | PostgreSQL RED coverage |
|---|---|---|
| PR4a0a3a | `backend/internal/bookmarks/{service.go,service_integration_test.go}`; `backend/internal/sync/{types.go,service.go,postgres.go,postgres_integration_test.go}` | Two opposite moves sharing both scopes: one blocks at first sorted advisory lock, both complete after release, no `40P01`. Same-scope move locks once and blocks. Concurrent target/source or destination-scope drift yields retryable error, rollback, then a clean retry; no stale shape. Assert prepare has zero resource/order/event/cursor writes. |
| PR4a0a3b | Same service/store tests | Same-tx prepared apply, exact mutation/one event-cursor or no-op zero writes, rollback, returned-not-invoked publisher, legacy compatibility. |
| PR4a0b | `backend/internal/sync/{bookmark_routes.go,bookmark_routes_test.go,headers.go,postgres_integration_test.go}` | Existing adapter/replay/conflict/post-commit-publisher coverage only; no lock-algorithm change. |

Use separate PostgreSQL transactions, start/release channels, and bounded contexts; assert the blocked goroutine does not finish before release and both finish afterward. Run `cd backend && go test ./internal/bookmarks ./internal/sync` when database URLs are available.

## Migration / Rollout

No migration. PR4a0a3a and PR4a0a3b remain inert and independently reversible; no spec amendment is required.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary changes.

## Open Questions

None. `sdd-tasks` MUST amend 13b.1/13b.2 wording before apply to replace target-before-scope with discovery, sorted scopes, locked revalidation, and retry-on-drift.
