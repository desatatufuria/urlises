# Design: Workspace Bookmark Management (admin-web)

## Technical Approach

Four additive layers in `admin-web`, zero backend files touched.

**Transport.** One typed option (`syncEventId`) on `apiRequest`, and a new `lib/api/bookmarks.ts`
whose six mutation functions take `syncEventId` as a **required positional argument** — omission is a
compile error, not a silent random server-side event id.

**Model.** Two pure, DOM-free modules that carry all the hard logic and all the automated coverage:
`lib/bookmarks/treeModel.ts` (flatten the nested `TreeResponse` into rows; turn a drop or a keyboard
command into a single `MovePlan`) and `lib/bookmarks/parseNetscapeBookmarks.ts` + `importPlan.ts`
(`bookmarks.html` → node tree → pre-order create plan).

**Feature.** `features/bookmarks/` follows `features/workspaces/` exactly: `queries.ts` +
`mutations.ts` + a page composed from existing `lib/ui` primitives, with `?panel=` search-param
modals. The tree is a nested `<ul>` inside **one flat `SortableContext`**; pointer drags and keyboard
move commands both funnel into the *same* `MovePlan` → the *same* `useMoveNodeMutation`.

**Refetch.** No optimistic tree state anywhere. Every mutation `onSettled` invalidates the tree query;
the rendered order is always the server's recomputed order.

### Verified against source, correcting and sharpening the proposal

| Prior statement | Verified reality |
|---|---|
| Proposal: "tree DnD reorder **and** reparent" (no shape given) | **Two disjoint position spaces per parent, not one.** `folders.position` is scoped to `(workspace_id, parent_id)` and `bookmarks.position` to `(workspace_id, folder_id)`, reordered by separate helpers (`reorderFolderSiblings` `:645`, `reorderBookmarkSiblings` `:687`). A folder and a bookmark under the same parent can both hold `position = 0`. A single interleaved sortable list is therefore **unrepresentable**; drag targets must be type-segregated (Decision 5). |
| Proposal D: "add `syncEventId?: string` … one line beside the existing one" | **Confirmed exactly.** `client.ts:93` is `if (options.idempotencyKey) headers.set("Idempotency-Key", ...)`; the new line is its twin. `RegisterBookmarkRoutes` never reads `Idempotency-Key` — `MetadataFromRequest` (`sync/headers.go:14`) reads only `X-Sync-Event-Id`. `X-Client-Id` is already sent by `apiRequest` and becomes `metadata.OriginClientID`, so admin-web edits already broadcast correctly to extensions. |
| Proposal D: "`useUncertainCreationKey` … `retainAfterFailure` (retain the key only when the server never answered)" | **Confirmed, and the method name is inverted from its behaviour.** `useUncertainCreationKey.ts:22-24`: `retainAfterFailure` **deletes** the key when `error instanceof ApiError` (the server answered ⇒ mint a fresh id next time) and **keeps** it otherwise (network/timeout ⇒ reuse the same id so the server dedupes). Correct semantics, misleading name — do not "fix" it. |
| Proposal E: "Refetch on window focus, on this page only" | **`refetchOnWindowFocus: true` alone is a no-op here.** `main.tsx:20` sets a global `staleTime: 30_000`; React Query only refetches on focus when the query is *stale*. The tree query must **also** set `staleTime: 0` or focus refetch silently does nothing within 30s of the last fetch (Decision 11). |
| Proposal risk row: "Org admin sees an empty page because they hold no workspace grant … detect the 403" | **403 on `GET /tree` is structurally unambiguous.** `GetTree` → `GetAccessibleWorkspace` → `GetEffectiveWorkspaceAccess`; the only `ErrForbidden` source is `highestWorkspaceRole` returning it for an empty grant set (`access/service.go:245`). Missing/soft-deleted workspace ⇒ `ErrNotFound` ⇒ 404; auth ⇒ 401; anything else ⇒ 500 (`workspaces/handler.go:287`). `status === 403` on this endpoint means exactly "no grant" (Decision 12). |
| Proposal: viewer "can read the tree but not mutate" | **The tree response already carries the answer.** `TreeResponse.Workspace.Role` is the effective role, so the page can render **read-only mode** instead of buttons that are guaranteed to 403 (Decision 12). |
| Proposal A: import "creation is sequential and parent-before-child — a child needs its parent's server-assigned ID" | **True, plus a second independent reason.** `CreateFolderTx` inserts at `position 0` then calls `reorderFolderSiblings(..., input.Position)`; a nil `Position` appends (`insertAt` `:750`). So file order is reproduced *only* if creates are sequential and `position` is **not** sent. Concurrent creates would append in completion order (Decision 15). |
| Proposal (silent) on root-level bookmarks in an export file | **Gap found.** `bookmarks.folder_id` is `NOT NULL`; there is no workspace-root bookmark. A Netscape export can contain loose top-level `<DT><A>`. **Deviation 1 — this design adds a pre-flight destination check** rather than silently dropping them or inventing a container folder (Decision 17). |
| Proposal B: "`KeyboardSensor` … in scope" | **Kept, but not the load-bearing path.** jsdom returns zeroed `getBoundingClientRect`, so every dnd-kit collision/coordinate path is untestable in this repo's vitest harness. **Deviation 2 — the guaranteed keyboard path is explicit `Alt+Arrow` move commands** on the drag handle, sharing the planner with the pointer path (Decision 8). |

## Architecture Decisions

