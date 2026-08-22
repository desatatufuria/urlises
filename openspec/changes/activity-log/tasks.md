# Tasks: Activity Log

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~1,850–1,950 |
| 800-line session budget risk | High |
| 400-line reviewer-burden signal | High |
| Chained PRs recommended | Yes |
| Suggested split | 6 work units (see below), largest ≈553 lines, all comfortably under the 800-line session budget |
| Delivery strategy | ask-on-risk (cached this session) |
| Chain strategy | feature-branch-chain — matches `secret-sharing` precedent; each unit branches off the previous unit's branch, PR'd and merged to `develop` before the next unit starts |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain (6 sequential branches, first off `develop`, each merged before the next starts)
400-line budget risk: High (mitigated by the 6-way split; largest unit ≈553 lines)

The proposal's own risk table forecast 4 units; the concrete design (13 call sites, a 3-function tx-wrap refactor, and a 16-branch admin-web formatter) pushes this to 6 units to keep each PR close to the 400-line reviewer-burden signal rather than merely under the 800-line session ceiling.

### Estimate basis

| File | Action | Est. lines |
|---|---|---|
| `backend/migrations/000012_activity_events.sql` | Create | ~20 |
| `backend/internal/activity/service.go` (+tests) | Create | ~160 + ~180 |
| `backend/internal/activity/cursor.go` (+tests) | Create | ~40 + ~50 |
| `backend/internal/activity/handler.go` (+tests) | Create | ~110 + ~130 |
| `backend/internal/organizations/service.go` (+tests) | Modify | ~70 + ~90 |
| `backend/internal/workspaces/service.go` (+tests) | Modify | ~70 + ~90 |
| `backend/internal/groups/service.go` (+tests) | Modify | ~140 + ~150 |
| `backend/cmd/api/main.go` | Modify | ~40 (spread across units 3–5) |
| `admin-web/src/lib/api/activity.ts` | Create | ~45 |
| `admin-web/src/features/activity/queries.ts` | Create | ~40 |
| `admin-web/src/features/activity/format.ts` (+tests) | Create | ~55 + ~140 |
| `admin-web/src/features/activity/ActivityPage.tsx` (+tests) | Create | ~150 + ~110 |
| `admin-web/src/app/router.tsx` | Modify | ~8 |
| `admin-web/src/app/shell/AdminLayout.tsx` | Modify | ~5 |

### Suggested Work Units

| Unit | Goal | Branch | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| 1 | Foundation: migration + `activity` package (`Record`, `Kind` enum, `ListByOrganization`, cursor helpers) — no callers | `feat/activity-log-foundation` off `develop` | PR 1 | `cd backend && go test ./internal/activity` | `docker compose up -d backend`; exercise `Service` via a Go test harness (no HTTP route yet) | `backend/migrations/000012_activity_events.sql`, `backend/internal/activity/{service.go,cursor.go}`(+tests) |
| 2 | `activity` HTTP handler: `RegisterRoutes`, admin authorization, cursor pagination in the response | `feat/activity-log-handler` off `feat/activity-log-foundation` | PR 2, base = 1 | `cd backend && go test ./internal/activity` | `docker compose up -d backend`; `curl` a seeded org's `/organizations/{id}/activity` as admin vs. non-admin | `backend/internal/activity/handler.go`(+tests) |
| 3 | `organizations` wiring (5 call sites) + initial `main.go` composition (`activityService` construction, `activity.RegisterRoutes`, `organizations.NewService` param) | `feat/activity-log-organizations` off `feat/activity-log-handler` | PR 3, base = 2 | `cd backend && go test ./internal/organizations ./internal/activity` | `docker compose up -d`; create an org and an invitation via `curl`, confirm rows via `GET .../activity` | `backend/internal/organizations/service.go`(+tests), the `activityService`/`organizations` lines in `main.go` |
| 4 | `workspaces` wiring (5 call sites) + `main.go` param for `workspaces.NewService` | `feat/activity-log-workspaces` off `feat/activity-log-organizations` | PR 4, base = 3 | `cd backend && go test ./internal/workspaces ./internal/activity` | `docker compose up -d`; create a workspace and grant/revoke user access via `curl`, confirm rows via `GET .../activity` | `backend/internal/workspaces/service.go`(+tests), the `workspaces` line in `main.go` |
| 5 | `groups` tx-wrap refactor (`Update`/`Delete`/`ListMembers`, behavior-preserving) + wiring (5 call sites) + `main.go` param for `groups.NewService` | `feat/activity-log-groups` off `feat/activity-log-workspaces` | PR 5, base = 4 | `cd backend && go test ./internal/groups ./internal/activity ./internal/secrethide` | `docker compose up -d`; rename/delete a group and add/remove a member via `curl`, confirm rows via `GET .../activity`; confirm no `secrethide` mutation produces a row | `backend/internal/groups/service.go`(+tests), the `groups` line in `main.go` |
| 6 | admin-web: `lib/api/activity.ts`, `features/activity/{queries,format,ActivityPage}`, router + nav wiring | `feat/activity-log-admin-web` off `feat/activity-log-groups` | PR 6, base = 5 | `cd admin-web && npm test -- format ActivityPage` | `npm run dev`; log in as an org admin, open `/activity`, confirm loading/empty/populated states and readable sentences for events created via the earlier units' `curl` calls | `admin-web/src/{lib/api/activity.ts,features/activity/,app/router.tsx,app/shell/AdminLayout.tsx}` |

