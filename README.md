# Shared Bookmark Sync MVP

Shared Bookmark Sync is a greenfield MVP that keeps organization and workspace bookmark trees consistent across Chrome clients while treating the Go backend as the canonical source of truth.

## Current Slice

This repository is currently on **Work Unit 2 / PR 2** of a chained Gitflow delivery plan:

- auth, durable client bindings, and JWT-protected session reads
- organization/workspace membership reads and canonical workspace tree reads
- folder/bookmark shared CRUD with role gates, ordering, URL validation, and soft delete

Sync replay, websocket fan-out, and a minimal local backend + PostgreSQL Compose stack are the next slice; extension code remains deferred until after that backend exercise step.

## Architecture Baseline

- **Backend**: Go HTTP service
- **Database**: PostgreSQL only
- **Persistence model**: relational domain tables plus transactional `sync_events`
- **Source of truth**: backend domain state, never the local Chrome tree

## Repository Layout

```text
backend/
  cmd/api/               API bootstrap and health endpoints
  internal/config/       environment-driven application configuration
  internal/database/     PostgreSQL connection and migration runner
  internal/auth/         register/login/me, JWT middleware, durable client bindings
  internal/organizations/ organization membership reads
  internal/workspaces/   workspace access and canonical tree reads
  internal/bookmarks/    shared folder/bookmark commands and sibling ordering
  migrations/            SQL schema files for canonical backend state
docs/
  requeriments.md        original product requirements
  roadmap.md             chained MVP delivery roadmap
openspec/
  changes/shared-bookmark-sync-mvp/
```

## Prerequisites

- Go 1.26+
- PostgreSQL 15+

## Local Bootstrap

1. Create a PostgreSQL database for the project.
2. Export the required environment variables.
3. Run the backend from the `backend/` directory.

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/shared_bookmark_sync?sslmode=disable"
export SERVER_ADDR=":8080"
export AUTH_JWT_SECRET="replace-me-with-a-long-random-secret"
export DATABASE_AUTO_MIGRATE=true

cd backend
go run ./cmd/api
```

Available endpoints in this slice:

- `POST /auth/register`
- `POST /auth/login`
- `GET /me`
- `GET /organizations`
- `GET /organizations/{organizationId}/workspaces`
- `GET /workspaces/{workspaceId}`
- `GET /workspaces/{workspaceId}/tree`
- `POST /workspaces/{workspaceId}/folders`
- `PATCH /folders/{folderId}`
- `DELETE /folders/{folderId}`
- `POST /workspaces/{workspaceId}/bookmarks`
- `PATCH /bookmarks/{bookmarkId}`
- `DELETE /bookmarks/{bookmarkId}`
- `GET /healthz`
- `GET /readyz`

Authenticated routes require:

- `Authorization: Bearer <token>`
- `X-Client-Id: <durable-browser-client-id>`

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | – | PostgreSQL connection string. SQLite is not supported. |
| `AUTH_JWT_SECRET` | Yes | – | HMAC secret used to sign access tokens. |
| `AUTH_TOKEN_TTL` | No | `24h` | JWT expiry duration for API sessions. |
| `AUTH_CLIENT_ID_HEADER` | No | `X-Client-Id` | Header name used for durable client binding. |
| `SERVER_ADDR` | No | `:8080` | API listen address. |
| `DATABASE_MAX_CONNS` | No | `10` | Max PostgreSQL pool connections. |
| `DATABASE_MIN_CONNS` | No | `1` | Min PostgreSQL pool connections. |
| `DATABASE_AUTO_MIGRATE` | No | `true` | Run SQL migrations on startup. |
| `DATABASE_MIGRATIONS_DIR` | No | `migrations` | Relative migrations directory from `APP_ROOT`. |
| `APP_ROOT` | No | `.` | Base path used to resolve migrations. |

## Verification Commands for This Slice

From `backend/`:

```bash
go test ./...
go build ./cmd/api
```

These commands validate compilation only. There is no automated integration or end-to-end runner in the repository yet.

## Canonical Domain Rules in This Slice

- The backend is the only source of truth for shared organizations, workspaces, folders, and bookmarks.
- Only `admin` and `editor` workspace members can mutate shared folder/bookmark state.
- `viewer` members can read workspace trees but cannot change shared semantics.
- `GET /workspaces/{workspaceId}/tree` returns stable backend IDs, parent links, and sibling order.
- Folder and bookmark deletes are soft deletes; sibling positions are re-packed after create, move, update, and delete operations.

## Gitflow and Chained Delivery

This change follows **Gitflow** with a dedicated tracker branch:

- Tracker branch: `feature/shared-bookmark-sync-mvp`
- Delivery model: `feature-branch-chain`
- PR 1 base: `feature/shared-bookmark-sync-mvp`
- PR 2+ base: the previous PR branch in the chain

Each work unit must stay reviewable, self-contained, and documented. Documentation updates ship with the same slice that introduces the behavior.

## Review Slice Policy

- Keep each PR focused on one work unit.
- Do not start the next work unit in the same branch.
- Include relevant docs updates in the same slice.
- Prefer compile/build verification when full test infrastructure does not exist yet.

See `docs/roadmap.md` for the five planned slices and their acceptance checkpoints.
