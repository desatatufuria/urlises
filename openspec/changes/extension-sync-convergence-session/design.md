# Design: Extension Sync Convergence Session

## Technical Approach

Keep Slice A, integrated PR4a0a (`0a9bf44`), the extension redesign, and completed create/delete behavior unchanged. Insert autonomous **PR4a0a2** before PR4a0b: it makes the generic receipt executor prepare a PATCH only inside its executor-owned transaction. PR4a0b then wires folder/bookmark routes to that prepared path. Equal complete shapes persist/replay a 200 acknowledgement without domain/order/event/cursor work; unequal shapes do one update/event/cursor.

## Architecture Decisions

| Decision | Alternatives considered | Rationale |
|---|---|---|
| Generalize `idempotency_records` for PATCH 200 receipts | A `sync_noop_receipts` table; encoding a receipt in `sync_events` | Reuse the existing principal/key/route/fingerprint ledger, TTL cleanup, advisory first-writer lock, safe response storage, and conflict semantics. `sync_events` is invalid because recording it allocates a cursor. A dedicated table duplicates that model. |
| Bind receipt to canonical complete shape | Raw PATCH JSON | Partial PATCH bodies cannot distinguish equivalent final state from incompatible reuse. The fingerprint hashes route, resource ID, and normalized final folder `{parentId,name,position}` or bookmark `{folderId,title,url,position}`. |
| Prepare inside the executor transaction | Route-owned receipt transaction; pre-read fingerprint then revalidate | `Execute` currently requires its fingerprint before `Begin`, while `runMutation` starts another transaction and always records an event. A pre-read can be stale/unauthorized and cannot canonically normalize concurrent siblings; route ownership would duplicate the existing lock, receipt, replay, and rollback primitives. |
| Serialize affected sibling lists by ordered advisory scope locks | Target-row lock only; unordered sibling row updates | Current `Update*Tx` reads target/siblings without `FOR UPDATE` and reorders sequentially. A target lock cannot serialize two resources moving across the same lists. |

## Backend PATCH Idempotency Amendment — PR4a0a2 then PR4a0b

`X-Sync-Event-Id` remains the PATCH idempotency key (a generated key is returned when absent). Its scope is `(principal_id, PATCH, route-template + resource ID, key)`; the final-shape fingerprint includes the resource binding, so a key cannot cross user, route, or resource boundaries. The generic ledger is extended to retain `response_status`, canonical JSON body, semantic response headers, and nullable `ack_cursor`; the receipt expires under the current 24-hour terminal-record cleanup policy.

For a no-op, store status `200`, the canonical resource body, `X-Sync-Event-Id`, and the selected `X-Sync-Cursor`; derive `X-Sync-Duplicate` on replay rather than storing a stale first/replay marker. `ack_cursor` is read from the workspace's current cursor in the receipt transaction and stored permanently. It therefore does not advance, and later workspace events cannot change an acknowledgement already issued.

PR4a0a already generalized completed records to safe `200`/`201`; no migration follows it. The exact additive executor API is:

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

`ExecutePrepared` owns scope validation, `Begin`/rollback/commit, advisory scope lock, receipt lookup/insert/update, safe-response validation, and replay/conflict/in-progress errors. `Prepare` owns only read/lock/authorize/containment/normalization and returns the canonical fingerprint plus a no-op or mutation command; it MUST NOT mutate or publish. Command owns domain/event/cursor work and returns its response and optional publisher closure. The closure is returned only after commit and the route invokes it only for a created real mutation; a publisher failure is reported after durable commit and retry replays the receipt without a second event. Domain errors from prepare/command are returned to the route's existing error mapper; executor/receipt errors remain HTTP idempotency errors. Existing `Execute(identity, authorize, command)` remains source-compatible: implement it as an adapter that supplies a `Prepare` calling `authorize`, uses `identity.Fingerprint`, returns the old command, discards a nil post-commit hook, and reuses the same private receipt decision/completion helpers rather than copying them.

## Data Flow

```text
PATCH + event key
  -> executor scope advisory lock -> Prepare: target FOR UPDATE
  -> derive server workspace -> authorize -> containment/ancestry
  -> ordered sibling-scope locks -> lock/read siblings -> normalize -> fingerprint
  -> existing receipt?
       same shape: replay stored 200/body/headers/cursor (no event)
       different shape: 409 idempotency_key_conflict (no mutation)
       absent: equal? store receipt + current cursor -> 200 (no event)
                unequal? update + record one event/cursor -> store 200 result
  -> commit; publish only the real mutation's event
```

