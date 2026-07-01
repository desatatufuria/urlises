# Design: Shared Bookmark Sync MVP

## Technical Approach

Build a modular Go backend as the canonical source of truth in PostgreSQL, then project selected workspaces into a Manifest V3 Chrome extension. This follows the proposal/spec direction: relational domain tables for shared state, transactional `sync_events` for delivery/audit, snapshot bootstrap from `GET /workspaces/:workspaceId/tree`, and incremental replay over REST/WebSocket using a monotonic workspace cursor. The extension manages only `Shared Bookmarks / Organization / Workspace` paths: one organization folder per accessible organization under `Shared Bookmarks`, and one workspace subtree per selected workspace under its organization.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Canonical persistence | PostgreSQL vs SQLite vs event sourcing | PostgreSQL domain tables + `sync_events` | Preserves hard constraint, supports transactions/locking/indexes, and avoids MVP complexity of full event sourcing. |
| Ordering contract | `eventId` only vs timestamp vs cursor | Per-workspace monotonic `cursor` plus `eventId` idempotency | `eventId` dedups, but cursor guarantees replay/apply order for move/delete/update correctness. |
| Extension write policy | Trust local edits vs backend validation | Backend validates every shared mutation; extension reconciles rejected edits | Chrome cannot enforce read-only. Authority must stay server-side. |
| Viewer hide semantics | Shared delete vs local override | Local exclusions in `chrome.storage.local` only | Keeps shared meaning unchanged while letting viewers hide noisy branches. |

## Data Flow

```text
Chrome popup/options ──JWT login──> Backend auth
Service worker ──workspace snapshot──> GET /workspaces/:id/tree
Service worker ──subscribe/replay──> WS /sync/ws + GET /sync/events
Backend command ──tx──> PostgreSQL domain tables + sync_events + workspace cursor
Backend fan-out ──ordered events──> other workspace clients
Extension applier ──projection──> Chrome bookmarks subtree
```

Sync sequence:

```text
Local admin/editor change
  -> extension creates command {eventId, originClientId, baseCursor}
  -> backend authenticates, checks role, writes domain mutation + sync_event in one tx
  -> tx assigns next workspace cursor N
  -> backend ACKs origin, broadcasts event(cursor=N) to other clients
  -> receivers apply only if cursor == lastApplied+1 else trigger replay/resync
```

Reconnect: client loads last applied cursor per workspace, reopens WS with JWT, replays missing events via `GET /sync/events?workspaceId=&afterCursor=` or receives `resync_required` when retention/gap prevents contiguous recovery.

Failure/recovery rules: duplicate `eventId` returns prior ACK without a second mutation; stale/missing local mappings trigger subtree rebuild from snapshot; viewer or unauthorized local edits are reverted by fetching canonical state for the affected subtree and restoring Chrome nodes while preserving local exclusions by backend node ID. Selecting multiple workspaces projects multiple sibling workspace folders under their organization folders; deselecting a workspace removes only that projected workspace subtree and keeps other selected workspaces intact.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/cmd/api/main.go` | Create | HTTP/WS bootstrap, dependency wiring. |
| `backend/internal/auth/*` | Create | JWT login/register/me and auth middleware. |
| `backend/internal/database/*` | Create | PostgreSQL pool, migrations runner, tx helpers. |
| `backend/internal/organizations/*` | Create | Organization CRUD/membership reads. |
| `backend/internal/workspaces/*` | Create | Workspace access, tree query, workspace membership. |
| `backend/internal/bookmarks/*` | Create | Folder/bookmark commands, ordering, soft delete rules. |
| `backend/internal/sync/*` | Create | Event log, cursor assignment, replay API, idempotency. |
| `backend/internal/websocket/*` | Create | Workspace connection registry and ordered fan-out. |
| `backend/migrations/*.sql` | Create | PostgreSQL schema for domain tables, `devices`, `sync_events`, cursor columns/indexes. |
| `extension/src/background/*` | Create | Service worker, bookmark listeners, replay/apply engine. |
| `extension/src/popup/*` | Create | Login/session bootstrap UX. |
| `extension/src/options/*` | Create | Workspace selection, resync controls, diagnostics. |
| `extension/src/shared/*` | Create | REST/WS client, types, auth/session storage, mapping/exclusion helpers. |
| `docs/requeriments.md` | Modify | Align on cursor contract, JWT extension auth, PostgreSQL-only persistence, exclusion semantics. |
| `README.md` | Create | Setup, Gitflow branch intent, chained work-unit delivery guidance. |

## Interfaces / Contracts

```go
type SyncEnvelope struct {
  Cursor int64
  EventID string
  WorkspaceID string
  OriginClientID string
  Kind string
  EntityType string
  EntityID string
  Payload json.RawMessage
}
```

```ts
type LocalProjectionState = {
  session: { accessToken: string; clientId: string };
  lastCursorByWorkspace: Record<string, number>;
  chromeIdByBackendId: Record<string, string>;
  excludedNodeIdsByWorkspace: Record<string, string[]>;
};
```

- `POST /auth/login` returns backend-issued JWT and durable `clientId` binding.
- `GET /workspaces/:workspaceId/tree` returns canonical tree snapshot with stable backend IDs and sibling order.
- `GET /sync/events?...afterCursor=` returns ordered contiguous events.
- `WS /sync/ws?workspaceId=` accepts auth, sends `event`, `ack`, `resync_required`.
- The extension MUST ignore bookmark events outside `Shared Bookmarks / Organization / Workspace`; it may reuse existing managed organization/workspace folders by stable mapping, but it must not project one workspace into another workspace's subtree.
- Exclusions are stored only in extension local storage keyed by `workspaceId + backendNodeId`; rename/move keeps the exclusion, canonical delete prunes it.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Role checks, ordering, idempotency, exclusion merge rules | Go table tests; TS pure-state tests. |
| Integration | PostgreSQL tx writes, replay queries, WS fan-out | Backend tests against real Postgres container. |
| E2E | Login, snapshot bootstrap, reconnect replay, unauthorized local edit restore | Chromium-based extension flow once tooling lands. |

## Migration / Rollout

No data migration required. Roll out behind a feature branch `feature/shared-bookmark-sync-mvp` with chained Gitflow work units: backend foundation -> domain/tree -> sync engine -> extension projection -> docs/hardening. Each slice must ship its documentation updates.

## Open Questions

- [ ] Cursor retention window: keep all MVP events or prune with mandatory resync threshold?
- [ ] Should viewer unauthorized local edits show a notification immediately or only self-heal silently?
