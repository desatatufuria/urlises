# Chrome Extension Guide

## Responsibilities

The extension owns Chrome API interaction, local session/state, managed-root filtering, backend/Chrome mappings, replay, WebSocket subscription, convergence/recovery, and viewer-local preferences. It does not own canonical bookmark meaning.

## MV3 runtime

| Area | Files | Responsibility |
| --- | --- | --- |
| Service worker | `src/background/service-worker.ts` | Registers listeners and coordinates runtime actions |
| Projection | `src/background/projection.ts` | Bootstraps trees, applies changes, manages cursors and health |
| Convergence | `src/background/convergence.ts` | Durable journal and operation ownership |
| Chrome adapter | `src/background/chrome-bookmarks.ts` | Chrome bookmark operations |
| REST client | `src/shared/api.ts` | Authenticated API requests and sync headers |
| WebSocket client | `src/shared/websocket.ts` | Ticket connection, events, callbacks, idle keepalive |
| Storage | `src/shared/storage.ts` | Serialized `chrome.storage.local` state and normalization |
| Popup/options | `src/popup`, `src/options` | Login, workspace selection, status, diagnostics, resync |

## Durable local state

The extension stores settings, session, durable client ID, selected workspaces, cached catalogs, per-workspace projections, diagnostics, and activity signals in `chrome.storage.local`. Projections contain managed root IDs, backend↔Chrome mappings, cursor, health/status, exclusions, and convergence journal state. State writes are serialized through a mutation queue.

## Managed tree

```text
URLises /
└── Organization /
    └── Workspace /
        ├── folders
        └── bookmarks
```

Nodes outside this path remain personal browser data. If `URLises` does not exist, an exact legacy `Shared Bookmarks` root may be renamed in place. If both exist, the extension does not merge or delete them.

## Reconciliation rules

1. Bootstrap from the canonical workspace tree.
2. Reuse a Chrome node only when identity is unambiguous.
3. Persist mappings before dependent effects need them.
4. Apply remote effects without re-emitting them as local mutations.
5. Persist cursor advancement only after the effect completes.
6. If a mapped parent/node disappears or an operation is ambiguous, recover/replay instead of guessing.
7. Rebuild the nearest recoverable subtree or full workspace when required.

Viewer exclusions are local presentation state. They survive canonical updates and are pruned when the canonical node is deleted.

## Build and package

```bash
cd extension
npm ci
npm run typecheck
npm run test:projection
npm run package
```

Packaging creates `extension/release/urlises-for-chrome-<manifest-version>.zip`, validates an explicit runtime allowlist, and prints a SHA-256 digest. It requires the system `zip` executable.

## Diagnostics

The options UI exposes workspace health, connection status, activity, errors, and manual resync. Healthy runtime stays quiet; replay-first recovery precedes a visible degraded state.
