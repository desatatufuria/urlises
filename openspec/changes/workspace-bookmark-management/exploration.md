# Exploration: workspace-bookmark-management

## Current State

**Nothing exists in admin-web today for this.** `admin-web/src/features/*` covers organizations, members, groups, workspaces (as containers), access grants, activity, secrets, and trash — no feature renders a workspace's actual bookmark/folder tree, and no admin-web page today renders nested/recursive data at all (everything goes through the flat `Table` component).

**Backend CRUD + reorder already exists and is solid.** `backend/internal/bookmarks/service.go`: `CreateFolder`/`UpdateFolder`/`DeleteFolder` (soft-delete cascades recursively to descendant folders and their bookmarks via `WITH RECURSIVE`, L290-350), `CreateBookmark`/`UpdateBookmark`/`DeleteBookmark`, cycle prevention via `ensureFolderNotDescendant` (L607-631), and position-based reordering via `reorderFolderSiblings`/`reorderBookmarkSiblings` (L645-727), both delegating to `insertAt(ids, movingID, requestedPosition)` (L745-765) — a slice-splice that clamps an arbitrary target index into range and rewrites every sibling's `position`. This is exactly the primitive a drag-and-drop reorder needs; no backend change required for reorder.

**Live routes are NOT `bookmarks.Service` directly — they're wrapped by the sync layer.** `backend/internal/sync/bookmark_routes.go` (`RegisterBookmarkRoutes`, wired in `cmd/api/main.go` L162) calls into `syncapi.Service` → `PostgresStore` (`backend/internal/sync/postgres.go`), which wraps `bookmarks.Service` and additionally: derives a sync `Metadata{EventID, OriginClientID, BaseCursor}`, writes an append-only `Envelope` event with a monotonic per-workspace cursor, and records an `activity.Kind{Folder,Bookmark}{Created,Updated,Deleted}` entry attributed to the caller. This is the same route surface the browser extension's sync protocol uses.

**Idempotency header — corrected from initial assumption.** The real header is `X-Sync-Event-Id` (`sync/types.go` L13), not `Idempotency-Key`, and it is only strictly required on the two PATCH routes (`PATCH /folders/{id}`, `PATCH /bookmarks/{id}`), which route through `httpapi.IdempotencyExecutor.ExecutePrepared` and 400 on an empty key. POST (create) and DELETE routes call `ensureEventID` (`postgres.go` L507-518), which silently generates a random ID if the header is absent — the request still succeeds, it just loses idempotency protection. This matters for admin-web: a naive create/delete mutation hook that doesn't deliberately set and reuse `X-Sync-Event-Id` gets no double-submit protection on retry (a timeout-retry on "create bookmark" could silently create two).

**Read endpoint already exists and returns a ready-to-render tree.** `GET /workspaces/{workspaceId}/tree` (`workspaces/handler.go` L118 → `workspaces/service.go` L601-659, gated by the cheap any-grant `GetAccessibleWorkspace` check) returns:

```go
type FolderNode struct {
    ID string; ParentID *string; Name string; Position int
    Folders   []FolderNode   // recursive children
    Bookmarks []BookmarkNode
}
type BookmarkNode struct { ID, FolderID, Title, URL string; Position int }
type TreeResponse struct { Workspace WorkspaceAccess; Folders []FolderNode }
```

`buildFolderTree` (`service.go` L1083-1131) assembles this server-side into a fully nested structure — a tree component can consume `TreeResponse.Folders` directly, no client-side reshaping needed. One structural constraint: `bookmarks.folder_id` is `NOT NULL` (`migrations/000001_initial_schema.sql`) — there is no "root bookmark" concept; a bookmark must always live inside some folder, even a root-level one. `buildFolderTree` also silently drops any bookmark whose `folder_id` doesn't resolve to a live folder (covered by `TestBuildFolderTreeIgnoresBookmarksForUnknownFolders`).

