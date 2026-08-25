# Admin Workspace Bookmark Management Specification

## Purpose

Let an org admin with a workspace grant view, edit, delete, reorder, reparent, and manually
create a workspace's bookmarks and folders directly in admin-web — closing the gap where the
only way to fix content today is installing the extension and editing by hand in a browser.

## Requirements

### Requirement: Workspace Tree Read

The system MUST render a workspace's full nested folder/bookmark tree at
`/bookmarks?workspace={id}` using `GET /workspaces/{id}/tree`, entered via a per-row action on
`WorkspacesPage`. If the acting admin holds no grant on the target workspace, the system MUST
detect the resulting 403 and present a message directing the admin to the existing self-grant
(`AccessPage`) flow, not a bare error.

#### Scenario: Admin with a workspace grant sees the full tree

- GIVEN an org admin holding `editor` or `admin` on workspace W
- WHEN they open `/bookmarks?workspace=W`
- THEN the full nested folder/bookmark tree for W is rendered

#### Scenario: Entry point carries the correct workspace id

- GIVEN an admin on `WorkspacesPage`
- WHEN they trigger the bookmarks row action for workspace W
- THEN they land on `/bookmarks?workspace=W`

#### Scenario: No workspace grant is detected and redirected, not shown as an error

- GIVEN an org admin with no grant on workspace W
- WHEN they open `/bookmarks?workspace=W` and the tree request returns 403
- THEN the page detects the 403 and shows a message pointing at the self-grant flow, never a
  bare/generic error state

### Requirement: Folder Rename and Bookmark Title/URL Edit

The system MUST allow renaming a folder, and MUST allow editing a bookmark's title and URL
together in one edit action, since the PATCH already carries both and title-only editing would
leave a broken URL permanently uneditable. Every edit mutation MUST include a deliberate
`X-Sync-Event-Id`.

#### Scenario: Folder rename succeeds

- GIVEN a folder F in the tree
- WHEN the admin renames F and submits
- THEN the PATCH is sent with a deliberate sync event id and, after refetch, F displays the new
  name

#### Scenario: Bookmark title and URL are edited together

- GIVEN a bookmark B with a mistyped title and a broken URL
- WHEN the admin edits both fields in the same form and submits
- THEN a single PATCH updates both title and URL, and the refetched tree reflects both changes

### Requirement: Delete With Cascade Confirmation

Folder deletion MUST use `ConfirmByTyping` (matching workspace delete) because it cascades to
all descendants server-side; its confirmation copy MUST state the cascade and that the change
applies immediately to every synced browser. Bookmark deletion MUST require explicit
confirmation before the DELETE is issued. Cancelling any confirmation MUST send no request.

#### Scenario: Folder delete cascades and requires typed confirmation

- GIVEN a folder F containing nested bookmarks and subfolders
- WHEN the admin initiates delete on F
- THEN a `ConfirmByTyping` dialog states the cascade and live blast radius, and only submits the
  DELETE (removing F and all descendants) once the confirmation text matches

#### Scenario: Bookmark delete requires confirmation

- GIVEN a single bookmark B
- WHEN the admin initiates delete on B
- THEN a confirmation is shown before any DELETE is sent, and confirming removes only B

#### Scenario: Cancelling a delete confirmation sends no request

- GIVEN either delete confirmation dialog is open
- WHEN the admin cancels
- THEN no DELETE request is sent and the item remains in the tree

### Requirement: Manual Single-Item Create

The system MUST allow creating a folder inside a workspace or inside another folder, and
creating a bookmark inside a folder, via the existing `CreateFolder`/`CreateBookmark` endpoints,
without requiring a file import. Each create call MUST include a deliberate `X-Sync-Event-Id`.

#### Scenario: Folder created at workspace root

- GIVEN a workspace with no selected parent folder
- WHEN the admin creates a new folder
- THEN the folder is created at the workspace root and appears after refetch

#### Scenario: Folder created nested inside another folder

