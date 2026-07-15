# Design: Extension Sync Convergence Session

## Technical Approach

Keep Slice A unchanged. Redesign Slice B update/move as a durable receipt ledger plus local-intent outbox. Create/delete ownership at `482ed88` remains unchanged. Rebuild/resync is not enabled until final repair.

## Phase 12/13 — Update/Move Convergence Redesign

### Observable boundary and decision

`onChanged(id, {title?, url?})` is partial; `onMoved(id, {oldParentId, oldIndex, parentId, index})` is a tuple. Neither has a token, workspace, or complete node. Callbacks may precede/follow promises and duplicate/reorder. A callback alone cannot prove ownership or distinguish a delayed remote callback from an identical local action after consumption. **No clock/window or chromeId-wide suppression is permitted.**

| Option | Tradeoff | Decision |
|---|---|---|
| Retain done ownership / timing suppression | Drops legitimate immediate edits | Reject |
| Consume partial payload | Cannot establish complete transition identity | Reject |
| Receipt + full read + outbox no-op contract | Requires Phase 12 foundation and spec clarification | Choose |

### Receipt and transition model

Persist a bounded, versioned per-workspace `transitionReceipts` ledger. A receipt is `{id, workspaceId, entityType, backendId, chromeId, cursor, eventId, before, expectedAfter, signatures, state}`. Shapes include type/title/URL/parent/index; signatures are changed fields/values and/or move old/new tuple. States: `pending | consumed | verified | failed`; compact terminal receipts only after cursor advance. Persist `lastAcknowledgedShape` per mapped node.

Before `updateNode`/`moveNode`, the workspace serial reducer verifies mapping/managed containment, reads `before`, writes `pending`, then calls Chrome. The callback uses that reducer, proves containment, reads the full node, and compares `expectedAfter` plus signature. A partial `onChanged` never consumes without this read. Mark `consumed` and update `lastAcknowledgedShape`; mark `verified` only after promise/read confirms final shape. Mismatch becomes a local intent.

### Phase boundary and flow

Phase 12 must move local-intent capture/outbox **before** remote update/move application; it cannot be correct as the former later phase.

```text
listener -> workspace reducer -> full node read -> pending receipt match?
                                     | yes, pending: consume -> verify
                                     | no/already consumed: durable local intent -> outbox
remote event -> receipt(pending) -> Chrome effect -> read/verify -> cursor checkpoint
```

After consumption, an indistinguishable callback queues, never suppresses. Required invariant: an outbox update/move whose complete shape already equals backend canonical state is a no-op (no mutation/event/cursor advance). Without it, remote-feedback prevention and preserving indistinguishable local actions are information-theoretically incompatible.

### State machine, failures, and invariants

`planned -> pending -> consumed -> verified`; `pending|consumed -> failed -> paused`. Checkpoint requires verified predecessor cursor. Capacity/write/read/promise error or mismatch pauses and preserves cursor. Refuse replay `cursor <= lastCursor`; no later event passes a failed cursor. On restart, prove then verify; retry only pre-effect pending with proof, else pause `ambiguous-transition`. No-op remote shape has no receipt/effect. Pending local edits queue with stable IDs.

| Failure | Safe outcome |
|---|---|
| Full-node read/runtime error, unknown containment, signature/shape mismatch | Queue local intent when observable; otherwise pause, no cursor advance |
| Receipt/outbox capacity or durable-write failure | Pause before Chrome/API effect; retain failed cursor |
| Callback before/after promise, duplicate before consumption | Serialized first exact pending match consumes once; others queue |
| Duplicate after consumption / immediate local reversion | Queue; backend no-op invariant prevents feedback, reversion is preserved |

Invariants: every receipt and intent names one workspace; only its managed root may match; receipt consumption requires exact complete transition proof; each cursor is terminally verified before checkpoint; queues are bounded and fail closed; create/delete semantics remain unchanged.

## Delivery, Interfaces, and Rollback

12a (<=400 lines): types/storage migration, reducer, receipt/outbox normalization, no-op contract tests. 12b (<=400): remote update/move application and listener correlation. 13 (<=400): recovery, compaction, cursor sequencing, behavior matrix. Modify shared types/storage/API, projection/convergence, and fake-Chrome tests. Migrate v1 additively; unknown legacy in-flight update/move pauses. Rollback disables only new update/move application, retains ledger/outbox, and never auto-Rebuilds.

## Testing Strategy

Fake-Chrome tests must construct each state: title-/URL-only callback with full-node mismatch; immediate reversion; repeated move; duplicates before/after consumption; callback before/after promise; restart per receipt state; same chrome-like IDs in two workspaces; containment violation; read/write/capacity failures; cursor-0 failure then later event; replay refusal at `currentCursor <= lastCursor`. Assert receipt, outbox, mapping, calls, cursor, pause. Preserve create/delete regressions.

## Specification and Rollout Implications

The convergence spec lacks the backend no-op contract and post-consumption ambiguity routing. A **spec delta is required**, not tasks-only: complete-shape no-op without publish/cursor advance, partial-callback full-read proof, containment isolation, fail-closed cursor ordering. Proposal scope is unchanged. Threat matrix: N/A — no routing, shell, subprocess, VCS/PR automation, executable classification, or process-integration boundary.
