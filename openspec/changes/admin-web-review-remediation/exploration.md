## Exploration: admin-web-review-remediation

### Current State
The current admin-web implementation has verified severe gaps across invitation lifecycle, organization ownership, request idempotency, runtime observability, and evidence quality. The prior `admin-web-ui` review transaction remains immutable in `fix_validating`; this change must be a new remediation lineage and must not alter that ledger or SMTP work.

Verified findings:
- **RELIABILITY-005**: `ListInvitations` filters only `status = 'pending'`; it does not exclude `expires_at <= NOW()`. The integration test proves rejection on acceptance but not omission from the list.
- **RELIABILITY-006**: `CreateInvitation` only rejects an empty normalized email. It neither validates email syntax nor rejects an existing organization member; duplicate-pending rejection is delegated to the new, currently unsafe index and is not mapped to a stable client error.
- **RELIABILITY-009**: `lockOrganizationMemberships` exists but has no call site. `PatchMember` counts owners without a membership lock, so concurrent last-owner demotions/removals can both pass.
- **RELIABILITY-010**: `AccessPage.test.tsx` covers existing group-grant update/revoke, but does not create a new group grant.
- **RELIABILITY-012**: `AuthProvider.test.tsx` proves restoration reaches `anonymous`; it does not mount a protected route and prove navigation to `/login` afterwards.
- **RELIABILITY-014**: `verify-admin-db-contracts.sh` exports only `ADMIN_TEST_DATABASE_URL`, while the three integration helpers read `ORGANIZATIONS_TEST_DATABASE_URL`, `GROUPS_TEST_DATABASE_URL`, `WORKSPACES_TEST_DATABASE_URL`, or `DATABASE_URL`. The command can therefore pass through skipped packages.
- **RESILIENCE-002**: handlers return sanitized 500 bodies, but `main.go` installs only CORS; no middleware logs/reports the request failure that caused a 5xx.
- **RESILIENCE-005**: `apiRequest` adds a fresh `Idempotency-Key` for every POST/PUT/PATCH, but backend source has no key consumption, persistence, replay, or reconciliation.
- **RISK-001**: `PatchMember` authorizes both owners and admins, then accepts `owner` through `normalizeOrganizationRole`; an admin can promote a member to owner. Workspace grants are correctly limited to workspace roles, so this is an organization-membership issue.
- **CRITICAL migration safety**: `000003_admin_remediation.sql` creates the pending-invitation unique index directly. Legacy duplicate pending rows make that transactional migration fail before later remediation can run.

The Gentle AI CLI v1.47.0 rejection is also verified: the old transaction has no appended state change because the successor validator requires correction IDs to equal all corroborated severe findings, but a fix-caused severe finding is not included in `FixFindingIDs`. This is a tooling/provenance constraint, not a product-code finding.

### Affected Areas
- `backend/internal/organizations/service.go` — invitation validation/listing, membership-owner authorization, and atomic last-owner protection.
- `backend/internal/organizations/{service_test.go,service_integration_test.go,handler.go}` — stable error mapping plus PostgreSQL tests for expiry, duplicates, member rejection, owner authorization, and concurrent demotion.
- `backend/migrations/000003_admin_remediation.sql` — reconcile legacy duplicate/expired pending invitations before the partial unique index; migration state must be inventoried before modifying a possibly applied file.
- `backend/internal/httpapi/` and `backend/cmd/api/main.go` — request-scoped, sanitized server-side 5xx reporting and middleware composition.
- `backend/internal/workspaces/*`, `backend/internal/groups/*`, and `backend/internal/organizations/*` — bounded server-side idempotency integration for admin mutations, including persistence/replay semantics and conflict handling.
- `admin-web/src/lib/api/client.ts` and mutation callers — preserve one key per user action across retry/reconciliation rather than regenerating a key per request.
- `admin-web/src/features/access/AccessPage.test.tsx` — group-grant creation and snapshot refresh proof.
- `admin-web/src/app/{providers/AuthProvider.test.tsx,router.test.tsx}` plus `src/test/renderRoute.tsx` — restoration-failure-to-login routing proof.
- `scripts/verify-admin-db-contracts.sh` and package integration helpers — one explicit database URL contract that fails rather than skips.

### Approaches
1. **One bounded remediation PR with reusable backend primitives** — add invitation/ownership fixes, a generic persisted idempotency boundary for admin mutation routes, 5xx reporting middleware, migration reconciliation, and focused frontend/runtime tests.
   - Pros: resolves every verified severe finding coherently; one trustworthy migration/runtime evidence story; preserves a single new lineage.
   - Cons: crosses backend, database, script, and frontend boundaries; likely near or above the 1,600-line budget.
   - Effort: High.

2. **Split product remediation by backend safety and frontend/evidence follow-up** — first ship invitation/ownership/migration/idempotency/reporting, then separately add frontend and harness evidence.
   - Pros: smaller reviews and rollback units.
   - Cons: leaves verified severe frontend/evidence gaps open between PRs and violates the requested single-PR default unless the findings are explicitly re-scoped.
   - Effort: Medium per PR, High overall.

### Recommendation
Use approach 1, but constrain it to the verified severe findings only. Create a new, independent remediation lineage such as `admin-web-review-remediation` with a new target snapshot and an explicit provenance note linking—not modifying—the old `admin-web-ui` transaction. Do not resume `fix_validating`, edit review records, alter SMTP, or broaden into general observability/auth redesign.

The backend design should make three small, testable primitives: (1) invitation lifecycle/validation and owner-transition rules, (2) an idempotency record keyed by authenticated principal, method/path, key, and request fingerprint that replays a completed response or rejects key/payload reuse, and (3) a response-status wrapper that emits sanitized request-failure logs for 5xx. The idempotency key must be generated once per UI mutation attempt and reused for its retry/reconciliation path.

For migration safety, first inventory whether `000003_admin_remediation.sql` is applied anywhere. If it is not deployed, reconcile rows in that migration before creating the index: mark already-expired pending invitations expired, retain a deterministic newest pending row per `(organization_id, lower(email))`, and mark older active duplicates cancelled/expired with timestamps. If it may already be applied, obtain maintainer direction before changing a historical migration; the runner records filenames but no checksums, so silent historical edits are unsafe. Add a PostgreSQL migration test seeded with legacy duplicates and assert full migration completion plus deterministic retained state.

Expected implementation range: **1,350–1,700 changed lines** including focused Go/PostgreSQL/Vitest coverage and the migration/runtime harness. The single-PR 1,600-line budget is at high risk; a maintainer-approved size exception will likely be required before apply unless the final task estimate is kept at or below 1,600 authored changed lines.

### Risks
- Changing `000003` without knowing deployed migration state can create environment drift; migration inventory and explicit approval are required.
- A generic idempotency layer must store/replay only safe sanitized response payloads and define in-flight, fingerprint-mismatch, and failed-request behavior; otherwise it creates new retry inconsistencies.
- Last-owner concurrency needs a real PostgreSQL two-transaction test; unit assertions alone cannot prove the lock boundary.
- Server reporting must not log bearer tokens, request bodies, or sensitive error details; client responses remain sanitized.
- The existing dirty admin-web workspace and old review/SMTP artifacts must remain untouched; implementation must start from an isolated remediation scope.

### Ready for Proposal
Yes — after a maintainer decides (1) the migration deployment state and duplicate-retention policy, (2) whether owner promotion is owner-only or entirely prohibited through this UI/API, and (3) accepts a likely single-PR size exception if the task forecast exceeds 1,600 lines. The proposal should define the new lineage/provenance boundary and explicitly list old `admin-web-ui` review files and SMTP as non-goals.
