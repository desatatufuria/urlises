# Exploration: Lifecycle management — 5 missing "undo" capabilities

Scope: member removal UI, workspace delete, organization delete, invitation cancel, user delete/deactivate.

## Current State

Shared conventions confirmed across the codebase (patterns every new capability should follow):

- **Sentinel errors per package**: each service package (`organizations`, `workspaces`, `groups`) declares its own `ErrForbidden`, `ErrNotFound`, plus domain-specific ones (`organizations.ErrLastOwner`). Handlers map them via a `write{Domain}Error` switch on `errors.Is` (`backend/internal/organizations/handler.go:298-317`, `backend/internal/workspaces/handler.go:233-242`).
- **Admin gate**: `requireOrganizationAdmin(ctx, querier, userID, organizationID)` is reimplemented per-package (organizations/service.go:775, workspaces via `access.RequireOrganizationAdmin`, groups/service.go:374) — checks `organization_members.role IN ('owner'|'admin')`.
- **Activity logging**: `s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.Kind, targetType, targetID, metadata)` is called inside the same transaction as the mutation, before `tx.Commit()`. Kind constants are `resource.action` dot-strings (`backend/internal/activity/service.go:28-43`). All 16 existing kinds are org-scoped — `activity_events.organization_id` is `NOT NULL` (`backend/migrations/000012_activity_events.sql:3`).
- **Delete/revoke routes do NOT use the idempotency executor** — only creation routes (`POST /organizations`, `POST .../invitations`, `POST .../workspaces`) go through `httpapi.IdempotencyExecutor`. `PATCH .../members` (remove), `DELETE .../access`, and `groups.Delete` are plain begin/commit transactions returning `204 No Content` on success. This is deliberate — removal side effects are naturally idempotent (a second `DELETE` on a missing row is `ErrNotFound`, not a duplicate side effect).
- **Row locking for cascade-sensitive mutations**: `PatchMember`'s remove path locks the organization row (`lockOrganization`) and all its memberships (`lockOrganizationMemberships`) with `FOR UPDATE` before checking `ErrLastOwner` (organizations/service.go:283-331) — precedent for "don't let two concurrent removals both think they're not the last owner."
- **Frontend `window.confirm()` pattern**: every destructive/role-changing action in admin-web uses a native `window.confirm("...")` guard before firing the mutation, and a per-row `disabled`/"Removing…"/"Saving…" busy state (`admin-web/src/features/groups/GroupMembersPanel.tsx:93-105` for group delete, `AccessPage.tsx:302,336,387,421` for role change/revoke). React Query `onSuccess` invalidates the relevant query keys; `onError` surfaces a `DataState` notice, never a toast library.
- **Self-mutation edge case is already handled once**: `useUpdateMemberRoleMutation` (admin-web/src/features/members/mutations.ts:41-60) checks `if (input.userId === session?.user.id)`, refreshes the organizations list, and calls `signOut()` if the acting admin just left their last organization. This is the exact precedent to reuse for member removal and (partially) for org deletion.

### Per-capability state

1. **Remove org member** — backend done (`PATCH /organizations/{id}/members` with `{userId, remove:true}`, `organizations/service.go:265` `PatchMember`, `organizations/handler.go:113`). Frontend API client already typed for it (`admin-web/src/lib/api/organizations.ts:72-82` `patchOrganizationMember`). Missing only: a mutation hook + a "Remove" button in `MembersPage.tsx`'s Actions column (currently just a `Badge`, `MembersPage.tsx:124-126`).

2. **Delete workspace** — nothing exists. `workspaces.routeService` interface (`handler.go:13-23`) has no `Delete`. `workspaces.organization_id` is `ON DELETE CASCADE` from `organizations`. If added, `folders`, `bookmarks`, `workspace_cursors`, `sync_events`, `workspace_user_access`, `workspace_group_access` are all `ON DELETE CASCADE` on `workspace_id` (`000001_initial_schema.sql:39,48,59,79,88`; `000002_admin_backend_foundation.sql:58,69`) — a hard `DELETE FROM workspaces WHERE id=$1` cleanly cascades everything, no orphan risk. `groups.Delete` (`groups/service.go:192-223`) is the closest existing precedent: admin-gate, `DELETE ... WHERE id=$1 AND organization_id=$2`, `RowsAffected()==0 → ErrNotFound`, record activity, commit.