| # | Decision | Options / tradeoff | Choice and rationale |
|---|---|---|---|
| 1 | **`syncEventId` on `RequestOptions`** | Generic `headers` passthrough (works today); typed option | **Typed option**, per proposal D. Adds `const SYNC_EVENT_ID_HEADER = "X-Sync-Event-Id"` beside `CLIENT_ID_HEADER` and one `headers.set` line after `:93`. `idempotencyKey` is untouched and no bookmark call passes it — two different headers for two different subsystems, both named in exactly one file. |
| 2 | **`syncEventId` is required, not defaulted** | Mirror `createWorkspace(…, idempotencyKey = newIdempotencyKey())`; require it | **Required.** A default restores exactly the failure the change exists to fix: POST/DELETE `ensureEventID` (`sync/postgres.go:507`) silently mints a random id and loses retry protection. Deliberate deviation from `workspaces.ts`'s defaulted style, because there the header is optional and here it is the point. |
| 3 | **Route** | `/bookmarks?workspace={id}` (proposal C); path param | **Query param**, per proposal C, and — matching `/access` — **no nav entry** in `AdminShellContext.navItems`. `/access` is likewise reachable only from a `WorkspacesPage` row action; a nav link to a page that is meaningless without `?workspace=` would need an empty-state picker nobody asked for. |
| 4 | **Tree DOM/ARIA** | `role="tree"` + roving tabindex; `role="treegrid"`; plain nested `<ul>/<li>` | **Plain nested `<ul>/<li>`, no tree role.** A `treeitem` row here contains three interactive controls (handle, name, actions menu); honouring `role="tree"` means roving tabindex plus `tabIndex={-1}` inner controls plus a secondary key to enter the row — machinery we would half-implement. This repo already ruled on the identical tradeoff (`secret-recipient-directory` Decision 16: a role without its interaction contract "is a worse lie than no role at all"). Native list nesting + real tab stops + an `aria-live` region delivers the spec's requirements without the lie. **Cost recorded**: a large tree has many tab stops; search/filter (explicit non-goal) is the eventual mitigation. |
| 5 | **Drag target legality** | One interleaved sortable list; type-segregated targets | **Type-segregated**, forced by the two position spaces (verification table row 1). A row accepts only same-type rows as ordering targets; folders additionally expose an "into" zone accepting both types; the workspace root exposes an into-root zone accepting folders only. |
| 6 | **How illegal targets are suppressed** | Post-filter in `onDragEnd`; custom `collisionDetection` | **Custom collision detection.** `legalTargets(closestCenter)` filters `args.droppableContainers` by `isLegalTarget(active, target)` *before* collision runs, so an illegal target is never reported as `over` at all — the placeholder simply snaps to the nearest legal slot. Post-filtering would show a drop indicator and then refuse it, which reads as a bug. |
| 7 | **Nested-tree sortable topology** | Recursive `SortableContext` per folder + cross-container `onDragOver`; one flat `SortableContext` over flattened visible rows | **One flat `SortableContext`.** dnd-kit resolves collisions from refs and rects, not DOM nesting, so a flat `items` array works over nested `<ul>` markup. Multi-container sortable needs `onDragOver` to mutate a local items copy mid-drag — banned outright by the "no retained optimistic state" requirement. Flat + `verticalListSortingStrategy` needs **uniform row height**: rows are single-line with `text-overflow: ellipsis` (a functional CSS requirement, not styling). |
| 8 | **Keyboard move** | `KeyboardSensor` drag emulation only; explicit move commands only; both | **Both, with the commands load-bearing.** `KeyboardSensor` is registered on the drag handle (space to lift, arrows, escape) because it costs nothing. But the *tested, guaranteed* path is `Alt+Arrow` commands handled on the same handle, because (a) coordinate emulation cannot guarantee that every legal target is reachable in a tree with collapsed branches and two position spaces, and (b) jsdom's zeroed rects make any coordinate path unverifiable in `vitest`. Both paths build the same `MovePlan`. |
| 9 | **Where move logic lives** | Inside `onDragEnd`; a pure planner module | **Pure `lib/bookmarks/treeModel.ts`.** `planDrop` and `planKeyboardMove` both return `MovePlan`; the page has one `useMoveNodeMutation`. "Keyboard achieves the same outcome as a mouse drag" becomes a structural property of a shared function, not two code paths kept in sync by review. This module is where the automated coverage lives. |
| 10 | **Optimistic updates** | `onMutate` snapshot/rollback; none | **None.** The requirement is that displayed order always comes from the server. `DragOverlay` plus `SortableContext`'s transform give in-drag feedback without retaining anything; the moved row renders `aria-busy` until the invalidated query settles. |
| 11 | **Refetch config** | Rely on globals; per-query overrides | **Per-query overrides on the tree query only**: `staleTime: 0` + `refetchOnWindowFocus: true` (both needed — see verification table) + `retry` that never retries 403/404. Globals in `main.tsx` stay untouched, so no other page changes behaviour. |
| 12 | **403 handling** | Generic error state; grant-aware states | **Three distinct states.** Tree 403 ⇒ "no grant" + a `<Link to="/access?workspace={id}">` self-grant call to action. `workspace.role === "viewer"` ⇒ read-only mode (no create/edit/delete/drag affordances rendered at all). Mutation 403 ⇒ "your grant is read-only" notice — a *different* meaning (`RequireWorkspaceWriteAccess` rejecting `viewer`), so it gets different copy. |
| 13 | **"Updated HH:MM" source** | `useState` set in `onSuccess`; `query.dataUpdatedAt` | **`treeQuery.dataUpdatedAt`**, formatted with `toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})`. Local state would be a second clock that can disagree with the cache after a focus refetch. Zero state added. |
| 14 | **Import event ids** | `keyFor({workspaceId, name, url})`; `keyFor({nodeKey})` with a parser-assigned key | **Parser-assigned stable `nodeKey`.** `normalizedIntent` (`useUncertainCreationKey.ts:4`) hashes the intent's *content*, so two genuinely duplicate bookmarks in one export file would share an event id and the second would be silently deduped by the server. A per-parsed-node key makes every node distinct while still reusing one id across retries of *that* node. |
| 15 | **Import ordering** | Send explicit `position` per item; send none | **Send none.** `CreateFolderTx`/`CreateBookmarkTx` append when `Position` is nil, so sequential pre-order creation reproduces file order exactly, and the client never has to model server positions during import. This is a second, independent reason the loop must not be parallelised. |
| 16 | **Retry-failed-items mechanics** | Re-run the whole plan; re-run the failed subset | **Failed subset, against a retained `createdIds` map** (Decision detail below). Re-running the whole plan would duplicate every folder that already succeeded — the single most likely bug in this feature. |
| 17 | **Root-level bookmarks in the file** | Drop silently; invent a container folder; pre-flight refusal | **Pre-flight refusal with a destination picker.** The import panel requires a destination (workspace root, or any existing folder). If the destination is the workspace root *and* the file has top-level bookmarks, import is blocked before any call with "N bookmarks sit at the top level of this file. A bookmark cannot live at the workspace root — choose a destination folder." Consistent with the 500-node ceiling: refuse up front, never mid-flight, never invent structure. **Deviation 1.** |
| 18 | **Where create affordances live** | Page-level buttons only; per-folder menu only; both | **Both.** A page-level "New folder" is *mandatory* — an empty workspace (the seeding case this feature exists for) has no folder row to hang a menu on. Per-folder creation needs a per-row affordance, so each folder row carries a `DropdownMenu` with *Add folder inside / Add bookmark inside / Rename / Delete*; bookmark rows carry *Edit / Delete*. `DropdownMenu` already exists and is already used for nav submenus. |
| 19 | **Import run ownership** | State inside `ImportPanel`; state in `BookmarksPage` | **`useImportRunner()` at page level.** `ContextPanel` unmounts when `?panel=` is cleared, so panel-owned state would kill an in-flight import the moment the admin closes the modal to look at the tree. The page renders a compact progress banner; reopening the panel re-attaches to the same run. |
| 20 | **URL rendering** | Anchor everywhere; text in preview, anchor in tree | **Text in the import preview, anchor in the tree.** Tree URLs passed backend `validateURL` (`bookmarks/service.go:777` — `http`/`https` + non-empty host only), so they are safe to render as `<a rel="noreferrer noopener" target="_blank">`. Parsed-but-not-yet-created URLs are untrusted; the parser filters non-`http(s)` schemes and the preview renders plain text regardless. |

