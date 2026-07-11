# Tasks: Admin Web Review Remediation

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | Total 1,450–1,600; Unit 2: 300–400 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Maintainer-approved one PR; internal Units 1 → 2 → 3 → 4 |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

Maintainer-approved `size:exception` up to 1,600 changed lines: one final PR; four internal work units remain independent evidence/rollback boundaries.

### Receipt Lifecycle Gate

Apply may proceed without a receipt. After apply, start a new remediation review only if no valid receipt exists. No commit or PR may occur until the new full remediation target obtains and passes `review-validate`. If post-apply review/validation is unavailable or escalates, stop before commit/PR. Never modify or reuse the old `admin-web-ui` receipt lineage.

### Suggested Work Units

All four units ship in the maintainer-approved final PR; each remains an independent evidence and rollback boundary.

| Unit | Delivery | Focused test | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Final PR internal unit | `cd backend && go test ./internal/organizations -run 'Test(Invitation|Owner)'` | Seeded PostgreSQL; two transactions | Revert Go; applied SQL fixes forward. |
| 2 | Final PR internal unit (300–400 lines) | `cd backend && go test ./internal/httpapi ./internal/organizations ./internal/groups ./internal/workspaces -run 'Test.*(Idempotency|Create)' -count=1` | PostgreSQL duplicate/replay against all five scoped POST routes; prove at-most-one creation. | Revert `httpapi/idempotency.go`, `main.go` wiring, and U2 `...Tx` paths; schema fixes forward. |
| 3 | Final PR internal unit | `cd backend && go test ./internal/httpapi -run TestUnexpectedFailure` | `httptest` failed mutation | Revert error/log wrapper and tests. |
| 4 | Final PR internal unit | `cd admin-web && npm run test` | Mocked router; PostgreSQL script | Revert UI/script only; no migration rollback. |

## Phase 1: Migration and Organization Safety

- [x] 1.1 **U1 gate:** inventory shared `schema_migrations` for `000003`; do not edit it without proof. Absent proof requires forward `000004`.
- [x] 1.2 **U1 RED:** PostgreSQL-test expired/duplicate invitations: keep highest `(created_at,id)` and allow a post-expiry invite.
- [x] 1.3 **U1 GREEN:** reconcile-before-index in `backend/migrations/000003_admin_remediation.sql`, or create `backend/migrations/000004_admin_remediation_safety.sql` with reconciliation, index, ledger.
- [x] 1.4 **U1 RED:** in `backend/internal/organizations/*_test.go`, cover expiry, stable validation/conflicts, owner-only promotion, and concurrent final-owner rejection with owner count ≥1.
- [x] 1.5 **U1 GREEN:** update `backend/internal/organizations/{service,handler}.go` for error mapping and locked (`FOR UPDATE`) owner transitions.

## Phase 2: Persisted Idempotency

- [x] 2.1 **U2 RED:** add PostgreSQL executor tests in `backend/internal/httpapi/{idempotency,idempotency_integration}_test.go` for replay, fingerprint-mismatch 409, deterministic in-flight 409, failed-row reclaim, TTL cleanup, and at-most-one creation; add `httptest` for POST `/organizations`, `/organizations/{organizationId}/invitations`, `/organizations/{organizationId}/groups`, `/groups/{groupId}/members`, `/organizations/{organizationId}/workspaces`, plus representative excluded PATCH/DELETE routes; run `-count=1` with no skips.
- [x] 2.2 **U2 GREEN:** create `backend/internal/httpapi/idempotency.go`; add transaction-aware creation `...Tx` paths only where needed in organization/group/workspace services and five handlers, wire `backend/cmd/api/main.go`, and execute claim → createTx → allowlisted complete → commit in one `pgx.Tx`; preserve principal/route scoping, safe DTO, TTL, and error contracts—never middleware check-then-act.

## Phase 3: Sanitized 5xx Reporting

- [x] 3.1 **U3 RED:** add `backend/internal/httpapi/errors_test.go`: stable 500/correlation ID; redact Authorization, cookies, body, tokens, SQL/DB errors, and replay payload.
- [x] 3.2 **U3 GREEN:** create `backend/internal/httpapi/errors.go`; wire `backend/cmd/api/main.go` structured failure events.

## Phase 4: UI and Fail-Closed Evidence

- [x] 4.1 **U4 RED:** test `scripts/verify-admin-db-contracts.sh` for absent/unreachable URL and false success from `SKIP`; require execution markers.
- [x] 4.2 **U4 GREEN:** require reachable `ADMIN_TEST_DATABASE_URL`, propagate failures, and reject skipped suites in `scripts/verify-admin-db-contracts.sh`.
- [x] 4.3 **U4 RED:** add `admin-web/src/**/*test.tsx` for uncertain-retry same/new keys, group-grant refetch, and failed `/members` restoration redirect to `/login` without protected content.
- [x] 4.4 **U4 GREEN:** update only necessary admin-web API client creation keys; existing access mutations retain their successful grant invalidation/refetch behavior.
- [x] 4.5 **U4:** executed backend, gateway DB-contract, and admin-web typecheck/test/build verification.
