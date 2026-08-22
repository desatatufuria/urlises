# Tasks: Bookmark & Folder Activity Auditing

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~1,350–1,450 pre-overrun across 6 work units (Slice A: A1/A2a/A2b/A3; Slice B: B1/B2); this session's established +60% overrun pattern (`soft-delete-recovery`) puts actuals at ~2,100–2,300 total |
| 400-line budget risk | **High** — A2a (~370–450 est.) and B2 (~260–280 est.) each risk crossing 400 once overrun is applied |
| Chained PRs recommended | Yes |
| Suggested split | 6 work units: A1 → A2a → A2b → A3 → B1 → B2 |
| Delivery strategy | ask-on-risk (cached this session) |
| Chain strategy | feature-branch-chain (cached this session) — tracker `feat/bookmark-activity-audit` (current branch); only the tracker merges to `develop`, and not until the user says so |

Decision needed before apply: Yes (ask-on-risk requires confirming the A2a/A2b pre-split and the B2 scope below before `sdd-apply` starts Slice A or Slice B)
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High (A2a and B2, as designed, are each independently likely to approach or exceed 400 changed lines once this session's actual-vs-estimate overrun is applied — see basis below)

### Why A2a and B2 are flagged

A2a carries the `recordEvent` CTE restructure, the `Record()` call, all 8 call-site edits, **and** 8 of the 12 named integration test cases (6 per-mutation-type + no-op + unknown-event-type) in one file (`activity_audit_integration_test.go`) — structurally the same shape as `soft-delete-recovery`'s slice 2, which was estimated at ~750–900 and landed at **~694 actual on its smaller sub-split alone**. A2a's own pre-overrun estimate (~410) already sits above the 400-line guideline before any overrun buffer; applying the same +60% pattern lands it near ~650–700 actual. **Recommendation: keep A2a as its own chained unit, do not fold A2b's retry/failure tests into it.**

B2 introduces one net-new frontend component (`ActivityCategoryToggle.tsx` + test) **and** a mechanical CSS rename that touches an unrelated file (`ThemeToggle.tsx`) — two different review concerns in one diff. Pre-overrun estimate (~270) is Medium, but the same overrun pattern pushes it toward ~430, crossing the 400-line guideline. **Recommendation: keep B2 as its own chained unit; if it lands above ~450 actual, split the CSS rename out into its own trailing mechanical commit/PR.**

### Estimate basis (design.md File Changes table, grouped by work unit)

| File | Action | Unit | Est. lines |
|---|---|---|---|
| `backend/internal/activity/service.go` — 6 `Kind` consts, doc fix | Modify | A1 | ~15 |
| `backend/internal/activity/kind_test.go` | Modify | A1 | ~20 |
| `backend/internal/sync/postgres.go` — interface, map, struct field, constructor, 2 metadata helpers, 2 delete-payload helpers | Modify | A1 | ~65 |
| `backend/internal/sync/activity_kind_map_test.go` (new) | Create | A1 | ~30 |
| `backend/cmd/api/main.go` | Modify | A1 | ~2 |
| `backend/internal/sync/{postgres_integration,bookmark_routes,handler,replay}_test.go` — `NewPostgresStore` call sites | Modify | A1 | ~40 |
| `backend/internal/sync/postgres.go` — `recordEvent` SQL restructure + `Record()` call + 8 call sites | Modify | A2a | ~90 |
| `backend/internal/sync/activity_audit_integration_test.go` (new) — 6 mutation-type + no-op + unknown-type cases | Create | A2a | ~320 |
| `backend/internal/sync/activity_audit_integration_test.go` — 3 retry/dedup cases + audit-failure-aborts case | Create | A2b | ~170 |
| `admin-web/src/lib/api/activity.ts` — 6 union members | Modify | A3 | ~8 |
| `admin-web/src/features/activity/format.ts` — 6 cases + doc fix | Modify | A3 | ~12 |
| `admin-web/src/features/activity/format.test.ts` — 6 kinds × 2 fixtures | Modify | A3 | ~110 |
| `backend/internal/activity/service.go` — `Category` type + 3 consts + `ListByOrganization` param + predicate | Modify | B1 | ~30 |
| `backend/internal/activity/handler.go` — `routeService` signature + `parseCategory` | Modify | B1 | ~20 |
| `backend/internal/activity/handler_test.go` — stub signature + `?category=` + `parseCategory` table cases | Modify | B1 | ~55 |
| `backend/internal/activity/service_test.go` — 3-state filter + filtered pagination | Modify | B1 | ~80 |
| `admin-web/src/lib/api/activity.ts` — `ActivityCategory` + `listOrgActivity` param | Modify | B2 | ~18 |
| `admin-web/src/lib/api/activity.test.ts` — category param URL cases | Modify | B2 | ~15 |
| `admin-web/src/features/activity/queries.ts` — category param + query key | Modify | B2 | ~15 |
| `admin-web/src/features/activity/ActivityCategoryToggle.tsx` (new) | Create | B2 | ~40 |
| `admin-web/src/features/activity/ActivityCategoryToggle.test.tsx` (new) | Create | B2 | ~50 |
| `admin-web/src/features/activity/ActivityPage.tsx` | Modify | B2 | ~30 |
| `admin-web/src/features/activity/ActivityPage.test.tsx` | Modify | B2 | ~50 |
| `admin-web/src/lib/ui/tokens.css` — `.ui-theme-toggle*` → `.ui-segmented*` | Modify | B2 | ~35 |
| `admin-web/src/lib/ui/components/ThemeToggle.tsx` — class-string rename | Modify | B2 | ~10 |

### Suggested Work Units

| Unit | Goal | Branch | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| A1 | Audit wiring foundation: Kinds, lookup table, `activityRecorder` interface, constructor param, metadata/delete-payload helpers, mechanical test call-site updates | `feat/bookmark-audit-foundation` off `feat/bookmark-activity-audit` | PR 1 | `cd backend && go test ./internal/activity ./internal/sync` | `N/A` — no live DB write path is wired yet; check Postgres/Docker availability before Phase A2a | `sync/postgres.go` (interface/map/struct/ctor/helpers), `activity/service.go` (consts); revert restores the pre-audit constructor signature |
| A2a | `recordEvent` SQL restructure + `Record()` call + 8 call sites; 6 per-mutation-type + no-op + unknown-event-type RED/GREEN | `feat/bookmark-audit-recordevent` off `feat/bookmark-audit-foundation` | PR 2, base = A1 | `cd backend && go test ./internal/sync -run ActivityAudit` | `docker compose up -d`; create/update/delete a bookmark and a folder, confirm one `activity_events` row each — or `N/A`, verify Docker/Postgres availability at apply time | `sync/postgres.go` (`recordEvent` body + call sites), `sync/activity_audit_integration_test.go`; revert returns to pre-restructure SQL, no data loss |
| A2b | Retry/dedup (3 mechanisms) + audit-failure-aborts-mutation RED/GREEN; sync byte-identical regression check | `feat/bookmark-audit-retry-failure` off `feat/bookmark-audit-recordevent` | PR 3, base = A2a | `cd backend && go test ./internal/sync -run "Replay\|Idempot\|ActivityAudit"` | `docker compose up -d`; retry an already-applied mutation, confirm no extra `activity_events` row — or `N/A`, verify at apply time | `sync/activity_audit_integration_test.go` (added cases only); no production code changes beyond what A2a already shipped |
| A3 | Frontend rendering: 6 `ActivityKind` union members, `format.ts` cases, `format.test.ts` | `feat/bookmark-audit-frontend-render` off `feat/bookmark-audit-retry-failure` | PR 4, base = A2b | `cd admin-web && npm test -- format` | `N/A` — pure rendering unit tests, no backend dependency to exercise live | `admin-web/src/lib/api/activity.ts`, `admin-web/src/features/activity/format.ts`(+test); revert leaves unknown kinds on the existing `default:` sentence |
| B1 | Backend category filter: `Category` type, predicate injection, `parseCategory`, handler wiring | `feat/bookmark-category-filter-backend` off `feat/bookmark-audit-frontend-render` | PR 5, base = A3 | `cd backend && go test ./internal/activity` | `docker compose up -d`; `GET .../activity?category=bookmarks` vs `?category=administrative`, confirm disjoint kind sets — or `N/A`, verify at apply time | `activity/service.go` (`Category`+predicate), `activity/handler.go` (`parseCategory`); revert makes `?category=` a no-op again |
| B2 | Frontend category control: `ActivityCategoryToggle` (new), `ActivityPage` wiring, `listOrgActivity`/`useOrgActivity` param threading, `.ui-segmented*` CSS rename | `feat/bookmark-category-toggle-ui` off `feat/bookmark-category-filter-backend` | PR 6, base = B1 | `cd admin-web && npm test -- ActivityCategoryToggle ActivityPage ThemeToggle activity` | `npm run dev`; toggle All/Administrative/Bookmarks on the Activity page, confirm the feed and pagination reset per category — or `N/A`, verify at apply time | `admin-web/src/features/activity/*`, `admin-web/src/lib/ui/{tokens.css,components/ThemeToggle.tsx}`; revert restores `.ui-theme-toggle*` and removes the toggle only |

Each unit is developed, tested, and merged into the previous unit's branch before the next unit's branch is created. Only the tracker branch `feat/bookmark-activity-audit` eventually merges to `develop`, and only when the user says so.

## Phase A1: Audit Wiring Foundation

- [x] A1.1 RED: `backend/internal/activity/kind_test.go` — assert the 6 new `Kind` constants' exact wire values (`bookmark.created/.updated/.deleted`, `folder.created/.updated/.deleted`).
- [x] A1.2 GREEN: `backend/internal/activity/service.go` — add the 6 `Kind` constants; correct the package doc comment (drop "zero callers", name organizations/workspaces/groups/bookmarks/folders).
- [x] A1.3 RED: `backend/internal/sync/activity_kind_map_test.go` (new) — `activityKindByEventType` has exactly 6 entries; each of the 8 call sites' `eventType` literals is present and maps to the matching `Kind` constant.
- [x] A1.4 GREEN: `backend/internal/sync/postgres.go` — add `activityKindByEventType` map and the `activityRecorder` interface (declared next to `workspaceAccessChecker`).
- [x] A1.5 GREEN: `backend/internal/sync/postgres.go` — add `activity activityRecorder` field to `PostgresStore`; update `NewPostgresStore` to accept it (Decision 6: no nil guard).
- [x] A1.6 GREEN: `backend/internal/sync/postgres.go` — add `folderAuditMetadata(f bookmarks.Folder)` and `bookmarkAuditMetadata(b bookmarks.Bookmark)` helpers.
- [x] A1.7 DEFERRED to A2a: `backend/internal/sync/postgres.go` — `folderDeletePayload`/`bookmarkDeletePayload` gain `name`/`title,url` columns on the existing pre-delete SELECT and return a 3rd `audit map[string]any` value; sync payload keys stay byte-identical. Explicit scope narrowing for this apply batch: the delete-payload helpers are bound up with `recordEvent`'s `auditMetadata` wiring (A2a.3), so they move there instead of landing unused in A1.
- [x] A1.8 GREEN: `backend/cmd/api/main.go:129` — pass `activityService` into `syncapi.NewPostgresStore(...)`.
- [x] A1.9 GREEN: `backend/internal/sync/{postgres_integration,bookmark_routes,handler,replay}_test.go` — update every `NewPostgresStore` call site to pass the new `activityRecorder` argument (mechanical; nil or a no-op stub as each test already does for `publisher`). Only `postgres_integration_test.go` had call sites (5); `bookmark_routes_test.go`/`handler_test.go`/`replay_test.go` don't call `NewPostgresStore` directly, so no changes were needed there.

## Phase A2a: `recordEvent` Wiring + Core Mutation Audit Tests

- [x] A2a.1 GREEN: `backend/internal/sync/postgres.go` — restructure `recordEvent`'s SQL into the `inserted` CTE + outer SELECT joining `mutation_context` (per design.md's corrected SQL); `organization_id` and `workspace_name` reach the outer SELECT; placeholders `$1`-`$8` and the zero-row fail-closed behavior are unchanged.
- [x] A2a.2 GREEN: `backend/internal/sync/postgres.go` — `recordEvent` gains the `auditMetadata map[string]any` parameter; looks up `activityKindByEventType[eventType]` (error on miss, before the INSERT); calls `s.activity.Record(...)` inside the same `tx` with `auditMetadata` copied + `workspaceId`/`workspaceName` injected.
- [x] A2a.3 GREEN: `backend/internal/sync/postgres.go` — thread `auditMetadata` through all 8 call sites (6 direct mutation methods + `ApplyPreparedFolderPatchTx`/`ApplyPreparedBookmarkPatchTx` appliers), using `folderAuditMetadata`/`bookmarkAuditMetadata` and the delete-payload helpers' new `audit` return value.
- [x] A2a.4 RED: `backend/internal/sync/activity_audit_integration_test.go` (new) — bookmark create: exactly one `activity_events` row, `kind=bookmark.created`, `target_type=bookmark`, `organization_id` = the workspace's org, `actor_user_id` = real principal, metadata has `title`,`url`,`workspaceId`,`workspaceName`.
- [x] A2a.5 RED: same file — bookmark update: `kind=bookmark.updated`, same assertions.
- [x] A2a.6 RED: same file — bookmark delete: `kind=bookmark.deleted`, metadata `title`/`url` reflect the pre-delete state.
- [x] A2a.7 RED: same file — folder create: `kind=folder.created`, `target_type=folder`, metadata has `name`,`workspaceId`,`workspaceName`, no `url`.
- [x] A2a.8 RED: same file — folder update: `kind=folder.updated`, same assertions.
- [x] A2a.9 RED: same file — folder delete: `kind=folder.deleted`, metadata `name` reflects the pre-delete state.
- [x] A2a.10 RED: same file — no-op prepared patch (`patch.NoOp == true`) produces zero `sync_events` rows and zero `activity_events` rows.
- [x] A2a.11 RED: same file — unknown `eventType` passed to `recordEvent` returns an error and leaves a clean rollback (no `sync_events` row, no `activity_events` row, no cursor bump).
- [x] A2a.12 GREEN: verify A2a.4–A2a.11 pass against the A2a.1–A2a.3 implementation; no further production code expected.

