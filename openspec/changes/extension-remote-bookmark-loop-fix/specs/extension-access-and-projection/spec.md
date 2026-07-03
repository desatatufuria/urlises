# extension-access-and-projection Specification

## Purpose

Define extension projection behavior for backend-authoritative live sync, bounded recovery, and remote bookmark update/move loop prevention inside the managed Chrome tree.

## Requirements

### Requirement: Live Sync Degraded Visibility

The extension MUST keep healthy live sync practically invisible to the user. It MUST show a visible degraded indicator only when bounded silent recovery cannot restore healthy sync after replay, subtree recovery, or workspace recovery is exhausted.

#### Scenario: Silent recovery succeeds

- GIVEN live delivery is briefly interrupted
- WHEN bounded reconnect or replay recovery restores healthy sync promptly
- THEN the extension remains usable without showing a degraded indicator

#### Scenario: Recovery budget is exhausted

- GIVEN replay and bounded recovery cannot restore healthy sync
- WHEN the extension cannot continue reliable remote apply
- THEN it shows a visible degraded indicator until health is restored

### Requirement: Local Mapping, Exclusions, and Reconciliation

The extension MUST persist backend↔Chrome mappings and viewer-local exclusions in local storage. It MUST validate mapped nodes and expected parent paths before remote create, move, update, or delete continues. If validation fails, it MUST prune invalid mapping state, reconcile the affected subtree first, and escalate to workspace recovery only when subtree recovery cannot restore a canonical managed path. Viewer-local exclusions SHALL survive remote updates and MUST NOT rewrite shared semantics.

#### Scenario: Reconcile stale managed state

- GIVEN a remote event references a stale mapped node or parent
- WHEN validation fails before apply continues
- THEN the extension prunes invalid mapping state and reconciles the affected subtree first

#### Scenario: Preserve viewer-local exclusion

- GIVEN a viewer excluded a managed node locally
- WHEN remote canonical updates arrive for the same workspace
- THEN the exclusion remains local and shared backend state is unchanged

### Requirement: Remote Bookmark Update and Move Loop Prevention

The extension MUST treat Chrome `onChanged` and `onMoved` events caused by remote bookmark update or move apply as remote side effects, not as fresh local mutations. It MUST correlate equivalent side effects to the backend bookmark, operation type, and resulting parent/index state so remote apply is not re-emitted to the backend. Remote bookmark move apply MUST preserve backend-authoritative sibling ordering and MUST stop repeated rejection or replay churn once remote recovery has started. The extension MUST degrade only on true unrecoverable runtime failure.

#### Scenario: Remote bookmark update is not re-emitted

- GIVEN a remote `bookmark.updated` event changes a managed bookmark title or URL
- WHEN Chrome emits the equivalent `onChanged` side effect during apply
- THEN the extension suppresses backend re-emission for that bookmark update

#### Scenario: Remote bookmark move preserves order without loop

- GIVEN a remote bookmark move changes parent or sibling index
- WHEN Chrome emits the equivalent `onMoved` side effect during apply
- THEN the extension keeps the final parent/index aligned with backend order and does not send an equivalent local move back to the backend

#### Scenario: Remote recovery bounds churn

- GIVEN remote bookmark apply already entered recovery for a rejected update or move
- WHEN equivalent local listener events or retries recur for the same bookmark scope
- THEN the extension abandons repeated looped retries and degrades only if bounded recovery still cannot restore reliable apply
