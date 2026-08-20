# Installation and Local Environments

## Recommended: Docker Compose

```bash
docker network create dtf-netwok 2>/dev/null || true
docker compose up --build
```

The external network is required by the checked-in Compose files.

| Service | Host endpoint | Purpose |
| --- | --- | --- |
| PostgreSQL | `localhost:5433` | Persistent canonical database |
| Backend | `localhost:8081` | Go API |
| Admin web | dynamic loopback port | React SPA served by Nginx |
| Mailpit SMTP | `127.0.0.1:11025` | Local SMTP sink |
| Mailpit UI | `http://127.0.0.1:18025` | Inspect local mail |

Find the admin port with `docker compose port admin-web 80`. Migrations run automatically in the backend container. Development credentials must not be reused in production.

```bash
ADMIN_WEB_HOST_PORT=5173 MAILPIT_UI_HOST_PORT=18026 docker compose up --build
```

The repeatable smoke workflow is:

```bash
./scripts/test-poc.sh
```

## Manual backend

Requirements: Go 1.26+, PostgreSQL 15+, and a reachable database.

```bash
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/shared_bookmark_sync?sslmode=disable'
export SERVER_ADDR=':8080'
export AUTH_JWT_SECRET="$(openssl rand -hex 32)"
export DATABASE_AUTO_MIGRATE=true
cd backend
go run ./cmd/api
```

Running from `backend/` with the default `DATABASE_MIGRATIONS_DIR=migrations` is the simplest manual setup.

## Admin web development

```bash
cd admin-web
npm ci
VITE_API_BASE_URL=/api npm run dev
```

Vite proxies `/api` to `http://shared-bookmark-sync-backend:8080` by default. Override it when the backend is outside Compose:

```bash
VITE_API_PROXY_TARGET=http://localhost:8081 VITE_API_BASE_URL=/api npm run dev
```

## Chrome extension

```bash
cd extension
npm ci
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extension/`. Build output is `extension/dist/`. Configure the backend URL from the extension options page when the default does not match the local API.

## Environment reference

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | none | Required PostgreSQL URL; SQLite is unsupported |
| `AUTH_JWT_SECRET` | none | Required signing secret |
| `AUTH_TOKEN_TTL` | `24h` | Access-token lifetime |
| `AUTH_CLIENT_ID_HEADER` | `X-Client-Id` | Durable client binding header |
| `SERVER_ADDR` | `:8080` | API listen address |
| `DATABASE_AUTO_MIGRATE` | `true` | Run migrations at startup |
| `DATABASE_MIGRATIONS_DIR` | `migrations` | Migration directory under `APP_ROOT` |
| `APP_ROOT` | `.` | Runtime base path |
| `DATABASE_MAX_CONNS` / `DATABASE_MIN_CONNS` | `10` / `1` | PostgreSQL pool sizing |
| `MAIL_ENABLED` | `false` | SMTP adapter toggle; not a complete invitation workflow |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | `587` | SMTP endpoint |
| `MAIL_TLS_MODE` | `starttls` | `none`, `starttls`, or `tls` |
| `MAIL_AUTH_MODE` | `none` | `none` or `plain`; plain requires TLS and credentials |
| `MAIL_FROM_ADDRESS` | none | Required when mail is enabled |
| `PUBLIC_BASE_URL` | none | Absolute `http(s)` origin used to build invitation accept links; required when `MAIL_ENABLED=true` |
| `ADMIN_WEB_HOST_PORT` | dynamic | Compose host port for Nginx |
| `MAILPIT_SMTP_HOST_PORT` / `MAILPIT_UI_HOST_PORT` | `11025` / `18025` | Loopback-only Mailpit ports |

## Manual invitation email check

With `MAIL_ENABLED=true` and `PUBLIC_BASE_URL` set (both are the compose defaults), create an
organization invitation, open the received message at `http://127.0.0.1:18025` (Mailpit UI), and
follow the accept link with no existing account: register, and land as a member.

## Troubleshooting

- **Network error:** create `dtf-netwok` once with `docker network create dtf-netwok`.
- **API not ready:** inspect `docker compose logs backend postgres`; `/readyz` requires PostgreSQL.
- **Vite cannot reach API:** set `VITE_API_PROXY_TARGET` to a URL reachable from Vite.
- **Extension degraded:** confirm backend URL, sign-in/client ID, workspace grant, and WebSocket reachability; then resync.
- **Integration tests skip:** provide the database variable documented in [development](development.md).
