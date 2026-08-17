# Design: Extension Sync Convergence Session

## Technical Approach

**PR4a0b amendment:** replace tasks 14.1–14.2's 463-line minimum with two vertical, stacked PATCH-route slices. Each activates one complete endpoint through `httpapi.ExecutePrepared`; the other endpoint remains on its existing safe path until its own slice lands. This preserves the session-continuity and complete-shape specifications without changing either requirement.

## Architecture Decisions

| Option | Tradeoff | Decision / rationale |
|---|---|---|
| One combined route change | 463 lines before reserve | Reject: exceeds the 400-line autonomous limit. |
| Test-only or bridge-only slice | Leaves a half-wired production path | Reject: every activated route needs its full proof. |
| Folder then bookmark vertical slices | Temporary endpoint asymmetry | **Choose:** each endpoint is independently correct, reviewable, and reversible. |
| Route calls `bookmarks` directly | Bypasses sync ownership | Reject: `syncapi` remains the orchestration boundary. |
| Duplicate prepare logic in route/store | Drift and inconsistent authorization | Reject: delegate to existing bookmarks preparation. |

## Data Flow

```text
PATCH route -> ExecutePrepared (one tx)
  -> sync.Service.Prepare*Tx -> Store -> bookmarks.Prepare*PatchTx
  -> receipt claim/replay/conflict -> Store.ApplyPrepared*Tx
  -> commit -> returned PostCommit publisher -> HTTP stable ACK
```

The route constructs `IdempotencyScope` from principal, PATCH method, canonical route, and mutation key. Preparation authenticates, locks, validates containment/base state, normalizes the complete final shape, and supplies its fingerprint; it makes no writes. A replay returns the stored `SafeResult` without apply or publication. A new receipt applies the same prepared patch/transaction, records exactly one event/cursor only when non-no-op, completes the receipt, commits, then invokes returned publication. Errors roll back and retain existing HTTP error mapping.

## Stacked Slice Plan

| Slice | Start -> finish / dependency | Exact forecast | Verification and rollback |
|---|---|---:|---|
| **PR4a0b.1 folder PATCH vertical** | `448eb1f` -> complete-shape, idempotent `PATCH /folders/{folderId}`; depends on PR4a0a2, PR4a0a3a.2c, PR4a0a3b. | **94 production + 152 focused HTTP/PostgreSQL proof + 1 task + 10 progress + 25 artifact reserve = 282 lines.** | RED then GREEN: partial input normalizes full shape; same-key replay returns identical status/body/headers/ack; key/shape conflict, auth, base-cursor, containment, no-op zero event/cursor/publication, mutation one event/cursor and post-commit ordering. Revert only this slice's route/bridge/tests/evidence; legacy folder route returns. |
| **PR4a0b.2 bookmark PATCH vertical** | PR4a0b.1 -> complete-shape, idempotent `PATCH /bookmarks/{bookmarkId}`; immediate parent is PR4a0b.1. | **63 production + 132 focused HTTP/PostgreSQL proof + 1 task + 10 progress + 25 artifact reserve = 231 lines.** | Equivalent bookmark proof, including folder containment and URL/full-shape normalization. Revert only bookmark wiring/tests/evidence; PR4a0b.1 remains correct. |

`develop` is the established integration base: `... -> PR4a0a3b -> PR4a0b.1 -> PR4a0b.2 -> PR4a1`. Each route slice is a single work-unit commit/stacked PR and stays below 400 changed additions plus deletions. PR4a1 and extension work are excluded from this backend route amendment and covered by the extension amendment below.

## Extension Convergence Amendment

Remote updates and moves follow one durable proof path:

```text
remote envelope -> persist complete-shape receipt -> Chrome effect
  -> exact complete callback proof -> consume receipt -> checkpoint cursor
```

PR4a1 queues stable-ID local intent, PR4a2 adds the dormant receipt reducer, PR4a3.1 activates verified updates, and PR4a3.2 adds predecessor-ordered move receipts plus per-workspace FIFO application. A pending receipt blocks later live/replay effects and survives restart; nonmatching, duplicate, reordered, or immediate local callbacks remain durable intent.

PR4b gates capacity, durable-write, complete-read, final-verification, Chrome rejection, and ambiguous-predecessor failures before unsafe follow-up. The affected workspace records the failed cursor and repair disposition without secrets. Retry replays from durable state and never clears the managed tree. Only explicit Rebuild may invoke destructive workspace reconstruction; it retains local intents and cannot promote an uncheckpointed replay cursor.

## Interfaces / Contracts

`backend/internal/sync/types.go` adds `PrepareFolderPatchTx` and `PrepareBookmarkPatchTx` to `Store`; `sync.Service` forwards them; `PostgresStore` delegates to `bookmarks.Service.Prepare*PatchTx`. `RegisterBookmarkRoutes` receives the already-created `*httpapi.IdempotencyExecutor` from `backend/cmd/api/main.go`. The route owns receipt scope, `SafeResult`, header/ack conversion, and post-commit invocation; `syncapi` owns transactional delegation/event recording; `bookmarks` owns preparation, locks, authorization, containment, normalization, and exact apply. The dependency remains `syncapi -> bookmarks`; no reverse import, cycle, or duplicated domain logic is introduced.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/cmd/api/main.go` | Modify (.1) | Inject the existing executor into bookmark routes. |
| `backend/internal/sync/{types.go,service.go,postgres.go}` | Modify | Add prepare forwarding/delegation only. |
| `backend/internal/sync/{bookmark_routes.go,headers.go}` | Modify | Route each endpoint through prepared execution and emit stored ACK headers. |
| `backend/internal/sync/{bookmark_routes_test.go,postgres_integration_test.go,handler_test.go}` | Modify | Focused HTTP/fake and isolated-schema PostgreSQL proof. |
| `extension/src/background/{convergence.ts,projection.ts,service-worker.ts}` | Modify | Durable receipts, FIFO apply, fail-closed gates, and workspace repair actions. |
| `extension/src/{shared,options}` | Modify | Persisted repair state and workspace-scoped Retry/Rebuild status UI. |
| `extension/tests/{convergence,delete-ownership,projection-behavior,status-ui}.test.mjs` | Modify | Deterministic callback, restart, retention, failure-matrix, and repair proof. |

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| HTTP | Contract, replay/conflict, auth/error mapping, stable ACK | Route tests per vertical slice. |
| PostgreSQL | Same transaction, no-op/event/cursor/rollback/publication ordering | Isolated-schema focused integration tests. |
| Regression | Existing packages | `cd backend && go test ./internal/sync ./internal/bookmarks`. |
| Extension convergence | Complete callback proof, FIFO, restart, capacity, and repair isolation | Deterministic Chrome runtime harness; no manual browser dependency. |
| Extension regression | Full projection behavior and type safety | `cd extension && npm run test:projection && npm run typecheck`. |

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A: no executable classification | None | None |
| Git repository selection | N/A: no Git command | None | None |
| Commit state | N/A: no commit automation | None | None |
| Push state | N/A: no push automation | None | None |
| PR commands | N/A: no PR automation | None | None |

## Migration / Rollout

No backend migration is required. The extension normalizes legacy persisted convergence journals before use and pauses ambiguous state rather than applying effects. Deploy/rollback at the slice boundary; no feature flag or changed public endpoint is needed.

## Open Questions

None. All planned slices are implemented and independently verified.
