# Proposal: Soft Delete + Recovery Window for Organizations and Workspaces

## Intent

`lifecycle-management` gave admins delete for organizations and workspaces and made it **permanent**, with "no undelete/restore" as an explicit non-goal. For banking/fintech clients a mistaken organization delete is an unrecoverable incident that destroys every workspace, bookmark, membership and audit event under it, with only an engineering/DB restore as the escape hatch. The user has now superseded that non-goal: deletion must be reversible for a bounded window. Separately, workspace delete is still gated by a native `window.confirm()` while organization delete already requires typing the exact name — inconsistent friction for two comparably destructive actions.

Success: an admin who deletes the wrong organization or workspace can restore it themselves, within a known window, without support; and both delete actions demand the same deliberate confirmation.

## Scope

### In Scope

1. **Workspace delete UX parity** — replace `window.confirm()` in `WorkspacesPage.tsx` with `ConfirmByTyping` (Decision G). No backend dependency.
2. **Soft delete** — `deleted_at` on `organizations` and `workspaces`; `DeleteOrganization` / `workspaces.Delete` switch from `DELETE` to `UPDATE ... SET deleted_at = now()`.
3. **Immediate inaccessibility** — `deleted_at IS NULL` predicates at every read/authorization choke point, including sync/websocket (Decision C).
4. **Self-service restore** — admin-only restore endpoints for organization and workspace, clearing `deleted_at`.
5. **Trash view** — one minimal admin-web screen listing the requester's soft-deleted organizations and workspaces with a Restore action (Decision F).
6. **Scheduled purge** — in-process ticker hard-deletes rows past the window, letting existing FK cascades do the destruction (Decision B).

### Out of Scope / Non-Goals

- No cross-organization trash spanning orgs the requester does not administer.
- No configurable/admin-tunable grace period — the window is a hardcoded constant.
- No bulk restore, no filtering/search/pagination in Trash, no restore-preview.
- No change to `ErrWouldOrphanMember` / `ErrSoleOwner` semantics beyond Decision D.
- No change to the existing `folders`/`bookmarks` `deleted_at` **sync tombstone** — a different mechanism (cursor protocol, no restore, no purge) that merely shares a column name.
- No partial/selective restore (restore is whole-entity), no export of a purged entity, no user-facing deletion notifications or countdown emails.
- No retroactive rework of `lifecycle-management`'s Decision A (see Decision E).

## Product Decisions Resolved

> These go beyond the literal request. Each is a recommendation the product owner should sanity-check before spec.

| # | Decision | Rationale |
|---|----------|-----------|
| **A** | **30 days for both organizations and workspaces** — one shared constant. | 30 days is the dominant convention (GCP, GitLab since 2025, Notion) and covers the "nobody noticed until someone came back from leave" case. A shorter workspace window was considered and rejected: it doubles the test matrix and the support explanation ("why is my workspace already gone but the org isn't?") for no business gain, and a soft-deleted workspace's storage cost is bounded. |
| **B** | **In-process goroutine ticker** sweeping expired soft-deletes. | Net-new architecture for this backend — stated as a recommendation, not a default. The repo has zero cron/scheduler infrastructure, so an external cron (b) requires new ops surface that does not exist; lazy purge-on-read (c) never purges the common case, an org nobody queries again. A ticker needs no external system and guarantees eventual purge. Accepted cost: multi-instance deployments need the sweep to be idempotent/singleton-safe. |
| **C** | **Soft-deleted = immediately inaccessible**, including sync and websocket. | The grace period is for an admin to restore, not for users to keep working in a half-deleted org. Matches GCP/GitLab ("becomes unusable immediately"). `access.GetEffectiveWorkspaceAccess` is the choke point for workspaces; organization-side needs `ListMemberships`, `ListMembers`, and **both** copies of `requireOrganizationAdmin` (`organizations` and `groups`). |
| **D** | **`ErrWouldOrphanMember` and `ErrSoleOwner` still apply, unchanged.** | Soft delete does not auto-restore, so during the window the entity is unusable and a member left with zero reachable organizations is just as stranded as before — arguably more confusingly so, since the org still exists in the database. Guards stay at delete time; restore does not re-run them. |
| **E** | **`activity_events` survival is a positive side effect, no action required.** | Nothing cascades until purge, so a soft-deleted organization keeps its audit trail for the whole window. This makes `lifecycle-management` Decision A's accepted "org deletion destroys its own audit trail" tradeoff moot for 30 days and strictly better than before. Purge still cascades the trail away — no schema change, no separate retention work in this change. |
| **F** | **A real Trash view**, scoped minimally. | Restore must be discoverable or it is not self-service. One nav item, one list per entity type: name, deleted-when, deleted-by (when recorded), days remaining, Restore. No filters, search, or pagination in v1 given expected volume. |
| **G** | **Per-row confirmation modal/panel reusing `ConfirmByTyping`**, opened by the existing per-row Delete button. | Smallest change that still requires exact-name typing. Moving workspace delete to a danger-zone panel would require a workspace detail page that does not exist. `ConfirmByTyping` is already presentation-only and reusable as-is. |

