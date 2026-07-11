# Workspace Access Operations UI Specification

## Purpose

Define group, workspace, and workspace-access operations for the admin web UI.

## Requirements

### Requirement: Group And Workspace Administration

The system MUST let organization admins create and manage flat groups, list workspaces, and create workspaces without exposing bookmark-content management.

#### Scenario: Admin manages groups and workspaces

- GIVEN an authenticated organization admin
- WHEN the user opens workspace administration
- THEN the UI exposes flat group management and workspace management actions only

#### Scenario: Workspace has no extra grants yet

- GIVEN a newly created workspace
- WHEN the admin reviews its access state
- THEN the UI shows the creator as the only initial admin until more grants are added

### Requirement: Explicit Access Assignment Review

The system MUST support direct user grants and group grants per workspace, and MUST show the effective role using the highest-role-wins result returned by the backend.

#### Scenario: Admin assigns workspace access

- GIVEN an authenticated organization admin
- WHEN the user adds a direct grant or a group grant to a workspace
- THEN the UI shows the assignment source and the resulting effective role

#### Scenario: Multiple grant paths exist

- GIVEN a workspace subject has direct and group-based grants
- WHEN the admin reviews effective access
- THEN the UI shows the resolved highest role and the contributing grant paths
