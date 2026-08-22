# Activity Log Specification

## Purpose

Give organization admins an org-scoped audit trail of notable mutations (org, workspace, group changes) without querying the database directly. Recording is atomic with the mutation it describes; secret-sharing events are excluded from v1.

## Requirements

### Requirement: Atomic In-Transaction Recording

`activity.Record(ctx, tx, orgID, actorUserID, kind, targetType, targetID, metadata)` MUST write inside the caller's existing `pgx.Tx`, before commit. A rolled-back transaction MUST NOT persist its activity row.

#### Scenario: Committed mutation persists its activity row

- GIVEN a service calls `Record(ctx, tx, ...)` before `tx.Commit()`
- WHEN the transaction commits
- THEN both the activity row and the primary mutation row MUST exist

#### Scenario: Rolled-back mutation leaves no orphan activity row

- GIVEN `Record(ctx, tx, ...)` was called inside a transaction
- WHEN that transaction rolls back due to a later error
- THEN no activity row for that call MUST exist afterward

### Requirement: Event Recording — Organizations

The system MUST record `kind`, `actor_user_id`, `organization_id`, `target_type`, `target_id` for: `organization.created`, `invitation.created`, `invitation.resent`, `invitation.accepted`, `organization_member.role_changed`, `organization_member.removed`.

#### Scenario: Member role change is recorded

- GIVEN an org admin calls `PatchMember` to change a role
- WHEN the transaction commits
- THEN a row with `kind = organization_member.role_changed`, the admin as actor, the org as scope, and the target member as `target_id` MUST exist

### Requirement: Event Recording — Workspaces

The system MUST record an activity row for: `workspace.created`, `workspace_access.user_granted`, `workspace_access.user_revoked`, `workspace_access.group_granted`, `workspace_access.group_revoked`.

#### Scenario: Workspace user-access grant is recorded

- GIVEN an org admin calls `GrantUserAccess`
- WHEN the transaction commits
- THEN a row with `kind = workspace_access.user_granted`, the admin as actor, the workspace's org as scope, and the granted user as target MUST exist

### Requirement: Event Recording — Groups

The system MUST record an activity row for: `group.created`, `group.renamed`, `group.deleted`, `group_member.added`, `group_member.removed`. `Update` and `Delete` MUST run inside an explicit transaction so their row is atomic with the mutation. `ListMembers` MUST also run inside a transaction for consistency but performs no mutation and records no activity row.

#### Scenario: Group rename is recorded atomically

- GIVEN an org admin calls `Update` to rename a group
- WHEN the transaction commits
- THEN the group's `name` MUST reflect the new value, unchanged from prior behavior
- AND a row with `kind = group.renamed` MUST exist in the same transaction

#### Scenario: Delete and ListMembers stay behavior-preserving

- GIVEN existing callers invoke `Delete` or `ListMembers` unchanged
- WHEN the wrapping transaction is introduced
- THEN `Delete` MUST still return `ErrNotFound` when no row matches, and remove the row otherwise
- AND `ListMembers` MUST still return the same ordered member set, with no response-shape or error-behavior change

### Requirement: Secret Events Are Excluded

The system MUST NOT record any activity row for `secrethide` mutations (create, burn, send-email) in v1.

#### Scenario: Secret creation produces no activity row

- GIVEN a user creates a secret via `secrethide.Create`
- WHEN its transaction commits
- THEN no row in `activity_events` MUST reference that secret or action

### Requirement: Organization-Admin-Only Listing Authorization

`ListByOrganization` MUST require `access.RequireOrganizationAdmin`-equivalent authorization, matching the bar `workspaces`/`groups` already enforce. Non-admins MUST be rejected.

#### Scenario: Non-admin member is denied

- GIVEN a user is a non-admin member of an organization
- WHEN they call `ListByOrganization` for it
- THEN the system MUST reject with an authorization error and return no rows

#### Scenario: Organization admin is allowed

- GIVEN a user holds admin/owner role in an organization
- WHEN they call `ListByOrganization` for it
- THEN the system MUST return that organization's activity rows

### Requirement: Cursor-Based Paginated Listing

`ListByOrganization` MUST return results ordered newest-first by `created_at DESC` via cursor-based pagination. The system MUST NOT expose an unbounded listing endpoint.

#### Scenario: First page is capped and ordered newest-first

- GIVEN an organization has more rows than one page size
- WHEN a caller requests the first page with no cursor
- THEN the response MUST contain at most the page-size limit, newest to oldest

#### Scenario: Cursor advances without duplicates or gaps

- GIVEN a caller holds a cursor from a prior page
- WHEN they request the next page with it
- THEN the response MUST continue strictly after the previous page's last row, with no duplicate or skipped rows

### Requirement: admin-web Read-Only Activity Page

`ActivityPage` MUST require an authenticated session and active organization context, using the same `RequireAdminOrganization` guard as `/secrets` and `/access`. It MUST render loading, error, and empty states distinctly from a populated list.

#### Scenario: Unauthenticated visitor is redirected

- GIVEN a visitor with no active session opens `/activity`
- WHEN the route guard evaluates
- THEN they MUST be redirected to `/login` without any activity data fetched

#### Scenario: Non-admin user sees the shared guard state

- GIVEN an authenticated user has no admin organization membership
- WHEN they navigate to `/activity`
- THEN they MUST see the same "Organization admin access required" state as other admin routes, not the activity list

#### Scenario: Empty activity list renders an explicit empty state

- GIVEN an org admin's active organization has zero activity rows
- WHEN `ActivityPage` finishes loading
- THEN it MUST render an explicit empty state, not an empty table or a loading spinner