**Auth model — confirmed, and the self-service path is real, not a workaround.** Mutations go through `bookmarks.Service.requireMutatingRole` → `access.RequireWorkspaceWriteAccess` → `loadWorkspaceGrants` (`access/service.go` L176-196), whose SQL has exactly two UNION branches: `workspace_user_access` (direct) and `workspace_group_access` (via group membership) — no org-admin branch. An org owner/admin has zero implicit read or write access to a workspace's bookmark tree until a grant row exists (confirmed by diffing against `workspaces.Service.ListByOrganization`, a *different* query that does add a third org-admin UNION branch, but only for the workspace-listing screen). However, `workspaces.Service.GrantUserAccess` (L315-336) is itself gated by `access.RequireOrganizationAdmin` — org scope, not workspace scope — so an org admin can always grant themselves editor/admin on any workspace in their org, via the already-built `AccessGrantForm.tsx`/`AccessPage.tsx` flow. **No backend authorization change is needed for this feature.** Minimum role for mutation is `editor`; `viewer` can read the tree but not mutate.

**No drag-and-drop library, no bulk-import anything.** `admin-web/package.json` has no `@dnd-kit/*`, `react-beautiful-dnd`, or `react-dnd`. No bulk-create backend endpoint exists (only single create), and no Netscape-bookmark-file (`<DL><DT><A>`) parser exists anywhere in this codebase.

## Affected Areas

- `backend/internal/bookmarks/service.go` — existing CRUD/reorder logic, reused as-is; no change for read+rename+delete+reorder.
- `backend/internal/sync/{bookmark_routes,service,postgres,types,headers}.go` — the actual route/idempotency/event layer admin-web must call into. No change needed for single-item ops; directly relevant to the bulk-import backend-shape decision below.
- `backend/internal/workspaces/{handler,service}.go` — the read-only tree endpoint, reusable unmodified.
- `backend/internal/httpapi/idempotency.go` — `ExecutePrepared`, relevant if a new bulk endpoint reuses the same primitive.
- `admin-web/src/lib/api/client.ts` — `apiRequest`'s `idempotencyKey` option (L93) hardcodes header name `Idempotency-Key`, which is the *wrong* header for bookmark mutations. A new `admin-web/src/lib/api/bookmarks.ts` must set `X-Sync-Event-Id` via the generic `headers` passthrough or a small `apiRequest` extension.
- `admin-web/src/lib/api/useUncertainCreationKey.ts` — the mutation-owned retry-key pattern to reuse for bookmark creates, pointed at the correct header.
- `admin-web/src/app/router.tsx` — no workspace-scoped nested route exists today; per-workspace deep links use query params (`/access?workspace={id}`), not path params. Open fork: follow that convention (`/bookmarks?workspace={id}`) or introduce the repo's first path-param route.
- `admin-web/src/lib/ui/components/{Table,DataState,FormRow,ContextPanel,ConfirmByTyping,DropdownMenu}.tsx` — existing primitives to compose; folder delete (cascades to descendants) should reuse `ConfirmByTyping`, same as workspace delete.
- `admin-web/src/features/workspaces/{queries,mutations}.ts` — the closest existing pattern for a new `features/bookmarks/{queries,mutations}.ts`.
- `backend/internal/websocket/hub.go` L96-106 — `Hub.Publish` already suppresses echo back to the originating `ClientID`; admin-web isn't a WebSocket subscriber, so an admin's edit always broadcasts live to any connected extension for that workspace with no origin-suppression edge case on the admin-web side.

## Approaches

### Axis 1 — bulk-import backend shape

1. **N sequential calls to existing single-create endpoints.** admin-web (or a thin parse step) walks the parsed `.html` tree top-down, issuing one `POST .../folders` or `POST .../bookmarks` per node.
   - Pros: zero backend endpoint changes; reuses the proven mutation path untouched; each item gets its own sync event/cursor/activity entry (correct per-item audit granularity); fastest to ship.
   - Cons: N round trips (a real browser export can be hundreds to thousands of nodes); no atomicity — a mid-import failure leaves a partial tree with no clean rollback, and the UI must show which items succeeded/failed; each POST needs a deliberately-set `X-Sync-Event-Id` to avoid duplicate creates on retry.
