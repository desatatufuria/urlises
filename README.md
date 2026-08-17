# Shared Bookmark Sync MVP

Shared Bookmark Sync is a greenfield MVP that keeps organization and workspace bookmark trees consistent across Chrome clients while treating the Go backend as the canonical source of truth.

## Admin Control Plane Delivery

This repository now carries both admin control-plane tracks:

- explicit organization, invitation, group, workspace, and workspace-grant control-plane routes
- shared `internal/access` resolution for effective workspace roles across direct and group grants
- runtime-compatible workspace reads backed by the new access model
- bookmark write guards enforced through effective shared access instead of legacy `workspace_members` reads
- `admin-web/` React operator UI with Members, Invitations, Groups, Workspaces, and Access routes only
- focused frontend coverage for route guards, invite flows, workspace creation, and highest-role-wins access review

## Current Product Baseline

This repository now includes:

- auth, durable client bindings, and JWT-protected session reads
- organization/workspace membership reads and canonical workspace tree reads
- folder/bookmark shared CRUD with role gates, ordering, URL validation, and soft delete
- transactional sync-event writes, per-workspace cursors, replay endpoint, and websocket fan-out with origin suppression
- minimal local backend + PostgreSQL Compose bring-up
- Manifest V3 extension login, workspace selection, managed projection, cursor replay, websocket subscription, viewer-local exclusions, and resync diagnostics
- premium popup/options/status surfaces with shared dark-theme tokens, online presence, and blue fresh-activity indicators

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
extension/
  manifest.json          MV3 shell pointing to popup/options UI and background service worker
  src/background/        bookmark listeners, projection sync engine, Chrome bookmark applier
  src/popup/             sign-in UI for JWT session bootstrap
  src/options/           workspace selection, resync-all, diagnostics
  src/shared/            REST/WS clients, session storage, mappings, exclusions, runtime types
admin-web/
  src/app/               guarded operator shell and route wiring
  src/features/          members, invitations, groups, workspaces, and access pages
  src/lib/               typed API client and local UI primitives
```

## Prerequisites

- Go 1.26+
- PostgreSQL 15+

## One-command POC test

Run `./scripts/test-poc.sh` to start the complete local stack, verify the admin UI and its API proxy, create a test user and organization, and run the Mailpit smoke test. The script creates the required shared Docker network (`dtf-netwok`) when absent and prints the assigned admin UI URL. Reusable local session details are written to `/tmp/shared-bookmark-sync-poc-session.env` with mode `600`.

On an empty database, opening Admin Web starts a one-time owner setup: create the first account, then create its organization. The account becomes organization owner. No default administrator password is embedded in the image. Existing installations go directly to sign-in.

## Local Bootstrap

1. Create a PostgreSQL database for the project.
2. Export the required environment variables.
3. Run the backend from the `backend/` directory, or use the minimal Compose stack.

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
- `POST /organizations`
- `GET /organizations/{organizationId}/members`
- `PATCH /organizations/{organizationId}/members`
- `POST /organizations/{organizationId}/invitations`
- `POST /invitations/{token}/accept`
- `GET /organizations/{organizationId}/groups`
- `POST /organizations/{organizationId}/groups`
- `PATCH /organizations/{organizationId}/groups/{groupId}`
- `DELETE /organizations/{organizationId}/groups/{groupId}`
- `POST /groups/{groupId}/members`
- `DELETE /groups/{groupId}/members/{userId}`
- `GET /organizations/{organizationId}/workspaces`
- `POST /organizations/{organizationId}/workspaces`
- `GET /workspaces/{workspaceId}`
- `GET /workspaces/{workspaceId}/tree`
- `PUT /workspaces/{workspaceId}/users/{userId}/access`
- `DELETE /workspaces/{workspaceId}/users/{userId}/access`
- `PUT /workspaces/{workspaceId}/groups/{groupId}/access`
- `DELETE /workspaces/{workspaceId}/groups/{groupId}/access`
- `POST /workspaces/{workspaceId}/folders`
- `PATCH /folders/{folderId}`
- `DELETE /folders/{folderId}`
- `POST /workspaces/{workspaceId}/bookmarks`
- `PATCH /bookmarks/{bookmarkId}`
- `DELETE /bookmarks/{bookmarkId}`
- `GET /sync/events?workspaceId=<id>&afterCursor=<n>`
- `GET /sync/ws?workspaceId=<id>&accessToken=<jwt>&clientId=<durable-client-id>`
- `GET /healthz`
- `GET /readyz`

Authenticated routes require:

- `Authorization: Bearer <token>`
- `X-Client-Id: <durable-browser-client-id>`

Local admin-web development from `http://localhost:5173` or `http://127.0.0.1:5173` is CORS-enabled on the backend, including preflight handling for `Content-Type`, `Authorization`, `X-Client-Id`, `X-Sync-Event-Id`, and `X-Sync-Base-Cursor`.

