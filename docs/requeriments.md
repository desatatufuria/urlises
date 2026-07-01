# Project Proposal: Shared Bookmark Sync for Teams, Projects and Clients

## 1. Objective

Build a Chrome extension and backend service that allow teams to synchronize shared bookmark folders in real time.

The product should let users create shared bookmark spaces organized by:

- Team
- Project
- Client
- Environment
- Category

The system must synchronize only the folders managed by the application, never the user’s personal Chrome bookmarks.

## 2. Product Concept

The application is a workspace-based bookmark synchronization tool for operational teams.

Example structure:

text
Shared Bookmarks
├── Client - Sacyr
│   ├── PRE
│   │   ├── Grafana Dashboard
│   │   ├── Jira Filter
│   │   └── Runbook
│   └── PRO
│       ├── Grafana Dashboard
│       ├── Alerts Panel
│       └── Documentation
├── Client - Affinity
│   ├── Jira
│   ├── ServiceDesk
│   └── APIs
└── Team - DevOps
    ├── Monitoring
    ├── Internal Tools
    └── Documentation


## 3. MVP Scope

The first version must be simple and functional.

### Must Have

- Chrome extension using Manifest V3.
- Backend API.
- User authentication.
- Organizations.
- Workspaces.
- Shared folders.
- Shared bookmarks.
- Team members.
- Basic roles:
    - admin
    - editor
    - viewer
- Real-time synchronization.
- Conflict prevention using event IDs.
- Deduplication of sync events.
- Local Chrome folder controlled by the extension.
- Sync only under one root folder, for example: Shared Bookmarks.

### Nice to Have Later

Do not implement in the MVP:

- Browser support beyond Chrome.
- Comments.
- Tags.
- AI features.
- Advanced audit logs.
- Public sharing links.
- Import/export.
- Mobile app.
- Complex permission inheritance.

## 4. Recommended Tech Stack

### Backend

Use Go.

Recommended stack:

- Go 1.22+
- PostgreSQL
- sqlc or pgx
- chi, Echo, Fiber or Gin
- WebSocket support
- JWT authentication
- Docker Compose

Keep the backend clean and modular.

Suggested backend modules:

text
cmd/api
internal/auth
internal/users
internal/organizations
internal/workspaces
internal/folders
internal/bookmarks
internal/sync
internal/websocket
internal/database
internal/config


### Chrome Extension

Use:

- TypeScript
- Manifest V3
- Chrome Bookmarks API
- Chrome Storage API
- WebSocket client
- REST client

Suggested extension structure:

text
extension
├── manifest.json
├── src
│   ├── background
│   │   ├── service-worker.ts
│   │   ├── bookmark-listeners.ts
│   │   ├── sync-client.ts
│   │   └── chrome-bookmarks.ts
│   ├── popup
│   │   ├── popup.html
│   │   └── popup.ts
│   ├── options
│   │   ├── options.html
│   │   └── options.ts
│   └── shared
│       ├── api.ts
│       ├── types.ts
│       └── config.ts


## 5. Core Domain Model

Use this conceptual model:

text
Organization
  └── Workspace
        └── Folder
              └── Bookmark


A workspace can represent:

- a team
- a client
- a project
- an environment
- an internal department
## 6. Database Model

Create the following tables:

