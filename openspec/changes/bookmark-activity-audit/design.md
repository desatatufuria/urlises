# Design: Bookmark & Folder Activity Auditing

## Technical Approach

Two independent slices, both purely additive, no migration.

**Slice A — audit write.** One `activity.Record` call inside `syncapi.PostgresStore.recordEvent`
(`backend/internal/sync/postgres.go:344`), verified as the single choke point through which all
8 live bookmark/folder mutation sites already pass. `recordEvent` receives a `pgx.Tx` it does
not own — `runMutation` (`:291`), `runDeleteMutation` (`:331`) and
`httpapi.IdempotencyExecutor.ExecutePrepared` (`idempotency.go:170`) each commit *after* the
apply closure returns — so the audit row lands in the same transaction as the mutation and its
`sync_events` row, exactly like the organizations/workspaces/groups callers.

**Slice B — category filter.** A query-time kind-prefix predicate in
`activity.ListByOrganization`, an optional `?category=` param, and a segmented toggle on
`ActivityPage`. No schema change, no `category` column.

Slice B is independently shippable and useful on its own (it filters today's 21 kinds into
"everything" vs "everything", i.e. a no-op) but only *valuable* after Slice A, so ship A→B or
together. Neither slice touches `backend/internal/bookmarks/**` (Decision B) or the extension.

### Verified against source, correcting the proposal

| Proposal statement | Verified reality |
|---|---|
| "Add `organization_id` (and `w.name`) to the statement's `RETURNING`" | `organization_id` works (it is a `sync_events` column being inserted). **`w.name` does not** — Postgres `RETURNING` may only reference the inserted row, never a CTE. Requires the `inserted` CTE + outer SELECT restructure below. |
| `types.go` gains the activity dependency | `workspaceAccessChecker` and the `PostgresStore` struct both live in **`postgres.go:19-37`**, not `types.go`. `types.go` is unchanged. |
| "kind and metadata passed in explicitly by each of its 8 call sites" | Metadata: yes. Kind: **derived from a lookup table** — see Decision 1. Flagged for re-confirmation. |
| "adding `title`/`name` to the existing pre-delete SELECT" | Ambiguous. The extra columns feed the **audit map only**; the `sync_events` payload keys stay byte-identical (Decision 4), honouring the "no extension protocol change" non-goal. Bookmark needs **two** extra columns (`title` *and* `url`), not one. |
| Retry cannot double-audit | Confirmed for all 8 sites. `runMutation`/`runDeleteMutation` return at `:283`/`:323` **before** `apply`; `ExecutePrepared` returns the replayed receipt at `idempotency.go:161` **before** `prepared.Command`. |

## Architecture Decisions

