# Design: Admin Web Review Remediation

## Technical Approach

Preserve the completed Unit 1 forward migration (`000004`; `000003` unchanged), invitation reconciliation, and owner locking. Unit 2 replaces the invalid middleware claim/check with a handler-to-command transaction: validated administrative requests run ledger claim, transaction-aware domain mutation, allowlisted completion, and commit in one `pgx.Tx`.

## Architecture Decisions

| Decision | Alternatives / trade-off | Rationale |
|---|---|---|
| Migration gate | Rewrite `000003` / forward `000004` | Unit 1 selected the safe forward path because shared deployment inventory is unknown; never rewrite applied history. |
| Invitation/owner safety | Unchanged Unit 1 implementation | Retain newest eligible invitation and locked last-owner transitions. |
| Atomic boundary | Generic middleware; nested service transactions / handler command plus creation-only `...Tx` methods | Current handlers directly call concrete services, while creation services own `Begin`/`Commit`. Middleware cannot share that transaction. Creation handlers parse once; `httpapi.IdempotencyExecutor` starts one tx and invokes `...Tx` methods. Public creation methods delegate to the same methods with their own tx for non-idempotent callers. |
| Duplicate exclusion | Row check-then-act / transaction-scoped advisory lock | `pg_try_advisory_xact_lock` on principal/method/canonical-target/key makes an active duplicate deterministically `409`; the ledger row alone is not visible until commit. |
| Replay safety | Store arbitrary response/errors / endpoint DTO allowlist | Store only the `201` creation DTO for the canonical route. Invitation replay (and initial response) excludes its token; never store errors, headers, bodies, credentials, or SQL details. |

## Data Flow

```
auth Principal.UserID -> handler validates key + typed input -> Executor.Begin
  -> advisory lock -> claim -> service.MutationTx -> safe result -> complete -> Commit
                                  ^ rollback on domain/unexpected error
```

Scope (required `Idempotency-Key`): `POST /organizations`; `POST /organizations/{organizationId}/invitations`; `POST /organizations/{organizationId}/groups`; `POST /groups/{groupId}/members`; and `POST /organizations/{organizationId}/workspaces`. These create an organization, invitation, group, group-membership relationship, or workspace. PATCH/PUT (including access-grant upserts) and DELETE, all GETs, health/readiness, auth/login/logout/invitation acceptance, sync/bookmark/websocket, and non-admin routes are not wrapped.

## Interfaces / Contracts

```go
type Command func(context.Context, pgx.Tx) (SafeResult, error)
type Executor interface { Execute(context.Context, Identity, Command) (SafeResult, Outcome, error) }
// Service public Mutation(...) begins/commits; MutationTx(ctx, tx, ...) never does.
```

Identity is authenticated `Principal.UserID` (not client ID), method, and canonical target: route template plus normalized UUID path values; fingerprint is SHA-256 of stable JSON `{target, typed request}`. Key is nonempty, bounded opaque text. States: absent -> **new** insert; same fingerprint completed -> replay; different fingerprint -> `409 idempotency_key_conflict`; advisory-lock failure -> `409 idempotency_in_progress`; an existing **failed** row is atomically reset/reclaimed. Executor rolls back a callback error with its claim; failed is only reclaimable legacy/operational state and has no result. Completion precedes the same commit, so at most one creation commits. Missing/malformed key is `400`; domain mappings remain; unexpected failure is sanitized `500`.

Allowlisted `201` DTOs are: `OrganizationCreation` (`organizationId`, `organizationName`, `role`); `InvitationCreation` (invitation identifiers, email, role, status, inviter, expiry/timestamps—never token); `GroupCreation` (`id`, `organizationId`, `name`, timestamps); `GroupMembershipCreation` (`groupId`, `userId`, `email`, `name`); and `WorkspaceCreation` (workspace/organization identifiers and names, type, role, sources). Store and return only these DTOs on initial and replay responses.

`000004` already supports the narrowed creation scope: identity, status, payload, expiry, and uniqueness are route-agnostic. Preserve the accepted unreleased amendment (never `000003`): nonblank/bounded key; completed rows require `response_status`, `safe_response`, and `completed_at`; non-completed rows require them null; only `201` is an allowlisted response status. Test a fresh-schema application and each constraint/unique identity.

API-owned periodic, bounded cleanup deletes only expired completed/failed rows; in-progress rows are never deleted. TTL expiry intentionally permits a new intent only after retention.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/migrations/000004_admin_remediation_safety.sql` | Modify | Add unreleased-ledger constraints. |
| `backend/internal/httpapi/idempotency.go` | Create | Executor, canonicalization, claim/replay/cleanup. |
| `backend/internal/{organizations,groups,workspaces}/{service,handler}.go` | Modify | Creation-only `...Tx` paths and five scoped handler commands. |
| `backend/cmd/api/main.go` | Modify | Construct executor/cleanup and pass it to route registration. |
| `backend/internal/httpapi/{idempotency,idempotency_integration}_test.go`, `backend/internal/{organizations,groups,workspaces}/*_test.go` | Create/Modify | Ledger, five creation routes, tx, DTO, and `000004` constraint coverage. |
| Unit 1/UI/script/5xx files | Unchanged by Unit 2 | Preserve their planned work. |

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit | Key/input canonicalization, allowlist, status mapping | Table-driven tests. |
| PostgreSQL | Each claim state, concurrent duplicate, rollback, no second mutation, TTL/constraint migration | Real two-request/two-transaction tests; no skips. |
| Handler | Five creation routes require keys; PATCH/PUT/DELETE, reads, and excluded surfaces do not | `httptest` route table. |
| Existing Unit 1/UI/script | Unchanged | Keep current evidence plan. |

## Threat Matrix

| Boundary | Applicability | Design response / RED tests |
|---|---|---|
| Documentation-like paths | N/A — no classification/execution | N/A |
| Git repository selection | N/A — no Git command | N/A |
| Commit state | N/A — no commit command | N/A |
| Push state | N/A — no push command | N/A |
| PR commands | N/A — no PR command | N/A |

The existing database-verification shell boundary remains fail-closed and unchanged.

## Migration / Rollout

Deploy amended `000004` before Unit 2 code. Roll back Unit 2 by reverting the executor, five creation-handler bindings, and creation `...Tx` refactors together; applied SQL is corrected forward. Unit 2 forecast: **300–400 lines**; total remediation forecast: **1,450–1,600**. This returns within the maintainer-approved 1,600-line exception; no additional size authorization is implied.

## Open Questions

- [ ] None: `000004` is confirmed unreleased by the stated Unit 1/apply context; if that changes, add a new forward migration rather than edit it.
