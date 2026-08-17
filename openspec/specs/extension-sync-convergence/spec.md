# Extension Sync Convergence

## Requirements

### Requirement: Complete-Shape Backend No-Op

Update/move MUST compare complete final shape to canonical state. Equal shape MUST return stable acknowledgement for its idempotency header/key, publish no event, and advance no cursor. Same key/shape SHALL acknowledge equivalently; reused key/different shape MUST fail without mutation.

#### Scenario: Replayed final shape
- GIVEN canonical state equals the request
- WHEN submitted or retried
- THEN success has no event or cursor advance

#### Scenario: Incompatible key reuse
- GIVEN a key acknowledged for one shape
- WHEN submitted with another shape
- THEN it rejects without mutation

### Requirement: Durable Receipt and Intent Ownership

Before remote update/move, the extension MUST durably queue callbacks unproven as pending transitions as stable-ID local intent. Receipts SHALL bind workspace, backend/Chrome IDs and type, before/expected-after shapes, event/cursor, expected signature(s), pending/consumed state, and bounded lifecycle. Per-node transitions MUST serialize; pending local edits MUST queue.

#### Scenario: Callback during pending transition
- GIVEN a pending receipt and unproven local callback
- WHEN the callback is reduced
- THEN its stable intent is retained, not suppressed or discarded

#### Scenario: Restart with receipt or intent
- GIVEN restart with pending receipt/intents
- WHEN recovery runs
- THEN it safely proves/resumes or pauses without losing intent

### Requirement: Complete Callback Proof

`onChanged` partial data MUST have complete-node read and durable last-acknowledged before-shape before consumption. `onMoved` MUST prove exact old/new parent/index and workspace. Hidden-field, signature, shape, mapping, or containment mismatch MUST NOT consume and SHALL queue observable intent.

#### Scenario: Hidden URL differs
- GIVEN a title-only callback with unexpected complete-node URL
- WHEN receipt matching runs
- THEN it is not consumed and is queued

#### Scenario: Adversarial Chrome-like ID
- GIVEN workspaces reuse an equivalent Chrome-like ID
- WHEN a move callback arrives outside the receipt workspace root
- THEN it cannot match or affect the receipt workspace

### Requirement: Post-Consumption Ambiguity

MUST NOT use timing, Chrome-ID-wide suppression, or terminal receipts for later callback ownership. Duplicate, delayed, reordered, or identical post-consumption callbacks MUST use stable local-intent/no-op semantics. Only one exact pending receipt may consume.

#### Scenario: Immediate local reversion
- GIVEN a remote transition has been consumed
- WHEN the user immediately restores the former title or position
- THEN the action is queued as local intent, not suppressed

#### Scenario: Two sequential remote transitions
- GIVEN two serialized receipts for one node
- WHEN callbacks arrive before/after promise, duplicate, or reordered
- THEN each exact pending transition consumes once and all others queue

### Requirement: Verified Fail-Closed Sequencing

Workspace MUST checkpoint only after predecessor final-shape verification. Capacity, write, read, verification, promise, or ambiguity errors MUST cause no effect/checkpoint, pause, stop later live/replay cursor advancement, and retry the failed cursor. Replay at/below checkpoint MUST be refused.

#### Scenario: Read failure at cursor zero
- GIVEN the node read fails while applying cursor zero
- WHEN a later live event or replay event arrives
- THEN it remains paused at zero with no later effect or advance

### Requirement: Bounded Durable Retention

Receipt/outbox capacity MUST be bounded; deterministic pruning requires terminal verification and safe cursor progress. Unacknowledged intent MUST NOT be pruned; exhaustion MUST pause before effect/API call.

#### Scenario: Full outbox
- GIVEN the outbox has unacknowledged intent
- WHEN a local edit occurs
- THEN it pauses without discarding intent or remote work

### Requirement: Isolation, Repair, and Diagnostics

Containment MUST be strict for all receipts, intents, callbacks, and effects. Durable create/delete behavior SHALL remain unchanged; destructive normal resync MUST remain disabled until final repair/enablement. Diagnostics MUST explain pause, no-op, queued intent, cursor, and disposition without secrets.

#### Scenario: Repair and diagnosis
- GIVEN a containment or verification failure during repair
- WHEN diagnostics are requested
- THEN only the affected workspace pauses, the reason is observable without secrets, and no destructive resync runs

## Unaffected Capabilities

`extension-session-continuity` is unaffected by this specification.