3. **Delete organization** — nothing exists. `organizations.routeService` (`handler.go:14-22`) has no `Delete`. Cascade if a plain `DELETE FROM organizations WHERE id=$1` ran: `organization_members`, `workspaces` (→ folders/bookmarks/access/cursors/sync_events), `invitations`, `groups` (→ `group_members`, `workspace_group_access`), and **`activity_events`** all cascade (`activity_events.organization_id ... ON DELETE CASCADE`) — a hard org delete destroys its own audit trail. `secrets` is untouched (user-scoped, not org-scoped — confirms secrethide is correctly excluded). No existing code computes "is this the requester's only organization" or "would this leave any member with zero organizations."

4. **Cancel/revoke pending invitation** — nothing exists. `organizations.Service` has `CreateInvitation`, `ResendInvitation`, `AcceptInvitation`, `ValidatePendingInvitation` but no cancel. `invitations.status` CHECK already includes `'cancelled'` (`000002_admin_backend_foundation.sql:22`: `CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired'))`) — schema anticipates this feature; only the mutation is missing. `ResendInvitation` (service.go:515-600) is the near-identical precedent. Frontend: `MembersPage.tsx`'s invitations table only renders "Resend" — "Cancel" would sit alongside it with the same busy-state pattern.

5. **Delete/deactivate user account** — nothing exists, and there is no global-admin role anywhere in the system (`organization_members.role` CHECK is strictly `IN ('owner','admin','member')`, per-organization only). `auth.Service` has `Register`, `Login`/`LoginRenewable`, `Refresh`, `Logout`, `AuthenticateToken` — nothing gates on a `users` row's liveness. A repo-wide search for `disabled_at|is_active|deactivat` returns zero matches. FK cascade behavior on `users.id` if hard-deleted (confirmed by reading every migration):
   - `ON DELETE CASCADE`: `organization_members`, `devices`, `group_members`, `workspace_user_access`, `refresh_families`/`refresh_tokens` (`000006_refresh_sessions.sql:3`), `secrets` (`000010_secrets.sql:3`) — all silently wiped.
   - `ON DELETE SET NULL`: `activity_events.actor_user_id` (`000012_activity_events.sql:4`), `invitations.accepted_by_user_id` (`000002...sql:24`).
   - `ON DELETE RESTRICT`: `invitations.invited_by_user_id` (`000002...sql:23`) — **a hard delete of a user who has ever sent a still-present invitation row fails outright** at the DB level unless those rows are cleaned up or reassigned first. Concrete blocker for a "hard delete" option; a soft-deactivate flag sidesteps it entirely.

## Affected Areas

- `backend/internal/organizations/service.go` — add `CancelInvitation` (item 4), add `DeleteOrganization`/`DeleteOrganizationTx` (item 3, needs a new "last org"/"would orphan a member" guard — no precedent today).
- `backend/internal/organizations/handler.go` — extend `routeService`, add `DELETE /organizations/{id}` and an invitation-cancel route, extend `writeOrganizationError`.
- `backend/internal/workspaces/service.go` / `handler.go` — add `Delete`/`DeleteTx`, extend `routeService` and routes (item 2). No new migration needed.
- `backend/internal/auth/service.go` — item 5 touchpoint if deactivation is chosen: gate in `login()` (service.go:270-300); if hard delete is chosen, must pre-clean `invitations.invited_by_user_id` (RESTRICT) first.
- `backend/internal/activity/service.go` — new `Kind` constants (`workspace.deleted`, `organization.deleted`, `invitation.cancelled`); item 5 has no natural org scope if self-service (`activity_events.organization_id NOT NULL` is a real constraint to flag).
- `backend/migrations/` — new migration only for item 5 if deactivation (soft flag) is chosen; items 1-4 need zero schema changes.
- `admin-web/src/features/members/MembersPage.tsx` — add "Remove" button (item 1) and "Cancel" button (item 4) in the Actions columns.
- `admin-web/src/features/members/mutations.ts` — add `useRemoveMemberMutation` (mirror the self-removal/sign-out branch in `useUpdateMemberRoleMutation`, lines 41-60) and `useCancelInvitationMutation`.
- `admin-web/src/features/workspaces/WorkspacesPage.tsx` — no delete UI exists; would need a delete action mirroring `GroupMembersPanel.tsx`'s confirm+delete block.
- `admin-web/src/lib/api/organizations.ts` and workspaces API file — add `deleteOrganization`, `cancelInvitation`, `deleteWorkspace` client functions.
- `admin-web/src/features/activity/format.ts` — degrades gracefully for unrecognized kinds, so new kinds aren't a hard requirement but should get real sentences for consistency.

## Approaches

Items 1, 2, and 4 have no real architectural fork — existing `groups.Delete` / `ResendInvitation` / `patchOrganizationMember(remove:true)` are direct, low-risk templates. Two items carry a genuine decision:

