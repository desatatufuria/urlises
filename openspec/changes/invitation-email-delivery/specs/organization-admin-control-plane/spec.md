# Delta for Organization Admin Control Plane

## MODIFIED Requirements

### Requirement: Invite Lifecycle

The system MUST support invite-by-email for MVP. Invitations MUST be single-use, inactive until accepted, and MUST create membership after acceptance. Every invitation MUST be assigned an expiry of exactly 168 hours (7 days) from its creation timestamp.
(Previously: invitations carried no expiry and remained valid indefinitely; `expires_at` was always `NULL`)

#### Scenario: Accepted invite activates membership

- GIVEN an `owner` or `admin` sends an email invitation
- WHEN the invitee accepts the pending invitation
- THEN the system MUST activate the user as an OdA member with the invited role

#### Scenario: Reused or inactive invitation is rejected

- GIVEN an invitation is already accepted, cancelled, or expired
- WHEN a client attempts to accept it again
- THEN the system MUST reject the acceptance and MUST NOT change membership state

#### Scenario: New invitation is stamped with a 7-day expiry

- GIVEN an `owner` or `admin` creates an invitation at time `T`
- WHEN the invitation row is persisted
- THEN `expires_at` MUST equal `T + 168h`

#### Scenario: Expired invitation is rejected at accept time

- GIVEN an invitation's `expires_at` is in the past
- WHEN a client attempts to accept it
- THEN the system MUST reject the acceptance with an expiry error and MUST NOT change membership state