Shared mutation routes also accept:

- `X-Sync-Event-Id: <client-generated-id>` for idempotent mutation retries
- `X-Sync-Base-Cursor: <last-applied-cursor>` for client replay context

Successful shared mutations return:

- `X-Sync-Event-Id`
- `X-Sync-Cursor`
- `X-Sync-Duplicate`

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
| `MAIL_ENABLED` | No | `false` | Enables SMTP delivery for a future workflow; startup never connects to SMTP. |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | When enabled | `587` | SMTP server host and port. |
| `MAIL_TIMEOUT` | No | `10s` | Upper bound for one SMTP operation. |
| `MAIL_TLS_MODE` | No | `starttls` | `none`, `starttls`, or `tls`. |
| `MAIL_AUTH_MODE` | No | `none` | `none` or `plain`; `plain` requires TLS and both credentials. |
| `MAIL_USERNAME` / `MAIL_PASSWORD` | With `plain` | – | SMTP credentials. `none` ignores them. |
| `MAIL_FROM_ADDRESS` / `MAIL_FROM_DISPLAY_NAME` | When enabled | – | Verified platform sender identity. |
| `MAIL_REPLY_TO` | When enabled | – | Global Reply-To fallback. |

Mail delivery is deliberately not wired to invitations or any other workflow in this POC. Keep production credentials in deployment secrets. `plain` authentication is rejected without TLS; use `starttls` or `tls` in production.

Compose starts Mailpit for local inspection. Its SMTP and UI ports are host-loopback only: `127.0.0.1:11025` and `http://127.0.0.1:18025` by default. Set `MAILPIT_SMTP_HOST_PORT` or `MAILPIT_UI_HOST_PORT` before Compose starts to use alternate host-loopback ports. The backend still waits only for PostgreSQL.

## Local Container Networking

| Caller | PostgreSQL | Backend | Mailpit SMTP / UI |
| --- | --- | --- | --- |
| Host | `127.0.0.1:5433` | `127.0.0.1:8081` | `127.0.0.1:11025` / `http://127.0.0.1:18025` |
| Devcontainer | `shared-bookmark-sync-postgres:5432` | `shared-bookmark-sync-backend:8080` | `shared-bookmark-sync-mailpit:1025` / `http://shared-bookmark-sync-mailpit:8025` |

The project services join their private Compose network and the external `dtf-netwok` network used by the devcontainer. Use the unique container DNS names from the devcontainer; internal backend service names (`postgres`, `mailpit`) remain unchanged. Mailpit is intentionally not exposed to the external LAN.

The devcontainer receives the Docker socket group through `DOCKER_SOCKET_GID` (default `986`). If the host socket uses another group, run this before rebuilding the devcontainer:

```bash
export DOCKER_SOCKET_GID="$(stat -c %g /var/run/docker.sock)"
```

## Verification Commands

From `backend/`:

```bash
go test ./...
go build ./cmd/api
MAILPIT_SMOKE_TEST=1 MAILPIT_SMOKE_ADDR=shared-bookmark-sync-mailpit:1025 go test ./internal/mailer -run TestMailpitSmoke
# From the host instead: MAILPIT_SMOKE_ADDR=127.0.0.1:11025
```

These commands validate compilation and the current unit-style test coverage. PostgreSQL-backed integration tests also exist for selected admin/backend flows, but they require explicit database environment variables.

From `extension/`:

```bash
npm install
npm run build
npm run typecheck
npm run test:projection
```

From `admin-web/`:

```bash
npm run typecheck
npm run test
npm run build
```

The extension build emits the service worker, popup script, and options script into `extension/dist/`.

Current automated extension coverage for this slice focuses on:

- managed-root projection filtering for local-only exclusions
- descendant exclusion cleanup after canonical folder deletion
- exclusion pruning during snapshot-driven reconciliation
- duplicate-safe remote node reuse before create/rebuild
- legacy projection-state hydration for live-sync health metadata
- premium UI status helpers plus activity seen/unseen state transitions

Current automated backend coverage for this slice focuses on:

