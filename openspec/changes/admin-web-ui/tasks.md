# Tasks: Admin Web UI

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1,200-1,800 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 backend read models → PR 2 shell/foundations → PR 3 people/groups UI → PR 4 workspaces/access UI |
| Delivery strategy | chained PRs |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Add UI-read backend endpoints | PR 1 | Base `feature/admin-web-ui`; handler+service+docs |
| 2 | Bootstrap admin-web shell and shared UI/api layers | PR 2 | Depends on PR 1; auth, org switcher, route guard |
| 3 | Deliver members, invitations, and groups flows | PR 3 | Depends on PR 2; include empty/error states |
| 4 | Deliver workspaces and access flows with verification | PR 4 | Depends on PR 3; include manual validation/docs |

## Phase 1: Foundation

- [x] 1.1 Create `admin-web/package.json`, `tsconfig.json`, and `vite.config.ts` with React, TypeScript, TanStack Query, and baseline scripts.
- [x] 1.2 Create `admin-web/src/main.tsx`, `src/app/router.tsx`, and `src/app/providers/{AuthProvider.tsx,OrganizationProvider.tsx}` for login, session restore, org selection, and admin-only guards.
- [x] 1.3 Create `admin-web/src/lib/api/{client.ts,auth.ts,organizations.ts,groups.ts,workspaces.ts}` plus shared query keys/types for current contracts and planned read models.
- [x] 1.4 Create `admin-web/src/lib/ui/tokens.css` and `src/lib/ui/components/{AppShell.tsx,DataState.tsx,Table.tsx,FormRow.tsx,Badge.tsx}` for minimal/premium layout and calm states.

## Phase 2: Backend Read Models

- [x] 2.1 Update `backend/internal/organizations/{handler.go,service.go}` to add `GET /organizations/{organizationId}/invitations` for pending invite listing.
- [x] 2.2 Update `backend/internal/groups/{handler.go,service.go}` to add `GET /groups/{groupId}/members` for group membership review.
- [x] 2.3 Update `backend/internal/workspaces/{handler.go,service.go}` to add `GET /workspaces/{workspaceId}/access` returning raw grants plus effective-role sources.

## Phase 3: Admin UI Features

- [x] 3.1 Create `admin-web/src/app/shell/AdminLayout.tsx` and nav config so only Members, Invitations, Groups, Workspaces, and Access routes are visible.
- [x] 3.2 Create `admin-web/src/features/members/{MembersPage.tsx,InviteMemberForm.tsx,queries.ts,mutations.ts}` for member list, invite flow, role edits, and backend validation recovery.
- [x] 3.3 Create `admin-web/src/features/groups/{GroupsPage.tsx,GroupMembersPanel.tsx,queries.ts,mutations.ts}` for flat group CRUD and member assignment.
- [x] 3.4 Create `admin-web/src/features/workspaces/{WorkspacesPage.tsx,WorkspaceForm.tsx}` and `src/features/access/{AccessPage.tsx,AccessGrantForm.tsx,queries.ts,mutations.ts}` for workspace creation, direct/group grants, and effective-role review.

## Phase 4: Verification And Documentation

- [x] 4.1 Add focused tests in `admin-web/src/app/router.test.tsx`, `src/features/members/*.test.tsx`, and `src/features/access/*.test.tsx` for guard, empty/error, invite, role-rejection, and highest-role-wins scenarios.
- [x] 4.2 Add backend coverage in `backend/internal/{organizations,groups,workspaces}/*_test.go` for new read endpoints and authorization failures.
- [x] 4.3 Document delivery and operator scope in `README.md` and `docs/roadmap.md`, then run manual validation for login, non-admin rejection, invite visibility, group membership, workspace creation, and mixed-grant access review.
