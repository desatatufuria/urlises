# Tasks: Admin Multi-Organization Creation

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 260–380 authored lines |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR; work-unit commits keep tests with behavior |
| Delivery strategy | single-pr |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Eligible create flow with tests | Single PR | `cd admin-web && npm test && npm run typecheck` | N/A — no E2E harness change; Vitest router integration covers the flow | Revert page, route, shell entry, provider contract, and paired tests together |

## Phase 1: Provider Contract

- [x] 1.1 RED: In `admin-web/src/app/providers/AuthProvider.test.tsx`, assert `createOwnerOrganization` returns and persists the exact mocked owner membership, without role/name substitution.
- [x] 1.2 GREEN: In `admin-web/src/app/providers/AuthProvider.tsx`, type `createOwnerOrganization` as `Promise<OrganizationMembership>`; append, persist, then return the API membership.

## Phase 2: Eligibility and Route Boundary

- [x] 2.1 RED: In `admin-web/src/app/router.test.tsx`, prove owner/admin sees and opens the shell entry, while a member sees no entry and direct `/organizations/new` never renders the form.
- [x] 2.2 GREEN: Update `admin-web/src/app/shell/AdminLayout.tsx` to show the entry only for nonempty `adminOrganizations`; retain existing OdA markup.
- [x] 2.3 GREEN: Update `admin-web/src/app/router.tsx` to place `organizations/new` under `RequireAdminOrganization`, allowing eligible direct access and preserving setup routing.

## Phase 3: Accessible Creation Flow

- [x] 3.1 RED: In `admin-web/src/app/router.test.tsx`, specify labelled/autofocused required input, pending-disabled submit, and a mounted `role="alert" aria-atomic="true"` for definite API messages.
- [x] 3.2 RED: In `admin-web/src/app/router.test.tsx`, assert `ApiError` resubmission mints a fresh key; uncertain transport Retry retains the normalized-intent key; Cancel clears intent and makes no POST.
- [x] 3.3 RED: In `admin-web/src/app/router.test.tsx`, assert success persists the returned membership, selects its organization before replace-navigation to `/`, and first-run setup/creation remains unchanged.
- [x] 3.4 GREEN: Create `admin-web/src/app/views/OrganizationCreatePage.tsx` using `useUncertainCreationKey`, the provider result, active selection, replace navigation, retry-safe errors, and cancellation.

## Phase 4: Verification and Delivery Boundaries

- [x] 4.1 Run `cd admin-web && npm test` and `npm run typecheck`; record results with this single work unit and verify no backend, OdA-branding, or unrelated-refactor diff.
- [x] 4.2 Review rollback as one boundary: remove the new page, route, entry, provider return contract, and their tests; leave created backend organizations intact.
