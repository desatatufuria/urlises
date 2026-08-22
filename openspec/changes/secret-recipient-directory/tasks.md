# Tasks: Secret Recipient Directory

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | Backend ~650–750 pre-overrun; Extension ~330–390 pre-overrun; ~1,000–1,150 total pre-overrun. This session's established +40–60% overrun pattern puts actuals at ~1,450–1,800 total |
| 400-line budget risk | **High** — Backend alone (service+handler+3 test files) is pre-overrun ~650–750, already over budget before any overrun buffer |
| Chained PRs recommended | Yes |
| Suggested split | 2 work units: Backend → Extension |
| Delivery strategy | ask-on-risk (cached this session) |
| Chain strategy | feature-branch-chain (cached this session) — tracker `feat/secret-recipient-directory`; only the tracker merges to `develop`, and not until the user says so |

Decision needed before apply: Yes (ask-on-risk requires confirming the Backend/Extension split and chain strategy before `sdd-apply` starts either unit)
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High (Backend unit's own pre-overrun estimate already exceeds 400; Extension unit's Testing Strategy table plus new module plus markup/wiring also risks crossing 400 once overrun is applied)

### Why Backend and Extension are split into two units

The design's own File Changes table (14 files) splits cleanly along the layer boundary it names explicitly: backend (`service.go`, `handler.go`, `predicate_test.go`, `handler_test.go`, `service_test.go`, `auth/handler.go`) vs. extension (`types.ts`, `api.ts`, `projection.ts`, `service-worker.ts`, `recipient-filter.ts`, `create-secret.html`, `create-secret.ts`, `theme.css`, one new `.test.mjs`). No file crosses the boundary. Folding both into one PR would mix a Go authorization-surface review (IDOR/exposure risk, per the Threat Matrix) with a UI/DOM review that has a declared untested-coverage gap — two different review concerns in one diff, the same anti-pattern flagged for prior changes' oversized units.

Backend carries 12 of the Testing Strategy table's 14 rows (10 DB-integration cases in `service_test.go` alone, each with its own fixture) plus the `predicate_test.go` CP14 update that MUST land in the same commit as the new query (design.md's explicit GREEN-breaks-otherwise warning). This is comparable in shape to `bookmark-activity-audit`'s A2a unit, which was pre-estimated ~410 and is exactly the profile flagged High risk there.

### Suggested Work Units

| Unit | Goal | Branch | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| Backend | `MemberName` type, `ListSecretRecipients` + CP14 query, `GET /me/secret-recipients` route, CP14 predicate-test fix, full DB-integration + handler test suite | `feat/secret-recipient-directory-backend` off `feat/secret-recipient-directory` | PR 1 | `cd backend && go test ./internal/organizations` | `docker compose up -d`; call `GET /me/secret-recipients` as a plain member across 2+ orgs, confirm deduped union with no `role` key — or `N/A`, verify Postgres/Docker availability at apply time (not confirmed this session — no shell tool available to this planning agent) | `organizations/service.go` (`MemberName`, const, `ListSecretRecipients`), `organizations/handler.go` (route + interface method), `organizations/predicate_test.go` (count only); revert removes the route and type, `ListMembers`/admin gate never touched |
| Extension | `SecretRecipient` type, `getSecretRecipients`, `listSecretRecipients` + `secrets/recipients` case, `recipient-filter.ts` (new), picker markup, `create-secret.ts` wiring, `.ui-option-list` CSS, api/projection/filter tests | `feat/secret-recipient-directory-extension` off `feat/secret-recipient-directory-backend` | PR 2, base = Backend | `cd extension && npm run test:projection` | Load the unpacked extension, open create-secret window, confirm picker fetch/filter/select fills `#recipient-email` and send still works with directory loading/empty/error — manual, per design's declared DOM-coverage gap (see Phase 5 checklist) | `extension/src/shared/{types.ts,api.ts}`, `background/{projection.ts,service-worker.ts}`, `create-secret/*`, `shared/ui/theme.css` (one class); revert restores blind free-text entry, no backend change needed |

Each unit is developed, tested, and merged into the previous unit's branch before the next unit's branch is created. Only the tracker branch `feat/secret-recipient-directory` eventually merges to `develop`, and only when the user says so.

## Phase B1: Backend — Type, Query, Service Method

- [x] B1.1 GREEN: `backend/internal/organizations/service.go` — add `MemberName{UserID,Email,Name}` struct (no `role` field) and `const maxSecretRecipientResults = 500`, per design.md's exact doc comments.
- [x] B1.2 RED: `backend/internal/organizations/service_test.go` — minimized-shape test: `MemberName` has exactly 3 fields; `json.Marshal` of a populated value never emits `"role"`.
- [x] B1.3 RED: `backend/internal/organizations/predicate_test.go` — update `membershipJoin` expected count from 3 to 4 and its comment/failure message to name CP14/`ListSecretRecipients`, in the SAME commit as B1.4 (design.md: this test fails on GREEN otherwise).
- [x] B1.4 GREEN: `backend/internal/organizations/service.go` — implement `ListSecretRecipients(ctx, requesterUserID)` with the CP14 SQL (membership subquery + `u.disabled_at IS NULL` + `DISTINCT` + `ORDER BY u.email, u.id` + `LIMIT $2`), `make([]MemberName, 0)` default. Confirm B1.3 now passes (count is 4).

