# Admin Web UI Experience Specification

## Purpose

Define the premium, minimal operator shell for organization owners/admins.

## Requirements

### Requirement: Restricted Admin Shell

The system MUST provide an authenticated admin shell limited to members, invitations, groups, workspaces, and access assignment for organization `owner` and `admin` users.

#### Scenario: Admin opens the shell

- GIVEN an authenticated organization `owner` or `admin`
- WHEN the user opens the admin web UI
- THEN the navigation shows only Members, Invitations, Groups, Workspaces, and Access

#### Scenario: Out-of-scope area is requested

- GIVEN an authenticated admin user
- WHEN the user requests bookmark-content management or tenant super-admin tooling
- THEN the UI does not expose that destination and shows no operator action for it

### Requirement: Calm Operator States

The system SHOULD present a clean, minimal, premium interface with explicit empty, loading, success, and error states instead of dense dashboard behavior.

#### Scenario: No records exist yet

- GIVEN an admin opens a management page with no data
- WHEN the page loads successfully
- THEN the UI shows a calm empty state with the next valid admin action

#### Scenario: Backend data cannot be loaded

- GIVEN an admin opens a management page
- WHEN the backing request fails
- THEN the UI shows a clear error state and a retry action
