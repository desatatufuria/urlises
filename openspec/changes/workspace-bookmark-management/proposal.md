# Proposal: Workspace bookmark management (admin-web)

## Intent

An org admin can create a workspace, grant access, and read the audit feed — but cannot see or
touch the workspace's actual content. `admin-web/src/features/*` has no page that renders a
bookmark/folder tree at all. Today the only way to fix a mistyped folder name, remove a stale
bookmark, or seed a new workspace is to install the extension, join the workspace, and do it by
hand in a browser's native bookmark bar. That is an operational cost on every onboarding and
every support request, and it makes the admin console structurally incomplete: it administers
containers and permissions but not the product's actual data.

The backend already supports every operation this needs (CRUD, cycle-safe reparenting,
position-based sibling reorder, a fully nested tree read). This change is admin-web wiring plus
one file parser — not new domain capability.

## Scope

### In Scope

- Per-workspace bookmark/folder tree view in admin-web, from the existing
  `GET /workspaces/{id}/tree`.
- Rename a folder; edit a bookmark's title **and URL** (the PATCH already carries both;
  shipping title-only would leave a broken URL permanently uneditable).
- Delete a folder (cascade-confirmed) or a bookmark.
- Drag-and-drop reorder **and reparent** (drop into another folder) — the backend `position` +
  `parentId` patch and `ensureFolderNotDescendant` cycle guard already cover both, and a tree
  DnD that refuses to move items between folders is worse than none.
- Bulk import from a Netscape bookmarks file (`bookmarks.html`) with visible per-item progress
  and a per-item failure list.
- Manual single-item create: add a folder inside a workspace (or another folder), and add a
  bookmark inside a folder — confirmed needed, not just import-and-extension-covered. Uses the
  same `CreateFolder`/`CreateBookmark` backend endpoints already wired for the rest of this
  change; no new backend surface.
- Correct `X-Sync-Event-Id` plumbing for every bookmark mutation issued by admin-web.

### Out of Scope (explicit non-goals)

- **Export** — no backend support, no stated need; the tree endpoint makes it a small
  fast-follow.
- **Search / filter within the tree** — deferred until real trees are large enough to need it.
- **Multi-select bulk delete** — needs a selection model and a bulk endpoint; single delete
  covers the actual reported need.
- **Any backend change**: no new endpoint, no schema change, no authorization change.
  `access.RequireWorkspaceWriteAccess` stays as-is (org admins self-grant editor via the
  existing `AccessPage` flow — confirmed real, not a workaround).
- **In-extension admin-edit attribution** — deferred, see Decision G.

## Capabilities

### New Capabilities

- `admin-workspace-bookmark-management`: admin-web tree read, rename/edit, delete, and
  drag-and-drop reorder/reparent for a workspace's bookmarks and folders.
- `bookmark-file-import`: parsing a Netscape bookmarks file and materializing it into a
  workspace, including partial-failure reporting.

### Modified Capabilities

- None. No spec in `openspec/specs/` covers admin-web bookmark content.

## Approach — decisions resolved

### A — Bulk import: Option A (N sequential calls), with a hard size ceiling

Confirmed, not defaulted to. Option B's strongest argument is round-trip cost and atomicity at
"thousands of nodes" scale. This is an internal admin tool for one small team's own
infrastructure; realistic imports are one person's curated browser export — tens to low
hundreds of nodes, not a decade-old 5,000-bookmark bar. That materially weakens B's urgency,
but it is an assumption about usage, not a fact, so it is fenced rather than trusted:

- **Ceiling**: imports above **500 nodes** are refused up front with a message naming the bulk
  endpoint as the fix. This keeps the pathological case from silently becoming a 5-minute
  hanging request, and turns "is Option A enough?" into observable evidence instead of a guess.
- **Ordering**: creation is sequential and parent-before-child — a child needs its parent's
  server-assigned ID. No concurrency in the first slice.
- **Partial failure is a product feature, not an error path**: a mid-import failure leaves the
  successfully-created subtree in place and shows an explicit list of failed items with their
  reason and a "retry failed items" action. No fake rollback, no silent truncation.
- **Parsing is client-side TypeScript** via `DOMParser` on the uploaded file's text (the
  A/B-orthogonal choice the exploration left open). Keeps the whole feature inside admin-web
  and adds zero backend surface. The file never leaves the browser except as normal create
  calls.
