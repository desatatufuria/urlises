# Design: Extension Remote Bookmark Loop Fix

## Technical Approach

Keep the fix extension-first and limited to bookmark remote upsert/move behavior in `extension/src/background/projection.ts` plus listener coordination in `extension/src/background/bookmark-listeners.ts`. Replace the current 250ms ID-only suppression with a short-lived remote-apply correlation ledger keyed by workspace, backend bookmark ID, Chrome ID, and operation shape so `onChanged` / `onMoved` side effects produced by remote apply are swallowed only when they match the expected remote outcome. Recovery stays subtree/workspace based, and degraded state remains the last resort.

## Architecture Decisions

### Decision: Correlate remote bookmark apply by operation shape

**Choice**: Track pending remote bookmark apply entries with expected `title`, `url`, `parentChromeId`, and `index`, then let local listeners suppress only equivalent events.
**Alternatives considered**: Keep `suppressedChromeIds`; disable listeners broadly during remote apply.
**Rationale**: The bug is a false local re-emission problem, not a generic listener problem. Shape-based correlation is narrow enough to avoid hiding real local edits.

### Decision: Suppression is consumed by matching listener type, not by time alone

**Choice**: `handleBookmarkChanged` clears only the pending update part, and `handleBookmarkMoved` clears only the pending move part after payload equivalence is confirmed.
**Alternatives considered**: One-shot consume on first event; longer TTL only.
**Rationale**: A remote bookmark upsert can emit both `onChanged` and `onMoved`. One-shot suppression is exactly why equivalent follow-up events can escape today.

### Decision: Backend order is verified inside remote apply

**Choice**: After remote bookmark move/update apply, verify the resulting Chrome node parent/index against the backend target and recover only when the final state is still wrong.
**Alternatives considered**: Accept Chrome intermediate ordering; resync immediately after every remote move.
**Rationale**: The backend is authoritative. The runtime must preserve final canonical order without turning every remote move into churn.

## Data Flow

```text
remote bookmark.updated
  -> build pending remote op (bookmarkId/chromeId + expected fields)
  -> apply updateNode/moveNode
  -> Chrome emits onChanged/onMoved
  -> listener resolves backend context + compares payload to pending op
  -> match: swallow + clear matched part
  -> mismatch: treat as real local mutation
  -> verify final parent/index
  -> recover only on true runtime failure
```

Runtime sequence:
1. `applyRemoteBookmarkUpsert()` creates a pending remote bookmark operation before `updateNode()` or `moveNode()`.
2. The operation records the backend bookmark ID, mapped Chrome ID, expected title/url, expected parent Chrome ID, expected final index, cursor, and expiry.
3. `handleBookmarkChanged()` resolves the bookmark context and suppresses only when the listener payload equals the pending remote title/url outcome.
4. `handleBookmarkMoved()` suppresses only when the listener payload equals the pending remote parent/index outcome; otherwise current local-mutation logic remains.
5. If both update and move are expected, each half stays pending until its matching listener arrives or the operation expires.
6. After remote apply, the runtime re-reads the Chrome node. If final parent/index still differs from the backend target, it enters the existing subtree-first recovery ladder.
7. Equivalent local retries encountered after recovery starts are abandoned for that bookmark scope; degraded state is used only after bounded recovery is exhausted.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `openspec/changes/extension-remote-bookmark-loop-fix/design.md` | Create | Technical design for the narrow remote bookmark loop fix. |
| `extension/src/background/projection.ts` | Modify | Add pending remote bookmark operation tracking, payload-equivalent suppression, final order verification, and bounded cleanup. |
| `extension/src/background/bookmark-listeners.ts` | Modify | Keep listener contracts explicit for change/move correlation used by projection runtime. |
| `extension/tests/projection-behavior.test.mjs` | Modify | Cover remote update suppression, remote move suppression, combined update+move, final order stability, and degrade-only-on-failure behavior. |
| `README.md` / `docs/roadmap.md` | Modify | Document the narrow Gitflow follow-up and runtime rule being fixed. |

## Interfaces / Contracts

```ts
type PendingRemoteBookmarkOp = {
  workspaceId: string;
  backendId: string;
  chromeId?: string;
  expected?: { title?: string; url?: string };
  targetMove?: { parentChromeId: string; index: number };
  cursor: number;
  expiresAt: number;
};

matchesRemoteChange(op, changeInfo): boolean;
matchesRemoteMove(op, moveInfo): boolean;
finalizeRemoteBookmarkOp(op, kind: "change" | "move"): void;
```

Rules:
- Suppression MUST require bookmark identity plus equivalent payload.
- A matched remote change/move MUST NOT trigger backend mutation APIs.
- Final backend parent/index MUST be preserved before remote apply is considered successful.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Payload-equivalence matching and partial op consumption | Focused helper tests around pending remote op matching. |
| Integration | Remote bookmark update/move side effects vs local listeners | Extend `projection-behavior.test.mjs` with mocked Chrome events and strict index cases. |
| E2E | Remote bookmark reorder no longer loops or degrades prematurely | Manual Chromium validation against local backend until broader E2E tooling exists. |

## Migration / Rollout

No migration required. Roll out on the current Gitflow extension follow-up branch.

## Open Questions

- [ ] Should final-order verification retry one in-memory move before subtree recovery, or should any post-apply mismatch escalate immediately to recovery?
