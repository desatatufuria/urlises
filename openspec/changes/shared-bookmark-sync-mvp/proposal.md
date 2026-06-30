# Proposal: Shared Bookmark Sync MVP

## Intent
- Deliver an MVP that keeps shared workspace bookmarks consistent across Chrome clients while protecting canonical structure from corruption and unauthorized edits.

## Scope
### In Scope
- Go + PostgreSQL backend with relational bookmark/workspace domain, JWT auth, and transactional sync event log.
- Chrome MV3 extension with popup/options login, `Shared Bookmarks -> Organization -> Workspaces` layout, workspace snapshot bootstrap, and realtime updates.
- Cursor/version replay after reconnect, origin filtering, viewer-local exclusion overrides, and resync-all recovery for accessible content.

### Out of Scope
- Full event sourcing, CRDT/offline-first conflict resolution, non-Chrome browsers, advanced audit/UI customization.
- Changing shared bookmark meaning from viewer-local overrides.

## Capabilities
### New Capabilities
- `workspace-bookmark-domain`: Canonical organizations, workspaces, folders, bookmarks, roles, and workspace tree rules.
- `bookmark-sync-projection`: Snapshot + realtime sync, cursor replay, origin suppression, mapping, and transactional event delivery.
- `extension-access-and-projection`: Extension JWT login, managed-root layout, local projection behavior, and resync controls.

### Modified Capabilities
- None.

## Approach
- Use canonical relational domain tables as source of truth plus transactional `sync_events`; do not use full event sourcing for MVP.
- Bootstrap each workspace from `GET /workspaces/:workspaceId/tree`, then apply websocket events ordered by backend cursor/version.
- Treat viewer subtree deletion/hide in Chrome as local visibility exclusion only; keep canonical data immutable and preserve exclusion after remote edits.

## Affected Areas
| Area | Impact | Description |
|------|--------|-------------|
| `docs/requeriments.md` | Modified | Align MVP decisions, reconnect semantics, and viewer behavior docs. |
| `openspec/changes/shared-bookmark-sync-mvp/proposal.md` | New | Proposal contract for spec/design. |
| `backend/` | New | Modular backend for auth, workspaces, bookmarks, sync, websocket. |
| `extension/` | New | MV3 extension login, projection, listeners, mapping, resync UX. |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Out-of-order events corrupt structure | Med | Monotonic cursor/version, transactional writes, replay on reconnect. |
| Unauthorized local edits diverge from canonical state | Med | Role checks server-side, remote reconciliation, viewer overrides scoped to visibility only. |

## Rollback Plan
- Revert to snapshot-only sync behind a feature flag, disable websocket fan-out, and preserve canonical data in relational tables while extension resync rebuilds local projections.

## Dependencies
- PostgreSQL, JWT auth, WebSocket transport, Chrome Bookmarks/Storage APIs.
- Gitflow feature branch intent: `feature/shared-bookmark-sync-mvp`; documentation updates must ship with implementation slices.

## Success Criteria
- [ ] Admin/editor changes sync across multiple visible workspaces without corrupting canonical folder/bookmark structure.
- [ ] Reconnected clients recover via cursor replay after snapshot bootstrap without full default resync.
- [ ] Viewer local exclusions remain local, survive remote edits, and never delete backend data.
