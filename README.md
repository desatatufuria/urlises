# URLises

URLises is a multi-workspace bookmark synchronization platform. A Go API backed by PostgreSQL is the canonical source of truth; the Manifest V3 Chrome extension projects selected workspaces into each browser; and URLises Control manages organizations, members, groups, workspaces, and access grants.

## Quick path

1. Install Docker and Docker Compose, then create the external `dtf-netwok` network if needed:

   ```bash
   docker network create dtf-netwok 2>/dev/null || true
   ```

2. Start the complete local stack:

   ```bash
   docker compose up --build
   ```

3. Open the admin UI at the port reported by `docker compose port admin-web 80`.
4. Complete first-run registration and organization setup, then create a workspace and grants.
5. Build and load the extension as an unpacked extension; configure the backend URL, sign in, and select workspaces.

Start with [installation](docs/installation.md), then follow [the user workflows](docs/usage.md).

## Documentation map

| Document | Purpose |
| --- | --- |
| [Architecture](docs/architecture.md) | Components, boundaries, data flow, authorization, persistence, and synchronization |
| [Installation](docs/installation.md) | Docker, manual backend, admin-web, extension, variables, and troubleshooting |
| [Usage](docs/usage.md) | First-run setup, operator workflows, extension workflows, and CLI examples |
| [API reference](docs/api.md) | Authentication, endpoints, sync contracts, and response headers |
| [Extension guide](docs/extension.md) | MV3 lifecycle, projection, exclusions, recovery, and packaging |
| [Development and verification](docs/development.md) | Repository layout, commands, tests, database checks, and release hygiene |
| [Roadmap](docs/roadmap.md) | Delivery history, scope, remaining manual validation, and product direction |
| [Original requirements](docs/requeriments.md) | Initial product requirements and MVP constraints |

## What is implemented

- JWT authentication with durable browser/client binding.
- Organization membership, invitations, groups, explicit workspace grants, and highest-role-wins resolution.
- Canonical folder/bookmark CRUD with URL validation, role gates, soft deletion, and deterministic sibling ordering.
- Transactional sync events, per-workspace cursors, replay-gap detection, idempotent mutations, and WebSocket fan-out with origin suppression.
- React/TanStack Query operator UI for members, invitations, groups, workspaces, and access review.
- MV3 extension login, workspace selection, managed-root projection, replay, WebSocket subscription, local viewer exclusions, diagnostics, and resynchronization.
- Docker Compose development stack with PostgreSQL, API, admin UI, and Mailpit.

## Architecture at a glance

```text
Chrome extension  <-- REST + WebSocket -->  Go API  <-- SQL/transactions --> PostgreSQL
       ^                                      |
       |                                      +--> Mailpit/SMTP adapter
       |
Admin web  ---------- REST through Nginx --+
```

The backend owns shared meaning. Chrome bookmark trees are projections and must never be treated as authoritative. See [the architecture map](docs/architecture.md).

## Prerequisites

- Docker Engine and Docker Compose for the recommended path.
- Go 1.26+ for backend development.
- Node.js 20+ and npm for admin-web and extension tooling.
- PostgreSQL 15+ when running the API outside Compose.
- Chrome/Chromium with Developer Mode for unpacked extension validation.

## Local verification

```bash
(cd backend && go test ./... && go build ./cmd/api)
(cd admin-web && npm run typecheck && npm run test && npm run build)
(cd extension && npm run typecheck && npm run test:projection && npm run package)
git diff --check
```

Database-backed tests are environment-gated; see [development and verification](docs/development.md).

## Scope boundaries

The current product does not implement billing, SSO, analytics, cross-browser support, offline-first CRDT conflict resolution, or full personal-bookmark import. The admin UI deliberately does not edit bookmark content.