## Phase A2b: Retry/Dedup + Audit-Failure Regression Tests

- [x] A2b.1 RED: `backend/internal/sync/activity_audit_integration_test.go` — replay the same `metadata.EventID` through `runMutation`; assert `sync_events` count == 1 and `activity_events` count == 1 (the `loadDuplicateMutation*` early-return path).
- [x] A2b.2 RED: same file — replay through `runDeleteMutation`; same 1/1 assertion (`loadDuplicateDelete*` early-return path).
- [x] A2b.3 RED: same file — replay through `IdempotencyExecutor.ExecutePrepared`; same 1/1 assertion (`claimReceipt` replay path, `Command` never runs).
- [x] A2b.4 RED: same file — inject a stub `activityRecorder` returning an error; assert the folder/bookmark row, the `sync_events` row, and the cursor bump are all absent after rollback (only possible via Decision 5's narrow interface).
- [x] A2b.5 GREEN: confirm A2b.1–A2b.4 pass with no production code changes beyond A2a (dedup/rollback plumbing already exists; these tests lock in the guarantee).
- [x] A2b.6 Regression: run existing `backend/internal/sync/replay_test.go` + `postgres_integration_test.go` unchanged; confirm cursor/replay/idempotency responses and the restructured `Envelope` fields are byte-identical (Success Criterion 5).

## Phase A3: Frontend Rendering of New Kinds

- [x] A3.1 GREEN: `admin-web/src/lib/api/activity.ts` — add the 6 new members to the `ActivityKind` union.
- [x] A3.2 RED: `admin-web/src/features/activity/format.test.ts` — for each of the 6 new kinds, one fixture with full metadata and one with missing metadata, asserting a readable sentence with no actor-name prefix and no literal `"undefined"`.
- [x] A3.3 GREEN: `admin-web/src/features/activity/format.ts` — add the 6 `case` branches before `default:`; update the stale "16 recorded Kind values" doc comment to 27; `url` is recorded but deliberately not rendered.

## Phase B1: Backend Category Filter

- [ ] B1.1 RED: `backend/internal/activity/service_test.go` — category filter, three states: seed admin-kind and bookmark/folder-kind fixtures; `all` returns every row; `bookmarks` returns only the 6 prefixes; `administrative` returns the exact complement, including an unclassified future kind (Decision 9 negation).
- [ ] B1.2 RED: same file — filtered pagination: `limit=1` with a category filter; page 2's cursor continues within the same filtered set and never surfaces an excluded row.
- [ ] B1.3 GREEN: `backend/internal/activity/service.go` — add `Category` type + `CategoryAll`/`CategoryAdministrative`/`CategoryBookmarks` constants.
- [ ] B1.4 GREEN: `backend/internal/activity/service.go` — `ListByOrganization` gains the `category Category` param; inject the constant `LIKE`/`NOT LIKE` predicate after the optional cursor clause (`LIMIT` numbering unaffected).
- [ ] B1.5 RED: `backend/internal/activity/handler_test.go` — update `activityRouteStub`'s signature to record the received `Category`; `?category=bookmarks` → `CategoryBookmarks`; absent → `CategoryAll`; `?category=nonsense` → `CategoryAll` and HTTP 200, never 400.
- [ ] B1.6 RED: same file — `parseCategory` table-driven: `""`, `"all"`, `"administrative"`, `"bookmarks"`, `"BOOKMARKS"`, `"  bookmarks  "`, `"garbage"` (mirrors `parseListLimit`'s forgiving style).
- [ ] B1.7 GREEN: `backend/internal/activity/handler.go` — `routeService` interface signature gains `category Category`; implement `parseCategory` (case/whitespace-insensitive); wire it into the route handler.

## Phase B2: Frontend Category Control + CSS Rename

- [ ] B2.1 RED: `admin-web/src/lib/api/activity.test.ts` — `listOrgActivity` emits `category=bookmarks` in the query string; omits the param entirely when `category="all"` (rollback guarantee: older-backend request stays byte-identical).
- [ ] B2.2 GREEN: `admin-web/src/lib/api/activity.ts` — add `ActivityCategory` type; `listOrgActivity` gains the `category` param, inserted before `limit`.
- [ ] B2.3 GREEN: `admin-web/src/features/activity/queries.ts` — `useOrgActivity` gains `category`; query key becomes `[...queryKeys.organization(id).activity, category]`.
- [ ] B2.4 RED: `admin-web/src/features/activity/ActivityCategoryToggle.test.tsx` (new) — 3 buttons render; `aria-pressed` is `true` only on the active category; `onChange` fires with each value on click.
- [ ] B2.5 GREEN: `admin-web/src/features/activity/ActivityCategoryToggle.tsx` (new) — `role="group"` segmented control, 3 text-label buttons, `className="ui-segmented"`.
- [ ] B2.6 RED: `admin-web/src/features/activity/ActivityPage.test.tsx` — selecting a category refetches with the new category and does not render the previous category's rows (distinct query key); "Load more" pagination stays within the selected category.
- [ ] B2.7 GREEN: `admin-web/src/features/activity/ActivityPage.tsx` — `useState<ActivityCategory>("all")`; render `ActivityCategoryToggle`; update page copy to stop claiming admin-only content.
- [ ] B2.8 GREEN: `admin-web/src/lib/ui/tokens.css` — rename `.ui-theme-toggle*` → `.ui-segmented*` (4 rules + the dark-theme hover at line 17).
- [ ] B2.9 GREEN: `admin-web/src/lib/ui/components/ThemeToggle.tsx` — update the 3 class strings to `.ui-segmented*`; confirm `ThemeToggle.test.tsx` stays green untouched (asserts roles/`aria-pressed` only, never class names).

## Phase 5: Verification

- [ ] 5.1 `cd backend && go build ./... && go vet ./... && go test ./internal/activity ./internal/sync ./cmd/api` — build/vet clean; touched packages pass.
- [ ] 5.2 `cd admin-web && npm run build && npm test` — build clean; all suites pass, including `ActivityCategoryToggle`, `ActivityPage`, `format`, `activity`, and `ThemeToggle`.
- [ ] 5.3 Check current Postgres/Docker availability for this session (e.g. `docker ps`) before relying on it in A2a/A2b/B1/B2's runtime harness steps. If unavailable, defer to the same contingency `soft-delete-recovery` used (task 5.3 there): validate the live create/update/delete/retry/category-filter/toggle behavior against a running environment once Docker is available, rather than assuming it works from unit/integration coverage alone.
