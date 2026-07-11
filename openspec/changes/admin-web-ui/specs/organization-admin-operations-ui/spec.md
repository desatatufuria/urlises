# Organization Admin Operations UI Specification

## Purpose

Define member, invitation, and organization-role operations for the admin web UI.

## Requirements

### Requirement: Member And Invitation Operations

The system MUST let organization `owner` and `admin` users list members, invite by email, inspect pending invitations, and change organization roles within backend-enforced rules.

#### Scenario: Admin reviews organization people state

- GIVEN an authenticated organization admin
- WHEN the user opens organization administration
- THEN the UI shows active members, pending invitations, and each record's current role or status

#### Scenario: Admin invites a new member

- GIVEN an authenticated organization admin
- WHEN the user submits a valid invitation email and role
- THEN the UI records the pending invitation and shows it in the pending list

### Requirement: Admin Scope Enforcement

The system MUST enforce operator-only access in the UI and MUST NOT offer tenant-wide super-admin controls.

#### Scenario: Non-admin reaches an admin route

- GIVEN an authenticated user without organization admin authority
- WHEN the user opens an admin route
- THEN the UI blocks the workflow and shows an authorization failure state

#### Scenario: Invalid role change is attempted

- GIVEN an organization admin is editing a member role
- WHEN the backend rejects the requested role change
- THEN the UI preserves the prior state and shows the returned validation message
