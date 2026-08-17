# URLises Architecture

## Executive summary

URLises is a backend-authoritative synchronization system. PostgreSQL stores users, organizations, workspaces, access grants, bookmark trees, and sync events. The Go service exposes REST and WebSocket contracts. The admin web application configures the control plane. The Chrome extension maintains a local projection for selected workspaces.

## System map

```text
                         +----------------------+
                         | URLises Control       |
                         | React + Vite + Nginx  |
                         +----------+-----------+
                                    | /api REST
                                    v
+-------------------+     +---------+----------+     +----------------------+
| Chrome MV3        | REST| Go HTTP API         | SQL | PostgreSQL            |
| popup/options/    +----> auth, control plane, +----> domain tables        |
| service worker    | WS  | bookmark sync, WS   |     | sync_events/cursors  |
+-------------------+     +---------+----------+     +----------------------+
                                    |
                                    v
                         +----------------------+
                         | SMTP adapter/Mailpit |
                         +----------------------+
```

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| `backend/cmd/api` | Process bootstrap, configuration, dependency wiring, graceful shutdown |
| `backend/internal/auth` | Registration, login, JWT validation, refresh/session state, durable client binding, WebSocket tickets |
| `backend/internal/access` | Organization-admin checks and effective workspace access resolution |
| `backend/internal/organizations` | Organizations, members, invitations |
| `backend/internal/groups` | Flat groups and group membership |
| `backend/internal/workspaces` | Workspace metadata, creation, tree reads, access grant management |
| `backend/internal/bookmarks` | Folder/bookmark models, validation, ordering, soft-delete operations |
| `backend/internal/sync` | Transactional mutation orchestration, event envelopes, replay, cursor contracts |
| `backend/internal/websocket` | Workspace subscriptions, authentication, origin suppression, event delivery |
| `backend/internal/database` | PostgreSQL connection and ordered migrations |
| `admin-web/src` | Operator shell and control-plane views |
| `extension/src` | Browser integration, projection, reconciliation, local state, UI |
| `backend/migrations` | Canonical schema evolution |

## Runtime boot sequence

`backend/cmd/api/main.go` loads environment configuration, opens PostgreSQL, optionally runs migrations, constructs access/auth/domain/sync/WebSocket services, registers routes, starts `/healthz` and `/readyz`, and performs graceful shutdown on SIGINT/SIGTERM.

## Authorization model

1. Authentication produces a principal containing user ID, email, and durable client ID.
2. Authenticated HTTP requests require `Authorization: Bearer <token>` and `X-Client-Id` by default.
3. Organization administration requires an owner/admin organization membership.
4. Workspace access is explicit; organization membership alone does not grant it.
5. Direct user grants and group grants are combined; the effective role is the highest matching role.
6. `admin` and `editor` may mutate shared bookmark meaning; `viewer` is read-only for canonical data.

## Canonical data and transactions

Shared folder/bookmark mutations write the domain change and its `sync_events` record in the same PostgreSQL transaction. Each workspace has a monotonic cursor in `workspace_cursors`. Duplicate client event IDs are idempotent and return the prior acknowledgement.

## Synchronization flow

### Local mutation

```text
Chrome event -> managed-root filter -> REST mutation
-> authorization/validation -> domain row + sync event + cursor transaction
-> WebSocket publish to same-workspace subscribers except origin client
```

### Remote mutation

```text
WebSocket event or replay -> extension convergence journal
-> backend-ID/Chrome-ID mapping -> Chrome effect
-> listener suppression -> durable cursor/state update
```

`GET /sync/events` is the recovery path. A replay gap or ambiguous projection causes controlled resynchronization/rebuild rather than guessing.

## Data model overview

Migrations define users/devices, organizations/members, invitations, groups/members, workspaces, direct and group access, folders, bookmarks, sync events, workspace cursors, refresh sessions, WebSocket tickets, and idempotency records. Folders and bookmarks use stable backend UUIDs, parent relationships, and sibling positions. Deletion is soft-delete oriented.

## Trust boundaries

- PostgreSQL is authoritative; local Chrome storage is disposable projection state.
- WebSocket authentication supports short-lived tickets and a compatibility token/client-ID path.
- Compose credentials are development-only.
- Mailpit is local-only and invitation email acceptance is not currently a complete production workflow.
- Nginx serves the admin SPA and proxies `/api` to the backend.
