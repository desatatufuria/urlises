# Design: Admin Backend Foundation

## Technical Approach

Add a modular Go control plane that keeps current `handler.go`/`service.go` package boundaries, but moves authorization into a shared access module. `organizations` owns OdA membership and invitations, `groups` owns reusable many-to-many groups, `workspaces` owns workspace CRUD plus grants, and existing runtime readers/mutators consume one deterministic effective-access path. This satisfies the three delta specs while keeping extension-facing read contracts stable.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|----------|---------|--------|-----------|
| Shared access evaluation | Inline SQL per package; derived membership tables; central resolver | Central `internal/access` service + SQL helpers | Current access logic is already duplicated (`workspaces`, `bookmarks`, websocket/sync). Centralizing removes drift and makes highest-role-wins enforceable everywhere. |
| Invitation acceptance | Overload `auth/register`; standalone invite package; org-owned lifecycle | Keep identity in `auth`, accept invite after authenticated sign-in | Avoids mixing JWT/session concerns with org policy. Reuses current auth middleware and supports existing-user invites cleanly. |
| Group/workspace grants | Reuse `workspace_members`; implicit org inheritance; normalized direct + group grants | New normalized grant tables with explicit resolution | Matches spec exactly, keeps groups first-class, and scales better than implicit inheritance or per-workspace denormalization. |

## Data Flow

Admin UI → auth middleware → organization/group/workspace handler → domain service → `access.Service` → PostgreSQL

Invite acceptance:

Admin UI → `POST /organizations/{id}/invitations`
→ invite row (`pending`)
→ invitee signs in
→ `POST /invitations/{token}/accept`
→ transactional validate + create `organization_members` row + mark invite `accepted`

Workspace authorization:

Client/extension ─→ workspace/bookmark/sync handler ─→ access resolver
                                  │
                                  └─ direct user grant + group grants + org membership
                                                     ↓
                                           highest workspace role wins

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `backend/migrations/000002_admin_backend_foundation.sql` | Create | Add org-role migration, invitations, groups, group memberships, workspace direct/group grants, and compatibility backfill. |
| `backend/internal/access/service.go` | Create | Central org-admin checks, effective workspace-role resolution, and bookmark mutation guards. |
| `backend/internal/groups/handler.go` | Create | Group CRUD and membership endpoints for admin UI. |
| `backend/internal/groups/service.go` | Create | Group persistence and org-scoped membership rules. |
| `backend/internal/organizations/handler.go` | Modify | Add org create/detail/member/invitation/admin routes; keep `GET /organizations`. |
| `backend/internal/organizations/service.go` | Modify | Bootstrap owner, protect last owner, list/manage members, invitation orchestration. |
| `backend/internal/workspaces/handler.go` | Modify | Add workspace create and grant-management routes beside existing reads. |
| `backend/internal/workspaces/service.go` | Modify | Replace `workspace_members` reads with effective-access queries. |
| `backend/internal/bookmarks/service.go` | Modify | Replace direct `workspace_members` mutation gate with shared access guard. |
| `backend/cmd/api/main.go` | Modify | Wire new services/routes in existing bootstrap style. |
| `README.md`, `docs/roadmap.md` | Modify | Document admin backend scope, Gitflow slice intent, and unchanged extension contract. |

## Interfaces / Contracts

```go
type OrganizationRole string // owner | admin | member
type WorkspaceRole string    // admin | editor | viewer

type EffectiveWorkspaceAccess struct {
    WorkspaceID string
    OrganizationID string
    Role WorkspaceRole
    Sources []string // direct, group:<groupID>
}
```

Admin HTTP contracts:

- `POST /organizations` → create OdA and bootstrap creator as `owner`.
- `GET|PATCH /organizations/{organizationId}/members`
- `POST /organizations/{organizationId}/invitations`
- `POST /invitations/{token}/accept`
- `GET|POST|PATCH|DELETE /organizations/{organizationId}/groups`
- `POST|DELETE /groups/{groupId}/members`
- `POST /organizations/{organizationId}/workspaces`
- `PUT|DELETE /workspaces/{workspaceId}/users/{userId}/access`
- `PUT|DELETE /workspaces/{workspaceId}/groups/{groupId}/access`

Current extension contracts stay shape-compatible: `GET /organizations`, `GET /organizations/{id}/workspaces`, `GET /workspaces/{id}`, and `GET /workspaces/{id}/tree` continue returning effective role data, now computed through the new resolver.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | role ranking, last-owner protection, invite state transitions | table-driven Go tests near `internal/access` and `internal/organizations` |
| Integration | migration/backfill, accept-invite transaction, direct+group recalculation, bookmark mutation guard | pgx-backed integration tests following current `*_integration_test.go` pattern |
| E2E | admin API happy path + extension read compatibility | defer full runner; document manual API verification until an E2E harness exists |

## Migration / Rollout

Add one forward-only migration. Expand `organization_members.role` to `owner|admin|member`, backfill legacy org roles (`admin→admin`, `editor/viewer→member`), create new grant tables, and copy existing `workspace_members` rows into direct user access. Keep old runtime endpoints working in the same release, then stop reading `workspace_members` in code; no feature flag required.

## Open Questions

- [ ] Can one user hold memberships in multiple OdA organizations inside the same Acme tenant during MVP?
- [ ] What invitation expiry window and resend/cancel policy should the email adapter enforce?
