# Design: Extension Premium UI

## Technical Approach

Keep the existing MV3 + vanilla TypeScript architecture, but replace the ad-hoc inline styling and string-only status rendering with a small shared UI foundation used by both `popup` and `options`. The redesign stays strictly in popup, options, toolbar status, and status surfaces; background sync semantics remain intact. This implements the proposal’s premium direction and the specs’ requirements for dark theme, subtle motion, hierarchy, and cross-surface activity signals.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Shared UI foundation | Add shared static CSS tokens/components plus small TS view helpers under `extension/src/shared/ui/` | Keep per-page inline `<style>` blocks | The repo uses plain HTML + TS with no CSS bundler. Shared static assets fit the current build and avoid duplicating theme rules. |
| Rendering model | Keep imperative DOM rendering in `popup.ts` and `options.ts` | Introduce React/preact or a template library | The current extension already renders with direct DOM updates. Reusing that pattern keeps scope narrow and avoids toolchain expansion. |
| Activity signal state | Add lightweight UI-facing activity metadata in extension state, derived in background on successful sync/replay and acknowledged by surfaces | Infer “new” from diagnostics text only | A dedicated signal is required for the blue indicator and keeps presentation separate from verbose diagnostics. |
| Toolbar badge status | Derive a compact badge model from existing health/activity state and update the MV3 action badge from the service worker | Introduce a parallel badge-specific store | Reusing the existing projection/activity signals keeps badge behavior consistent with popup/options and avoids new state contracts. |

## Data Flow

Background sync remains the producer of truth for UI status; popup/options become richer consumers.

    projection.ts ──updates──> ExtensionState/UI signals
           │                         │
           ├── socket/live health ───┤
           └── replay/apply activity ┤
                                     │
                     service-worker message bridge
                          │                    │
                       popup.ts            options.ts
                          │                    │
                    shared theme.css + status helpers
                          │
                    action badge projection

New activity flow:
1. Background marks a workspace/activity revision when replay, websocket apply, or resync completes successfully.
2. `session/get` and `options/load` return that state.
3. Popup/options render a blue dot when unseen activity exists.
4. Surface sends a narrow “activity seen” acknowledgement after render/open so the indicator clears without touching sync contracts.
5. Service worker mirrors the same state into the toolbar icon badge, with degraded red taking precedence over unseen-activity blue.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `extension/src/shared/ui/theme.css` | Create | Shared tokens, dark palette, typography, spacing, elevation, motion, and reusable surface classes. |
| `extension/src/shared/ui/status.ts` | Create | Helpers that derive presentation-ready status labels, tone, online state, and new-activity visibility from `ExtensionState`. |
| `extension/src/shared/types.ts` | Modify | Add UI signal metadata for unseen activity and compact status summaries; keep contracts UI-facing only. |
| `extension/src/background/projection.ts` | Modify | Populate online/activity metadata when sockets connect, replay succeeds, or sync events are applied; expose mark-seen handler support. |
| `extension/src/background/service-worker.ts` | Modify | Add narrow message route for acknowledging activity visibility and mirror badge state to the toolbar icon. |
| `extension/src/popup/popup.html` | Modify | Replace inline-only styling with shared foundation hooks and premium popup structure. |
| `extension/src/popup/popup.ts` | Modify | Render stacked status cards: session, workspace summary, projection summary, online dot, and blue activity indicator. |
| `extension/src/options/options.html` | Modify | Reframe page into overview, health banner, workspace cards, and diagnostics sections using shared classes. |
| `extension/src/options/options.ts` | Modify | Render per-workspace status cards with hierarchy, diagnostics grouping, online signal, and calmer empty/degraded states. |

## Interfaces / Contracts

```ts
interface ActivitySignal {
  revision: number;
  lastSeenRevision: number;
}

interface ProjectionState {
  // existing fields...
  lastActivityAt?: string;
}

interface ExtensionState {
  // existing fields...
  activitySignal?: ActivitySignal;
}
```

Message addition:

```ts
{ type: "ui/mark-activity-seen" }
```

`status.ts` will expose pure helpers such as `getPopupStatusModel(state)` and `getWorkspaceStatusModel(projection)` so popup/options share logic while keeping layout-specific markup separate.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Status helper output, unseen-activity rules, degraded/online tone mapping, toolbar badge precedence | Add focused Node tests for `shared/ui/status.ts`. |
| Integration | Background state transitions set activity/online metadata correctly | Extend `extension/tests/projection-behavior.test.mjs`. |
| E2E | None automated in repo today | Manual Chromium check for popup/options dark theme, online dot, blue indicator clear-on-open, and degraded prominence. |

## Migration / Rollout

No migration required. Persisted extension state changes must be backward-compatible by treating new UI metadata as optional defaults during normalization.

## Open Questions

- [ ] Confirm whether “seen” should clear on popup open, options open, or only after either surface fully renders.
