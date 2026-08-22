# Design: Activity Log

## Technical Approach

A new `backend/internal/activity` package mirrors the shape of `organizations`/`workspaces`/`groups`: a `Service` wrapping `*pgxpool.Pool`, a package-level `Kind` string enum (16 values), a `Record(ctx, tx, ...)` free function usable both as `Service.Record` and directly by callers already holding a `pgx.Tx`, and `RegisterRoutes` following the exact `groups.RegisterRoutes` pattern (`authMiddleware`, `routeService` interface, `r.PathValue`, `httpapi.WriteJSON`/`WriteError`). `Record` writes synchronously inside the caller's existing transaction, immediately before `tx.Commit()` — never after commit, never through `IdempotencyExecutor.ExecutePrepared`/`PostCommit` — so the activity row is atomic with the mutation it describes (spec: "Atomic In-Transaction Recording"). `activity` imports nothing from `organizations`/`workspaces`/`groups`; those three packages each gain one new import of `internal/activity` and one new constructor parameter, a direct `*activity.Service` (not a narrow port interface — see Architecture Decisions). `groups.Update`, `Delete`, and `ListMembers` are refactored from pool-direct calls to `s.pool.Begin(ctx)`-wrapped transactions, matching the shape `groups.CreateTx`/`AddMemberTx` already use, so `Update`/`Delete` can call `activity.Record` atomically (`ListMembers` gets the same wrapping for consistency per spec, but never calls `Record` — it performs no mutation). `ListByOrganization` requires `access.RequireOrganizationAdmin` (the same helper `workspaces.CreateTx`/`GrantUserAccess` already call) and returns cursor-paginated results ordered `created_at DESC, id DESC`. admin-web's `ActivityPage.tsx` is modeled directly on `SecretsPage.tsx`: `useAuth()`, a TanStack Query hook, `DataState` for loading/error/empty, `Table`/`Badge` for rows, with a small explicit `formatActivityEvent(kind, metadata)` function replacing raw JSON with one human-readable sentence per event.

## Architecture Decisions

