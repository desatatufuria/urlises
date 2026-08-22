# Lifecycle Management Specification

## Purpose

Give organization owners/admins and end users the ability to undo what admin-web lets them create: remove a member, cancel a pending invitation, delete a workspace, delete an organization (guarded), and deactivate one's own account. Five independently shippable slices; no new global/platform-operator role is introduced.

## Requirements

### Requirement: Remove Organization Member (admin-web)

An org owner/admin MUST be able to remove another member from `MembersPage.tsx` via a "Remove" action, guarded by `window.confirm()`, using the existing `PATCH /organizations/{id}/members {userId, remove:true}` endpoint.

#### Scenario: Admin removes a member (happy path)

- GIVEN an org admin views the members table
- WHEN they click "Remove" on another member and confirm the prompt
- THEN the mutation fires, the row enters a busy state, and on success the member list is invalidated/refetched without that member

#### Scenario: Confirm guard cancels the action

- GIVEN an org admin clicks "Remove" on a member
- WHEN they dismiss the `window.confirm()` prompt
- THEN no request is sent and the member remains listed

#### Scenario: Backend rejection is surfaced

- GIVEN a remove request returns `ErrForbidden` or `ErrNotFound`
- WHEN the mutation's `onError` runs
- THEN a `DataState` error notice is shown and the member row returns to its non-busy state

#### Scenario: Self-removal from the acting user's last organization

- GIVEN the acting admin removes themself and this was their only organization membership
- WHEN the mutation succeeds
- THEN the organizations list is refreshed and the client signs the user out, mirroring `useUpdateMemberRoleMutation`

#### Scenario: Self-removal while other organizations remain

- GIVEN the acting admin removes themself but still belongs to at least one other organization
- WHEN the mutation succeeds
- THEN the organizations list is refreshed and no sign-out occurs

### Requirement: Cancel Pending Invitation

An org owner/admin MUST be able to cancel a `pending` invitation, transitioning it to `cancelled` via a new `CancelInvitation` backend method and route, activity-logged with a new `Kind` (`invitation.cancelled`).

#### Scenario: Admin cancels a pending invitation (happy path)

- GIVEN a pending invitation exists in the organization
- WHEN an org admin cancels it
- THEN its `status` becomes `cancelled` in the same transaction as an `invitation.cancelled` activity row recording the admin as actor and the invitation as target

#### Scenario: Non-admin is forbidden

- GIVEN a non-admin member attempts to cancel an invitation
- WHEN the request is made
- THEN the system MUST reject with `ErrForbidden` and MUST NOT change the invitation status

#### Scenario: Cancelling a non-pending or missing invitation

- GIVEN an invitation is already `accepted`, `cancelled`, `expired`, or does not exist
- WHEN cancellation is requested
- THEN the system MUST return a not-found/invalid-state error and record no activity row

#### Scenario: admin-web Cancel action

- GIVEN the invitations table renders a pending invitation
- WHEN an admin clicks "Cancel" alongside "Resend", confirms, and the request succeeds
- THEN the row shows a busy state during the request and the invitations list refreshes to reflect `cancelled` status; a failed request surfaces an error without losing the row

### Requirement: Delete Workspace

An org owner/admin MUST be able to permanently delete a workspace and all its contents via a new `Delete`/`DeleteTx` on `workspaces.Service`, relying on existing `ON DELETE CASCADE` for folders, bookmarks, access, cursors, and sync events.

#### Scenario: Admin deletes a workspace (happy path)

- GIVEN an org admin selects a workspace to delete and confirms
- WHEN the delete transaction commits
- THEN the workspace and all cascaded child rows (folders, bookmarks, workspace_user_access, workspace_group_access, workspace_cursors, sync_events) no longer exist
- AND a `workspace.deleted` activity row is recorded with the admin as actor and the workspace as target, in the same transaction

#### Scenario: Non-admin is forbidden

- GIVEN a non-admin member of the organization requests workspace deletion
- WHEN the request is made
- THEN the system MUST reject with `ErrForbidden` and the workspace MUST remain intact

#### Scenario: Deleting a non-existent workspace

- GIVEN the target workspace ID does not exist or belongs to a different organization
- WHEN deletion is requested
- THEN the system MUST return `ErrNotFound` and record no activity row