- GIVEN an existing folder F
- WHEN the admin creates a new folder with F as parent
- THEN the new folder appears as a child of F after refetch

#### Scenario: Bookmark created inside a folder

- GIVEN an existing folder F
- WHEN the admin creates a bookmark with title and URL inside F
- THEN the bookmark appears as a child of F after refetch

### Requirement: Drag-and-Drop Reorder and Reparent

The system MUST support reordering siblings within a folder and reparenting by dropping an item
into a different folder, via mouse/touch and via keyboard-only interaction, using `@dnd-kit`.
Keyboard support (`KeyboardSensor`) and screen-reader `announcements`/live-region wiring MUST be
present, not deferred as polish. A move that the backend's cycle guard rejects MUST be surfaced
to the admin, never silently dropped.

#### Scenario: Mouse drag reorders siblings

- GIVEN two sibling bookmarks A and B in the same folder
- WHEN the admin drags A to a position after B using the mouse
- THEN a position-patch mutation is sent and, after refetch, A appears after B

#### Scenario: Mouse drag reparents into another folder

- GIVEN a bookmark B in folder F1 and a sibling folder F2
- WHEN the admin drags B and drops it onto F2
- THEN a parent-and-position patch is sent and, after refetch, B is a child of F2, not F1

#### Scenario: Keyboard-only reorder moves an item

- GIVEN an item is focused via keyboard navigation, with no mouse or touch input used
- WHEN the admin issues the keyboard move commands to change its position among siblings
- THEN the reorder mutation is sent and the new order is reflected after refetch, achieving the
  same outcome as a mouse drag

#### Scenario: Screen reader announces the move outcome

- GIVEN an admin using a screen reader performs a keyboard reorder or reparent
- WHEN the move completes
- THEN a live-region announcement communicates what moved and where it now sits

#### Scenario: A cycle-producing move is rejected and shown

- GIVEN a folder F being dragged onto one of its own descendants
- WHEN the drop is attempted
- THEN the backend's cycle guard rejects the mutation and the UI surfaces the rejection to the
  admin instead of silently reverting with no explanation

### Requirement: Deliberate Sync Event Id On Every Mutation

Every bookmark/folder mutation issued by this feature (rename, edit, delete, reorder, reparent,
create) MUST send a deliberate `X-Sync-Event-Id`, distinct from `Idempotency-Key`, so a retried
mutation does not create a duplicate and PATCH requests never 400 for a missing header.

#### Scenario: PATCH mutation carries a sync event id

- GIVEN any rename, edit, or reorder/reparent PATCH issued from this feature
- WHEN the request is sent
- THEN it includes an `X-Sync-Event-Id` header and does not 400 for a missing header

#### Scenario: Retried mutation does not duplicate

- GIVEN a mutation was sent with sync event id E but the client never received a response
- WHEN the client retries the same logical mutation
- THEN the retry reuses sync event id E and the server applies it at most once, producing no
  duplicate

### Requirement: Post-Mutation Refetch Is Authoritative

After every mutation, the system MUST invalidate and refetch the tree, and the rendered order
MUST always come from the server's recomputed positions, never from retained local optimistic
state. The tree page MUST refetch on window focus, and MUST display an "Updated HH:MM" stamp
with a manual refresh control.

#### Scenario: Displayed order matches server after mutation, not local optimism

- GIVEN a drag-and-drop reorder was performed and briefly showed an optimistic local order
- WHEN the mutation's refetch completes
- THEN the displayed order is replaced with the server's recomputed order, even if it differs
  from the optimistic order shown mid-drag

#### Scenario: Window focus triggers a refetch

- GIVEN the bookmarks page is open and the browser tab regains focus
- WHEN focus returns
- THEN the tree is refetched automatically

#### Scenario: Manual refresh updates the tree and the timestamp

- GIVEN the "Updated HH:MM" stamp is visible
- WHEN the admin clicks the manual Refresh control
- THEN the tree refetches and the stamp updates to the new time