| Decision | Options / tradeoff | Choice and rationale |
|---|---|---|
| `orgID` parameter type on `Record` | `*string` (exploration/proposal's original signature) vs. plain `string` | Plain `string`. The proposal explicitly confirmed "org-scoped only — no secret events" as a closed decision (see spec's "Secret Events Are Excluded" requirement), so every legitimate caller of `activity.Record` — `organizations`, `workspaces`, `groups` — always has a real `organizationID` in scope at the call site (exploration finding 1 confirms this for all 13 sites). A `*string` would silently reintroduce the nullable-org ambiguity the proposal closed, and would let a future caller pass `nil` without a compile-time signal that it's out of scope for v1. `secrethide` (the one package without an org) is simply never wired to `activity` at all — not accommodated with a nullable parameter. |
| Dependency shape into `organizations`/`workspaces`/`groups` | Narrow consumer-defined port interface (`secretReadNotifier`/`invitationNotifier` pattern) vs. direct `*activity.Service` | Direct `*activity.Service`. The notifier-port pattern exists in this codebase specifically because the underlying transport varies per use (SMTP vs. WebSocket) and call sites are best-effort/post-commit, so decoupling and mockability at the transport boundary earns its keep. `activity.Record(ctx, tx, ...)` has neither property: every call site does the exact same mechanical thing (`INSERT INTO activity_events` inside the shared `tx`), there is only ever one implementation, and it must run inside the same transaction the caller already holds — a port interface would still need to expose `pgx.Tx` in its signature, so it buys zero transport abstraction while adding one file and one mock per package for no behavioral benefit. `organizations.NewService(pool *pgxpool.Pool, activityService *activity.Service)` (and the equivalent for `workspaces`/`groups`) is simpler, equally testable (`*activity.Service` is a concrete struct around `*pgxpool.Pool`, trivially exercised against a test DB the same way the existing services are), and matches the "small, pool-backed packages" convention this repo already follows. |
| Cursor encoding | Opaque server-issued token vs. plain `created_at`+`id` querystring params vs. base64-encoded composite | `base64(url-safe)` of `"<created_at RFC3339Nano>|<id>"`. No existing precedent in this codebase for an *opaque* REST pagination cursor: `sync`'s `afterCursor`/`X-Sync-Cursor` (`backend/internal/sync/types.go:14-15,28`, `postgres.go:205-261`) is a per-workspace monotonic `int64` sequence assigned by a dedicated `workspace_cursors` table — a different mechanism entirely (an event-log offset, not a keyset-pagination cursor over a queryable, orderable column pair) and not reusable here without inventing an equivalent sequence table for `activity_events`, which the spec does not require and would add needless state. `activity`'s cursor is therefore new: `(created_at, id)` is the natural composite key for `ORDER BY created_at DESC, id DESC` (ties broken by `id` since two rows can share a `created_at` at insert-time granularity), base64-encoding it keeps the value opaque/non-guessable to API consumers and gives forward room to change the internal encoding later without a wire-format break. `WHERE (created_at, id) < ($1, $2)` (row-wise comparison, supported by Postgres) is the exact predicate that continues "strictly after the previous page's last row" per the spec's cursor scenario. |
| Page size | Fixed vs. client-supplied `limit` | Client-supplied `limit` query param, default 50, clamped to `[1, 100]`. Matches the spec's "MUST NOT expose an unbounded listing endpoint" requirement while giving admin-web room to request a larger first page if useful later; clamping prevents a client from requesting the entire table in one call. |
| Route shape | `GET /organizations/{organizationId}/activity` vs. a `/activity?organizationId=...` flat route | `GET /organizations/{organizationId}/activity`, matching `GET /organizations/{organizationId}/groups` (`groups/handler.go:36`) and `GET /organizations/{organizationId}/workspaces` verbatim — organization-scoped resources in this codebase are consistently nested under `/organizations/{organizationId}/...`, not query-filtered. |
| `groups.Update`/`Delete`/`ListMembers` transaction wrap | Wrap only `Update`/`Delete` (the two that mutate) vs. wrap all three per spec text | Wrap all three, per the spec's explicit "`ListMembers` MUST also run inside a transaction for consistency but performs no mutation and records no activity row." `ListMembers`' wrap is purely for consistency of the package's internal shape (every `Service` method that touches `groups`/`organization_members` now goes through the same `tx.Begin`/`defer tx.Rollback`/`tx.Commit` shape); it is otherwise behavior-preserving — same query, same ordering, same error mapping — and adds no `Record` call. |
| Where `Record` runs relative to the pre-existing lock/authorize/mutate sequence in `PatchMember`-style flows | Before all validation vs. immediately before `tx.Commit()` | Immediately before `tx.Commit()`, after every validation/mutation step has already succeeded. This guarantees `Record` never fires for a request that later fails validation (e.g. `ErrLastOwner`, `ErrForbidden`), and — because it shares the same `tx` — a failure inside `Record` itself rolls back the primary mutation too (an accepted, named risk per the proposal, requiring solid unit coverage on `Record` before wiring it into 13 call sites). |
| `Kind` type | Untyped `string` constants vs. a defined `type Kind string` with typed constants | `type Kind string` with 16 typed constants (`activity.KindOrganizationCreated`, etc.). Gives compile-time exhaustiveness pressure at call sites and in the admin-web formatter's switch (via the string values crossing the wire), while still serializing as a plain JSON string — no different from `access.OrganizationRole`'s existing `type OrganizationRole string` pattern in this codebase. |
| admin-web pagination pattern | `useInfiniteQuery` ("load more") vs. cursor-in-state + refetch | `useInfiniteQuery`. The feed is inherently an append-only, newest-first list where "load more" is the natural interaction (compliance/audit review scrolling back in time), and TanStack Query's `useInfiniteQuery` handles the cursor-as-`pageParam` bookkeeping (dedup, cache keys per page) that a hand-rolled cursor-in-`useState` + manual refetch would have to reimplement. No existing admin-web page uses infinite scroll today (`SecretsPage`'s `useMySecrets` is a flat, capped `LIMIT 50` list), so this is new but small — one hook, no new UI primitive beyond a "Load more" button reusing `ui-button-secondary`. |
| Event display | Generic JSON dump of `metadata` vs. an explicit per-`kind` formatter | Explicit `formatActivityEvent(kind, metadata): string` covering all 16 kinds (see Event Display section below), each returning one human-readable sentence. A raw JSON dump would technically satisfy "read-only feed" but defeats the proposal's compliance-audit framing — an admin scanning the feed needs "Granted editor access to jane@co.com," not `{"role":"editor","targetEmail":"jane@co.com"}`. |

