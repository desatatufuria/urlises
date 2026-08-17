# Proposal: Create Additional Organizations from Admin Web

## Intent

Enable owner/admin operators to create another organization after first-run setup, without leaving the authenticated Admin Web. This removes the current one-organization-only UI gap while preserving the existing API contract.

## Scope

### In Scope
- Add an owner/admin-protected Admin Web page and shell entry point for organization creation.
- Submit the existing authenticated `POST /organizations` request with the established uncertain-creation idempotency-key behavior.
- On success, persist the returned owner membership, select it as active, and navigate to its overview.
- Add focused route, success/switching, API-failure, and uncertain-retry coverage.

### Out of Scope
- Backend authorization or API-contract changes: `POST /organizations` remains available to any authenticated user.
- Changes to first-run `OrganizationSetupPage` semantics, organization branding (`OdA`), invitation flows, or cross-organization management.

## Capabilities

### New Capabilities
- `admin-organization-creation`: Admin Web flow for eligible operators to create and immediately enter an additional organization.

### Modified Capabilities
None. Existing OpenSpec capabilities cover extension behavior only.

## Approach

Add a routed page within `RequireAdminOrganization`, linked from `AdminLayout`. Reuse the existing API client and `useUncertainCreationKey`; retain a key for uncertain transport failures and discard it for definite API errors. Return the created membership from the authenticated action, append it to the persisted snapshot, call `setActiveOrganizationId`, then navigate home. The existing backend transaction establishes the creator as owner.

## Product Rules

- The Admin Web entry point is only available after an owner/admin membership resolves.
- A successful creation always switches the active organization before organization-scoped work resumes.
- First-run setup remains the only path for users with no organizations.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `admin-web/src/app/shell/AdminLayout.tsx` | Modified | Add creation entry point; retain `OdA`. |
| `admin-web/src/app/router.tsx` | Modified | Add protected route. |
| `admin-web/src/app/views/` | New | Routed creation form and states. |
| `admin-web/src/app/providers/{Auth,Organization}Provider.tsx` | Modified | Persist membership and select it. |
| Admin Web tests | Modified/New | Cover eligibility and creation outcomes. |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| UI policy differs from backend authorization | Medium | Document UI-only gate; do not alter API. |
| Follow-up work targets prior organization | Medium | Switch active ID before navigation; test it. |
| Duplicate create after network uncertainty | Low | Reuse existing idempotency-key lifecycle. |

## Rollback Plan

Revert the Admin Web route, shell entry, and creation-state updates as one change. The backend remains untouched; organizations already created remain valid owner-scoped records and can be selected through existing behavior.

## Dependencies

- Existing authenticated organization API, owner-creation transaction, and idempotency ledger.
- Gitflow intent: deliver on `feat/admin-multi-organization-create` as one PR, within the approved 800-line review budget; no documentation beyond this SDD artifact is changed in this phase.

## Success Criteria

- [ ] Eligible operators can create an organization and land in its overview as owner.
- [ ] Ineligible Admin Web users cannot reach the creation page; backend authenticated access is unchanged.
- [ ] Failure and uncertain retry behavior do not duplicate the organization.