## Data Flow

    WorkspacesPage row action
      └─► /bookmarks?workspace={id}
             │
    BookmarksPage
      ├─ useWorkspaceTree(token, workspaceId)  ─────────► GET /workspaces/{id}/tree
      │     staleTime 0 · refetchOnWindowFocus ◄─────────  200 {workspace:{role,…}, folders:[…]}
      │     retry: never on 403/404                       403 ⇒ "no grant" + link to /access
      │     dataUpdatedAt ──► "Updated HH:MM"
      │
      ├─ BookmarkTree
      │    flattenTree(folders, expanded) ──► FlatRow[]  (render order, per-group index)
      │    DndContext(sensors, legalTargets(closestCenter), announcements)
      │      └─ SortableContext(flatRowKeys, verticalListSortingStrategy)
      │           TreeRow · useSortable({id:"folder:X"|"bookmark:Y"})
      │           TreeRow(folder) also useDroppable({id:"into:X"})
      │           RootDropZone · useDroppable({id:"into-root"})   [folders only, while dragging]
      │
      │    onDragEnd(active, over) ─┐
      │    handle onKeyDown Alt+Arrow┘──► planDrop / planKeyboardMove ──► MovePlan
      │                                        │
      │                                        ├─ kind:"none" ──► aria-live announcement, no request
      │                                        └─ reorder|reparent
      │                                             └─► useMoveNodeMutation
      │                                                   PATCH /folders/{id}   {parentId?, position}
      │                                                   PATCH /bookmarks/{id} {folderId?, position}
      │                                                   X-Sync-Event-Id: keyFor(plan)
      │                                             onSettled ⇒ invalidate tree
      │
      └─ useImportRunner()                     (survives ContextPanel unmount)
           file ──► parseNetscapeBookmarks (DOMParser, client-only)
                      │  malformed ⇒ ParseError, zero calls
                      ├─ skipped[]  (non-http(s) schemes — listed, not imported)
                      └─ roots[] ──► toImportPlan (pre-order DFS) ──► ImportItem[]
                           nodeCount > 500 ⇒ refuse, zero calls
                           destination = root && has top-level bookmarks ⇒ refuse, zero calls
                           sequential loop, one in-flight call at a time:
                             parentId := createdIds[item.parentKey] ?? destinationFolderId
                             missing  ⇒ failures += {cause:"missing-parent"}   (no request)
                             POST /workspaces/{id}/folders | /bookmarks
                                  X-Sync-Event-Id: keyFor({nodeKey})
                             ok   ⇒ createdIds[key] = id; confirm(key); completed++
                             err  ⇒ retainAfterFailure(key, err); failures += {cause:"request"}
                           after the run ⇒ invalidate tree
                           "Retry failed items" ⇒ plan.filter(failed) with createdIds RETAINED

## Interfaces / Contracts

### `admin-web/src/lib/api/client.ts` (modify — 3 lines)

```ts
const SYNC_EVENT_ID_HEADER = "X-Sync-Event-Id";

type RequestOptions = Omit<RequestInit, "body"> & {
  token?: string;
  clientId?: string;
  body?: unknown;
  idempotencyKey?: string;
  /** X-Sync-Event-Id — the ONLY idempotency header the bookmark/sync routes
   *  read (sync/headers.go:14). PATCH /folders|/bookmarks 400 without it;
   *  POST/DELETE silently mint a random one and lose retry protection.
   *  Deliberately distinct from idempotencyKey: never set both. */
  syncEventId?: string;
};

// beside the existing idempotencyKey line (:93)
if (options.syncEventId) headers.set(SYNC_EVENT_ID_HEADER, options.syncEventId);
```

### `admin-web/src/lib/api/bookmarks.ts` (new)

```ts
export interface BookmarkNode { id: string; folderId: string; title: string; url: string; position: number }
export interface FolderNode { id: string; parentId?: string; name: string; position: number; folders: FolderNode[]; bookmarks: BookmarkNode[] }
export interface WorkspaceTree { workspace: WorkspaceAccessSummary; folders: FolderNode[] }
// NOTE: parentId is `omitempty` server-side — a ROOT folder omits the key entirely.
// Every consumer normalizes with `node.parentId ?? null`.

export async function getWorkspaceTree(token: string, workspaceId: string): Promise<WorkspaceTree>;

// syncEventId is REQUIRED on every mutation (Decision 2).
export function createFolder(token: string, workspaceId: string, input: { parentId: string | null; name: string }, syncEventId: string): Promise<FolderResource>;
export function updateFolder(token: string, folderId: string, input: { name?: string; parentId?: string | null; position?: number }, syncEventId: string): Promise<FolderResource>;
export function deleteFolder(token: string, folderId: string, syncEventId: string): Promise<void>;
export function createBookmark(token: string, workspaceId: string, input: { folderId: string; title: string; url: string }, syncEventId: string): Promise<BookmarkResource>;
export function updateBookmark(token: string, bookmarkId: string, input: { folderId?: string; title?: string; url?: string; position?: number }, syncEventId: string): Promise<BookmarkResource>;
export function deleteBookmark(token: string, bookmarkId: string, syncEventId: string): Promise<void>;
```