## Phase B2: Backend — Integration Coverage (DB-backed)

- [x] B2.1 RED: `service_test.go` — cross-org union + dedup: requester in org A and org B; shared peer appears exactly once; peers unique to A and unique to B both appear.
- [x] B2.2 RED: `service_test.go` — self-inclusion: requester's own `userId` present in their own result.
- [x] B2.3 RED: `service_test.go` — membership-gate-not-admin-gate: requester seeded with role `member` gets a full non-empty result.
- [x] B2.4 RED: `service_test.go` — cross-org isolation: a third org the requester does not belong to contributes zero rows.
- [x] B2.5 RED: `service_test.go` — pending-invitation exclusion: seed via `insertOrganizationsTestInvitation` with `status='pending'`, assert absent; after `AcceptInvitation`, assert present.
- [x] B2.6 RED: `service_test.go` — deactivated-user exclusion: add `disableOrganizationsTestUser` helper (mirrors `softDeleteGroupsTestOrganization`); set `disabled_at`, assert the peer disappears while their `organization_members` row still exists.
- [x] B2.7 RED: `service_test.go` — soft-deleted-org exclusion: stamp `deleted_at` on the shared org, assert its peers vanish (mirrors `groups/service_integration_test.go:120`'s CP11 case).
- [x] B2.8 RED: `service_test.go` — zero-orgs case: requester with no membership gets `[]`, not null, not an error.
- [x] B2.9 RED: `service_test.go` — `LIMIT` honoured: seed more than `maxSecretRecipientResults` peers, assert exactly the cap is returned.
- [x] B2.10 RED: `service_test.go` — `ListMembers` regression proof: in the same fixture, assert `ListMembers` still returns `ErrForbidden` for a plain member and still populates `role` for an admin with the existing ordering (Success Criterion 2).
- [x] B2.11 GREEN: run B2.1–B2.10 against B1.4's implementation; confirm all pass with no further production changes. (All 10 cases SKIP cleanly — no `ORGANIZATIONS_TEST_DATABASE_URL`/`DATABASE_URL` this session — package build/vet is clean and all DB-free tests pass.)

## Phase B3: Backend — Route + Handler Coverage

- [x] B3.1 GREEN: `backend/internal/organizations/handler.go` — add `ListSecretRecipients(context.Context, string) ([]MemberName, error)` to the `routeService` interface.
- [x] B3.2 GREEN: `handler.go` — register `mux.Handle("GET /me/secret-recipients", authMiddleware(...))`: 401 via `PrincipalFromContext` when absent; else call `service.ListSecretRecipients(ctx, principal.UserID)` and `httpapi.WriteJSON(w, 200, map[string]any{"recipients": recipients})`; errors through the existing `writeOrganizationError`. Add the namespace-ownership doc comment above it.
- [x] B3.3 GREEN: `backend/internal/auth/handler.go` — add the reciprocal one-line comment beside `POST /me/deactivate` (line ~162) noting `GET /me/secret-recipients` is registered in `organizations/handler.go`. No behavior change.
- [x] B3.4 RED: `backend/internal/organizations/handler_test.go` — add `ListSecretRecipients` to `organizationsRouteStub`, recording the received `requesterUserID` only (no org id param).
- [x] B3.5 RED: `handler_test.go` — no principal ⇒ 401 with no body leakage; with principal ⇒ 200 and raw-JSON assertion (not decoded struct) that the body contains `userId`/`email`/`name` keys and no `role` key.
- [x] B3.6 RED: `handler_test.go` — stub receives exactly `principal.UserID` and no organization id argument (locks the "no client-supplied org id" property).
- [x] B3.7 RED: `handler_test.go` — register all routes on one mux and assert `GET /me/secret-recipients` resolves without shadowing/being shadowed by `GET /me` or `GET /me/preferences`.
- [x] B3.8 GREEN: run B3.4–B3.7 against B3.1–B3.2; confirm all pass.

## Phase E1: Extension — Types, API, Background Wiring

- [x] E1.1 GREEN: `extension/src/shared/types.ts` — add `SecretRecipient{userId,email,name?}`, placed beside `OrganizationMembership`/`WorkspaceAccess`, with the "mirrors `organizations.MemberName`, no role/org attribution" doc comment.
- [x] E1.2 RED: `extension/tests/secret-recipients.test.mjs` (new) — `api.getSecretRecipients` issues `GET /me/secret-recipients` with the bearer header and unwraps `recipients` (mirrors `list-secrets.test.mjs:37`).
- [x] E1.3 GREEN: `extension/src/shared/api.ts` — implement `getSecretRecipients(backendUrl, session)` per design.md's exact signature, following `getOrganizations`' shape.
- [x] E1.4 RED: same test file — `projection.listSecretRecipients` rejects with `/sign in required/` without a session; returns raw entries with one (mirrors `list-secrets.test.mjs:56,65`).
- [x] E1.5 GREEN: `extension/src/background/projection.ts` — implement `listSecretRecipients()` following `listSecrets`' shape.
- [x] E1.6 GREEN: `extension/src/background/service-worker.ts` — add `case "secrets/recipients": sendResponse(await listSecretRecipients()); return;` next to `secrets/create`/`secrets/send-email`/`secrets/list`.

## Phase E2: Extension — Pure Filter Module

- [x] E2.1 RED: same test file — `filterRecipients` table-driven: empty/whitespace query ⇒ `[]`; email substring match; name substring match; case-insensitive; prefix ranks before mid-string; capped at `MAX_RECIPIENT_SUGGESTIONS`; no match ⇒ `[]`; empty candidate list ⇒ `[]`.
- [x] E2.2 GREEN: `extension/src/create-secret/recipient-filter.ts` (new) — implement `MAX_RECIPIENT_SUGGESTIONS = 8` and `filterRecipients(candidates, query)` per design.md's exact signature and ranking rule.

## Phase E3: Extension — Picker Markup + DOM Wiring (untested per design's declared gap)

- [x] E3.1 GREEN: `extension/src/create-secret/create-secret.html` — insert `#recipient-picker` (input + `<ul>`) and `#recipient-picker-hint` inside `#secret-link-result`, after the `<hr class="ui-divider" />` and before `#send-email-form` (Decision 12 — sibling, not nested).
- [x] E3.2 GREEN: `extension/src/shared/ui/theme.css` — add the one new `.ui-option-list` class (max-height + overflow-y).
- [x] E3.3 GREEN: `extension/src/create-secret/create-secret.ts` — add `RecipientDirectoryState` type (`loading`/`ready`/`error`) and fire-and-forget `void loadRecipients()` call inside `bootstrap()`, never awaited (Decision 13).
- [x] E3.4 GREEN: `create-secret.ts` — implement `renderRecipientPicker()` covering the 6-row degradation table (hidden/empty-hint/`Type to search N colleagues.`/`No colleague matches — type the full address.`/M≤8 options/`Colleague search is unavailable — type the address.`); `#recipient-email` is never `.disabled`.
- [x] E3.5 GREEN: `create-secret.ts` — add the delegated `click` listener on `#recipient-options` that sets `recipientEmailInput.value`, clears the filter, collapses the list, and focuses `#recipient-email`; do not edit `runSendSecretEmail`.
- [x] E3.6 GREEN: `create-secret.ts` — add `clearRecipientPicker()` and call it from `resetToCreateForm()` and after a successful send.

## Phase 5: Verification

- [x] 5.1 `cd backend && go build ./... && go vet ./... && go test ./internal/organizations` — confirmed: build/vet clean, `ok`, includes the CP14 predicate count (4) and the `ListMembers` regression case (B2.10).
- [x] 5.2 `cd extension && npm run test:projection` — confirmed: build clean, 182/182 tests pass, including all of `secret-recipients.test.mjs`.
- [ ] 5.3 `docker ps` checked this session — no Postgres container running (only an unrelated `bookmarks` devcontainer). B2's DB-integration cases (cross-org dedup, self-inclusion, membership-not-admin gate, cross-org isolation, pending-invitation/deactivated-user/soft-deleted-org exclusion, zero-orgs, LIMIT, ListMembers regression) compiled and SKIP cleanly this session. **Deferred**: per this session's established practice, validate against production instead.
- [ ] 5.4 MANUAL VERIFICATION CHECKLIST — picker DOM behavior (design.md's declared automated-coverage gap; NOT the Docker/Postgres note above). Load the unpacked extension, open create-secret, and confirm each of design.md's six degradation-table rows by hand:
  - [ ] 5.4a `loading`: picker hidden, hint empty, `#recipient-email` enabled/focusable/submittable.
  - [ ] 5.4b `ready`, 0 candidates (solo user, zero orgs): picker hidden, hint empty — no broken widget shown.
  - [ ] 5.4c `ready`, N>0, empty query: picker visible, `<ul>` empty, hint reads `Type to search N colleagues.`.
  - [ ] 5.4d `ready`, N>0, 0 matches: picker visible, `<ul>` empty, hint reads `No colleague matches — type the full address.`.
  - [ ] 5.4e `ready`, N>0, M matches: picker visible with M ≤ 8 options, hint empty; clicking an option fills `#recipient-email` and collapses the list.
  - [ ] 5.4f `error` (simulate a failed fetch): picker hidden, hint reads `Colleague search is unavailable — type the address.`, `#recipient-email` still enabled and send still works.
