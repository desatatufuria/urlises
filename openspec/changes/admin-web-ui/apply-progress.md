# Apply Progress: Admin Web UI

## Change
- `admin-web-ui`

## Mode
- Standard

## Delivery
- Strategy: chained PRs
- Chain strategy: feature-branch-chain
- Current work unit: PR 4 / final documentation and manual-validation closure
- Branch context: tracker branch `feature/admin-web-ui`; a PR 4 child slice targets the immediate PR 3 branch, never `main` directly.

## Completed Tasks
- [x] 1.1 Create `admin-web/package.json`, `tsconfig.json`, and `vite.config.ts` with React, TypeScript, TanStack Query, and baseline scripts.
- [x] 1.2 Create `admin-web/src/main.tsx`, `src/app/router.tsx`, and `src/app/providers/{AuthProvider.tsx,OrganizationProvider.tsx}` for login, session restore, org selection, and admin-only guards.
- [x] 1.3 Create `admin-web/src/lib/api/{client.ts,auth.ts,organizations.ts,groups.ts,workspaces.ts}` plus shared query keys/types for current contracts and planned read models.
- [x] 1.4 Create `admin-web/src/lib/ui/tokens.css` and `src/lib/ui/components/{AppShell.tsx,DataState.tsx,Table.tsx,FormRow.tsx,Badge.tsx}` for minimal/premium layout and calm states.
- [x] 2.1 Add `GET /organizations/{organizationId}/invitations` for pending invite listing.
- [x] 2.2 Add `GET /groups/{groupId}/members` for group membership review.
- [x] 2.3 Add `GET /workspaces/{workspaceId}/access` returning raw grants plus effective-role sources.
- [x] 3.1 Create `admin-web/src/app/shell/AdminLayout.tsx` and nav config so only Members, Invitations, Groups, Workspaces, and Access routes are visible.
- [x] 3.2 Create `admin-web/src/features/members/{MembersPage.tsx,InviteMemberForm.tsx,queries.ts,mutations.ts}` for member list, invite flow, role edits, and backend validation recovery.
- [x] 3.3 Create `admin-web/src/features/groups/{GroupsPage.tsx,GroupMembersPanel.tsx,queries.ts,mutations.ts}` for flat group CRUD and member assignment.
- [x] 3.4 Create `admin-web/src/features/workspaces/{WorkspacesPage.tsx,WorkspaceForm.tsx}` and `src/features/access/{AccessPage.tsx,AccessGrantForm.tsx,queries.ts,mutations.ts}` for workspace creation, direct/group grants, and effective-role review.
- [x] 4.1 Add focused tests in `admin-web/src/app/router.test.tsx`, `src/features/members/*.test.tsx`, and `src/features/access/*.test.tsx` for guard, empty/error, invite, role-rejection, and highest-role-wins scenarios.
- [x] 4.2 Add backend coverage for new read endpoints and authorization failures.
- [x] 4.3 Document delivery and operator scope in `README.md` and `docs/roadmap.md`, then run manual validation for login, non-admin rejection, invite visibility, group membership, workspace creation, and mixed-grant access review.