PATCH bodies are built key-by-key, never spread: the backend decodes `parentId`/`folderId` into
`OptionalString` and `position` into `OptionalInt` (`bookmarks/service.go:75-105`), which are
**presence-detecting** — an absent key means "leave unchanged", and an explicit `"parentId": null`
means "move to the workspace root". `JSON.stringify` drops `undefined` keys, so only `null` may ever
be assigned deliberately.

### `admin-web/src/lib/bookmarks/treeModel.ts` (new, pure — the coverage centre)

```ts
export type NodeType = "folder" | "bookmark";
export type RowKey = `folder:${string}` | `bookmark:${string}`;

export interface FlatRow {
  key: RowKey;
  type: NodeType;
  id: string;
  label: string;              // folder name | bookmark title
  url?: string;               // bookmarks only
  parentFolderId: string | null;   // null ⇒ workspace root (folders only)
  depth: number;
  index: number;              // index within its SIBLING GROUP == server `position`
  groupSize: number;          // size of that group EXCLUDING nothing (folders XOR bookmarks)
  hasChildren: boolean;
  expanded: boolean;
  ancestorIds: string[];      // folder ids from root to parent — powers the cycle pre-check
}

/** Depth-first, folders-before-bookmarks within each parent (mirroring the two
 *  position spaces). Collapsed folders contribute their own row and no descendants. */
export function flattenTree(folders: FolderNode[], expanded: ReadonlySet<string>): FlatRow[];

export type DropTarget =
  | { kind: "row"; key: RowKey }
  | { kind: "into"; folderId: string }
  | { kind: "into-root" };

export type MovePlan =
  | { kind: "move"; type: NodeType; id: string; label: string;
      parentFolderId: string | null; parentChanged: boolean; position: number }
  | { kind: "none"; reason: "same-position" | "illegal-target" | "cycle" | "not-found" };

export function isLegalTarget(rows: FlatRow[], activeKey: RowKey, target: DropTarget): boolean;
export function planDrop(rows: FlatRow[], activeKey: RowKey, target: DropTarget): MovePlan;

export type MoveCommand = "up" | "down" | "outdent" | "indent";
export function planKeyboardMove(rows: FlatRow[], activeKey: RowKey, command: MoveCommand): MovePlan;

/** One description function, two consumers: dnd-kit `announcements` and the
 *  keyboard path's own aria-live region. */
export function describeMovePlan(plan: MovePlan, rows: FlatRow[]): string;
```

**Position arithmetic (the single load-bearing formula).** For `{kind:"row"}` targets,
`position = overRow.index`. This is correct for both cases and for both engines:

- dnd-kit's `arrayMove(items, from, to)` removes then inserts at `to`.
- The server's `insertAt(ids, movingID, position)` (`bookmarks/service.go:745`) builds the sibling
  list **excluding** the moving row (`AND id <> $3`, `:657`/`:699`) and inserts at `position`,
  clamped to `[0, len]`.

Same group `[A,B,C]`, drag `A` onto `C` (`index 2`): client shows `[B,C,A]`; server list without `A`
is `[B,C]`, insert at 2 ⇒ `[B,C,A]`. Different group: the moving row is not in the target list, so
inserting at `overRow.index` lands it immediately before the hovered row. For `{kind:"into"}` and
`{kind:"into-root"}`, `position = <target group size>` (append); `PrepareFolderPatchTx:158-169`
clamps to `siblingCount` anyway.

**Legality rules** (`isLegalTarget`, applied identically by the collision filter and the keyboard
planner):

| Target | Legal when |
|---|---|
| `row` | `target.type === active.type`, target ≠ active, and (folders) target is not inside active's subtree |
| `into` | target ≠ active, `folderId ∉ active.subtree`, and `folderId !== active.parentFolderId` |
| `into-root` | `active.type === "folder"` and `active.parentFolderId !== null` |

The subtree check is a client-side **UX filter** built from `ancestorIds`; `ensureFolderNotDescendant`
(`bookmarks/service.go:607`) stays authoritative for the stale-tree race, and its 400 message
(`"folder cannot move into its own subtree"`) is surfaced verbatim in the page notice.

