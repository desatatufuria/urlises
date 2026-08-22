# Design: Lifecycle Management — Admin Undo Capabilities

## Technical Approach

Five independently shippable slices, ordered lowest-risk first. Nothing here invents a pattern: each backend slice is a near-verbatim application of an existing in-repo template — `groups.Delete` (`groups/service.go:192-223`) for scoped deletes, `ResendInvitation` (`organizations/service.go:515-600`) for invitation state transitions, `PatchMember`'s remove branch (`organizations/service.go:283-349`) for `FOR UPDATE` locking around a cross-member guard. Every mutating slice runs one `s.pool.Begin` / `defer tx.Rollback` / authorize / lock / mutate / `activity.Record` / `tx.Commit` sequence; none goes through `httpapi.IdempotencyExecutor` (that is reserved for creation routes — removal side effects are naturally idempotent, exploration finding). Handlers stay thin: `auth.PrincipalFromContext` → `r.PathValue` → service call → `204 No Content` or `write{Domain}Error`. On the frontend every slice reuses the established `window.confirm()` + per-row busy state + React Query invalidation + `DataState` notice pattern; slices 4 and 5 add the one genuinely new UI primitive, a shared `ConfirmByTyping` component, because the existing `lib/ui/components/` set (`Table`, `DataState`, `Badge`, `FormRow`, `AppShell`, `ContextPanel`) has no type-to-confirm affordance.

Two findings materially change what the proposal assumed and are flagged as **decisions requiring re-confirmation** (see Deviations Requiring Re-confirmation): `organization.deleted` cannot exist as an activity kind, and `useUpdateMemberRoleMutation`'s self-removal branch is latently broken and cannot be mirrored as-is.

Slice independence: each slice compiles, ships and rolls back on its own. The only cross-slice artifact is `ConfirmByTyping` (slice 4 creates it, slice 5 reuses it) and `AuthProvider.refreshOrganizations`' return type (slice 1 changes it, slice 4 reuses it) — both are created by the earlier slice, so shipping in order has no forward dependency.

## Architecture Decisions