Each unit is developed, tested, and merged into `develop` before the next unit's branch is created. `main.go` is touched incrementally in units 3–5 (one constructor param per unit) rather than all at once, so `go build ./...` stays green at every merge point — no unit leaves `cmd/api` non-compiling.

## Phase 1: Foundation — Migration & Activity Service

- [ ] 1.1 Create `backend/migrations/000012_activity_events.sql` — `activity_events` table (`id`, `organization_id` FK CASCADE, `actor_user_id` FK SET NULL, `kind`, `target_type`, `target_id`, `metadata JSONB`, `created_at`) + `idx_activity_events_org_created_id` + `idx_activity_events_actor_user_id`, per design DDL.
- [ ] 1.2 RED: `backend/internal/activity/service_test.go` — `Record` inside a committed tx persists a row with correct columns (Atomic In-Transaction Recording: committed scenario).
- [ ] 1.3 RED: same file — `Record` inside a tx that later rolls back leaves no orphan row (rollback scenario); `metadata` round-trips through `JSONB` unmodified.
- [ ] 1.4 GREEN: `backend/internal/activity/service.go` — `Service{pool}`, `NewService(pool)`, `type Kind string` + 16 typed constants, `Record(ctx, tx, orgID, actorUserID, kind, targetType, targetID, metadata) error`.
- [ ] 1.5 RED: `backend/internal/activity/cursor_test.go` — `encodeCursor`/`decodeCursor` round-trip; a malformed cursor returns a clear error, not a panic.
- [ ] 1.6 GREEN: `backend/internal/activity/cursor.go` — `encodeCursor(createdAt, id) string`, `decodeCursor(cursor) (createdAt, id, error)`, base64(url-safe) of `"<RFC3339Nano>|<id>"`.
- [ ] 1.7 RED: `backend/internal/activity/service_test.go` — `ListByOrganization` rejects a non-admin caller (non-admin denied scenario); admin sees rows (admin allowed scenario); first page capped/ordered `created_at DESC, id DESC` (first-page scenario); cursor advances without duplicates/gaps across same-`created_at` ties (cursor-advance scenario); `limit` clamps to `[1,100]`.
- [ ] 1.8 GREEN: `backend/internal/activity/service.go` — `ListByOrganization(ctx, requesterUserID, organizationID, cursor, limit) (events, nextCursor, error)`: `access.RequireOrganizationAdmin`, `WHERE organization_id = $1 [AND (created_at, id) < ($2,$3)] ORDER BY created_at DESC, id DESC LIMIT $N+1`, trim + encode `nextCursor`.

## Phase 2: Activity HTTP Handler

- [ ] 2.1 RED: `backend/internal/activity/handler_test.go` — `GET /organizations/{organizationId}/activity` returns 200 + `{events, nextCursor}` for an admin; rejects a non-admin; forwards `cursor`/`limit` query params to `ListByOrganization`.
- [ ] 2.2 GREEN: `backend/internal/activity/handler.go` — `RegisterRoutes(mux, authMiddleware, service routeService)`, `routeService` interface, `r.PathValue("organizationId")`, decode `cursor`/`limit`, `httpapi.WriteJSON`/`WriteError`, `writeActivityError`.

## Phase 3: Organizations Wiring

- [ ] 3.1 `backend/internal/organizations/service.go` — add `activity *activity.Service` field; `NewService(pool, activityService *activity.Service)` new trailing param.
- [ ] 3.2 RED: `backend/internal/organizations/service_test.go` — `CreateOrganizationTx` commit persists `KindOrganizationCreated` scoped to the new org.
- [ ] 3.3 GREEN: insert `activity.Record(...)` in `CreateOrganizationTx` before `tx.Commit()`.
- [ ] 3.4 RED: same file — `CreateInvitationTx`/`ResendInvitation`/`AcceptInvitation` commits persist `KindInvitationCreated`/`Resent`/`Accepted` with the metadata from the design's call-site table.
- [ ] 3.5 GREEN: insert the three `Record` calls before each function's `tx.Commit()`.
- [ ] 3.6 RED: same file — `PatchMember` role-change branch persists `KindOrganizationMemberRoleChanged` (member role change scenario); remove branch persists `KindOrganizationMemberRemoved`.
- [ ] 3.7 GREEN: insert the two `Record` calls, one per `PatchMember` branch, before their respective `tx.Commit()` calls.
- [ ] 3.8 `backend/cmd/api/main.go` — construct `activityService := activity.NewService(pool)` after `accessService`, before `organizationsService`; thread into `organizations.NewService(pool, activityService)`; register `activity.RegisterRoutes(mux, authService.Middleware, activityService)`.

## Phase 4: Workspaces Wiring