## Files Changed
- `admin-web/src/lib/api/client.ts` — authenticated requests default to the stored client id when a bearer token is present, and client-id storage is seeded from login/restored sessions.
- `admin-web/src/app/providers/AuthProvider.tsx` — login and session restore seed client-id storage before authenticated bootstrap calls.
- `admin-web/src/app/providers/AuthProvider.test.tsx` — focused coverage proves `/me` and `/organizations` receive `X-Client-Id` after login and session restore.
- `backend/internal/httpapi/{cors.go,cors_test.go}` — added a narrow development-only CORS wrapper plus focused preflight/origin tests for the admin web login path.
- `backend/cmd/api/main.go` — wrapped the API mux so CORS preflight is handled before route-level auth middleware.
- `admin-web/src/app/router.tsx` — replaced Workspaces/Access placeholders with live feature pages.
- `admin-web/src/features/workspaces/{WorkspacesPage.tsx,WorkspaceForm.tsx,queries.ts,mutations.ts}` — implemented workspace inventory and creation flow.
- `admin-web/src/features/access/{AccessPage.tsx,AccessGrantForm.tsx,queries.ts,mutations.ts}` — implemented direct/group grant management, effective access review, and source display.
- `admin-web/src/features/{workspaces,access}/*.test.tsx` and `admin-web/src/app/router.test.tsx` — added focused frontend coverage for workspace creation and highest-role-wins scenarios.
- `admin-web/src/lib/ui/tokens.css` — added subtle-card and inline-badge helpers used by the access review surface.
- `admin-web/README.md` — documented the final operator surface, commands, and manual checklist.
- `README.md` — documented the admin-web control plane, verification commands, UI validation checklist, and local admin-web CORS allowance.
- `scripts/activate-local-invitation.sh` — development-only helper that registers/logs in a local test user, privately finds the newest pending invitation, accepts it, and prints safe invitation fields plus remaining browser checks.
- `scripts/activate-local-invitation.sh` — corrected endpoint-specific auth payloads: registration includes `name`; login excludes it so strict JSON decoding can succeed for existing accounts.
- `scripts/activate-local-invitation.sh` — hardened runtime secret handling: auth JSON streams to curl stdin; response bodies, status, and tokens remain in shell memory; sensitive accept configuration streams through curl stdin.
- `scripts/activate-local-invitation.sh` — fixed psql variable interpolation by streaming the newest-pending-invitation query through standard input instead of `psql -c`.
- `scripts/activate-local-invitation.sh` — added pre-auth account detection and safe status-only diagnostics for existing-account password rejection, registration failure, and database lookup failure.
- `scripts/activate-local-invitation.sh` — validates the actual `AcceptedInvitation` response contract and verifies accepted invitation state through a safe psql stdin query.
- `docs/roadmap.md` — recorded the PR 4 scope and the remaining manual validation release gate.
- `backend/internal/organizations/*`, `backend/internal/groups/*`, `backend/internal/workspaces/*` — retained the previously completed backend read-model work in the merged progress record.

## Verification
- Auth request propagation follow-up:
  - `npm run typecheck` — PASS
  - `npm run test` — PASS (14 tests across auth provider, router, members, groups, workspaces, and access pages)
  - `npm run build` — PASS
- `npm run typecheck`
  - Result: PASS
- `npm run test`
  - Result: PASS (12 tests across router, members, groups, workspaces, and access pages)
  - Note: React Router emits the standard v7 future-flag warning during tests only.
- `npm run build`
  - Result: PASS
- `go test ./internal/organizations ./internal/groups ./internal/workspaces ./cmd/api`
  - Result: PASS
- `go test ./...`
  - Result: PASS
- `go build ./cmd/api`
  - Result: PASS

## Task 4.3 Manual Browser Evidence

| Scenario | Result | Evidence |
|---|---|---|
| Authenticated admin login | PASS | User confirmed a successful authenticated admin login. |
| Workspace creation and inventory | PASS | User created and can see `OdA` (`team`) and `monitorizacion` (`shared`), both with current role `admin` and grant source `direct`. |
| Invitation visibility | PASS | User can see `jcarlos@desatatufuria.com` as `member`, `pending`, with `No expiry`. This proves creation/listing only. SMTP delivery and browser acceptance are not implemented and were not claimed. |
| Non-admin rejection | PASS | User confirmed an authenticated `member` cannot enter the admin shell. Visible result: `Organization admin access required` — `This shell is limited to owner and admin memberships. Bookmark or tenant controls stay out of scope here.` |
| Group membership | PASS | After reloading/selecting `pruebas de acceso`, the UI showed `1 member`: `Local invitation test user` / `jcarlos@desatatufuria.com`, status `Assigned`, with `Remove` available. |
| Mixed direct/group grant review | PASS | The Effective access table states it reflects backend highest-role-wins plus contributing grant paths. `jcarlos@desatatufuria.com` resolved to `admin` from `Direct grant` and `Group: 52022435-c950-4744-a3ec-6a0a35d2e64e`, proving direct `viewer` plus group `admin` resolves to `admin` with both paths contributing. The existing admin also appeared as `admin` via `Direct grant`. |

## Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused verification | `bash -n scripts/activate-local-invitation.sh` — PASS; `scripts/activate-local-invitation.sh --help` — PASS (usage printed, exit 0); `scripts/activate-local-invitation.sh --check-payload-shapes` — PASS (registration includes `name`; login excludes it); `scripts/activate-local-invitation.sh --check-acceptance-response` — PASS (actual `organizationId`, `organizationName`, and `role` contract); static acceptance-verification SQL check — PASS (safe fields, accepted status, and non-null acceptance time are queried through psql stdin without `-c`); static runtime secret-storage check — PASS; live Compose DB check — N/A (Docker daemon socket permission remains unavailable); `git diff --check -- scripts/activate-local-invitation.sh openspec/changes/admin-web-ui/apply-progress.md` — PASS (exit 0; no whitespace errors). |
| Runtime harness | User-supplied browser observation — PASS for the complete Task 4.3 walkthrough, including mixed direct/group highest-role-wins review. |
| Rollback boundary | Revert only the Task 4.3 completion evidence and checkbox updates in OpenSpec/Engram artifacts; no application behavior changes. |

## Deviations From Design
- Added a narrow backend CORS compatibility layer for local admin-web development even though it was not called out in `design.md`; the UI exposed a real browser preflight blocker and the change stays intentionally scoped to local origins plus existing auth/sync headers.
- Root `README.md` and `docs/roadmap.md` now distinguish confirmed browser observations from the three scenarios still pending. Task 4.3 remains open until those scenarios are exercised against a live backend target.

## Issues / Risks
- CORS is intentionally hard-scoped to `http://localhost:5173` and `http://127.0.0.1:5173`; any different admin-web dev origin will need an explicit backend follow-up instead of silently widening policy.
- Non-blocking follow-up: group sources in Effective access are rendered as opaque UUIDs (for example `52022435-c950-4744-a3ec-6a0a35d2e64e`) rather than the human-readable group name `pruebas de acceso`. Highest-role-wins behavior is still verified.
- The local invitation helper is intentionally development-only and must not be treated as SMTP delivery or browser acceptance evidence.
- Fixed the existing-account fallback: the login request now excludes the registration-only `name` field required by strict JSON decoding.
- Fixed runtime secret persistence: real auth payloads, API response bodies, bearer tokens, and invitation tokens are no longer written to temporary files.
- Fixed psql query execution: `psql -c` sent `:'email'` directly to PostgreSQL, which does not perform psql variable interpolation; the query now reaches psql through standard input before it is sent to PostgreSQL.
- Observed generic auth failure: the helper now checks account existence before prompting so it can attempt login directly for existing users and report only a safe HTTP status category when the password is rejected.
- Observed successful HTTP acceptance with an incorrect display projection: the backend returns only `organizationId`, `organizationName`, and `role`; the former jq projection showed null `email`, `status`, and `acceptedAt` fields without failing. The helper now validates the real response and verifies accepted state separately through the database.
- React Router v6 emits a future-flag warning in tests; it is non-blocking but should be cleaned up when the app upgrades toward v7.

## Remaining Tasks
- None.

## Focused Remediation Batch 1 (in progress)

