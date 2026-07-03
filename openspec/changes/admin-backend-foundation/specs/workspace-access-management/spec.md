# Workspace Access Management Specification

## Purpose

Define workspace grants.

## Requirements

### Requirement: Creator-Only Default Membership

The system MUST create a new workspace with only its creator as `admin` by default. Additional users or groups MUST gain access only through explicit direct or group grants.

#### Scenario: New workspace starts with creator only

- GIVEN an OdA `owner` or `admin` creates the workspace
- WHEN the workspace is created
- THEN the creator MUST be the only initial member and MUST hold role `admin`

#### Scenario: Organization membership alone does not grant workspace access

- GIVEN a user is an OdA member without any workspace grant
- WHEN that user requests the workspace
- THEN the system MUST deny access

### Requirement: Direct And Group Access Resolution

The system MUST support direct user grants and workspace-group grants. When multiple grants apply, the effective role MUST be the highest among `admin`, `editor`, and `viewer`.

#### Scenario: Highest role wins across grant paths

- GIVEN a user has direct `viewer` access and group `editor` access to the synchronized operational space
- WHEN effective access is evaluated
- THEN the system MUST authorize `editor`

#### Scenario: Revoking one path preserves remaining access

- GIVEN a user has both direct and group-based access
- WHEN one grant path is removed
- THEN the system MUST recalculate access from the remaining grants only
