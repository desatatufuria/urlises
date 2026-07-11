# Organization Administration Safety Specification

## Purpose

Define safe invitation lifecycle, migration, and organization-owner invariants.

## Requirements

### Requirement: Invitation Visibility and Validation

The system MUST exclude expired invitations from active invitation lists. It MUST reject syntactically invalid email requests with a stable validation response and member or pending-duplicate requests with a stable conflict response.

#### Scenario: List active invitations

- GIVEN an organization has pending and expired invitations
- WHEN an authorized administrator lists invitations
- THEN only pending, unexpired invitations are returned

#### Scenario: Reject invalid or conflicting request

- GIVEN an invalid email, existing member, or pending invitation
- WHEN an administrator creates an invitation
- THEN the client receives the applicable stable validation or conflict response

### Requirement: Deterministic Invitation Reconciliation

The system MUST reconcile legacy expired and duplicate pending invitations deterministically before enforcing invitation uniqueness. It MUST retain the newest eligible duplicate and cancel or expire older duplicates.

#### Scenario: Reconcile legacy duplicates

- GIVEN multiple pending invitations exist for one organization and email
- WHEN reconciliation runs before uniqueness enforcement
- THEN the newest eligible invitation remains and older duplicates are inactive

#### Scenario: Reconcile expired rows

- GIVEN a pending invitation is expired during reconciliation
- WHEN uniqueness enforcement is prepared
- THEN the expired invitation is inactive and cannot block a new invitation

### Requirement: Conditional Migration History

The system MUST inventory deployment state before migration changes. It MUST reconcile within the historical migration only when that migration is unapplied to shared environments, and MUST NOT rewrite an applied historical migration.

#### Scenario: Historical migration is unapplied

- GIVEN inventory proves the relevant migration is unapplied in shared environments
- WHEN the migration is prepared
- THEN reconciliation precedes its uniqueness enforcement

#### Scenario: Historical migration may be applied

- GIVEN inventory cannot prove the historical migration is unapplied
- WHEN remediation is prepared
- THEN a forward migration is used and applied history is unchanged

### Requirement: Owner Transition Safety

Only an existing owner MUST be allowed to promote a member to owner. Concurrent demotion or removal of owners MUST atomically preserve at least one owner.

#### Scenario: Owner promotes member

- GIVEN an existing owner and a member in the same organization
- WHEN the owner promotes that member
- THEN the member becomes an owner

#### Scenario: Non-owner attempts promotion

- GIVEN a non-owner administrator and a member
- WHEN the administrator requests promotion
- THEN the request is denied without changing ownership

#### Scenario: Concurrent final-owner transitions

- GIVEN an organization has one remaining owner
- WHEN concurrent requests demote or remove that owner
- THEN at least one request is rejected and an owner remains
