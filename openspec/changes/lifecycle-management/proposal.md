# Proposal: Lifecycle Management — Admin Undo Capabilities

## Intent

URLises admins (banking/fintech clients) can create organizations, workspaces, groups, invitations and members — and can undo almost none of it. A mistyped invitation, a departed employee, an abandoned test workspace or a duplicate organization is permanent today and requires engineering/DB intervention. This change gives admin-web the five missing lifecycle actions so the product can reverse what it creates.

## Scope

### In Scope (five independently shippable slices, in order)

1. **Remove member from organization** — admin-web UI only; backend `PATCH .../members {remove:true}` already exists. Ship first: zero backend work, lowest risk.
2. **Cancel pending invitation** — backend + UI; `invitations.status` already allows `cancelled`.
3. **Delete workspace** — backend + UI; FK cascades already clean, no migration.
4. **Delete organization** — guarded (Decision A).
5. **Deactivate own user account** — soft flag + login gate (Decision B).

### Out of Scope / Non-Goals

- No new global-admin or platform-operator role.
- No org-admin-triggered deactivation of another user's global account (org admins use slice 1).
- No GDPR-style hard-erasure guarantee; deactivation is not data deletion.
- No undelete/restore/trash — workspace and organization deletion is **permanent**.
- No preservation or export of a deleted organization's `activity_events`.
- No change to `secrets` (user-scoped, unaffected by org deletion).

## Product Decisions Resolved

> Both were genuine forks in exploration and were **not** explicitly specified by the original request. Recommended and resolved here; the product owner should sanity-check them before spec.

**Decision A — organization deletion: guarded delete, audit trail cascades away.**
Requires owner/admin role plus confirm-by-typing-the-organization-name, and MUST be blocked when any member of that organization belongs to no other organization (deleting it would leave them with zero orgs). `activity_events` keeps its existing `ON DELETE CASCADE`: the organization and its own history cease to exist together. Other organizations' audit trails are unaffected because `activity_events` is org-scoped. Rationale: detaching or exporting a dead org's trail is materially more complex, needs a schema change, and no compliance requirement for it was stated for v1. Stated explicitly rather than defaulted silently.

**Decision B — user removal: soft deactivate, self-service only.**
Add a `users.disabled_at`-style flag checked in `auth.Service.login()`. Hard delete is rejected: `invitations.invited_by_user_id ON DELETE RESTRICT` blocks it at the DB layer for any user who ever sent a surviving invitation, it is irreversible, and it destroys audit context. Trigger is scoped to **self-service** — an authenticated user deactivates their own account, mirroring the existing self-removal/sign-out branch in `useUpdateMemberRoleMutation`. Not org-admin-triggered: an org admin controlling a user's *global* account is privilege escalation beyond the org boundary; slice 1 is the correct org-level control. No global-admin role is introduced.

## Capabilities

### New Capabilities

- `admin-member-removal`: org owner/admin removes a member from an organization via admin-web, including the acting-user self-removal case.
- `admin-invitation-cancellation`: org owner/admin cancels a pending invitation, moving it to `cancelled`.
- `admin-workspace-deletion`: org owner/admin permanently deletes a workspace and its contents.
- `admin-organization-deletion`: org owner permanently deletes an organization behind a confirm-by-name guard and an orphaned-member block.
- `account-self-deactivation`: an authenticated user deactivates their own account; subsequent login is refused.

### Modified Capabilities

- None. `admin-organization-creation` requirements are unchanged.

## Approach

Follow existing in-repo templates rather than inventing patterns: `groups.Delete` for workspace and organization deletion (admin gate → scoped `DELETE` → `RowsAffected()==0 → ErrNotFound` → `activity.Record` in-transaction → commit → `204`); `ResendInvitation` for invitation cancellation; `patchOrganizationMember(remove:true)` for member removal. In admin-web, reuse the `window.confirm` + per-row busy-state + React Query invalidation pattern already used for group deletion and access revocation. Organization deletion adds the one genuinely new piece of logic: a cross-member "would this leave anyone with zero organizations" check, executed under the same `FOR UPDATE` locking precedent as `ErrLastOwner`. Account deactivation is the only slice needing a migration.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `admin-web/src/features/members/` | Modified | Remove + Cancel actions, new mutation hooks |
| `admin-web/src/features/workspaces/` | Modified | Delete action |
| `admin-web/src/lib/api/` | Modified | `deleteWorkspace`, `deleteOrganization`, `cancelInvitation` clients |
| `backend/internal/organizations/` | Modified | `CancelInvitation`, `DeleteOrganization` + guard, routes, error mapping |
| `backend/internal/workspaces/` | Modified | `Delete` + route |
| `backend/internal/auth/service.go` | Modified | Login gate on disabled accounts |
| `backend/internal/activity/service.go` | Modified | New kinds: `workspace.deleted`, `organization.deleted`, `invitation.cancelled` |
| `backend/migrations/` | New | Single migration for the account-disabled flag |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Org deletion destroys its own audit trail | High (by design) | Explicit in Decision A; confirm-by-name guard; other orgs unaffected |
| Deletion orphans a member with zero orgs | Med | Block deletion; return a dedicated sentinel error |
| Self-deactivation locks out a sole org owner | Med | Spec must decide whether sole-owner deactivation is blocked |
| Self-service deactivation has no org scope, but `activity_events.organization_id` is `NOT NULL` | High | Design must choose: skip activity logging for this event or fan out per membership |
| Concurrent deletes racing membership changes | Low | Reuse `FOR UPDATE` locking precedent from `PatchMember` |

## Rollback Plan

Per slice. Slices 1–4 are additive code with no schema change: revert the commit/PR and the endpoints and UI actions disappear; already-executed deletions are **not** recoverable (accepted, stated as a non-goal). Slice 5 ships a migration — roll back by reverting the login gate first (restores access for all users), then dropping the column in a follow-up down-migration. Gitflow: work lands on `feat/lifecycle-management` off `develop`; rollback is a branch-level revert before merge.

## Dependencies

- None external. Slices 2–5 depend only on existing backend packages; slice 1 depends on already-shipped backend behavior.

## Success Criteria

- [ ] An org owner/admin can remove a member, cancel a pending invitation, delete a workspace and delete an organization entirely from admin-web.
- [ ] Organization deletion is refused when it would leave any member with zero organizations, and requires typing the org name.
- [ ] A user can deactivate their own account and is then refused at login; no org admin can deactivate another user's account.
- [ ] Every destructive action records an activity event where an org scope exists.
- [ ] No new global role, no restore path, and no change to `secrets` behavior.

## Proposal Question Round

Automatic execution mode — these were resolved with recommendations instead of blocking. Confirm or correct before spec:

1. **Decision A**: is losing a deleted organization's `activity_events` acceptable for your fintech clients, or is retention required (which would force a schema change and larger scope)?
2. **Decision B trigger**: did "eliminar y/o desactivar usuarios" mean self-service, or org-admin-triggered? Proposal assumes self-service.
3. **Decision B mode**: is soft deactivation sufficient, or is real erasure a contractual requirement?
4. **Sole-owner edge case**: should a user who is the only owner of an organization be blocked from self-deactivating, or forced to transfer ownership first?
