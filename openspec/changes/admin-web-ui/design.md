# Design: Admin Web UI

## Technical Approach

Build a dedicated `admin-web/` SPA for OdA `owner`/`admin` operators. It consumes the existing auth, organization, group, workspace, and grant APIs from `admin-backend-foundation`, and adds only three UI-read endpoints where the current backend is write-capable but not list-capable. The extension remains separate; this app is the operator control plane.

## Architecture Decisions

| Decision | Alternatives considered | Choice | Rationale |
|---|---|---|---|
| Web stack | Vanilla TS; Next.js | Vite + React + TypeScript | No existing web app exists. React gives maintainable page composition/forms; Vite keeps delivery light. Next.js adds SSR/server concerns we do not need. |
| Data state | Ad-hoc fetch + local state; heavy global store | TanStack Query for server state, React context for auth/org UI state | Most complexity is request/mutation/invalidation, not client business state. This stays scalable without Redux-style overhead. |
| Design system scope | Reuse extension DOM/CSS directly; adopt component library | Small local UI kit with shared tokens | The extension styling proves the premium/minimal direction, but its DOM/build is not reusable as-is. A thin app-local system avoids coupling and keeps the surface consistent. |
| Backend consumption | Force UI from current endpoints only; redesign backend broadly | Reuse current contracts and add minimal read models | Current handlers cover auth, members, groups, workspaces, and grant writes, but the UI still needs pending invitations, group members, and workspace access listings. |

## Data Flow

`/login` → `POST /auth/login` → store session/token → `GET /me` + `GET /organizations`
→ choose active organization
→ shell loads page queries
→ page mutation
→ invalidate affected query keys
→ refresh calm success/error state.

```text
Admin Shell
  ├─ AuthProvider (session)
  ├─ OrganizationProvider (active org)
  └─ QueryClient
       ├─ Members / Invitations
       ├─ Groups
       ├─ Workspaces
       └─ Access
```

## File Changes

| File | Action | Description |
|---|---|---|
| `admin-web/package.json` | Create | Vite/React app manifest and scripts. |
| `admin-web/src/main.tsx` | Create | App bootstrap and providers. |
| `admin-web/src/app/router.tsx` | Create | Login route, guarded admin shell routes. |
| `admin-web/src/app/shell/AdminLayout.tsx` | Create | Header, org switcher, left nav, page outlet. |
| `admin-web/src/features/{members,invitations,groups,workspaces,access}/...` | Create | Page modules, queries, mutations, and forms by domain. |
| `admin-web/src/lib/api/{client,auth,organizations,groups,workspaces}.ts` | Create | Typed fetch client over Go HTTP contracts. |
| `admin-web/src/lib/ui/{tokens.css,components/*}` | Create | Minimal reusable UI system: shell, table, form row, badge, empty/error states, drawer/modal. |
| `backend/internal/organizations/{handler.go,service.go}` | Modify | Add `GET /organizations/{organizationId}/invitations`. |
| `backend/internal/groups/{handler.go,service.go}` | Modify | Add `GET /groups/{groupId}/members`. |
| `backend/internal/workspaces/{handler.go,service.go}` | Modify | Add `GET /workspaces/{workspaceId}/access` read model. |

## Interfaces / Contracts

```ts
type AdminSession = { accessToken: string; expiresAt: string; clientId: string; user: { id: string; email: string; name?: string } };
type AdminNav = "members" | "invitations" | "groups" | "workspaces" | "access";
type WorkspaceAccessSnapshot = {
  workspace: { workspaceId: string; workspaceName: string; workspaceType: string; organizationId: string; organizationName: string };
  userGrants: Array<{ userId: string; email: string; role: "admin" | "editor" | "viewer" }>;
  groupGrants: Array<{ groupId: string; groupName: string; role: "admin" | "editor" | "viewer" }>;
  effectiveAccess: Array<{ userId: string; email: string; role: "admin" | "editor" | "viewer"; sources: string[] }>;
};
```

Pages use current endpoints plus:
- `GET /organizations/{organizationId}/invitations`
- `GET /groups/{groupId}/members`
- `GET /workspaces/{workspaceId}/access`

No Chrome extension contract changes; `/organizations`, `/workspaces`, `/tree`, replay, and websocket behavior stay untouched.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | route guards, query mappers, role/source formatting | Vitest near app/lib modules |
| Integration | CRUD page flows and invalidation | React Testing Library + MSW per feature page |
| E2E | login, invite, group membership, workspace grant flow | Playwright later; manual verification first if infra is not added in the first slice |

## Migration / Rollout

No data migration required. Roll out on `feature/admin-web-ui` in Gitflow slices. Backend follow-up endpoints ship before or with the first usable UI slice.

## Open Questions

- [ ] Should invitation resend/cancel stay out of MVP even if invitations are listed in the UI?
- [ ] Should `GET /workspaces/{workspaceId}/access` return only effective users, or both raw grants and effective users as proposed here?