**Keyboard commands** (handled on the drag handle's `onKeyDown`, so they never collide with
`KeyboardSensor`'s space-to-lift or with normal tabbing):

| Keys | Command | Semantics |
|---|---|---|
| `Alt+↑` / `Alt+↓` | `up` / `down` | `position ± 1` within the row's own sibling group; refused at the ends |
| `Alt+←` | `outdent` | reparent to the grandparent, appended. Refused for a bookmark whose parent is a root folder (would land at the workspace root) |
| `Alt+→` | `indent` | reparent into the folder immediately preceding this row among its parent's combined children; refused when that neighbour is not a folder or does not exist |

### `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.ts` (new, pure)

```ts
export interface ParsedFolder { kind: "folder"; key: string; name: string; children: ParsedNode[] }
export interface ParsedBookmark { kind: "bookmark"; key: string; title: string; url: string }
export type ParsedNode = ParsedFolder | ParsedBookmark;
export interface SkippedEntry { title: string; rawHref: string; reason: "unsupported-scheme" | "missing-href" }
export interface ParseResult {
  roots: ParsedNode[];
  nodeCount: number;                 // folders + bookmarks, EXCLUDING skipped entries
  topLevelBookmarkCount: number;     // drives the Decision 17 pre-flight check
  skipped: SkippedEntry[];
}
export class BookmarkParseError extends Error {}
export function parseNetscapeBookmarks(html: string): ParseResult;
```

Algorithm — the format's nesting is the easiest thing here to get wrong, so the shape is pinned:

1. `new DOMParser().parseFromString(html, "text/html")`. Scripts never execute in a parsed-not-loaded
   document, and no node from it is ever inserted into the live DOM.
2. `root = doc.querySelector("dl")`. Absent ⇒ `BookmarkParseError("not a Netscape bookmarks file")`.
3. `parseList(dl)` iterates **`:scope > dt` only**. Direct-child scoping is mandatory: a folder's
   nested `<DL>` lands *inside* its `<DT>` (below), so `dl.querySelectorAll("dt")` would return
   grandchildren and flatten the whole tree into one level.
4. For each `<dt>`: `h3 = :scope > h3`, `a = :scope > a`.
   - `h3` ⇒ folder. Children come from `dt.querySelector(":scope > dl")`, falling back to the first
     `<dl>` among `dt`'s following element siblings (skipping `<p>`). **Both shapes must be handled.**
     Per the HTML5 tree-construction rules a `<dl>` start tag does *not* close an open `<dt>`, so the
     browser puts the nested list inside the `<DT>` — but sanitizers and non-browser exporters emit
     it as a sibling. `parseList` only ever iterates `dt` children, so a sibling `<dl>` is invisible
     to it and its entire subtree would be silently lost without the fallback. No double-visit is
     possible for the same reason.
   - `a` ⇒ bookmark. `href` is filtered by `isImportableUrl` (mirrors backend `validateURL`:
     `http`/`https` scheme, non-empty host) — `javascript:`, `place:`, `chrome://`, `data:` and empty
     hrefs go to `skipped`, never to `roots`. Empty title falls back to the URL.
   - Neither ⇒ ignored. `<DD>` description elements, `<H1>`, `<META>`, `PERSONAL_TOOLBAR_FOLDER`,
     `ADD_DATE`, `ICON` are all ignored; no attribute other than `href` is read.
5. `key` is a monotonic `n0, n1, …` assigned in parse order — the stable identity behind Decision 14
   and the retry mechanics.
6. `nodeCount === 0` ⇒ `BookmarkParseError("no bookmarks or folders found")`.

### `admin-web/src/lib/bookmarks/importPlan.ts` (new, pure)

```ts
export interface ImportItem { key: string; kind: NodeType; label: string; url?: string; parentKey: string | null }
/** Pre-order DFS ⇒ a parent always precedes every descendant, in file order. */
export function toImportPlan(roots: ParsedNode[]): ImportItem[];

export interface ImportFailure { key: string; label: string; kind: NodeType; reason: string; cause: "request" | "missing-parent" }
export interface ImportRunState {
  status: "idle" | "ready" | "running" | "done";
  plan: ImportItem[];
  destinationFolderId: string | null;
  createdIds: Record<string, string>;   // planKey -> server id; RETAINED across retries
  failures: ImportFailure[];
  completed: number;
  total: number;
  currentKey: string | null;
}
```

**Retry mechanics** — `retryFailed()` never re-runs the whole plan:

```
const failedKeys = new Set(state.failures.map(f => f.key));
const retryPlan  = state.plan.filter(item => failedKeys.has(item.key));  // pre-order preserved
run(retryPlan, { createdIds: state.createdIds, failures: [] });
```

Four invariants make this correct, and each is a test:

1. `createdIds` is carried over ⇒ an already-created folder is never created twice, and its
   previously-failed children resolve their `parentId` from it.
2. The subset is filtered out of the *original* plan, so a failed parent is still attempted before
   its failed children.
3. `failures` is rebuilt from the retry run alone ⇒ items that now succeed disappear from the list;
   items that fail again reappear with a possibly-updated reason.
4. Event ids come from `keyFor({nodeKey})`. An item that failed with an `ApiError` had its key
   dropped by `retainAfterFailure`, so the retry is a fresh event; an item that failed with a network
   error keeps its key, so if the create actually landed the server returns the same resource as a
   duplicate and `createdIds` still gets the right id.

### `admin-web/src/features/bookmarks/queries.ts` (new)

```ts
export function useWorkspaceTree(token?: string, workspaceId?: string) {
  return useQuery({
    queryKey: workspaceId ? queryKeys.workspace(workspaceId).tree : ["workspaces", "missing", "tree"],
    queryFn: () => getWorkspaceTree(token!, workspaceId!),
    enabled: Boolean(token && workspaceId),
    // Both overrides are required. main.tsx sets a global staleTime of 30s and
    // refetchOnWindowFocus:false; React Query only refetches on focus when the
    // query is STALE, so refetchOnWindowFocus alone would be a silent no-op.
    staleTime: 0,
    refetchOnWindowFocus: true,
    // 403 = no grant, 404 = no such workspace. Both are terminal answers, not
    // transient failures; the global retry:1 would double the latency to the
    // self-grant call to action.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 403 || error.status === 404)) && failureCount < 1,
  });
}
```

`queryKeys.workspace(workspaceId)` gains `tree: ["workspaces", workspaceId, "tree"] as const`.

### `admin-web/src/features/bookmarks/mutations.ts` (new)

Seven hooks, each a verbatim copy of `useCreateWorkspaceMutation`'s shape
(`features/workspaces/mutations.ts:6`) with two deliberate differences:

```ts
export function useMoveNodeMutation(token?: string, workspaceId?: string) {
  const queryClient = useQueryClient();
  const retry = useUncertainCreationKey();
  return useMutation({
    mutationFn: (plan: Extract<MovePlan, { kind: "move" }>) =>
      plan.type === "folder"
        ? updateFolder(token!, plan.id, { ...(plan.parentChanged ? { parentId: plan.parentFolderId } : {}), position: plan.position }, retry.keyFor(plan))
        : updateBookmark(token!, plan.id, { ...(plan.parentChanged ? { folderId: plan.parentFolderId! } : {}), position: plan.position }, retry.keyFor(plan)),
    onError: (error, plan) => retry.retainAfterFailure(plan, error),
    onSuccess: (_result, plan) => retry.confirm(plan),
    // onSettled, not onSuccess: a REJECTED move (cycle guard, stale position)
    // must also resync the displayed order, or the UI keeps showing a state the
    // server never accepted.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId!).tree }),
  });
}
```

`retry.keyFor(plan)` gives a distinct id per (node, target parent, target position); `confirm` on
success releases it, so repeating an identical drag later mints a fresh id and is not falsely deduped.
`useDeleteFolderMutation` / `useDeleteBookmarkMutation` use `keyFor({ delete: id })` — a delete has no
body to derive an intent from, and the server needs a deliberate id just as much (`ensureEventID`).

### `admin-web/src/features/bookmarks/` component tree

```
BookmarksPage                                 features/bookmarks/BookmarksPage.tsx
├─ header: workspace name · role badge · "Updated HH:MM" + Refresh · New folder · Import file
├─ notice (useState, same shape/copy pattern as WorkspacesPage)
├─ ImportProgressBanner                       (rendered whenever a run is active or has failures)
├─ BookmarkTree                               features/bookmarks/BookmarkTree.tsx
│   ├─ <div aria-live="polite" class="ui-visually-hidden">   ← keyboard-path announcements
│   └─ DndContext
│       ├─ SortableContext(rowKeys, verticalListSortingStrategy)
│       │   └─ <ul aria-label="Bookmark tree for {name}">
│       │        RootDropZone (useDroppable "into-root", only while a folder is being dragged)
│       │        TreeRow …    features/bookmarks/TreeRow.tsx
│       │          ├─ drag handle button  ← useSortable listeners + Alt+Arrow onKeyDown
│       │          ├─ chevron (folders)   ← toggles `expanded`
│       │          ├─ label / <a> (bookmarks, http(s) only)
│       │          ├─ into-zone (folders) ← useDroppable "into:{id}"
│       │          └─ DropdownMenu        ← Add folder / Add bookmark / Rename|Edit / Delete
│       └─ DragOverlay (label of the active row)
└─ ContextPanels, all keyed off ?panel= (+ ?node= / ?parent=), ?workspace= preserved:
     folder-create · bookmark-create · folder-edit · bookmark-edit
     folder-delete (ConfirmByTyping) · bookmark-delete (confirm button) · bookmark-import
```

Search params are always updated with the **updater form** — `setSearchParams(current => …)` — never
the object form `setSearchParams({panel:…})` that `WorkspacesPage:24` uses, because that replaces the
whole query string and would drop `?workspace=`, unmounting the page mid-action.

Folder delete copy (spec-mandated blast radius):

> Deleting **{name}** also deletes every folder and bookmark inside it. This applies immediately to
> every browser synced to this workspace — there is no undo and no in-browser notice.

### State ownership

| State | Owner | Why not elsewhere |
|---|---|---|
| Tree data + order | React Query `["workspaces", id, "tree"]` | single server-owned source of truth |
| "Updated HH:MM" | derived from `treeQuery.dataUpdatedAt` | local state would be a second clock (Decision 13) |
| Expanded folder ids | `useState<Set<string>>` in `BookmarkTree` | pure view state; survives refetch because refetch does not remount |
| Active drag key / hovered target | `useState` in `BookmarkTree`, set in `onDragStart`/`onDragOver`, cleared in `onDragEnd`/`onDragCancel` | transient, never read after the drag |
| In-flight move | `moveMutation.isPending` + `.variables` | avoids a parallel `movingId` that can desync |
| Notice banner | `useState` in `BookmarksPage` | matches `WorkspacesPage`/`AccessPage` |
| Import run | `useImportRunner()` reducer in `BookmarksPage` | must outlive `ContextPanel` (Decision 19) |
| Which panel is open | `?panel=` / `?node=` / `?parent=` | existing convention, deep-linkable |

**Nothing holds a mutated copy of the tree.**

## File Changes

| File | Action | Description |
|---|---|---|
| `admin-web/src/lib/api/client.ts` | Modify | `SYNC_EVENT_ID_HEADER`, `syncEventId?: string` on `RequestOptions`, one `headers.set`. `idempotencyKey` untouched |
| `admin-web/src/lib/api/client.test.ts` | Modify | `X-Sync-Event-Id` sent when set / absent when not / independent of `Idempotency-Key` |
| `admin-web/src/lib/api/queryKeys.ts` | Modify | `queryKeys.workspace(id).tree` |
| `admin-web/src/lib/api/bookmarks.ts` | Create | Tree read + 6 mutations, `syncEventId` required |
| `admin-web/src/lib/bookmarks/treeModel.ts` | Create | `flattenTree`, `isLegalTarget`, `planDrop`, `planKeyboardMove`, `describeMovePlan` |
| `admin-web/src/lib/bookmarks/treeModel.test.ts` | Create | Position arithmetic, legality, cycle pre-check, keyboard/pointer equivalence |
| `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.ts` | Create | `DOMParser` parser + scheme filter |
| `admin-web/src/lib/bookmarks/parseNetscapeBookmarks.test.ts` | Create | Real Chrome/Firefox export fixtures, both nesting shapes, malformed input |
| `admin-web/src/lib/bookmarks/importPlan.ts` | Create | `toImportPlan` pre-order DFS + run-state types |
| `admin-web/src/lib/bookmarks/importPlan.test.ts` | Create | Ordering, 500 ceiling, missing-parent propagation, retry subset |
| `admin-web/src/features/bookmarks/queries.ts` | Create | `useWorkspaceTree` with the three per-query overrides |
| `admin-web/src/features/bookmarks/mutations.ts` | Create | 7 hooks, all `onSettled`-invalidating |
| `admin-web/src/features/bookmarks/BookmarksPage.tsx` | Create | Page shell, panels, notice, grant/role states, refresh + timestamp |
| `admin-web/src/features/bookmarks/BookmarkTree.tsx` | Create | `DndContext`/`SortableContext`, live region, expansion state |
| `admin-web/src/features/bookmarks/TreeRow.tsx` | Create | `useSortable` + folder `useDroppable` + handle + actions menu |
| `admin-web/src/features/bookmarks/dnd/collision.ts` | Create | `legalTargets(closestCenter)` filter |
| `admin-web/src/features/bookmarks/dnd/announcements.ts` | Create | dnd-kit `announcements` built on `describeMovePlan` |
| `admin-web/src/features/bookmarks/FolderForm.tsx` | Create | Name field; used by create + rename |
| `admin-web/src/features/bookmarks/BookmarkForm.tsx` | Create | Title + URL fields; used by create + edit |
| `admin-web/src/features/bookmarks/useImportRunner.ts` | Create | Reducer + sequential run loop + `retryFailed` |
| `admin-web/src/features/bookmarks/ImportPanel.tsx` | Create | File input, destination picker, pre-flight checks, preview, failure list |
| `admin-web/src/features/bookmarks/ImportProgressBanner.tsx` | Create | `completed/total`, failure count, reopen link |
| `admin-web/src/features/bookmarks/BookmarksPage.test.tsx` | Create | Tree render, 403 state, read-only mode, panels, keyboard move, import flow |
| `admin-web/src/app/router.tsx` | Modify | `{ path: "bookmarks", element: <BookmarksPage /> }` under `AdminLayout` |
| `admin-web/src/features/workspaces/WorkspacesPage.tsx` | Modify | Row action `<Link to={\`/bookmarks?workspace=${id}\`}>Bookmarks</Link>` beside "Manage access" |
| `admin-web/src/lib/ui/tokens.css` | Modify | `.ui-tree*` rows (single-line/ellipsis — required by Decision 7), indent, drop indicator, into-zone highlight, `.ui-visually-hidden` for the live region. This is admin-web's only stylesheet |
| `admin-web/package.json` | Modify | `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |
| `admin-web/src/app/shell/AdminShellContext.tsx` | **Unchanged** | No nav entry, matching `/access` (Decision 3) |
| `backend/**`, `extension/**` | **Unchanged** | Explicit non-goal |

## Testing Strategy

Existing harness: `vitest` + `@testing-library/react` + `jsdom` (`admin-web/package.json`), driven by
`src/test/renderRoute.tsx`. **jsdom has no layout — `getBoundingClientRect` returns zeros — so
dnd-kit's collision detection and pointer/keyboard sensors cannot be exercised in unit tests.** That
constraint is the reason the whole move contract lives in `treeModel.ts` (Decision 9): the tested
surface is `MovePlan` in and PATCH body out, with the drag gesture itself covered manually.

| Layer | What to test | Approach |
|---|---|---|
| Unit | `apiRequest` sets `X-Sync-Event-Id` only when `syncEventId` is passed, and never conflates it with `Idempotency-Key` | Extend `client.test.ts`, asserting on the captured `Headers` |
| Unit | `flattenTree`: nesting order, folders-before-bookmarks, per-group `index` == server `position`, collapsed folders contribute no descendants, `parentId` absent ⇒ root | Table-driven against a fixture `WorkspaceTree` |
| Unit | `planDrop` same-group reorder ⇒ `position === overRow.index` for every (from, to) pair of a 4-item group, cross-checked against a local `arrayMove` and a local port of `insertAt` | The single highest-value test in the change: it pins client and server ordering to the same function |
| Unit | `planDrop` cross-group reparent sets `parentChanged` and inserts before the hovered row | Fixture with two sibling folders |
| Unit | `isLegalTarget`: cross-type row rejected, self rejected, folder→own-descendant rejected, into-own-current-parent rejected, bookmark→into-root rejected | Table-driven; the collision filter and the keyboard planner both consume it |
| Unit | `planKeyboardMove` for `up`/`down`/`indent`/`outdent` produces **byte-identical `MovePlan`s** to the equivalent `planDrop` | Proves the spec's "keyboard achieves the same outcome as a mouse drag" structurally |
| Unit | `parseNetscapeBookmarks`: real Chrome export fixture; nested `<DL>` **inside** `<DT>` and **as sibling of** `<DT>` both parse identically; 3-level nesting; `<DD>` ignored; empty title falls back to URL; `javascript:`/`place:`/`data:`/missing href land in `skipped` and not in `nodeCount`; non-bookmark HTML throws; empty `<DL>` throws | Inline fixture strings + jsdom's `DOMParser` |
| Unit | `toImportPlan` emits strict pre-order (every `parentKey` appears earlier in the array) | Property-style assertion over a deep fixture |
| Unit | Ceiling: 500 nodes ⇒ allowed, 501 ⇒ refused, and the refusal path issues **zero** `fetch` calls | Assert on a mocked `fetch` call count, not just on a flag |
| Unit | Import run: mid-run failure preserves earlier successes, continues to independent nodes, records `missing-parent` **without issuing a request** for the failed folder's children | Mocked `bookmarks.ts` module; assert per-call arguments in order |
| Unit | Retry: only failed keys re-attempted; `createdIds` retained ⇒ no duplicate folder create; a now-succeeding item leaves the failure list; a re-failing item stays with an updated reason | Same mock, second run |
| Component | Tree renders nested folders/bookmarks from a mocked `GET /tree` in server order | `renderRoute("/bookmarks?workspace=W")` |
| Component | 403 ⇒ "no grant" state with a link to `/access?workspace=W`, **not** a generic error; 404 ⇒ different copy; neither is retried | Mocked `fetch` returning 403/404 |
| Component | `workspace.role === "viewer"` ⇒ zero create/edit/delete/drag-handle affordances rendered | Fixture with role `viewer` |
| Component | Rename folder / edit bookmark title+URL send one PATCH each with `X-Sync-Event-Id` set and the expected body keys | Assert the captured `Request` |
| Component | Folder delete requires `ConfirmByTyping` and cancel sends no request; bookmark delete requires confirmation | Mirrors `WorkspacesPage.test.tsx`'s delete case |
| Component | `Alt+↓` on a row's drag handle issues the expected PATCH and updates the `aria-live` region | The keyboard path is fully testable precisely because it is coordinate-free |
| Component | A rejected move (400 cycle message) surfaces the server message **and** still refetches (`onSettled`) | Mocked 400 |
| Component | Manual Refresh refetches and advances the displayed "Updated HH:MM" | Fake timers + `dataUpdatedAt` |
| **Not covered — manual checklist required in `tasks.md`** | Pointer drag reorder, pointer drag reparent onto an into-zone, drop-indicator placement, `DragOverlay` visuals, `KeyboardSensor` space-to-lift, screen-reader announcement audibility (NVDA/VoiceOver) | Declared gap, caused by jsdom's lack of layout — not an omission. The `MovePlan` boundary is what makes the gap small |

## Threat Matrix

The change adds one client route and parses an untrusted user-supplied file. No shell, subprocess,
VCS/PR automation, or executable-file classification is involved.

| Boundary | Applicable | Expected safe behaviour | RED test |
|---|---|---|---|
| **Routing — new client route** | Yes | `/bookmarks` sits inside `RequireSession` → `RequireAdminOrganization` → `AdminLayout`, so it is unreachable anonymously and without an admin org; a missing/invalid `?workspace=` renders the "no workspace selected" state, never a crashed page | Router test for the anonymous and missing-param cases |
| **Authorization / IDOR** | Yes | `?workspace=` is attacker-controllable, and that is fine: the backend gates every read and write on the caller's grants. Admin-web adds **no** client-side authorization; the 403/viewer states are UX, never a control | 403 component test asserts the page shows the grant call to action rather than any tree data |
| **Untrusted HTML parsing (import)** | Yes | `DOMParser.parseFromString(text/html)` never executes scripts and never loads subresources; no parsed node is inserted into the live DOM — only extracted strings are. File contents are never transmitted anywhere except as ordinary create bodies | Parser test with a `<script>` and an `onerror` `<img>` in the fixture asserting no execution and no emitted node |
| **XSS via bookmark href** | Yes | Non-`http(s)` hrefs are dropped at parse time into `skipped`; the import preview renders URLs as **text**; only tree URLs (already through backend `validateURL`) render as anchors, with `rel="noreferrer noopener"` | Parser test for `javascript:`/`data:`; component test asserting the preview renders no anchor |
| **Denial of service — oversized import** | Yes | Hard 500-node ceiling refuses before any call, plus a file-size guard before `parseFromString`. Worst case is 500 sequential requests, bounded and observable | Ceiling test asserting zero `fetch` calls at 501 |
| **Denial of service — oversized tree render** | Partial | `GetTree` has no pagination; the import ceiling bounds what admin-web can create, but not what an extension already created. No virtualization in this slice — collapsed-by-default below depth 1 keeps the initial row count small | Recorded as a risk, not a test |
| **Replay / duplicate mutation** | Yes | Every mutation carries a deliberate `X-Sync-Event-Id`; a retry after a network failure reuses it (server dedupes), a retry after a server rejection mints a fresh one | `client.test.ts` header test + the import retry test |
| **Destructive action** | Yes | Folder delete is cascade-confirmed via `ConfirmByTyping` with blast-radius copy; cancel issues no request | Delete component tests |
| Shell / subprocess / VCS-PR / executable classification / process integration | **N/A** | No such boundary is crossed | — |

## Migration / Rollout

**No migration required.** No schema change, no new endpoint, no altered backend contract. The only
non-`features/bookmarks/` production change is three additive lines in `client.ts` plus one query key,
one route, and one row-action link.

Deploy order is unconstrained; the backend already serves every route this consumes. Rolling back is a
branch revert and restores the previous console exactly. **Caveat, restated from the proposal**:
reverting does not undo bookmarks an import already created — they are ordinary rows and must be
removed through the UI or the extension.

Branch: work continues on `feature/workspace-bookmark-management`, cut from and targeting `develop`.
No new branches, no merges in this change.

### Sequencing (input for `sdd-tasks`)

Hard edges — later items cannot be written correctly before earlier ones:

1. **`client.ts` `syncEventId`** — every mutation hook's signature depends on it. Nothing else may start.
2. **`queryKeys.tree` + `lib/api/bookmarks.ts` + tree types**.
3. **`features/bookmarks/queries.ts` + read-only `BookmarksPage` + router + `WorkspacesPage` link** — first independently shippable slice; proves the 403/viewer/refresh/timestamp behaviour with no mutations at all.
4. **`lib/bookmarks/treeModel.ts`** — pure, no UI, no dnd-kit import. Must precede the DnD layer.
5. **`features/bookmarks/mutations.ts` + create/rename/edit/delete panels** — depends on 1-3 only, not on 4.
6. **DnD + keyboard layer** — depends on 4 and 5 (it reuses `useMoveNodeMutation`). Adds the `@dnd-kit` dependency here, not earlier.
7. **`parseNetscapeBookmarks.ts` + `importPlan.ts`** — pure; depends only on 2. Parallelisable with 4-6.
8. **Import panel + progress banner + retry** — depends on 5 and 7.

Suggested PR chain, since the whole change is well over the 400-line review budget: **(A)** 1-3,
**(B)** 5, **(C)** 4+6, **(D)** 7+8. Each slice leaves the page in a coherent, demoable state:
read-only tree → editable tree → draggable tree → importable tree.

## Risks / Deviations Requiring Re-confirmation

1. **Deviation 1 — root-level bookmarks in an import file are a pre-flight refusal**, not a silent
   drop and not an invented container folder (Decision 17). The proposal is silent on the case;
   `folder_id NOT NULL` makes it unavoidable. **Confirm.**
2. **Deviation 2 — `KeyboardSensor` is registered but is not the guaranteed keyboard path**;
   `Alt+Arrow` commands sharing the pointer path's planner are (Decision 8). The proposal named
   `KeyboardSensor` explicitly. Every accessibility *outcome* the spec requires is still delivered,
   and delivered testably. **Confirm.**
3. **Deviation 3 — no `role="tree"`** (Decision 4), following this repo's own precedent for partial
   ARIA patterns. Large trees therefore carry many tab stops. **Confirm.**
4. **The import failure list is in-memory only.** Navigating away from `/bookmarks` abandons an
   in-flight run and loses the retry list; created nodes stay (that is the no-fake-rollback promise).
   No `beforeunload` guard is added in this slice. Recorded honestly rather than mitigated.
5. **`@dnd-kit` is three new runtime dependencies** in a repo that currently has four. Reviewable, but
   it is the largest dependency decision the console has made.
6. **Pointer-drag behaviour has no automated coverage** (jsdom has no layout). The design minimises
   the exposure by pushing all decision logic behind `MovePlan`, but the gesture itself is
   manual-checklist territory. `tasks.md` must carry that checklist.
7. **Last-write-wins is unchanged** (proposal Decision E). A concurrent extension move is clobbered;
   `onSettled` refetch makes the result immediately visible, which is the whole mitigation.
8. **No in-extension attribution** (proposal Decision G) — confirmed deferred; the admin-side
   confirmation copy is the only in-product mitigation and is specified above verbatim.
9. **Large existing trees are rendered whole.** Import cannot create one above 500 nodes, but an
   extension can. Mitigation in this slice is collapse-below-depth-1 only; virtualization is a
   fast-follow trigger alongside the bulk-import endpoint.
