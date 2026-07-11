# Apply Progress: Admin Web Review Remediation

## Status

**Mode:** Standard (Strict TDD disabled).  
**Delivery:** `exception-ok` / maintainer-approved `size:exception`.  
**Completion:** **14/14 tasks complete**. No commits, PRs, review/start, receipts, or archive actions were performed.

### Completed Tasks

- [x] 1.1–1.5 Migration, invitation lifecycle, and owner-safety remediation.
- [x] 2.1–2.2 Persisted idempotency tests and atomic creation transaction wiring.
- [x] 3.1–3.2 Sanitized 5xx response, request ID, and structured failure-event handling.
- [x] 4.1–4.5 Fail-closed DB contract script, frontend creation-key/auth recovery coverage, and integrated verification.

## Historical Unit 1 RED Evidence — Superseded by Successful Gateway GREEN

Added real PostgreSQL migration and organization-safety tests before any production change:

- `TestInvitationMigrationReconcilesExpiredAndDuplicatePendingRows` seeds expired and duplicate pending invitations, requires survivor ordering by newest `created_at` then `id`, verifies older rows become `cancelled`, expired rows become `expired`, verifies partial uniqueness, and verifies a new invitation can follow expiry.
- `TestInvitationSafetyScenarios` covers expired-list exclusion, invalid email, existing-member conflict, and pending-duplicate conflict.
- `TestOwnerOnlyPromotionAndConcurrentOwnerTransitions` uses concurrent service calls against PostgreSQL and requires a rejection plus owner count >= 1.
- `TestWriteOrganizationErrorMapsInvitationSafetyErrors` covers stable 400/409 HTTP mappings.

The focused RED command was intentionally run before production code. It could not obtain the required PostgreSQL runtime; its handler assertions also remain RED against the current implementation.

## Historical Unit 1 Corrective Retry: `postgres:5432`

The approved internal-Compose retry used both `ORGANIZATIONS_TEST_DATABASE_URL` and `DATABASE_URL` set to `postgres://postgres:postgres@postgres:5432/shared_bookmark_sync?sslmode=disable` and bypassed the Go test cache with `-count=1 -v`.

It did **not** reach PostgreSQL: Docker DNS returned `lookup postgres on 127.0.0.11:53: no such host`. Of the four selected root tests, 0 passed, 2 failed (`TestInvitationMigrationReconcilesExpiredAndDuplicatePendingRows` on explicit ping and `TestWriteOrganizationErrorMapsInvitationSafetyErrors`), and 2 were skipped by the pre-existing integration helper after the same DNS failure. The handler test still had 3 expected RED subcase failures (500 returned; 400/409 expected). No GREEN production changes were made.

## Successful Gateway Retry: `172.18.0.1:5433`

The verified Docker gateway endpoint reached PostgreSQL with both `ORGANIZATIONS_TEST_DATABASE_URL` and `DATABASE_URL` set to `postgres://postgres:postgres@172.18.0.1:5433/shared_bookmark_sync?sslmode=disable`.

The initial gateway RED run executed all four selected root tests with **0 infrastructure skips** and failed only for intended missing behavior: absent `000004`, three stable handler mapping assertions, expired invitation visibility, and admin-to-owner promotion. After GREEN changes, the same focused command passed all 4 root tests and 5 subtests with 0 failures and 0 skips. The package-level PostgreSQL harness then passed all 11 root tests and 5 subtests with 0 failures and 0 skips. `TestInvitationMigrationReconcilesExpiredAndDuplicatePendingRows` creates a unique schema and drops it through `t.Cleanup`, so it neither applies the forward migration to nor mutates unrelated local data.

## Work Unit Evidence — Unit 1 (historical failures and final successful gateway evidence)