## Data Flow

    Mutation request (e.g. PATCH /organizations/{id}/members)
      -> organizations.Service.PatchMember(ctx, requesterUserID, organizationID, input)
         -> tx := pool.Begin(ctx)
         -> lock/authorize/validate/mutate (existing logic, unchanged)
         -> activity.Record(ctx, tx, organizationID, requesterUserID,
              activity.KindOrganizationMemberRoleChanged, "organization_member", targetUserID,
              map[string]any{"role": nextRole, "previousRole": currentRole})
         -> tx.Commit(ctx)
      -> both the organization_members row and the activity_events row now exist atomically

    GET /organizations/{organizationId}/activity?cursor=...&limit=50
      -> activity.RegisterRoutes handler
         -> auth.PrincipalFromContext(r.Context())
         -> service.ListByOrganization(ctx, principal.UserID, organizationId, cursor, limit)
            -> access.RequireOrganizationAdmin(ctx, pool, requesterUserID, organizationID) -- reject non-admins
            -> decode cursor (if present) -> (createdAt, id)
            -> SELECT ... WHERE organization_id = $1 [AND (created_at, id) < ($2, $3)]
               ORDER BY created_at DESC, id DESC LIMIT $N+1
            -> encode nextCursor from the (limit+1)th row if present, trim to `limit`
      -> admin-web ActivityPage: useOrgActivity(orgId, token) -> useInfiniteQuery
         -> Table rows: formatDateTime(createdAt), actor email/name, formatActivityEvent(kind, metadata)

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/migrations/000012_activity_events.sql` | Create | `activity_events` table + composite/actor indexes |
| `backend/internal/activity/service.go` | Create | `Service`, `Kind` type + 16 constants, `Record`, `ListByOrganization`, cursor encode/decode helpers |
| `backend/internal/activity/handler.go` | Create | `RegisterRoutes`, `routeService` interface, `writeActivityError` |
| `backend/internal/organizations/service.go` | Modify | `activity` field on `Service`, `NewService` gains `activityService *activity.Service` param, 5 `Record` calls |
| `backend/internal/workspaces/service.go` | Modify | same, 5 `Record` calls |
| `backend/internal/groups/service.go` | Modify | same, tx-wrap `Update`/`Delete`/`ListMembers`, 5 `Record` calls |
| `backend/cmd/api/main.go` | Modify | construct `activityService := activity.NewService(pool)` before `organizationsService`/`groupsService`/`workspacesService`; thread it into their constructors; call `activity.RegisterRoutes(mux, authService.Middleware, activityService)` |
| `admin-web/src/lib/api/activity.ts` | Create | `listOrgActivity(orgId, token, cursor?, limit?)`, `ActivityEvent` type |
| `admin-web/src/features/activity/queries.ts` | Create | `useOrgActivity(orgId, token)` via `useInfiniteQuery` |
| `admin-web/src/features/activity/format.ts` | Create | `formatActivityEvent(kind, metadata): string`, one branch per `Kind` |
| `admin-web/src/features/activity/ActivityPage.tsx` | Create | modeled on `SecretsPage.tsx` |
| `admin-web/src/app/router.tsx` | Modify | new `activity` sibling route under `RequireAdminOrganization`/`AdminLayout` |
| `admin-web/src/app/shell/AdminLayout.tsx` | Modify | new nav item `{ to: "/activity", label: "Activity" }` |

## Interfaces / Contracts

### Backend: `backend/internal/activity/service.go`

```go
package activity

type Kind string

