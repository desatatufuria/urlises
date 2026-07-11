# Design: Safe Admin Remediation v2

The change fixes the 18 frozen findings in five independently reversible work units without changing predecessor review state. It follows the current modular Go services, pgx transactions, React Query mutations, and filename-only migration ledger.

## Decisions

| Decision | Choice and rationale |
|---|---|
| Migration history | Amend unapplied `000003_admin_remediation.sql` to expire/cancel duplicates before its partial index; add idempotent `000005_admin_remediation_v2_fix_forward.sql` with the same reconciliation plus `CREATE UNIQUE INDEX IF NOT EXISTS`. `Migrate` lexically sorts names and records only filenames in `schema_migrations`; recorded `000003` is skipped, so forward-only repair is mandatory. Never edit ledger rows. |
| Replay authorization | `Execute` receives `authorize(context.Context, pgx.Tx) error` and `command`. In one tx: advisory lock keyed by identity **including normalized target UUIDs**, authorize target, load/compare ledger, replay or claim/command/complete. Reauthorization precedes lookup, so revoked replay is 403 with no stored DTO. Fingerprint hashes route + canonical targets + typed payload. |
| Retry ownership | Create mutations own a small `useUncertainCreationKey` state/hook and pass the key into API wrappers. Retain only after transport/ambiguous failure for the same intent; clear on confirmed response, cancel, or changed/new input. PATCH/PUT/DELETE never receive keys. |
| Containment | `NewErrorMiddleware` defers recovery before dispatch; when uncommitted it writes the generic 500, otherwise only logs one safe event. `statusWriter` keeps Flush/Hijack/Push/ReaderFrom/Unwrap. Accept `X-Request-ID` only as a UUID; otherwise generate UUID. Cleanup logs fixed `idempotency_cleanup_failed`, never `err`. |

## Flow and Migration Proof

`handler → Execute(lock → authorize → record/replay|claim → CreateTx → safe DTO) → response`.

Migration integration tests use `database.Migrate`, production SQL, isolated schemas, and no manual ledger writes: (1) migrate to `000002`, seed expired/tied duplicate invitations, then migrate through `000005`; prove deterministic survivor, inactive others, and index. (2) use a `t.TempDir` historical `000001`–`000004` fixture (old `000003`) through `Migrate`, then point `Migrate` at production `000001`–`000005`; prove lexical filename ordering, recorded names are skipped, and `000005` fix-forwards expired pending data. Re-run `Migrate` in both states to prove idempotence; rollback is test-schema drop and source revert only—applied SQL is not rolled back.

## File and ID Map

| Frozen IDs | Files / exact tests |
|---|---|
| RISK-003, RESILIENCE-001, RELIABILITY-006 | `backend/migrations/000003_admin_remediation.sql`, new `000005_admin_remediation_v2_fix_forward.sql`, `backend/internal/organizations/remediation_integration_test.go` (`TestMigrationFrom000002`, `TestRecorded000003FixForward`), new `backend/internal/database/migrator_integration_test.go` (sort/ledger semantics). |
| RISK-001, RISK-002, RESILIENCE-002, RELIABILITY-001, RELIABILITY-005 | `backend/internal/httpapi/idempotency.go`, `idempotency_test.go`, `idempotency_integration_test.go`, new `idempotency_routes_integration_test.go`; organization/group/workspace handler/service tests cover five keyed `httptest` routes and migrated-PG runtime paths: organization, invitation, group, member, workspace; target isolation and revoked replay are 403/no body. |
| RESILIENCE-004, RESILIENCE-005, RELIABILITY-003, RELIABILITY-004 | `scripts/verify-admin-db-contracts.sh`, `scripts/verify-admin-db-contracts_test.sh`; include `httpapi`, production migrations, named `RUN`/`PASS` markers per package, reject missing URL/unreachable/skip/unnamed or fake `PASS`, keep script-location cwd and redact URL. |
| RESILIENCE-006, RESILIENCE-007, RESILIENCE-008 | `backend/internal/httpapi/{errors,errors_test,httpapi}.go`, `backend/cmd/api/main.go`: panic-before/after-commit, UUID validation, interface preservation, and generic cleanup event RED cases. |
| RESILIENCE-003, RELIABILITY-002, RELIABILITY-007 | `admin-web/src/lib/api/{client,client.test,groups,organizations,workspaces}.ts`, new `admin-web/src/lib/api/useUncertainCreationKey.ts` and test, creation mutation files, `AccessPage.test.tsx`: uncertain retry/new intent/no update-delete keys; create group grant, invalidate/refetch, render grant. |

## Expanded Future Review Genesis Paths

`backend/migrations/000003_admin_remediation.sql`; `backend/migrations/000005_admin_remediation_v2_fix_forward.sql`; `backend/internal/database/migrator.go`; `backend/internal/database/migrator_integration_test.go`; `backend/internal/organizations/handler.go`; `backend/internal/organizations/handler_test.go`; `backend/internal/organizations/service.go`; `backend/internal/organizations/remediation_integration_test.go`; `backend/internal/groups/handler.go`; `backend/internal/groups/handler_test.go`; `backend/internal/groups/service.go`; `backend/internal/workspaces/handler.go`; `backend/internal/workspaces/handler_test.go`; `backend/internal/workspaces/service.go`; `backend/internal/httpapi/idempotency.go`; `backend/internal/httpapi/idempotency_test.go`; `backend/internal/httpapi/idempotency_integration_test.go`; `backend/internal/httpapi/idempotency_routes_integration_test.go`; `backend/internal/httpapi/errors.go`; `backend/internal/httpapi/errors_test.go`; `backend/internal/httpapi/httpapi.go`; `backend/cmd/api/main.go`; `scripts/verify-admin-db-contracts.sh`; `scripts/verify-admin-db-contracts_test.sh`; `admin-web/src/lib/api/client.ts`; `admin-web/src/lib/api/client.test.ts`; `admin-web/src/lib/api/groups.ts`; `admin-web/src/lib/api/organizations.ts`; `admin-web/src/lib/api/workspaces.ts`; `admin-web/src/lib/api/useUncertainCreationKey.ts`; `admin-web/src/lib/api/useUncertainCreationKey.test.ts`; `admin-web/src/features/groups/mutations.ts`; `admin-web/src/features/members/mutations.ts`; `admin-web/src/features/workspaces/mutations.ts`; `admin-web/src/features/access/mutations.ts`; `admin-web/src/features/groups/GroupsPage.tsx`; `admin-web/src/features/members/MembersPage.tsx`; `admin-web/src/features/workspaces/WorkspacesPage.tsx`; `admin-web/src/features/access/AccessPage.tsx`; `admin-web/src/features/access/AccessPage.test.tsx`.

## Testing, Threats, and Delivery

Use table-driven Go tests and `httptest`; PG tests are named and non-skipped in the gate. Shell RED tests: absent URL, unreachable `go test`, skip marker, generic/fake PASS, missing package marker, cwd independence, and URL redaction.

| Threat-matrix boundary | Status |
|---|---|
| Documentation-like paths | N/A: no classifier/execution selection. |
| Git repository selection | N/A: script derives its own location; invokes no Git. |
| Commit state / Push state / PR commands | N/A: no VCS or PR process. |

Five rollback boundaries: migration proof (forward SQL retained after deployment); idempotency routes/services; DB gate; containment; UI retry/grant. Forecast 940–1,310 authored lines: one PR under 1,600 is credible; monitor Unit 2, no exception approval. 400-line review risk remains high.

## Open Questions

None.
