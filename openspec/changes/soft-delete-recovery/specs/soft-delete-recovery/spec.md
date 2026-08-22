# Soft Delete + Recovery Window Specification

## Purpose

Give organization owners/admins a bounded, self-service way to undo an organization or workspace delete. Workspace delete gains the same typed-name confirmation organization delete already has; both deletes become reversible soft deletes for 30 days, immediately inaccessible to normal reads/sync/websocket but visible to the requester and other admins via a Trash view, restorable without re-running orphan/sole-owner guards, and automatically hard-purged past the window via the existing FK cascade graph. Four independently sequenced slices, on top of `lifecycle-management`'s (unmerged) delete paths.

## Requirements

### Requirement: Workspace Delete UX Parity

Deleting a workspace from `WorkspacesPage.tsx` MUST require the admin to type the exact workspace name via `ConfirmByTyping` (reused unmodified) before the delete action is enabled, replacing the current `window.confirm()` guard.

#### Scenario: Admin types the exact name and confirms (happy path)

- GIVEN an org admin opens the delete confirmation for a workspace row
- WHEN they type the workspace's exact name into `ConfirmByTyping` and submit
- THEN the delete request fires and, on success, the workspace is removed from the list

#### Scenario: Mismatched or partial name blocks submission

- GIVEN the delete confirmation is open for a workspace row
- WHEN the typed value does not exactly match the workspace name (empty, partial, or wrong)
- THEN the delete action MUST remain disabled and no request is sent

#### Scenario: Backend rejection is surfaced without losing state

- GIVEN a correctly typed name triggers a delete request that the backend rejects
- WHEN the mutation's error handler runs
- THEN an error is shown to the admin and the confirmation panel/row returns to its non-busy state without the row disappearing

### Requirement: Soft Delete for Organizations and Workspaces

`DeleteOrganization` and `workspaces.Delete` MUST set `deleted_at = NOW()` instead of issuing a hard `DELETE`. Both entity types MUST share one 30-day grace-period constant. `ErrWouldOrphanMember` and `ErrSoleOwner` MUST still apply, unchanged, at delete time. The instant `deleted_at` is set, the organization/workspace and everything under it MUST become inaccessible to normal reads, sync, and websocket connections — with the sole exception of the deletion requester and other admins of that entity, who can still see it via the Trash listing (see Restore + Trash requirement).

#### Scenario: Delete sets deleted_at, row survives (happy path)

- GIVEN an admin deletes an organization or workspace they are authorized to delete
- WHEN the delete transaction commits
- THEN the row's `deleted_at` is set to the commit time and the row itself still exists in the database

#### Scenario: Soft-deleted entity disappears from normal listings

- GIVEN an organization or workspace has `deleted_at` set
- WHEN any non-admin-Trash read path (`ListMemberships`, `ListByOrganization`, `ListMembers`, or equivalent listing) is queried
- THEN the soft-deleted entity MUST NOT appear in the results

#### Scenario: Soft-deleted workspace loses sync/websocket access immediately

- GIVEN a workspace has `deleted_at` set
- WHEN a sync request or websocket connection for that workspace is attempted immediately afterward
- THEN the system MUST reject the request rather than allowing continued access until eventual purge

#### Scenario: Orphan and sole-owner guards still block deletion

- GIVEN deleting an organization would leave another member with zero organization memberships, or deleting would strand a sole owner
- WHEN the delete is attempted
- THEN the system MUST reject with `ErrWouldOrphanMember` or the sole-owner sentinel, exactly as before this change, and MUST NOT set `deleted_at`

#### Scenario: activity_events survive a soft-deleted organization

- GIVEN an organization is soft-deleted
- WHEN its `activity_events` are queried during the grace period
- THEN the rows MUST still exist and be readable, because soft delete triggers no cascade — a behavior change from `lifecycle-management`'s original hard-delete design, where the organization's own audit trail was destroyed with it

#### Scenario: Distinct from the existing sync-tombstone deleted_at

- GIVEN `folders` and `bookmarks` already use their own `deleted_at` column as a sync-tombstone marker (cursor-protocol visibility, no restore, no purge)
- WHEN organization/workspace soft delete is implemented
- THEN it MUST be treated as an unrelated mechanism — it MUST NOT reuse, alter, restore, or purge the `folders`/`bookmarks` tombstone columns, and the tombstone mechanism MUST NOT gain restore/purge behavior as a side effect of this change

### Requirement: Self-Service Restore and Trash View

Admin-gated restore endpoints for organizations and workspaces MUST clear `deleted_at` without re-running `ErrWouldOrphanMember` or `ErrSoleOwner`. A minimal admin-web Trash view MUST list the requester's own soft-deleted organizations and workspaces (name, deleted-when, deleted-by if known, days remaining, Restore action), with no filters, search, or pagination in v1.

#### Scenario: Restore returns full access immediately (happy path)

- GIVEN an admin restores a soft-deleted organization or workspace they administer
- WHEN the restore request succeeds
- THEN `deleted_at` is cleared and the entity is immediately reachable again through normal reads, sync, and websocket

#### Scenario: Restoring an already-purged entity fails cleanly

- GIVEN a soft-deleted entity's grace period has already elapsed and it has been purged
- WHEN a restore is attempted against that entity's ID
- THEN the system MUST return `ErrNotFound` and change nothing

#### Scenario: Trash lists only entities the requester can administer

- GIVEN a requester views the Trash view
- WHEN the list is loaded
- THEN it MUST include only soft-deleted organizations and workspaces the requester administers, and MUST NOT include soft-deleted entities belonging to organizations they do not administer

#### Scenario: A restored entity reappears in normal listings and sync immediately

- GIVEN an organization or workspace was just restored
- WHEN normal listing endpoints or sync/websocket are queried afterward
- THEN the entity MUST appear and be usable immediately, with no residual delay

### Requirement: Scheduled Purge

An in-process ticker MUST sweep organizations and workspaces past their 30-day grace period and hard-delete them, letting the existing `ON DELETE CASCADE` FK graph (unchanged from `lifecycle-management`) destroy their children. The sweep MUST use a safe, idempotent query shape (`UPDATE ... WHERE deleted_at < NOW() - INTERVAL '30 days' RETURNING id`) even though a single backend instance in production makes an advisory lock unnecessary for v1.

#### Scenario: Entity past its window is purged with cascades

- GIVEN an organization or workspace has `deleted_at` older than 30 days
- WHEN the purge sweep runs
- THEN the entity is hard-deleted and its cascaded children are gone (organizations: `organization_members`, `workspaces`, `invitations`, `groups`, `activity_events`; workspaces: `folders`, `bookmarks`, `workspace_user_access`, `workspace_group_access`, `workspace_cursors`, `sync_events`)

#### Scenario: Entity still within its window is untouched

- GIVEN an organization or workspace has `deleted_at` less than 30 days old
- WHEN the purge sweep runs
- THEN the entity and its rows MUST remain unaffected

#### Scenario: Restoring before purge removes the entity from the sweep

- GIVEN an entity was restored (its `deleted_at` cleared) before the next sweep runs
- WHEN the next purge sweep executes
- THEN the entity MUST NOT be included among purge candidates and MUST NOT be deleted