const (
    KindOrganizationCreated            Kind = "organization.created"
    KindInvitationCreated              Kind = "invitation.created"
    KindInvitationResent               Kind = "invitation.resent"
    KindInvitationAccepted             Kind = "invitation.accepted"
    KindOrganizationMemberRoleChanged  Kind = "organization_member.role_changed"
    KindOrganizationMemberRemoved      Kind = "organization_member.removed"
    KindWorkspaceCreated               Kind = "workspace.created"
    KindWorkspaceAccessUserGranted     Kind = "workspace_access.user_granted"
    KindWorkspaceAccessUserRevoked     Kind = "workspace_access.user_revoked"
    KindWorkspaceAccessGroupGranted    Kind = "workspace_access.group_granted"
    KindWorkspaceAccessGroupRevoked    Kind = "workspace_access.group_revoked"
    KindGroupCreated                   Kind = "group.created"
    KindGroupRenamed                   Kind = "group.renamed"
    KindGroupDeleted                   Kind = "group.deleted"
    KindGroupMemberAdded               Kind = "group_member.added"
    KindGroupMemberRemoved             Kind = "group_member.removed"
)

type Service struct {
    pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service

// Record writes one activity_events row inside the caller's existing
// transaction, immediately before tx.Commit(). orgID is always a concrete
// organization ID -- there is no nullable/org-less variant in v1 (see
// Architecture Decisions: "orgID parameter type").
func (s *Service) Record(
    ctx context.Context,
    tx pgx.Tx,
    orgID string,
    actorUserID string,
    kind Kind,
    targetType string,
    targetID string,
    metadata map[string]any,
) error

type Event struct {
    ID             string         `json:"id"`
    OrganizationID string         `json:"organizationId"`
    ActorUserID    *string        `json:"actorUserId,omitempty"`
    ActorEmail     *string        `json:"actorEmail,omitempty"`
    ActorName      *string        `json:"actorName,omitempty"`
    Kind           Kind           `json:"kind"`
    TargetType     string         `json:"targetType"`
    TargetID       string         `json:"targetId"`
    Metadata       map[string]any `json:"metadata"`
    CreatedAt      string         `json:"createdAt"`
}

// ListByOrganization enforces access.RequireOrganizationAdmin, then returns
// up to limit events newest-first. cursor is the opaque token from a prior
// page's nextCursor, or "" for the first page. nextCursor is "" when no
// further page exists.
func (s *Service) ListByOrganization(
    ctx context.Context,
    requesterUserID string,
    organizationID string,
    cursor string,
    limit int,
) (events []Event, nextCursor string, err error)
```

```go
func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService)
// registers: GET /organizations/{organizationId}/activity
```

Cursor helpers (unexported, `backend/internal/activity/cursor.go`):

```go
// encodeCursor/decodeCursor round-trip a (createdAt time.Time, id string)
// pair through base64.URLEncoding of "<RFC3339Nano createdAt>|<id>". The
// pipe separator is safe: RFC3339Nano contains no "|", and id is a UUID.
func encodeCursor(createdAt time.Time, id string) string
func decodeCursor(cursor string) (createdAt time.Time, id string, err error)
```

### admin-web: `admin-web/src/lib/api/activity.ts`

```ts
export type ActivityKind =
  | "organization.created" | "invitation.created" | "invitation.resent" | "invitation.accepted"
  | "organization_member.role_changed" | "organization_member.removed"
  | "workspace.created"
  | "workspace_access.user_granted" | "workspace_access.user_revoked"
  | "workspace_access.group_granted" | "workspace_access.group_revoked"
  | "group.created" | "group.renamed" | "group.deleted"
  | "group_member.added" | "group_member.removed";

