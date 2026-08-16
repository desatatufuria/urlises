# Design: Extension Sync Convergence Session

## Technical Approach

**Amendment:** replace the infeasible one-step `.2a` relocation with exactly two stacked, autonomous copy-then-remove slices. The measured relocation is 75D/81A kernel plus 116D/114A PostgreSQL proof: 386 code/test lines, or at least 402 with four task and twelve progress lines. First copy an equivalent, private, inert kernel and its full PostgreSQL proof into `bookmarks`; then remove the proven `syncapi` duplicate. This gives `bookmarks` private ownership without a `bookmarks -> syncapi` import, while preserving `.1` scope-first locking and caller-owned `pgx.Tx`.

The prepared-apply slice builds on that ownership boundary with internal APIs that materialize an already prepared patch and record its sync event in the same caller-owned transaction. The APIs have no production route or handler caller, so they do not yet change external mutation, acknowledgement, idempotency, or publication behavior.

## Architecture Decisions

| Option | Tradeoff | Decision / rationale |
|---|---|---|
| One-step relocation | Measured minimum is 402 lines including artifacts | Reject: exceeds the 400-line autonomous cap. |
| Copy then remove | Temporary duplicate exists for one slice | **Choose:** each change is independently testable/reversible and below cap. |
| `bookmarks` imports/exports from `syncapi` | `syncapi -> bookmarks -> syncapi` cycle or inverted ownership | Reject. |
| Neutral package | New boundary and additional proof migration | Reject: unnecessary for bookmark-only consumers. |
| Target-first/workspace-wide lock | Proven opposite-move deadlock/over-serialization | Reject. |
| Prepare and apply in one caller-owned transaction | Retains the preparation locks through resource, ordering, event, and cursor writes | **Choose:** prevents the prepared final shape from being invalidated between phases. |
| Prepare or reacquire locks during apply | Repeats work and creates a second lock/drift boundary | Reject: apply consumes the retained prepared patch and does not prepare, validate, or relock. |
| Publish from transactional apply | Can expose an event before commit and cannot be rolled back with PostgreSQL | Reject: return deferred `PostCommit` data for the caller to invoke only after a successful commit. |

## Data Flow

```text
discover scopes -> sort/dedupe advisory locks -> target/siblings FOR UPDATE
-> locked rederivation -> retryable drift or domain validation -> prepared patch (locks retained)
-> apply exact patch.Final -> reorder relevant sibling scopes
-> record one update event/cursor -> return resource/event and deferred post-commit data
-> caller commit -> optional caller-invoked post-commit publication
```

`scopeKey` remains `(kind, workspaceID, parentID-or-root/folderID)`. No scope is acquired after a row lock. Preparation has zero resource, ordering, event, cursor, or publisher writes. In `.2a.1`, the copied bookmarks kernel is unexported and has no production caller; `syncapi` remains the sole reachable implementation. The copied proof establishes behavior equivalence. In `.2a.2`, deletion makes the proved bookmarks copy the sole implementation. No adapter or route reaches either copy in these slices, preventing drift from becoming production-reachable.

Preparation and application receive the same `pgx.Tx`; application relies on the locks retained by preparation and never prepares or relocks. For a no-op, the operation returns the prepared final resource without a resource or ordering write and without an event, cursor, or post-commit item. For a mutation, the bookmarks kernel applies the exact normalized `patch.Final` and reorders the affected old and destination sibling scopes, then the sync store records exactly one update event and cursor advance. The store returns the event and publisher reference as deferred work without invoking the publisher. Transaction commit, rollback, and any publication after a successful commit remain caller responsibilities.

## Sub-slices

| Slice | Exact start -> end / dependency | Files, proof, and conservative lines | Rollback / exclusions |
|---|---|---|---|
| **PR4a0a3a.2a.1 copy + proof** | `.1` (`08ffff8`) -> inert equivalent bookmarks kernel; depends exactly on `.1`. | Create `backend/internal/bookmarks/prepare.go` (+81) and add the full isolated-schema proof to `backend/internal/bookmarks/service_integration_test.go` (+114). Retain `backend/internal/sync/{postgres.go,postgres_integration_test.go}`. PostgreSQL proves opposite/same-scope blocking without `40P01`, dedupe, locked drift, no late lock, zero writes. **195 code/test + 4 task + 16 progress/design reserve = 215 <=400.** | Revert only added bookmarks kernel/proof. Exclude patches, apply, routes, events, cursors, publisher, idempotency, migrations, extension. |
| **PR4a0a3a.2a.2 removal** | `.2a.1` -> one private bookmarks kernel; depends exactly on `.2a.1`. | Delete the duplicate kernel from `backend/internal/sync/postgres.go` (-75) and its proof from `backend/internal/sync/postgres_integration_test.go` (-116); retain/re-run bookmarks proof. **191 code/test + 4 task + 16 progress/design reserve = 211 <=400.** | Revert deletion only; `.2a.1` restores the inert duplicate. Same exclusions. |
| **PR4a0a3a.2b folder preparation** | `.2a.2` -> immutable folder patch; depends exactly on `.2a.2`. | `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}` adds `PrepareFolderPatchTx`; existing 230 forecast remains. PostgreSQL proves tx, locks, normalization, full shape/fingerprint/no-op, zero writes, legacy update. | Revert folder API/proof; kernel remains. |
| **PR4a0a3a.2c bookmark preparation** | `.2a.2` -> immutable bookmark patch; stacked after `.2b`, semantically depends exactly on `.2a.2`. | Same files add `PrepareBookmarkPatchTx`; existing 245 forecast remains with equivalent PostgreSQL proof. | Revert bookmark API/proof; prior slices remain. |
| **PR4a0a3b prepared apply** | `.2c` -> internal same-transaction apply seam; depends exactly on `.2c`. | Add bookmarks-kernel apply methods; sync result contracts, store methods, and service forwarding; and isolated PostgreSQL proof for exact finals, no-op, event/cursor cardinality, deferred publication, rollback, and legacy compatibility. | Revert apply APIs/proof; preparation remains. Exclude route wiring, stable ACK/idempotency behavior, and publisher invocation. |

