# Design: Soft Delete + Recovery Window for Organizations and Workspaces

## Technical Approach

Four slices, in the proposal's order. The governing idea is a **fail-safe default**: every existing role/metadata lookup gains the `deleted_at IS NULL` predicate so the *default* path is filtered, and the two places that must ignore deletion (restore, trash listing) get explicitly named `...IncludingDeleted` helpers. That inverts the proposal's highest-likelihood risk ("a missed predicate leaves a deleted entity reachable"): a missed predicate is now impossible to introduce silently, because reaching a deleted row requires calling a function whose name says so.

The second idea is that **soft delete never touches `organization_members`**. Membership rows are the durable authorization substrate; the soft-delete predicate belongs on *organization liveness*, not on *who you are*. That single distinction resolves the slice-3 admin-gate edge case (see the Decision row) without special-casing anything.

Nothing here invents a pattern. `deleted_at TIMESTAMPTZ` nullable mirrors `000013`'s `disabled_at`; partial indexes mirror `idx_folders_workspace_parent_position` (`000001:105`); `POST .../restore` mirrors the `POST .../invitations/{id}/cancel|resend` state-transition precedent; the purge ticker is a copy of the **already existing** hourly goroutine at `backend/cmd/api/main.go:110-123` (see Deviation 7 — the exploration's "zero scheduler infrastructure" finding is wrong).

Slice independence: 1 is frontend-only. 2 is backend-only and self-contained. 3 depends on 2's predicates and creates `internal/purge` holding only `purge.Window`. 4 depends on 2 and adds the sweeper to that package.

## Architecture Decisions

