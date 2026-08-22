# Tasks: Lifecycle Management — Admin Undo Capabilities

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~1,490–1,600 total across 5 slices |
| 800-line session budget risk | Low (largest slice ≈410–430 lines, comfortably under 800) |
| 400-line reviewer-burden signal | Medium–High (slices 2, 3, 5 sit near 270–393 lines; slice 4 sits right at ≈410–430) |
| Chained PRs recommended | Yes |
| Suggested split | 5 work units, one per design.md slice (already the natural shippable boundary — no further splitting needed) |
| Delivery strategy | ask-on-risk (cached this session) |
| Chain strategy | feature-branch-chain — already selected this session; matches design.md's stated PR-chain order (slice order = PR order, no forward dependency) |

Decision needed before apply: No (chain strategy pre-resolved this session: feature-branch-chain; only the tracker branch `feat/lifecycle-management` eventually merges to `develop`, and per explicit instruction not until the user says so)
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain (5 sequential branches, first off `feat/lifecycle-management`, each merged into the previous slice's branch before the next starts)
400-line budget risk: Medium-High (slice 4 is the one to watch; if it grows during apply, split `ConfirmByTyping` out as its own micro-PR ahead of slice 4)

### Estimate basis (design.md File Changes table, grouped by slice)

| File | Action | Slice | Est. lines |
|---|---|---|---|
| `admin-web/src/app/providers/AuthProvider.tsx`(+test) | Modify | 1 | ~10 + ~15 |
| `admin-web/src/features/members/mutations.ts` | Modify | 1, 2 | ~40 + ~25 |
| `admin-web/src/features/members/MembersPage.tsx`(+test) | Modify | 1, 2 | ~40 + ~110 |
| `backend/internal/organizations/service.go`(+test) | Modify | 2, 4 | ~120 + ~150 |
| `backend/internal/organizations/handler.go`(+test) | Modify | 2, 4 | ~45 + ~60 |
| `backend/internal/activity/service.go` | Modify | 2, 3 | ~4 |
| `admin-web/src/lib/api/activity.ts` / `features/activity/format.ts`(+test) | Modify | 2, 3 | ~4 + ~10 + ~20 |
| `backend/internal/workspaces/service.go`(+test) | Modify | 3 | ~35 + ~70 |
| `backend/internal/workspaces/handler.go`(+test) | Modify | 3 | ~15 + ~30 |
| `admin-web/src/lib/api/workspaces.ts` / `features/workspaces/{mutations,WorkspacesPage}.tsx`(+test) | Modify | 3 | ~10 + ~20 + ~20 + ~50 |
| `admin-web/src/lib/ui/components/ConfirmByTyping.tsx`(+test) | Create | 4 | ~40 + ~30 |
| `admin-web/src/lib/api/organizations.ts` | Modify | 2, 4 | ~10 |
| `admin-web/src/features/organizations/mutations.ts` | Create | 4 | ~30 |
| `admin-web/src/features/home/StateHome.tsx`(+test) | Modify | 4 | ~30 + ~50 |
| `backend/migrations/000013_user_deactivation.sql` | Create | 5 | ~15 |
| `backend/internal/auth/service.go`(+test) | Modify | 5 | ~70 + ~110 |
| `backend/internal/auth/handler.go`(+integration test) | Modify | 5 | ~25 + ~40 |
| `admin-web/src/lib/api/auth.ts` / `features/account/AccountPage.tsx`(+test) | Modify/Create | 5 | ~10 + ~60 + ~50 |
| `admin-web/src/app/router.tsx` / `app/shell/AdminLayout.tsx` | Modify | 5 | ~8 + ~5 |

### Suggested Work Units

| Unit | Goal | Branch | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| 1 | Remove member from organization (admin-web only, backend endpoint already exists) + fix the latent self-role-change sign-out bug | `feat/lifecycle-member-removal` off `feat/lifecycle-management` | PR 1 | `cd admin-web && npm test -- AuthProvider MembersPage` | `docker compose up -d`; log in as org admin, remove a member from `MembersPage`, confirm list refresh and (for self-removal) sign-out branch — or `N/A` this session if Docker/Postgres is unavailable, falling back to production validation per this session's practice | `admin-web/src/app/providers/AuthProvider.tsx`, `features/members/{mutations.ts,MembersPage.tsx}`(+tests) |
| 2 | Cancel pending invitation (backend `CancelInvitation` + widened `ListInvitations` + UI) | `feat/lifecycle-cancel-invitation` off `feat/lifecycle-member-removal` | PR 2, base = 1 | `cd backend && go test ./internal/organizations ./internal/activity && cd admin-web && npm test -- MembersPage format` | `docker compose up -d`; invite then cancel an invitation via `curl`/UI, confirm `status='cancelled'` badge persists in the list — or `N/A` this session if Docker/Postgres is unavailable | `backend/internal/organizations/{service.go,handler.go}`(+tests), `activity/service.go` (`KindInvitationCancelled`), `features/activity/format.ts`(+test), `lib/api/{activity.ts,organizations.ts}`, `features/members/{mutations.ts,MembersPage.tsx}`(+tests) |
| 3 | Delete workspace (backend `Delete` + cascade + UI) | `feat/lifecycle-delete-workspace` off `feat/lifecycle-cancel-invitation` | PR 3, base = 2 | `cd backend && go test ./internal/workspaces ./internal/activity && cd admin-web && npm test -- WorkspacesPage format` | `docker compose up -d`; seed a workspace with folders/bookmarks/access, delete it, confirm cascade emptiness and `workspace.deleted` activity row — or `N/A` this session if Docker/Postgres is unavailable | `backend/internal/workspaces/{service.go,handler.go}`(+tests), `activity/service.go` (`KindWorkspaceDeleted`), `features/activity/format.ts`(+test), `lib/api/{activity.ts,workspaces.ts}`, `features/workspaces/{mutations.ts,WorkspacesPage.tsx}`(+tests) |
| 4 | Delete organization, guarded (orphan check, confirm-by-name, `ConfirmByTyping`) | `feat/lifecycle-delete-organization` off `feat/lifecycle-delete-workspace` | PR 4, base = 3 | `cd backend && go test ./internal/organizations && cd admin-web && npm test -- ConfirmByTyping StateHome` | `docker compose up -d`; seed two orgs sharing one member and one single-org member, attempt/confirm deletion via UI, verify orphan block and successful cascade — or `N/A` this session if Docker/Postgres is unavailable | `backend/internal/organizations/{service.go,handler.go}`(+tests, `ErrWouldOrphanMember`), `lib/ui/components/ConfirmByTyping.tsx`(+test), `lib/api/organizations.ts`, `features/organizations/mutations.ts`, `features/home/StateHome.tsx`(+test) |
| 5 | Self-service account deactivation (migration + login/token gates + UI) | `feat/lifecycle-self-deactivation` off `feat/lifecycle-delete-organization` | PR 5, base = 4 | `cd backend && go test ./internal/auth && cd admin-web && npm test -- AccountPage` | `docker compose up -d`; deactivate a test account, confirm `login()` 403 and a pre-deactivation token 401 — or `N/A` this session if Docker/Postgres is unavailable | `backend/migrations/000013_user_deactivation.sql`, `backend/internal/auth/{service.go,handler.go}`(+tests), `lib/api/auth.ts`, `features/account/AccountPage.tsx`(+test), `app/router.tsx`, `app/shell/AdminLayout.tsx` |

Each unit is developed, tested, and merged into the previous unit's branch before the next unit's branch is created, exactly mirroring the `activity-log` chain. Only the tracker branch `feat/lifecycle-management` eventually merges to `develop`, and only when the user says so.

## Phase 1: Remove Member From Organization (Slice 1 — admin-web only)

- [x] 1.1 RED: `admin-web/src/app/providers/AuthProvider.test.tsx` — `refreshOrganizations()` resolves to the fetched `OrganizationMembership[]` (not `void`), asserting a caller can branch on the list in the same tick.
- [x] 1.2 GREEN: `admin-web/src/app/providers/AuthProvider.tsx` — `refreshOrganizations` returns `Promise<OrganizationMembership[]>`.
- [x] 1.3 RED: `admin-web/src/features/members/MembersPage.test.tsx` — regression test: self *role change* (owner→admin) no longer unconditionally signs out (Deviation #3).
- [x] 1.4 GREEN: `admin-web/src/features/members/mutations.ts` — fix `useUpdateMemberRoleMutation`'s self branch to check the list returned by `refreshOrganizations()` instead of the always-`undefined` `queryClient.getQueryData` read.
- [x] 1.5 RED: `MembersPage.test.tsx` — admin removes another member (busy state, list invalidated without them); confirm-dismissal sends no request; backend `ErrForbidden`/`ErrNotFound` surfaces a `DataState` error and clears busy state.
- [x] 1.6 RED: `MembersPage.test.tsx` — self-removal from the acting user's last organization signs out; self-removal with other organizations remaining does not sign out.
- [x] 1.7 GREEN: `admin-web/src/features/members/mutations.ts` — `useRemoveMemberMutation` calling `PATCH .../members {userId, remove:true}`, branching on `refreshOrganizations()`'s returned list.
- [x] 1.8 GREEN: `admin-web/src/features/members/MembersPage.tsx` — "Remove" action in the members Actions cell, `window.confirm()` guard, `removingUserId` busy state.

## Phase 2: Cancel Pending Invitation (Slice 2)

- [x] 2.1 RED: `backend/internal/organizations/service_test.go` — `CancelInvitation`: admin gate; `pending`→`cancelled` + activity row committed atomically; already-`cancelled`/`accepted`/`expired` → `ErrInvitationNotPending` with no activity row; unknown ID → `ErrNotFound`.
- [x] 2.2 GREEN: `backend/internal/organizations/service.go` — `CancelInvitation(ctx, requesterUserID, organizationID, invitationID) error`.
- [x] 2.3 RED: `service_test.go` — `ListInvitations` after cancel includes the row with `status='cancelled'`, still excludes `accepted`/`expired`.
- [x] 2.4 GREEN: `service.go` — widen `ListInvitations` query to `WHERE status IN ('pending', 'cancelled')`.
- [x] 2.5 RED: `backend/internal/organizations/handler_test.go` — `POST .../invitations/{invitationId}/cancel`: 204 admin; 403 non-admin; 400 `ErrInvitationNotPending`; 404 unknown.
- [x] 2.6 GREEN: `backend/internal/organizations/handler.go` — `routeService` +`CancelInvitation`; register the `cancel` route as a sibling of `resend`; reuse the existing 400 case.
- [x] 2.7 GREEN: `backend/internal/activity/service.go` — add `KindInvitationCancelled Kind = "invitation.cancelled"`.
- [x] 2.8 GREEN: `admin-web/src/lib/api/activity.ts` — add `"invitation.cancelled"` to the `ActivityKind` union.
- [x] 2.9 RED: `admin-web/src/features/activity/format.test.ts` — `formatActivityEvent` renders `invitation.cancelled` with representative and missing metadata.
- [x] 2.10 GREEN: `admin-web/src/features/activity/format.ts` — add the `"invitation.cancelled"` case branch.
- [x] 2.11 GREEN: `admin-web/src/lib/api/organizations.ts` — `cancelOrganizationInvitation(token, organizationId, invitationId)`.
- [x] 2.12 RED: `MembersPage.test.tsx` — admin cancels a pending invitation (busy state, list refreshes to `cancelled` status, row stays visible); a failed request surfaces an error without losing the row; "Cancel"/"Resend" render only when `invitation.status === "pending"`.
- [x] 2.13 GREEN: `admin-web/src/features/members/mutations.ts` — `useCancelInvitationMutation`.
- [x] 2.14 GREEN: `MembersPage.tsx` — "Cancel" button beside "Resend", `cancellingInvitationId` busy state, conditional action rendering on `invitation.status`.

## Phase 3: Delete Workspace (Slice 3)

- [ ] 3.1 RED: `backend/internal/workspaces/service_test.go` — `Delete`: admin gate via `mapAccessError`; cascade emptiness asserted per child table (folders, bookmarks, `workspace_cursors`, `sync_events`, `workspace_user_access`, `workspace_group_access`); `RowsAffected()==0 → ErrNotFound`; `workspace.deleted` activity row present.
- [ ] 3.2 GREEN: `backend/internal/workspaces/service.go` — `Delete(ctx, requesterUserID, workspaceID) error` via `loadWorkspaceMetadataRecord` + `access.RequireOrganizationAdmin`.
- [ ] 3.3 RED: `backend/internal/workspaces/handler_test.go` — `DELETE /workspaces/{workspaceId}`: 204 success; 403 non-admin; 404 unknown/cross-org.
- [ ] 3.4 GREEN: `backend/internal/workspaces/handler.go` — `routeService` +`Delete`; register `DELETE /workspaces/{workspaceId}` → 204.
- [ ] 3.5 GREEN: `backend/internal/activity/service.go` — add `KindWorkspaceDeleted Kind = "workspace.deleted"`.
- [ ] 3.6 GREEN: `admin-web/src/lib/api/activity.ts` — add `"workspace.deleted"` to `ActivityKind`.
- [ ] 3.7 RED: `admin-web/src/features/activity/format.test.ts` — `formatActivityEvent` renders `workspace.deleted` with representative and missing metadata.
- [ ] 3.8 GREEN: `admin-web/src/features/activity/format.ts` — add the `"workspace.deleted"` case branch.
- [ ] 3.9 GREEN: `admin-web/src/lib/api/workspaces.ts` — `deleteWorkspace(token, workspaceId)`.
- [ ] 3.10 RED: `admin-web/src/features/workspaces/WorkspacesPage.test.tsx` — admin deletes a workspace (busy state, list invalidated without it); confirm-dismissal sends no request; a failed request surfaces an error and the row returns to normal.
- [ ] 3.11 GREEN: `admin-web/src/features/workspaces/mutations.ts` — `useDeleteWorkspaceMutation` invalidating `organization(orgId).workspaces` + `["workspaces"]`, mirroring `useDeleteGroupMutation`.
- [ ] 3.12 GREEN: `admin-web/src/features/workspaces/WorkspacesPage.tsx` — `ui-button-secondary` "Delete" beside "Manage access", `window.confirm()` naming the workspace, `deletingWorkspaceId` busy state.

## Phase 4: Delete Organization, Guarded (Slice 4)

- [ ] 4.1 RED: `backend/internal/organizations/service_test.go` — `DeleteOrganization`: admin gate; happy path removes org + all cascades, other orgs' `activity_events` intact; orphan probe blocks with **zero** rows deleted; requester's own orphaning does not block; unknown ID → `ErrNotFound`; explicit assertion that no activity row exists anywhere after a successful delete.
- [ ] 4.2 GREEN: `backend/internal/organizations/service.go` — `ErrWouldOrphanMember` sentinel; `lockOrganization`/`lockOrganizationMemberships` helpers; orphan probe query (`om.user_id <> $2`); `DeleteOrganization(ctx, requesterUserID, organizationID) error`.
- [ ] 4.3 RED: `service_test.go` — concurrent deletion race: two requests evaluating the orphan check concurrently only commit one consistent result (`FOR UPDATE`, matching `ErrLastOwner`).
- [ ] 4.4 GREEN: `service.go` — verify/adjust lock ordering to satisfy 4.3.
- [ ] 4.5 RED: `backend/internal/organizations/handler_test.go` — `DELETE /organizations/{organizationId}`: 204 admin/owner; 403 member role; 409 `ErrWouldOrphanMember`; 404 unknown.
- [ ] 4.6 GREEN: `backend/internal/organizations/handler.go` — `routeService` +`DeleteOrganization`; register `DELETE /organizations/{organizationId}`; new `writeOrganizationError` case for `ErrWouldOrphanMember` → 409.
- [ ] 4.7 RED: `admin-web/src/lib/ui/components/ConfirmByTyping.test.tsx` — button stays disabled on partial/mismatched/whitespace-only input; enabled only on exact case-sensitive match.
- [ ] 4.8 GREEN: `admin-web/src/lib/ui/components/ConfirmByTyping.tsx` — controlled input + confirm button, disabled until `value.trim() === expected`.
- [ ] 4.9 GREEN: `admin-web/src/lib/api/organizations.ts` — `deleteOrganization(token, organizationId)`.
- [ ] 4.10 RED: `admin-web/src/features/home/StateHome.test.tsx` (new) — danger-zone delete stays disabled until the org name is typed exactly; confirmed deletion calls `refreshOrganizations()` then signs out (empty list) or navigates to `/` (non-empty list).
- [ ] 4.11 GREEN: `admin-web/src/features/organizations/mutations.ts` (new) — `useDeleteOrganizationMutation` with the post-delete `refreshOrganizations()` → empty ? `signOut()`+`/login` : `navigate("/")` branch.
- [ ] 4.12 GREEN: `admin-web/src/features/home/StateHome.tsx` — danger-zone `ContextPanel` section wired to `ConfirmByTyping(expected=organizationName)`.

## Phase 5: Self-Service Account Deactivation (Slice 5)

- [ ] 5.1 `backend/migrations/000013_user_deactivation.sql` — `ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ` per design DDL (migration only, no RED counterpart).
- [ ] 5.2 RED: `backend/internal/auth/service_test.go` (new) — `DeactivateSelf`: sole-owner in any org → `ErrSoleOwner`, `disabled_at` untouched, refresh families intact; happy path sets `disabled_at` **and** revokes all families in one commit; second call is a no-op.
- [ ] 5.3 GREEN: `backend/internal/auth/service.go` — `ErrAccountDisabled`, `ErrSoleOwner` sentinels; `DeactivateSelf(ctx, userID) error` using the sole-owner probe + `RevokeAllRefreshFamiliesTx`.
- [ ] 5.4 RED: `service_test.go` — `login()` with valid password on a disabled account → `ErrAccountDisabled` (not `ErrInvalidCredentials`); wrong password on a disabled account → `ErrInvalidCredentials`; `AuthenticateToken` with a pre-deactivation token → `ErrUnauthorized`; `Refresh` cannot mint a session after family revocation.
- [ ] 5.5 GREEN: `service.go` — `disabled_at` gate in `login()` (post-`bcrypt.CompareHashAndPassword`) and in `AuthenticateToken` (`AND u.disabled_at IS NULL`).
- [ ] 5.6 RED: `backend/internal/auth/handler_integration_test.go` — `POST /me/deactivate`: 204 self-only success; 403 `ErrAccountDisabled` surfaced at a subsequent `login()`; 409 `ErrSoleOwner`; unauthenticated → 401.
- [ ] 5.7 GREEN: `backend/internal/auth/handler.go` — register `POST /me/deactivate` → 204 (no body, no user identifier — self-only is structural); `writeAuthError` cases for `ErrAccountDisabled`(403)/`ErrSoleOwner`(409).
- [ ] 5.8 GREEN: `admin-web/src/lib/api/auth.ts` — `deactivateSelf(token)`.
- [ ] 5.9 RED: `admin-web/src/features/account/AccountPage.test.tsx` (new) — deactivate button disabled until `principal.email` is typed exactly via `ConfirmByTyping`; confirmed success signs out and redirects to `/login`; confirm-dismissal sends no request.
- [ ] 5.10 GREEN: `admin-web/src/features/account/AccountPage.tsx` (new) — `ConfirmByTyping(expected=principal.email)`, on success `signOut()` + navigate `/login`.
- [ ] 5.11 GREEN: `admin-web/src/app/router.tsx` — register `{ path: "account", element: <AccountPage /> }` under `AdminLayout`.
- [ ] 5.12 GREEN: `admin-web/src/app/shell/AdminLayout.tsx` — trailing nav item `{ to: "/account", label: "Account" }`.

## Phase 6: Verification

- [ ] 6.1 `cd backend && go build ./... && go vet ./... && go test ./internal/organizations ./internal/workspaces ./internal/auth ./internal/activity`
- [ ] 6.2 `cd admin-web && npm run build && npm test`
- [ ] 6.3 Manual: `docker compose up`; as an org admin, remove a member, cancel an invitation, delete a workspace, delete a guarded organization, and (as a second test user) deactivate an own account; confirm each behaves per the spec scenarios and appears where activity-logged. **Contingency**: if local Postgres/Docker is unavailable this session, this step should validate against production instead, per this session's established practice — check current availability before assuming either way.
