# Design: Admin Multi-Organization Creation

Add an Admin Web-only routed form for eligible operators using the existing `POST /organizations` contract and first-run idempotency lifecycle. It does not alter backend authorization, `OrganizationSetupPage`, or OdA branding.

## Technical Approach

`AdminLayout` exposes a “Create organization” link when `adminOrganizations` is non-empty. The child route lives under `RequireAdminOrganization`, protecting direct URLs. `OrganizationCreatePage` submits `createOwnerOrganization`, receives the exact membership, switches the active ID, then replaces history to `/`.

## Architecture Decisions

| Decision | Options / tradeoff | Choice and rationale |
|---|---|---|
| Eligibility and route boundary | Link-only guard is bypassable; a page-local guard duplicates shell policy | Render the link from `adminOrganizations`; nest `/organizations/new` below `RequireAdminOrganization`. Existing guard already distinguishes no organizations (setup), non-admin memberships (denied), and unresolved active scope (loading). |
| Provider result | Return `void` then reread state risks a stale closure; refetch adds latency and may normalize data | Change `createOwnerOrganization(name, key)` to `Promise<OrganizationMembership>`. It appends and persists exactly the API result in the same snapshot update, then returns that object for immediate selection. Existing setup may ignore the return value, preserving its behavior. |
| Retry semantics | Always minting a key can duplicate uncertain creates; always retaining blocks corrected submissions | Use `useUncertainCreationKey`: `ApiError` is definite, displays its message, and discards that intent key; any other thrown transport failure displays a retry-safe message and retains the normalized intent key. Confirm clears only after success. |
| UX, errors, and cancellation | A modal adds focus management and route ambiguity; `DataState` is visual-only and has no live-region contract | Use a dedicated shell page with labelled required name input, autofocus, disabled submit while pending, and a page-owned, initially empty `role="alert"` live region with `aria-atomic="true"`. Update that region for definite and uncertain failures; do not use `DataState` as the error announcement mechanism. A Cancel link/button to `/` calls `cancel(intent)` before navigation. No backend call occurs on cancellation. |

## Flow and Error Model

```text
eligible AdminLayout link/direct URL
  -> RequireAdminOrganization -> OrganizationCreatePage
  -> keyFor({name}) -> AuthProvider.createOwnerOrganization
  -> POST /organizations -> append exact membership + persist snapshot
  -> setActiveOrganizationId(returned.organizationId) -> navigate("/", replace)
```

An `ApiError` leaves the form editable, writes the server message into the page-owned alert region, and uses a fresh key for corrected/resubmitted intent. A non-`ApiError` leaves the entered value intact, writes the uncertainty message into that same region, and Retry resubmits the same normalized intent/key. Success confirms the key only after provider persistence completes.

## Interfaces / Contracts

```ts
// AuthContextValue
createOwnerOrganization(name: string, idempotencyKey: string): Promise<OrganizationMembership>;
```

The API client and backend remain unchanged. The provider constructs and persists `nextSnapshot` from the response itself (no role/name substitution), returns it, then the page sets its ID before navigation.

```tsx
// OrganizationCreatePage keeps this page-owned region mounted; empty text is inert.
<div aria-atomic="true" role="alert">{error}</div>
```

## File Changes

| File | Action | Description |
|---|---|---|
| `admin-web/src/app/views/OrganizationCreatePage.tsx` | Create | Accessible form, page-owned live error region, cancellation, success, and retry states. |
| `admin-web/src/app/router.tsx` | Modify | Add `organizations/new` beneath `RequireAdminOrganization`. |
| `admin-web/src/app/shell/AdminLayout.tsx` | Modify | Conditionally render the eligible creation entry; retain OdA. |
| `admin-web/src/app/providers/AuthProvider.tsx` | Modify | Return the persisted API membership from `createOwnerOrganization`. |
| `admin-web/src/app/router.test.tsx` | Modify | Route, eligibility, success/switch, failure, retry, and setup regression coverage. |
| `admin-web/src/app/providers/AuthProvider.test.tsx` | Modify | Assert exact returned membership is persisted and surfaced. |

Estimated authored change: 260–380 lines, one PR, below the 800-line budget. Keep each behavior and its tests in one work-unit commit.

## Testing Strategy

| Layer | Coverage | Approach |
|---|---|---|
| Unit | Provider returns/persists exact response; definite vs uncertain key lifecycle | Vitest with mocked `fetch`/`ApiError`; extend existing hook/provider tests. |
| Router integration | Owner/admin sees and opens link; member has no link and direct URL never renders form; eligible direct URL renders form | `renderAppRoute` with role-specific snapshots. |
| Router integration | Success persists exact membership, writes active ID, and lands at `/`; errors get correct keys | Mock POST headers, storage, router state, and UI. |
| Accessibility assertion | Definite API failure is announced by the creation page | After rejected POST, assert the mounted page-owned `getByRole("alert")` contains the server message and has `aria-atomic="true"`; this is the focused RED test for the live-region contract. |
| Regression | No-organization user remains on existing setup route and first-run creation still works | Retain and extend the current onboarding router test. |

`npm test` and `npm run typecheck` in `admin-web` are the focused validation commands. No E2E harness change is needed.

## Threat Matrix

The routing boundary is client-side only; no process-integration boundary applies.

| Boundary | Applicability | Reason |
|---|---|---|
| Documentation-like paths | N/A | No execution or classification. |
| Git repository selection | N/A | No VCS operation. |
| Commit state | N/A | No commit operation. |
| Push state | N/A | No push operation. |
| PR commands | N/A | No PR automation. |

## Rollback / Rollout

No migration, flag, or backend rollout is required. Revert the route, entry point, page, provider return contract, and paired tests together. Already-created organizations remain valid backend records and existing organization selection continues to work.

## Open Questions

None.
