# Tasks: Admin Backend Foundation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 700-1000 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 schema+access → PR 2 org+groups → PR 3 workspace integration+docs |
| Delivery strategy | chained PRs |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Schema and shared access base | PR 1 | Gitflow feature slice; base boundary depends on final chain choice |
| 2 | OdA members, invites, and groups | PR 2 | Depends on Unit 1; keep admin API focused |
| 3 | Workspace grants, runtime wiring, tests, docs | PR 3 | Depends on Unit 2; verify extension reads stay compatible |

## Phase 1: Foundation

- [x] 1.1 Create `backend/migrations/000002_admin_backend_foundation.sql` for org roles, invitations, groups, group memberships, workspace user/group grants, and `workspace_members` backfill.
- [x] 1.2 Create `backend/internal/access/service.go` with org-admin checks, role ranking, effective workspace access resolution, and bookmark mutation guards.
- [x] 1.3 Add `backend/internal/access/service_test.go` for highest-role-wins, direct+group source merging, and no-grant denial.

## Phase 2: Organization Admin Core

- [x] 2.1 Extend `backend/internal/organizations/service.go` for `POST /organizations`, member listing/patching, initial `owner` bootstrap, and last-owner protection.
- [x] 2.2 Extend `backend/internal/organizations/handler.go` for member and invitation routes, keeping `GET /organizations` shape-compatible.
- [x] 2.3 Update `backend/internal/auth/service.go` and `backend/internal/auth/handler.go` to accept invite tokens after authenticated sign-in and activate pending membership once.
- [x] 2.4 Add `backend/internal/organizations/service_test.go` for creator-as-owner, last-owner rejection, accepted invite activation, and reused invite rejection.

## Phase 3: Groups And Workspace Grants

- [x] 3.1 Create `backend/internal/groups/service.go` and `backend/internal/groups/handler.go` for OdA group CRUD and organization-scoped many-to-many membership rules.
- [x] 3.2 Extend `backend/internal/workspaces/service.go` and `backend/internal/workspaces/handler.go` for workspace create, direct grants, group grants, creator-only default admin, and effective-role reads.
- [x] 3.3 Update `backend/internal/bookmarks/service.go` to consume `internal/access` instead of direct `workspace_members` checks.
- [x] 3.4 Wire `backend/cmd/api/main.go` to register access, organization, group, workspace, and invite flows in existing bootstrap style.

## Phase 4: Verification

- [x] 4.1 Add `backend/internal/organizations/service_integration_test.go` for migration/backfill safety and invite acceptance transaction behavior.
- [x] 4.2 Add `backend/internal/groups/service_integration_test.go` and `backend/internal/workspaces/service_integration_test.go` for org-scoped group membership, creator-only workspace access, highest-role-wins, and revoke/recalculate scenarios.
- [x] 4.3 Extend `backend/internal/bookmarks/service_integration_test.go` to prove bookmark mutations respect shared access results.
- [x] 4.4 Manually validate `POST /organizations`, `POST /organizations/{id}/invitations`, `POST /invitations/{token}/accept`, and workspace access endpoints with Acme/OdA sample data; record expected request flow in `README.md`.

PostgreSQL-backed invitation integration tests were validated against the running Docker PostgreSQL instance using `scripts/test-organizations.sh` with the devcontainer host bridge (`telemetry.host:5433`).

## Phase 5: Documentation

- [x] 5.1 Update `README.md` with admin/control-plane scope, Acme/OdA terminology, invite-by-email MVP flow, and Gitflow delivery notes.
- [x] 5.2 Update `docs/roadmap.md` and `docs/requeriments.md` to document groups-first access, direct+group grants, and synchronized operational space assumptions.