- **Fast-follow trigger, stated now**: if a real import hits the 500 ceiling, or wall-clock
  import time exceeds ~30s, cut the transactional `POST /workspaces/{id}/bookmarks/import`
  (Option B) as its own change.

### B — Drag-and-drop: `@dnd-kit`, confirmed

`@dnd-kit/core` + `@dnd-kit/sortable`. `react-beautiful-dnd` is unmaintained; `react-dnd` has
no comparable accessibility story. Accessibility is an **explicit task, not an afterthought**:
`KeyboardSensor` and `announcements`/live-region wiring are in scope for this change, because
`@dnd-kit`'s defaults ship mouse/touch-only.

### C — Route: query param `/bookmarks?workspace={id}`, confirmed

Matches the existing `/access?workspace={id}` convention; `router.tsx` has no nested
path-param route anywhere (`/invitations/:token` and `/s/:token` are top-level, outside the org
shell). Introducing the repo's first nested path-param route to gain nothing over the sibling
pattern is unjustified churn. Entry point: a per-row action from `WorkspacesPage`.

### D — `X-Sync-Event-Id` plumbing: a typed `syncEventId` option on `apiRequest`

Confirmed gap, not speculative: `client.ts:93` hardcodes `Idempotency-Key`, which the bookmark
routes ignore. The bookmark routes read `X-Sync-Event-Id` (`sync/types.go:13`); PATCH **400s**
without it, POST/DELETE silently mint a random one (`postgres.go:507-518`) and thereby lose
retry protection.

**Decision**: add `syncEventId?: string` to `RequestOptions` and one line beside the existing
one, `if (options.syncEventId) headers.set("X-Sync-Event-Id", options.syncEventId)`. Chosen
over the raw `headers` passthrough (which already works today) because the passthrough scatters
a magic header string across every call site in exactly the place the exploration showed is
easy to get wrong; a typed option keeps header-name knowledge in `client.ts` and makes omission
visible at the type level. The existing `idempotencyKey` option is untouched, and bookmark
calls will not pass it.

Every mutation in the new `admin-web/src/lib/api/bookmarks.ts` supplies a `syncEventId` from
the existing `useUncertainCreationKey` hook — its `keyFor(intent)` / `confirm` /
`retainAfterFailure` semantics (retain the key only when the server never answered) are exactly
right for sync event IDs, and `newIdempotencyKey()` is a plain UUID generator, so no rename is
needed. Because `confirm` releases the key on success, a repeated identical drag mints a fresh
event ID and is not falsely deduped.

### E — Stale tree: manual refetch + last-write-wins, no concurrency control

The backend has no `updated_at`/version compare, so real optimistic concurrency would be a
backend change — out of proportion for a low-concurrency internal surface where the realistic
collision is one admin against one extension. **Decision**: no version guard. Three cheap
guards instead:

1. Every mutation invalidates and refetches the tree; the rendered order always comes from the
   server's recomputed positions, never from retained local optimistic state. This directly
   defuses the exploration's "stale drag produces confusing final order" hazard.
2. Refetch on window focus, on this page only.
3. A visible "Updated HH:MM" stamp with a manual Refresh control.

### F — Destructive-action confirmations state the blast radius

Folder delete cascades to all descendants server-side, so it reuses `ConfirmByTyping` (same as
workspace delete). Confirmation copy states plainly that the change applies immediately to
every synced browser — the only in-product mitigation available for Decision G.

### G — In-extension admin-edit attribution: deferred, named