#### Scenario: admin-web delete action

- GIVEN `WorkspacesPage.tsx` renders a workspace row
- WHEN an admin clicks delete, confirms via `window.confirm()`, and the request succeeds
- THEN the row shows a busy state and the workspace list is invalidated/refetched without it; a failed request surfaces an error and the row returns to normal

### Requirement: Delete Organization (Guarded)

An org owner or admin MUST be able to permanently delete an organization through a new `DeleteOrganization`/`DeleteOrganizationTx`, gated by role, a confirm-by-typing-the-organization-name UI step, and a cross-member orphan check that blocks deletion when any OTHER member would be left with zero organization memberships.

#### Scenario: Authorized deletion (happy path)

- GIVEN the requester is an owner or admin of the organization, and every other member has at least one other organization membership
- WHEN they confirm deletion by typing the exact organization name and submit
- THEN the organization, its `organization_members`, `workspaces` (and their cascades), `invitations`, `groups` (and their cascades), and `activity_events` for that organization are all removed
- AND other organizations' `activity_events` rows are unaffected

#### Scenario: Non-owner/non-admin is forbidden

- GIVEN the requester holds the `member` role
- WHEN they attempt to delete the organization
- THEN the system MUST reject with `ErrForbidden` and the organization MUST remain intact

#### Scenario: Deletion blocked to prevent orphaning a member

- GIVEN at least one other member of the organization has no membership in any other organization
- WHEN an owner/admin attempts deletion
- THEN the system MUST reject with a new sentinel error `ErrWouldOrphanMember` and MUST NOT delete anything

#### Scenario: Concurrent deletion race is locked

- GIVEN two deletion/membership-changing requests race against the same organization
- WHEN both attempt to evaluate the orphan check concurrently
- THEN the system MUST lock the organization and its memberships (`FOR UPDATE`, matching the `ErrLastOwner` precedent) so only a consistent result is committed

#### Scenario: Frontend confirm-by-name guard blocks submission

- GIVEN the admin-web delete dialog requires typing the organization's exact name
- WHEN the typed value does not match
- THEN the delete action MUST remain disabled and no request is sent

#### Scenario: Deleting a non-existent organization

- GIVEN the target organization ID does not exist
- WHEN deletion is requested
- THEN the system MUST return `ErrNotFound`

### Requirement: Self-Service Account Deactivation

An authenticated user MUST be able to deactivate their own account (`userID == principal.UserID` only — no org-admin-triggered path), after which `login()` and `AuthenticateToken` MUST reject them, unless blocked by the sole-owner guard.

#### Scenario: Self-service deactivation succeeds (happy path)

- GIVEN an authenticated user is not the sole owner of any organization
- WHEN they call the deactivation action for their own account
- THEN `users.disabled_at` (or equivalent) is set for that user, and the request MUST NOT accept or act on any other user's ID

#### Scenario: Sole-owner guard blocks deactivation

- GIVEN the requester is the sole owner of at least one organization
- WHEN they attempt to deactivate their own account
- THEN the system MUST reject with a sentinel error instructing them to transfer ownership or leave the organization first, and MUST NOT set `disabled_at`

#### Scenario: Deactivated user cannot log in

- GIVEN a user's account has `disabled_at` set
- WHEN they attempt `login()` with valid credentials
- THEN the system MUST reject the login and MUST NOT issue a session or refresh token

#### Scenario: Existing session is rejected after deactivation

- GIVEN a user holds a valid JWT/refresh session issued before deactivation
- WHEN their account becomes deactivated
- THEN `AuthenticateToken` MUST reject subsequent calls using that token, and the deactivation flow MUST revoke all refresh families (e.g. via `RevokeAllRefreshFamilies`) so refresh cannot mint a new session

#### Scenario: No activity event is recorded for self-deactivation

- GIVEN `activity_events.organization_id` is `NOT NULL` and self-deactivation has no single-org scope
- WHEN a user deactivates their own account
- THEN the system MUST NOT call `activity.Record` for this action; this is a deliberate scope decision, not an oversight

#### Scenario: admin-web deactivation UI

- GIVEN an authenticated user opens the account/profile area
- WHEN they trigger "Deactivate my account", pass a strong confirm step, and the request succeeds
- THEN the client signs the user out and redirects to `/login`
