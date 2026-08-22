# Tasks: Soft Delete + Recovery Window for Organizations and Workspaces

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~2,000–2,300 total across 4 design slices (6 recommended work units) |
| 800-line session budget risk | Low individually per work unit; slice 2 and slice 3 each risk exceeding 800 if NOT sub-split |
| 400-line reviewer-burden signal | **High** for slice 2 (~750–900 est., 4 backend packages + 16 named choke-point tests) and slice 3 (~950–1,050 est., 2 backend packages + a full new frontend feature) |
| Chained PRs recommended | Yes |
| Suggested split | 6 work units: 1, 2a, 2b, 3a, 3b, 4 (slices 2 and 3 each pre-split ahead of apply) |
| Delivery strategy | ask-on-risk (cached this session) |
| Chain strategy | feature-branch-chain (cached this session) — tracker `feat/soft-delete-recovery`, off unmerged `feat/lifecycle-management`; only the tracker merges to `develop`, and not until the user says so |

Decision needed before apply: Yes (ask-on-risk requires confirming the 2a/2b and 3a/3b sub-splits below before `sdd-apply` starts slice 2 or slice 3; slice 1 and slice 4 are low-risk and need no further split)
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High (slices 2 and 3, as designed in `design.md`, are each individually likely to exceed 400 changed lines — see Estimate basis)

### Why slice 2 is flagged (per orchestrator instruction)

Slice 2 touches 4 backend packages (`organizations`, `groups`, `access`, `workspaces`) plus a migration and 2 frontend files, and `design.md`'s own Testing Strategy demands "one named case per numbered choke-point row" — 16 named RED tests, not 1 bundled test. `lifecycle-management`'s comparable slice 4 (guarded org delete) was estimated at ~410–430 lines and landed at **~694 actual (+60% overrun)**. Slice 2 here starts from a *higher* estimate (~750–900) before any overrun buffer, so a similar overrun would land it at **~1,100–1,400 actual lines** — well past the 400-line reviewer-burden threshold and into the 800-line session budget zone. **Recommendation: split slice 2 into 2a (core soft-delete conversion + migration) and 2b (the 16-point inaccessibility sweep + its tests) before apply.**

Slice 3 (restore endpoints + a full new Trash frontend feature) shows a comparable ~950–1,050 estimate for the same structural reason (2 backend packages + 1 new frontend feature area + router/nav wiring). **Recommendation: split slice 3 into 3a (backend restore/list-deleted endpoints) and 3b (frontend Trash feature + wiring).**

### Estimate basis (design.md File Changes table, grouped by slice)

| File | Action | Slice | Est. lines |
|---|---|---|---|
| `admin-web/src/features/workspaces/WorkspacesPage.tsx`(+test) | Modify | 1 | ~50 + ~110 |
| `backend/migrations/000014_soft_delete.sql` | Create | 2a | ~30 |
| `backend/internal/organizations/service.go`(+test) — soft-delete UPDATE, CP4, CP9, orphan probe | Modify | 2a | ~50 + ~70 |
| `backend/internal/workspaces/service.go`(+test) — soft-delete UPDATE | Modify | 2a | ~25 + ~35 |
| `backend/internal/activity/service.go` — `KindOrganizationDeleted` | Modify | 2a | ~2 |
| `backend/internal/organizations/service.go`(+test) — CP1,2,3,5,6,7,8 | Modify | 2b | ~65 + ~185 |
| `backend/internal/groups/service.go`(+test) — CP10,11 | Modify | 2b | ~12 + ~50 |
| `backend/internal/access/service.go`(+test) — CP12,13, sync/websocket regression | Modify | 2b | ~12 + ~75 |
| `backend/internal/workspaces/service.go`(+test) — CP14,15,16 | Modify | 2b | ~20 + ~90 |
| `admin-web/src/lib/api/activity.ts` / `features/activity/format.ts`(+test) — `organization.deleted` | Modify | 2b | ~2 + ~10 + ~15 |
| `openspec/changes/lifecycle-management/specs/` | Modify | 2b | ~15 |
| `backend/internal/purge/purge.go` — `Window` const + doc | Create | 3a | ~15 |
| `backend/internal/organizations/{service,handler}.go`(+tests) — Restore, ListDeleted | Modify | 3a | ~110 + ~35 + ~180 + ~50 |
| `backend/internal/workspaces/{service,handler}.go`(+tests) — Restore, ListDeleted | Modify | 3a | ~90 + ~30 + ~120 + ~50 |
| `activity/service.go` / `lib/api/activity.ts` / `features/activity/format.ts`(+test) — restored kinds | Modify | 3a | ~4 + ~2 + ~30 |
| `admin-web/src/lib/api/{organizations,workspaces,queryKeys}.ts` | Modify | 3b | ~15 + ~15 + ~6 |
| `admin-web/src/features/trash/{queries,mutations,TrashPage}.tsx`(+test) | Create | 3b | ~30 + ~40 + ~90 + ~110 |
| `admin-web/src/app/router.tsx` / `shell/AdminLayout.tsx` / `app/views/OrganizationSetupPage.tsx` | Modify | 3b | ~10 + ~6 + ~15 |
| `openspec/changes/lifecycle-management/specs/` | Modify | 3b | ~15 |
| `backend/internal/purge/purge.go`(+test) — `Sweeper`, `Sweep`, `Run` | Modify | 4 | ~40 + ~90 |
| `backend/cmd/api/main.go` | Modify | 4 | ~4 |

