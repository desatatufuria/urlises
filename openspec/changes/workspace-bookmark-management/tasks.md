# Tasks: Workspace Bookmark Management (admin-web)

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~2,750–2,850 pre-overrun across 27 files (see basis table below); this session has no established overrun sample for admin-web-only work yet, but comparable recent changes ran +40–60% over pre-estimate, putting actuals at roughly ~3,900–4,500 total |
| 400-line budget risk | **High** — every one of the 4 design-proposed slices individually exceeds 400 lines pre-overrun; `treeModel.ts`+`treeModel.test.ts` alone (~475) and `BookmarksPage.test.tsx` alone (~350) are single-file risk concentrations |
| Chained PRs recommended | Yes |
| Suggested split | 4 work units, matching design.md's own proposed chain: A (foundation + read-only tree) → B (mutations + panels) → C (`treeModel.ts` + DnD) → D (import) |
| Delivery strategy | ask-on-risk (cached this session) |
| Chain strategy | **pending** — recommend `feature-branch-chain` (matches this repo's recent convention for High-risk changes and fits design.md's hard sequencing edges) but not yet confirmed by the user |

Decision needed before apply: Yes (ask-on-risk requires confirming the A→B→C→D split and the chain strategy before `sdd-apply` starts any unit)
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### No DB-backed integration tests in this change

Backend is explicitly unchanged (design.md, proposal.md: zero backend files touched, zero migrations). Every test task below is a `vitest`+`jsdom` admin-web test with no Postgres dependency, and is expected to **actually pass in this sandbox**, not skip. There is no Strict-TDD DB-skip case to carry forward for this change.

### Estimate basis (design.md File Changes table, grouped by work unit)

| File | Action | Unit | Est. lines |
|---|---|---|---|
| `admin-web/src/lib/api/client.ts` | Modify | A | ~7 |
| `admin-web/src/lib/api/client.test.ts` | Modify | A | ~35 |
| `admin-web/src/lib/api/queryKeys.ts` | Modify | A | ~3 |
| `admin-web/src/lib/api/bookmarks.ts` | Create | A | ~125 |
| `admin-web/src/features/bookmarks/queries.ts` | Create | A | ~45 |
| `admin-web/src/features/bookmarks/BookmarksPage.tsx` (read-only shell) | Create | A | ~110 |
| `admin-web/src/features/bookmarks/BookmarkTree.tsx` (plain recursive render) | Create | A | ~60 |
| `admin-web/src/features/bookmarks/BookmarksPage.test.tsx` (read-only slice) | Create | A | ~140 |
| `admin-web/src/app/router.tsx` | Modify | A | ~4 |
| `admin-web/src/features/workspaces/WorkspacesPage.tsx` | Modify | A | ~4 |
| `admin-web/src/features/bookmarks/mutations.ts` | Create | B | ~135 |
| `admin-web/src/features/bookmarks/FolderForm.tsx` | Create | B | ~55 |
| `admin-web/src/features/bookmarks/BookmarkForm.tsx` | Create | B | ~65 |
| `admin-web/src/features/bookmarks/TreeRow.tsx` (menu, no DnD yet) | Create | B | ~85 |
| `admin-web/src/features/bookmarks/BookmarksPage.tsx` (panels wiring, delta) | Modify | B | ~65 |
| `admin-web/src/features/bookmarks/BookmarksPage.test.tsx` (mutation cases, delta) | Modify | B | ~150 |
| `admin-web/src/lib/bookmarks/treeModel.ts` | Create | C | ~200 |
| `admin-web/src/lib/bookmarks/treeModel.test.ts` | Create | C | ~275 |
| `admin-web/src/features/bookmarks/dnd/collision.ts` | Create | C | ~45 |
| `admin-web/src/features/bookmarks/dnd/announcements.ts` | Create | C | ~35 |
| `admin-web/src/features/bookmarks/BookmarkTree.tsx` (DnD rework, delta) | Modify | C | ~105 |
| `admin-web/src/features/bookmarks/TreeRow.tsx` (useSortable/useDroppable, delta) | Modify | C | ~50 |
| `admin-web/src/features/bookmarks/mutations.ts` (`useMoveNodeMutation`, delta) | Modify | C | ~30 |
| `admin-web/src/features/bookmarks/BookmarksPage.test.tsx` (keyboard/cycle cases, delta) | Modify | C | ~60 |
| `admin-web/src/lib/ui/tokens.css` | Modify | C | ~70 |
| `admin-web/package.json` | Modify | C | ~3 |
| `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.ts` | Create | D | ~135 |
| `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.test.ts` | Create | D | ~175 |
| `admin-web/src/lib/bookmarks/importPlan.ts` | Create | D | ~70 |
| `admin-web/src/lib/bookmarks/importPlan.test.ts` | Create | D | ~135 |
| `admin-web/src/features/bookmarks/useImportRunner.ts` | Create | D | ~165 |
| `admin-web/src/features/bookmarks/ImportPanel.tsx` | Create | D | ~165 |
| `admin-web/src/features/bookmarks/ImportProgressBanner.tsx` | Create | D | ~55 |
| `admin-web/src/features/bookmarks/BookmarksPage.test.tsx` (import cases, delta) | Modify | D | ~100 |