2. **New bulk/transactional backend endpoint** (e.g. `POST /workspaces/{id}/bookmarks/import`), inserting the whole parsed subtree in one DB transaction.
   - Pros: one round trip regardless of size; true atomicity; can emit a single coalesced sync event instead of hundreds; better UX for large imports.
   - Cons: new backend surface (service method, route, a bulk-appropriate event-emission strategy since the sync protocol's per-entity event model doesn't obviously generalize), new validation/limits (recursion depth, cycle safety, workspace scoping — currently enforced per-write, must be re-derived at the bulk layer).

Both options need a Netscape bookmark file parser somewhere (client TypeScript via `DOMParser`, or backend Go) — that choice is orthogonal to A vs. B.

### Axis 2 — drag-and-drop library

`@dnd-kit` is the recommended, current industry standard (accessible primitives available, actively maintained — `react-beautiful-dnd` is effectively unmaintained). No alternative was found with comparable accessibility support in this ecosystem. Accessibility is not free: `@dnd-kit`'s keyboard-sensor and screen-reader announcement primitives require deliberate wiring (`KeyboardSensor`, `announcements` config, live regions) — default drag-handle-only wiring ships mouse/touch-only.

### Axis 3 — route/navigation shape

1. Query-param convention (`/bookmarks?workspace={id}`) — consistent with the existing `AccessPage` pattern, zero new routing infrastructure.
2. Path-param route (`/workspaces/:workspaceId/bookmarks`) — more conventional REST-ish shape, but would be the first nested path-param route in this router.

## Recommendation

Not resolved here — exploration only. Recommend, for `sdd-propose` to confirm or override: bulk-import Option A (N sequential calls) for a first slice, with a visible partial-failure list in the UI rather than silent all-or-nothing, and Option B as an explicit fast-follow if real import sizes make N round trips unacceptable in practice; `@dnd-kit` for drag-and-drop with accessibility wiring as an explicit task, not an afterthought; and the query-param route convention (matches `AccessPage`, avoids introducing new routing shape for a first slice).

## Risks

- **Drag-and-drop accessibility**: must be deliberately wired (keyboard sensor, ARIA live-region announcements) or the reorder feature ships mouse/touch-only.
- **Large workspace tree performance**: `GetTree` has no pagination or depth limit — a workspace with thousands of bookmarks means one large JSON payload and a naive full-tree render. Virtualization or lazy per-folder expansion is a real design question, especially combined with bulk-import producing exactly this scenario.
- **Concurrent edit conflict — backend-safe, frontend must not assume it.** The backend correctly serializes reorders per parent scope and idempotency prevents double-apply of the exact same event, but there is no optimistic-concurrency check (`updated_at`/version compare) stopping an admin's `PATCH` from clobbering a concurrent extension-originated move of the same node — last-write-wins at the row level. A drag-and-drop reorder computed against a stale client-side tree can produce a confusing final order once the server recomputes positions against the *current* sibling list. Needs either a staleness guard or an explicit "someone else changed this, refresh" affordance; admin-web consumes no cursor/replay state today.
- **Bulk-import partial-failure UX** is a genuine product gap under Option A, independent of the technical choice — needs an explicit decision, not a default.
- **Zero in-browser attribution today**: the extension has no activity/audit UI of its own (only `options/secret-history.ts` for secrets) — it purely projects sync events onto the native bookmark tree. An admin's edit will silently rearrange a user's browser bookmarks with no in-extension indication an admin did it. Worth a product decision in `sdd-propose`, not a blocker.

## Ready for Proposal

Yes. Every load-bearing backend primitive (CRUD, reorder, tree read, org-admin self-grant path) is confirmed live and correct. `sdd-propose` must explicitly resolve: bulk-import backend shape (A vs. B), drag-and-drop library confirmation, route/navigation shape, `X-Sync-Event-Id` header plumbing through `apiRequest`, scope boundary (read+rename+delete+reorder+import only — export, search, and multi-select bulk-delete explicitly deferred, none have existing backend support), and whether this first slice needs any stale-tree/conflict guard or ships as manual-refetch/last-write-wins given this is a low-concurrency internal-admin surface.