### 1. Organization deletion (item 3) — cascade/guard strategy

- **A. Hard DB cascade, admin-role check only.** Pros: minimal code, reuses FK cascades as-is. Cons: silently destroys `activity_events` audit trail; no protection against orphaning a user; likely unacceptable for a fintech-adjacent product. Effort: Low.
- **B. Guarded delete** (confirm-by-name + block if any member would be left with zero orgs, or block if it's the requester's sole organization) **+ explicit decision on activity_events fate** (detach instead of cascade, or export-before-delete). Pros: matches the caution already shown for `ErrLastOwner`; protects users from silent lockout. Cons: real new logic (cross-user org-count check has no precedent); needs explicit product decision on whether activity_events should survive org deletion (may require changing that FK from CASCADE to something else — schema change). Effort: Medium-High.

This is a judgment call for `sdd-propose`, not resolved here.

### 2. User account removal (item 5) — hard delete vs. soft deactivate, and who can trigger it

- **A. Hard delete `users` row.** Blocked outright today by `invitations.invited_by_user_id ON DELETE RESTRICT` unless invitation rows are cleaned up/reassigned first; also destroys `secrets`, `devices`, `refresh_tokens`, `group_members`, `workspace_user_access` via CASCADE. Pros: true data removal (relevant for right-to-erasure needs). Cons: RESTRICT blocker must be solved; irreversible; loses audit context for CASCADE-affected tables. Effort: Medium.
- **B. Soft deactivate** (`users.disabled_at` or similar). New migration, login-time gate, no cascades, all FKs and history stay intact. Pros: reversible, keeps every historical reference valid, no RESTRICT collision, minimal blast radius. Cons: doesn't satisfy actual data-deletion/GDPR-style requirements if that's a goal. Effort: Low-Medium.

**Orthogonal, unresolved question**: *who* can trigger this. No global-admin concept exists today (roles are strictly per-organization `owner|admin|member`). Three distinct interpretations, not interchangeable: (a) "deactivate this user within my org" — really just item 1, needs no new concept; (b) self-service "delete my own account" — new authenticated self-action, no admin gate; (c) a genuinely new global-admin/platform-operator role — significant scope expansion. `sdd-propose` must pick one explicitly.

## Recommendation

Sequence as independent, separately-shippable slices, lowest-risk first:

1. Item 1 (member removal UI) — backend done, pure admin-web addition following an exact existing pattern.
2. Item 4 (cancel invitation) — schema already anticipates it; near-identical to `ResendInvitation`.
3. Item 2 (delete workspace) — backend net-new but schema cascades are already clean; follow `groups.Delete` almost verbatim.
4. Item 3 (delete organization) — needs an explicit product decision on guard rules and activity_events fate before design/spec can be written. Force the confirm-by-name + orphan-check + audit-trail question into the proposal's open-questions section; do not silently default to option A.
5. Item 5 (user delete/deactivate) — needs the authority-model question resolved as a precondition before backend work starts. Recommend soft-deactivate over hard-delete given the RESTRICT collision and irreversibility, but this is `sdd-propose`'s explicit call.

## Risks

- Organization deletion destroys its own audit trail (`activity_events.organization_id ON DELETE CASCADE`) — compliance-relevant, easy to miss if the proposal just says "delete the org and its data."
- Hard user deletion is currently blocked by a DB constraint (`invitations.invited_by_user_id ON DELETE RESTRICT`) — any hard-delete proposal must account for pre-cleaning/reassigning those rows or the DELETE fails at the DB layer the first time an ex-admin who sent an invitation is deleted.
- No global-admin/platform-operator role exists anywhere — item 5's authority model is genuinely undecided; the three candidate interpretations have very different security/scope implications and must not be conflated.
- Org deletion "last org"/"orphan a member" guard has zero precedent — new cross-cutting logic, not a copy-paste of `ErrLastOwner`.
- Activity kind additions are org-scoped by schema (`activity_events.organization_id NOT NULL`) — if item 5 becomes self-service account deactivation (no org context), it cannot use the existing `activity.Record` call shape as-is.

## Ready for Proposal

Yes, with two explicit open questions to carry into `sdd-propose` rather than letting the phase default silently:

1. Organization-deletion guard rules and activity_events fate (hard cascade vs. guarded delete with confirm-by-name and orphan/audit protections).
2. User account removal's authority model and hard-delete-vs-soft-deactivate choice, including the concrete `invitations.invited_by_user_id ON DELETE RESTRICT` blocker for the hard-delete path.

Items 1, 2, and 4 have no open design questions and can proceed straight through spec/design/tasks using the cited existing-code templates.