### Suggested Work Units

| Unit | Goal | Branch | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| A | `syncEventId` transport, `lib/api/bookmarks.ts`, read-only tree page, route + entry link | `feat/workspace-bookmarks-foundation` off `feature/workspace-bookmark-management` | PR 1 | `cd admin-web && npm test -- client bookmarks BookmarksPage` | `npm run dev`; open `/bookmarks?workspace={id}` as an editor and as a no-grant admin, confirm tree render vs. self-grant CTA | `client.ts` (additive `syncEventId` option only), `features/bookmarks/**`, `router.tsx`, `WorkspacesPage.tsx` row action; revert removes the page and link with zero effect on any other route |
| B | Mutation hooks + create/rename/edit/delete panels | `feat/workspace-bookmarks-mutations` off `feat/workspace-bookmarks-foundation` | PR 2, base = A | `cd admin-web && npm test -- mutations BookmarksPage` | `npm run dev`; rename a folder, edit a bookmark's title+URL, create a folder/bookmark, delete both with confirmation | `features/bookmarks/{mutations.ts,FolderForm.tsx,BookmarkForm.tsx,TreeRow.tsx}`; revert restores the read-only tree from A with no data loss |
| C | `treeModel.ts` (pure) + `@dnd-kit` wiring (pointer + `Alt+Arrow` keyboard) | `feat/workspace-bookmarks-dnd` off `feat/workspace-bookmarks-mutations` | PR 3, base = B | `cd admin-web && npm test -- treeModel BookmarksPage` | Real-browser manual checklist (Phase C2.10) — jsdom cannot exercise pointer/collision layout, see Testing Strategy gap in design.md | `lib/bookmarks/treeModel.ts`, `features/bookmarks/{dnd/**,BookmarkTree.tsx,TreeRow.tsx}` (DnD delta only), `package.json` dnd-kit deps; revert restores B's non-draggable tree, reorder/reparent become unavailable but rename/edit/delete/create keep working |
| D | Netscape parser + import plan + import UI + retry | `feat/workspace-bookmarks-import` off `feat/workspace-bookmarks-dnd` | PR 4, base = C | `cd admin-web && npm test -- parseNetscapeBookmarks importPlan BookmarksPage` | `npm run dev`; import a real Chrome/Firefox `bookmarks.html` export under 500 nodes, induce a mid-import failure, confirm retry | `lib/bookmarks/{parseNetscapeBookmarks.ts,importPlan.ts}`, `features/bookmarks/{useImportRunner.ts,ImportPanel.tsx,ImportProgressBanner.tsx}`; revert removes the "Import file" affordance only, no effect on manual CRUD or DnD |

Each unit is developed, tested, and merged into the previous unit's branch before the next unit's branch is created. Only the tracker branch `feature/workspace-bookmark-management` eventually merges to `develop`, and only when the user says so.

## Phase A1: Transport — `syncEventId`

