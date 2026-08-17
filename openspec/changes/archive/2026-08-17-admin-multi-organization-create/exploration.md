## Exploration: Admin multi-organization creation

### Current State
The authenticated API already creates an organization transactionally, adds its creator as `owner`, and returns the new membership. The Admin Web already has a typed client, an idempotency-key hook, a persisted organization list, and an owner/admin-only active-organization selector. Creation is currently reachable only through `/setup/organization`, which redirects away once an admin organization exists. The shell's `OdA` text is a fixed product identity; the adjacent organization name is already dynamic.

### Affected Areas
- `admin-web/src/app/shell/AdminLayout.tsx` — add the authenticated-admin entry point near the organization selector; keep `OdA` unchanged.
- `admin-web/src/app/router.tsx` — add a protected create-organization route that is available only after an owner/admin organization is resolved.
- `admin-web/src/app/views/OrganizationSetupPage.tsx` — reference behavior for the name form, failure state, and retry-safe idempotency key handling; it should remain first-run-only.
- `admin-web/src/app/providers/AuthProvider.tsx` — expose creation as a general authenticated action and return or otherwise surface the created membership while updating the persisted list.
- `admin-web/src/app/providers/OrganizationProvider.tsx` — select the new owner membership after creation so the shell and organization-scoped queries move to it.
- `admin-web/src/lib/api/organizations.ts` and `admin-web/src/lib/api/useUncertainCreationKey.ts` — existing API and retry-safe key mechanism; no contract change is required.
- `admin-web/src/app/providers/AuthProvider.test.tsx` and new Admin Web route/component tests — existing provider coverage exists, but setup, selector, and post-create switching have no direct coverage.
- `backend/internal/organizations/handler.go`, `backend/internal/organizations/service.go`, and their tests — verify-only scope: the API already requires authentication, validates a real user in the idempotent path, atomically creates the organization plus owner membership, and has integration coverage for owner bootstrapping.

### Approaches
1. **Dedicated protected create page linked from the shell** — Add a `Create organization` shell action and a route/form using the existing creation-key pattern; on success append the returned membership, select it, and navigate to its overview.
   - Pros: Small, discoverable from every admin page, preserves first-run flow, has an addressable and testable UI state, and reuses current API/idempotency behavior.
   - Cons: Introduces a small form/page alongside the first-run form unless form mechanics are factored later.
   - Effort: Medium

2. **Inline shell dialog/popover** — Put the name form directly in `AdminLayout` beside the selector.
   - Pros: Fewer route changes and fastest interaction.
   - Cons: Adds focus/escape/overlay accessibility work, crowds the global shell, and makes failure/retry state harder to test and preserve across navigation.
   - Effort: Medium

3. **Reuse `/setup/organization` for subsequent creation** — Relax its redirect and link to it from the shell.
   - Pros: Least new UI code.
   - Cons: Conflates first-run onboarding with repeat creation, retains misleading setup copy, and risks breaking the zero-organization guard.
   - Effort: Low

### Recommendation
Use a dedicated protected create page linked from the shell. Restrict the UI entry point to the existing `RequireAdminOrganization` boundary (owner/admin membership), while retaining the backend's existing authenticated-creator contract. Have the create action return the created owner membership, append it atomically to the persisted auth snapshot, call `setActiveOrganizationId` with that ID, then navigate home. Use `useUncertainCreationKey`: reuse a key after an uncertain transport failure, but discard it after a definite API error so corrected input can submit anew. The database transaction prevents an organization-without-owner partial state; the idempotency ledger returns the original successful response for a same-intent retry.

`OdA` should remain out of scope: code shows it is a hardcoded shell/brand label, not the organization identity, which is already rendered dynamically beside it. Changing it requires a separate branding/product decision and does not enable multi-organization creation.

### Risks
- The requested owner/admin UI policy is stricter than the backend: `POST /organizations` authorizes any authenticated existing user, not only users with an existing owner/admin membership. The feature should enforce the requested scope in Admin Web without silently redefining the API unless a product decision expands this change.
- Returning a new membership without explicitly switching active organization would leave users on the prior tenant and could cause follow-up work to be created in the wrong organization.
- The Admin Web lacks direct tests for first-run setup, the selector, and this flow; tests must cover eligibility, success/switching, API failure, and retry with a retained transport-failure key.

### Ready for Proposal
Yes — propose a single-pr Admin Web change, forecast below the 800-line review budget, with no backend contract or `OdA` branding change. The proposal should explicitly state that only the Admin Web entry point is owner/admin-gated while the existing authenticated backend endpoint remains unchanged.
