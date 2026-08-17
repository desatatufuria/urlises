# Development and Verification

## Repository map

```text
backend/        Go API, internal domains, migrations, tests
admin-web/      React/Vite operator UI and frontend tests
extension/      TypeScript MV3 client, tests, release packaging
scripts/        POC, seed, invitation, API and DB-contract helpers
docs/           Product, architecture, installation, and usage documentation
openspec/       Historical/specification workflow artifacts
.devcontainer/  Development container and Docker networking setup
docker-compose.yml  Local PostgreSQL/API/admin/Mailpit stack
```

## Backend

```bash
cd backend
go test ./...
go build ./cmd/api
go vet ./...
```

Coverage spans auth, access, organizations, groups, workspaces, bookmarks, HTTP idempotency, sync replay, WebSockets, migrations, and mail adapters. PostgreSQL-backed tests require their package-specific database variable.

## Admin web

```bash
cd admin-web
npm ci
npm run typecheck
npm run test
npm run build
```

Vitest/jsdom coverage focuses on guarded routes, session/setup states, members, groups, workspaces, invitations, and effective access display.

## Extension

```bash
cd extension
npm ci
npm run typecheck
npm run test:projection
npm run package
```

`test:projection` rebuilds first and runs Node's test runner with a fake Chrome harness.

## Database-backed contracts

```bash
./scripts/test-organizations.sh

ADMIN_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:5433/shared_bookmark_sync?sslmode=disable' \
  ./scripts/verify-admin-db-contracts.sh
```

The stricter gate refuses success when tests skip, named markers are missing, or Go fails; it withholds output to avoid leaking credentials.

## POC verification

```bash
./scripts/test-poc.sh
docker compose logs --tail=100 postgres backend admin-web mailpit
```

## Change hygiene

Update the nearest detailed document and the README map when behavior changes. Separate automated evidence, manual evidence, and known gaps. Before review:

```bash
git diff --check
git status --short
```

Do not commit generated dependencies or local session files. Existing untracked `.docmanager/` and root `package-lock.json` are preserved unless explicitly addressed.

## Known verification limits

- Integration tests require a live PostgreSQL instance and are environment-gated.
- Browser/manual checks are not equivalent to automated tests.
- Chromium validation may be separate from default Node tests and must be recorded explicitly.
- Invitation email delivery and acceptance are not yet a complete production flow.
- Compose uses development secrets and local network assumptions.
