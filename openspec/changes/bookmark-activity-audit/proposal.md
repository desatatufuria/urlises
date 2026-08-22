# Proposal: Bookmark & folder activity auditing

## Intent

URLises serves banking/fintech clients where "who changed what, when" is a compliance
expectation, not a nice-to-have. `activity_events` today records **only** administrative
lifecycle (21 Kinds: organizations, invitations, workspaces, access, groups). There is **no
audit trail for the product's core content** — nobody can answer "who deleted this client's
bookmark?" or "who moved that folder?". Support and compliance currently have no answer.

The actor and transaction are already at every mutation site, so the gap is wiring, not
architecture. The real cost is volume: bookmark/folder writes are the highest-frequency
mutations in the system (Chrome-native bulk import fires hundreds of `onCreated` events in
seconds), so mixing them into the admin feed without a filter would bury the low-frequency
events the page exists for.

## Scope

### In Scope

- 6 new `activity.Kind` constants + `activity.Record` calls for bookmark/folder create,
  update, delete (Decision A/B).
- `kind` category filter end-to-end: SQL predicate → HTTP query param → admin-web control
  (Decision C).
- `admin-web` rendering for the new kinds (`format.ts`, `ActivityKind` union).
- Fix the stale `activity/service.go` package doc ("zero callers in this work unit" — false;
  organizations/workspaces/groups are wired).

### Out of Scope (non-goals)

- **No revival of `bookmarks.RegisterRoutes`/`bookmarks.Service` HTTP layer** — confirmed dead
  code (zero callers; `main.go:162` mounts `syncapi.RegisterBookmarkRoutes` on the same paths).
- **No changes to `sync_events`, cursors, idempotency, or the extension sync protocol.** This
  change only *adds* a write alongside what already happens.
- **No pruning/retention system** (Decision D) — deferred, flagged below.
- No per-user or per-workspace activity views; org-scoped admin feed only.
- No extension-side changes.

## Capabilities

### New Capabilities

- `bookmark-activity-audit`: actor-attributed audit records for bookmark/folder create,
  update, delete, plus category filtering of the org activity feed.

### Modified Capabilities

- None. No existing spec in `openspec/specs/` covers the activity feed.

## Decisions

### A — Kind set and metadata

Six new Kinds, matching the existing `{resource}.{action}` convention **and** matching the
`sync_events.event_type` literals already used verbatim at these exact call sites
(`postgres.go:48,66,87,105,123,155,177,196`) — zero new vocabulary invented:

| Kind | `target_type` | Metadata |
|---|---|---|
| `bookmark.created` / `bookmark.updated` / `bookmark.deleted` | `bookmark` | `{title, url, workspaceId, workspaceName}` |
| `folder.created` / `folder.updated` / `folder.deleted` | `folder` | `{name, workspaceId, workspaceName}` |

Rationale: mirrors `KindWorkspaceDeleted`'s `{workspaceName, workspaceType}` style — a
human-readable *name* plus scoping IDs, never the full resource blob. `workspaceName` is
included because the admin reading the feed needs to know *which* workspace without a second
lookup. Delete metadata is sourced by adding `title`/`name` to the existing pre-delete SELECT
in `folderDeletePayload`/`bookmarkDeletePayload` (one extra column, same query, same tx).

### B — Where `activity.Record` is called

**Decision: one call inside `syncapi.PostgresStore.recordEvent` (`postgres.go:344`), with the
kind and metadata passed in explicitly by each of its 8 call sites.**

Verified by reading both layers, not inferred:

1. `sync.PostgresStore` **does** delegate to `bookmarks.Service`'s `*Tx` methods, so layer (a)
   would technically reach the live path — **but the live PATCH routes do not use
   `UpdateFolderTx`/`UpdateBookmarkTx` at all**. `bookmark_routes.go:65-74,174-183` use the
   prepared-patch path, and `bookmarks.ApplyPreparedFolderPatchTx`/`ApplyPreparedBookmarkPatchTx`
   **do not receive `userID`** — recording there would require changing their signatures and
   re-plumbing the actor into a package that has no actor concept. Layer (a) is rejected.
2. All 8 live mutation paths (6 methods + 2 prepared-patch appliers) already funnel through
   `recordEvent`, in the caller's `pgx.Tx`, immediately before commit — exactly the
   organizations/workspaces/groups shape. One wiring point instead of six or eight.
3. **Bonus correctness:** the idempotent-replay path returns early via
   `loadDuplicateMutation*`/`loadDuplicateDelete*` **before** `recordEvent`, so a retried
   extension request cannot double-audit. Recording at the bookmarks layer would not get this.

**Org resolver: not needed.** `recordEvent`'s existing `mutation_context` CTE already resolves
`w.organization_id` (`postgres.go:353-357`) and writes it into `sync_events`. Add
`organization_id` (and `w.name`) to the statement's `RETURNING`, then pass it to
`activity.Record` in the same tx. No mirror of `workspaces.loadWorkspaceOrganizationID` (which
is unexported anyway) and no extra round-trip.

### C — Activity feed filter

**Decision: a 3-way category filter — `All` / `Administrative` / `Bookmarks` — derived from
kind prefixes, not a 27-checkbox multi-select and not single-kind exact match.**