| # | Decision | Options / tradeoff | Choice and rationale |
|---|---|---|---|
| 1 | **How `recordEvent` obtains the `activity.Kind`** | (a) 9th/11th positional param at 8 call sites (proposal wording); (b) package-level lookup `map[string]activity.Kind`; (c) `activity.Kind(eventType)` direct cast | **(b) lookup table, fail-closed.** (c) is rejected outright: `sync_events.event_type` is an **extension wire-protocol value** and `activity.Kind` is an **admin audit vocabulary**; they coincide today by convention, not contract, and a cast makes any future protocol rename silently rewrite the audit vocabulary — and silently mint unlisted Kinds that only hit `format.ts`'s `default:` branch. (a) is rejected because it puts two literals that *must* agree (`"folder.updated"` and `KindFolderUpdated`) five arguments apart on the same line at 8 sites — a drift hazard a reviewer cannot check at a glance. (b) makes agreement structural, is 6 lines, is DB-free testable, and an unmapped `eventType` returns an error (aborting the mutation) rather than skipping the audit. **Deviation from Decision B's literal wording — see Risks.** |
| 2 | **How `recordEvent` obtains the metadata** | (a) one new `auditMetadata map[string]any` param from the call sites; (b) type-switch on the existing `payload any` | **(a).** (b) would need zero call-site churn, but silently yields empty metadata for any future payload type and forces `recordEvent` to reason about `bookmarks.Folder` vs `bookmarks.Bookmark` vs `map[string]any`+`entityType`. (a) keeps the projection explicit at the site that owns the data. Metadata is deliberately a **projection**, never the resource blob (Decision A). Cost accepted: `recordEvent` goes from 10 to 11 parameters. A struct-grouped signature refactor is a larger diff across all 8 sites for no behavioural gain — out of scope, noted as a follow-up. |
| 3 | **`workspaceId`/`workspaceName` injected by `recordEvent`, not the call sites** | Build the whole map at the site vs. site supplies entity fields only | **`recordEvent` injects both.** `workspaceName` is *only* available there (it comes from the CTE). Having it inject `workspaceId` too means the two scoping keys are guaranteed consistent across all 8 sites and cannot be forgotten. Call sites supply exactly `{"name":…}` or `{"title":…,"url":…}`. `recordEvent` copies the caller's map rather than mutating it. |
| 4 | **Delete metadata source** | Second SELECT vs. extra columns on the existing pre-delete SELECT | **Extra columns on the existing SELECT**, returned as a *separate* audit map. `folderDeletePayload`/`bookmarkDeletePayload` already run one SELECT in the same tx immediately before the delete; `name` / `title, url` are one and two extra columns on it. The **sync payload keys are unchanged** — the extension's wire shape is a stated non-goal. |
| 5 | **`sync` → `activity` coupling** | Import `*activity.Service` vs. narrow handler-local interface | **Narrow interface `activityRecorder`, declared next to `workspaceAccessChecker` in `postgres.go`.** No import cycle exists either way (`activity` imports only `access`; `postgres_integration_test.go:16` already imports `activity` from this package), so the interface is for the repo's convention and for **testability**: the "audit failure aborts the mutation" risk row is only testable with an injectable failing recorder. The `activity` import stays for the `activity.Kind` type — exactly as `workspaceAccessChecker` imports `workspaces` for its return type. |
| 6 | **Nil recorder handling** | Guard like `s.publisher != nil` vs. no guard like `s.workspaces` | **No guard.** `publisher` is deliberately optional (tests pass `nil`); the audit trail is not. A nil recorder is a wiring bug that must fail at the first mutation, not silently disable compliance logging. Adding the constructor parameter breaks every existing `NewPostgresStore` call site at compile time — that pressure is the point. |
| 7 | **Category filter: query-time predicate vs. persisted column** | (a) `kind LIKE` prefix predicate; (b) `category` column written/derived at write time + index | **(a).** (b) costs a migration, a backfill, and a second source of truth that can drift from `kind` — its only advantage is an equality predicate over a 3-value column. The derivation rule ("`bookmark.`/`folder.` prefix ⇒ content") is stable, low-cardinality, and cheap to evaluate. Critically, (a) is **not a dead end**: because the predicate is emitted as a *constant string*, the escalation path (Decision 8) is a pure migration with zero code change. |
| 8 | **Indexing** | Rely on `idx_activity_events_org_created_id`; add a partial index now; add nothing | **Rely on the existing index; design but do not build the partial index.** The index is `(organization_id, created_at DESC, id DESC)`: the leading equality on `organization_id` plus the exact `ORDER BY created_at DESC, id DESC` means the planner can do an ordered index scan with no sort node and stop at `LIMIT`; the cursor predicate `(created_at,id) < ($2,$3)` is the scan start point. `kind` is not in the index and never can be index-only (the query returns `metadata`, `target_*`, and joins `users`), so **the category predicate is a per-row filter applied after the heap fetch**. That is correct but *amplifies rows scanned by 1/selectivity*: with a 99%-bookmark feed, one 50-row `administrative` page scans ~5,000 rows. Not a problem at today's volume; the honest trigger to escalate is the same one Decision D already flags for monitoring. Escalation, verbatim and additive: `CREATE INDEX idx_activity_events_org_admin_created_id ON activity_events (organization_id, created_at DESC, id DESC) WHERE kind NOT LIKE 'bookmark.%' AND kind NOT LIKE 'folder.%';`. `LIKE` with a constant pattern is `IMMUTABLE`, so the partial predicate is legal, and Postgres's implication prover matches it because the query emits that clause **byte-identically**. |
| 9 | **"Administrative" defined by negation, not allowlist** | `NOT LIKE 'bookmark.%' AND NOT LIKE 'folder.%'` vs. an explicit list of the 21 admin prefixes | **Negation.** Fail-safe for an audit surface: a future Kind nobody remembers to classify still appears in the default admin view rather than becoming invisible everywhere. |
| 10 | **Filter state lives in `useState`, not the URL** | `useSearchParams` (the repo's `ContextPanel` idiom) vs. local component state | **Local `useState`.** Decision C's whole rationale for rejecting multi-select was avoiding URL-state complexity. A 3-way view toggle is not a shareable resource identity. Tradeoff accepted and recorded: the filter is not bookmarkable and resets on navigation. |
| 11 | **Segmented-control CSS** | Reuse `.ui-theme-toggle*` under its theme-specific name; duplicate 5 CSS rules; rename to `.ui-segmented*` | **Rename to `.ui-segmented*`** in `tokens.css` and update `ThemeToggle.tsx`'s three class strings. It is a 5-line mechanical rename; `ThemeToggle.test.tsx` asserts only roles and `aria-pressed`, never class names, so it stays green untouched. The alternatives are a lying class name or duplicated CSS. |
| 12 | **No `queryKeys.ts` change** | Add `activityFiltered(category)` vs. append the category in the hook | **Append in the hook**: `[...queryKeys.organization(id).activity, category]`. Prefix-based invalidation of `queryKeys.organization(id).activity` still matches every category, so existing/future invalidation code needs no update. |

## Data Flow

    PATCH /bookmarks/{id}   (prepared path, 2 of the 8 sites)
      -> IdempotencyExecutor.ExecutePrepared   tx = pool.Begin
           claimReceipt -> found  => replay stored response, Command NEVER runs  [no double-audit]
           Command:
             ApplyPreparedBookmarkPatchTx -> patch.NoOp? => return, no sync event, no audit
                                          -> recordEvent(...)
           completeReceipt ; tx.Commit

    POST/PATCH/DELETE folders|bookmarks   (the other 6 sites)
      -> runMutation / runDeleteMutation      tx = pool.Begin
           lockEventKey (pg_advisory_xact_lock)
           loadDuplicate* -> Duplicate => return + tx.Commit, apply NEVER runs   [no double-audit]
           apply:
             bookmarks.<Mutate>Tx
             (deletes only) folder|bookmarkDeletePayload -> (syncPayload, auditMetadata, workspaceID)
             recordEvent(...)
           tx.Commit ; publisher.Publish   (post-commit, unchanged)

    recordEvent(ctx, tx, userID, workspaceID, eventID, originClientID,
                eventType, entityType, entityID, payload, auditMetadata)
        kind, ok := activityKindByEventType[eventType]  -> !ok => error (fail closed, pre-INSERT)
        json.Marshal(payload)                                            [unchanged]
        one QueryRow: mutation_context + assigned + inserted CTEs
            -> Envelope fields                                           [unchanged]
            -> organizationID   (inserted.organization_id)               [NEW scan target]
            -> workspaceName    (mutation_context.workspace_name)        [NEW scan target]
        metadata := copy(auditMetadata) + workspaceId + workspaceName
        s.activity.Record(ctx, tx, organizationID, userID, kind, entityType, entityID, metadata)
            -> error => recordEvent returns error => caller rolls back everything
        return Envelope

    GET /organizations/{id}/activity?category=administrative&limit=50&cursor=…
      -> parseCategory (forgiving: absent/unknown/any case -> CategoryAll)
      -> ListByOrganization(ctx, requesterUserID, organizationID, cursor, limit, category)
           access.RequireOrganizationAdmin                               [unchanged]
           WHERE organization_id = $1 [AND (created_at,id) < ($2,$3)] AND <constant kind predicate>
           ORDER BY created_at DESC, id DESC LIMIT $n                    [unchanged]

    ActivityPage  useState<ActivityCategory>("all")
      -> ActivityCategoryToggle (onChange)
      -> useOrgActivity(orgId, token, category)
           queryKey [...organization(orgId).activity, category]  => category switch = a distinct
           cached infinite query, so cursors from one category never page into another

## Interfaces / Contracts

### `backend/internal/activity/service.go`

```go
const (
    KindBookmarkCreated Kind = "bookmark.created"
    KindBookmarkUpdated Kind = "bookmark.updated"
    KindBookmarkDeleted Kind = "bookmark.deleted"
    KindFolderCreated   Kind = "folder.created"
    KindFolderUpdated   Kind = "folder.updated"
    KindFolderDeleted   Kind = "folder.deleted"
)

// Category partitions Kind values into the two audiences the feed serves.
// Administrative is defined by NEGATION so an unclassified future Kind stays
// visible in the default admin view instead of disappearing from every view.
type Category string

const (
    CategoryAll            Category = "all"
    CategoryAdministrative Category = "administrative"
    CategoryBookmarks      Category = "bookmarks"
)

func (s *Service) ListByOrganization(
    ctx context.Context, requesterUserID, organizationID, cursor string,
    limit int, category Category,
) (events []Event, nextCursor string, err error)
```

Package doc comment: delete `"This package has zero callers in this work unit; organizations/
workspaces/groups are wired in later units."` and replace with the true wiring —
`organizations`, `workspaces`, `groups`, and `sync.PostgresStore.recordEvent` (bookmark/folder
mutations).

Predicate injection, appended **after** the optional cursor clause so `len(args)+1` numbering for
`LIMIT` is untouched. The fragments are compile-time constants; no user input reaches SQL:

```go
switch category {
case CategoryBookmarks:
    query += " AND (e.kind LIKE 'bookmark.%' OR e.kind LIKE 'folder.%')"
case CategoryAdministrative:
    query += " AND e.kind NOT LIKE 'bookmark.%' AND e.kind NOT LIKE 'folder.%'"
default: // CategoryAll — no predicate
}
```

### `backend/internal/activity/handler.go`

```go
type routeService interface {
    ListByOrganization(ctx context.Context, requesterUserID, organizationID, cursor string,
        limit int, category Category) ([]Event, string, error)
}

// parseCategory mirrors parseListLimit's forgiving style: absent, blank, or
// unrecognised -> CategoryAll. Case- and whitespace-insensitive.
func parseCategory(raw string) Category
```

`?category=all|administrative|bookmarks`. Absent ⇒ `all`. Unknown ⇒ `all` (never 400 — a
forgiving read filter must not break a bookmarked admin URL). Response shape unchanged.

### `backend/internal/sync/postgres.go`

```go
// activityRecorder is the subset of *activity.Service this store depends on,
// mirroring workspaceAccessChecker's narrow-interface pattern above. The
// activity import is type-only (activity.Kind); activity does not import
// sync, so there is no cycle.
type activityRecorder interface {
    Record(ctx context.Context, tx pgx.Tx, orgID, actorUserID string, kind activity.Kind,
        targetType, targetID string, metadata map[string]any) error
}

type PostgresStore struct {
    pool       *pgxpool.Pool
    bookmarks  *bookmarks.Service
    workspaces workspaceAccessChecker
    activity   activityRecorder   // NEW — never nil; see Decision 6
    publisher  Publisher
}

func NewPostgresStore(pool *pgxpool.Pool, bookmarkService *bookmarks.Service,
    workspaceService workspaceAccessChecker, activityService activityRecorder,
    publisher Publisher) *PostgresStore

// activityKindByEventType is the ONLY bridge between sync's wire-protocol
// event_type vocabulary and activity's audit Kind vocabulary. They read alike
// today by convention, not by contract — this table is what makes the
// relationship explicit, reviewable, and fail-closed.
var activityKindByEventType = map[string]activity.Kind{
    "folder.created":   activity.KindFolderCreated,
    "folder.updated":   activity.KindFolderUpdated,
    "folder.deleted":   activity.KindFolderDeleted,
    "bookmark.created": activity.KindBookmarkCreated,
    "bookmark.updated": activity.KindBookmarkUpdated,
    "bookmark.deleted": activity.KindBookmarkDeleted,
}

func (s *PostgresStore) recordEvent(ctx context.Context, tx pgx.Tx,
    userID, workspaceID, eventID, originClientID, eventType, entityType, entityID string,
    payload any, auditMetadata map[string]any) (Envelope, error)

func folderAuditMetadata(f bookmarks.Folder) map[string]any   // {"name": f.Name}
func bookmarkAuditMetadata(b bookmarks.Bookmark) map[string]any // {"title": b.Title, "url": b.URL}

// Third return value is NEW; the first (the sync payload) keeps its exact keys.
func (s *PostgresStore) folderDeletePayload(ctx context.Context, tx pgx.Tx, folderID string) (
    payload map[string]any, audit map[string]any, workspaceID string, err error)
func (s *PostgresStore) bookmarkDeletePayload(ctx context.Context, tx pgx.Tx, bookmarkID string) (
    payload map[string]any, audit map[string]any, workspaceID string, err error)
```

`recordEvent`'s query, restructured so `workspace_name` can leave the CTE. `RETURNING` cannot
reference `mutation_context`, so the INSERT moves into an `inserted` CTE and an outer SELECT
joins the two single-row CTEs. Placeholders `$1`-`$8` and their meanings are unchanged; the
zero-row fail-closed behaviour (`mutation_context` empty ⇒ 0 rows inserted ⇒ `pgx.ErrNoRows`) is
preserved exactly, as is the `assigned` cursor upsert:

```sql
WITH mutation_context AS (
    SELECT w.organization_id AS organization_id, w.name AS workspace_name, d.id AS device_id
    FROM workspaces w
    LEFT JOIN devices d ON d.user_id = $2 AND d.client_id = $3
    WHERE w.id = $1
), assigned AS (
    INSERT INTO workspace_cursors (workspace_id, current_cursor, updated_at)
    VALUES ($1, 1, NOW())
    ON CONFLICT (workspace_id) DO UPDATE
    SET current_cursor = workspace_cursors.current_cursor + 1, updated_at = NOW()
    RETURNING current_cursor
), inserted AS (
    INSERT INTO sync_events (
        event_id, organization_id, workspace_id, user_id, device_id,
        origin_client_id, cursor, event_type, entity_type, entity_id, payload
    )
    SELECT $4, mutation_context.organization_id, $1, $2, mutation_context.device_id,
           $3, assigned.current_cursor, $5, $6, $7, $8
    FROM mutation_context, assigned
    RETURNING cursor, event_id, workspace_id, origin_client_id, event_type,
              entity_type, entity_id, payload, created_at, organization_id
)
SELECT i.cursor, i.event_id, i.workspace_id, i.origin_client_id, i.event_type,
       i.entity_type, i.entity_id, i.payload, i.created_at,
       i.organization_id, mutation_context.workspace_name
FROM inserted i, mutation_context;
```

Delete-payload SELECTs gain columns only (`SELECT workspace_id, parent_id, name FROM folders …`,
`SELECT workspace_id, folder_id, title, url FROM bookmarks …`); the `deleted_at IS NULL` sync
tombstone predicate is unchanged.

`backend/cmd/api/main.go:129` becomes
`syncapi.NewService(syncapi.NewPostgresStore(pool, bookmarksService, workspacesService, activityService, websocketHub))` —
`activityService` already exists at `:101`.

### Recorded metadata (Decision A)

| Kind | `target_type` | `target_id` | Metadata |
|---|---|---|---|
| `bookmark.created` / `.updated` / `.deleted` | `bookmark` | bookmark ID | `{title, url, workspaceId, workspaceName}` |
| `folder.created` / `.updated` / `.deleted` | `folder` | folder ID | `{name, workspaceId, workspaceName}` |

### Frontend

```ts
// lib/api/activity.ts
export type ActivityCategory = "all" | "administrative" | "bookmarks";
// + 6 members on the ActivityKind union
// category inserted BEFORE limit: only queries.ts calls this, and limit is the
// rarely-overridden trailing default. "all" sends NO param, so the default
// request is byte-identical to today's.
export function listOrgActivity(organizationId: string, token: string, cursor?: string,
    category: ActivityCategory = "all", limit = 50): Promise<ActivityPage>

// features/activity/queries.ts
export function useOrgActivity(organizationId?: string, token?: string,
    category: ActivityCategory = "all")
//   queryKey: [...queryKeys.organization(organizationId).activity, category]

// features/activity/ActivityCategoryToggle.tsx  (new)
interface ActivityCategoryToggleProps {
  category: ActivityCategory;
  onChange: (category: ActivityCategory) => void;
}
// <div role="group" aria-label="Activity category" className="ui-segmented">
//   3 x <button type="button" aria-pressed={…} className="ui-segmented__button[ --active]">
// Text labels ("All", "Administrative", "Bookmarks"), not icons: ThemeToggle is
// icon-only because it sits in a tight header bar; these three have no obvious
// glyphs and sit above a full-width table.
```

`format.ts` — 6 new `case` branches before `default:`; `url` is recorded but deliberately not
rendered (it would wreck the one-line table cell). Existing doc comment's "16 recorded Kind
values" is already stale at 21 and becomes 27:

```ts
case "bookmark.created": return `Added the bookmark "${m.title ?? ""}" to workspace "${m.workspaceName ?? "?"}".`;
case "bookmark.updated": return `Updated the bookmark "${m.title ?? ""}" in workspace "${m.workspaceName ?? "?"}".`;
case "bookmark.deleted": return `Deleted the bookmark "${m.title ?? ""}" from workspace "${m.workspaceName ?? "?"}".`;
case "folder.created":   return `Created the folder "${m.name ?? ""}" in workspace "${m.workspaceName ?? "?"}".`;
case "folder.updated":   return `Updated the folder "${m.name ?? ""}" in workspace "${m.workspaceName ?? "?"}".`;
case "folder.deleted":   return `Deleted the folder "${m.name ?? ""}" from workspace "${m.workspaceName ?? "?"}".`;
```

## File Changes

| File | Action | Slice | Description |
|---|---|---|---|
| `backend/internal/activity/service.go` | Modify | A, B | 6 `Kind` consts; `Category` type + 3 consts; `ListByOrganization` gains `category`; constant predicate; package doc corrected |
| `backend/internal/activity/kind_test.go` | Modify | A | RED: value assertions for the 6 new Kinds |
| `backend/internal/activity/handler.go` | Modify | B | `routeService` signature; `parseCategory`; pass-through |
| `backend/internal/activity/handler_test.go` | Modify | B | `activityRouteStub` signature (`:30`); `?category=` cases |
| `backend/internal/activity/service_test.go` | Modify | B | Three-state filter cases + filtered pagination |
| `backend/internal/sync/postgres.go` | Modify | A | `activityRecorder`; struct field; constructor param; `activityKindByEventType`; `recordEvent` signature + SQL + `Record` call; 2 delete-payload helpers; 2 audit-metadata helpers; 8 call sites |
| `backend/internal/sync/activity_audit_integration_test.go` | Create | A | Per-mutation, replay, rollback, no-op coverage |
| `backend/internal/sync/{postgres_integration,bookmark_routes,handler,replay}_test.go` | Modify | A | `NewPostgresStore` call sites gain the recorder argument |
| `backend/cmd/api/main.go` | Modify | A | Line 129 passes `activityService` |
| `backend/internal/sync/types.go` | **Unchanged** | — | Correcting the proposal: the store and its interfaces live in `postgres.go` |
| `backend/internal/bookmarks/**` | **Unchanged** | — | Decision B |
| `admin-web/src/lib/api/activity.ts` | Modify | A, B | 6 union members; `ActivityCategory`; `listOrgActivity` param |
| `admin-web/src/features/activity/queries.ts` | Modify | B | `category` param + query key member |
| `admin-web/src/features/activity/format.ts` | Modify | A | 6 cases; stale kind count in the doc comment |
| `admin-web/src/features/activity/format.test.ts` | Modify | A | 6 kinds × (full, missing) metadata |
| `admin-web/src/features/activity/ActivityCategoryToggle.tsx` | Create | B | 3-way segmented control |
| `admin-web/src/features/activity/ActivityCategoryToggle.test.tsx` | Create | B | aria-pressed + onChange, mirroring `ThemeToggle.test.tsx` |
| `admin-web/src/features/activity/ActivityPage.tsx` | Modify | B | `useState<ActivityCategory>`; render the toggle; page copy no longer claims admin-only content |
| `admin-web/src/features/activity/ActivityPage.test.tsx` | Modify | B | Toggle wiring + fresh-pagination assertion |
| `admin-web/src/lib/ui/tokens.css` | Modify | B | Rename `.ui-theme-toggle*` → `.ui-segmented*` (4 rules + the dark-theme hover at `:17`) |
| `admin-web/src/lib/ui/components/ThemeToggle.tsx` | Modify | B | Class-string rename only, no behaviour change |
| `admin-web/src/lib/api/queryKeys.ts` | **Unchanged** | — | Category appended in the hook; prefix invalidation still matches |

## Testing Strategy

Strict TDD: every row is RED first. Backend integration rows follow the existing
`testing.Short()`-skip + real-pool harness (`openSyncTestPool`, `insertSyncTestOrganizationAndWorkspace`).

| Layer | What to test | Approach |
|---|---|---|
| Unit (DB-free) | The 6 new `Kind` constants hold their exact wire values | Extend `activity/kind_test.go`'s existing shape |
| Unit (DB-free) | `activityKindByEventType` has **exactly** 6 entries and each maps to the matching constant; a table-driven case asserting every `eventType` literal used at the 8 call sites is present | New `sync/activity_kind_map_test.go`; guards Decision 1's fail-closed contract |
| Unit (DB-free) | `parseCategory`: `""`, `"all"`, `"administrative"`, `"bookmarks"`, `"BOOKMARKS"`, `"  bookmarks  "`, `"garbage"` | Table-driven, mirrors the existing `parseListLimit` test |
| Integration | **One case per mutation type (6)**: after the mutation, exactly one `activity_events` row exists with the right `organization_id` (the workspace's org, resolved by the CTE — never passed in), `actor_user_id` = the real principal, `kind`, `target_type`, `target_id`, and metadata containing the expected entity keys **plus** `workspaceId`/`workspaceName` | New `sync/activity_audit_integration_test.go`, table-driven |
| Integration | **Retry writes zero extra rows**: replay the same `metadata.EventID` through each of `runMutation`, `runDeleteMutation`, and `ExecutePrepared`; assert `sync_events` count == 1 **and** `activity_events` count == 1 for all three | The three distinct dedup mechanisms need three distinct cases; this is Success Criterion 2 |
| Integration | **No-op prepared patch records nothing**: a PATCH whose `patch.NoOp` is true produces zero sync events and zero activity events | Locks in the `:144`/`:166` early return as intended behaviour, not an omission |
| Integration | **Audit failure aborts the mutation**: inject an `activityRecorder` stub returning an error; assert the folder/bookmark row, the `sync_events` row and the cursor bump are all absent after rollback | Only possible because of Decision 5's narrow interface; covers the proposal's Medium risk row |
| Integration | **Unknown event type fails closed**: call `recordEvent` with an unmapped `eventType`; assert an error and a clean rollback | Guards against a future protocol addition silently skipping the audit |
| Integration | Sync behaviour is byte-identical: existing replay/cursor/idempotency tests pass unchanged; the restructured CTE returns the same `Envelope` field-for-field | Existing `replay_test.go` + `postgres_integration_test.go` as the regression net (Success Criterion 5) |
| Integration | **Category filter, three states**: seed a fixture with both admin kinds and bookmark/folder kinds; `all` returns every row, `bookmarks` returns only the 6 prefixes, `administrative` returns the exact complement; a Kind matching neither convention lands in `administrative` (Decision 9) | Extends `activity/service_test.go` |
| Integration | **Filtered pagination**: with `limit=1` and a category filter, page 2's cursor continues within the same filtered set and never surfaces an excluded row | Cursor + predicate interaction is the non-obvious part |
| Integration | Handler: `?category=bookmarks` reaches the service as `CategoryBookmarks`; absent ⇒ `CategoryAll`; `?category=nonsense` ⇒ `CategoryAll` and **200**, never 400 | `activityRouteStub` records the received `Category` |
| Frontend unit | `ActivityCategoryToggle`: three buttons, `aria-pressed` true only on the active one, `onChange` fires with each value | vitest + RTL, mirroring `ThemeToggle.test.tsx` exactly |
| Frontend unit | `ActivityPage`: clicking a category refetches with the new category and does not render the previous category's rows (distinct query key) | vitest + RTL with a mocked `listOrgActivity` |
| Frontend unit | `format.ts`: the 6 new kinds render real sentences with representative metadata, and degrade without `"undefined"` when metadata is missing/partial | Two fixtures per kind, matching the file's existing test shape |
| Frontend unit | `listOrgActivity` emits `category=bookmarks` in the URL and **omits** the param entirely when `"all"` | Guards the rollback story (older backend sees today's exact request) |

## Threat Matrix

N/A — no shell commands, subprocesses, VCS/PR automation, executable-file classification, or
process integration. The HTTP route change is a new optional read-only query param on an existing
authenticated, org-admin-gated endpoint.

The two real adversarial surfaces, both closed by construction:
1. **User input reaching SQL.** `?category=` is parsed into a closed 3-value Go type before it
   reaches the service, and the value selects between three **compile-time constant** SQL
   fragments. No user-derived string is ever concatenated or bound into the predicate.
2. **Authorization.** `ListByOrganization`'s `access.RequireOrganizationAdmin` gate is untouched
   and runs before any filtering — a category filter can only ever *narrow* what an already
   authorized org admin sees. `recordEvent` derives `organization_id` from the workspace row
   inside the transaction, never from the request, so an audit row cannot be attributed to a
   different tenant.

## Migration / Rollout

**No migration required.** No new table, column, or index (Decision 8 defers the partial index).

Deploy order is unconstrained: `?category=` is optional and defaults to `all`, so an older
frontend against a newer backend behaves exactly as today, and a newer frontend against an older
backend degrades to unfiltered results (the toggle still renders and still switches query keys —
it just receives the same rows). Slice A alone is shippable and correct; Slice B alone is
shippable and inert.

Rollback is a branch revert. `activity_events` rows already written with the new kinds remain
valid and render through `formatActivityEvent`'s `default:` branch. No data is orphaned: the new
rows are ordinary rows in an existing table with an existing `ON DELETE CASCADE` FK.

All work lands on `feat/bookmark-activity-audit` (already cut from `develop`). No new branches,
no merges.

## Risks / Deviations Requiring Re-confirmation

1. **Decision 1 deviates from Decision B's literal wording.** The proposal says the kind is
   "passed in explicitly by each of its 8 call sites"; this design derives it from
   `activityKindByEventType` instead. Metadata *is* still passed explicitly, as specified. The
   audited outcome is identical for all 6 kinds; what changes is where the sync-vocabulary →
   audit-vocabulary mapping is written down. **Confirm.**
2. **Decision 4 tightens Decision A's "add `title`/`name` to the pre-delete SELECT".** The extra
   columns feed the audit map only; the `sync_events` payload keeps its exact current keys, to
   honour the "no extension protocol change" non-goal. **Confirm** — the alternative (also
   enriching the sync payload) is a wire-shape change the extension does not need.
3. **`recordEvent` grows to 11 parameters.** Accepted for a minimal diff; a struct-grouped
   signature is a larger refactor across all 8 sites with no behavioural gain. Likely to be
   raised at review — recorded here as a deliberate, bounded tradeoff, not an oversight.
4. **The `.ui-theme-toggle*` → `.ui-segmented*` rename puts `ThemeToggle.tsx` in a diff that has
   nothing to do with theming.** 5 mechanical lines, tests are behaviour-based and stay green.
   The alternative is a misleading class name or duplicated CSS.
5. **Administrative-page scan amplification** grows linearly with bookmark volume (Decision 8).
   Not a launch blocker; the mitigation is a pure additive migration with zero code change. This
   is the same growth signal Decision D already says to monitor.
6. **Bulk-import bursts** remain the accepted volume risk (proposal risk table). The category
   filter contains the *usability* damage; row growth is a flagged follow-up, not solved here.

## Open Questions

- [ ] A no-op PATCH (`patch.NoOp`) records **no** audit row. Consistent with today's sync
      behaviour (it records no sync event either) and arguably correct — nothing changed. Confirm
      that "an admin clicked save and nothing was written" needs no audit trace.
- [ ] `url` is recorded in metadata but not rendered in the feed sentence. If compliance needs it
      visible, the cleanest option is a `title` attribute on the Event cell, which requires
      `formatActivityEvent` to return more than a string — a shape change deferred out of scope.
- [ ] Category filter state is not in the URL (Decision 10), so it is not shareable and resets on
      navigation. Acceptable for a view toggle; revisit if admins start sending each other links.
- [ ] Decision 8's partial index is designed but not built. Agree on the concrete trigger (e.g.
      `activity_events` row count per org, or observed Administrative page latency) so the
      escalation is a measurement, not a guess.