The extension has no activity UI of its own (only `options/secret-history.ts`), so surfacing
"an admin changed this" is not a label — it is building an in-extension activity surface, which
is its own product slice with its own design questions. Deferring is safe because the
attributed data already exists server-side (`activity_events` via the bookmark-activity-audit
change); nothing here makes it harder to add later. Recorded as a real risk below, not dropped.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `admin-web/src/features/bookmarks/**` | New | Tree page, tree/node components, edit + delete + import flows, `queries.ts`/`mutations.ts` modeled on `features/workspaces` |
| `admin-web/src/lib/api/bookmarks.ts` | New | Tree read + folder/bookmark PATCH/POST/DELETE, each passing `syncEventId` |
| `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.ts` | New | `DOMParser`-based `bookmarks.html` → node tree |
| `admin-web/src/lib/api/client.ts` | Modified | `syncEventId?: string` option → `X-Sync-Event-Id`; `idempotencyKey` untouched |
| `admin-web/src/app/router.tsx` | Modified | `/bookmarks` route under the org shell |
| `admin-web/src/features/workspaces/WorkspacesPage.tsx` | Modified | Row action linking to `/bookmarks?workspace={id}` |
| `admin-web/package.json` | Modified | `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |
| `backend/**` | Unchanged | Deliberate non-goal — no endpoint, schema, or authorization change |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| DnD ships mouse/touch-only | Med | `KeyboardSensor` + live-region announcements are explicit in-scope tasks, not polish |
| Import exceeds Option A's practical limit | Med | 500-node ceiling with a clear message; stated fast-follow trigger for the bulk endpoint |
| Partial import leaves a half-built tree | Med | Explicit failed-item list + retry action; no fake atomicity claimed anywhere in the UI |
| Users see bookmarks change with no in-browser explanation (Decision G) | High | Admin-side confirmation copy states the live blast radius; in-extension attribution deferred as a named follow-up |
| Large tree renders slowly (no pagination or depth limit on `GetTree`) | Med | Import ceiling bounds the worst case admin-web can create; virtualization/lazy expansion is a design-phase call, deferred if not needed |
| Last-write-wins clobbers a concurrent extension move | Low | Post-mutation refetch makes the server order authoritative and visible immediately; accepted for an internal low-concurrency surface |
| Org admin sees an empty page because they hold no workspace grant | Med | Detect the 403 and point at the existing self-grant flow rather than rendering a bare error |

## Rollback Plan

Revert the branch. The change is admin-web-only plus a two-line additive option in `client.ts`;
there is no migration, no schema change, and no altered backend contract, so reverting restores
the previous console exactly. **Caveat, stated honestly**: reverting the code does not undo
bookmarks already created by an import — those are ordinary rows that must be removed through
the UI or the extension, the same as any user-created bookmark.

## Dependencies

- New npm deps: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.
- The acting admin must hold `editor` or `admin` on the target workspace; obtainable through the
  already-shipped `AccessGrantForm`/`AccessPage` flow. No new backend authorization.
- Gitflow: work continues on `feature/workspace-bookmark-management`, cut from `develop`,
  targeting `develop`. No new branches or merges in this change.
- Documentation impact: this proposal plus spec/design/tasks under
  `openspec/changes/workspace-bookmark-management/`; two new capability specs in
  `openspec/specs/` on archive.

## Success Criteria

- [ ] An admin with an editor grant can open `/bookmarks?workspace={id}` and see the workspace's
      full nested folder/bookmark tree.
- [ ] Rename, URL edit, and delete each succeed and are reflected in a connected extension
      without a manual extension refresh.
- [ ] Every admin-web bookmark mutation sends a deliberate `X-Sync-Event-Id`; no PATCH 400s for
      a missing header, and a retried mutation creates no duplicate.
- [ ] Reorder and reparent work with a mouse **and** with the keyboard, with screen-reader
      announcements.
- [ ] A folder delete confirmation states the cascade and the live blast radius before applying.
- [ ] Importing a real browser export under 500 nodes produces a matching tree; an induced
      mid-import failure shows exactly which items failed and offers a retry.
- [ ] An admin can create a new folder (inside a workspace or another folder) and a new
      bookmark (inside a folder) without going through import.
- [ ] Tree order after any mutation matches the server, not retained local state.
- [ ] Zero backend files changed.

## Proposal question round

Run with the user directly after this proposal was drafted. Answers:

1. **Import size (500-node ceiling)**: confirmed as proposed.
2. **URL editing included in "rename"**: confirmed as proposed.
3. **Drag-and-drop scope**: confirmed as proposed — reorder within a folder, move to another
   folder via drag, and delete are the three actions in scope ("lo típico que se hace en estos
   casos"). Delete itself is a button/confirm action (`ConfirmByTyping`, Decision F), not a
   drag gesture — dragging is reorder/reparent only, consistent with the original approach; the
   user's answer confirms the *set* of actions expected on a bookmark (reorder, move, delete),
   not a request for a fourth drag-to-delete interaction.
4. **Manual single-item create**: overridden — the user confirmed a real need to add one
   bookmark/folder without going through an import file ("puede darse el caso de necesitar
   crear el favorito"). Moved from Out of Scope into In Scope (see above); no backend change
   required since `CreateFolder`/`CreateBookmark` already exist and `bookmarks.ts`/`mutations.ts`
   were already going to wire POST support for import's sake.
5. **Decision G deferral (no in-extension attribution)**: confirmed acceptable for this slice.