- [x] A1.1 RED: `admin-web/src/lib/api/client.test.ts` — `apiRequest` sets `X-Sync-Event-Id` only when `options.syncEventId` is passed; asserts it is independent of (never conflated with) `Idempotency-Key`.
- [x] A1.2 GREEN: `admin-web/src/lib/api/client.ts` — add `SYNC_EVENT_ID_HEADER = "X-Sync-Event-Id"` const, `syncEventId?: string` on `RequestOptions` with the doc comment from design.md, `headers.set(...)` line beside the existing `idempotencyKey` line (`:93`).

## Phase A2: API Layer — types, tree read, mutation signatures

- [x] A2.1 GREEN: `admin-web/src/lib/api/queryKeys.ts` — add `queryKeys.workspace(id).tree = ["workspaces", id, "tree"] as const`.
- [x] A2.2 GREEN: `admin-web/src/lib/api/bookmarks.ts` (new) — `BookmarkNode`/`FolderNode`/`WorkspaceTree` types (`parentId` normalized `?? null` everywhere per design's `NOTE`); `getWorkspaceTree`; the 6 mutation functions (`createFolder`, `updateFolder`, `deleteFolder`, `createBookmark`, `updateBookmark`, `deleteBookmark`), each requiring `syncEventId` as the last positional argument (Decision 2 — no default); PATCH bodies built key-by-key, never spread (`undefined` keys must drop, explicit `null` must survive).

## Phase A3: Read-Only Tree Page (first independently shippable slice)

- [x] A3.1 RED: `admin-web/src/features/bookmarks/BookmarksPage.test.tsx` (new) — renders the full nested folder/bookmark tree from a mocked `GET /workspaces/{id}/tree`, in server order. *(Spec: Workspace Tree Read — "Admin with a workspace grant sees the full tree")*
- [x] A3.2 RED: same — `status === 403` shows a "no grant" state with a link to `/access?workspace={id}`, never a generic error. *(Spec: "No workspace grant is detected and redirected")*
- [x] A3.3 RED: same — `status === 404` shows distinct copy from the 403 case; neither status is retried (mock `fetch` call count).
- [x] A3.4 RED: same — `workspace.role === "viewer"` renders zero create/edit/delete/drag-handle affordances (Decision 12 read-only mode).
- [x] A3.5 RED: same — clicking manual Refresh refetches and advances the "Updated HH:MM" stamp (fake timers + `treeQuery.dataUpdatedAt`). *(Spec: "Manual refresh updates the tree and the timestamp")*
- [x] A3.6 RED: same — a `window` `focus` event triggers a refetch of the tree query. *(Spec: "Window focus triggers a refetch")*
- [x] A3.7 GREEN: `admin-web/src/features/bookmarks/queries.ts` (new) — `useWorkspaceTree` with `staleTime: 0`, `refetchOnWindowFocus: true`, and `retry` that never retries `403`/`404`, per design's exact implementation.
- [x] A3.8 GREEN: `admin-web/src/features/bookmarks/BookmarksPage.tsx` (new, read-only shell) — header (workspace name, role badge, "Updated HH:MM" derived from `dataUpdatedAt`, Refresh control), the three 403/404/viewer states, notice banner (matches `WorkspacesPage` pattern).
- [x] A3.9 GREEN: `admin-web/src/features/bookmarks/BookmarkTree.tsx` (new, plain recursive renderer — no `flattenTree`, no `@dnd-kit`; both land in Unit C per design's hard sequencing) — nested `<ul>`/`<li>` from `FolderNode[]`, expand/collapse `useState<Set<string>>`.
- [x] A3.10 RED: `admin-web/src/app/router.test.tsx` (extend, if present, else new) — `/bookmarks` is unreachable anonymously and without an admin org; missing/invalid `?workspace=` renders "no workspace selected", never a crashed page. *(Threat Matrix: Routing — new client route)*
- [x] A3.11 GREEN: `admin-web/src/app/router.tsx` — add `{ path: "bookmarks", element: <BookmarksPage /> }` under `AdminLayout`. No nav entry (Decision 3, matches `/access`).
- [x] A3.12 RED: `admin-web/src/features/workspaces/WorkspacesPage.test.tsx` (extend) — the bookmarks row action for workspace W links to `/bookmarks?workspace=W`. *(Spec: "Entry point carries the correct workspace id")*
- [x] A3.13 GREEN: `admin-web/src/features/workspaces/WorkspacesPage.tsx` — add `<Link to={\`/bookmarks?workspace=${id}\`}>Bookmarks</Link>` beside "Manage access".
- [x] A3.14 RED: same as A3.2 — asserts the 403 code path issues **no** client-side authorization decision of its own (Threat Matrix: Authorization/IDOR — `?workspace=` is attacker-controllable by design; the page never gates on it itself).

## Phase B1: Mutation Hooks

- [ ] B1.1 GREEN: `admin-web/src/features/bookmarks/mutations.ts` (new) — `useCreateFolderMutation`, `useUpdateFolderMutation`, `useDeleteFolderMutation`, `useCreateBookmarkMutation`, `useUpdateBookmarkMutation`, `useDeleteBookmarkMutation`; each uses `useUncertainCreationKey`'s `keyFor`/`confirm`/`retainAfterFailure`, and `onSettled` invalidates `queryKeys.workspace(workspaceId).tree`. (`useMoveNodeMutation` lands in Unit C.)

## Phase B2: Rename / Edit / Delete

- [ ] B2.1 RED: `BookmarksPage.test.tsx` (extend) — renaming folder F sends one PATCH with a deliberate `X-Sync-Event-Id`, and F shows the new name after refetch. *(Spec: "Folder rename succeeds")*
- [ ] B2.2 RED: same — editing a bookmark's title and URL together sends a **single** PATCH carrying both fields. *(Spec: "Bookmark title and URL are edited together")*
- [ ] B2.3 RED: same — folder delete opens `ConfirmByTyping` stating the cascade and live blast radius (verbatim copy from design.md); cancel sends no DELETE. *(Spec: "Folder delete cascades and requires typed confirmation" / "Cancelling a delete confirmation sends no request")*
- [ ] B2.4 RED: same — bookmark delete requires confirmation before any DELETE; confirming removes only that bookmark. *(Spec: "Bookmark delete requires confirmation")*
- [ ] B2.5 GREEN: `admin-web/src/features/bookmarks/FolderForm.tsx` (new) — name field, shared by create and rename.
- [ ] B2.6 GREEN: `admin-web/src/features/bookmarks/BookmarkForm.tsx` (new) — title + URL fields, shared by create and edit.
- [ ] B2.7 GREEN: `admin-web/src/features/bookmarks/TreeRow.tsx` (new, no `@dnd-kit` yet) — folder rows carry a `DropdownMenu` (*Add folder inside / Add bookmark inside / Rename / Delete*); bookmark rows carry *Edit / Delete*.
- [ ] B2.8 GREEN: `BookmarksPage.tsx` — wire `ContextPanels` keyed off `?panel=`/`?node=`/`?parent=` using the **updater form** of `setSearchParams` only (never the object form, which would drop `?workspace=`); page-level "New folder" button (mandatory for an empty workspace with no row to hang a per-folder menu on).

## Phase B3: Manual Create

- [ ] B3.1 RED: `BookmarksPage.test.tsx` (extend) — creating a folder with no selected parent lands at the workspace root and appears after refetch. *(Spec: "Folder created at workspace root")*
- [ ] B3.2 RED: same — creating a folder with an existing folder F as parent appears as F's child after refetch. *(Spec: "Folder created nested inside another folder")*
- [ ] B3.3 RED: same — creating a bookmark with title+URL inside folder F appears as F's child after refetch. *(Spec: "Bookmark created inside a folder")*
- [ ] B3.4 GREEN: confirm B3.1–B3.3 pass against B1.1/B2.5–B2.8 with no further production changes.

## Phase C1: `treeModel.ts` (pure — the automated coverage centre)

- [ ] C1.1 RED: `admin-web/src/lib/bookmarks/treeModel.test.ts` (new) — `flattenTree`: depth-first nesting order, folders-before-bookmarks within each parent, per-group `index === server position`, collapsed folders contribute their own row and no descendants, `parentId` absent ⇒ workspace root.
- [ ] C1.2 GREEN: `admin-web/src/lib/bookmarks/treeModel.ts` (new) — `FlatRow`, `flattenTree`.
- [ ] C1.3 RED: same — **the single highest-value test in the change**: `planDrop` same-group reorder — `position === overRow.index` for every `(from, to)` pair of a 4-item group, cross-checked against a local `arrayMove` port and a local port of the server's `insertAt`.
- [ ] C1.4 RED: same — `planDrop` cross-group reparent sets `parentChanged: true` and inserts before the hovered row (fixture: two sibling folders).
- [ ] C1.5 GREEN: `treeModel.ts` — `DropTarget`, `MovePlan`, `planDrop`.
- [ ] C1.6 RED: same — `isLegalTarget` table-driven: cross-type row rejected, self rejected, folder→own-descendant rejected, `into`-own-current-parent rejected, bookmark→`into-root` rejected.
- [ ] C1.7 GREEN: `treeModel.ts` — `isLegalTarget`, consumed identically by the collision filter (C2) and the keyboard planner.
- [ ] C1.8 RED: same — `planKeyboardMove` for `up`/`down`/`indent`/`outdent` produces **byte-identical `MovePlan`s** to the equivalent `planDrop` call — the structural proof of "keyboard achieves the same outcome as a mouse drag". *(Spec: "Keyboard-only reorder moves an item")*
- [ ] C1.9 GREEN: `treeModel.ts` — `MoveCommand`, `planKeyboardMove` (`Alt+↑/↓` reorder within sibling group; `Alt+←` outdent to grandparent, refused when parent is a root folder for a bookmark; `Alt+→` indent into the preceding folder sibling).
- [ ] C1.10 GREEN: `treeModel.ts` — `describeMovePlan`, one function consumed by both the dnd-kit `announcements` object and the keyboard path's own `aria-live` text. *(Spec: "Screen reader announces the move outcome")*

## Phase C2: DnD Wiring

- [ ] C2.1 GREEN: `admin-web/package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.
- [ ] C2.2 GREEN: `admin-web/src/features/bookmarks/dnd/collision.ts` (new) — `legalTargets(closestCenter)`: filters `args.droppableContainers` by `isLegalTarget` **before** collision runs, so an illegal target is never reported as `over` (Decision 6).
- [ ] C2.3 GREEN: `admin-web/src/features/bookmarks/dnd/announcements.ts` (new) — dnd-kit `announcements` built on `describeMovePlan`.
- [ ] C2.4 GREEN: `BookmarkTree.tsx` (rework) — one flat `SortableContext(flatRowKeys, verticalListSortingStrategy)` over `flattenTree`'s output inside the existing nested `<ul>` markup; `DndContext` with pointer + `KeyboardSensor`; `aria-live="polite"` region; `RootDropZone` (`useDroppable("into-root")`, folders only, visible only while dragging); `DragOverlay`. No optimistic state retained anywhere (Decision 10).
- [ ] C2.5 GREEN: `TreeRow.tsx` (extend) — `useSortable({id: rowKey})`; folder rows also `useDroppable({id: "into:" + id})`; drag handle button carries both dnd-kit listeners and the `Alt+Arrow` `onKeyDown` handler (never colliding with `KeyboardSensor`'s space-to-lift).
- [ ] C2.6 GREEN: `mutations.ts` (extend) — `useMoveNodeMutation`: branches `updateFolder`/`updateBookmark` on `plan.type`, sends `parentId`/`folderId` only when `plan.parentChanged`, `onSettled` (not `onSuccess` — a rejected move must still resync) invalidates the tree.
- [ ] C2.7 RED: `BookmarksPage.test.tsx` (extend) — `Alt+↓` on a row's drag handle issues the expected PATCH and updates the `aria-live` region text. *(Spec: "Keyboard-only reorder moves an item")* — the keyboard path is fully testable in jsdom precisely because it is coordinate-free.
- [ ] C2.8 RED: same — a rejected move (mocked 400, cycle-guard message) surfaces the server message **and** still triggers a refetch via `onSettled`. *(Spec: "A cycle-producing move is rejected and shown")*
- [ ] C2.9 GREEN: `admin-web/src/lib/ui/tokens.css` — `.ui-tree*` single-line/ellipsis rows (required for uniform row height, Decision 7), indent, drop indicator, into-zone highlight, `.ui-visually-hidden` for the live region.
- [ ] C2.10 **MANUAL VERIFICATION CHECKLIST — mandatory, real browser only.** jsdom returns zeroed `getBoundingClientRect`; `@dnd-kit`'s collision/coordinate/pointer paths are structurally unverifiable in this repo's vitest+jsdom harness (design.md Testing Strategy, "Not covered" row). `treeModel.ts` is unit-tested exhaustively (C1) specifically so this checklist is the *only* uncovered surface:
  - [ ] Pointer drag reorders two sibling bookmarks within a folder; final order matches the server after refetch.
  - [ ] Pointer drag reparents a bookmark by dropping it onto a folder's into-zone; it becomes that folder's child.
  - [ ] Drop-indicator placement visually matches the row the pointer is hovering.
  - [ ] `DragOverlay` renders the dragged row's label while dragging.
  - [ ] `KeyboardSensor` space-to-lift + arrow-key drag emulation works end to end (registered per Decision 8, not the guaranteed path, but not dead code either).
  - [ ] Screen reader (NVDA or VoiceOver) audibly announces the outcome of both a pointer drop and an `Alt+Arrow` move.
  - [ ] Dragging a folder onto its own descendant is visually refused (no drop indicator ever appears there), consistent with `isLegalTarget`'s client-side filter.

## Phase D1: Netscape Bookmarks Parser

- [ ] D1.1 RED: `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.test.ts` (new) — a real Chrome export fixture parses into a node tree whose nesting matches the source file. *(Spec: "Valid Netscape export parses into a matching node tree")*
- [ ] D1.2 RED: same — nested `<DL>` **inside** `<DT>` and nested `<DL>` **as a sibling of** `<DT>` both parse identically (both shapes are real per the HTML5 tree-construction note in design.md).
- [ ] D1.3 RED: same — 3-level nesting; `<DD>`/`<H1>`/`<META>`/`PERSONAL_TOOLBAR_FOLDER`/`ADD_DATE`/`ICON` are ignored; empty title falls back to the URL.
- [ ] D1.4 RED: same — `javascript:`, `place:`, `data:`, `chrome://`, and missing `href` all land in `skipped` with the correct `reason`, never in `roots`/`nodeCount`. *(Threat Matrix: XSS via bookmark href)*
- [ ] D1.5 RED: same — non-bookmark HTML (no `<dl>`) throws `BookmarkParseError`; a `<dl>` with zero nodes throws. *(Spec: "Malformed file is rejected before any create call")*
- [ ] D1.6 RED: same — a fixture containing `<script>` and an `onerror`-bearing `<img>` never executes and inserts no node into the live document (`DOMParser` output is never attached to `document`). *(Threat Matrix: Untrusted HTML parsing)*
- [ ] D1.7 GREEN: `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.ts` (new) — `parseList`/`:scope > dt` direct-child scoping, `h3`⇒folder / `a`⇒bookmark, `isImportableUrl` scheme filter, monotonic `n0, n1, …` keys.

## Phase D2: Import Plan

- [ ] D2.1 RED: `admin-web/src/lib/bookmarks/importPlan.test.ts` (new) — `toImportPlan` emits strict pre-order: every item's `parentKey` appears earlier in the array than the item itself.
- [ ] D2.2 GREEN: `admin-web/src/lib/bookmarks/importPlan.ts` (new) — `ImportItem`, `toImportPlan` (pre-order DFS).
- [ ] D2.3 RED: same — a 500-node plan is allowed; a 501-node plan is refused and issues **zero** `fetch` calls (assert on mocked call count, not a flag). *(Spec: "Import at exactly 500 nodes proceeds" / "Import over 500 nodes is refused up front")*
- [ ] D2.4 RED: same — a mid-run failure at node K preserves nodes created before K, continues attempting independent subsequent nodes, and records K's children with `cause: "missing-parent"` **without issuing a request** for them. *(Spec: "Mid-import failure preserves prior successes" / "Children of a failed parent are listed as failed, not attempted")*
- [ ] D2.5 RED: same — retry re-attempts only `failures`-keyed items in original pre-order, `createdIds` retained so an already-created folder is never duplicated, a now-succeeding item leaves the failure list, a re-failing item stays with a possibly-updated reason. *(Spec: "Retry re-attempts only the failed set" / "Repeated retry failure keeps the item listed")*
- [ ] D2.6 GREEN: `importPlan.ts` — `ImportFailure`, `ImportRunState`, retry mechanics (`retryFailed()` filters the *original* plan by `failures`, never re-runs the whole plan).

## Phase D3: Import UI

- [ ] D3.1 GREEN: `admin-web/src/features/bookmarks/useImportRunner.ts` (new) — reducer + sequential run loop (one in-flight `POST` at a time, parent-before-child, no `position` sent per Decision 15), `retryFailed`; event ids from `keyFor({nodeKey})` (Decision 14).
- [ ] D3.2 RED: `BookmarksPage.test.tsx` (extend) — a file whose parsed plan exceeds 500 nodes shows a refusal naming the bulk import endpoint, before any `fetch` call. *(Spec: "Import over 500 nodes is refused up front")*
- [ ] D3.3 RED: same — destination is the workspace root **and** the file has top-level bookmarks ⇒ import is blocked pre-flight with the exact copy from design.md, zero calls issued. *(Deviation 1 / Decision 17 — root-level bookmarks in an import file)*
- [ ] D3.4 RED: same — the import preview renders parsed-but-not-yet-created URLs as **text**, never as an anchor, even for a fixture containing a crafted `<script>`/`onerror` entry. *(Threat Matrix: XSS via bookmark href, component level; Decision 20)*
- [ ] D3.5 RED: same — closing the import panel (`?panel=` cleared) mid-run does **not** abort it; reopening shows the same in-progress state. *(Decision 19 — `useImportRunner()` ownership)*
- [ ] D3.6 GREEN: `admin-web/src/features/bookmarks/ImportPanel.tsx` (new) — file input, destination picker (workspace root or any existing folder), the two pre-flight checks (D3.2/D3.3), preview, failure list, "Retry failed items" action.
- [ ] D3.7 GREEN: `admin-web/src/features/bookmarks/ImportProgressBanner.tsx` (new) — `completed`/`total`, failure count, link back to the import panel.
- [ ] D3.8 GREEN: `BookmarksPage.tsx` (extend) — mount `useImportRunner()` at page level, "Import file" button, render `ImportProgressBanner` whenever a run is active or has failures.
- [ ] D3.9 RED: same — a successful import with no failures produces a tree, refetched from the server, matching the source file's nesting exactly. *(Spec: "Final tree structure matches the source file")*
- [ ] D3.10 RED: same — progress advances as each sequential create call resolves. *(Spec: "Progress advances as each item resolves")*

## Phase 5: Verification

- [ ] 5.1 `cd admin-web && npm run build && npm test` — full suite green. Every test above is `vitest`+`jsdom`, has no Postgres dependency, and is expected to **actually pass** in this sandbox (no skip expectation applies to this change).
- [ ] 5.2 `git diff --stat backend/` from the tracker branch — confirm empty. *(Success Criterion: "Zero backend files changed")*
- [ ] 5.3 Confirm every mutation in `bookmarks.ts`/`mutations.ts` passes `syncEventId` and none pass `idempotencyKey` (grep-level check across `features/bookmarks/**`). *(Success Criterion: "Every admin-web bookmark mutation sends a deliberate X-Sync-Event-Id")*
- [ ] 5.4 **MANUAL VERIFICATION CHECKLIST — real browser, end to end** (combines C2.10 with the full feature, against a real dev backend):
  - [ ] Rename, URL edit, and delete each reflect in a connected extension without a manual extension refresh.
  - [ ] A folder delete confirmation states the cascade and the live blast radius before applying.
  - [ ] Importing a real browser export under 500 nodes produces a matching tree; an induced mid-import failure shows exactly which items failed and offers a working retry.
  - [ ] An admin can create a new folder and a new bookmark without going through import.
  - [ ] Tree order after any mutation (mouse or keyboard) matches the server, never retained local state.
  - [ ] All items from Phase C2.10 (pointer drag, keyboard drag, screen-reader announcements, cycle-guard visual refusal).
