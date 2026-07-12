# Extension Sync Convergence

## Requirements

### Requirement: Canonical Idempotent Projection

Canonical backend state MUST win. N identical snapshot/event applications MUST yield one managed tree, one node per canonical ID, and no remote-caused backend mutation. The system MUST NOT delete outside managed subtree.

#### Scenario: Apply the same snapshot N times
- GIVEN a canonical snapshot
- WHEN the snapshot is applied N times
- THEN tree and mapping bijection remain unchanged after first convergence

#### Scenario: Remote listener event is delivered twice
- GIVEN a correlated remote Chrome operation
- WHEN its listener event is delivered twice
- THEN neither delivery becomes a local backend mutation

### Requirement: Durable Apply Ownership and Recovery

Before remote Chrome effects, the extension MUST durably record workspace ownership and checkpoint epoch, phase, canonical/Chrome identity or result, and cursor/progress. Restart MUST resume/reconcile it, not treat event as local.

#### Scenario: Worker stops after side effect
- GIVEN a Chrome side effect completes before its next checkpoint commit
- WHEN the service worker restarts
- THEN it reconciles the recorded operation without duplicate creation or local mutation

#### Scenario: Listener around mapping persistence
- GIVEN create, remove, change, or move events arrive before and after mapping persistence
- WHEN the owned operation is reconciled
- THEN each event is classified from durable correlation, not timing

### Requirement: Epoch-Scoped Bounded Work

Each workspace MUST allow one active apply and one latest queued rerun. Newer epochs MUST invalidate stale work. Recovery MUST converge or pause/degrade after a bounded limit; it MUST NOT loop.

#### Scenario: Concurrent resync and reconnect
- GIVEN two resync intents and a reconnect arrive for one workspace
- WHEN a newer snapshot epoch begins
- THEN stale work is invalidated and only active work plus one latest rerun execute

#### Scenario: Bounded repair failure
- GIVEN repair reaches its configured attempt limit
- WHEN the last attempt fails
- THEN the workspace pauses/degrades and requires explicit Retry or Rebuild action

### Requirement: Local Mutation and Identity Safety

Repair-time local edits MUST queue durably with stable event IDs and apply once after convergence. Title/URL similarity MUST NOT establish identity. Mapping loss, stale IDs, or ambiguity MUST pause or use controlled rebuild, never guess or duplicate.

#### Scenario: Local edit during repair
- GIVEN a user edit occurs while repair is active
- WHEN the workspace converges
- THEN its durable event is sent exactly once after convergence

#### Scenario: Ambiguous legacy mapping
- GIVEN mapping is lost and two Chrome nodes share title and URL
- WHEN migration or reconciliation evaluates candidates
- THEN it pauses or starts controlled rebuild without adopting or creating a duplicate implicitly

### Requirement: Isolation, Authentication, and Operator Controls

Workspace state MUST be isolated. Authentication expiry during REST/WebSocket/apply MUST pause work for renewal without duplicate resync, then resume from checkpoint. Retry MUST resume bounded recovery; Rebuild MUST be explicit, remain owned, and preserve rollback boundaries.

#### Scenario: Expiry during apply
- GIVEN an apply is checkpointed when authentication expires
- WHEN renewal succeeds
- THEN it resumes from that checkpoint with no duplicate apply or resync

#### Scenario: Retry and rebuild scope
- GIVEN a workspace is degraded
- WHEN Retry or Rebuild is selected
- THEN only that workspace's managed subtree is affected and unrelated workspaces remain unchanged

### Requirement: Migration, Diagnostics, and Evidence

Legacy mappings MUST migrate or adopt only with unambiguous proof; otherwise they MUST pause or use controlled rebuild and MUST NOT duplicate. Diagnostics MUST expose workspace, epoch, cause, attempt, listener disposition, and pause reason without secrets. Tests MUST model Chrome listener order, delayed/duplicate events, storage concurrency, restart, mapping loss, expiry, and reconnect.

#### Scenario: Deterministic recovery matrix
- GIVEN schedules covering reordered listeners, duplicate events, concurrent storage, restart, mapping loss, expiry, and reconnect
- WHEN each schedule executes
- THEN it proves convergence or the specified bounded paused/degraded terminal state without secret output