The precise lock order is: (1) non-blocking receipt scope advisory lock `(principal, method, route+resource, key)`; (2) target folder/bookmark `FOR UPDATE`; (3) derive its workspace and require write access; (4) lock/validate target parent/folder and folder ancestry; (5) take blocking transaction advisory locks for every affected ordering scope, sorted by stable `(kind, workspaceID, parentID-or-root)` key—source then destination after sorting, once when equal; (6) select every sibling in each scope `FOR UPDATE ORDER BY position,id`; (7) normalize/clamp position and fingerprint. The apply command uses those prepared locked IDs/order, never rereads an unlocked list. This prevents opposing moves from taking sibling locks in different orders. Authorization and containment deliberately precede receipt lookup, so revoked or cross-workspace callers cannot replay stored bodies/cursors.

`sync.PostgresStore` gains tx-taking prepared PATCH operations (for example `PrepareFolderPatchTx`/`PrepareBookmarkPatchTx` and `ApplyPrepared*PatchTx`) and returns an event-backed post-commit publisher closure only for a mutation. The sync `Store`/`Service` seam exposes this narrow path to routes. It is forbidden for executor callbacks to call `PostgresStore.Update*` or `runMutation`: both call `pool.Begin` and would create a nested independent transaction. Bookmark helpers factor target load, validation, normalization, and locked sibling ordering so `Update*Tx` remains the legacy public path and create/delete remain unchanged.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/httpapi/idempotency.go` | Modify (PR4a0a2) | Add `IdempotencyScope`, `Prepared`, `Prepare`, `PostCommit`, `ExecutePrepared`; factor shared receipt primitives; retain `Execute`. |
| `backend/internal/httpapi/idempotency_integration_test.go` | Modify (PR4a0a2) | Prove executor-tx preparation, first-writer/in-progress, auth-before-receipt, and atomic rollback. |
| `backend/internal/bookmarks/service.go` | Modify (PR4a0a2) | Add locked canonical prepare/apply helpers and deterministic sibling lock/read ordering. |
| `backend/internal/sync/{types,service,postgres}.go` | Modify (PR4a0a2) | Define and implement the external-`pgx.Tx` prepared PATCH seam; no route use yet. |
| `backend/internal/sync/{bookmark_routes,headers}.go` | Modify (PR4a0b) | Use `ExecutePrepared`, emit stored headers, and invoke post-commit publishing only for mutations. |
| `backend/internal/{bookmarks, sync}/{service,postgres,bookmark_routes}_test.go` | Modify (split) | Foundation lock/normalization tests in PR4a0a2; end-to-end PATCH receipt tests in PR4a0b. |

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| PR4a0a2 integration | executor tx identity; prepare-only behavior; auth-before-receipt; rollback; ordered opposite moves | Assert no prepare mutation/publication, one first writer, no receipt/domain residue on failure, and no lock-order deadlock. |
| PR4a0b route/PostgreSQL | partial canonical shape, same-key replay/conflict, later-event-stable ack, no-op, mutation | Assert no-op has no event/cursor/publish; mutation has exactly one event/cursor/publish; revoked/cross-workspace cannot replay. |
| Regression | Existing 201 creation and create/delete paths | Assert `Execute` compatibility and untouched `runMutation` behavior. |

## Migration / Rollout

No migration is required beyond integrated `000008_sync_patch_idempotency.sql`. A crash/response loss after commit replays the completed receipt; before commit (including receipt completion failure) rolls back resource reorder, event, cursor, and receipt. The first same-scope writer holds the advisory lock; contenders receive in-progress and retry. Rollback PR4a0a2 removes its unused API/seam without touching PR4a0a. Rollback PR4a0b restores existing PATCH routing; do not restore a 201-only constraint until 200 receipts expire or are removed.

## Scope, Delivery, and Open Questions

PR4a0a2 is autonomous: **300–340 authored lines**, reserve **60–100**; it adds unused prepared infrastructure and tests only. PR4a0b is complete-shape route integration: **250–300**, reserve **100–150**. Neither alters extension work or completed create/delete. Threat matrix: N/A — no shell, subprocess, VCS/PR automation, executable classification, or process-integration boundary.

No spec amendment is required: the delta already requires durable same-key acknowledgement, incompatible-reuse rejection, and no event/cursor advance. Next phase: revise tasks to insert PR4a0a2 before PR4a0b.