### Suggested Work Units

| Unit | Goal | Branch | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| 1 | Workspace delete UX parity (`ConfirmByTyping` via `ContextPanel`) | `feat/soft-delete-workspace-ux` off `feat/soft-delete-recovery` | PR 1 | `cd admin-web && npm test -- WorkspacesPage` | `docker compose up -d`; delete a workspace, confirm typed-name gate — or `N/A` this session, verify Docker/Postgres availability at apply time | `admin-web/src/features/workspaces/WorkspacesPage.tsx`(+test); pure frontend revert restores `window.confirm` |
| 2a | Soft-delete core: migration 000014, `DeleteOrganization`/`workspaces.Delete` UPDATE conversion, orphan-probe strictness fix, `KindOrganizationDeleted` | `feat/soft-delete-core` off `feat/soft-delete-workspace-ux` | PR 2, base = 1 | `cd backend && go test ./internal/organizations ./internal/workspaces ./internal/activity` | `docker compose up -d`; delete an org and a workspace, confirm rows survive with `deleted_at` set and children intact — or `N/A`, verify at apply time | `backend/migrations/000014_soft_delete.sql`, `organizations/service.go`, `workspaces/service.go`, `activity/service.go` |
| 2b | Inaccessibility sweep: all 16 choke points (organizations CP1-3,5-8; groups CP10-11; access CP12-13; workspaces CP14-16), sync/websocket regression, `format.ts` | `feat/soft-delete-inaccessibility` off `feat/soft-delete-core` | PR 3, base = 2a | `cd backend && go test ./internal/organizations ./internal/groups ./internal/access ./internal/workspaces ./internal/sync && cd admin-web && npm test -- format` | `docker compose up -d`; soft-delete an org, confirm sync/websocket/API immediately reject — or `N/A`, verify at apply time | `organizations/service.go`, `groups/service.go`, `access/service.go`, `workspaces/service.go`(+tests); each predicate is independently revertible |
| 3a | Backend restore + list-deleted endpoints for both entity types, `purge.Window` | `feat/soft-delete-restore-backend` off `feat/soft-delete-inaccessibility` | PR 4, base = 2b | `cd backend && go test ./internal/organizations ./internal/workspaces ./internal/purge` | `docker compose up -d`; restore a soft-deleted org and workspace, confirm full access returns — or `N/A`, verify at apply time | `organizations/{service,handler}.go`, `workspaces/{service,handler}.go`, `purge/purge.go`(+tests); revert removes the routes, rows stay recoverable via DB |
| 3b | Trash frontend feature + router/nav wiring | `feat/soft-delete-trash-ui` off `feat/soft-delete-restore-backend` | PR 5, base = 3a | `cd admin-web && npm test -- TrashPage format` | `docker compose up -d`; open `/trash` with zero live orgs, restore from the list — or `N/A`, verify at apply time | `admin-web/src/features/trash/*`, `app/router.tsx`, `shell/AdminLayout.tsx`, `app/views/OrganizationSetupPage.tsx`; revert removes the route and nav item only |
| 4 | Scheduled purge ticker | `feat/soft-delete-purge-sweeper` off `feat/soft-delete-trash-ui` | PR 6, base = 3b | `cd backend && go test ./internal/purge` | `docker compose up -d`; back-date a `deleted_at` row past the window, confirm the next sweep purges it — or `N/A`, verify at apply time | `backend/internal/purge/purge.go`(+test), `backend/cmd/api/main.go`; revert stops the sweep, nothing purged |