Rationale: the problem is *one* signal-vs-noise separation, not arbitrary slicing. A
multi-select solves a problem nobody has and adds URL-state, chip UI, and cursor-invalidation
complexity. Single-kind exact match is too narrow — an admin looking for "who changed access"
does not know which of 4 `workspace_access.*` kinds to pick.

| Layer | Change |
|---|---|
| SQL (`ListByOrganization`) | `AND e.kind LIKE ANY($n)` with `{'bookmark.%','folder.%'}` (Bookmarks) or `NOT LIKE ALL` (Administrative). The existing `(organization_id, created_at DESC, id DESC)` index still drives the scan; the predicate is a bounded post-filter. |
| HTTP (`activity/handler.go`) | `?category=all\|administrative\|bookmarks`, default `all`; unknown value falls back to `all` (same forgiving style as `parseListLimit`). |
| Frontend | `listOrgActivity(…, category)`; `useOrgActivity` takes category and includes it in the query key so pages do not mix. |
| UI | Segmented toggle above the table, matching the `ThemeToggle` component style established this session. Default `All`. |

### D — Retention / volume

**Confirmed by reading, not assumed: there is no pruning for `activity_events` or
`sync_events` anywhere.** The only sweep that exists (`internal/purge`) hard-deletes
soft-deleted *organizations and workspaces* past a 30-day window — it is not an event-pruning
mechanism to extend.

**Decision: build no retention in this change.** Adding an event-retention system means a
policy question (how long must a fintech client's bookmark audit be retained? likely longer,
not shorter, than admin events), a differentiated-per-kind sweep, and operator-facing config —
materially larger than "add auditing + a filter", and the wrong thing to guess at.

**Explicitly flagged, not ignored:** unbounded `activity_events` growth is a real follow-up.
The `purge.Sweeper` + ticker pattern in `internal/purge` is the natural home for it. Recommend
a separate change once a retention *policy* is agreed with the client, and monitoring
`activity_events` row count after this ships.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `backend/internal/activity/service.go` | Modified | 6 new Kinds; `category` param on `ListByOrganization`; fix stale package doc |
| `backend/internal/activity/handler.go` | Modified | Parse `?category=` |
| `backend/internal/sync/postgres.go` | Modified | `recordEvent` gains activity kind/metadata params + returns org ID; 8 call sites pass them; delete payload SELECTs gain `title`/`name` |
| `backend/internal/sync/types.go` | Modified | `PostgresStore` gains an `activity` dependency (interface, mirroring `workspaceAccessChecker`) |
| `backend/cmd/api/main.go` | Modified | Pass `activity.Service` into `NewPostgresStore` |
| `admin-web/src/lib/api/activity.ts` | Modified | 6 kinds on the union; `category` param |
| `admin-web/src/features/activity/{format.ts,queries.ts,ActivityPage.tsx}` | Modified | Sentences for 6 kinds; category in query key; segmented toggle |
| `backend/internal/bookmarks/**` | Unchanged | Deliberately untouched (Decision B) |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bulk-import bursts flood the feed | High | Category filter (Decision C); growth monitored, retention as flagged follow-up |
| Bookmark `url` in an org-admin-visible audit metadata field | Medium | Same org-scoped data admins already reach via the workspace; no new exposure class — but **confirm with product** whether `url` should be recorded for `personal`-type workspaces |
| `activity.Record` failure aborts a user's bookmark sync mutation | Medium | Intended: audit is transactional, not best-effort — consistent with existing callers. Covered by integration tests |
| `sync` → `activity` package dependency | Low | Narrow handler-local interface, matching `workspaceAccessChecker` |
| Filter cursor semantics (category switch mid-pagination) | Low | Category is part of the TanStack query key → fresh pagination per category |

## Rollback Plan

Purely additive; no migration. Revert the branch. Any `activity_events` rows already written
with the new kinds remain valid rows and render via `formatActivityEvent`'s existing
`default:` branch ("Performed bookmark.created on bookmark …"). The `?category=` param is
optional and defaults to `all`, so an older frontend against a newer backend is unaffected,
and a newer frontend against an older backend degrades to unfiltered results.

## Dependencies

- None external. Requires `activity.Service` (already constructed in `cmd/api/main.go`).

## Gitflow & Documentation Impact

- Branch: `feat/bookmark-activity-audit`, already cut from `develop`. Target `develop`. No new
  branches, no merges in this change.
- Docs: new capability spec `openspec/specs/bookmark-activity-audit/spec.md`; `activity`
  package doc comment corrected.

## Success Criteria

- [ ] Every live bookmark/folder create, update, and delete writes exactly one
      `activity_events` row, in the same transaction, attributed to the real actor.
- [ ] A retried (duplicate `Idempotency-Key`/event ID) mutation writes **zero** extra rows.
- [ ] An org admin can select `Administrative` and see the same feed as before this change —
      no bookmark/folder noise.
- [ ] An org admin can answer "who deleted bookmark X and when" from the Activity page alone.
- [ ] No change to sync behavior: cursors, replay, and idempotency responses are byte-identical.