| Evidence | Exact result |
|---|---|
| Focused test command and exact result | `cd backend && ORGANIZATIONS_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:5433/shared_bookmark_sync?sslmode=disable' go test ./internal/organizations -run 'Test(InvitationMigration\|InvitationSafety\|OwnerOnlyPromotion\|WriteOrganizationErrorMaps)' -count=1 -v` → exit 1. `TestInvitationMigrationReconcilesExpiredAndDuplicatePendingRows` failed on `dial tcp 127.0.0.1:5433: connect: connection refused`; `TestWriteOrganizationErrorMapsInvitationSafetyErrors` had 3 failing subcases (current status 500, expected 400/409); `TestInvitationSafetyScenarios` and `TestOwnerOnlyPromotionAndConcurrentOwnerTransitions` were skipped by the pre-existing helper after the same refused connection. |
| Runtime harness command/scenario and exact result | Same command and configured reachable URL. It attempted the seeded PostgreSQL migration and two-transaction owner scenario, but the host refused `localhost:5433`; no migration was applied and no runtime evidence exists. |
| Rollback boundary | Revert `backend/internal/organizations/remediation_integration_test.go` and the additive handler test. No production behavior or SQL migration was changed. Keep `000003_admin_remediation.sql` unchanged; any later applied forward SQL correction must be fixed forward, not rolled back. |

| Corrective retry command and exact result | `cd backend && ORGANIZATIONS_TEST_DATABASE_URL='postgres://postgres:postgres@postgres:5432/shared_bookmark_sync?sslmode=disable' DATABASE_URL='postgres://postgres:postgres@postgres:5432/shared_bookmark_sync?sslmode=disable' go test ./internal/organizations -run 'Test(InvitationMigration\|InvitationSafety\|OwnerOnlyPromotion\|WriteOrganizationErrorMaps)' -count=1 -v` → exit 1. Root tests: 0 pass, 2 fail, 2 skip; PostgreSQL DNS error: `lookup postgres on 127.0.0.11:53: no such host`; 3 handler RED subcases failed as expected. |
| Gateway RED command and exact result | `cd backend && ORGANIZATIONS_TEST_DATABASE_URL='postgres://postgres:postgres@172.18.0.1:5433/shared_bookmark_sync?sslmode=disable' DATABASE_URL='postgres://postgres:postgres@172.18.0.1:5433/shared_bookmark_sync?sslmode=disable' go test ./internal/organizations -run 'Test(InvitationMigration\|InvitationSafety\|OwnerOnlyPromotion\|WriteOrganizationErrorMaps)' -count=1 -v` → exit 1. Root tests: 0 pass, 4 fail, 0 skip; failures were expected RED behavior (missing `000004`, 3 handler mappings, expired list inclusion, admin promotion). |
| Gateway GREEN focused command and exact result | Same gateway command after implementation → exit 0. Root tests: 4 pass, 0 fail, 0 skip; subtests: 5 pass, 0 fail, 0 skip. |
| Gateway PostgreSQL harness command and exact result | `cd backend && ORGANIZATIONS_TEST_DATABASE_URL='postgres://postgres:postgres@172.18.0.1:5433/shared_bookmark_sync?sslmode=disable' DATABASE_URL='postgres://postgres:postgres@172.18.0.1:5433/shared_bookmark_sync?sslmode=disable' go test ./internal/organizations -count=1 -v` → exit 0. Root tests: 11 pass, 0 fail, 0 skip; subtests: 5 pass, 0 fail, 0 skip. |

## Rollback / Fix-Forward Boundary

Revert the Unit 1 Go behavior and its tests together: `backend/internal/organizations/service.go`, `backend/internal/organizations/handler.go`, `backend/internal/organizations/remediation_integration_test.go`, and the additive handler test. Do not edit or revert `000003_admin_remediation.sql`. If `000004_admin_remediation_safety.sql` has been applied outside the isolated test schema, correct it only with a reviewed forward migration.

## Historical Unit 2 Architecture Gate — Resolved

Before writing Unit 2 RED tests or production code, CodeGraph confirmed that administrative handlers call services directly and that those services independently open and commit their own `pgx` transactions. For example, organization mutation handlers invoke `service.PatchMember` and `service.CreateInvitation`, while those service methods own `pool.Begin`/`Commit`; `main.go` registers the concrete services directly.