## Capabilities

### New Capabilities

- `deletion-recovery`: soft delete, 30-day grace period, immediate inaccessibility, self-service restore, Trash listing, and scheduled purge for organizations and workspaces.

### Modified Capabilities

- `lifecycle-management`: "Delete Workspace" and "Delete Organization (Guarded)" change from permanent hard delete to reversible soft delete; workspace delete gains the confirm-by-typing guard the organization requirement already has. (Spec currently lives in `openspec/changes/lifecycle-management/specs/`, not yet archived.)

## Approach

Additive migration adds nullable `deleted_at` to `organizations` and `workspaces` plus partial indexes for the "not deleted" reads and the purge sweep. Delete handlers keep their existing admin gate, guard checks, `RowsAffected()==0 → ErrNotFound` shape, and in-transaction `activity.Record`; only the SQL verb changes. Reachability is enforced by adding `deleted_at IS NULL` at the authorization choke points rather than sprinkling it across every query — one predicate in `access.GetEffectiveWorkspaceAccess` covers essentially all workspace reads including sync; organization side must be enumerated explicitly in design because `requireOrganizationAdmin` is duplicated. Restore mirrors delete (admin gate, scoped `UPDATE ... SET deleted_at = NULL`, activity event). The purge ticker runs on backend startup, sweeps rows past the window, and issues real `DELETE`s so the existing FK cascade graph performs the destruction unchanged. Admin-web reuses `ConfirmByTyping` for workspace delete and adds one Trash route with React Query invalidation matching existing mutation patterns.

## Sequencing

Item 1 has no dependency on soft delete and could ship first and alone. The user's request grouped both asks, and `lifecycle-management` set a 5-slice chained-PR precedent, so the recommended shape is another chain on the existing branch:

| Slice | Content | Depends on |
|-------|---------|-----------|
| 1 | Workspace delete UX parity (`ConfirmByTyping`) — frontend only | — |
| 2 | Migration + soft delete + `deleted_at IS NULL` at all choke points | — |
| 3 | Restore endpoints + Trash view | 2 |
| 4 | Purge ticker | 2 |

