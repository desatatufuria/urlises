# Design: Extension Sync Convergence Session

## Technical Approach

Keep Slice A and completed create/delete behavior unchanged. PR4a0 makes PATCH update/move convergence safe by recognizing the requested **complete final shape** before mutation. Equality returns a durable 200 acknowledgement; it never changes a folder/bookmark or ordering, inserts/publishes a `sync_events` record, or advances `workspace_cursors`. Persisting that acknowledgement is required and is not a sync mutation.

## Architecture Decisions

| Decision | Alternatives considered | Rationale |
|---|---|---|
| Generalize `idempotency_records` for PATCH 200 receipts | A `sync_noop_receipts` table; encoding a receipt in `sync_events` | Reuse the existing principal/key/route/fingerprint ledger, TTL cleanup, advisory first-writer lock, safe response storage, and conflict semantics. `sync_events` is invalid because recording it allocates a cursor. A dedicated table duplicates that model. |
| Bind receipt to canonical complete shape | Raw PATCH JSON | Partial PATCH bodies cannot distinguish equivalent final state from incompatible reuse. The fingerprint hashes route, resource ID, and normalized final folder `{parentId,name,position}` or bookmark `{folderId,title,url,position}`. |
| Run both PATCH outcomes through the receipt transaction | Probe then existing mutation | One transaction prevents a same-key/different-shape request from slipping between no-op detection and mutation. The real mutation retains its current result: exactly one event and cursor increment. |

## PR4a0 Receipt Contract

`X-Sync-Event-Id` remains the PATCH idempotency key (a generated key is returned when absent). Its scope is `(principal_id, PATCH, route-template + resource ID, key)`; the final-shape fingerprint includes the resource binding, so a key cannot cross user, route, or resource boundaries. The generic ledger is extended to retain `response_status`, canonical JSON body, semantic response headers, and nullable `ack_cursor`; the receipt expires under the current 24-hour terminal-record cleanup policy.

For a no-op, store status `200`, the canonical resource body, `X-Sync-Event-Id`, and the selected `X-Sync-Cursor`; derive `X-Sync-Duplicate` on replay rather than storing a stale first/replay marker. `ack_cursor` is read from the workspace's current cursor in the receipt transaction and stored permanently. It therefore does not advance, and later workspace events cannot change an acknowledgement already issued.

The existing completed-record constraint and executor's 201-only guard are generalized to permit safe `200` and `201` responses; existing create records remain valid. No new general PATCH API is introduced: only folder/bookmark PATCH use this capability in PR4a0.

## Data Flow

```text
PATCH + event key
  -> key advisory lock -> authorize + lock/load resource
  -> derive complete target -> fingerprint -> existing receipt?
       same shape: replay stored 200/body/headers/cursor (no event)
       different shape: 409 idempotency_key_conflict (no mutation)
       absent: equal? store receipt + current cursor -> 200 (no event)
                unequal? update + record one event/cursor -> store 200 result
  -> commit; publish only the real mutation's event
```

The implementation factors the current sync PATCH transaction so the idempotency executor owns the transaction and the store performs authorization, canonical load/target calculation, and either update/event recording inside it. Lock order is idempotency advisory key, then resource row; concurrent first writers for the same key receive the existing in-progress conflict and retry. A committed no-op survives a response-loss/crash and replays exactly. A pre-commit failure rolls back both resource work and receipt. Post-commit publisher failure retains the existing mutation retry behavior; no-op never calls the publisher.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/migrations/000008_sync_patch_idempotency.sql` | Create | Generalize terminal receipt constraint and add response-header/ack-cursor storage compatibly. |
| `backend/internal/httpapi/idempotency.go` | Modify | Permit safe 200 receipts and preserve semantic headers/cursor through replay. |
| `backend/internal/sync/{types,headers,service,postgres,bookmark_routes}.go` | Modify | Route PATCH through the transactional complete-shape receipt path; publish only real events. |
| `backend/internal/sync/{bookmark_routes,postgres}_test.go` | Modify | Cover contract and PostgreSQL persistence/races. |

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Route | Folder/bookmark name/title, URL, parent/folder, and position equality | Assert 200 canonical body, stable event/cursor headers, no event publication, and no cursor advance. |
| Integration | Same key/shape, changed final shape, later workspace events, and concurrent first writers | Assert replayed stored receipt; 409 before mutation; stored ack cursor remains old; one winner/no event for equal shape. |
| Regression | Unequal PATCH | Assert current one-event/one-cursor behavior and existing create/delete idempotency remains 201. |

## Migration / Rollout

Migration is additive except replacing the too-narrow completed-response check; it accepts existing 201 rows and allows nullable new fields for them. Rollback deploys code first/last safely: old code ignores added columns, while retained 200 receipts are inert if rollback restores the prior constraint only after those records expire or are removed. Access is rechecked before ledger lookup; resource workspace is derived server-side, preventing cross-workspace key or cursor disclosure. Log only route/resource IDs, disposition, and cursor—not bodies or keys.

## Scope, Delivery, and Open Questions

PR4a0 remains autonomous: estimated **360–390 authored lines** including migration, focused tests, and design artifact update. It must not alter extension receipt/outbox work or completed create/delete paths. Threat matrix: N/A — no shell, subprocess, VCS/PR automation, executable classification, or process-integration boundary.

No spec amendment is required: the current delta already mandates durable same-key acknowledgement, rejection of incompatible reuse, and no event/cursor advance. Next phase: revise tasks, then apply PR4a0.
