# Tasks: Admin Web Review Remediation v2

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 940–1310 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Five work units; single PR only with new v2 exception |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

Maintainer-approved v2 `size:exception`: one PR up to 1600 lines, five internal evidence/rollback work units, no commit/PR before new receipt `review-validate`.

### Suggested Work Units

| Unit | Goal | Focused command | Runtime harness | Rollback boundary |
|---|---|---|---|---|
| 1 | Ordered dual migration | `cd backend && go test ./internal/{database,organizations} -run 'Test(MigrationFrom000002|Recorded000003FixForward|Migrate)'` | Isolated PostgreSQL schemas via `DATABASE_URL` | SQL source/tests; never ledger rows/applied SQL |
| 2 | Authorized target-bound replay | `cd backend && go test ./internal/httpapi ./internal/{organizations,groups,workspaces} -run Idempotency` | Migrated PostgreSQL + five `httptest` POSTs | Idempotency/routes/services/tests |
| 3 | DB evidence gate | `bash scripts/verify-admin-db-contracts_test.sh` | Reachable `DATABASE_URL`, production migrations | Gate script/tests |
| 4 | Failure containment | `cd backend && go test ./internal/httpapi -run 'Test(Error|RequestID|Cleanup)'` | `httptest` panic before/after commit | Middleware/API wiring/tests |
| 5 | Retry and grants | `cd admin-web && npm run test` | Group grant create→refetch→render | API hook/mutations/access UI/tests |

## Phase 1: Migration proof — Unit 1 (RISK-003, RESILIENCE-001, RELIABILITY-006)

- [x] 1.1 RED: add `backend/internal/organizations/remediation_integration_test.go` and `backend/internal/database/migrator_integration_test.go`: `database.Migrate` pre-`000003` and `t.TempDir` old `000003/000004`; assert order, no ledger edits, survivor/index, rerun.
- [x] 1.2 GREEN: amend `backend/migrations/000003_admin_remediation.sql` reconciliation-before-index; add idempotent `000005_admin_remediation_v2_fix_forward.sql`; migrate production `000001`–`000005` to fix recorded old `000003`.

## Phase 2: Idempotency — Unit 2 (RISK-001, RISK-002, RESILIENCE-002, RELIABILITY-001, RELIABILITY-005)

- [x] 2.1 RED: in `backend/internal/httpapi/idempotency{,_integration}_test.go` and `backend/internal/{organizations,groups,workspaces}/handler_test.go`, prove reauth before replay, revoked 403/no DTO, target UUID identity/fingerprint, reclaim/concurrency, isolation.
- [x] 2.2 RED: add `backend/internal/httpapi/idempotency_routes_integration_test.go` for five successful keyed production-migration routes: organization, invitation, group, member, workspace.
- [x] 2.3 GREEN: update `backend/internal/httpapi/idempotency.go` plus `backend/internal/{organizations,groups,workspaces}/{handler,service}.go` for lock→authorize→lookup/claim, canonical targets, typed fingerprint, safe replay.

## Phase 3: DB gate — Unit 3 (RESILIENCE-004/005, RELIABILITY-003/004)

- [x] 3.1 RED: add shell cases in `scripts/verify-admin-db-contracts_test.sh` for absent URL, unreachable test, skip, unnamed/missing marker, fake PASS, cwd independence, and URL redaction.
- [x] 3.2 GREEN: update `scripts/verify-admin-db-contracts.sh` for production migrations and named non-skipped RUN/PASS return coverage for organizations, groups, workspaces, and httpapi.

## Phase 4: Containment — Unit 4 (RESILIENCE-006..008)

- [x] 4.1 RED: extend `backend/internal/httpapi/errors_test.go` for panic before/after commit, UUID-only `X-Request-ID`, preserved optional interfaces, and generic cleanup log without raw error.
- [x] 4.2 GREEN: update `backend/internal/httpapi/{errors,httpapi}.go` and `backend/cmd/api/main.go` with safe recovery/request IDs/cleanup event.

## Phase 5: UI and integrated verification — Unit 5 (RESILIENCE-003, RELIABILITY-002/007)

- [x] 5.1 RED: add `admin-web/src/lib/api/useUncertainCreationKey.test.ts` for mutation-owned uncertain retry and reset; verify existing `admin-web/src/lib/api/client.test.ts` coverage that PATCH/PUT/DELETE receive no keys.
- [x] 5.2 RED: verify existing `admin-web/src/features/access/AccessPage.test.tsx` behavior for group-grant create→invalidate/refetch→render.
- [x] 5.3 GREEN: add hook and update the three creation-mutation files; verify existing `admin-web/src/lib/api/{client,groups,organizations,workspaces}.ts` wrappers and `AccessPage.tsx` while running `go test ./... && go build ./...`, DB gate, `npm run typecheck && npm test && npm run build`.
- [x] 5.4 HARD GATE: before starting a new review, inventory every touched/new path against Design §18, including all genesis paths; fail review start until complete.