Slice 1 is independently mergeable if the user wants to phase delivery.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `admin-web/src/features/workspaces/WorkspacesPage.tsx` | Modified | Per-row `ConfirmByTyping` modal replaces `window.confirm` (line 108) |
| `admin-web/src/features/trash/` | New | Trash list + Restore actions |
| `admin-web/src/lib/api/` | Modified | `restoreOrganization`, `restoreWorkspace`, `listDeleted` clients |
| `backend/migrations/` | New | `deleted_at` on `organizations` + `workspaces`, partial indexes |
| `backend/internal/organizations/service.go` | Modified | Soft delete, restore, list-deleted, predicates on `ListMemberships`/`ListMembers`/`requireOrganizationAdmin` |
| `backend/internal/workspaces/service.go` | Modified | Soft delete, restore, predicate on `ListByOrganization`/`GetTree` |
| `backend/internal/access/service.go` | Modified | Workspace reachability choke point (also gates sync/websocket) |
| `backend/internal/groups/service.go` | Modified | Duplicated `requireOrganizationAdmin` needs the same predicate |
| `backend/internal/purge/` (new) | New | Ticker sweep + hard delete past the window |
| `backend/internal/activity/service.go` | Modified | New kinds: `organization.restored`, `workspace.restored`, purge events |
| `openspec/changes/lifecycle-management/specs/` | Modified | Delete requirements are superseded by the delta in this change; docs must stop claiming deletion is permanent |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| A missed `deleted_at IS NULL` predicate leaves a deleted entity reachable | High | Enumerate every call site in design; both `requireOrganizationAdmin` copies are named explicitly; spec scenario per choke point |
| Purge ticker runs concurrently in a multi-instance deployment | ~~Med~~ Resolved | User confirmed production runs a single backend instance — no advisory lock needed for v1. Design should still guard the sweep with a plain transaction (`UPDATE ... WHERE deleted_at < NOW() - INTERVAL '30 days' RETURNING id`) so a future move to multiple instances fails safe rather than double-purging silently. |
| Purge is irreversible by design | Med (by design) | 30-day window; Trash shows days remaining; purge is the only destructive path left |
| Reverting the soft-delete code resurrects soft-deleted entities as live | Med | Stated in Rollback Plan; revert requires an explicit decision on pending rows |
| Restoring an organization whose members changed meanwhile | Low | Restore does not re-run orphan/sole-owner guards (Decision D); memberships were never deleted |
| Storage growth from never-purged rows if the ticker silently fails | Low | Log each sweep; surface last-sweep observability in design |
| Confusion with the existing `folders`/`bookmarks` sync tombstone | Med | Explicit non-goal; design must keep the two mechanisms named distinctly |

## Rollback Plan

Per slice, on `feat/soft-delete-recovery` (branched off the still-unmerged `feat/lifecycle-management`); rollback is a branch-level revert before merge — no merges or new branches in this change.

- Slice 1: pure frontend revert, restores `window.confirm`.
- Slice 2: reverting the service code while the column exists makes any row with `deleted_at` set visible and usable again. Safe revert order is: decide the fate of pending rows first (hard-delete them to honour the original intent, or accept resurrection), then revert code, then drop the column in a follow-up down-migration.
- Slice 3: revert removes the Trash route and restore endpoints; soft-deleted rows remain, recoverable only by DB access.
- Slice 4: revert stops the sweep; nothing is purged, no data is lost.

## Dependencies

- Depends on `lifecycle-management` (unmerged `feat/lifecycle-management`): this change modifies the delete paths that branch introduced. It cannot be evaluated or merged independently of it.
- No external dependencies. The purge ticker deliberately introduces no new external infrastructure.

## Success Criteria

- [ ] Deleting a workspace requires typing its exact name; the delete control stays disabled until it matches.
- [ ] Deleting an organization or workspace makes it immediately unreachable to admin API, sync, and websocket clients, while the row survives.
- [ ] An admin can restore a soft-deleted organization or workspace from a Trash view and it becomes fully usable again, with its bookmarks, memberships, and activity history intact.
- [ ] An entity past 30 days is hard-deleted automatically, with FK cascades performing the same destruction the previous hard delete did.
- [ ] `ErrWouldOrphanMember` and `ErrSoleOwner` still block the same cases they blocked before this change.
- [ ] A soft-deleted organization's `activity_events` are still readable for the whole window.

## Proposal Question Round

Automatic execution mode — resolved with recommendations instead of blocking. Confirm or correct before spec:

1. **Decision A**: is 30 days right for both, or should workspaces get a shorter window (or organizations a longer one for compliance)?
2. ~~**Decision B**: is an in-process ticker acceptable as new backend architecture, and how many backend instances run in production?~~ **RESOLVED**: user confirmed a single backend instance in production — the ticker ships without an advisory lock.
3. **Decision C**: confirm that users of a soft-deleted org/workspace should lose access immediately rather than during a wind-down.
4. **Decision F**: is one Trash view for both entity types the right shape, or should restore live next to each entity's list?
5. **Sequencing**: ship all four slices as a chain, or land slice 1 (UX parity) on its own first?
