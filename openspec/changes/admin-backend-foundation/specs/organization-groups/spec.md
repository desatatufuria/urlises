# Organization Groups Specification

## Purpose

Define OdA groups.

## Requirements

### Requirement: First-Class Group Management

The system MUST model groups as first-class entities. `owner` and `admin` roles MUST manage group CRUD and memberships. Groups MUST support many-to-many membership with users.

#### Scenario: Admin manages reusable subteam

- GIVEN OdA has an `admin`
- WHEN the admin creates the `devops` group and adds users
- THEN the system MUST persist one group and many-to-many user memberships

#### Scenario: Group membership is organization-scoped

- GIVEN a user is not an OdA member
- WHEN an admin attempts to add that user to an OdA group
- THEN the system MUST reject the request

### Requirement: Groups Are Reusable Access Subjects

Groups SHALL be reusable across workspaces and MUST NOT grant access without an explicit workspace-group grant.

#### Scenario: Group without grant does not unlock a workspace

- GIVEN a user belongs to the `monitorizacion` group
- WHEN no workspace-group grant exists for the synchronized operational space
- THEN the user MUST NOT gain workspace access from group membership alone
