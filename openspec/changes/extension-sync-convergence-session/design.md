# Design: Extension Sync Convergence Session

## Technical Approach

**Amendment:** the maintainer authorized resolution of the `.2` package-boundary blocker. `syncapi` imports `bookmarks` (`PostgresStore.bookmarks` and `types.go`), so `bookmarks` cannot import the private `syncapi.prepareScopesTx` without a cycle. Move the proven kernel to the mutation-owning `bookmarks` package, then keep prepared patches there. `syncapi` remains a future consumer, not a dependency. This preserves `.1` scope-first locking and caller-owned external `pgx.Tx`; it changes no apply, route, event, cursor, publisher, HTTP-idempotency, migration, or extension behavior.

## Architecture Decisions

| Option | Tradeoff | Decision / rationale |
|---|---|---|
| Let `bookmarks` import `syncapi` | Creates `syncapi -> bookmarks -> syncapi` | Reject: Go import cycle. |
| Export/inject the `syncapi` kernel | Reverses the current dependency and makes a sync concern a bookmarks dependency | Reject. |
| Neutral package | A third ownership boundary and proof migration | Reject: unnecessary while only bookmark mutations consume it. |
| Relocate kernel to `bookmarks` | `.1` implementation/proof moves package | Choose: `bookmarks` owns one private scope-order rule beside its mutation invariants; `syncapi` already depends on it. |
| One `.2` slice | Kernel relocation plus both adapter proof sets exceeds 400 lines | Reject: use three stacked autonomous slices. |
| Workspace-wide lock / target-first lock | Over-serialization / proven opposite-move cycle | Reject. |

## Data Flow

```text
read-only discovery -> source/destination scope keys -> sorted, deduped advisory locks
-> target/siblings FOR UPDATE -> locked rederivation -> bookmarks domain validation
-> normalized complete shape -> immutable patch/fingerprint/no-op
```

`scopeKey` is `(kind, workspaceID, parentID-or-root/folderID)`. A typed retryable drift error rolls back the caller's whole transaction for retry from discovery; no scope is acquired after a row lock. Preparation only reads/locks: it performs zero resource, ordering, event, cursor, or publisher writes.

## Sub-slices

| Slice | Start -> end / exact dependency | Interfaces and candidate files | Owned RED/GREEN proof; estimate + reserve | Rollback / exclusions |
|---|---|---|---|---|
| **PR4a0a3a.2a kernel relocation** | `08ffff8` -> private bookmarks kernel; depends on `.1`. | Move `siblingScopeKey`, `prepareScopesTx`, sorting/locking, drift type/classifier from `backend/internal/sync/postgres.go` to `backend/internal/bookmarks/prepare.go`; relocate the isolated-schema proof from `sync/postgres_integration_test.go` to `bookmarks/service_integration_test.go`. | Preserve RED/GREEN: opposite/same-scope blocking without `40P01`, dedupe, locked drift, no post-row-lock scope acquisition, zero writes. **150 add + 145 delete + 20 artifact = 315**. | Revert relocation only; `.1` behavior is restored. No prepared patch. |
| **PR4a0a3a.2b folder preparation** | `.2a` -> immutable folder patch; depends exactly on `.2a`. | `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}` adds private planning helpers and exported `PrepareFolderPatchTx`. | RED then GREEN: caller `pgx.Tx`, locked role/parent/ancestry, trim and clamped position, full final `Folder`, stable fingerprint, canonical no-op, zero writes, `UpdateFolderTx` unchanged. **190 add + 15 delete + 25 artifact = 230**. | Revert folder API/tests; kernel remains. |
| **PR4a0a3a.2c bookmark preparation** | `.2b` -> immutable bookmark patch; depends on `.2a` only but is stacked after `.2b`. | Same bookmarks files add `PrepareBookmarkPatchTx` and shared patch contracts. | RED then GREEN: caller `pgx.Tx`, locked role/folder containment, title/URL trim-validation, clamped position, full final `Bookmark`, fingerprint/no-op, zero writes, `UpdateBookmarkTx` unchanged. **205 add + 15 delete + 25 artifact = 245**. | Revert bookmark API/tests; prior slices remain. |

## Interfaces / Contracts

`bookmarks` exports only `PrepareFolderPatchTx(ctx, tx pgx.Tx, userID, folderID string, input UpdateFolderInput) (PreparedFolderPatch, error)` and `PrepareBookmarkPatchTx(ctx, tx pgx.Tx, userID, bookmarkID string, input UpdateBookmarkInput) (PreparedBookmarkPatch, error)`. Patches contain immutable original/final full shapes, normalized position, stable fingerprint, and `NoOp`; their fields have no mutation capability. Kernel keys, locks, and drift classifier remain private to `bookmarks`. `syncapi` changes no `Store`/`Service`/`PostgresStore` interface in `.2`; `.3` consumes bookmark patches through its existing one-way import. `ApplyPrepared*`, route adaptation, event/cursor creation, and publishing remain later work.

## Testing Strategy

Use the existing isolated-schema PostgreSQL harness at `postgres:5432`, separate transactions/release channels/bounded contexts, and `testing.Short()` skips. Run `cd backend && go test ./internal/bookmarks ./internal/sync`. `.2a` owns the moved concurrency/drift/no-write proof; `.2b/.2c` own their domain RED/GREEN proofs. No runtime attempt is active in this amendment.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/bookmarks/prepare.go` | Create | Private scope kernel, planning helpers, immutable patches. |
| `backend/internal/bookmarks/service.go` | Modify | External-tx prepared folder/bookmark entry points; preserve legacy updates. |
| `backend/internal/bookmarks/service_integration_test.go` | Modify | Relocated kernel plus folder/bookmark RED/GREEN proof. |
| `backend/internal/sync/{postgres.go,postgres_integration_test.go}` | Modify | Remove relocated kernel and its proof only. |
| `openspec/changes/extension-sync-convergence-session/design.md` | Modify | This boundary amendment; task recalculation is next. |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary changes.

## Migration / Rollout

No migration required. Each inert sub-slice is independently reversible.

## Open Questions

None. Recalculate task definitions before apply; `sdd-tasks` is next.