| Decision | Options / tradeoff | Choice and rationale |
|---|---|---|
| Slice 2 REST shape | `DELETE /organizations/{organizationId}/invitations/{invitationId}` vs. `POST .../invitations/{invitationId}/cancel` | **`POST .../cancel`.** This is a state transition, not a resource removal: the `invitations` row survives with `status='cancelled'`, keeping `invited_by_user_id`/`accepted_by_user_id` provenance intact (and `invited_by_user_id ON DELETE RESTRICT` means those rows are load-bearing). `DELETE` would advertise that the row is gone, which is false. It also sits as a direct sibling of the already-registered `POST .../invitations/{invitationId}/resend` at the same nesting level, so route registration is a copy of the block immediately above it in `organizations/handler.go:222-240`. |
| Slice 2 response | `200` + `pendingInvitationView` (mirroring resend) vs. `204 No Content` | **`204 No Content`**, with `CancelInvitation(...) error`. Matches the repo's removal convention (`PATCH .../members {remove:true}` → 204, `groups.Delete` → 204, `DELETE .../access` → 204). The UI does not need the row back on the cancel call itself — it re-lists after invalidation (see next row: `ListInvitations` now returns cancelled rows too, so the row stays visible with an updated status badge rather than disappearing). |
| Slice 2 `ListInvitations` scope | Keep `WHERE status = 'pending'` (cancelled rows disappear) vs. widen to `WHERE status IN ('pending', 'cancelled')` | **Widen to `IN ('pending', 'cancelled')`** — user decision (confirmed): a cancelled invitation must show as "Cancelled" in the table, not vanish. `MembersPage.tsx`'s existing invitations table already renders `<Badge tone={invitation.status === "pending" ? "accent" : "neutral"}>{invitation.status}</Badge>` generically off `invitation.status` (`MembersPage.tsx` `renderInvitationsSection`) — no new frontend badge component needed, the widened backend response is sufficient. `accepted`/`expired` rows stay excluded (unchanged scope, not part of this decision). The "Cancel"/"Resend" action buttons must only render when `invitation.status === "pending"` so a cancelled row shows no stale actions. |
| Slice 3 service signature | `Delete(ctx, requesterUserID, organizationID, workspaceID)` (as proposed) vs. `Delete(ctx, requesterUserID, workspaceID)` | **`Delete(ctx, requesterUserID, workspaceID) error`.** The route is `DELETE /workspaces/{workspaceId}` — there is no `organizationId` path segment to supply the fourth argument, so the proposed signature is unimplementable against the proposed route. Every existing workspace-scoped method (`RevokeUserAccess`, `GrantUserAccess`, `RevokeGroupAccess`) resolves the org from the row via `loadWorkspaceOrganizationID(ctx, tx, workspaceID)` and then calls `access.RequireOrganizationAdmin`. Slice 3 does exactly that. Flagged below. |
| Slice 3 no `DeleteTx` variant | Export `DeleteTx` for symmetry with `CreateTx` vs. `Delete` only | **`Delete` only.** `*Tx` variants exist in this repo solely so `httpapi.IdempotencyExecutor` can drive the mutation inside its own transaction; delete routes are not wired to the executor, so a `DeleteTx` would have zero callers. `groups.Delete` has no `DeleteTx` either. |
| Slice 4 activity event | Record `activity.KindOrganizationDeleted` (as the proposal's Affected Areas states) vs. record nothing | **Record nothing.** `activity_events.organization_id` is `NOT NULL REFERENCES organizations(id) ON DELETE CASCADE` (`000012_activity_events.sql:3`). Recording before the `DELETE` inserts a row the same transaction's cascade immediately removes; recording after the `DELETE` violates the FK and aborts the transaction. There is no ordering in which the event survives. This is the logical consequence of Decision A ("the organization and its own history cease to exist together"), not a new choice — but it contradicts the proposal's file-level plan and is flagged below. |
| Slice 4 orphan-check locking scope | Lock only this org + its memberships (`FOR UPDATE`, spec-mandated) vs. additionally lock every affected user's membership rows across all organizations | **This org + its memberships only.** The wider lock would close a residual cross-org race (member M passes the check while concurrently being removed from their only other org) at the cost of taking `FOR UPDATE` on rows in unrelated organizations, introducing a real deadlock ordering hazard against concurrent `PatchMember` calls in those orgs. Proportionality: orphaning is *already* freely reachable today through `PatchMember(remove:true)` on a member's last org — the very case `useUpdateMemberRoleMutation`'s sign-out branch exists to handle. The guard is a bulk-accident safety net, not a system invariant, so it does not warrant cross-org lock escalation. Residual race documented under Open Questions. |
| Slice 4 requester exclusion | Include the requester in the orphan check vs. exclude them | **Exclude the requester** (`om.user_id <> $2`). Deleting your own last organization is a deliberate self-service act with a defined client-side outcome (refresh orgs → empty → sign out), exactly mirroring the self-removal precedent. Blocking it would make a sole-member org permanently undeletable. |
| Slice 5 column shape | `is_active BOOLEAN NOT NULL DEFAULT TRUE` vs. `disabled_at TIMESTAMPTZ NULL` | **`disabled_at TIMESTAMPTZ NULL`.** Encodes the fact *and* the moment — audit value that matters for the fintech framing, and a boolean would need a second column to carry it. Nullable-with-no-default means existing rows are active with zero backfill. Matches the repo's timestamp idiom (`accepted_at`, `expires_at`, `last_seen_at`, `consumed_at`, `deleted_at`). No index: every read is `WHERE email = $1` (unique) or `WHERE u.id = $1` (PK), so the predicate filters an already-located single row; a partial index would add write cost for no read benefit. |
| Slice 5 `AuthenticateToken` gate | Gate at `login()` only vs. also on every authenticated request | **Both** (spec-required, and cheap). `AuthenticateToken` already resolves one `users` row by primary key joined to `devices`; adding `AND u.disabled_at IS NULL` filters a row the index lookup has already produced — no extra probe, no extra round trip, no new error branch (`pgx.ErrNoRows` is already mapped to `ErrUnauthorized`). The same request already issues a second statement (`UPDATE devices SET last_seen_at`), so the marginal cost is negligible against existing per-request work. Without it, an access token minted seconds before deactivation stays valid for its full TTL. |
| Slice 5 error distinguishability | Same generic 401 everywhere vs. distinct login error | **Distinct at login, generic at token auth.** `login()` returns `ErrAccountDisabled` (→ 403) so the user gets an actionable message — safe because the check runs *after* `bcrypt.CompareHashAndPassword` succeeds, so a wrong password still yields `ErrInvalidCredentials` and no account-state is leaked to a non-owner. `AuthenticateToken` keeps the generic `ErrUnauthorized`/401: distinguishing there would need a second query and would leak state to a bearer of a stale token. |
| Slice 5 route | `DELETE /me` vs. `POST /me/deactivate` | **`POST /me/deactivate`.** `DELETE /me` advertises erasure, which Decision B explicitly rejects. `/me/*` is the established self-scoped namespace (`GET /me`, `GET|PUT /me/preferences`) registered under `service.Middleware` in `auth.RegisterRoutes`. The route takes no body and no user identifier at all — self-only is structural, not a validated field, which is what the spec's "MUST NOT accept or act on any other user's ID" requires. |
| Type-to-confirm UI | Reuse an existing component vs. new shared primitive | **New `lib/ui/components/ConfirmByTyping.tsx`.** Verified absent: `lib/ui/components/` contains only `Table`, `DataState`, `Badge`, `FormRow`, `AppShell`, `ContextPanel`. One controlled input + one confirm button, disabled until `value.trim() === expected` (exact, case-sensitive — the friction is the point). Slice 4 passes the organization name; slice 5 passes the user's own email. |
| Slice 5 UI location | Inline next to "Sign out" in `AdminLayout` vs. a dedicated page | **New `/account` route + `AccountPage.tsx` + a trailing `Account` nav item.** The context-actions bar already carries an org select, a colour-scheme select, a role badge and Sign out; adding an irreversible action beside a same-shaped button is a misclick hazard. A dedicated page gives room for the explanation the action needs. |
| Slice 4 UI location | New settings page vs. a danger-zone block on the org Overview | **Danger-zone section at the foot of `StateHome.tsx`.** `StateHome` is already the active organization's landing page (it renders `activeOrganization.organizationName` and org-scoped counts), so "delete this organization" belongs there with the rest of the org's state. Avoids inventing an org-settings route for a single action. |

## Data Flow

    Slice 2 -- POST /organizations/{organizationId}/invitations/{invitationId}/cancel
      -> organizations.CancelInvitation(ctx, principal.UserID, organizationID, invitationID)
         tx = pool.Begin
         requireOrganizationAdmin(ctx, tx, requester, org)          -> ErrForbidden
         SELECT status FROM invitations WHERE id=$1 AND organization_id=$2 FOR UPDATE
                                                                    -> ErrNotFound / ErrInvitationNotPending
         UPDATE invitations SET status='cancelled', updated_at=NOW() WHERE id=$1
         activity.Record(..., KindInvitationCancelled, "invitation", invitationID, {email, role})
         tx.Commit
      -> 204 -> admin-web invalidates queryKeys.organization(orgId).invitations

    Slice 3 -- DELETE /workspaces/{workspaceId}
      -> workspaces.Delete(ctx, principal.UserID, workspaceID)
         tx = pool.Begin
         loadWorkspaceMetadataRecord(ctx, tx, workspaceID)          -> ErrNotFound (+ name/type/orgID)
         access.RequireOrganizationAdmin(ctx, tx, requester, orgID) -> mapAccessError -> ErrForbidden
         DELETE FROM workspaces WHERE id=$1 AND organization_id=$2  -> RowsAffected()==0 -> ErrNotFound
             cascade: folders, bookmarks, workspace_cursors, sync_events,
                      workspace_user_access, workspace_group_access
         activity.Record(..., KindWorkspaceDeleted, "workspace", workspaceID, {workspaceName, workspaceType})
         tx.Commit
      -> 204 -> admin-web invalidates organization(orgId).workspaces + ["workspaces"]

    Slice 4 -- DELETE /organizations/{organizationId}
      -> organizations.DeleteOrganization(ctx, principal.UserID, organizationID)
         tx = pool.Begin
         lockOrganization(ctx, tx, organizationID)                  -> ErrNotFound
         requireOrganizationAdmin(ctx, tx, requester, org)          -> ErrForbidden
         lockOrganizationMemberships(ctx, tx, organizationID)
         orphan probe (single EXISTS, below)                        -> ErrWouldOrphanMember
         DELETE FROM organizations WHERE id=$1
             cascade: organization_members, workspaces(->all children), invitations,
                      groups(->group_members, workspace_group_access), activity_events
         -- no activity.Record: the row would be cascaded away in this same tx
         tx.Commit
      -> 204 -> admin-web: refreshOrganizations() -> empty ? signOut()+/login : navigate("/")

    Slice 5 -- POST /me/deactivate
      -> auth.DeactivateSelf(ctx, principal.UserID)
         tx = pool.Begin
         SELECT ... FROM organization_members WHERE user_id=$1 FOR UPDATE   (stabilise the check)
         sole-owner probe (single EXISTS, below)                    -> ErrSoleOwner
         UPDATE users SET disabled_at=NOW(), updated_at=NOW() WHERE id=$1 AND disabled_at IS NULL
         RevokeAllRefreshFamiliesTx(ctx, tx, userID)
         -- no activity.Record: activity_events.organization_id is NOT NULL, no single org scope
         tx.Commit
      -> 204 -> admin-web signOut() + redirect /login
      login()            : reject with ErrAccountDisabled after bcrypt succeeds
      AuthenticateToken(): "AND u.disabled_at IS NULL" -> ErrNoRows -> ErrUnauthorized

## Interfaces / Contracts

### Backend signatures

```go
// organizations/service.go
var ErrWouldOrphanMember = errors.New("deleting this organization would leave a member with no organization")

func (s *Service) CancelInvitation(ctx context.Context, requesterUserID, organizationID, invitationID string) error
func (s *Service) DeleteOrganization(ctx context.Context, requesterUserID, organizationID string) error

// workspaces/service.go  -- org resolved from the row, see Architecture Decisions
func (s *Service) Delete(ctx context.Context, requesterUserID, workspaceID string) error

// auth/service.go
var ErrAccountDisabled = errors.New("account is deactivated")
var ErrSoleOwner       = errors.New("transfer ownership or leave the organization before deactivating")

func (s *Service) DeactivateSelf(ctx context.Context, userID string) error

// activity/service.go -- two new kinds only
const (
    KindInvitationCancelled Kind = "invitation.cancelled"
    KindWorkspaceDeleted    Kind = "workspace.deleted"
)
```

`routeService` interface additions: `CancelInvitation` and `DeleteOrganization` on `organizations.routeService` (`handler.go:14-22`); `Delete` on `workspaces.routeService` (`handler.go:13-23`).

### The two non-obvious queries

```sql
-- Slice 4 orphan probe. Runs after lockOrganization + lockOrganizationMemberships.
-- $1 = organizationID, $2 = requesterUserID. true => ErrWouldOrphanMember.
-- Anti-join is index-served by idx_organization_members_user_id (000001:102).
SELECT EXISTS (
  SELECT 1 FROM organization_members om
  WHERE om.organization_id = $1
    AND om.user_id <> $2
    AND NOT EXISTS (
      SELECT 1 FROM organization_members other
      WHERE other.user_id = om.user_id
        AND other.organization_id <> $1
    )
);

-- Slice 5 sole-owner probe. $1 = userID. true => ErrSoleOwner.
SELECT EXISTS (
  SELECT 1 FROM organization_members mine
  WHERE mine.user_id = $1
    AND mine.role = 'owner'
    AND NOT EXISTS (
      SELECT 1 FROM organization_members peers
      WHERE peers.organization_id = mine.organization_id
        AND peers.user_id <> $1
        AND peers.role = 'owner'
    )
);
```

Both are single round trips returning one boolean; neither iterates members in Go.

### Sentinel error → HTTP status mapping

| Sentinel | Switch in | Status | Note |
|---|---|---|---|
| `organizations.ErrForbidden` | `writeOrganizationError` | 403 | existing case, reused |
| `organizations.ErrNotFound` | `writeOrganizationError` | 404 | existing case, reused |
| `organizations.ErrInvitationNotPending` | `writeOrganizationError` | 400 | existing case, reused verbatim by slice 2 |
| `organizations.ErrWouldOrphanMember` | `writeOrganizationError` | **409 Conflict** | new case; matches `ErrLastOwner`'s "valid request, forbidden by current state" precedent |
| `workspaces.ErrForbidden` / `ErrNotFound` | `writeWorkspaceError` | 403 / 404 | existing cases; slice 3 needs **no** new case |
| `auth.ErrAccountDisabled` | `writeAuthError` | **403 Forbidden** | new case; must be explicit — `writeAuthError`'s default is 400 |
| `auth.ErrSoleOwner` | `writeAuthError` | **409 Conflict** | new case; same rationale as `ErrWouldOrphanMember` |

### Frontend API clients

```ts
// lib/api/organizations.ts
export function cancelOrganizationInvitation(token: string, organizationId: string, invitationId: string)
  // POST /organizations/{o}/invitations/{i}/cancel -> apiRequest returns undefined on 204
export function deleteOrganization(token: string, organizationId: string)
  // DELETE /organizations/{o}

// lib/api/workspaces.ts
export function deleteWorkspace(token: string, workspaceId: string)
  // DELETE /workspaces/{w}

// lib/api/auth.ts
export function deactivateSelf(token: string)
  // POST /me/deactivate
```

`apiRequest` already returns `undefined as T` on 204 (`lib/api/client.ts:101`) — no client change needed.

### `AuthProvider.refreshOrganizations` contract change (slice 1)

```ts
refreshOrganizations: () => Promise<OrganizationMembership[]>   // was: Promise<void>
```

Returns the freshly fetched list so a caller can branch on it in the same tick. See Deviations below for why the existing pattern cannot be copied.

## File Changes

| File | Action | Slice | Description |
|---|---|---|---|
| `admin-web/src/app/providers/AuthProvider.tsx` | Modify | 1 | `refreshOrganizations` returns the fetched `OrganizationMembership[]` |
| `admin-web/src/features/members/mutations.ts` | Modify | 1, 2 | `useRemoveMemberMutation`; fix `useUpdateMemberRoleMutation`'s self branch; `useCancelInvitationMutation` |
| `admin-web/src/features/members/MembersPage.tsx` | Modify | 1, 2 | "Remove" button in the members Actions cell (`removingUserId` busy state alongside `updatingUserId`); "Cancel" button beside "Resend" (`cancellingInvitationId`) |
| `backend/internal/organizations/service.go` | Modify | 2, 4 | `CancelInvitation`, `DeleteOrganization`, `ErrWouldOrphanMember`, orphan probe helper; `ListInvitations` widened to `status IN ('pending', 'cancelled')` |
| `backend/internal/organizations/handler.go` | Modify | 2, 4 | `routeService` +2 methods; `POST .../invitations/{invitationId}/cancel`; `DELETE /organizations/{organizationId}`; `ErrWouldOrphanMember` case |
| `admin-web/src/features/members/MembersPage.tsx` | Modify | 2 | (in addition to slice 1's entry above) invitations table Actions cell renders "Cancel"/"Resend" only when `invitation.status === "pending"`, so a cancelled row shows its badge with no stale action buttons |
| `backend/internal/activity/service.go` | Modify | 2, 3 | `KindInvitationCancelled`, `KindWorkspaceDeleted` |
| `admin-web/src/features/activity/format.ts` | Modify | 2, 3 | Two `case` branches (the `default` already degrades gracefully, so this is consistency, not correctness) |
| `admin-web/src/lib/api/activity.ts` | Modify | 2, 3 | Two members on the `ActivityKind` union |
| `backend/internal/workspaces/service.go` | Modify | 3 | `Delete(ctx, requesterUserID, workspaceID) error` |
| `backend/internal/workspaces/handler.go` | Modify | 3 | `routeService` +`Delete`; `DELETE /workspaces/{workspaceId}` → 204 |
| `admin-web/src/lib/api/workspaces.ts` | Modify | 3 | `deleteWorkspace` |
| `admin-web/src/features/workspaces/mutations.ts` | Modify | 3 | `useDeleteWorkspaceMutation` (invalidate `organization(o).workspaces` + `["workspaces"]`, mirroring `useDeleteGroupMutation`) |
| `admin-web/src/features/workspaces/WorkspacesPage.tsx` | Modify | 3 | Actions cell gains a `ui-button-secondary` "Delete" beside the existing "Manage access" `Link`; `window.confirm()` naming the workspace; `deletingWorkspaceId` busy state → "Deleting…" |
| `admin-web/src/lib/ui/components/ConfirmByTyping.tsx` | Create | 4 | Shared type-to-confirm primitive (reused by slice 5) |
| `admin-web/src/lib/api/organizations.ts` | Modify | 2, 4 | `cancelOrganizationInvitation`, `deleteOrganization` |
| `admin-web/src/features/organizations/mutations.ts` | Create | 4 | `useDeleteOrganizationMutation` incl. post-delete org refresh / sign-out branch |
| `admin-web/src/features/home/StateHome.tsx` | Modify | 4 | Danger-zone section → `ContextPanel` + `ConfirmByTyping(expected=organizationName)` |
| `backend/migrations/000013_user_deactivation.sql` | Create | 5 | `ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ` |
| `backend/internal/auth/service.go` | Modify | 5 | `ErrAccountDisabled`, `ErrSoleOwner`, `DeactivateSelf`; `disabled_at` in `login()` and `AuthenticateToken` |
| `backend/internal/auth/handler.go` | Modify | 5 | `POST /me/deactivate` → 204; two `writeAuthError` cases |
| `admin-web/src/lib/api/auth.ts` | Modify | 5 | `deactivateSelf` |
| `admin-web/src/features/account/AccountPage.tsx` | Create | 5 | Deactivation surface; `ConfirmByTyping(expected=principal.email)`; on success `signOut()` + `/login` |
| `admin-web/src/app/router.tsx` | Modify | 5 | `{ path: "account", element: <AccountPage /> }` under `AdminLayout` |
| `admin-web/src/app/shell/AdminLayout.tsx` | Modify | 5 | Trailing `{ to: "/account", label: "Account" }` nav item |

## Migration DDL

`backend/migrations/000013_user_deactivation.sql` (highest existing is `000012_activity_events.sql`):

```sql
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- Nullable with no default: every existing row is active with no backfill.
-- No index: disabled_at is only ever read as an extra predicate alongside a
-- unique/PK lookup (users.email, users.id), so it filters an already-located
-- single row.
-- Rollback: ALTER TABLE users DROP COLUMN IF EXISTS disabled_at;
--   revert the login()/AuthenticateToken gates FIRST (restores access),
--   drop the column in a follow-up.
```

## Deviations Requiring Re-confirmation

1. **No `organization.deleted` activity kind (slice 4).** The proposal's Affected Areas lists `organization.deleted` among the new kinds. It cannot exist: `activity_events.organization_id` is `NOT NULL ... ON DELETE CASCADE`, so the row is either cascaded away by its own transaction or rejected by the FK. Only `invitation.cancelled` and `workspace.deleted` are added. Confirm this is understood as the intended consequence of Decision A rather than lost coverage.
2. **`workspaces.Delete` drops the `organizationID` parameter (slice 3).** The proposed 4-argument signature is incompatible with the proposed `DELETE /workspaces/{workspaceId}` route. Either the signature loses the parameter (chosen — matches all four existing workspace-scoped methods) or the route becomes `DELETE /organizations/{organizationId}/workspaces/{workspaceId}`. Confirm the route stays flat.
3. **`useUpdateMemberRoleMutation`'s self-branch cannot be mirrored (slice 1).** It reads `queryClient.getQueryData(queryKeys.auth.organizations)`, but nothing in admin-web ever writes that key — `refreshOrganizations` updates `AuthProvider` React state only. The read is always `undefined`, so `remaining.length === 0` is always true and the branch signs out unconditionally whenever `input.userId === session.user.id` (today: an owner self-demoting owner→admin is signed out). Slice 1 therefore changes `refreshOrganizations` to return the fetched list and branches on that. This repairs the existing role-change bug as a side effect — confirm that in-scope for slice 1 rather than a separate fix.
4. ~~Cancelled invitations disappear from the list rather than showing `cancelled`~~ — **RESOLVED (user decision): widen the scope.** `ListInvitations` now returns `status IN ('pending', 'cancelled')` instead of just `'pending'`, so a cancelled row stays visible with its badge updated to "cancelled" rather than vanishing. See the "Slice 2 `ListInvitations` scope" row in Architecture Decisions.

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit — `CancelInvitation` | admin gate; `pending` → `cancelled` + activity row committed atomically; already-`cancelled`/`accepted`/`expired` → `ErrInvitationNotPending` with no activity row; unknown ID → `ErrNotFound`; `ListInvitations` after cancel includes the row with `status='cancelled'` and still excludes `accepted`/`expired` | table-driven against the test DB, extending existing `organizations` service tests |
| Unit — `workspaces.Delete` | admin gate via `mapAccessError`; cascade emptiness asserted per child table (folders, bookmarks, `workspace_cursors`, `sync_events`, `workspace_user_access`, `workspace_group_access`); `RowsAffected()==0 → ErrNotFound`; `workspace.deleted` row present | seeded fixture workspace with one row in each cascading table |
| Unit — `DeleteOrganization` | admin gate; happy path removes org + all cascades and leaves other orgs' `activity_events` intact; orphan probe blocks and rolls back with **zero** rows deleted; requester's own orphaning does *not* block; unknown ID → `ErrNotFound`; **explicit assertion that no activity row exists anywhere after a successful delete** | fixture with two orgs sharing one member and one single-org member |
| Unit — `DeactivateSelf` | sole-owner in any org → `ErrSoleOwner`, `disabled_at` untouched, refresh families intact; happy path sets `disabled_at` **and** revokes all families in one commit; second call is a no-op (guarded by `AND disabled_at IS NULL`) | fixture user owning one org alone, and one co-owned |
| Unit — auth gates | `login()` with valid password on a disabled account → `ErrAccountDisabled` (not `ErrInvalidCredentials`); wrong password on a disabled account → `ErrInvalidCredentials` (no state leak); `AuthenticateToken` with a pre-deactivation token → `ErrUnauthorized`; `Refresh` cannot mint a session after family revocation | table-driven, ordering-sensitive (bcrypt before the disabled check) |
| Integration — handlers | Each new route: 204 on success; 403 non-admin; 404 unknown; 409 `ErrWouldOrphanMember` / `ErrSoleOwner`; 400 `ErrInvitationNotPending`; 403 `ErrAccountDisabled`; 401 unauthenticated | mux-level tests mirroring existing handler tests |
| Frontend unit | Confirm-dismissal sends no request (all four destructive actions); busy state disables the trigger; `onError` renders a `DataState` and clears busy state; `ConfirmByTyping` keeps the button disabled on partial/mismatched/whitespace-only input | vitest + React Testing Library, mocked mutations |
| Frontend unit — self-removal | removing self with other orgs remaining → no `signOut`; removing self from the last org → `signOut`; **regression test that self *role change* no longer signs out** | mocked `refreshOrganizations` returning a controlled list |
| Frontend unit — `format.ts` | `invitation.cancelled` and `workspace.deleted` render real sentences with representative and with missing metadata | vitest fixture per kind |

## Threat Matrix

N/A — no shell commands, subprocesses, VCS/PR automation, executable-file classification, or process integration. HTTP route registration is added, but the reference matrix's rows (documentation-like paths, git repository selection, commit state, push state, PR commands) have no counterpart here. The real adversarial surface is authorization on the four new endpoints, and it is covered explicitly: non-admin rejection, cross-organization ID substitution (`AND organization_id = $2` scoping on every mutation, org resolved from the row for `DELETE /workspaces/{workspaceId}`), and the structural absence of any user identifier on `POST /me/deactivate`. Each of those has a named integration test above.

## Migration / Rollout

Slices 1–4 are additive code with no schema change — revert the slice's commit and the route plus UI affordance disappear. Executed deletions are **not** recoverable (stated non-goal). Slice 5 ships `000013_user_deactivation.sql`: to roll back, revert the `login()`/`AuthenticateToken` gates first (immediately restores access for every disabled user), then drop the column in a follow-up migration. Already-revoked refresh families are not restored by either step — affected users must log in again. All work lands on `feat/lifecycle-management` off `develop`; rollback before merge is a branch-level revert. Slice ordering is also the recommended PR-chain order: PR #1 (slice 1) targets `feat/lifecycle-management`, each later slice targets the previous slice's branch.

## Open Questions

- [ ] Residual cross-organization race in the slice-4 orphan probe: a member can pass the check and concurrently lose their only other membership, ending up orphaned. Accepted (see Architecture Decisions) because orphaning is already reachable via `PatchMember(remove:true)` and the wider lock introduces deadlock risk — confirm the acceptance rather than assuming it.
- [ ] Same class of race in the slice-5 sole-owner probe: a co-owner can be demoted concurrently, leaving the deactivated user's org ownerless. The `FOR UPDATE` on the requester's own membership rows does not cover the peer's row in that org. Same accepted-risk reasoning.
- [ ] Workspace deletion and live sync clients: `sync_events` and `workspace_cursors` cascade away, so a connected extension polling that workspace starts receiving 404s with no push notification. No live invalidation is designed (consistent with the activity-log design's "no live push in v1"). If a `wsapi.Hub` broadcast is wanted, it belongs post-commit in the handler following `secrethide.Burn`'s pattern, never inside the transaction.
- [ ] Deactivated users retain their `organization_members` rows, so they keep appearing in `MembersPage` as normal members with no visual indication. Surfacing a "deactivated" badge would require adding `disabled_at` to the `ListMembers` projection — deliberately out of scope for slice 5, but worth a follow-up.