export interface ActivityEvent {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  kind: ActivityKind;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityPage {
  events: ActivityEvent[];
  nextCursor: string | null;
}

export function listOrgActivity(
  organizationId: string,
  token: string,
  cursor?: string,
  limit = 50,
): Promise<ActivityPage> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  return apiRequest<ActivityPage>(
    `/organizations/${encodeURIComponent(organizationId)}/activity?${params.toString()}`,
    { method: "GET", token },
  );
}
```

## Migration DDL

`backend/migrations/000012_activity_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_org_created_id
    ON activity_events (organization_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_actor_user_id
    ON activity_events (actor_user_id);

-- Rollback: DROP TABLE activity_events; additive only, no existing data touched.
```

`gen_random_uuid()` is already available (`pgcrypto` extension created in `000001_initial_schema.sql:1`), and `actor_user_id ... ON DELETE SET NULL` mirrors `invitations.accepted_by_user_id`'s "provenance survives, don't block user deletion" precedent (exploration finding, `Affected Areas`). File numbered `000012` — the highest existing migration is `000011_secrets_sent_to_email.sql`.

## Call-Site Wiring (all ~13 `Record` insertions)

Each call is inserted immediately before the function's existing `tx.Commit(ctx)` (or, for `*Tx`-suffixed functions with no `Commit` of their own, at the end of the function body, since the caller commits). `metadata` values are the smallest set that makes the event self-explanatory in the admin-web formatter without a second lookup.

### `organizations/service.go`

| Function | `kind` | `targetType` | `targetID` | `metadata` |
|---|---|---|---|---|
| `CreateOrganizationTx` | `KindOrganizationCreated` | `"organization"` | `membership.OrganizationID` | `{"organizationName": membership.OrganizationName}` |
| `CreateInvitationTx` | `KindInvitationCreated` | `"invitation"` | `invitation.ID` | `{"email": invitation.Email, "role": invitation.Role}` |
| `ResendInvitation` | `KindInvitationResent` | `"invitation"` | `invitation.ID` | `{"email": invitation.Email}` |
| `AcceptInvitation` | `KindInvitationAccepted` | `"invitation"` | `record.ID` | `{"email": record.Email, "role": string(record.Role)}` |
| `PatchMember` (role branch) | `KindOrganizationMemberRoleChanged` | `"organization_member"` | `userID` | `{"role": string(nextRole), "previousRole": string(currentRole), "targetEmail": currentMember.Email}` |
| `PatchMember` (remove branch) | `KindOrganizationMemberRemoved` | `"organization_member"` | `userID` | `{"targetEmail": currentMember.Email, "previousRole": string(currentRole)}` |

Actor: `requesterUserID` for all except `AcceptInvitation`, which uses `userID` (the acceptor, per exploration finding 1 — the accepting user is the actor of their own acceptance). Org scope: `membership.OrganizationID` for `CreateOrganizationTx` (the just-created org — the row's own creation is itself an org-scoped event), `organizationID` param for the other four functions, and `record.OrganizationID` for `AcceptInvitation` (loaded from the invitation row, since `organizationID` is not a direct parameter there).

Note `PatchMember` has two mutually exclusive branches (`input.Remove` true/false) with two separate `tx.Commit()` call sites (`service.go:331`, `service.go:347`) — each branch gets its own `Record` call with its own `kind`, inserted immediately before its own `Commit`.

### `workspaces/service.go`

| Function | `kind` | `targetType` | `targetID` | `metadata` |
|---|---|---|---|---|
| `CreateTx` | `KindWorkspaceCreated` | `"workspace"` | `workspaceID` | `{"workspaceName": name, "workspaceType": workspaceType}` |
| `GrantUserAccess` | `KindWorkspaceAccessUserGranted` | `"workspace_user_access"` | `userID` | `{"workspaceId": workspaceID, "role": string(role)}` |
| `RevokeUserAccess` | `KindWorkspaceAccessUserRevoked` | `"workspace_user_access"` | `userID` | `{"workspaceId": workspaceID}` |
| `GrantGroupAccess` | `KindWorkspaceAccessGroupGranted` | `"workspace_group_access"` | `groupID` | `{"workspaceId": workspaceID, "role": string(role)}` |
| `RevokeGroupAccess` | `KindWorkspaceAccessGroupRevoked` | `"workspace_group_access"` | `groupID` | `{"workspaceId": workspaceID}` |

Actor: `requesterUserID` for all five. Org scope: `organizationID` — already resolved via `loadWorkspaceOrganizationID(ctx, tx, workspaceID)` at the top of each of these four access-grant/revoke functions, and available directly as the `organizationID` parameter in `CreateTx`. `workspaceName`/`workspaceType`/target user or group email are not separately looked up for revoke calls to avoid an extra query — the workspace/user/group IDs in `targetID`/`metadata.workspaceId` are enough for the admin-web formatter combined with data already visible elsewhere in the UI; grant calls include `role` since it's already in scope as the normalized `role` local variable.

### `groups/service.go`

| Function | `kind` | `targetType` | `targetID` | `metadata` |
|---|---|---|---|---|
| `CreateTx` | `KindGroupCreated` | `"group"` | `group.ID` | `{"groupName": group.Name}` |
| `Update` (after tx-wrap) | `KindGroupRenamed` | `"group"` | `group.ID` | `{"previousName": <name before UPDATE>, "name": group.Name}` |
| `Delete` (after tx-wrap) | `KindGroupDeleted` | `"group"` | `groupID` | `{}` (group row is gone by the time of `Record`; nothing further to attach without an extra pre-delete lookup, and the target ID alone is sufficient audit context) |
| `AddMemberTx` | `KindGroupMemberAdded` | `"group_member"` | `userID` | `{"groupId": groupID, "targetEmail": member.Email}` |
| `RemoveMember` | `KindGroupMemberRemoved` | `"group_member"` | `userID` | `{"groupId": groupID}` |

Actor: `requesterUserID` for all five. Org scope: `organizationID` param directly in `CreateTx`/`Update`/`Delete`; resolved via `loadGroupOrganizationID(ctx, tx, groupID)` in `AddMemberTx`/`RemoveMember` (already called there today).

`Update`'s `previousName` requires reading the row's current `name` before the `UPDATE` — the tx-wrap refactor (below) adds a `SELECT name FROM groups WHERE id = $1 AND organization_id = $2 FOR UPDATE` immediately after authorization, which supplies both the previous value and row-level locking consistent with `organizations.PatchMember`'s `lockOrganization`/`lockOrganizationMemberships` pattern.

## `groups.Update`/`Delete`/`ListMembers` Transaction-Wrapping Refactor

Exact before/after for `Update` (the pattern `Delete`/`ListMembers` follow identically, minus the `Record` call for `ListMembers`):

**Before** (`groups/service.go:133-158`, pool-direct):

```go
func (s *Service) Update(ctx context.Context, requesterUserID, organizationID, groupID string, input UpdateGroupInput) (Group, error) {
	if err := requireOrganizationAdmin(ctx, s.pool, requesterUserID, organizationID); err != nil {
		return Group{}, err
	}

	name := strings.TrimSpace(input.Name)
	if name == "" {
		return Group{}, fmt.Errorf("group name is required")
	}

	var group Group
	err := s.pool.QueryRow(ctx, `
		UPDATE groups
		SET name = $3, updated_at = NOW()
		WHERE id = $1 AND organization_id = $2
		RETURNING id, organization_id, name, created_at::text, updated_at::text
	`, groupID, organizationID, name).Scan(&group.ID, &group.OrganizationID, &group.Name, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Group{}, ErrNotFound
		}
		return Group{}, fmt.Errorf("update group: %w", err)
	}

	return group, nil
}
```

**After** (matches `CreateTx`/`AddMemberTx`'s `pgx.Tx`-based shape):

```go
func (s *Service) Update(ctx context.Context, requesterUserID, organizationID, groupID string, input UpdateGroupInput) (Group, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Group{}, fmt.Errorf("begin update group tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := requireOrganizationAdmin(ctx, tx, requesterUserID, organizationID); err != nil {
		return Group{}, err
	}

	name := strings.TrimSpace(input.Name)
	if name == "" {
		return Group{}, fmt.Errorf("group name is required")
	}

	var previousName string
	if err := tx.QueryRow(ctx, `
		SELECT name FROM groups WHERE id = $1 AND organization_id = $2 FOR UPDATE
	`, groupID, organizationID).Scan(&previousName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Group{}, ErrNotFound
		}
		return Group{}, fmt.Errorf("lock group for update: %w", err)
	}

	var group Group
	err = tx.QueryRow(ctx, `
		UPDATE groups
		SET name = $3, updated_at = NOW()
		WHERE id = $1 AND organization_id = $2
		RETURNING id, organization_id, name, created_at::text, updated_at::text
	`, groupID, organizationID, name).Scan(&group.ID, &group.OrganizationID, &group.Name, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return Group{}, fmt.Errorf("update group: %w", err)
	}

	if err := s.activity.Record(ctx, tx, organizationID, requesterUserID, activity.KindGroupRenamed, "group", group.ID, map[string]any{
		"previousName": previousName,
		"name":         group.Name,
	}); err != nil {
		return Group{}, fmt.Errorf("record group rename activity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return Group{}, fmt.Errorf("commit update group tx: %w", err)
	}

	return group, nil
}
```

`Delete` and `ListMembers` follow the same `tx, err := s.pool.Begin(ctx)` / `defer tx.Rollback(ctx)` / replace every `s.pool.Query*`/`s.pool.Exec` call with the equivalent `tx.*` call / `tx.Commit(ctx)` at the end shape. `Delete` adds one `Record(ctx, tx, organizationID, requesterUserID, activity.KindGroupDeleted, "group", groupID, map[string]any{})` call right before its `tx.Commit(ctx)`. `ListMembers` adds no `Record` call — only the `tx.Begin`/`Commit` wrap, per the spec's explicit "no response-shape or error-behavior change" requirement; its existing `requireOrganizationAdmin`/`loadGroupOrganizationID` calls switch from `s.pool` to `tx` and the final `tx.Commit(ctx)` replaces the implicit pool-query completion (a read-only transaction commit here is a no-op against the data but keeps the package's internal shape uniform, per this design's earlier "wrap all three" decision).

## Composition Root (`backend/cmd/api/main.go`)

```go
mux := http.NewServeMux()
accessService := access.NewService(pool)
activityService := activity.NewService(pool)          // NEW — constructed right after accessService,
                                                        // before organizationsService, since organizations/
                                                        // workspaces/groups all now depend on it
