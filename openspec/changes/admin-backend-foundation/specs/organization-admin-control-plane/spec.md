# Organization Admin Control Plane Specification

## Purpose

Define OdA administration.

## Requirements

### Requirement: Bootstrap And Owner Protection

The system MUST assign the user who creates an OdA organization as its initial `owner`. The system MUST always retain one `owner`. Only `owner` and `admin` roles SHALL manage members, groups, workspaces, invitations, and access grants.

#### Scenario: First organization creator becomes owner

- GIVEN a user creates OdA inside the Acme tenant
- WHEN the organization is persisted
- THEN the creator MUST be stored as an organization member with role `owner`

#### Scenario: Last owner cannot be removed or demoted

- GIVEN OdA has exactly one `owner`
- WHEN an admin request would remove or change that owner to another role
- THEN the system MUST reject the request

### Requirement: Invite Lifecycle

The system MUST support invite-by-email for MVP. Invitations MUST be single-use, inactive until accepted, and MUST create membership after acceptance.

#### Scenario: Accepted invite activates membership

- GIVEN an `owner` or `admin` sends an email invitation
- WHEN the invitee accepts the pending invitation
- THEN the system MUST activate the user as an OdA member with the invited role

#### Scenario: Reused or inactive invitation is rejected

- GIVEN an invitation is already accepted, cancelled, or expired
- WHEN a client attempts to accept it again
- THEN the system MUST reject the acceptance and MUST NOT change membership state