gentle-ai.remediation-result/v1
{"lineage_id":"admin-web-ui","generation":1,"mode":"ordinary_4r","transaction_state":"fixing","fix_batch":1,"failed_evidence_revision":"sha256:512e22ac16be3ff5677a2a64a4abc630032f01e0dd4855665a454623dbccaadb","initial_snapshot":"sha256:2acccbe2d639c2cf3a6b86c458db58d5d35d038432ce18d74b0823fe4f713304","status":"partial","completed_fix_ids":["RISK-001","RELIABILITY-001","RELIABILITY-003","RELIABILITY-004","RELIABILITY-005","RELIABILITY-006","RELIABILITY-007","RELIABILITY-008","RELIABILITY-009","RESILIENCE-001","RESILIENCE-002","RESILIENCE-004","RESILIENCE-005"],"pending_fix_ids":["RELIABILITY-002","RELIABILITY-010","RELIABILITY-011","RELIABILITY-012","RELIABILITY-013","RELIABILITY-014","RELIABILITY-015","RESILIENCE-003"]}
gentle-ai.remediation-evidence/v1
{"lineage_id":"admin-web-ui","generation":1,"mode":"ordinary_4r","fix_batch":1,"failed_evidence_revision":"sha256:512e22ac16be3ff5677a2a64a4abc630032f01e0dd4855665a454623dbccaadb","work_units":[{"name":"backend-consistency-and-validation","fix_ids":["RISK-001","RELIABILITY-001","RELIABILITY-005","RELIABILITY-006","RELIABILITY-008","RELIABILITY-009","RESILIENCE-002"],"files":["backend/internal/organizations/service.go","backend/internal/organizations/handler.go","backend/internal/groups/handler.go","backend/internal/workspaces/service.go","backend/internal/workspaces/handler.go"],"focused_test":"cd backend && go test ./internal/organizations ./internal/groups ./internal/workspaces (PASS)","runtime":"N/A: ADMIN_TEST_DATABASE_URL/DATABASE_URL is absent; database-backed contract execution was not claimed","rollback":"git restore -- backend/internal/organizations/service.go backend/internal/organizations/handler.go backend/internal/groups/handler.go backend/internal/workspaces/service.go backend/internal/workspaces/handler.go"},{"name":"spa-resilience-and-cache-consistency","fix_ids":["RELIABILITY-003","RELIABILITY-004","RELIABILITY-007","RESILIENCE-001","RESILIENCE-004","RESILIENCE-005"],"files":["admin-web/src/app/observability.tsx","admin-web/src/main.tsx","admin-web/src/app/providers/AuthProvider.tsx","admin-web/src/app/providers/OrganizationProvider.tsx","admin-web/src/lib/api/client.ts","admin-web/src/features/access/mutations.ts","admin-web/src/features/groups/mutations.ts","admin-web/src/features/access/AccessPage.tsx","admin-web/src/features/groups/GroupsPage.tsx"],"focused_test":"cd admin-web && npm run typecheck && npm run test && npm run build (PASS: 6 files, 14 tests)","runtime":"N/A: no browser/E2E harness is configured","rollback":"git restore -- admin-web/src/app admin-web/src/features/access admin-web/src/features/groups admin-web/src/features/members admin-web/src/lib/api/client.ts"}],"truthful_database_verification":"FAILED PRECONDITION: database URL missing; no database-backed tests were executed"}

## Remediation continuation evidence

