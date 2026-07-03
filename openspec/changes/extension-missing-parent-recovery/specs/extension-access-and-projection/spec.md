# Delta for extension-access-and-projection

## MODIFIED Requirements

### Requirement: Live Sync Degraded Visibility

The extension MUST keep healthy live sync practically invisible to the user. It MUST show a visible degraded indicator only when bounded silent recovery cannot restore healthy live sync promptly. During destructive folder/bookmark cascades, missing-parent or stale-mapping recovery MUST attempt deterministic subtree recovery before workspace recovery and MUST enter degraded state only after that bounded sequence fails.

(Previously: degraded visibility covered general silent recovery, but cascade-specific recovery order and deterministic degraded entry were not explicit.)

#### Scenario: Silent recovery succeeds

- GIVEN live delivery is briefly interrupted
- WHEN bounded reconnect or replay recovery restores live sync promptly
- THEN the extension remains usable without showing a degraded indicator

#### Scenario: Cascade recovery repairs stale parent

- GIVEN destructive remote churn invalidates a mapped Chrome parent
- WHEN bounded subtree or workspace recovery restores a canonical parent path
- THEN the extension continues without showing a degraded indicator

#### Scenario: Degraded indicator appears after bounded cascade recovery fails

- GIVEN destructive cascade recovery cannot restore a valid parent within budget
- WHEN the deterministic subtree-then-workspace recovery sequence is exhausted
- THEN the extension shows a visible degraded indicator until health is restored

### Requirement: Local Mapping, Exclusions, and Reconciliation

The extension MUST persist backend↔Chrome ID mappings and viewer-local exclusions in local storage. Healthy remote events MUST apply automatically in Chrome within a few seconds, without requiring manual reload or manual resync as the normal visible path. Missing mapped nodes, unauthorized local edits, duplicate-create risk, rejected mutations, or missing/stale parent references during destructive folder/bookmark cascades MUST reconcile to backend state. Before creating, moving, deleting, or rebuilding a managed node, the extension MUST validate the mapped Chrome node and expected parent path. If validation fails, it MUST prune invalid mapping state, reconcile the affected subtree first, and escalate to workspace recovery only when subtree recovery cannot re-establish a canonical parent. Remote apply MUST NOT continue against stale parent state, and repeated local `404` or missing-parent rejections MUST NOT loop indefinitely. Viewer-local exclusions SHALL survive remote updates and MUST NOT rewrite shared semantics.

(Previously: mappings and exclusions reconciled backend-authoritative state, but destructive-cascade parent validation, stale-mapping prune order, and bounded 404 recovery were not explicit.)

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

#### Scenario: Recover stale parent before remote apply continues

- GIVEN a remote create, move, or delete depends on a missing or stale Chrome parent
- WHEN the extension detects the invalid parent before applying the mutation
- THEN it prunes invalid mappings and reconciles the affected subtree before continuing

#### Scenario: Stop repeated local rejection loops

- GIVEN a destructive local move or delete is rejected with repeated `404` or missing-parent failures
- WHEN the extension exhausts the bounded retry budget for that subtree
- THEN it stops retrying the same local mutation and escalates to recovery or degraded state