| Decision | Options / tradeoff | Choice and rationale |
|---|---|---|
| **Slice 1 confirmation shape** | Per-row inline expansion vs. one URL-driven `ContextPanel` keyed by the selected workspace | **One `ContextPanel`**, opened by the existing per-row Delete button via `?panel=workspace-delete&workspace={id}`, rendered with `key={selectedWorkspaceId}`. Three reasons: (a) `ConfirmByTyping` holds internal `value` state (`ConfirmByTyping.tsx:23`), so switching rows must remount it — the `key` guarantees that; N mounted instances would each retain stale text. (b) `WorkspacesPage.tsx:141` already uses exactly this `ContextPanel` + `useSearchParams` idiom for `panel=workspace-create`, and `StateHome.tsx:47` uses it for org delete — reconciling the two patterns means using the one they already share. (c) `Table` takes flat `columns` + `<tr>` children; a column-spanning expansion row is a new layout primitive and new CSS for no gain. `expected` = `workspace.workspaceName`. `deletingWorkspaceId` busy flag and the page-level `notice` banner stay unchanged. |
| **Where the org-liveness predicate lives** | JOIN inside each role lookup vs. a separate `requireOrganizationLive` composed before each role check | **JOIN inside the role lookup** (3 copies: `organizations.loadOrganizationRole`, `groups.requireOrganizationAdmin`, `access.IsOrganizationAdmin`). Composition would require every current and *future* call site to remember a second call; the JOIN makes the filtered behavior the only behavior. The cost — restore needs an unfiltered variant — is paid once, in one named function, in one package. |
| **Org soft delete does not cascade to `workspaces.deleted_at`** | Stamp `deleted_at` on the org's workspaces too vs. leave them NULL and enforce org liveness by JOIN | **Leave them NULL.** Reachability comes from `access.loadWorkspaceMetadata`'s existing `JOIN organizations o` gaining `AND o.deleted_at IS NULL`, which is one predicate covering every workspace read, sync mutation and websocket connect. Stamping children would make restore ambiguous (which workspaces were deleted *individually* before the org went?) and would need a second timestamp to disambiguate. Purge still destroys them correctly via the untouched FK cascade. |
| **Indexing** | Partial index on the hot path (`(id) WHERE deleted_at IS NULL`) vs. on the trash side (`(deleted_at) WHERE deleted_at IS NOT NULL`) vs. none | **Trash side only**, one per table. The hot path is always `WHERE id = $1 AND deleted_at IS NULL` or a PK join — the predicate filters a row the PK/FK index has *already located*, so a partial index adds write cost for zero read benefit (identical reasoning to `000013`'s "no index" comment). The trash-side index is the opposite: it contains only soft-deleted rows (near-empty in steady state), is never touched by writes to live rows, and serves **both** the hourly purge scan and both Trash list queries. |
| **Restore idempotency error** | New `ErrOrganizationNotDeleted` → 409 vs. reuse `ErrNotFound` → 404 | **Reuse `ErrNotFound` → 404.** `UPDATE ... WHERE id = $1 AND deleted_at IS NOT NULL`, `RowsAffected()==0 → ErrNotFound`. Restore is a Trash-scoped action; a live organization genuinely is not in the trash. No new sentinel, no `writeOrganizationError`/`writeWorkspaceError` case, and double-restore is naturally idempotent-safe. |
| **Restore admin gate on a deleted org** (the hard case) | Special-case the gate vs. re-derive authorization from membership | **Re-derive from membership.** After slice 2, `organizations.requireOrganizationAdmin` resolves a role only for *live* organizations, so calling it inside `RestoreOrganization` would return `ErrForbidden` for **every** restore — the gate would be unconditionally closed and restore would be unreachable. This is not a bug to patch around: soft delete never modified `organization_members`, so that row still carries exactly the role the requester held at deletion time. `RestoreOrganization` therefore calls `loadOrganizationRoleIncludingDeleted` — byte-identical to today's `loadOrganizationRole` SQL (`organization_members` only, no join) — and rejects anything other than `owner`/`admin`. **This is the single place in the codebase where the soft-delete predicate is deliberately absent, and it is the slice's primary adversarial surface** (named test required: a plain `member` and a non-member must both get 403). |
| **Restore admin gate for a workspace** | Mirror the org exception vs. require the org to be live | **Require the org to be live** — no exception needed. `loadDeletedWorkspaceMetadataRecord` uses `w.deleted_at IS NOT NULL AND o.deleted_at IS NULL`, so a workspace inside a soft-deleted organization is not individually restorable (restore the organization first; if the workspace's own `deleted_at` is NULL it returns automatically). Consequently `access.RequireOrganizationAdmin` — already org-liveness-filtered from slice 2 — is correct as-is on this path. |
| **Trash scoping and route shape** | Org-scoped (`GET /organizations/{id}/trash`) vs. requester-scoped (`GET /organizations/deleted`, `GET /workspaces/deleted`) | **Requester-scoped, two endpoints, one per owning package.** Org-scoping is impossible for deleted organizations (there is no live org to scope to) and would force the Trash screen to depend on the active-org selector. Authorization is *inline in the query* — `JOIN organization_members om ON ... AND om.role IN ('owner','admin')` — never `requireOrganizationAdmin`, so the result set cannot leak beyond what the requester administers and an unauthorized requester gets an empty list, never a 403. Two endpoints keep each route in its own domain package, matching every other route in the repo. |
| **`purgeAt` computed server-side** | Client computes `deletedAt + 30 days` vs. server returns `purgeAt` | **Server returns `purgeAt`** (`(deleted_at + $1::interval)`). The 30-day window is a hardcoded constant (proposal non-goal: no config knob); returning the derived timestamp keeps it in exactly one place instead of duplicating it in TypeScript. "Days remaining" is then one client-side subtraction. |
| **Home of the window constant** | Duplicate the interval literal in 4 SQL strings vs. one Go const | **`purge.Window = 30 * 24 * time.Hour`**, in `backend/internal/purge`, created by **slice 3** (constant + package doc only) and extended by slice 4 with the sweeper. Slice 3 stays independently shippable; the constant never drifts between the Trash countdown and the sweep. |
| **Sweep interval** | 24h vs. 1h vs. 15m | **1 hour**, and `time.Hour` literally — the same cadence as the existing `idempotencyExecutor.Cleanup` ticker in `main.go:110`, so the process has one background idiom and one cadence. Against a 30-day window, 1h of purge latency is 0.14%; finer granularity has no product meaning. 24h is worse than it looks: `time.NewTicker` does not fire on creation, so with a daily tick a process restarted daily would **never** sweep. |
| **Sweep transaction and locking** | Two autocommit `DELETE`s vs. both inside one transaction vs. transaction + advisory lock | **One transaction, no advisory lock.** Single production instance is confirmed, so the lock is unnecessary today; the transaction is what makes a future second instance fail *safe* rather than silently double-purge — a concurrent identical sweep blocks on row locks, then deletes 0 rows and logs a 0-count line. The package doc states the exact condition under which an advisory lock becomes mandatory. |
| **Purge result capture** | `DELETE ... RETURNING id` vs. `Exec` + `RowsAffected()` | **`Exec` + `RowsAffected()`.** Observability needs counts, not identifiers; `RETURNING id` would materialize rows nothing reads. (Minor deviation from the proposal's risk-table sketch — Deviation 9.) |
| **Purge observability** | Metrics system vs. log only non-empty sweeps vs. one line per sweep | **One structured line per sweep, always**, in the repo's existing `event=key value` log idiom (`httpapi/errors.go:48`): `event=purge_sweep_completed organizations=%d workspaces=%d duration_ms=%d`. Logging only non-empty sweeps makes silence ambiguous between "healthy, nothing expired" and "ticker died" — the zero-count line *is* the last-sweep heartbeat, at 24 lines/day. Failures log `event=purge_sweep_failed` with no error detail, following `LogIdempotencyCleanupFailure`'s deliberate no-detail policy (it has an explicit test asserting pgx credentials never reach the log). |

## Data Flow

    Slice 2 -- DELETE /organizations/{organizationId}          (shape unchanged, verb changed)
      -> organizations.DeleteOrganization(ctx, principal.UserID, organizationID)
         tx = pool.Begin
         lockOrganization        (+ AND deleted_at IS NULL)     -> ErrNotFound  [also covers double-delete]
         requireOrganizationAdmin (now org-liveness filtered)    -> ErrForbidden
         lockOrganizationMemberships
         orphan probe (+ soft-deleted orgs no longer count as reachable) -> ErrWouldOrphanMember
         UPDATE organizations SET deleted_at=NOW(), deleted_by_user_id=$2, updated_at=NOW()
                WHERE id=$1 AND deleted_at IS NULL              -> RowsAffected()==0 -> ErrNotFound
         activity.Record(KindOrganizationDeleted)                [NEW: now possible, nothing cascades]
         tx.Commit                                              -> 204

    Slice 2 -- every read path collapses onto three filtered lookups
         access.loadWorkspaceMetadata   (w.deleted_at IS NULL AND o.deleted_at IS NULL)
             <- GetEffectiveWorkspaceAccess <- RequireWorkspaceWriteAccess <- bookmarks, sync store
             <- GetAccessibleWorkspace  <- GetTree, GET /workspaces/{id}, websocket connect, sync ListChanges
         access.IsOrganizationAdmin     (JOIN organizations ... deleted_at IS NULL)
             <- activity.ListByOrganization, all 8 workspaces org-admin gates
         organizations.loadOrganizationRole / groups.requireOrganizationAdmin (same JOIN)
             <- members, invitations, groups

    Slice 3 -- POST /organizations/{organizationId}/restore
      -> organizations.RestoreOrganization(ctx, principal.UserID, organizationID)
         tx = pool.Begin
         lockDeletedOrganization   (WHERE id=$1 AND deleted_at IS NOT NULL FOR UPDATE) -> ErrNotFound
         loadOrganizationRoleIncludingDeleted  <-- THE deliberate exception, no org join
                                                   role NOT IN (owner,admin) -> ErrForbidden
         -- no ErrWouldOrphanMember / ErrSoleOwner re-run (Decision D: memberships were never touched)
         UPDATE organizations SET deleted_at=NULL, deleted_by_user_id=NULL, updated_at=NOW()
                WHERE id=$1 AND deleted_at IS NOT NULL          -> RowsAffected()==0 -> ErrNotFound
         activity.Record(KindOrganizationRestored)
         tx.Commit -> 204 -> admin-web: invalidate trash.organizations + refreshOrganizations()

    Slice 3 -- POST /workspaces/{workspaceId}/restore
      -> workspaces.Restore(ctx, principal.UserID, workspaceID)
         loadDeletedWorkspaceMetadataRecord (w.deleted_at IS NOT NULL AND o.deleted_at IS NULL) -> ErrNotFound
         access.RequireOrganizationAdmin (filtered copy is correct here) -> mapAccessError -> ErrForbidden
         UPDATE workspaces SET deleted_at=NULL, ... WHERE id=$1 AND organization_id=$2 AND deleted_at IS NOT NULL
         activity.Record(KindWorkspaceRestored) -> tx.Commit -> 204

    Slice 4 -- ticker (main.go, ctx = signal.NotifyContext root)
      go purgeSweeper.Run(ctx, time.Hour)
         <-ctx.Done() -> return                 (SIGTERM cancels the loop and any in-flight query)
         <-ticker.C   -> Sweep(ctx):
              tx = pool.Begin
              DELETE FROM organizations WHERE deleted_at < NOW() - $1::interval   [FK cascade does the rest]
              DELETE FROM workspaces    WHERE deleted_at < NOW() - $1::interval
              tx.Commit
              log event=purge_sweep_completed organizations=N workspaces=M duration_ms=D

## Interfaces / Contracts

### Choke points — exhaustive `deleted_at IS NULL` inventory (slice 2)

Every row below was read; aliases and predicates are exact, not inferred.

| # | Location | Current clause | Add | Effect |
|---|---|---|---|---|
| 1 | `organizations/service.go:140-141` `ListMemberships` | `JOIN organizations o ON o.id = om.organization_id` / `WHERE om.user_id = $1` | `AND o.deleted_at IS NULL` on the JOIN | Deleted org vanishes from the org switcher |
| 2 | `organizations/service.go:918-922` `loadOrganizationRole` | `FROM organization_members WHERE organization_id = $1 AND user_id = $2` | alias to `om`, add `JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL` | Closes `requireOrganizationAdmin` (`:904`) → `ListMembers`, `PatchMember`, `AuthorizeInvitationTx`, `ListInvitations`, `CancelInvitation`, `ResendInvitation`, `DeleteOrganization` |
| 3 | `organizations/service.go:941-946` `loadOrganizationMember` | `FROM organization_members om JOIN users u ...` | `JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL` | Defense in depth behind #2 → `ErrNotFound` |
| 4 | `organizations/service.go:979` `lockOrganization` | `WHERE id = $1 FOR UPDATE` | `AND deleted_at IS NULL` | Double-delete → `ErrNotFound` *before* the admin gate |
| 5 | `organizations/service.go:483-486` `CreateInvitationTx` context | `FROM organizations o ... WHERE o.id = $1` | `AND o.deleted_at IS NULL` | Defense in depth behind #2 |
| 6 | `organizations/service.go:573-576` `ResendInvitation` context | same shape | `AND o.deleted_at IS NULL` | Defense in depth behind #2 |
| 7 | `organizations/service.go:868-870` `ValidatePendingInvitation` | `JOIN organizations o ON o.id = i.organization_id WHERE i.token = $1` | `AND o.deleted_at IS NULL` | **Required** — token route, no upstream gate. Blocks registering into a deleted org |
| 8 | `organizations/service.go:1049-1051` `loadInvitationForUpdate` | same JOIN, `FOR UPDATE` | `AND o.deleted_at IS NULL` | **Required** — `AcceptInvitation` is token-based and ungated |
| 9 | `organizations/service.go:717-721` orphan probe inner `NOT EXISTS` | `WHERE other.user_id = om.user_id AND other.organization_id <> $1` | `AND EXISTS (SELECT 1 FROM organizations o2 WHERE o2.id = other.organization_id AND o2.deleted_at IS NULL)` | A member whose only other org is in the trash **is** orphaned (see Deviation 5) |
| 10 | `groups/service.go:376-380` `requireOrganizationAdmin` (the duplicate) | `FROM organization_members WHERE organization_id = $1 AND user_id = $2` | alias `om` + `JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL` | Closes the exploration's named blind spot |
| 11 | `groups/service.go:398-403` `requireOrganizationMembership` | `EXISTS(SELECT 1 FROM organization_members WHERE ...)` | same JOIN inside the `EXISTS` | Group-member ops on a deleted org |
| 12 | `access/service.go:77-81` `IsOrganizationAdmin` | `FROM organization_members WHERE organization_id = $1 AND user_id = $2` | alias `om` + `JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL` | Closes `activity.ListByOrganization` and all 8 `workspaces` org-admin gates (`:268,305,324,365,404,449,494,532`) |
| 13 | `access/service.go:144-148` `loadWorkspaceMetadata` | `FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = $1` | `AND w.deleted_at IS NULL AND o.deleted_at IS NULL` | **Highest leverage.** `ErrNoRows → ErrForbidden` (existing) → 403 for `GetTree`, `GET /workspaces/{id}`, bookmark mutations, sync `ListChanges`, websocket connect |
| 14 | `workspaces/service.go:173, 209` `ListByOrganization` | `JOIN organizations o ...` / `WHERE w.organization_id = $2` | `AND o.deleted_at IS NULL` on the JOIN, `AND w.deleted_at IS NULL` on the outer WHERE | The inner `grants` UNION branch at `:204-207` needs nothing — it is inner-joined on `w.id` and the outer WHERE filters it |
| 15 | `workspaces/service.go:669-671` `loadWorkspaceMetadataRecord` | `FROM workspaces w JOIN organizations o ... WHERE w.id = $1` | `AND w.deleted_at IS NULL AND o.deleted_at IS NULL` | `Delete` (double-delete → 404) and `GetAccessSnapshot` |
| 16 | `workspaces/service.go:651-653` `loadWorkspaceOrganizationID` | `FROM workspaces WHERE id = $1` | `AND deleted_at IS NULL` | `GrantUserAccess`, `RevokeUserAccess`, `GrantGroupAccess`, `RevokeGroupAccess` → `ErrNotFound` |

**Explicit N/A rows** (checked, no change, reason recorded):

| Location | Why no change |
|---|---|
| `workspaces/service.go:597, 625` `GetTree` folders/bookmarks | Their `deleted_at IS NULL` is the **sync tombstone**, a different mechanism (cursor protocol, no restore, no purge). Workspace reachability is enforced upstream at #13. The two mechanisms must stay distinctly named in code comments (proposal risk row). |
| `sync/postgres.go:355` `recordEvent` `mutation_context` | Reached only after `RequireWorkspaceWriteAccess`/`GetAccessibleWorkspace` (#13). Fails closed anyway: no matching `workspaces` row ⇒ `INSERT ... SELECT` inserts nothing ⇒ `RETURNING` yields `ErrNoRows` ⇒ error. |
| `sync/postgres.go:400, 417` folder/bookmark filters | Sync tombstone again. |
| `organizations/service.go:965-969` `countOwners` | Only ever reached after #2. |
| `workspaces/service.go:691-695` `loadGroupOrganizationID` | `groups` has no `deleted_at`; its org's liveness is enforced by #10. |
| `access/service.go:167-181` `loadWorkspaceGrants` | Grants are only read after #13 already resolved metadata. |
| `auth/service.go:250-252` `SetupRequired` | **Deliberately unchanged.** A soft-deleted last organization keeps `SetupRequired=false`, so bootstrap does not reopen and the registration lock stays engaged for the whole window. Filtering it would *loosen* a security gate on the strength of a reversible action (Open Question 4). |
| `auth/service.go:~235-240` sole-owner probe | **Deliberately unchanged** — filtering would loosen `ErrSoleOwner` (Deviation 6). |
| `activity_events` | **Zero code change** (Decision E). Nothing cascades until purge, so the audit trail survives as a consequence of not deleting the row. Not a feature to build. |

### Backend signatures

```go
// organizations/service.go — no new sentinel errors
func (s *Service) RestoreOrganization(ctx context.Context, requesterUserID, organizationID string) error
func (s *Service) ListDeletedOrganizations(ctx context.Context, requesterUserID string) ([]DeletedOrganization, error)

// unexported, slice 3 — the two deliberate exceptions, named so review cannot miss them
func loadOrganizationRoleIncludingDeleted(ctx context.Context, querier dbQuerier, organizationID, userID string) (access.OrganizationRole, error) // == today's loadOrganizationRole SQL, verbatim
func lockDeletedOrganization(ctx context.Context, querier dbQuerier, organizationID string) error

type DeletedOrganization struct {
    OrganizationID   string  `json:"organizationId"`
    OrganizationName string  `json:"organizationName"`
    Role             string  `json:"role"`
    DeletedAt        string  `json:"deletedAt"`
    DeletedByEmail   *string `json:"deletedByEmail,omitempty"`
    PurgeAt          string  `json:"purgeAt"`
}

// workspaces/service.go
func (s *Service) Restore(ctx context.Context, requesterUserID, workspaceID string) error
func (s *Service) ListDeleted(ctx context.Context, requesterUserID string) ([]DeletedWorkspace, error)
func loadDeletedWorkspaceMetadataRecord(ctx context.Context, querier dbQuerier, workspaceID string) (workspaceMetadataRecord, error)

type DeletedWorkspace struct {
    WorkspaceID, WorkspaceName, WorkspaceType string
    OrganizationID, OrganizationName          string
    DeletedAt                                 string
    DeletedByEmail                            *string
    PurgeAt                                   string
}

// activity/service.go — three new kinds
const (
    KindOrganizationDeleted  Kind = "organization.deleted"   // newly possible, see Deviation 3
    KindOrganizationRestored Kind = "organization.restored"
    KindWorkspaceRestored    Kind = "workspace.restored"
)

// purge/purge.go — Window created by slice 3, Sweeper by slice 4
const Window = 30 * 24 * time.Hour
type Result struct{ Organizations, Workspaces int64 }
func NewSweeper(pool *pgxpool.Pool, output io.Writer) *Sweeper
func (s *Sweeper) Sweep(ctx context.Context) (Result, error)
func (s *Sweeper) Run(ctx context.Context, interval time.Duration) // ticker loop; returns on ctx.Done()
```

`routeService` additions: `RestoreOrganization`, `ListDeletedOrganizations` on `organizations.routeService` (`handler.go:14-24`); `Restore`, `ListDeleted` on `workspaces.routeService` (`handler.go:13-23`).

### The five non-obvious queries

```sql
-- Soft delete (organizations). Idempotent: a second call affects 0 rows.
UPDATE organizations SET deleted_at = NOW(), deleted_by_user_id = $2, updated_at = NOW()
WHERE id = $1 AND deleted_at IS NULL;

-- Soft delete (workspaces). Keeps the existing organization_id scoping.
UPDATE workspaces SET deleted_at = NOW(), deleted_by_user_id = $3, updated_at = NOW()
WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL;

-- Trash: organizations. Authorization is the JOIN, not a gate call. $1 = requesterUserID,
-- $2 = purge.Window. A non-admin simply gets an empty list, never a 403.
SELECT o.id, o.name, om.role, o.deleted_at::text, u.email, (o.deleted_at + $2::interval)::text
FROM organizations o
JOIN organization_members om ON om.organization_id = o.id
                            AND om.user_id = $1
                            AND om.role IN ('owner', 'admin')
LEFT JOIN users u ON u.id = o.deleted_by_user_id
WHERE o.deleted_at IS NOT NULL
ORDER BY o.deleted_at DESC, o.id;

-- Trash: workspaces. o.deleted_at IS NULL is deliberate — a workspace inside a trashed
-- organization is not individually restorable, so it is not individually listed.
SELECT w.id, w.name, w.type, o.id, o.name, w.deleted_at::text, u.email,
       (w.deleted_at + $2::interval)::text
FROM workspaces w
JOIN organizations o ON o.id = w.organization_id AND o.deleted_at IS NULL
JOIN organization_members om ON om.organization_id = w.organization_id
                            AND om.user_id = $1
                            AND om.role IN ('owner', 'admin')
LEFT JOIN users u ON u.id = w.deleted_by_user_id
WHERE w.deleted_at IS NOT NULL
ORDER BY w.deleted_at DESC, w.id;

-- Purge sweep, both statements in one transaction, organizations first so their
-- workspaces cascade away before the workspace pass runs. $1 = purge.Window.
DELETE FROM organizations WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - $1::interval;
DELETE FROM workspaces    WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - $1::interval;
```

### HTTP contract

| Method | Path | Package | Success | Errors |
|---|---|---|---|---|
| `POST` | `/organizations/{organizationId}/restore` | organizations | `204` | `403` `ErrForbidden`, `404` `ErrNotFound` |
| `GET` | `/organizations/deleted` | organizations | `200 {"organizations":[…]}` | none (empty list for non-admins) |
| `POST` | `/workspaces/{workspaceId}/restore` | workspaces | `204` | `403` `ErrForbidden`, `404` `ErrNotFound` |
| `GET` | `/workspaces/deleted` | workspaces | `200 {"workspaces":[…]}` | none |

**No new `writeOrganizationError` / `writeWorkspaceError` cases** — every status reuses an existing branch. `DELETE /organizations/{id}` and `DELETE /workspaces/{id}` keep their exact current status set; only the persisted effect changes.

Route-precedence note: `GET /workspaces/deleted` coexists with `GET /workspaces/{workspaceId}` because Go 1.22+ `ServeMux` prefers the more specific literal segment — no conflict, no panic. There is no `GET /organizations/{organizationId}` pattern at all, so `GET /organizations/deleted` is unambiguous. Both need an explicit route test asserting the literal wins.

### Frontend API clients

```ts
// lib/api/organizations.ts
export function restoreOrganization(token: string, organizationId: string)        // POST /organizations/{o}/restore
export async function listDeletedOrganizations(token: string)                     // GET  /organizations/deleted
// lib/api/workspaces.ts
export function restoreWorkspace(token: string, workspaceId: string)              // POST /workspaces/{w}/restore
export async function listDeletedWorkspaces(token: string)                        // GET  /workspaces/deleted
// lib/api/queryKeys.ts — top level, not org-scoped: both lists span organizations
trash: { organizations: ["trash", "organizations"] as const, workspaces: ["trash", "workspaces"] as const }
```

`apiRequest` already returns `undefined as T` on 204 (`lib/api/client.ts:101`) — no client change. Restore mutations invalidate: org → `trash.organizations` + `auth.organizations` **and** call `refreshOrganizations()` so the restored org reappears in the switcher; workspace → `trash.workspaces` + `organization(orgId).workspaces` + `["workspaces"]`, mirroring `useDeleteWorkspaceMutation`. Restore is non-destructive, so **no `ConfirmByTyping`** on the Restore buttons.

## File Changes

| File | Action | Slice | Description |
|---|---|---|---|
| `admin-web/src/features/workspaces/WorkspacesPage.tsx` | Modify | 1 | Delete button opens `?panel=workspace-delete&workspace={id}`; new `ContextPanel` + `ConfirmByTyping(expected=workspaceName)` keyed by the selected id; `window.confirm` (line 108) removed |
| `backend/migrations/000014_soft_delete.sql` | Create | 2 | `deleted_at` + `deleted_by_user_id` on both tables, two partial indexes |
| `backend/internal/organizations/service.go` | Modify | 2, 3 | Soft-delete `UPDATE`; choke points 1-9; `KindOrganizationDeleted`; `RestoreOrganization`, `ListDeletedOrganizations`, `loadOrganizationRoleIncludingDeleted`, `lockDeletedOrganization` |
| `backend/internal/organizations/handler.go` | Modify | 3 | `routeService` +2; `POST /organizations/{organizationId}/restore`; `GET /organizations/deleted` |
| `backend/internal/groups/service.go` | Modify | 2 | Choke points 10-11 (the duplicated admin check) |
| `backend/internal/access/service.go` | Modify | 2 | Choke points 12-13 (`IsOrganizationAdmin`, `loadWorkspaceMetadata`) |
| `backend/internal/workspaces/service.go` | Modify | 2, 3 | Soft-delete `UPDATE`; choke points 14-16; `Restore`, `ListDeleted`, `loadDeletedWorkspaceMetadataRecord` |
| `backend/internal/workspaces/handler.go` | Modify | 3 | `routeService` +2; `POST /workspaces/{workspaceId}/restore`; `GET /workspaces/deleted` |
| `backend/internal/activity/service.go` | Modify | 2, 3 | Three new `Kind` constants |
| `admin-web/src/features/activity/format.ts` | Modify | 2, 3 | Three `case` branches (the `default` already degrades gracefully) |
| `admin-web/src/lib/api/activity.ts` | Modify | 2, 3 | Three members on the `ActivityKind` union |
| `backend/internal/purge/purge.go` | Create | 3, 4 | `Window` const + package doc (slice 3); `Sweeper`, `Sweep`, `Run` (slice 4) |
| `admin-web/src/lib/api/organizations.ts` | Modify | 3 | `restoreOrganization`, `listDeletedOrganizations` |
| `admin-web/src/lib/api/workspaces.ts` | Modify | 3 | `restoreWorkspace`, `listDeletedWorkspaces` |
| `admin-web/src/lib/api/queryKeys.ts` | Modify | 3 | `trash.organizations`, `trash.workspaces` |
| `admin-web/src/features/trash/queries.ts` | Create | 3 | `useDeletedOrganizations`, `useDeletedWorkspaces` |
| `admin-web/src/features/trash/mutations.ts` | Create | 3 | `useRestoreOrganizationMutation`, `useRestoreWorkspaceMutation` |
| `admin-web/src/features/trash/TrashPage.tsx` | Create | 3 | Two `Table`s (name, deleted, deleted by, days remaining, Restore), `restoringId` busy state, `notice` `DataState` — the `WorkspacesPage` shape |
| `admin-web/src/app/router.tsx` | Modify | 3 | `{ path: "trash", element: <TrashPage /> }` as a SIBLING of `setup/organization`, directly under `RequireSession` — NOT nested inside `AdminLayout`/`RequireAdminOrganization` (see the resolved Open Question above: this is what makes Trash reachable with zero live organizations) |
| `admin-web/src/app/shell/AdminLayout.tsx` | Modify | 3 | `{ to: "/trash", label: "Trash" }` before the trailing Account item — links to the same standalone route; navigating there unmounts `AdminLayout` |
| `admin-web/src/app/views/OrganizationSetupPage.tsx` | Modify | 3 | "Recover a deleted organization" link to `/trash` |
| `backend/cmd/api/main.go` | Modify | 4 | `purgeSweeper := purge.NewSweeper(pool, os.Stdout)`; `go purgeSweeper.Run(ctx, time.Hour)` |
| `openspec/changes/lifecycle-management/specs/` | Modify | 2, 3 | Delete requirements must stop claiming deletion is permanent |

## Migration DDL

`backend/migrations/000014_soft_delete.sql` (highest existing on this branch is `000013_user_deactivation.sql` — verified).

```sql
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Trash-side partial indexes only. They contain solely soft-deleted rows, so they are
-- near-empty in steady state and are never touched by writes to live rows. They serve
-- BOTH the hourly purge scan (deleted_at < NOW() - interval) and the two Trash list
-- queries (deleted_at IS NOT NULL).
-- Deliberately NO index on the "not deleted" hot path: those reads are always
-- WHERE id = $1 AND deleted_at IS NULL, or a PK/FK join, so the predicate filters a row
-- the existing index has already located -- same reasoning as 000013's disabled_at.
CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at
    ON organizations (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspaces_deleted_at
    ON workspaces (deleted_at) WHERE deleted_at IS NOT NULL;

-- deleted_by_user_id is ON DELETE SET NULL, matching activity_events.actor_user_id:
-- a deleter's own account removal must not block or cascade the trashed row.
-- NOTE: these deleted_at columns are the ORG/WORKSPACE RECOVERY WINDOW mechanism.
-- They are NOT the folders/bookmarks sync tombstone from 000001, which shares only
-- the column name (cursor protocol, no restore, no purge).
-- Rollback: see design.md "Migration / Rollout" -- decide the fate of pending rows
--   BEFORE reverting code, or every trashed entity resurrects as live.
--   ALTER TABLE organizations DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS deleted_by_user_id;
--   ALTER TABLE workspaces    DROP COLUMN IF EXISTS deleted_at, DROP COLUMN IF EXISTS deleted_by_user_id;
```

## Deviations Requiring Re-confirmation

1. **Decision C contradicts Success Criterion 6.** Decision C says a soft-deleted organization is *immediately inaccessible*; Success Criterion 6 says its `activity_events` are *"still readable for the whole window"*. Both cannot hold: `activity.ListByOrganization` gates on `access.RequireOrganizationAdmin`, which choke point 12 filters. **Chosen: Decision C wins** — the audit trail is *preserved* for the window and becomes readable again on restore, but is not served while the org is in the trash. Confirm this reading of Decision E ("keeps its audit trail") as durability rather than live readability.
2. **`deleted_by_user_id` column added**, beyond the proposal's "`deleted_at` on `organizations` and `workspaces`". Decision F asks Trash to show "deleted-by (when recorded)"; a column is cheaper and more reliable than joining `activity_events` per row. Additive, nullable, `ON DELETE SET NULL`.
3. **`organization.deleted` activity kind is now recorded**, reversing `lifecycle-management` design Deviation 1. That decision ("record nothing") was correct only because the hard `DELETE` cascaded the event away in its own transaction. Under soft delete nothing cascades, so the event survives — and it is what supplies "deleted by" to the activity log. Confirm this reversal is wanted rather than left alone for minimal diff.
4. **No purge activity events**, despite the proposal's Affected Areas listing "purge events". For organizations it is structurally impossible (`activity_events.organization_id` is `NOT NULL ... ON DELETE CASCADE` — the event dies with the org in the same statement). For workspaces it would need a null actor, and `activity.Record`'s signature takes `actorUserID string` with no null variant. Replaced by the per-sweep log line.
5. **The orphan probe's anti-join must exclude soft-deleted organizations** (choke point 9). Decision D says the guards apply "unchanged", but leaving the probe as-is would let an admin delete an org while a member's only *other* organization sits in the trash, leaving them with zero reachable orgs — exactly what the guard exists to prevent. This makes the guard **stricter**, and is required for Decision C consistency.
6. **The `auth` sole-owner probe is left unchanged** and still counts soft-deleted organizations. This is deliberately asymmetric with item 5: filtering there would *loosen* `ErrSoleOwner` (letting someone deactivate while sole owner of a restorable org, leaving nobody able to restore it). Confirm the fail-safe asymmetry.
7. **The exploration's "no scheduled-job/cron infrastructure exists — zero `Ticker` matches" finding is wrong.** `backend/cmd/api/main.go:110-123` already runs an hourly, `ctx`-cancelled, in-process goroutine ticker for `idempotencyExecutor.Cleanup`. Decision B's framing of the ticker as "net-new architecture for this backend" is therefore overstated — slice 4 copies an existing block. This *lowers* the risk the proposal accepted; no decision changes, but the rationale should be corrected.
8. **No partial index on the not-deleted hot path**, only on the trash side. See the Indexing decision row.
9. **Purge uses `Exec` + `RowsAffected()`, not `DELETE ... RETURNING id`** as sketched in the proposal risk table. Counts are what observability needs; ids are read by nothing.
10. **`backend/internal/purge` is created in slice 3**, not slice 4, holding only `Window` so the Trash countdown and the sweep share one constant. Slice 3 remains independently shippable.

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Migration | Both columns nullable with no backfill; both partial indexes exist and are used by the sweep plan; existing rows unaffected | Applied against the test DB in the existing migration harness |
| Unit — `DeleteOrganization` | Row survives with `deleted_at`/`deleted_by_user_id` set; **every** child table (`organization_members`, `workspaces`, `invitations`, `groups`, `activity_events`, `sync_events`) still populated; second call → `ErrNotFound`; non-admin → `ErrForbidden`; `ErrWouldOrphanMember` still blocks with `deleted_at` untouched; **new**: orphan probe blocks when the member's only other org is soft-deleted; `organization.deleted` event present | Extends the existing `DeleteOrganization` fixtures; asserts survival where the old tests asserted cascade emptiness |
| Unit — `workspaces.Delete` | Same shape: children survive; double-delete → `ErrNotFound`; `workspace.deleted` event still recorded once | Seeded workspace with a row in each cascading child table |
| Unit — inaccessibility (one case per choke point 1-16) | Deleted org absent from `ListMemberships`; `ListMembers`/`ListInvitations`/`PatchMember` → `ErrForbidden`; **both** `requireOrganizationAdmin` copies reject (`organizations` *and* `groups`); `activity.ListByOrganization` → `ErrForbidden`; token-based `ValidatePendingInvitation`/`AcceptInvitation` → `ErrNotFound`; workspaces of a deleted org absent from `ListByOrganization`, and `GetTree`/`GetAccessibleWorkspace`/`RequireWorkspaceWriteAccess`/`GetAccessSnapshot`/grant-revoke all reject | Table-driven; **one named case per numbered choke-point row**, so the proposal's "missed predicate" risk maps 1:1 onto test names |
| Unit — sync + websocket reachability | `sync.ListChanges` and a bookmark mutation both reject after the workspace's org is soft-deleted; websocket connect (`GetAccessibleWorkspace` at `websocket/handler.go:40`) rejects | Extends existing sync/websocket integration tests |
| Unit — `RestoreOrganization` (**adversarial focus**) | Owner and admin restore successfully and the org becomes fully usable again with memberships, workspaces, bookmarks and the full pre-deletion activity trail intact; **a plain `member` gets `ErrForbidden`**; **a non-member gets `ErrForbidden`**; restoring a live org → `ErrNotFound`; unknown id → `ErrNotFound`; no orphan/sole-owner guard runs; `organization.restored` recorded | Fixture org soft-deleted with three principals (owner, member, outsider) |
| Unit — `workspaces.Restore` | Restores inside a live org; a workspace inside a soft-deleted org → `ErrNotFound` (must restore the org first); restoring a live workspace → `ErrNotFound`; non-admin → `ErrForbidden`; `workspace.restored` recorded | Fixture with one live and one trashed org |
| Unit — Trash listing | Returns only orgs/workspaces the requester owns/admins; a plain member of a trashed org gets an empty list (not a 403); workspaces of a trashed org are excluded; `purgeAt == deletedAt + purge.Window` | Multi-tenant fixture with a deliberate cross-org negative case |
| Unit — `purge.Sweep` | Rows older than `Window` are hard-deleted and their FK children with them; rows inside the window survive; a soft-deleted org's workspaces are cascade-destroyed even with their own `deleted_at IS NULL`; empty sweep returns `(0,0)` and errors nil; a cancelled `ctx` aborts without partial commit | Fixtures with `deleted_at` back-dated past and inside the window |
| Integration — handlers | `POST .../restore` → 204/403/404; `GET /organizations/deleted` and `GET /workspaces/deleted` → 200; **route-precedence test** that `/workspaces/deleted` does not match the `{workspaceId}` pattern; `DELETE` routes keep their exact existing status set | mux-level tests mirroring the existing handler tests |
| Frontend unit — slice 1 | Delete opens the panel and sends nothing; the confirm button stays disabled on partial/mismatched/whitespace-only input; a correct name enables it and fires one mutation; **switching rows resets the typed text** (the `key` remount); closing the panel sends nothing; error renders the `notice` `DataState` and clears `deletingWorkspaceId` | vitest + RTL, mocked mutations |
| Frontend unit — Trash | Both lists render; days-remaining derives from `purgeAt`; missing `deletedByEmail` degrades gracefully; Restore disables its row while pending; org restore triggers `refreshOrganizations` | vitest + RTL, mocked queries |
| Frontend unit — `format.ts` | The three new kinds render real sentences with representative and with missing metadata | vitest fixture per kind |

## Threat Matrix

N/A — no shell commands, subprocesses, VCS/PR automation, executable-file classification, or process integration. The reference matrix's rows (documentation-like paths, git repository selection, commit/push/PR state) have no counterpart here.

The real adversarial surface is authorization, and it is concentrated in exactly one place: `loadOrganizationRoleIncludingDeleted` is the **single** function in the codebase that resolves an organization role without the soft-delete predicate. It is reachable only from `RestoreOrganization`, it rejects any role other than `owner`/`admin`, and it is covered by two named negative tests (plain member, non-member). Secondary surfaces: the Trash queries embed authorization as an inner `JOIN` on `organization_members` rather than a separate gate, so they cannot return rows outside the requester's administered organizations even if the gate were forgotten; and `POST /workspaces/{id}/restore` resolves the organization from the row (never from the request) exactly as `DELETE /workspaces/{id}` does.

## Migration / Rollout

`000014_soft_delete.sql` is purely additive: nullable columns, `IF NOT EXISTS` indexes, no backfill, no data touched. Deploy order within slice 2 is migration-then-code (the code reads a column that must already exist); the reverse order fails closed on the first query rather than corrupting anything.

**Rollback is the one genuinely dangerous step.** Reverting slice 2's service code while the columns still hold data makes every trashed organization and workspace live and usable again, silently. The safe order is: (1) decide the fate of pending rows — hard-delete them to honour the original delete intent, or explicitly accept resurrection; (2) revert the code; (3) drop the columns in a follow-up down-migration. Slice 4 rolls back by removing two lines from `main.go`: the sweep stops, nothing is purged, no data is lost. Slice 3 rolls back by removing the route and the nav item; trashed rows remain, recoverable only through DB access. Slice 1 is a pure frontend revert.

All work lands on `feat/soft-delete-recovery` (off the still-unmerged `feat/lifecycle-management`); rollback before merge is a branch-level revert. Slice order is also the PR-chain order: PR #1 (slice 1) targets `feat/soft-delete-recovery`, each later slice targets the previous slice's branch. Slices 3 and 4 both depend only on 2 and could be stacked in either order.

## Open Questions

- [x] **RESOLVED (user decision): Trash must be reachable with zero live organizations.** `/trash` does NOT nest under `AdminLayout`/`RequireAdminOrganization`. It registers as a sibling of `setup/organization`, directly under `RequireSession` (`router.tsx`'s top-level children, alongside `{ path: "setup/organization", element: <OrganizationSetupPage /> }`). This works cleanly because `TrashPage`'s two queries (`GET /organizations/deleted`, `GET /workspaces/deleted`) are requester-scoped, not active-organization-scoped — the page needs a session, not an admin org, and `OrganizationProvider` already wraps the tree above `RequireSession`'s children either way. `TrashPage` renders standalone (no `AdminLayout` chrome), matching `OrganizationSetupPage`'s own presentation. `OrganizationSetupPage` gains a "Recover a deleted organization" link to `/trash` (visible exactly when `adminOrganizations.length === 0`, i.e. always on that page). `AdminLayout`'s "Trash" nav item still links to the same `/trash` path — clicking it from inside the shell unmounts `AdminLayout` and renders the standalone page, which is the normal React Router behavior for a sibling route and needs no special handling. Slice 3's File Changes and Data Flow are updated accordingly (see below).
- [ ] **Live websocket connections are not dropped on soft delete.** `websocket/handler.go:40` authorizes at connect time only; an already-subscribed extension keeps receiving frames for a workspace that just became unreachable, until it reconnects. Identical to `lifecycle-management`'s accepted open question for hard delete, and no worse — but Decision C's "immediately inaccessible" is technically violated for the lifetime of an open socket. A post-commit `Hub` broadcast/disconnect is the fix if wanted; it belongs in the handler after commit, never in the transaction.
- [ ] **Sole-owner asymmetry** (Deviation 6): a user who is sole owner of a *trashed* org still cannot deactivate their account. Fail-safe, but arguably confusing — the UI will say they must transfer ownership of an organization they cannot see.
- [ ] **`SetupRequired` semantics quietly change**: soft-deleting the last organization no longer reopens first-run bootstrap or the self-registration lock bypass for 30 days. This is a tightening and almost certainly desirable, but it is a behavior change nobody asked for.
- [ ] **Restore of an organization whose members changed during the window** is accepted per Decision D, but a member *removed* during the window stays removed after restore (their `organization_members` row was deleted by `PatchMember`, not by the soft delete). Confirm that partial-state restore is understood: restore reverses the deletion, not the window.