- [ ] 4.1 `backend/internal/workspaces/service.go` — add `activity *activity.Service` field; `NewService(pool, accessService, activityService)` new trailing param.
- [ ] 4.2 RED: `backend/internal/workspaces/service_test.go` — `CreateTx` commit persists `KindWorkspaceCreated`.
- [ ] 4.3 GREEN: insert `Record` call in `CreateTx` before `tx.Commit()`.
- [ ] 4.4 RED: same file — `GrantUserAccess`/`RevokeUserAccess`/`GrantGroupAccess`/`RevokeGroupAccess` commits each persist their `Kind*` row (user-access grant scenario and the group-access/revoke equivalents).
- [ ] 4.5 GREEN: insert the four `Record` calls before their respective `tx.Commit()` calls.
- [ ] 4.6 `backend/cmd/api/main.go` — thread `activityService` into `workspaces.NewService(pool, accessService, activityService)`.

## Phase 5: Groups Transaction-Wrap Refactor & Wiring

- [ ] 5.1 RED: `backend/internal/groups/service_test.go` — `Update`/`Delete` still return `ErrNotFound` on no match; `ListMembers` still returns the same ordered set/error behavior (Delete and ListMembers stay behavior-preserving scenario) — assert byte-identical response shape pre/post refactor.
- [ ] 5.2 GREEN: refactor `Update` to `s.pool.Begin(ctx)`/`defer tx.Rollback(ctx)`/`requireOrganizationAdmin(ctx, tx, ...)`, add `SELECT name ... FOR UPDATE` for `previousName`, replace `s.pool.QueryRow` with `tx.QueryRow`, `tx.Commit(ctx)` at the end.
- [ ] 5.3 GREEN: refactor `Delete` and `ListMembers` to the same `tx.Begin`/`defer Rollback`/`tx.*`/`tx.Commit` shape (`ListMembers` gets no `Record` call).
- [ ] 5.4 `backend/internal/groups/service.go` — add `activity *activity.Service` field; `NewService(pool, activityService)` new trailing param.
- [ ] 5.5 RED: same test file — `Update` commit persists `KindGroupRenamed` with `previousName`/`name` (group rename recorded atomically scenario); `Delete` persists `KindGroupDeleted`; `CreateTx` persists `KindGroupCreated`; `AddMemberTx`/`RemoveMember` persist `KindGroupMemberAdded`/`Removed`.
- [ ] 5.6 GREEN: insert the five `Record` calls (per design's call-site table) before each function's `tx.Commit()`.
- [ ] 5.7 RED: `backend/internal/secrethide/service_test.go` (existing file) — creating/burning a secret produces no `activity_events` row referencing it (secret creation produces no activity row scenario) — confirms exclusion by omission.
- [ ] 5.8 `backend/cmd/api/main.go` — thread `activityService` into `groups.NewService(pool, activityService)`.

## Phase 6: admin-web Activity Page

- [ ] 6.1 `admin-web/src/lib/api/activity.ts` — `ActivityKind`, `ActivityEvent`, `ActivityPage` types, `listOrgActivity(organizationId, token, cursor?, limit?)`.
- [ ] 6.2 RED: `admin-web/src/features/activity/format.test.ts` — `formatActivityEvent` covers all 16 kinds with representative metadata fixtures; missing/partial metadata degrades gracefully (no `undefined` in output).
- [ ] 6.3 GREEN: `admin-web/src/features/activity/format.ts` — `formatActivityEvent(event)` per design's 16-branch switch + defensive `default`.
- [ ] 6.4 `admin-web/src/features/activity/queries.ts` — `useOrgActivity(orgId, token)` via `useInfiniteQuery`, cursor as `pageParam`.
- [ ] 6.5 RED: `admin-web/src/features/activity/ActivityPage.test.tsx` — unauthenticated visitor redirected to `/login` with no fetch (unauthenticated scenario); non-admin sees the shared `RequireAdminOrganization` guard state, not the list (non-admin scenario); empty org renders an explicit empty state, not an empty table or spinner (empty list scenario); loading/error/populated states render distinctly.
- [ ] 6.6 GREEN: `admin-web/src/features/activity/ActivityPage.tsx` — `useAuth()`, `RequireAdminOrganization` guard, `useOrgActivity`, `DataState` for loading/error/empty, `Table`/`Badge` rows using `formatActivityEvent`, "Load more" button.
- [ ] 6.7 `admin-web/src/app/router.tsx` — register `activity` sibling route under existing `RequireAdminOrganization`/`AdminLayout`.
- [ ] 6.8 `admin-web/src/app/shell/AdminLayout.tsx` — add nav item `{ to: "/activity", label: "Activity" }`.

## Phase 7: Verification

- [ ] 7.1 `cd backend && go build ./... && go vet ./... && go test ./internal/activity ./internal/organizations ./internal/workspaces ./internal/groups ./internal/secrethide`
- [ ] 7.2 `cd admin-web && npm run build && npm test`
- [ ] 7.3 Manual: `docker compose up`; as an org admin, create an org, invite/accept, change a member role, create a workspace, grant/revoke access, rename/delete a group; confirm each appears in `/activity` newest-first with a readable sentence and no `secrethide` events present.
