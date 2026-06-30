# Shared Bookmark Sync MVP

Shared Bookmark Sync is a greenfield MVP that keeps organization and workspace bookmark trees consistent across Chrome clients while treating the Go backend as the canonical source of truth.

## Current Slice

This repository is currently on **Work Unit 1 / PR 1** of a chained Gitflow delivery plan:

- backend bootstrap
- PostgreSQL-only schema foundation
- baseline documentation for review slices and roadmap

Auth, domain APIs, sync replay, and extension code are intentionally deferred to later slices.

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
export DATABASE_AUTO_MIGRATE=true

cd backend
go run ./cmd/api
```

Available endpoints in this slice:

- `GET /healthz`
- `GET /readyz`

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | – | PostgreSQL connection string. SQLite is not supported. |
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