- contiguous resume replay acceptance
- replay-gap resync detection
- duplicate mutation ACK header behavior
- websocket broadcast exclusion for the origin client
- workspace creator-only default admin grants
- highest-role-wins recalculation across direct and group workspace access
- bookmark mutation guards resolved through shared access grants

Current automated admin-web coverage for this slice focuses on:

- auth route guard and non-admin blocking
- calm empty/error states for people, groups, and workspaces
- invite success plus backend role-rejection recovery
- workspace creation refresh
- workspace access direct/group grant review and highest-role-wins display

PostgreSQL-backed integration tests remain environment-gated and require one of:

- `WORKSPACES_TEST_DATABASE_URL`
- `GROUPS_TEST_DATABASE_URL`
- `BOOKMARKS_TEST_DATABASE_URL`
- `DATABASE_URL`

For the admin backend invitation flow specifically, this helper runs the organization integration tests against the local Docker PostgreSQL instance from the devcontainer/host setup:

```bash
./scripts/test-organizations.sh
```

## Minimal Docker Compose Bring-up

From the repository root:

```bash
docker compose up --build
```

This starts:

- PostgreSQL on `localhost:5433`
- the Go backend on `localhost:8081`
- the admin web UI on a free loopback port reported by `docker compose port admin-web 80`
- Mailpit on `http://127.0.0.1:18025` (override with `MAILPIT_UI_HOST_PORT`)

The backend and admin web containers are built from their Dockerfiles and start without source bind mounts. Nginx serves the admin SPA and proxies `/api` to the backend over the Compose network, avoiding devcontainer-to-host Docker mount mismatches.

Set `ADMIN_WEB_HOST_PORT` before `docker compose up --build` when a stable host port is required.

## Sync Guarantees in This Slice

- Shared folder/bookmark mutations write canonical data and `sync_events` in the same PostgreSQL transaction.
- Each workspace receives a monotonic `cursor` sequence through `workspace_cursors`.
- `GET /sync/events` returns only events after the caller's cursor and rejects replay gaps with `resync_required` semantics.
- Duplicate `X-Sync-Event-Id` values return the prior ACK without producing a second shared mutation.
- WebSocket fan-out excludes the origin client and broadcasts only to other subscribers on the same workspace.
- The extension projects only `Shared Bookmarks / Organization / Workspace` and ignores everything outside that managed path.
- Viewer-local exclusions stay in `chrome.storage.local`, survive remote updates, and do not mutate canonical backend data.

## Extension Bring-up for This Slice

1. Start the backend and PostgreSQL stack.
2. Build the extension from `extension/`.
3. Open `chrome://extensions`, enable Developer Mode, and load `extension/` as an unpacked extension.
4. Sign in from the popup, open Options, select accessible workspaces, and use `Resync all selected workspaces` when diagnostics indicate replay or reconciliation drift.
5. Premium UI validation remains extension-only: popup/options must show the shared dark theme, stronger hierarchy, a calm online indicator, and a blue activity dot that clears after the status view is shown.

## Operator Script for Remote Folder/Bookmark Creation

Use the repo-local script below when you need repeatable backend mutations during live-sync debugging without retyping raw `curl` commands.

```bash
# Store a reusable session file (defaults to /tmp/shared-bookmark-sync-session.json)
node scripts/remote-bookmarks.mjs login \
  --backend-url http://localhost:8081 \
  --email you@example.com \
  --password secret

# Create a remote folder
node scripts/remote-bookmarks.mjs create-folder \
  --workspace-id workspace-1 \
  --name "Debug Folder" \
  --parent-id folder-parent \
  --position 0

# Create a remote bookmark
node scripts/remote-bookmarks.mjs create-bookmark \
  --workspace-id workspace-1 \
  --folder-id folder-parent \
  --title "Debug Bookmark" \
  --url https://example.com/debug \
  --position 0

# Inspect the canonical workspace tree
node scripts/remote-bookmarks.mjs get-tree \
  --workspace-id workspace-1

# Replay sync events after a known cursor
node scripts/remote-bookmarks.mjs replay \
  --workspace-id workspace-1 \
  --after-cursor 42

# Listen to raw websocket sync messages until interrupted
node scripts/remote-bookmarks.mjs listen-ws \
  --workspace-id workspace-1
```

Notes:

- Pass `--session-file <path>` if you do not want to use the default `/tmp` session file.
- Pass `--base-cursor <n>` when you want mutation requests to reflect a known extension cursor during repro runs.
- Successful create commands print both the created resource JSON and the sync ACK headers (`eventId`, `cursor`, `duplicate`).