organizationsService := organizations.NewService(pool, activityService)   // NEW param
authService := auth.NewService(pool, cfg.Auth, ...)
smtpMailer := mailer.NewSMTP(cfg.Mail)
invitationNotifier := organizations.NewMailInvitationNotifier(smtpMailer, cfg.App.PublicBaseURL, os.Stdout)
secretLinkMailer := secrethide.NewMailSecretLinkMailer(smtpMailer, cfg.App.PublicBaseURL, os.Stdout)
groupsService := groups.NewService(pool, activityService)                 // NEW param
workspacesService := workspaces.NewService(pool, accessService, activityService) // NEW param
...
activity.RegisterRoutes(mux, authService.Middleware, activityService)     // NEW — alongside the other
                                                                            // *.RegisterRoutes(...) calls
```

`activityService` is constructed immediately after `accessService` and before `organizationsService`, mirroring the existing top-to-bottom "construct a dependency before the services that need it" ordering already used for `accessService` (constructed before `workspacesService`, which takes it as a parameter). `organizations.NewService`, `groups.NewService`, and `workspaces.NewService` each gain `activityService *activity.Service` as a new trailing constructor parameter (after `pool`, and after `accessService` for `workspaces.NewService` specifically, to keep existing parameter order stable and the diff minimal). `activity.RegisterRoutes` is added alongside the other `RegisterRoutes` calls, order-independent since it registers a disjoint route.

## Event Display — `admin-web/src/features/activity/format.ts`

```ts
import type { ActivityEvent } from "../../lib/api/activity";

