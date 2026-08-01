# Design: Extension Sync Convergence Session

## Technical Approach

**Amendment:** replace the infeasible one-step `.2a` relocation with exactly two stacked, autonomous copy-then-remove slices. The measured relocation is 75D/81A kernel plus 116D/114A PostgreSQL proof: 386 code/test lines, or at least 402 with four task and twelve progress lines. First copy an equivalent, private, inert kernel and its full PostgreSQL proof into `bookmarks`; then remove the proven `syncapi` duplicate. This gives `bookmarks` private ownership without a `bookmarks -> syncapi` import, while preserving `.1` scope-first locking and caller-owned `pgx.Tx`.

## Architecture Decisions

| Option | Tradeoff | Decision / rationale |
|---|---|---|
| One-step relocation | Measured minimum is 402 lines including artifacts | Reject: exceeds the 400-line autonomous cap. |
| Copy then remove | Temporary duplicate exists for one slice | **Choose:** each change is independently testable/reversible and below cap. |
| `bookmarks` imports/exports from `syncapi` | `syncapi -> bookmarks -> syncapi` cycle or inverted ownership | Reject. |
| Neutral package | New boundary and additional proof migration | Reject: unnecessary for bookmark-only consumers. |
| Target-first/workspace-wide lock | Proven opposite-move deadlock/over-serialization | Reject. |

## Data Flow

```text
discover scopes -> sort/dedupe advisory locks -> target/siblings FOR UPDATE
-> locked rederivation -> retryable drift or domain validation -> prepared patch
```

`scopeKey` remains `(kind, workspaceID, parentID-or-root/folderID)`. No scope is acquired after a row lock. Preparation has zero resource, ordering, event, cursor, or publisher writes. In `.2a.1`, the copied bookmarks kernel is unexported and has no production caller; `syncapi` remains the sole reachable implementation. The copied proof establishes behavior equivalence. In `.2a.2`, deletion makes the proved bookmarks copy the sole implementation. No adapter or route reaches either copy in these slices, preventing drift from becoming production-reachable.

## Sub-slices

| Slice | Exact start -> end / dependency | Files, proof, and conservative lines | Rollback / exclusions |
|---|---|---|---|
| **PR4a0a3a.2a.1 copy + proof** | `.1` (`08ffff8`) -> inert equivalent bookmarks kernel; depends exactly on `.1`. | Create `backend/internal/bookmarks/prepare.go` (+81) and add the full isolated-schema proof to `backend/internal/bookmarks/service_integration_test.go` (+114). Retain `backend/internal/sync/{postgres.go,postgres_integration_test.go}`. PostgreSQL proves opposite/same-scope blocking without `40P01`, dedupe, locked drift, no late lock, zero writes. **195 code/test + 4 task + 16 progress/design reserve = 215 <=400.** | Revert only added bookmarks kernel/proof. Exclude patches, apply, routes, events, cursors, publisher, idempotency, migrations, extension. |
| **PR4a0a3a.2a.2 removal** | `.2a.1` -> one private bookmarks kernel; depends exactly on `.2a.1`. | Delete the duplicate kernel from `backend/internal/sync/postgres.go` (-75) and its proof from `backend/internal/sync/postgres_integration_test.go` (-116); retain/re-run bookmarks proof. **191 code/test + 4 task + 16 progress/design reserve = 211 <=400.** | Revert deletion only; `.2a.1` restores the inert duplicate. Same exclusions. |
| **PR4a0a3a.2b folder preparation** | `.2a.2` -> immutable folder patch; depends exactly on `.2a.2`. | `backend/internal/bookmarks/{prepare.go,service.go,service_integration_test.go}` adds `PrepareFolderPatchTx`; existing 230 forecast remains. PostgreSQL proves tx, locks, normalization, full shape/fingerprint/no-op, zero writes, legacy update. | Revert folder API/proof; kernel remains. |
| **PR4a0a3a.2c bookmark preparation** | `.2a.2` -> immutable bookmark patch; stacked after `.2b`, semantically depends exactly on `.2a.2`. | Same files add `PrepareBookmarkPatchTx`; existing 245 forecast remains with equivalent PostgreSQL proof. | Revert bookmark API/proof; prior slices remain. |

## Interfaces / Contracts

Kernel keys, locking, and drift classification are private to `bookmarks`. `.2a.1/.2a.2` add no exported interface and no `syncapi` import. Later `.2b/.2c` retain only `PrepareFolderPatchTx(ctx, tx pgx.Tx, userID, folderID string, input UpdateFolderInput) (PreparedFolderPatch, error)` and `PrepareBookmarkPatchTx(ctx, tx pgx.Tx, userID, bookmarkID string, input UpdateBookmarkInput) (PreparedBookmarkPatch, error)`. Patches are immutable original/final full shapes, normalized position, fingerprint, and `NoOp`. `PR4a0a3b` depends on `.2c`; `PR4a0b` depends on `PR4a0a2 + .2c + PR4a0a3b`.

## Testing Strategy

Use isolated-schema PostgreSQL at `postgres:5432`, separate transactions/release channels/bounded contexts, and `testing.Short()` skips. Each relocation slice runs `cd backend && go test ./internal/bookmarks -run '^TestPrepareScopesTxSerializesAndRefusesDrift$' -count=1`; `.2a.2` additionally runs `go test ./internal/sync` to prove deletion compiles. No Go/test change was made here; 13b.3a/13b.3b remain unchecked.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/bookmarks/prepare.go` | Create in `.2a.1` | Inert private copied kernel; later planning helpers. |
| `backend/internal/bookmarks/service_integration_test.go` | Modify in `.2a.1` | Equivalent PostgreSQL proof. |
| `backend/internal/sync/postgres.go` | Modify in `.2a.2` | Remove duplicate kernel. |
| `backend/internal/sync/postgres_integration_test.go` | Modify in `.2a.2` | Remove duplicate proof. |
| `openspec/changes/extension-sync-convergence-session/design.md` | Modify | This amendment only. |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration required. Each inert slice is reversible.

## Open Questions

None. Recalculate tasks before apply; next recommended: `sdd-tasks`.