## Interfaces / Contracts

Kernel keys, locking, and drift classification are private to `bookmarks`. `.2a.1/.2a.2` add no exported interface and no `syncapi` import. Later `.2b/.2c` retain only `PrepareFolderPatchTx(ctx, tx pgx.Tx, userID, folderID string, input UpdateFolderInput) (PreparedFolderPatch, error)` and `PrepareBookmarkPatchTx(ctx, tx pgx.Tx, userID, bookmarkID string, input UpdateBookmarkInput) (PreparedBookmarkPatch, error)`. Patches are immutable original/final full shapes, normalized position, fingerprint, and `NoOp`.

| Layer | Prepared-apply contract |
|---|---|
| Bookmarks kernel | `ApplyPreparedFolderPatchTx(ctx, tx pgx.Tx, patch PreparedFolderPatch) (Folder, error)` and `ApplyPreparedBookmarkPatchTx(ctx, tx pgx.Tx, patch PreparedBookmarkPatch) (Bookmark, error)` consume a patch prepared in the same transaction. They do not repeat preparation, validation, or locking. A no-op returns a clone of `patch.Final` without resource or ordering writes; a mutation writes the exact final resource shape, reorders relevant sibling scopes, and returns a clone of that final shape. |
| Sync store | `ApplyPreparedFolderPatchTx(ctx, tx pgx.Tx, userID string, patch bookmarks.PreparedFolderPatch, metadata Metadata) (PreparedMutationResult[bookmarks.Folder], error)` and its bookmark equivalent accept the same caller transaction plus identity and event metadata. A no-op returns only `Resource` and creates no event, cursor, or `PostCommit`. A mutation delegates exact application to bookmarks, records one update event and cursor in the same transaction, and returns deferred post-commit data without publishing. |
| Sync service | `ApplyPreparedFolderPatchTx` and `ApplyPreparedBookmarkPatchTx` forward the caller transaction, prepared patch, identity, and metadata to the store without beginning, committing, rolling back, or publishing. |

`PreparedMutationResult[T]` carries `Resource T`, optional `Event *Envelope`, and optional `PostCommit *PostCommit`. `PostCommit` carries the `Publisher` and `Envelope` needed for deferred publication; returning it never invokes the publisher. The transaction owner decides whether to commit or roll back and may invoke the returned work only after a successful commit. `PR4a0a3b` depends on `.2c`; `PR4a0b` depends on `PR4a0a2 + .2c + PR4a0a3b`.

## Testing Strategy

Use isolated-schema PostgreSQL at `postgres:5432`, separate transactions/release channels/bounded contexts, and `testing.Short()` skips. Each relocation slice runs `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`; `.2a.2` additionally runs `go test ./internal/sync` to prove deletion compiles.

| Proof | Contract |
|---|---|
| Bookmarks integration | Applies folder and bookmark patches in their preparation transaction and compares returned resources with the complete prepared `Final` shapes. Rollback preserves caller ownership, and legacy `UpdateFolderTx`/`UpdateBookmarkTx` paths remain compatible. |
| Sync integration | Proves a no-op returns the prepared resource with zero resource/event/cursor writes and no post-commit work; a mutation returns the exact prepared resource, creates exactly one event and cursor, and leaves the publisher uninvoked; rollback removes the resource/event/cursor mutation; and the legacy transaction update remains compatible. |
| Store-interface fakes | Route and handler test fakes implement the expanded internal `Store` surface without wiring production handlers to prepared apply. |

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/bookmarks/prepare.go` | Create in `.2a.1` | Inert private copied kernel; later planning helpers. |
| `backend/internal/bookmarks/service.go` | Modify in `PR4a0a3b` | Apply exact prepared folder and bookmark final shapes in a caller transaction. |
| `backend/internal/bookmarks/service_integration_test.go` | Modify in `.2a.1` and `PR4a0a3b` | Equivalent kernel proof and exact prepared-final/legacy compatibility proof. |
| `backend/internal/sync/types.go` | Modify in `PR4a0a3b` | Add prepared-apply store methods, `PreparedMutationResult`, and `PostCommit`. |
| `backend/internal/sync/postgres.go` | Modify in `.2a.2` and `PR4a0a3b` | Remove the duplicate kernel, then add transactional apply/event/cursor/deferred-publication behavior. |
| `backend/internal/sync/service.go` | Modify in `PR4a0a3b` | Forward prepared-apply calls without taking transaction or publication ownership. |
| `backend/internal/sync/postgres_integration_test.go` | Modify in `.2a.2` and `PR4a0a3b` | Remove duplicate proof, then prove no-op, mutation, deferred publisher, rollback, and legacy contracts. |
| `backend/internal/sync/bookmark_routes_test.go` | Modify in `PR4a0a3b` | Keep the route fake compatible with the expanded internal store interface. |
| `backend/internal/sync/handler_test.go` | Modify in `PR4a0a3b` | Keep the handler fake compatible with the expanded internal store interface. |
| `openspec/changes/extension-sync-convergence-session/design.md` | Modify | Record the relocation amendment and internal prepared-apply contracts. |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration required. Each slice is reversible. Prepared apply remains internal and route-unreachable; production route wiring, stable ACK/idempotency behavior, and actual invocation of returned post-commit publisher work are deferred.

## Open Questions

None. Recalculate tasks before apply; next recommended: `sdd-tasks`.
