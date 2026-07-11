# Proposal: Admin Web UI

## Intent
- Launch the first admin/operator web interface for OdA organization `owner`/`admin` users on top of the merged backend admin foundation.
- Replace API-only administration with a clean, minimal, premium UI for members, invitations, groups, workspaces, and access assignment.

## Proposal question round
- Review later: should workspace creation require assigning at least one additional admin before handoff?
- Review later: the MVP assumes invitation resend/cancel is optional unless backend gaps force it.
- Review later: the MVP assumes group management is flat (no nesting) and access remains explicit per workspace.

## Scope
### In Scope
- Authenticated admin web shell for OdA `owner`/`admin` users with restrained navigation and calm status surfaces.
- Member management flows: list members, invite by email, inspect pending invites, and manage org roles within current backend rules.
- Group, workspace, and access flows: create/manage groups, list workspaces, assign direct/group workspace access, and review effective roles.

### Out of Scope
- Tenant-wide super-admin tooling, billing, analytics, audit dashboards, and extension runtime management.
- Workspace content editing, bookmark operations, and broad backend contract redesign.

## Capabilities
### New Capabilities
- `admin-web-ui-experience`: premium, minimal admin shell, navigation, empty states, and operator-facing interaction patterns.
- `organization-admin-operations-ui`: members, invitations, organization-role management, and pending-access visibility for OdA admins.
- `workspace-access-operations-ui`: groups, workspaces, direct/group grants, and effective-role review/assignment.

### Modified Capabilities
- None.

## Approach
- Build a dedicated web UI layer over existing admin endpoints, keeping backend changes minimal and contract-driven.
- Prioritize ordered information architecture, low-noise tables/forms, and explicit access summaries over dense dashboard widgets.
- Deliver in Gitflow slices and document UI scope/assumptions as the first operator-facing admin surface.

## Affected Areas
| Area | Impact | Description |
|------|--------|-------------|
| `admin-web/` | New | admin application shell, pages, components, and API client |
| `openspec/changes/admin-web-ui/` | New | proposal/spec/design/tasks trail |
| `README.md`, `docs/roadmap.md` | Modified | admin web UI delivery/documentation alignment |
| `backend/internal/*` | Modified | only small API contract fixes if UI exposes backend gaps |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| MVP drifts into generic enterprise dashboard | Med | enforce minimal IA and scope to core admin jobs only |
| Backend admin APIs miss UI-ready read models | Med | keep specs explicit and isolate small contract follow-ups |

## Rollback Plan
- Revert the `admin-web-ui` change artifacts and any UI-specific code/docs; keep the backend admin foundation as the supported control plane.

### Independent Work-Unit Rollback

| Unit | Boundary | Exact command |
|---|---|---|
| 1 — read models | Organization/group/workspace read routes and services | `git restore -- backend/internal/organizations backend/internal/groups backend/internal/workspaces` |
| 2 — shell/foundations | SPA bootstrap, router, providers, API/UI primitives | `git restore -- admin-web/src/app admin-web/src/lib` |
| 3 — people/groups | Member, invitation, and group flows with tests | `git restore -- admin-web/src/features/members admin-web/src/features/groups` |
| 4 — workspaces/access | Workspace/access flows, docs, and verification evidence | `git restore -- admin-web/src/features/workspaces admin-web/src/features/access README.md docs/roadmap.md openspec/changes/admin-web-ui` |

Each command is limited to the named work unit; run `git diff --check` and its focused test command after rollback.

## Dependencies
- Merged admin backend foundation, Gitflow branch `feature/admin-web-ui`, and documented UI delivery updates.

## Success Criteria
- [ ] OdA `owner`/`admin` users can complete member, invitation, group, workspace, and access-assignment flows without raw API calls.
- [ ] The UI feels premium, restrained, and understandable, not like a dense generic dashboard.
- [ ] Scope and Gitflow delivery are documented for downstream specs, design, and implementation.
