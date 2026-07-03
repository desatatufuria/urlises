# Design: Extension Live Sync Fix

## Technical Approach

Keep the fix extension-first. The current runtime does a full `resyncWorkspace()` before every `connectWorkspace()`, treats websocket health as binary `socketConnected`, and falls back to full resync on most remote-apply uncertainty. The change narrows that behavior: bootstrap once, subscribe immediately after projection is ready, advance by ordered live events, use bounded replay-first recovery for gaps/disconnects, and show degraded state only after silent recovery budget is exhausted. This implements the proposal and the `extension-access-and-projection` / `bookmark-sync-projection` deltas without changing normal backend behavior.

## Architecture Decisions

### Decision: Workspace runtime phases

**Choice**: Model each projection as `bootstrap -> live -> recovering -> degraded` on top of existing `ProjectionState`.
**Alternatives considered**: Keep `idle|syncing|ready|error` only; infer health only from diagnostics.
**Rationale**: Live-sync health needs explicit runtime sequencing and user-visible signaling, not log-only inference.

### Decision: Recovery order

**Choice**: Prefer websocket reconnect + contiguous replay from `lastCursor`; use full snapshot resync only for replay gap, stale mapping repair, or repeated apply failure.
**Alternatives considered**: Full resync on every reconnect; immediate degraded UI on socket close.
**Rationale**: Meets the requirement that replay/resync stays fallback-only and keeps healthy recovery invisible.

### Decision: Duplicate prevention

**Choice**: Before any remote create/rebuild, reconcile canonical mapping by backend ID and by current Chrome subtree under the expected parent; only create when neither path resolves.
**Alternatives considered**: Trust stored mapping only; rely on later snapshot cleanup.
**Rationale**: Stored mappings can be stale after local/manual Chrome changes. Pre-create reconciliation is the only reliable way to prevent duplicate nodes for one backend node.

### Decision: Backend changes threshold

**Choice**: No backend change unless the extension cannot distinguish healthy resume vs mandatory rebuild using existing `ack|event|resync_required` plus replay API.
**Alternatives considered**: Add backend heartbeats or richer WS state immediately.
**Rationale**: The current backend already provides ordered cursor replay and explicit `resync_required`; extension gaps should be fixed there first.

## Data Flow

```text
startup/selection
  -> bootstrap snapshot once
  -> connect WS
  -> ack(currentCursor)
  -> if ack > lastCursor: replay(afterCursor=lastCursor)
  -> apply ordered events
  -> live healthy

socket close / cursor gap / apply error
  -> mark recovering
  -> reconnect with bounded retries
  -> replay if contiguous
  -> full resync only if replay gap or mapping repair needed
  -> degraded only if recovery budget exhausted
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `extension/src/background/projection.ts` | Modify | Split bootstrap/live/recovery sequencing, add bounded silent recovery budget, replay-first reconnect path, and pre-create duplicate reconciliation. |
| `extension/src/shared/types.ts` | Modify | Extend `ProjectionState` with health/degraded metadata and recovery counters/timestamps. |
| `extension/src/shared/storage.ts` | Modify | Preserve new projection health fields in persisted state defaults. |
| `extension/src/shared/websocket.ts` | Modify | Surface connection lifecycle consistently for retry scheduling and health transitions. |
| `extension/src/options/options.ts` | Modify | Render a visible degraded indicator only when projection health enters degraded state; keep healthy sync quiet. |
| `extension/tests/projection-behavior.test.mjs` | Modify | Cover sequencing, replay-first recovery, degraded threshold, and duplicate-prevention behavior. |
| `README.md` | Modify | Document live-sync runtime expectations and degraded/recovery behavior for this slice. |
| `docs/roadmap.md` | Modify | Record the remediation scope and extension-first delivery intent. |

## Interfaces / Contracts

```ts
type ProjectionHealth = "bootstrap" | "live" | "recovering" | "degraded";

type ProjectionState = {
  health: ProjectionHealth;
  recoveryAttemptCount: number;
  recoveryStartedAt?: string;
  degradedReason?: string;
};
```

Runtime rules:
- `connectWorkspace()` MUST NOT force a full resync when `lastCursor` is trusted.
- `applyRemoteEnvelope()` MUST attempt mapping reconciliation before create/rebuild branches.
- Silent recovery budget SHOULD be small and deterministic (for example: a few reconnect attempts within seconds, then degrade).
- Backend change is justified only if replay/WS cannot provide the cursor or failure signal needed to decide replay vs rebuild.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit | Health-state transitions, retry budget, duplicate reconciliation decisions | Extend TS pure/runtime tests around projection state machines and mapping repair helpers. |
| Integration | Replay-after-ack sequencing and stale-mapping recovery against persisted state | Node-based projection tests with mocked WS/API/chrome adapters. |
| E2E | Remote change appears within seconds; degraded indicator stays hidden during silent recovery | Manual Chromium validation for the change slice until broader E2E tooling exists. |

## Migration / Rollout

No data migration required. Roll out on the Gitflow remediation branch for this change. Backend code stays untouched unless implementation proves the extension cannot make replay/resync decisions from current contracts.

## Open Questions

- [ ] Does implementation need a tiny shared helper for subtree lookup by expected parent/title to repair stale mappings before create?
