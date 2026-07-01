# Shared Bookmark Sync MVP Roadmap

## Delivery Model

- Workflow: Gitflow
- Tracker branch: `feature/shared-bookmark-sync-mvp`
- Chain strategy: `feature-branch-chain`
- Review policy: one work unit per PR, docs included in every slice

## Planned MVP Slices

| Work Unit | Target PR | Base Branch | Scope | Acceptance Checkpoint | Documentation Ownership |
|-----------|-----------|-------------|-------|-----------------------|-------------------------|
| 1 | PR 1 | `feature/shared-bookmark-sync-mvp` | Backend bootstrap, PostgreSQL schema, README baseline, roadmap baseline | API boots against PostgreSQL, migrations create canonical schema, repository docs explain branch and review model | `README.md`, `docs/roadmap.md` |
| 2 | PR 2 | PR 1 branch | Auth, organizations, workspaces, canonical tree reads, role gates, bookmark CRUD | Members can authenticate, access allowed workspaces, mutate allowed shared nodes, and read canonical trees with stable IDs/order | `README.md`, `docs/requeriments.md`, `docs/roadmap.md` |
| 3 | PR 3 | PR 2 branch | Transactional sync event log, replay API, websocket fan-out, idempotency rules, minimal backend + PostgreSQL Compose bring-up | Accepted mutations write domain + event in one transaction, replay ordered events by cursor, and run locally through the minimal backend/PostgreSQL stack | `README.md`, `docs/requeriments.md`, `docs/roadmap.md` |
| 4 | PR 4 | PR 3 branch | MV3 extension auth, workspace projection, mapping, exclusions, reconciliation | Extension projects only managed roots, stores mappings/exclusions, and reconciles backend-authoritative state | `README.md`, `docs/requeriments.md`, `docs/roadmap.md` |
| 5 | PR 5 | PR 4 branch | Hardening, verification notes, final documentation pass | End-to-end MVP behavior and verification guidance are documented after extension integration | `README.md`, `docs/requeriments.md`, `docs/roadmap.md` |

## Slice Acceptance Notes

### Work Unit 1
- PostgreSQL is the only supported product database.
- The backend is the canonical source of truth.
- The schema must include relational domain tables and transactional sync-event foundations.

### Work Unit 2
- Role handling must distinguish `admin`, `editor`, and `viewer`.
- Tree responses must expose stable backend IDs, parent links, and sibling order.
- JWT sessions must stay bound to a durable client ID header.
- Shared folder/bookmark mutations must remain backend-authoritative and use soft delete semantics.

### Work Unit 3
- Per-workspace cursors must enforce ordered replay.
- Duplicate `eventId` values must not create extra mutations.
- Add only a minimal `docker-compose.yml` for backend + PostgreSQL with essential env and volume wiring.
- Do not expand this slice into observability, reverse proxy, extension services, or deployment hardening.

Delivered in PR 3:
- transactional sync-event writes now wrap shared folder/bookmark mutations
- `GET /sync/events` replays ordered events and flags replay gaps for resync
- `GET /sync/ws` subscribes workspace clients and suppresses origin rebroadcast
- repository root `docker-compose.yml` now brings up only PostgreSQL + backend for local exercise
- slice-level backend tests cover replay continuity, replay-gap detection, duplicate ACK headers, and origin suppression

### Work Unit 4
- The extension must manage only `Shared Bookmarks / Organization / Workspace`.
- Viewer-local exclusions must stay local and survive remote updates.

### Work Unit 5
- Documentation must reflect delivered behavior and open questions.
- Verification notes must state what is automated versus manual.

## Documentation Rule for Every Slice

No work unit is complete unless its repository-facing documentation is updated in the same PR.
