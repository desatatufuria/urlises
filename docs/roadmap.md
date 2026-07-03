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

Delivered in PR 4:
- `extension/` now contains the MV3 shell, TypeScript toolchain, popup login flow, options workspace selection UI, and background sync service worker
- the extension persists JWT session state, durable client identity, backend↔Chrome mappings, per-workspace cursors, and viewer-local exclusions in `chrome.storage.local`
- snapshot bootstrap, replay catch-up, websocket subscription, managed-root projection, remote apply suppression, and manual resync diagnostics are wired for selected workspaces only
- focused projection behavior tests now cover exclusion-preserving snapshot filtering and descendant exclusion cleanup after canonical folder deletion

Live-sync remediation guardrail:
- Keep the fix extension-first on `feature/shared-bookmark-sync-wu4-extension`; backend changes are allowed only if current replay/websocket contracts cannot distinguish resume, replay-gap, or resync-required states.
- Healthy runtime should stay effectively invisible: replay-first silent recovery precedes any visible degraded message, and duplicate-safe subtree reconciliation must run before remote create/rebuild paths.

Delivered follow-up on `feature/shared-bookmark-sync-wu4-extension`:
- `extension-missing-parent-recovery` adds subtree-first repair for destructive delete/move cascades where mapped Chrome parents or nodes disappear mid-apply.
- Remote folder/bookmark apply now validates the expected parent path before create/move/delete continues, then prunes stale mappings and replays from the last trusted cursor after rebuilding the nearest recoverable managed subtree.
- Local delete/move `404` or parent-miss failures are abandoned once recovery starts so the same stale mutation does not loop.
- Descendant mappings and exclusions are removed deterministically after canonical subtree deletes.
- Scope remains explicitly narrow: this follow-up does NOT include broad Work Unit 5 hardening.
- Chromium validation for the missing-parent-specific recovery scenarios is still pending.

Delivered follow-up on `feature/shared-bookmark-sync-wu4-extension`:
- `extension-remote-bookmark-loop-fix` narrows the next extension remediation to remote bookmark update/move apply that was being re-emitted through Chrome `onChanged` / `onMoved` listeners.
- The runtime now correlates remote bookmark side effects by bookmark identity plus expected title/url and target parent/index so only equivalent listener events are swallowed.
- Backend-authoritative parent/index is verified after bookmark apply, and repeated same-bookmark update/move retries are abandoned once recovery starts.
- Scope remains explicitly narrow: this follow-up does NOT expand into generic Work Unit 5 hardening.
- Chromium validation has confirmed remote bookmark update and reorder behavior on the branch; degraded-threshold validation remains pending.

Delivered follow-up on `feature/shared-bookmark-sync-wu4-extension`:
- `extension-mv3-websocket-keepalive` adds a narrow idle keepalive around the existing MV3 websocket session without changing backend contracts.
- Chromium validation has confirmed websocket delivery and replay behavior, and current idle behavior appears improved on the branch.

### Work Unit 5
- Documentation must reflect delivered behavior and open questions.
- Verification notes must state what is automated versus manual.

## Product / Admin Direction

- Roles and memberships will be managed through a dedicated admin web application, not through the Chrome extension.
- The first user who creates an organization becomes its initial admin/owner.
- That organization admin is responsible for inviting members, assigning organization/workspace access, and setting `admin` / `editor` / `viewer` workspace roles.
- The extension remains an operational sync client: login, workspace selection, projection, replay, websocket sync, and local viewer exclusions.

## Viewer Local Override Policy

- Viewer users must never change canonical shared bookmark semantics in the backend.
- Viewer-local changes that only affect personal presentation may remain local in the browser.
- Allowed viewer-local behavior for MVP:
  - hide/exclude folders or bookmarks locally
  - reorder visible content locally for that viewer only
- Rejected/reverted viewer behavior for MVP:
  - changing shared bookmark URLs
  - renaming shared folders or bookmarks
  - moving shared folders/bookmarks as a canonical change
  - deleting shared nodes canonically
- Product rule: if a change alters shared meaning, revert it; if it only alters the local view, keep it local.

## Documentation Rule for Every Slice

No work unit is complete unless its repository-facing documentation is updated in the same PR.

## Extension Premium UI Follow-up Slice

- Branch: `feature/extension-premium-ui`
- Delivery exception: approved as a single larger PR for this redesign only
- Scope guardrail: popup, options, and status surfaces only — no backend, admin, or bookmark-management expansion

Delivered implementation scope:
- shared extension UI foundation under `extension/src/shared/ui/` with dark theme, hierarchy tokens, and subtle motion rules
- premium popup summary/status surface with clearer session + workspace hierarchy
- premium options workspace cards with explicit degraded state, calm healthy state, online presence, and blue fresh-activity cues
- activity-seen acknowledgement path that clears the blue indicator after a premium status surface renders

Outstanding verification:
- Manual Chromium validation is still required for dark theme, motion calmness, online indicator visibility, blue indicator clear-on-open, and degraded prominence.