Each unit is developed, tested, and merged into the previous unit's branch before the next unit's branch is created. Only the tracker branch `feat/soft-delete-recovery` eventually merges to `develop`, and only when the user says so.

## Phase 1: Workspace Delete UX Parity (Slice 1 — frontend only)

- [x] 1.1 RED: `admin-web/src/features/workspaces/WorkspacesPage.test.tsx` — Delete opens `?panel=workspace-delete&workspace={id}` and sends nothing on open.
- [x] 1.2 RED: same file — confirm button stays disabled on partial/mismatched/whitespace-only input into `ConfirmByTyping`.
- [x] 1.3 RED: same file — exact-name match enables the button and fires exactly one delete mutation on submit.
- [x] 1.4 RED: same file — switching the selected workspace row resets typed text (the `key={selectedWorkspaceId}` remount).
- [x] 1.5 RED: same file — closing the panel without confirming sends no request.
- [x] 1.6 RED: same file — backend rejection shows the `notice` `DataState` and resets busy/panel state without removing the row.
- [x] 1.7 GREEN: `WorkspacesPage.tsx` — replace `window.confirm()` (line 108) with a `ContextPanel` opened via `?panel=workspace-delete&workspace={id}`, `key={selectedWorkspaceId}`, embedding `ConfirmByTyping(expected=workspace.workspaceName)`; keep `deletingWorkspaceId` busy flag and `notice` banner unchanged.

## Phase 2: Soft Delete + Immediate Inaccessibility (Slice 2 — recommend splitting into 2a/2b, see forecast)

### 2a — Soft-delete core

- [x] 2.1 CREATE: `backend/migrations/000014_soft_delete.sql` — nullable `deleted_at`/`deleted_by_user_id` on `organizations` and `workspaces`; trash-side partial indexes `idx_organizations_deleted_at`, `idx_workspaces_deleted_at`; rollback comment per design DDL.
- [x] 2.2 RED: `organizations/service_test.go` — `DeleteOrganization`: row survives with `deleted_at`/`deleted_by_user_id` set; every child table (`organization_members`, `workspaces`, `invitations`, `groups`, `activity_events`, `sync_events`) still populated; second call → `ErrNotFound`.
- [x] 2.3 GREEN: `organizations/service.go` — `DeleteOrganization` switches to `UPDATE ... SET deleted_at=NOW(), deleted_by_user_id=$2 WHERE id=$1 AND deleted_at IS NULL`; `lockOrganization` gains `AND deleted_at IS NULL` (choke point 4).
- [x] 2.4 GREEN: `activity/service.go` — add `KindOrganizationDeleted Kind = "organization.deleted"`; `organizations/service.go` records it inside `DeleteOrganization`'s transaction.
- [x] 2.5 RED: `organizations/service_test.go` — orphan probe: a member whose only other organization is soft-deleted is treated as orphaned, blocks with `ErrWouldOrphanMember`, `deleted_at` untouched (Deviation 5).
- [x] 2.6 GREEN: `organizations/service.go` — orphan probe's inner `NOT EXISTS` gains `AND EXISTS (SELECT 1 FROM organizations o2 WHERE o2.id = other.organization_id AND o2.deleted_at IS NULL)` (choke point 9).
- [x] 2.7 RED: `workspaces/service_test.go` — `Delete`: row survives with `deleted_at`/`deleted_by_user_id` set; children (`folders`, `bookmarks`, `workspace_user_access`, `workspace_group_access`, `workspace_cursors`, `sync_events`) still populated; second call → `ErrNotFound`. (Implemented in `workspaces/service_integration_test.go`, the actual file holding these DB-backed fixtures — `service_test.go` in this package holds only pure-logic tests.)
- [x] 2.8 GREEN: `workspaces/service.go` — `Delete` switches to `UPDATE ... SET deleted_at=NOW(), deleted_by_user_id=$3 WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`.

### 2b — Inaccessibility sweep (16 choke points, one named test per row)