## Extension Live Sync Remediation

- Healthy live sync now resumes from the stored cursor instead of forcing a full workspace rebuild before every websocket connection.
- Replay remains the first recovery path for cursor catch-up and reconnect continuity; full snapshot resync is reserved for replay gaps, stale mapping repair, or explicit recovery fallback.
- The options page stays quiet during healthy sync and shows a visible degraded message only after the extension exhausts its bounded silent recovery budget.
- Before creating a managed folder or bookmark from a remote event, the extension reconciles stale mappings against the expected Chrome parent subtree to avoid duplicate Chrome nodes for one canonical backend node.
- Manual Chromium validation has confirmed remote folder create, remote bookmark create, websocket delivery, and replay behavior on the current branch.

## Extension Missing-Parent Recovery Follow-up

- This Gitflow follow-up stays extension-first on `feature/shared-bookmark-sync-wu4-extension` and fixes only destructive delete/move cascade recovery; it does NOT broaden into generic Work Unit 5 hardening.
- Remote folder/bookmark create, update, move, and delete now validate the expected parent path plus mapped Chrome node before apply continues.
- When validation fails, the extension prunes the affected subtree mappings first, rebuilds the nearest recoverable managed subtree, replays from the last trusted cursor, and falls back to workspace resync only if that subtree repair cannot restore the canonical path.
- Repeated local delete/move `404` or missing-parent failures are abandoned after recovery starts so the same stale mutation does not loop indefinitely.
- Descendant mappings and local exclusions are pruned deterministically when canonical folder/bookmark deletes invalidate stale subtree state.

Manual Chromium validation for this follow-up:

1. Delete nested managed folders while another client is moving children inside the same subtree.
2. Confirm remote create/move/delete waits for the canonical parent path to exist before the Chrome apply resumes.
3. Confirm repeated local delete/move failures do not loop on `HTTP 404` and only surface degraded state after bounded recovery is exhausted.

## Extension Remote Bookmark Loop Follow-up

- This Gitflow follow-up remains extension-first on `feature/shared-bookmark-sync-wu4-extension` and is limited to remote bookmark update/move loop prevention; it does NOT broaden into generic Work Unit 5 hardening.
- Remote bookmark update/move apply now records a short-lived payload correlation entry so equivalent Chrome `onChanged` / `onMoved` side effects are swallowed as remote effects instead of being re-sent to the backend.
- Bookmark move/update apply now verifies the final Chrome parent/index against the backend target and enters the existing subtree/workspace recovery ladder only when the final state still diverges.
- Repeated same-bookmark local update/move retries are abandoned once recovery begins so remote loop churn stops before degraded mode unless recovery is truly exhausted.

Manual Chromium validation for this follow-up:

1. ✅ Replayed a remote bookmark title/URL update and confirmed no duplicate backend mutation request was emitted.
2. ✅ Replayed a remote bookmark reorder/move and confirmed final Chrome parent/index matched backend order without repeated churn.
3. Confirm the degraded indicator remains hidden unless repeated recovery attempts are genuinely exhausted.

## Extension MV3 WebSocket Keepalive Hotfix

- This narrow extension-only hotfix stays on `feature/shared-bookmark-sync-wu4-extension` and adds no backend contract changes.
- The MV3 background websocket now sends a quiet keepalive only after ~20 seconds of socket idle time so healthy service-worker sessions are less likely to be idled away by Chrome.
- Normal sync traffic resets the idle timer, so healthy event flow does not produce noisy extra diagnostics or visible churn.
- Manual Chromium validation suggests idle/keepalive behavior is improved on the current branch.

## Extension Premium UI Redesign Slice

- This Gitflow slice stays on `feature/extension-premium-ui` and is limited to popup, options, and status surfaces only.
- Popup and Options now share `extension/src/shared/ui/theme.css` plus pure status helpers under `extension/src/shared/ui/status.ts` instead of page-local styling.
- The background projection state now exposes optional online/activity metadata so the UI can show calm online presence and a blue fresh-activity indicator without changing backend sync contracts.
- Fresh activity is acknowledged only after popup or options renders the current premium status view through `ui/mark-activity-seen`.

Manual Chromium validation completed on the current branch:

