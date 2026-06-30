# Tasks: Shared Bookmark Sync MVP

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1000-1400 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 → PR 4 → PR 5 |
| Delivery strategy | force-chained |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Backend bootstrap + Postgres schema + docs baseline | PR 1 | Base=`feature/shared-bookmark-sync-mvp`; include README, Gitflow note, roadmap scaffold. |
| 2 | Organizations/workspaces/tree + role gates | PR 2 | Base=PR 1 branch; include tree/read tests and docs delta. |
| 3 | Sync engine + minimal backend/PostgreSQL Compose bring-up | PR 3 | Base=PR 2 branch; include `docker-compose.yml`, replay/idempotency tests, and tracker update. |
| 4 | MV3 auth + projection + exclusions/reconcile | PR 4 | Base=PR 3 branch; include projection tests and roadmap progress. |
| 5 | Hardening + verification docs | PR 5 | Base=PR 4 branch; include integration/e2e notes and requirements alignment. |

## Phase 1: Foundation

- [x] 1.1 Create `backend/go.mod`, `backend/cmd/api/main.go`, and `backend/internal/config/*` for app/config bootstrap on PostgreSQL only.
- [x] 1.2 Create `backend/internal/database/*` and `backend/migrations/*.sql` for users, orgs, workspaces, folders, bookmarks, devices, `sync_events`, and workspace cursors.
- [x] 1.3 Create `README.md` with setup, Gitflow branch model, feature tracker branch flow, and review-slice policy.
- [x] 1.4 Create `docs/roadmap.md` with the five chained MVP slices, acceptance checkpoints, and documentation ownership per slice.

## Phase 2: Canonical Domain

- [x] 2.1 Create `backend/internal/auth/*` for register/login/me, JWT middleware, and durable `clientId` binding.
- [x] 2.2 Create `backend/internal/organizations/*` and `backend/internal/workspaces/*` for membership reads, workspace access, and `GET /workspaces/:workspaceId/tree`.
- [x] 2.3 Create `backend/internal/bookmarks/*` for folder/bookmark create-update-delete-move, sibling ordering, URL validation, and soft delete.
- [x] 2.4 Update `docs/requeriments.md` and `docs/roadmap.md` to document canonical tree, roles, and backend-source-of-truth rules.

## Phase 3: Sync Engine and Local Bring-up

- [ ] 3.1 Create `backend/internal/sync/*` for transactional domain+event writes, per-workspace cursor assignment, and `eventId` idempotency.
- [ ] 3.2 Create `backend/internal/websocket/*` plus replay handlers for `GET /sync/events?afterCursor=` and `WS /sync/ws?workspaceId=` with origin suppression.
- [ ] 3.3 Add minimal `docker-compose.yml` for backend + PostgreSQL only, with required env, port, and volume wiring for local backend exercise.
- [ ] 3.4 Add backend tests plus `README.md`/`docs/roadmap.md` updates covering resume replay, replay gap, duplicate `eventId`, broadcast-excludes-origin, and local bring-up.

## Phase 4: Extension Projection

- [ ] 4.1 Create `extension/manifest.json`, `extension/package.json`, `extension/tsconfig.json`, and `extension/src/shared/*` for REST/WS clients, types, session, mapping, and exclusion storage.
- [ ] 4.2 Create `extension/src/popup/*` and `extension/src/options/*` for JWT login, workspace selection, resync-all, and diagnostics.
- [ ] 4.3 Create `extension/src/background/*` for managed-root listeners, snapshot bootstrap, cursor replay, remote apply suppression, and viewer local exclusions.

## Phase 5: Verification and Documentation

- [ ] 5.1 Add TS tests for mapping persistence, exclusion survival after remote updates, and unauthorized local edit reconciliation.
- [ ] 5.2 Add verification notes for PostgreSQL-backed local dev plus backend/extension bring-up after extension wiring lands.
- [ ] 5.3 Update `README.md`, `docs/requeriments.md`, and `docs/roadmap.md` with delivered slices, open questions, and next-step handoff for apply/verify.
