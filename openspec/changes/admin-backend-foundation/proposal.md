# Proposal: Admin Backend Foundation

## Intent
- Add the admin/control-plane backend for Acme organizations (OdA), members, groups, workspaces, invitations, and role assignment.
- Close the current gap where sync/bookmark runtime exists, but organization administration, scalable access delegation, and maintainable membership governance do not.

## Proposal question round
- Review later: can one user belong to multiple OdA organizations inside the same Acme tenant?
- Review later: the proposal assumes an organization MUST always retain at least one `owner`.
- Review later: the proposal assumes invitations are email-based, single-use, and access activates only after acceptance.

## Scope
### In Scope
- Organization membership lifecycle: bootstrap first user as initial `owner`, invite-by-email onboarding, and member role management (`owner`, `admin`, `member`).
- First-class organization groups with many-to-many membership and admin-managed CRUD.
- Workspace access management with direct user grants, group grants, and effective-role resolution using highest-role-wins across `admin`, `editor`, `viewer`.

### Out of Scope
- LDAP / Active Directory sync, SCIM, SSO, billing, audit analytics.
- Bookmark/sync engine changes beyond consuming the new access model.

## Capabilities
### New Capabilities
- `organization-admin-control-plane`: organizations, members, invitations, and admin permissions.
- `organization-groups`: reusable group entities and group membership management.
- `workspace-access-management`: direct/group workspace grants and effective role evaluation.

### Modified Capabilities
- None.

## Approach
- Model this as a modular Go control plane aligned with current backend boundaries: auth identity stays in `internal/auth`; add admin domain modules instead of overloading sync logic.
- Persist explicit relations for organization members, groups, group members, workspace-user access, and workspace-group access; compute authorization through deterministic precedence rather than implicit inheritance.
- Keep Gitflow delivery as a documented feature slice and update repository docs with the new admin-domain contract.

## Affected Areas
| Area | Impact | Description |
|------|--------|-------------|
| `backend/internal/organizations` | Modified | organization CRUD and admin authorization |
| `backend/internal/workspaces` | Modified | workspace access reads/effective role checks |
| `backend/internal/groups` | New | group domain + membership management |
| `backend/internal/auth` | Modified | invite acceptance/bootstrap integration |
| `backend/migrations` | Modified | admin/control-plane relational schema |
| `README.md`, `docs/requeriments.md`, `docs/roadmap.md` | Modified | Gitflow + admin-domain documentation |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Ambiguous admin invariants | Med | Spec owner-protection, invite lifecycle, and grant rules explicitly |
| Access queries become hard to scale | Med | Normalize join tables and centralize effective-role evaluation |

## Rollback Plan
- Revert admin endpoints/modules, drop new migrations in reverse order, and keep current sync/bookmark runtime using existing workspace membership reads only.

## Dependencies
- PostgreSQL migrations, JWT identity, and an email invitation delivery adapter.

## Success Criteria
- [ ] Admin backend can create/manage OdA organizations, members, groups, workspaces, and grants.
- [ ] Effective workspace role is deterministic and highest-role-wins across direct and group assignment.
- [ ] Documentation and SDD follow Gitflow and describe the admin/control-plane scope clearly.