1. Popup and options render the shared dark theme with readable hierarchy.
2. Healthy live workspaces show the online indicator without noisy banners.
3. The blue activity indicator appears after remote activity and clears after popup or options displays the status view.
4. Degraded workspaces remain visually explicit and keep recovery actions visible.

## Canonical Domain Rules in This Slice

- The backend is the only source of truth for shared organizations, workspaces, folders, and bookmarks.
- Only `admin` and `editor` workspace members can mutate shared folder/bookmark state.
- `viewer` members can read workspace trees but cannot change shared semantics.
- `GET /workspaces/{workspaceId}/tree` returns stable backend IDs, parent links, and sibling order.
- Folder and bookmark deletes are soft deletes; sibling positions are re-packed after create, move, update, and delete operations.
- Organization membership alone does not unlock a workspace; access must come from an explicit direct or group grant.
- New workspaces start with only the creator as `admin` until additional user or group grants are added.
- Group membership is reusable for access, but grants nothing until the group is attached to a workspace.

## Gitflow and Chained Delivery

This change follows **Gitflow** with a dedicated tracker branch:

- Tracker branch: `feature/shared-bookmark-sync-mvp`
- Delivery model: `feature-branch-chain`
- PR 1 base: `feature/shared-bookmark-sync-mvp`
- PR 2+ base: the previous PR branch in the chain

Each work unit must stay reviewable, self-contained, and documented. Documentation updates ship with the same slice that introduces the behavior.

The admin backend foundation follow-up uses the same Gitflow chain discipline:

- Tracker branch: `feature/admin-backend-foundation`
- Delivery model: `feature-branch-chain`
- PR 1: schema + shared access
- PR 2: organizations + invitations + groups
- PR 3: workspace grants + runtime integration + verification + docs

The admin web UI follows the same Gitflow chain discipline:

- Tracker branch: `feature/admin-web-ui`
- Delivery model: `feature-branch-chain`
- PR 1: backend read models
- PR 2: shell + shared UI/API foundations
- PR 3: members + invitations + groups
- PR 4: workspaces + access + final docs/verification

## Review Slice Policy

- Keep each PR focused on one work unit.
- Do not start the next work unit in the same branch.
- Include relevant docs updates in the same slice.
- Prefer compile/build verification when full test infrastructure does not exist yet.

See `docs/roadmap.md` for the five planned slices and their acceptance checkpoints.

## Manual API Validation: Admin Backend Foundation

Use an authenticated admin session with the durable client header already required by the runtime routes.

1. `POST /organizations` and confirm the creator becomes the initial `owner`.
2. `POST /organizations/{organizationId}/invitations`, then `POST /invitations/{token}/accept`, and confirm the invitee becomes an active organization member.
3. `POST /organizations/{organizationId}/groups` plus `POST /groups/{groupId}/members` to prepare a reusable access group.
4. `POST /organizations/{organizationId}/workspaces` and confirm only the creator has initial `admin` access.
5. `PUT /workspaces/{workspaceId}/users/{userId}/access` and `PUT /workspaces/{workspaceId}/groups/{groupId}/access`, then confirm `GET /organizations/{organizationId}/workspaces` and `GET /workspaces/{workspaceId}` expose the effective highest role.
6. Remove one grant path at a time with the matching `DELETE` endpoints and confirm remaining access is recalculated instead of dropped prematurely.
7. Validate bookmark writes: `POST /workspaces/{workspaceId}/folders` must succeed for effective `admin`/`editor` access and fail with `403` for viewer-only or no-grant users.

## Manual UI Validation: Admin Web UI

Use an authenticated organization `owner` or `admin` session against the backend target configured in `admin-web`.

### Current browser evidence

- Authenticated admin login succeeded.
- The Workspaces inventory shows `OdA` (`team`) and `monitorizacion` (`shared`); each shows current role `admin` with grant source `direct`.
- The Invitations view shows `jcarlos@desatatufuria.com` as `member`, `pending`, with `No expiry`.
- This confirms invitation creation and listing only. SMTP email delivery and a browser invitation-acceptance UI are not implemented; API acceptance was not validated in this run.
- For local acceptance testing, run `scripts/activate-local-invitation.sh <email>`; it prompts for the test password and activates the newest pending local invitation.

### Remaining manual scenarios

1. Sign in as a non-admin user, open any admin route, and confirm the authorization failure state blocks the workflow.
2. In Groups, add a member to a flat group, reload the group details, and confirm the membership remains visible.
3. For one workspace, grant the same user a direct role and a group role through a group they belong to, then confirm Access shows both sources and the effective highest role.
