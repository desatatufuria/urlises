# API Reference

## Base URL

Compose exposes the API at `http://localhost:8081`. The admin UI uses `/api` through Nginx/Vite proxying.

## Authentication

Registration and login require a durable client identifier. The default header is `X-Client-Id`; it can be changed with `AUTH_CLIENT_ID_HEADER`.

```http
Authorization: Bearer <jwt>
X-Client-Id: <durable-client-id>
```

The client ID is bound to the user/device session. A token without the matching client identifier is not accepted.

## Endpoint groups

### Auth

```text
POST /auth/register
POST /auth/login
GET  /me
```

### Organizations and invitations

```text
GET   /organizations
POST  /organizations
GET   /organizations/{organizationId}/members
PATCH /organizations/{organizationId}/members
POST  /organizations/{organizationId}/invitations
POST  /invitations/{token}/accept
```

The first organization creator becomes owner. Administration requires owner/admin organization membership.

### Groups

```text
GET    /organizations/{organizationId}/groups
POST   /organizations/{organizationId}/groups
PATCH  /organizations/{organizationId}/groups/{groupId}
DELETE /organizations/{organizationId}/groups/{groupId}
POST   /groups/{groupId}/members
DELETE /groups/{groupId}/members/{userId}
```

### Workspaces and access

```text
GET    /organizations/{organizationId}/workspaces
POST   /organizations/{organizationId}/workspaces
GET    /workspaces/{workspaceId}
GET    /workspaces/{workspaceId}/tree
PUT    /workspaces/{workspaceId}/users/{userId}/access
DELETE /workspaces/{workspaceId}/users/{userId}/access
PUT    /workspaces/{workspaceId}/groups/{groupId}/access
DELETE /workspaces/{workspaceId}/groups/{groupId}/access
```

Access is the highest role across direct and group grants. New workspaces grant only the creator as `admin`.

### Shared bookmark data

```text
POST   /workspaces/{workspaceId}/folders
PATCH  /folders/{folderId}
DELETE /folders/{folderId}
POST   /workspaces/{workspaceId}/bookmarks
PATCH  /bookmarks/{bookmarkId}
DELETE /bookmarks/{bookmarkId}
```

Only `admin` and `editor` may mutate shared data. URLs are validated and sibling ordering is backend-managed.

## Idempotency and cursors

```http
X-Sync-Event-Id: <client-generated-event-id>
X-Sync-Base-Cursor: <last-applied-workspace-cursor>
```

Successful mutations return `X-Sync-Event-Id`, `X-Sync-Cursor`, and `X-Sync-Duplicate`. Reusing an event ID returns the previous acknowledgement without a second mutation.

## Replay

```text
GET /sync/events?workspaceId={id}&afterCursor={n}
```

The response contains ordered envelopes after the supplied cursor. An unreplayable gap is a resynchronization condition; clients must rebuild from the canonical tree.

## WebSocket

```text
GET /sync/ws?workspaceId={id}&accessToken={jwt}&clientId={durable-client-id}
```

The extension uses the short-lived `sbs-ticket.<ticket>` subprotocol. The server verifies workspace access, sends an `ack` with the current cursor, and emits `event` messages for same-workspace events from other clients. The origin client is excluded.

## Health

```text
GET /healthz
GET /readyz
```

`/healthz` is liveness; `/readyz` requires a PostgreSQL ping.
