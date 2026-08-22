# Bookmark & Folder Activity Audit Specification

## Purpose

Extend the organization activity trail — today limited to 21 administrative Kinds
(organizations, invitations, workspaces, access, groups) — to also cover bookmark and folder
create/update/delete, so compliance and support can answer "who changed what, when" for the
product's core content. A category filter keeps the pre-existing administrative feed noise-free
against high-frequency bookmark/folder events (e.g. Chrome-native bulk import).

## Requirements

### Requirement: Bookmark and Folder Mutations Are Audited

The system MUST record exactly one `activity_events` row for every live bookmark and folder
create, update, and delete mutation, using six new `activity.Kind` values: `bookmark.created`,
`bookmark.updated`, `bookmark.deleted`, `folder.created`, `folder.updated`, `folder.deleted`.
Each row MUST be written inside the same database transaction as the mutation it audits, before
that transaction commits, attributed to the acting user's ID and the mutation's resolved
organization ID. This MUST cover all 8 live mutation routes, including the prepared-patch update
paths.

#### Scenario: Bookmark or folder creation is audited

- GIVEN an authenticated user creates a bookmark or a folder in a workspace
- WHEN the create mutation commits
- THEN an `activity_events` row with Kind `bookmark.created` or `folder.created` is recorded in
  the same transaction, attributed to the creating user's ID and the workspace's organization ID

#### Scenario: Bookmark or folder update is audited

- GIVEN an authenticated user updates a bookmark or a folder, including via the prepared-patch
  update paths
- WHEN the update mutation commits
- THEN an `activity_events` row with Kind `bookmark.updated` or `folder.updated` is recorded in
  the same transaction, attributed to the acting user and the resolved organization

#### Scenario: Bookmark or folder deletion is audited

- GIVEN an authenticated user deletes a bookmark or a folder
- WHEN the delete mutation commits
- THEN an `activity_events` row with Kind `bookmark.deleted` or `folder.deleted` is recorded in
  the same transaction, attributed to the acting user and the resolved organization

#### Scenario: Retried mutation does not double-record

- GIVEN a bookmark or folder mutation is retried with the same idempotency key/event ID as an
  already-applied mutation
- WHEN the duplicate is detected and the mutation short-circuits before the recording step
- THEN no additional `activity_events` row is written for the retry

### Requirement: Bookmark and Folder Audit Metadata Shape

Metadata recorded for bookmark Kinds MUST include `title`, `url`, `workspaceId`, and
`workspaceName`. Metadata recorded for folder Kinds MUST include `name`, `workspaceId`, and
`workspaceName`. For delete Kinds, `title`/`name` MUST reflect the entity's state immediately
before deletion.

#### Scenario: Bookmark metadata includes title and url

- GIVEN a bookmark create, update, or delete is audited
- WHEN the `activity_events` row is written
- THEN its metadata contains `title`, `url`, `workspaceId`, and `workspaceName` for that bookmark

#### Scenario: Folder metadata omits url

- GIVEN a folder create, update, or delete is audited
- WHEN the `activity_events` row is written
- THEN its metadata contains `name`, `workspaceId`, and `workspaceName`, and no `url` field

#### Scenario: Delete metadata reflects pre-delete state

- GIVEN a bookmark or folder is deleted
- WHEN its audit row is written
- THEN the recorded `title`/`name` MUST be the value the entity held immediately before
  deletion, never empty or null

### Requirement: Activity Feed Category Filter

`GET /organizations/{organizationId}/activity` MUST accept a `category` query parameter with
three valid values — `all`, `administrative`, `bookmarks` — defaulting to `all` when absent or
unrecognized. `administrative` MUST return only the pre-existing 21 administrative Kind values.
`bookmarks` MUST return only the six bookmark/folder Kind values. Switching category MUST start
a fresh page rather than continuing a different category's cursor.

#### Scenario: Default category returns everything

- GIVEN no `category` parameter is supplied
- WHEN the activity feed is requested
- THEN both administrative and bookmark/folder events are returned, unfiltered by kind

#### Scenario: Administrative category excludes bookmark/folder noise

- GIVEN `category=administrative`
- WHEN the activity feed is requested
- THEN only the 21 pre-existing administrative Kind values are returned; none of the six
  bookmark/folder Kinds appear

#### Scenario: Bookmarks category excludes administrative events

- GIVEN `category=bookmarks`
- WHEN the activity feed is requested
- THEN only the six bookmark/folder Kind values are returned; no administrative Kind appears

#### Scenario: Unrecognized category falls back to all

- GIVEN `category` is set to a value that is none of `all`, `administrative`, `bookmarks`
- WHEN the activity feed is requested
- THEN the system MUST behave as if `category=all` was supplied

#### Scenario: Switching category resets pagination

- GIVEN an admin is paginated partway through one category's results
- WHEN they switch to a different category
- THEN the feed MUST start from a fresh cursor for the new category rather than continuing the
  previous category's cursor position

### Requirement: admin-web Category Control and Rendering

`ActivityPage.tsx` MUST expose a three-way category control (All / Administrative / Bookmarks)
defaulting to All, wired into `useOrgActivity`'s query key so each category paginates
independently. `format.ts` MUST render each of the six new Kinds as a readable sentence,
following the existing no-actor-prefix convention used by the other 27 cases.

#### Scenario: Selecting a category updates the visible feed

- GIVEN the admin selects "Bookmarks" from the category control
- WHEN the feed reloads
- THEN only bookmark/folder events are shown and further "Load more" pagination stays within
  that category

#### Scenario: New Kinds render readable sentences

- GIVEN an `activity_events` row with one of the six new Kinds
- WHEN `format.ts` renders it
- THEN it MUST produce a readable sentence naming the action and target (bookmark title or
  folder name), consistent with the existing 27 cases, without an actor-name prefix

### Requirement: Explicit Non-Goals

This change MUST NOT revive `bookmarks.RegisterRoutes` or `bookmarks.Service`'s standalone HTTP
layer, MUST NOT introduce any retention/pruning mechanism for `activity_events`, and MUST NOT
alter `sync_events`, sync cursors, idempotency behavior, or the extension sync protocol.

#### Scenario: sync_events and sync protocol are untouched

- GIVEN a bookmark or folder mutation now also writes an `activity_events` row
- WHEN the mutation's `sync_events` row and sync/cursor/idempotency response are inspected
- THEN they MUST be byte-identical to their pre-change behavior

#### Scenario: No retention system is introduced

- GIVEN unbounded `activity_events` growth is a known, explicitly deferred follow-up
- WHEN this change ships
- THEN no pruning, sweeping, or retention policy for `activity_events` is implemented; a future
  change may extend `internal/purge`'s `Sweeper` pattern for this purpose

### Requirement: Corrected Package Documentation

The `activity` package's doc comment MUST accurately describe its callers and MUST NOT claim
"zero callers in this work unit".

#### Scenario: Doc comment reflects real callers

- GIVEN `activity/service.go`'s package doc comment previously stated it had zero callers
- WHEN this change ships
- THEN the comment MUST be corrected to reflect that organizations, workspaces, groups,
  bookmarks, and folders all call `activity.Record`
