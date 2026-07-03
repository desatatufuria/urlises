# Delta for extension-access-and-projection

## ADDED Requirements

### Requirement: Live Sync Degraded Visibility

The extension MUST keep healthy live sync practically invisible to the user. It MUST show a visible degraded indicator only when bounded silent recovery cannot restore healthy live sync promptly.

#### Scenario: Silent recovery succeeds

- GIVEN live delivery is briefly interrupted
- WHEN bounded reconnect or replay recovery restores live sync promptly
- THEN the extension remains usable without showing a degraded indicator

#### Scenario: Degraded indicator appears

- GIVEN live delivery remains unhealthy after bounded silent recovery
- WHEN the extension cannot maintain healthy automatic remote apply
- THEN it shows a visible degraded indicator until health is restored

## MODIFIED Requirements

### Requirement: Local Mapping, Exclusions, and Reconciliation

The extension MUST persist backend↔Chrome ID mappings and viewer-local exclusions in local storage. Healthy remote events MUST apply automatically in Chrome within a few seconds, without requiring manual reload or manual resync as the normal visible path. Missing mapped nodes, unauthorized local edits, duplicate-create risk, or rejected mutations MUST reconcile to backend state. Before creating or rebuilding a managed node, the extension MUST reconcile mapping/state so one canonical backend node does not create duplicate Chrome nodes. Viewer-local exclusions SHALL survive remote updates and MUST NOT rewrite shared semantics.

(Previously: mappings and exclusions reconciled backend-authoritative state, but live remote apply timing, silent fallback boundaries, and duplicate-node prevention were not explicit.)

#### Scenario: Store mapping

- GIVEN a remote bookmark event targets a visible shared folder
- WHEN the extension applies it in Chrome
- THEN it stores the mapping and suppresses local re-emission

#### Scenario: Reconcile local edit

- GIVEN a viewer renames or deletes a managed shared node locally
- WHEN the edit is rejected or identified as non-authoritative
- THEN the extension restores canonical state while keeping any local exclusion preference

#### Scenario: Prevent duplicate managed node

- GIVEN a remote event references a backend node with stale or uncertain Chrome mapping
- WHEN the extension reconciles before apply or rebuild
- THEN it reuses or repairs the canonical mapping instead of creating a duplicate Chrome node