function actorLabel(event: ActivityEvent): string {
  return event.actorEmail ?? event.actorName ?? "A former member";
}

export function formatActivityEvent(event: ActivityEvent): string {
  const actor = actorLabel(event);
  const m = event.metadata as Record<string, string | undefined>;

  switch (event.kind) {
    case "organization.created":
      return `${actor} created the organization "${m.organizationName ?? ""}".`;
    case "invitation.created":
      return `${actor} invited ${m.email ?? "someone"} as ${m.role ?? "member"}.`;
    case "invitation.resent":
      return `${actor} resent the invitation to ${m.email ?? "someone"}.`;
    case "invitation.accepted":
      return `${actor} accepted the invitation to join as ${m.role ?? "member"}.`;
    case "organization_member.role_changed":
      return `${actor} changed ${m.targetEmail ?? "a member"}'s role from ${m.previousRole ?? "?"} to ${m.role ?? "?"}.`;
    case "organization_member.removed":
      return `${actor} removed ${m.targetEmail ?? "a member"} (was ${m.previousRole ?? "?"}) from the organization.`;
    case "workspace.created":
      return `${actor} created the workspace "${m.workspaceName ?? ""}" (${m.workspaceType ?? "unknown type"}).`;
    case "workspace_access.user_granted":
      return `${actor} granted ${m.role ?? "?"} access to a user on workspace ${m.workspaceId ?? "?"}.`;
    case "workspace_access.user_revoked":
      return `${actor} revoked a user's access on workspace ${m.workspaceId ?? "?"}.`;
    case "workspace_access.group_granted":
      return `${actor} granted ${m.role ?? "?"} access to a group on workspace ${m.workspaceId ?? "?"}.`;
    case "workspace_access.group_revoked":
      return `${actor} revoked a group's access on workspace ${m.workspaceId ?? "?"}.`;
    case "group.created":
      return `${actor} created the group "${m.groupName ?? ""}".`;
    case "group.renamed":
      return `${actor} renamed group "${m.previousName ?? "?"}" to "${m.name ?? "?"}".`;
    case "group.deleted":
      return `${actor} deleted a group.`;
    case "group_member.added":
      return `${actor} added ${m.targetEmail ?? "a user"} to group ${m.groupId ?? "?"}.`;
    case "group_member.removed":
      return `${actor} removed a user from group ${m.groupId ?? "?"}.`;
    default:
      return `${actor} performed ${event.kind} on ${event.targetType} ${event.targetId}.`;
  }
}
```

The `default` branch is defensive only (unreachable for the 16 recorded kinds today) — it exists so a future kind added to the backend without a matching admin-web branch degrades to a readable-if-generic sentence instead of `undefined`/blank text. `workspaceId`/`groupId` appear as raw IDs rather than names in several branches deliberately: resolving them to human names would require either a second API round-trip per row or joining against `workspaces`/`groups` in the `ListByOrganization` query (out of scope for v1 — noted as a Testing/Open Question below, not silently dropped).

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (`activity.Record`) | Row persisted with correct columns; rolls back with caller's tx on later error; `metadata` round-trips through `JSONB` | table-driven against a test DB, mirroring `organizations`/`groups` service tests |
| Unit (`activity.ListByOrganization`) | Non-admin rejected; admin sees rows; page ordering `created_at DESC, id DESC`; cursor advances without duplicates/gaps; limit clamping | table-driven, seeded fixture rows including same-`created_at` ties |
| Unit (cursor encode/decode) | Round-trip; malformed cursor rejected with a clear error, not a panic | pure Go |
| Integration (per package) | Each of the 13 call sites: commit persists both rows; rollback (forced validation failure) leaves no activity row | extends existing `organizations`/`workspaces`/`groups` integration tests |
| Integration (`groups` tx-wrap) | `Update`/`Delete` unchanged behavior (`ErrNotFound`, row shape); `ListMembers` unchanged ordering/error/response shape | extends `groups` integration tests, asserting byte-identical response shape pre/post refactor |
| Frontend unit | `formatActivityEvent` covers all 16 kinds with representative metadata fixtures; missing/partial metadata degrades gracefully (no `undefined` in output) | vitest, one fixture per kind |
| Frontend unit | `ActivityPage` renders loading/error/empty states distinctly; unauthenticated/non-admin guard states match `SecretsPage`'s precedent | React Testing Library, mocked `useOrgActivity` |

## Migration / Rollout

Additive migration `000012_activity_events.sql`; no backfill (existing mutations before this change have no retroactive activity rows — acceptable, matches the proposal's stated scope). Rollback: drop the table, remove `activity.RegisterRoutes` and the three new constructor parameters in `main.go` (revert to prior signatures), remove the `Record` calls and `activity` import from `organizations`/`workspaces`/`groups`, revert the `groups.go` tx-wrap refactor if it's judged unwanted independently of `activity` (it is spec-required either way per "Event Recording — Groups"), remove the admin-web route/nav item/page. No existing data model touched.

## Open Questions

- [ ] Whether `workspaceId`/`groupId` in `metadata` should be resolved to human-readable names server-side (a JOIN in `ListByOrganization`) vs. left as raw IDs for admin-web to resolve separately — deferred; raw IDs are correct and sufficient for v1, name resolution is a follow-up UX polish, not a blocker.
- [ ] Whether a future `byOrg` WebSocket index (live-push) would want `activity.Record` to also publish to `Hub` post-commit — explicitly out of scope per proposal (no live push in v1); if added later, it would follow `secrethide.Burn`'s commit-then-notify handler-local pattern, not change `Record`'s in-transaction contract.