- [x] 2.9 RED: `organizations/service_test.go` — CP1 `ListMemberships` excludes a deleted org from the org switcher.
- [x] 2.10 RED: `organizations/service_test.go` — CP2 `loadOrganizationRole`/`requireOrganizationAdmin` rejects on a deleted org, closing `ListMembers`, `PatchMember`, `AuthorizeInvitationTx`, `ListInvitations`, `CancelInvitation`, `ResendInvitation`, `DeleteOrganization`.
- [x] 2.11 RED: `organizations/service_test.go` — CP3 `loadOrganizationMember` (defense in depth behind CP2) → `ErrNotFound`.
- [x] 2.12 RED: `organizations/service_test.go` — CP5 `CreateInvitationTx` context rejects on a deleted org (defense in depth behind CP2).
- [x] 2.13 RED: `organizations/service_test.go` — CP6 `ResendInvitation` context rejects on a deleted org (defense in depth behind CP2).
- [x] 2.14 RED: `organizations/service_test.go` — CP7 `ValidatePendingInvitation` (required, token route, no upstream gate) blocks registering into a deleted org.
- [x] 2.15 RED: `organizations/service_test.go` — CP8 `loadInvitationForUpdate` (required, `AcceptInvitation` is token-based and ungated) blocks accepting into a deleted org.
- [x] 2.16 GREEN: `organizations/service.go` — implement CP1 + CP2 (`AND o.deleted_at IS NULL` on both JOINs).
- [x] 2.17 GREEN: `organizations/service.go` — implement CP3.
- [x] 2.18 GREEN: `organizations/service.go` — implement CP5 + CP6.
- [x] 2.19 GREEN: `organizations/service.go` — implement CP7 + CP8.
- [x] 2.20 RED: `groups/service_test.go` — CP10 `requireOrganizationAdmin` (the duplicate) rejects group admin ops on a deleted org.
- [x] 2.21 RED: `groups/service_test.go` — CP11 `requireOrganizationMembership` rejects group-member ops on a deleted org.
- [x] 2.22 GREEN: `groups/service.go` — implement CP10 (closes the exploration's named blind spot) + CP11.
- [x] 2.23 RED: `access/service_test.go` — CP12 `IsOrganizationAdmin` rejects on a deleted org, closing `activity.ListByOrganization` and all 8 `workspaces` org-admin gates.
- [x] 2.24 RED: `access/service_test.go` — CP13 `loadWorkspaceMetadata` (highest leverage) rejects `GetTree`, `GET /workspaces/{id}`, bookmark mutations, sync `ListChanges`, websocket connect.
- [x] 2.25 GREEN: `access/service.go` — implement CP12.
- [x] 2.26 GREEN: `access/service.go` — implement CP13 (`AND w.deleted_at IS NULL AND o.deleted_at IS NULL`).
- [x] 2.27 RED: extend sync/websocket integration tests — `sync.ListChanges`, a bookmark mutation, and websocket connect (`GetAccessibleWorkspace`) all reject immediately after the workspace's org is soft-deleted (proves CP13 propagation).
- [x] 2.28 RED: `workspaces/service_test.go` — CP14 `ListByOrganization` excludes a deleted org's workspaces and a soft-deleted workspace within a live org.
- [x] 2.29 RED: `workspaces/service_test.go` — CP15 `loadWorkspaceMetadataRecord` makes double-delete and `GetAccessSnapshot` return `ErrNotFound`.
- [x] 2.30 RED: `workspaces/service_test.go` — CP16 `loadWorkspaceOrganizationID` makes `GrantUserAccess`/`RevokeUserAccess`/`GrantGroupAccess`/`RevokeGroupAccess` return `ErrNotFound`.
- [x] 2.31 GREEN: `workspaces/service.go` — implement CP14 (`AND o.deleted_at IS NULL` on JOIN, `AND w.deleted_at IS NULL` on outer WHERE).
- [x] 2.32 GREEN: `workspaces/service.go` — implement CP15.
- [x] 2.33 GREEN: `workspaces/service.go` — implement CP16.
- [x] 2.34 GREEN: `organizations/handler_test.go` + `workspaces/handler_test.go` — regression: `DELETE /organizations/{id}` and `DELETE /workspaces/{id}` keep their exact existing 204/403/404 status set; only the persisted effect (soft vs. hard) differs.
- [x] 2.35 RED: `admin-web/src/features/activity/format.test.ts` — `formatActivityEvent` renders `organization.deleted` with representative and missing metadata.
- [x] 2.36 GREEN: `admin-web/src/features/activity/format.ts` — add the `"organization.deleted"` case branch.
- [x] 2.37 GREEN: `admin-web/src/lib/api/activity.ts` — add `"organization.deleted"` to `ActivityKind`.
- [x] 2.38 GREEN: `openspec/changes/lifecycle-management/specs/lifecycle-management/spec.md` — Delete Organization/Workspace requirements stop claiming deletion is permanent (superseded by this change).

## Phase 3: Restore + Trash (Slice 3 — recommend splitting into 3a/3b, see forecast)

### 3a — Backend restore + list-deleted

- [x] 3.1 CREATE: `backend/internal/purge/purge.go` — `Window = 30 * 24 * time.Hour` const + package doc (slice 3 scope only; `Sweeper` added in slice 4).
- [x] 3.2 RED: `organizations/service_test.go` — `RestoreOrganization`: owner/admin restore succeeds, `deleted_at` cleared, entity fully usable (memberships, workspaces, bookmarks, pre-deletion activity trail intact); a plain `member` → `ErrForbidden`; a non-member → `ErrForbidden`; restoring a live org → `ErrNotFound`; unknown id → `ErrNotFound`; no orphan/sole-owner guard re-runs; `organization.restored` recorded.
- [x] 3.3 GREEN: `organizations/service.go` — `lockDeletedOrganization` (`WHERE id=$1 AND deleted_at IS NOT NULL FOR UPDATE`); `loadOrganizationRoleIncludingDeleted` (byte-identical to pre-slice-2 `loadOrganizationRole` SQL — the deliberate exception); `RestoreOrganization(ctx, requesterUserID, organizationID) error`.
- [x] 3.4 GREEN: `activity/service.go` — add `KindOrganizationRestored`, `KindWorkspaceRestored`.
- [x] 3.5 RED: `organizations/service_test.go` — `ListDeletedOrganizations`: returns only orgs the requester owns/admins; a plain member of a trashed org gets an empty result, not a 403; `purgeAt == deletedAt + purge.Window`.
- [x] 3.6 GREEN: `organizations/service.go` — `ListDeletedOrganizations` running the Trash organizations query (inline `JOIN organization_members` role filter as authorization, `LEFT JOIN users` for `deleted_by`).
- [x] 3.7 RED: `organizations/handler_test.go` — `POST /organizations/{organizationId}/restore` → 204/403/404; `GET /organizations/deleted` → 200 `{"organizations":[...]}`.
- [x] 3.8 GREEN: `organizations/handler.go` — `routeService` +`RestoreOrganization`,+`ListDeletedOrganizations`; register both routes.
- [x] 3.9 RED: `workspaces/service_test.go` — `Restore`: succeeds inside a live org; a workspace inside a soft-deleted org → `ErrNotFound` (restore the org first); restoring a live workspace → `ErrNotFound`; non-admin → `ErrForbidden`; `workspace.restored` recorded.
- [x] 3.10 GREEN: `workspaces/service.go` — `loadDeletedWorkspaceMetadataRecord` (`w.deleted_at IS NOT NULL AND o.deleted_at IS NULL`); `Restore(ctx, requesterUserID, workspaceID) error` via `access.RequireOrganizationAdmin`.
- [x] 3.11 RED: `workspaces/service_test.go` — `ListDeleted`: returns only workspaces the requester owns/admins; workspaces of a trashed organization are excluded; `purgeAt == deletedAt + purge.Window`.
- [x] 3.12 GREEN: `workspaces/service.go` — `ListDeleted` running the Trash workspaces query.
- [x] 3.13 RED: `workspaces/handler_test.go` — `POST /workspaces/{workspaceId}/restore` → 204/403/404; `GET /workspaces/deleted` → 200; route-precedence test that `/workspaces/deleted` does not match `{workspaceId}`.
- [x] 3.14 GREEN: `workspaces/handler.go` — `routeService` +`Restore`,+`ListDeleted`; register both routes.
- [x] 3.15 RED: `admin-web/src/features/activity/format.test.ts` — renders `organization.restored` and `workspace.restored` with representative and missing metadata.
- [x] 3.16 GREEN: `admin-web/src/features/activity/format.ts` — add both case branches; `admin-web/src/lib/api/activity.ts` — add both to `ActivityKind`.

### 3b — Trash frontend feature + wiring

- [x] 3.17 GREEN: `admin-web/src/lib/api/organizations.ts` — `restoreOrganization(token, organizationId)`, `listDeletedOrganizations(token)`.
- [x] 3.18 GREEN: `admin-web/src/lib/api/workspaces.ts` — `restoreWorkspace(token, workspaceId)`, `listDeletedWorkspaces(token)`.
- [x] 3.19 GREEN: `admin-web/src/lib/api/queryKeys.ts` — `trash.organizations`, `trash.workspaces` (top-level, not org-scoped).
- [x] 3.20 GREEN: `admin-web/src/features/trash/queries.ts` (new) — `useDeletedOrganizations`, `useDeletedWorkspaces`.
- [x] 3.21 GREEN: `admin-web/src/features/trash/mutations.ts` (new) — `useRestoreOrganizationMutation` (invalidates `trash.organizations`+`auth.organizations`, calls `refreshOrganizations()`), `useRestoreWorkspaceMutation` (invalidates `trash.workspaces`+`organization(orgId).workspaces`+`["workspaces"]`).
- [x] 3.22 RED: `admin-web/src/features/trash/TrashPage.test.tsx` (new) — both lists render; days-remaining derives from `purgeAt`; missing `deletedByEmail` degrades gracefully; Restore disables its row while pending (no `ConfirmByTyping` — restore is non-destructive); org restore triggers `refreshOrganizations`.
- [x] 3.23 GREEN: `admin-web/src/features/trash/TrashPage.tsx` (new) — two `Table`s (name, deleted, deleted by, days remaining, Restore), `restoringId` busy state, `notice` `DataState` — the `WorkspacesPage` shape.
- [x] 3.24 GREEN: `admin-web/src/app/router.tsx` — register `{ path: "trash", element: <TrashPage /> }` as a SIBLING of `setup/organization`, directly under `RequireSession` — NOT nested inside `AdminLayout`/`RequireAdminOrganization` (resolved Open Question; makes Trash reachable with zero live organizations).
- [x] 3.25 GREEN: `admin-web/src/app/shell/AdminLayout.tsx` — `{ to: "/trash", label: "Trash" }` before the trailing Account item.
- [x] 3.26 GREEN: `admin-web/src/app/views/OrganizationSetupPage.tsx` — "Recover a deleted organization" link to `/trash`.
- [x] 3.27 GREEN: `openspec/changes/lifecycle-management/specs/lifecycle-management/spec.md` — complete the delete-permanence correction (restore/trash now documented).

## Phase 4: Scheduled Purge (Slice 4)

- [x] 4.1 RED: `backend/internal/purge/purge_test.go` — `Sweep`: rows older than `Window` hard-deleted with FK children; rows inside the window survive; a soft-deleted org's workspaces cascade-destroyed even with their own `deleted_at IS NULL`; empty sweep → `(0,0)`, nil error; a cancelled `ctx` aborts without partial commit.
- [x] 4.2 GREEN: `backend/internal/purge/purge.go` — `Result{Organizations, Workspaces int64}`; `NewSweeper(pool, output io.Writer) *Sweeper`; `Sweep(ctx)` running both `DELETE`s (organizations first) in one transaction, `$1=Window`.
- [x] 4.3 RED: `purge_test.go` — every `Sweep` call logs `event=purge_sweep_completed organizations=%d workspaces=%d duration_ms=%d`, including zero-count sweeps; failures log `event=purge_sweep_failed` with no error detail.
- [x] 4.4 GREEN: `purge.go` — structured log lines per `Sweep` call, following `LogIdempotencyCleanupFailure`'s no-detail-on-failure policy.
- [x] 4.5 RED: `purge_test.go` — `Run(ctx, interval)`: fires `Sweep` on each tick, returns promptly on `ctx` cancellation (mirrors `idempotencyExecutor.Cleanup`'s ticker shape).
- [x] 4.6 GREEN: `purge.go` — `Run(ctx, interval time.Duration)` ticker loop, `select` on `ctx.Done()`/`ticker.C`.
- [x] 4.7 GREEN: `backend/cmd/api/main.go` — `purgeSweeper := purge.NewSweeper(pool, os.Stdout)`; `go purgeSweeper.Run(ctx, time.Hour)`, alongside the existing `idempotencyExecutor` ticker block (`main.go:110-123`).

## Phase 5: Verification

- [x] 5.1 `cd backend && go build ./... && go vet ./... && go test ./internal/organizations ./internal/workspaces ./internal/groups ./internal/access ./internal/activity ./internal/purge ./internal/sync` — build/vet clean; all 7 packages pass (`ok`), no failures.
- [x] 5.2 `cd admin-web && npm run build && npm test` — build clean; 23 test files, 163/163 passing.
- [ ] 5.3 `docker ps` shows no Postgres container running this session — deferred. Per this session's established practice (`lifecycle-management`'s task 6.3 precedent), this validates against production instead: delete a workspace via typed-name confirm and delete an organization, confirm both vanish from listings/sync/websocket immediately, restore each from Trash, confirm full access returns, and (once the 30-day window has genuinely elapsed) confirm the sweep purges it.
