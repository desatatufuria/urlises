# Workspace Bookmark Domain Specification

## Purpose

Define canonical structure and roles.

## Requirements

### Requirement: Canonical Workspace Tree

The backend MUST keep organizations, workspaces, folders, and bookmarks as canonical shared state in PostgreSQL. SQLite MUST NOT be used as the product database for canonical shared state, memberships, or workspace trees. Each workspace tree SHALL expose stable backend IDs, parent links, and sibling order.

#### Scenario: Read tree

- GIVEN a member with workspace access
- WHEN the client requests the workspace tree
- THEN the backend returns the reachable hierarchy with backend IDs and order

### Requirement: Role-Based Shared Mutation

Admins and editors MAY mutate shared data. Viewers MUST NOT mutate shared semantics. Viewer-local exclusions MAY hide nodes for one viewer only and SHALL NOT change canonical data or another viewer's projection.

#### Scenario: Local exclusion

- GIVEN a viewer can access a subtree
- WHEN the viewer excludes it locally
- THEN the backend tree is unchanged and other clients still see it

#### Scenario: Unauthorized viewer edit

- GIVEN a viewer changes a managed node locally
- WHEN the change is evaluated as shared
- THEN the system rejects it and keeps backend state authoritative
