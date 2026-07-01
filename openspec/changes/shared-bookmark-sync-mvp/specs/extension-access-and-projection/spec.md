# Extension Access and Projection Specification

## Purpose

Define extension access and reconciliation.

## Requirements

### Requirement: Authenticated Managed Projection

The extension MUST authenticate the user with JWT-backed access before projecting shared workspaces. It SHALL manage only `Shared Bookmarks / Organization / Workspace` and MUST NOT treat bookmarks outside that subtree as shared state.

#### Scenario: Project workspace

- GIVEN a signed-in member selects an accessible workspace
- WHEN the extension projects it locally
- THEN it creates or reuses the managed root path and populates only that subtree

### Requirement: Local Mapping, Exclusions, and Reconciliation

The extension MUST persist backend↔Chrome ID mappings and viewer-local exclusions in local storage. Missing mapped nodes, unauthorized local edits, or rejected mutations MUST reconcile to backend state. Viewer-local exclusions SHALL survive remote updates and MUST NOT rewrite shared semantics.

#### Scenario: Store mapping

- GIVEN a remote bookmark event targets a visible shared folder
- WHEN the extension applies it in Chrome
- THEN it stores the mapping and suppresses local re-emission

#### Scenario: Reconcile local edit

- GIVEN a viewer renames or deletes a managed shared node locally
- WHEN the edit is rejected or identified as non-authoritative
- THEN the extension restores canonical state while keeping any local exclusion preference