The required idempotency claim/completion boundary could not use middleware-only or check-then-act behavior. This historical finding was resolved by creation-only `...Tx` service methods and handler-to-executor transaction wiring; it is not an active blocker.

## Unit 2 Corrective RED Attempt

The updated design and tasks now define the five creation routes and creation-only transaction-aware paths. RED coverage began in `backend/internal/httpapi/idempotency_test.go` with all five included route templates and representative excluded PATCH/DELETE templates. Command: `cd backend && go test ./internal/httpapi -run TestIdempotency -count=1 -v` → exit 1 at compile time because the required GREEN symbols do not exist yet: `undefined: IsIdempotentCreationRoute` (two references) and `undefined: NewIdempotencyExecutor`.

This is retained historical RED evidence only. It preceded the completed executor, transaction, schema, and route wiring work.

## Completed Unit 2 Evidence

Exact command was recorded in the Unit 2 result with gateway variables for `ADMIN_TEST_DATABASE_URL`, `ORGANIZATIONS_TEST_DATABASE_URL`, `GROUPS_TEST_DATABASE_URL`, `WORKSPACES_TEST_DATABASE_URL`, and `DATABASE_URL` set to `postgres://postgres:postgres@172.18.0.1:5433/shared_bookmark_sync?sslmode=disable`.

| Evidence | Exact known result |
|---|---|
| Focused test/build | Referenced from Unit 2 result: affected `httpapi`, `organizations`, `groups`, and `workspaces` focused command plus `go build ./cmd/api` → exit 0; **12 root tests**, 0 failures, 0 skips. |
| Runtime harness | Referenced from Unit 2 result: affected PostgreSQL packages plus build → exit 0; **32 root tests**, 0 failures, 0 skips. |
| Atomic boundary | Exactly five routes: `POST /organizations`, `POST /organizations/{organizationId}/invitations`, `POST /organizations/{organizationId}/groups`, `POST /groups/{groupId}/members`, and `POST /organizations/{organizationId}/workspaces`; executor claim → `...Tx` create → allowlisted completion → same transaction commit. |
| Rollback/fix-forward | Revert U2 executor, five bindings, `...Tx` paths, and U2 tests together. Applied `000004` ledger changes are corrected forward. |

## Completed Unit 3 Evidence

| Evidence | Exact known result |
|---|---|
| Focused test/build | Referenced from Unit 3 result: `go test ./internal/httpapi -run 'TestUnexpectedFailure|TestErrorMiddleware' -count=1 -v && go build ./cmd/api` → exit 0; **2 root tests**, 0 failures, 0 skips. |
| Runtime harness | Referenced from Unit 3 result: affected gateway regression command → exit 0; **34 root tests**, 0 failures, 0 skips. |
| Behavior | Generic 500 envelope; propagated/generated request ID; exactly one sanitized structured event; Authorization, cookies, bodies, tokens, replay payloads, and raw SQL/DB errors excluded from response/logs. |
| Rollback | Revert U3 `errors.go`, `errors_test.go`, U3 `httpapi.go` behavior, and API handler wrapper. |

## Completed Unit 4 Evidence

| Evidence | Exact known result |
|---|---|
| Focused script harness | `bash scripts/verify-admin-db-contracts_test.sh` → exit 0. |
| Unreachable DB | Gateway substitute command using `127.0.0.1:1` → exit 1; connection refused, no false success. |
| Focused frontend | Referenced from Unit 4 result: client test command → exit 0; **1 test** passed. |
| Backend integrated | `cd /workspace/backend && go test ./... && go build ./cmd/api` → exit 0. |
| DB contract runtime | Referenced from Unit 4 result: gateway `ADMIN_TEST_DATABASE_URL` contract script → exit 0; verbose uncached execution, **zero skips**. |
| Frontend integrated | `cd /workspace/admin-web && npm run typecheck && npm run test && npm run build` → exit 0; **7 files / 27 tests** passed; build passed. |
| Rollback | Revert Unit 4 script/harness, frontend creation-key API changes/tests, and router regression test. No migration rollback. |

## Next Step

No active pending apply tasks remain. The next step is parent-owned bounded review/start; apply must not launch review.