sql
users (
  id uuid primary key,
  email text unique not null,
  name text,
  password_hash text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

organizations (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

organization_members (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  user_id uuid not null references users(id),
  role text not null,
  created_at timestamptz not null
);

workspaces (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null,
  type text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

workspace_members (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  user_id uuid not null references users(id),
  role text not null,
  created_at timestamptz not null
);

folders (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  parent_id uuid references folders(id),
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

bookmarks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  folder_id uuid not null references folders(id),
  title text not null,
  url text not null,
  position integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

devices (
  id uuid primary key,
  user_id uuid not null references users(id),
  name text,
  client_id text unique not null,
  created_at timestamptz not null,
  last_seen_at timestamptz
);

sync_events (
  id uuid primary key,
  event_id text unique not null,
  organization_id uuid not null references organizations(id),
  workspace_id uuid not null references workspaces(id),
  user_id uuid not null references users(id),
  device_id uuid references devices(id),
  origin_client_id text not null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null
);


## 7. Sync Event Format

Every change must be represented as a sync event.

Example:

json
{
  "eventId": "uuid",
  "originClientId": "browser-device-id",
  "workspaceId": "uuid",
  "eventType": "bookmark.created",
  "entityType": "bookmark",
  "entityId": "uuid",
  "payload": {
    "title": "Grafana PRO",
    "url": "https://grafana.example.com",
    "folderId": "uuid",
    "position": 1
  },
  "createdAt": "2026-06-30T10:00:00Z"
}


Supported event types:

text
folder.created
folder.updated
folder.deleted
folder.moved

bookmark.created
bookmark.updated
bookmark.deleted
bookmark.moved


## 8. Sync Rules

The system must prevent infinite loops.

Rules:

1. Every client has a unique originClientId.
2. Every event has a unique eventId.
3. The backend stores every processed event in sync_events.
4. If an event with the same eventId already exists, ignore it.
5. When the backend broadcasts an event, it must not send it back to the same originClientId.
6. When the extension applies a remote change to Chrome, it must mark the operation as remote.
7. Chrome bookmark listeners must ignore changes currently being applied from remote sync.
8. The backend must assign a monotonic per-workspace cursor to every accepted shared mutation.
9. Reconnect replay must use `GET /sync/events?workspaceId=<id>&afterCursor=<n>` and return only contiguous later events.
10. If replay continuity cannot be proven, the backend must instruct the client to resync from a fresh snapshot.
11. MVP policy: retain all sync events in PostgreSQL; do not implement pruning or retention jobs yet.

## 9. Chrome Extension Behavior

The extension must create or detect a root folder:

text
Shared Bookmarks


Only bookmarks inside this folder are managed.

The extension must listen to:

javascript
chrome.bookmarks.onCreated
chrome.bookmarks.onRemoved
chrome.bookmarks.onChanged
chrome.bookmarks.onMoved


When a local change happens inside the managed root folder:

1. Convert Chrome bookmark change into a sync event.
2. Send event to backend.
3. Backend persists it.
4. Backend broadcasts it to other connected clients.
5. Other clients apply the change locally.

When a remote event arrives:

1. Check if event was already processed.
2. Apply it to Chrome bookmarks.
3. Store local mapping between backend IDs and Chrome bookmark IDs.
4. Do not re-emit it as a local event.

## 10. Local Mapping

Chrome bookmark IDs are local to each browser.

Therefore, the extension must store mappings:

json
{
  "backendFolderId": "chromeFolderId",
  "backendBookmarkId": "chromeBookmarkId"
}


Use chrome.storage.local.

Never assume Chrome IDs are the same across devices.

## 11. API Endpoints

Implement these REST endpoints:

text
POST /auth/register
POST /auth/login
GET  /me

GET    /organizations
POST   /organizations

GET    /organizations/:organizationId/workspaces
POST   /organizations/:organizationId/workspaces

GET    /workspaces/:workspaceId
GET    /workspaces/:workspaceId/tree

POST   /workspaces/:workspaceId/folders
PATCH  /folders/:folderId
DELETE /folders/:folderId

POST   /workspaces/:workspaceId/bookmarks
PATCH  /bookmarks/:bookmarkId
DELETE /bookmarks/:bookmarkId

GET /sync/events?workspaceId=:workspaceId&since=:timestamp
WS  /sync/ws?workspaceId=:workspaceId

Authentication notes for MVP:

- `POST /auth/register` and `POST /auth/login` require a durable client identifier header (`X-Client-Id` by default).
- The backend binds that client ID to the authenticated device/user record and returns a JWT for subsequent requests.
- Authenticated requests must send both `Authorization: Bearer <token>` and the same durable `X-Client-Id` header.


## 12. WebSocket Behavior

When a user connects to:

text
/sync/ws?workspaceId=:workspaceId


The backend must:

1. Authenticate the user.
2. Verify workspace access.
3. Register the connection.
4. Receive sync events.
5. Persist valid events.
6. Broadcast them to other connected clients in the same workspace.

## 13. Permissions

Use simple role rules:

### Admin

Can:

- manage workspace
- invite users
- create folders
- edit folders
- delete folders
- create bookmarks
- edit bookmarks
- delete bookmarks

### Editor

Can:

- create folders
- edit folders
- delete folders
- create bookmarks
- edit bookmarks
- delete bookmarks

### Viewer

Can:

- read workspace
- sync bookmarks locally
- not modify shared data

For MVP, do not implement complex permission inheritance.

## 14. Backend Business Rules

- A bookmark must belong to one folder.
- A folder must belong to one workspace.
- A workspace must belong to one organization.
- Deleted folders and bookmarks should use soft delete.
- URLs must be validated.
- Users cannot access workspaces where they are not members.
- The backend is the source of truth.
- Chrome local state is a projection of backend state.
- Workspace trees must expose stable backend IDs, parent links, and sibling order.
- Only `admin` and `editor` members may mutate shared folders and bookmarks.
- `viewer` members may read workspace trees but must not mutate shared semantics.
- Shared folder/bookmark moves must preserve deterministic sibling ordering after create, update, move, and soft delete operations.

## 15. First Implementation Milestones

### Milestone 1: Backend Foundation

- Project setup.
- Config.
- Database connection.
- Migrations.
- Auth.
- Organizations.
- Workspaces.
- Basic CRUD.

### Milestone 2: Bookmark Domain

- Folder CRUD.
- Bookmark CRUD.
- Workspace tree endpoint.
- Soft delete

### Milestone 3: Sync Engine

- Sync event model.
- Event deduplication.
- WebSocket connections.
- Broadcast by workspace.
- Origin client filtering.

### Milestone 4: Chrome Extension

- Manifest V3.
- Create root folder.
- Listen to bookmark changes.
- Send local events.
- Receive remote events.
- Apply remote changes.
- Store ID mappings.

### Milestone 5: MVP Hardening

- Permission checks.
- Reconnect logic.
- Initial full sync.
- Basic tests.
- Docker Compose.
- README.

## 16. Non-Goals for MVP

Do not implement:

- AI recommendations.
- Import from all personal bookmarks.
- Synchronization of all Chrome bookmarks.
- Firefox/Safari/Edge support.
- Offline-first conflict resolution.
- Complex CRDT logic.
- Enterprise SSO.
- Billing.
- Analytics dashboard.

## 17. Engineering Guidelines

Keep the system simple.

Avoid overengineering.

Use clear boundaries:

- Auth handles identity.
- Workspace handles membership.
- Bookmark domain handles folders and bookmarks.
- Sync domain handles events and broadcasting.
- Chrome extension handles browser integration only.

Do not let sync logic leak into every module.

Do not let the Chrome extension become the source of truth.

Do not hardcode clients, teams or projects.

Everything must be workspace-driven.

## 18. Suggested Repository Structure

text
shared-bookmark-sync
├── backend
│   ├── cmd
│   │   └── api
│   ├── internal
│   │   ├── auth
│   │   ├── config
│   │   ├── database
│   │   ├── organizations
│   │   ├── workspaces
│   │   ├── bookmarks
│   │   ├── sync
│   │   └── websocket
│   ├── migrations
│   ├── go.mod
│   └── Dockerfile
├── extension
│   ├── manifest.json
│   ├── package.json
│   ├── tsconfig.json
│   └── src
├── docker-compose.yml
└── README.md


## 19. First Prompt for OpenCode or Codex

Build the MVP for a shared bookmark synchronization platform.

Use the proposal in this document as the source of truth.

Start by creating the repository structure, backend service in Go, PostgreSQL migrations, Docker Compose, and the core domain models for users, organizations, workspaces, folders, bookmarks, devices and sync events.

Keep the implementation simple, modular and production-oriented.

Do not implement non-MVP features.

Prioritize:

1. clean architecture without overengineering;
2. working backend foundation;
3. database migrations;
4. authentication;
5. workspace tree model;
6. sync event model;
7. WebSocket sync design;
8. Chrome extension skeleton using Manifest V3.

After creating the initial structure, provide a clear README with setup instructions and next development steps