gentle-ai.remediation-result/v1
{"lineage_id":"admin-web-ui","generation":1,"mode":"ordinary_4r","transaction_state":"fixing","fix_batch":1,"failed_evidence_revision":"sha256:512e22ac16be3ff5677a2a64a4abc630032f01e0dd4855665a454623dbccaadb","status":"partial","completed_fix_ids":["RISK-001","RELIABILITY-001","RELIABILITY-002","RELIABILITY-003","RELIABILITY-004","RELIABILITY-005","RELIABILITY-006","RELIABILITY-007","RELIABILITY-008","RELIABILITY-009","RELIABILITY-010","RELIABILITY-012","RELIABILITY-014","RELIABILITY-015","RESILIENCE-001","RESILIENCE-002","RESILIENCE-003","RESILIENCE-004","RESILIENCE-005"],"pending_fix_ids":["RELIABILITY-011","RELIABILITY-013"]}
gentle-ai.remediation-evidence/v1
{"lineage_id":"admin-web-ui","generation":1,"mode":"ordinary_4r","fix_batch":1,"failed_evidence_revision":"sha256:512e22ac16be3ff5677a2a64a4abc630032f01e0dd4855665a454623dbccaadb","continuation":{"RELIABILITY-002":"MembersPage test proves a self-demotion reaches the sign-in route immediately","RELIABILITY-010":"AccessPage tests cover direct/group update and revoke; existing test covers direct create","RELIABILITY-012":"AuthProvider tests cover rejected, expired, malformed, and partial restoration failures","RELIABILITY-014":"scripts/verify-admin-db-contracts.sh exits 3 without a URL and runs the admin database package suite when configured","RELIABILITY-015":"MembersPage test proves failed query then Retry reaches the empty-state result","RESILIENCE-003":"proposal.md lists independent boundaries and exact git restore commands"},"focused_test":"npm run test -- --run AuthProvider MembersPage GroupsPage AccessPage: PASS; broad admin-web: 22 tests PASS","backend":"go test ./... && go build ./cmd/api: PASS","database_gate":"scripts/verify-admin-db-contracts.sh: exit 3, ADMIN_TEST_DATABASE_URL/DATABASE_URL absent; contracts not executed","remaining":{"RELIABILITY-011":"test must exercise failed create/rename/delete recovery, not only successful CRUD","RELIABILITY-013":"HTTP handler tests for the three read routes and middleware/envelopes are absent"}} 

## Remediation completion evidence

gentle-ai.remediation-result/v1
{"lineage_id":"admin-web-ui","generation":1,"mode":"ordinary_4r","transaction_state":"fixing","fix_batch":1,"failed_evidence_revision":"sha256:512e22ac16be3ff5677a2a64a4abc630032f01e0dd4855665a454623dbccaadb","status":"success","completed_fix_ids":["RISK-001","RELIABILITY-001","RELIABILITY-002","RELIABILITY-003","RELIABILITY-004","RELIABILITY-005","RELIABILITY-006","RELIABILITY-007","RELIABILITY-008","RELIABILITY-009","RELIABILITY-010","RELIABILITY-011","RELIABILITY-012","RELIABILITY-013","RELIABILITY-014","RELIABILITY-015","RESILIENCE-001","RESILIENCE-002","RESILIENCE-003","RESILIENCE-004","RESILIENCE-005"]}
gentle-ai.remediation-evidence/v1
{"lineage_id":"admin-web-ui","generation":1,"mode":"ordinary_4r","fix_batch":1,"failed_evidence_revision":"sha256:512e22ac16be3ff5677a2a64a4abc630032f01e0dd4855665a454623dbccaadb","RELIABILITY-011":"GroupsPage tests cover successful create/rename/delete plus each failed mutation, notice, and preserved Operators state","RELIABILITY-013":"handler_test.go in organizations/groups/workspaces covers route registration, principal propagation, 200 envelope, forbidden 403, and missing-principal 401 for each read route","focused_commands":["cd backend && go test ./internal/organizations ./internal/groups ./internal/workspaces","cd backend && go test ./... && go build ./cmd/api","cd admin-web && npm run typecheck && npm run test && npm run build"],"results":["PASS","PASS","PASS: 25 tests"],"database_contracts":"NOT EXECUTED: scripts/verify-admin-db-contracts.sh exited 3 because ADMIN_TEST_DATABASE_URL/DATABASE_URL is absent; this required gate prevents a skipped suite from being recorded as pass","rollback":{"groups-tests":"git restore -- admin-web/src/features/groups/GroupsPage.test.tsx","read-route-tests-and-seams":"git restore -- backend/internal/organizations/handler.go backend/internal/organizations/handler_test.go backend/internal/groups/handler.go backend/internal/groups/handler_test.go backend/internal/workspaces/handler.go backend/internal/workspaces/handler_test.go"}}
