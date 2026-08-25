# Delta for extension-sync-convergence

## ADDED Requirements

### Requirement: Serialized Rebuild Per Workspace

Concurrent `Rebuild` requests for the SAME workspace MUST serialize through a dedicated per-workspace lock inside `rebuildWorkspace`, so `doResyncWorkspace` never runs concurrently with another rebuild of the same workspace and neither run can observe "folder does not exist yet" while the other is also creating it. The rebuild lock MUST use a separate lock map from the existing local-intent-drain lock (`workspaceLocks`) — the two lock domains MUST NOT share keys or a lock map, since a rebuild arriving during a drain (or vice versa) would otherwise be silently satisfied by the wrong operation's rerun instead of performing the requested one. The rebuild lock map MUST reset alongside `workspaceLocks` on the same lifecycle trigger. This serialization is in-memory only and MUST NOT alter backend requests, responses, or any persisted schema.

#### Scenario: Concurrent rebuilds of one workspace converge to one folder
- GIVEN two Rebuild requests for the same workspace fire without awaiting each other
- WHEN both are processed
- THEN exactly one managed workspace folder exists afterward
- AND the workspace's `workspaceChromeId` remains stable across both requests

#### Scenario: Rebuild lock is a distinct domain from the drain lock
- GIVEN a rebuild holds the dedicated rebuild lock for a workspace
- WHEN a local-intent drain is requested for the same workspace concurrently
- THEN the drain uses `workspaceLocks` and is not satisfied by, or substituted for, the in-flight rebuild
- AND the rebuild is not satisfied by, or substituted for, the drain

#### Scenario: Rebuild lock map resets with workspace locks
- GIVEN the runtime resets `workspaceLocks`
- WHEN the reset trigger fires
- THEN the dedicated rebuild lock map is reset in the same operation

#### Scenario: No backend or persisted-schema change from serialization
- GIVEN rebuild serialization is applied via an in-memory lock
- WHEN concurrent rebuilds are processed
- THEN no backend request, response shape, or persisted schema differs from before this change

### Requirement: Serialized Managed Root and Organization Folder Creation

`ensureManagedPath`'s check-then-create sequence for the shared root and organization folder MUST serialize across workspaces, independent of the per-workspace rebuild lock, so that two different workspaces sharing an organization cannot both observe "folder does not exist yet" and both create it. This mechanism is distinct from the per-workspace rebuild lock: the rebuild lock prevents a workspace from racing against itself; this serialization prevents two different workspaces from racing on a shared ancestor folder.

#### Scenario: Concurrent rebuilds of two workspaces in one organization converge to one shared root and org folder
- GIVEN two workspaces belong to the same organization and each receives a concurrent Rebuild request
- WHEN both requests run `ensureManagedPath` without awaiting each other
- THEN exactly one shared root folder exists afterward
- AND exactly one organization folder for that organization exists afterward

#### Scenario: Same-workspace race and cross-workspace race use different mechanisms
- GIVEN two Rebuild requests for the same workspace race, and separately two Rebuild requests for two different workspaces in the same organization race
- WHEN both races are resolved
- THEN the same-workspace race is prevented by the per-workspace rebuild lock serializing `doResyncWorkspace`
- AND the cross-workspace race is prevented by serializing `ensureManagedPath`'s check-then-create sequence, not by the per-workspace rebuild lock

### Requirement: Diagnostic Log on Unrecognized Local-Only Folder

When `ensureLocalOnlyFolder` cannot find its previously-recorded local-only folder under the current workspace root, it MUST log a diagnostic identifying the missing/reparented folder before falling back to creating a new one. This is an observability addition only: the fallback behavior of creating the folder when it is legitimately missing (e.g. the user deleted or renamed it in Chrome) is unchanged.

#### Scenario: Missing local-only folder is logged before recreation
- GIVEN a workspace's previously-recorded local-only folder id is not found under the current workspace root
- WHEN `ensureLocalOnlyFolder` runs
- THEN a diagnostic is logged identifying the mismatch before any new folder is created
- AND a new local-only folder is created afterward, exactly as before this change

#### Scenario: Recognized local-only folder needs no diagnostic
- GIVEN a workspace's previously-recorded local-only folder id is found under the current workspace root
- WHEN `ensureLocalOnlyFolder` runs
- THEN no diagnostic is logged
- AND the existing folder is reused, unchanged from today's behavior
