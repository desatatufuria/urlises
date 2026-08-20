# Apply Progress: Invitation Email Delivery — PR 1 (Backend)

**Branch**: `feat/invitation-email-delivery-backend` (based on tracker `feat/invitation-email-delivery`)
**Scope**: Phases 1–4, 7.1, 8.1 (backend only). Phases 5, 6, 7.2, 7.3, 8.2 are out of scope for this run (frontend / cross-cutting, deferred to PR 2).
**Mode**: Strict TDD (RED → GREEN, with triangulation)

## Completed Tasks

- [x] 1.1 RED — `backend/internal/config/config_test.go`: `TestLoadPublicBaseURL` table cases (missing-when-enabled, malformed scheme, missing host, query rejected, fragment rejected, trailing slash trimmed, valid https, empty-when-disabled).
- [x] 1.2 GREEN — `backend/internal/config/config.go`: `AppConfig{PublicBaseURL}`, `Config.App`, `AppConfig.Validate(mailEnabled bool)`, wired into `Load` after `mailConfig.Validate()`.
- [x] 1.3 — `docker-compose.yml`: `PUBLIC_BASE_URL: http://localhost:5173` on `backend`.
- [x] 1.4 — `docker-compose.prod.yml`: `PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://admin.urlises.lab.dtfuria.xyz}` on `backend`.
- [x] 1.5 — `.env.example`: applied directly by the orchestrator after this run (sub-agents are permission-blocked from `.env*` paths by design; the orchestrator is not). See `.env.example` `PUBLIC_BASE_URL` line next to `MAIL_*`.
- [x] 1.6 — `docs/installation.md` (env table + new "Manual invitation email check" section) and `docs/deployment.md` (PUBLIC_BASE_URL requirement note).
- [x] 2.1 RED — `backend/internal/organizations/service_test.go`: `TestCreateInvitationSetsExpiryAndInviterContext`, `TestCreateInvitationInviterNamePopulatedWhenPresent`.
- [x] 2.2 GREEN — `backend/internal/organizations/service.go`: `invitationTTL` const, `InvitationCreation` struct, expiry on INSERT ($6), post-INSERT org/inviter `SELECT` inside the same tx, `pgx.ErrNoRows` → `ErrNotFound`, `CreateInvitationTx`/`CreateInvitation` return `(InvitationCreation, error)`. Updated all in-package callers (`service_integration_test.go`, `remediation_integration_test.go`) to the new return shape.
- [x] 3.1 RED — `backend/internal/organizations/invitation_mail_test.go`: exact accept URL (spec scenario), required fields in both bodies, inviter-name variant.
- [x] 3.2 RED — CR/LF organization-name sanitization for the subject line (real correctness test, not cosmetic) + whitespace-collapse triangulation.
- [x] 3.3 RED — HTML-escaping of a `<script>` org name; `ErrDisabled` logged with `reason=disabled` and no token/email/URL leak; triangulated with `reason=send_error` and success logging.
- [x] 3.4 GREEN — `backend/internal/organizations/invitation_mail.go`: `InvitationNotification`, unexported `invitationNotifier` port, `MailInvitationNotifier` + `NewMailInvitationNotifier`, `invitationAcceptURL`, `sanitizeHeaderValue`, `html/template` HTML body, plain-text body, `NotifyInvitation` with the `event=invitation_email_sent` / `event=invitation_email_failed reason=...` logging contract.
- [x] 4.1 RED — `backend/internal/organizations/handler_test.go`: updated `organizationsRouteStub.CreateInvitation` to `(InvitationCreation, error)`; added `nil` notifier arg to all pre-existing `RegisterRoutes` calls.
- [x] 4.2 RED — same file: `TestInvitationRouteInvokesNotifierOnceOnFreshCommand`, `TestInvitationRouteReplayDoesNotReinvokeNotifier`, `TestInvitationRouteNotifierErrorStillReturns201`, `TestInvitationRouteFingerprintConflictSendsNothing` (all DB-backed via `openOrganizationsTestPool`, since `ExecutePrepared` requires a real `*pgxpool.Pool`).
- [x] 4.3 GREEN — `backend/internal/organizations/handler.go`: `creationTxService`/`routeService` return `InvitationCreation`; `RegisterRoutes` gains a `notifier invitationNotifier` parameter before the variadic executors (nil-tolerant); added `idempotencyScope` helper.
- [x] 4.4 GREEN — idempotent branch switched from `executor.Execute` to `executor.ExecutePrepared`, returning a `PostCommit` closure built only when `notifier != nil`; non-idempotent branch performs the same flush-and-notify.
- [x] 4.5 GREEN (load-bearing) — both branches call `http.NewResponseController(w).Flush()` before `hook(...)` / `notifier.NotifyInvitation(...)`, guarded by nil checks, on `context.WithoutCancel(r.Context())`.
- [x] 4.6 GREEN — `backend/cmd/api/main.go`: `mailer.NewSMTP(cfg.Mail)` wrapped by `organizations.NewMailInvitationNotifier(..., cfg.App.PublicBaseURL, os.Stdout)`, passed into `organizations.RegisterRoutes`.
- [x] 7.1 — `cd backend && go test ./internal/config ./internal/organizations ./...` — see Evidence below.
- [x] 8.1 — `MAIL_ENABLED=false` / disabled-mailer rollback behavior confirmed by test.

### Not in scope for this run (left unchecked, belongs to PR 2 / later)
- [ ] 5.1, 5.2 (frontend API client)
- [ ] 6.1–6.8 (frontend routing/pages)
- [ ] 7.2 (frontend test suite)
- [ ] 7.3 (manual end-to-end, needs both PRs)
- [ ] 8.2 (chain-strategy record — already resolved in tasks.md's forecast: `feature-branch-chain`)

## Files Changed

| File | Action | What Was Done |
|---|---|---|
| `backend/internal/config/config.go` | Modified | `AppConfig`, `Config.App`, `Validate`, wired into `Load`. |
| `backend/internal/config/config_test.go` | Modified | New `TestLoadPublicBaseURL`; added `PUBLIC_BASE_URL` to `TestLoadMailConfig`'s enabled cases (safety-net fix — required env changed behavior). |
| `backend/internal/organizations/service.go` | Modified | `invitationTTL`, `InvitationCreation`, expiry + org/inviter read on invitation creation. |
| `backend/internal/organizations/service_test.go` | Modified | Two new DB-backed tests for expiry/context. |
| `backend/internal/organizations/service_integration_test.go` | Modified | Updated callers to `InvitationCreation.Invitation.*` (return-type change ripple). |
| `backend/internal/organizations/remediation_integration_test.go` | Modified | Same ripple fix (one call site). |
| `backend/internal/organizations/invitation_mail.go` | Created | Message composition, link builder, sanitization, `NotifyInvitation` + logging. |
| `backend/internal/organizations/invitation_mail_test.go` | Created | 11 unit tests, zero DB dependency. |
| `backend/internal/organizations/handler.go` | Modified | `RegisterRoutes` notifier param, `ExecutePrepared` wiring, flush-then-notify on both branches, `idempotencyScope`/`invitationNotification` helpers. |
| `backend/internal/organizations/handler_test.go` | Modified | Stub signature fix, `nil` notifier args, 5 new DB-backed handler tests (notifier once/zero/error/conflict + disabled-mail end-to-end). |
| `backend/cmd/api/main.go` | Modified | `mailer.NewSMTP` + `NewMailInvitationNotifier` composition wired into `organizations.RegisterRoutes`. |
| `backend/internal/httpapi/idempotency_routes_integration_test.go` | Modified | Added `nil` notifier arg to 2 external `organizations.RegisterRoutes` call sites (ripple from signature change). |
| `docker-compose.yml` | Modified | `PUBLIC_BASE_URL` on `backend`. |
| `docker-compose.prod.yml` | Modified | `PUBLIC_BASE_URL` on `backend`. |
| `docs/installation.md` | Modified | Env table row + "Manual invitation email check" section. |
| `docs/deployment.md` | Modified | `PUBLIC_BASE_URL` requirement note. |
| `.env.example` | **Not modified** | Blocked by sandbox permissions (see Deviations). |
| `openspec/changes/invitation-email-delivery/tasks.md` | Modified | Checked off 1.1–1.6, 2.1–2.2, 3.1–3.4, 4.1–4.6, 7.1, 8.1 (1.5 applied by the orchestrator after this run and checked off separately). |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 1.1/1.2 | `config_test.go` | Unit | ✅ 3/3 pre-existing (`TestLoadMailConfig`, `TestLoadAuthTokenTTL`, `TestLoadMailConfigDoesNotDial`) | ✅ Written (compile-fail: `cfg.App` undefined) | ✅ Passed | ✅ 8 cases | ➖ None needed |
| 2.1/2.2 | `service_test.go` | Integration (Postgres) | ✅ existing `service_test.go`/`service_integration_test.go` suite | ✅ Written (compile-fail: `invitationTTL` undefined) | ✅ Passed against live Postgres | ✅ 2 cases (with/without inviter name) | ➖ None needed |
| 3.1–3.4 | `invitation_mail_test.go` | Unit | N/A (new file) | ✅ Written (compile-fail: `InvitationNotification` undefined) | ✅ Passed, first attempt | ✅ 11 cases | ➖ None needed |
| 4.1–4.6 | `handler_test.go` | Integration (Postgres) — `ExecutePrepared` requires a real `*pgxpool.Pool`, so these are DB-backed rather than pure mocks, per repo convention | ✅ existing handler suite | ✅ Written (compile-fail: stub type mismatch) | ✅ Passed against live Postgres | ✅ 5 cases (fresh/replay/error/conflict/disabled-mail) | ➖ None needed |

### Test Summary
- **Total tests written**: 8 (config) + 2 (service) + 11 (invitation_mail) + 5 (handler) = 26 new/modified test functions (config count includes the 1 pre-existing test updated for the new required env var).
- **Total tests passing**: all of the above, plus the full pre-existing backend suite (see Evidence).
- **Layers used**: Unit (config: 8, invitation_mail: 11), Integration/Postgres (service: 2, handler: 5).
- **Approval tests**: None — no pure refactors, only additive/interface-widening changes with real behavior change (return-type, expiry, notifier wiring).
- **Pure functions created**: `invitationAcceptURL`, `inviterIdentity`, `roleDescription`, `sanitizeHeaderValue`, `composeInvitationMessage`, `idempotencyScope`, `invitationNotification`.

## Evidence

### Focused command (no DB — baseline)
```
cd backend && go test ./internal/config ./internal/organizations ./...
```
Result: `config` and `organizations` packages **PASS**. `auth`, `database`, `httpapi`, `websocket` packages **FAIL** with `DATABASE_URL is required` / `HTTPAPI_TEST_DATABASE_URL or DATABASE_URL is required` — confirmed **pre-existing** (identical failure reproduced on `internal/auth`, a package untouched by this change, run in isolation).

### Focused command (real ephemeral Postgres, same command)
Spun up a temporary `postgres:16-alpine` container on the sandbox's `dtf-netwok` bridge (reachable from this tool's network namespace), set `DATABASE_URL`/`ORGANIZATIONS_TEST_DATABASE_URL`/`HTTPAPI_TEST_DATABASE_URL`, then ran:
```
go test ./internal/config ./internal/organizations ./... -p 1 -parallel 1
```
Result: **all 12 backend packages PASS**, including every new invitation-email-delivery test (`TestInvitationRouteInvokesNotifierOnceOnFreshCommand`, `TestInvitationRouteReplayDoesNotReinvokeNotifier`, `TestInvitationRouteNotifierErrorStillReturns201`, `TestInvitationRouteFingerprintConflictSendsNothing`, `TestInvitationRouteWithDisabledMailerStillCreatesInvitation`, `TestCreateInvitationSetsExpiryAndInviterContext`, `TestCreateInvitationInviterNamePopulatedWhenPresent`, and all 11 `TestNotifyInvitation*`/`TestInvitationAcceptURL*` tests). `-p 1 -parallel 1` was required only because many tests share one physical Postgres instance and race on `CREATE EXTENSION IF NOT EXISTS pgcrypto`, which is a resource-contention artifact of this improvised single-instance setup, not a code defect (reproduced identically on pre-existing, untouched tests when run with default parallelism against the same shared instance). Container removed after the run.

### `go build ./...`, `go vet ./...`, `gofmt -l`
All clean (no output) for every file touched by this change.

## Deviations from Design

1. **`.env.example` (task 1.5) blocked for this agent, applied by the orchestrator afterward.** The sandbox's permission system denies all `Read` and `Bash` access to `.env.example` and `.env` for sub-agent sessions, for any command that references the path — confirmed by testing multiple invocation shapes (direct `Read`, `cat`, `ls`, `file`). This is a hard permission-system gate scoped to delegated sub-agents, not a tool bug, and per operating instructions it must not be bypassed by this agent. The orchestrator (which is not subject to that scoped restriction) added the `PUBLIC_BASE_URL=` line next to the `MAIL_*` block directly after this run and checked off 1.5 in `tasks.md`.
2. **Handler notifier tests (4.2) are DB-backed, not pure mocks.** The design's Testing Strategy table describes these as "Unit (handler) ... with a counting notifier stub and a fake `creationTxService`." In practice, `httpapi.IdempotencyExecutor.ExecutePrepared` calls `(*pgxpool.Pool).Begin` directly — there is no seam to fake the transaction/pool, and the existing repo convention (`idempotency_routes_integration_test.go`) already tests this boundary against a real Postgres instance. I used the real `*organizations.Service` plus a real DB-backed `IdempotencyExecutor`, with only the **notifier** faked (a counting stub), which still isolates exactly the behavior the task cares about (send-once / send-zero / error-tolerance / conflict-tolerance) without inventing an unverifiable fake transaction type. This matches the repository's own established pattern for this exact boundary.
3. **`docs/deployment.md` does not repeat the Mailpit manual check.** `docs/deployment.md` documents production deployment (Traefik, no Mailpit container); the Mailpit end-to-end check was added to `docs/installation.md` instead, where the `docker-compose.yml` Mailpit service actually exists. `docs/deployment.md` got the `PUBLIC_BASE_URL`-required-when-`MAIL_ENABLED=true` statement instead, per the same task line's other requirement.
4. **Safety-net fix to a pre-existing test.** `TestLoadMailConfig`'s "enabled" cases did not set `PUBLIC_BASE_URL`; since `MAIL_ENABLED=true` now requires it, those cases would fail without a same-file fix. Added `PUBLIC_BASE_URL` to each `MAIL_ENABLED=true` case's env map — this is a required-safety-net update, not a scope change, and is called out explicitly here per the strict-TDD "don't silently deviate" rule.

## Rollback Boundary

Revert `backend/internal/config/config.go` (+test), `backend/internal/organizations/{service.go,invitation_mail.go,handler.go}` (+tests), `backend/cmd/api/main.go`, `backend/internal/httpapi/idempotency_routes_integration_test.go`, `docker-compose.yml`, `docker-compose.prod.yml`, `docs/installation.md`, `docs/deployment.md`. No migration was added or needs undoing (`expires_at` was already nullable). `MAIL_ENABLED=false` keeps invitation creation working with `ErrDisabled` logged, matching the design's stated rollback plan.

## Status

20/20 assigned backend tasks complete (1.5 was applied by the orchestrator after this run, see Deviations; all tasks done and verified green, including against a real Postgres instance, and independently re-verified in `verify-report-backend.md`). Ready for PR 1.

---

# Apply Progress: Invitation Email Delivery — PR 2 (Frontend / admin-web)

**Branch**: `feat/invitation-email-delivery-frontend` (based on PR 1's branch `feat/invitation-email-delivery-backend`, which is already fast-forward-merged into this branch's history)
**Scope**: Phases 5, 6, 7.2, 8.2 (frontend only, `admin-web/`). Did not touch anything under `backend/`. Phase 7.3 is a manual check left unexecuted (no Docker/running stack in this sandbox).
**Mode**: Strict TDD (RED → GREEN, with triangulation)

## Completed Tasks

- [x] 5.1 — `admin-web/src/lib/api/types.ts`: added `AcceptedInvitation { organizationId, organizationName, role: OrganizationRole }` alongside `PendingInvitation`.
- [x] 5.2 — Created `admin-web/src/lib/api/invitations.ts`: `acceptInvitation(accessToken, invitationToken)` calling `POST /invitations/{token}/accept` via `apiRequest`, kept separate from `organizations.ts` per the design's module-ownership decision. (5.1/5.2 are purely structural — type export + a thin wrapper with one possible output — so triangulation was skipped per the strict-TDD rule for structural tasks; both are exercised end-to-end by the `InvitationAcceptPage.test.tsx` suite below, which fails without them.)
- [x] 6.1 RED — `admin-web/src/app/router.test.tsx`: new case `"resolves /invitations/:token as its own public route instead of the catch-all"`, asserting the final location after an anonymous visit is `/login?invitation=abc123&email=invitee%40example.com` (a value only achievable if the dedicated route exists and preserves query params — the pre-existing `*` catch-all silently drops both path and query). Confirmed RED against pre-change `router.tsx` (route resolved to `/login` with no query string).
- [x] 6.2 GREEN — `admin-web/src/app/router.tsx`: registered `{ path: "/invitations/:token", element: <InvitationAcceptPage /> }` as a top-level route, sibling of `/login`/`/register`, outside `RequireSession`.
- [x] 6.3 RED — `admin-web/src/app/views/InvitationAcceptPage.test.tsx`: redirect target per `status` (anonymous → `/login`, setupRequired → `/register`, both with `invitation`/`email` preserved); accept called exactly once under React StrictMode's double-invoked effect (dedicated `renderStrictAppRoute` helper wrapping in `<StrictMode>`, mirroring the app's real `main.tsx` wrapper); all four error mappings (email-mismatch → sign-out action, not-pending, not-found, generic → retry); a working "Try again" action that resets the guard and re-succeeds.
- [x] 6.4 RED (threat-matrix: open redirect) — same file: `"never turns a crafted invitation token into a redirect off the fixed local path"` — uses a token value that is itself a full URL (`https://evil.example.com/phish`) and asserts the resulting pathname is still exactly `/login`, never the crafted value, proving the token is only ever interpolated into a fixed local path's query string.
- [x] 6.5 GREEN — created `admin-web/src/app/views/InvitationAcceptPage.tsx`: `useParams`/`useSearchParams`, branches on `useAuth().status` (`loading`/`anonymous`/`setupRequired`/`authenticated`), `useRef`-guarded single-flight `acceptInvitation` call (guard persists across React StrictMode's double-invoke since the ref lives on the same fiber instance; a separate `retryToken` state is the only thing that re-arms the effect for the "Try again" path), outcome screen ("You joined {org} as {role}", console link only for `owner`/`admin` via an `ADMIN_ROLES` set matching `OrganizationProvider`'s), and the four inline error mappings exactly as specified in the design (message-string matching on `ApiError`, verified against the actual backend error strings in `backend/internal/organizations/service.go:26-27` and `backend/internal/auth/handler.go:182-193`).
- [x] 6.6 — `admin-web/src/app/views/LoginPage.tsx`: added `useSearchParams`; derived `invitation`/`invitedEmail`/`returnTo`; the post-auth `<Navigate to="/" replace/>` now targets `returnTo`; email prefilled (editable) from `invitedEmail`; register link preserves `searchParams.toString()`.
- [x] 6.7 GREEN (critical fix, verified via a dedicated RED→GREEN cycle — see TDD Evidence) — `admin-web/src/app/views/RegisterPage.tsx`: the unconditional `status === "anonymous"` redirect to `/login` is now `if (status === "anonymous" && !invitation) return <Navigate to="/login" replace/>;`, so an invitee with no account can reach the registration form instead of being bounced to `/login` with no way forward.
- [x] 6.8 — `RegisterPage.tsx`: added `useSearchParams`/`returnTo` (defaults to `/setup/organization`); authenticated `<Navigate>` and the post-`signUp` `navigate(...)` both target `returnTo`; email prefilled from `invitedEmail`; when `invitation && invitedEmail` are both present the email input is `readOnly aria-readonly="true"` with a locked-field hint; heading/copy/submit-button label are invitation-aware; login link preserves `searchParams`.

### Necessary completion beyond the design's literal line references (documented, not a silent deviation)

- **`LoginPage.tsx`'s "create an account" link visibility.** The design (`design.md` LoginPage section) specifies only the link's *target* (`{ pathname: "/register", search: searchParams.toString() }}`), not a change to its *display condition*. The pre-existing condition was `status === "setupRequired"` only. For the real invitee flow, an organization already exists (that's what they're being invited into), so `status` is `anonymous`, never `setupRequired` — under the unmodified condition, an invitee landing on `/login?invitation=...` from `InvitationAcceptPage` would see **no link at all** to registration, functionally reproducing the exact dead-end that task 6.7 calls out for `RegisterPage`, just one hop earlier. I changed the condition to `status === "setupRequired" || invitation` (with invitation-aware link copy) so the UI path is actually navigable, not just reachable by a hand-typed URL. This is a completion of the design's own stated intent ("Following the link registers or signs in and accepts the invitation") rather than a deviation from an explicit instruction, and it is covered by the critical-path end-to-end test below.

## Files Changed

| File | Action | What Was Done |
|---|---|---|
| `admin-web/src/lib/api/types.ts` | Modified | Added `AcceptedInvitation`. |
| `admin-web/src/lib/api/invitations.ts` | Created | `acceptInvitation(accessToken, invitationToken)`. |
| `admin-web/src/app/router.tsx` | Modified | Registered `/invitations/:token` as a public top-level route. |
| `admin-web/src/app/router.test.tsx` | Modified | New case proving the route is not swallowed by the `*` catch-all. |
| `admin-web/src/app/views/InvitationAcceptPage.tsx` | Created | Public accept entry point: status routing, single-flight accept, outcome screen, four inline error mappings. |
| `admin-web/src/app/views/InvitationAcceptPage.test.tsx` | Created | 11 tests: redirect targets, open-redirect threat matrix, accept-once (incl. StrictMode), all error mappings + retry, and the full critical invitee end-to-end flow (login → register → land back → accept → outcome). |
| `admin-web/src/app/views/LoginPage.tsx` | Modified | `useSearchParams`, `returnTo`, email prefill, register-link param preservation, link now also shown when `invitation` is present. |
| `admin-web/src/app/views/RegisterPage.tsx` | Modified | `useSearchParams`, `returnTo`, critical anonymous-redirect fix (6.7), email prefill+lock, invitation-aware copy, login-link param preservation. |
| `openspec/changes/invitation-email-delivery/tasks.md` | Modified | Checked off 5.1–5.2, 6.1–6.8, 7.2, 8.2; left 7.3 unchecked with an explicit "not executable in this sandbox" note. |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|---|---|---|
| 5.1/5.2 | exercised via `InvitationAcceptPage.test.tsx` | Unit (structural) | N/A (new) | ➖ Triangulation-exempt: pure type export + one-branch wrapper (no logic, no possible alternate output) | ✅ Passed (every accept-flow test depends on it) | ➖ Skipped: single possible output, per strict-TDD's structural exemption | ➖ None needed |
| 6.1/6.2 | `router.test.tsx` | Integration (React Router + fetch mock) | ✅ 11/11 pre-existing router tests | ✅ Written and confirmed failing (`expected '' to be '?invitation=abc123&email=...'`) against pre-change `router.tsx` | ✅ Passed after registering the route | ➖ Single scenario (route existence); covered further by 6.3/6.4 | ➖ None needed |
| 6.3/6.4/6.5 | `InvitationAcceptPage.test.tsx` | Integration (React Router + AuthProvider + fetch mock, incl. a dedicated `<StrictMode>` render) | N/A (new file) | ✅ Written; RED **retroactively re-confirmed** by temporarily stripping the component's accept/error/outcome logic back to a single loading state and re-running the suite — 8 of 10 tests failed for the right reason (see note below), then the full implementation was restored | ✅ Passed, 11/11 (10 initial + 1 added afterward) | ✅ Multiple cases: 2 redirect targets, 2 role variants (admin vs member) for the outcome screen, 4 distinct error mappings, 1 retry-then-succeed | ➖ None needed — component was already minimal |
| 6.6/6.7/6.8 | `InvitationAcceptPage.test.tsx` (new case: "critical invitee path") | Integration (full login→register→accept flow through the real router, real `AuthProvider`, mocked `fetch`) | ✅ pre-existing `AuthProvider.test.tsx`/`router.test.tsx` suites unaffected | ✅ Written; **RED confirmed** by temporarily reverting `RegisterPage.tsx`'s guard to the original unconditional `status === "anonymous"` redirect and re-running — the test failed exactly at the point of trying to find the registration heading (`Unable to find role="heading" ... /create your account/`), proving it exercises 6.7's fix, not a coincidence | ✅ Passed after restoring the fix; also caught a real test-authoring bug (`getByLabelText("Email")` exact-match broke once a `hint` was added to the locked-email `FormRow`, requiring `getByLabelText(/^email/i)`) | ➖ Single end-to-end scenario is sufficient here — the component-level redirect/prefill/lock behavior is independently covered by dedicated small assertions inside the same test | ➖ None needed |

**Note on the 6.3/6.4/6.5 RED confirmation being retroactive**: `InvitationAcceptPage.tsx` was written as one cohesive file rather than incrementally, because `router.tsx`'s 6.2 GREEN step needed a real (not stub) component to satisfy 6.1's redirect-with-params assertion. To keep RED→GREEN honest rather than silently claim it, I temporarily stripped the component back to a single always-loading state, reran the full test file, confirmed 8 of 10 tests failed for the expected reasons (missing outcome screen, missing error copy, missing StrictMode guard, etc.), then restored the complete implementation and confirmed all tests passed again. This is called out explicitly per the "don't silently deviate" rule rather than presented as a clean incremental RED→GREEN.

### Test Summary
- **Total tests written this run**: 1 (router.test.tsx) + 11 (InvitationAcceptPage.test.tsx) = 12 new test cases.
- **Total tests passing**: all 12 new, plus the full pre-existing frontend suite (see Evidence below) — 49 tests across 9 files, 0 failures.
- **Layers used**: Integration only (React Router + `AuthProvider`/`OrganizationProvider` + mocked `fetch`), matching this codebase's existing convention of fetch-level integration tests via `renderAppRoute` rather than module-level `vi.mock`ing of `lib/api/*` (see Deviations below — the design suggested mocking `lib/api/invitations` directly, but no test file in this codebase uses `vi.mock` for an API module; all existing tests, including `router.test.tsx`, `MembersPage.test.tsx`, and `AuthProvider.test.tsx`, mock at the `fetch` boundary).
- **Approval tests**: None — no pure refactors; all changes are additive/behavior-widening (new route, new redirect conditions, new prefill/lock logic).
- **Pure functions created**: `invitationRedirectQuery` (exported from `InvitationAcceptPage.tsx` for potential reuse/direct testing), `mapAcceptError`.

## Evidence

### Focused command (this work unit, as scoped by the Suggested Work Units table)
```
cd admin-web && npx vitest run src/app/views/InvitationAcceptPage.test.tsx src/app/router.test.tsx
```
Result: **2 files, 22 tests, all PASS.**

### Full frontend suite (task 7.2, required evidence)
```
cd admin-web && npm test
```
Result:
```
 Test Files  9 passed (9)
      Tests  49 passed (49)
```
All 9 test files green: `client.test.ts`, `useUncertainCreationKey.test.ts`, `AuthProvider.test.tsx`, `AccessPage.test.tsx`, `WorkspacesPage.test.tsx`, `MembersPage.test.tsx`, `InvitationAcceptPage.test.tsx` (new), `router.test.tsx`, `GroupsPage.test.tsx`. No pre-existing test was broken by this change.

### `npx tsc --noEmit`
Clean, no output — no type errors introduced across the touched files.

### Runtime harness (task 7.3)
**Not executable in this sandbox.** This task requires a running `docker compose up` stack with a live Mailpit instance (`127.0.0.1:8025`) and a real SMTP-capable backend to send and receive an actual invitation email, then click through the link in a browser. This sandbox has no Docker daemon / running compose stack available to this agent. Left unchecked in `tasks.md` with an explicit note; the orchestrator/user should run it manually per the steps already documented in `docs/installation.md`'s "Manual invitation email check" section (added in PR 1) before considering this change fully verified end-to-end. The equivalent behavior is covered as thoroughly as a runtime harness substitute allows by `InvitationAcceptPage.test.tsx`'s "critical invitee path" test, which exercises the full register → land-back → accept → outcome flow through the real router and real `AuthProvider`, only with `fetch` mocked instead of a live backend.

## Deviations from Design

1. **Fetch-level mocking instead of `vi.mock("../../lib/api/invitations")`.** The design's Testing Strategy table says InvitationAcceptPage tests should use "a mocked `lib/api/invitations`". No test file anywhere in this codebase uses `vi.mock` on an API module (confirmed via `rg -n "vi.mock" src -l` returning zero files) — every existing test, including the closest analog (`router.test.tsx`, `MembersPage.test.tsx`), mocks at the `fetch` boundary via `vi.stubGlobal("fetch", fetchMock)` and asserts on real request URLs/methods. I followed the codebase's established, consistent convention instead of the design's suggested approach, since matching existing patterns is an explicit apply-phase rule and this integration-level approach also gives strictly more coverage (it exercises `acceptInvitation`'s URL-encoding and the real `apiRequest`/`ApiError` mapping, not just a hand-written mock's return value).
2. **`LoginPage`'s register-link visibility condition**, documented above under "Necessary completion beyond the design's literal line references" — not a deviation from an instruction, but an extension of the design's stated intent needed to make the invitee flow actually navigable via UI rather than only reachable by a hand-typed URL.
3. **6.3/6.4/6.5's RED evidence is retroactive, not incremental**, documented above in the TDD Cycle Evidence note — called out explicitly rather than silently presented as clean RED-first.
4. **Task 7.3 is left unchecked**, as instructed, with the reason recorded both in `tasks.md` and here — it requires a running Docker/compose stack this sandbox does not have.

## Rollback Boundary

Revert `admin-web/src/lib/api/{types.ts,invitations.ts}`, `admin-web/src/app/router.tsx` (+test), `admin-web/src/app/views/{InvitationAcceptPage.tsx,InvitationAcceptPage.test.tsx,LoginPage.tsx,RegisterPage.tsx}`. No backend files were touched in this run. No migration, no schema, no persisted state to undo — reverting this PR's branch removes the public route and the login/register pass-through with no data cleanup required, consistent with the design's stated Rollback Plan.

## Status

10/12 assigned frontend tasks complete as originally enumerated (5.1, 5.2, 6.1–6.8, 7.2 = 11 tasks done; 8.2 recorded = 12 total). 7.3 intentionally left unchecked (manual, requires a live stack this sandbox does not have — explicitly called out, not silently skipped). Combined with PR 1's 20/20 backend tasks, the change is functionally complete pending only the manual Mailpit end-to-end check. Ready for PR 2 review; PR 2 targets PR 1's branch per the resolved `feature-branch-chain` strategy.

---

# Apply Progress Addendum: Invitation Resend (out-of-band, post Phase 8)

**Why this is out-of-band**: The original `design.md`/`tasks.md` for this change never covered resending an invitation. While manually testing real invitation emails against a live SMTP server, the user hit `CreateInvitationTx`'s existing (and correct) anti-spam guard — `ErrInvitationPendingExists` — which blocks creating a second pending invitation to the same email/org. That guard has no bypass, so every manual test run required a brand-new email address. This addendum adds a `POST /organizations/{organizationId}/invitations/{invitationId}/resend` endpoint plus a frontend "Resend" action so the same pending invitation (same token/link) can be re-sent instead. Per the user's explicit instruction, this was scoped small enough that a `tasks.md` Phase 9 + this note stand in for a full spec/design cycle — `design.md` was intentionally left untouched.

**Scope**: Additive only. Did not touch `CreateInvitationTx`'s duplicate-block, its `ExecutePrepared`/idempotency wiring, rate-limiting (explicitly out of scope), or any deployment/compose/env files.

## Files Changed

| File | Action | What Was Done |
|---|---|---|
| `backend/internal/organizations/service.go` | Modified | `Service.ResendInvitation` — admin-gated, refreshes `expires_at` on a `status='pending'` invitation scoped to `id + organization_id`, keeps the token, re-reads org/inviter context for the resending admin, single begin/commit tx. |
| `backend/internal/organizations/service_integration_test.go` | Modified | 4 new DB-backed tests (expiry refresh/token-kept, non-pending rejection, non-admin rejection, cross-tenant not-found). |
| `backend/internal/organizations/handler.go` | Modified | New route `POST /organizations/{organizationId}/invitations/{invitationId}/resend`; `routeService.ResendInvitation` added to the interface; `pendingInvitationView` helper (response matches `ListInvitations`'s `PendingInvitation` shape); `writeOrganizationError` gained an `ErrInvitationNotPending` → 400 case. |
| `backend/internal/organizations/handler_test.go` | Modified | 3 new DB-backed handler tests (notify-once, non-pending 400, non-admin 403); `ErrInvitationNotPending` case added to `TestWriteOrganizationErrorMapsInvitationSafetyErrors`; `ResendInvitation` stub added to `organizationsRouteStub`. |
| `admin-web/src/lib/api/organizations.ts` | Modified | `resendOrganizationInvitation(token, organizationId, invitationId)`. |
| `admin-web/src/features/members/mutations.ts` | Modified | `useResendInvitationMutation`. |
| `admin-web/src/features/members/MembersPage.tsx` | Modified | "Actions" column with a per-row Resend button on the pending-invitations table, wired to the mutation, success/failure notices reusing the existing `notice` state pattern. |
| `admin-web/src/features/members/MembersPage.test.tsx` | Modified | 2 new tests (resend success shows confirmation, resend failure shows error notice). |
| `openspec/changes/invitation-email-delivery/tasks.md` | Modified | Appended Phase 9 documenting this addition. |

## TDD Cycle Evidence

| Task | Test File | Layer | RED | GREEN | TRIANGULATE |
|---|---|---|---|---|---|
| 9.1/9.3 | `service_integration_test.go` | Integration (Postgres) | ✅ confirmed via `go vet` compile failure (`service.ResendInvitation undefined`) before implementation | ✅ all 4 pass against a real ephemeral Postgres | ✅ 4 cases (refresh/token-kept, non-pending, non-admin, cross-tenant not-found) |
| 9.2/9.4 | `handler_test.go` | Integration (Postgres), DB-backed per this package's existing convention for this boundary | ✅ same compile-fail RED (interface + route did not exist) | ✅ all 3 pass, plus the updated `TestWriteOrganizationErrorMapsInvitationSafetyErrors` case | ✅ 3 cases (notify-once, 400 non-pending, 403 non-admin) |
| 9.7/9.8 | `MembersPage.test.tsx` | Integration (fetch-mocked, matching this codebase's established convention — see PR 2's own deviation note above) | ✅ ran the 2 new tests against pre-change `MembersPage.tsx`; both failed (`getByRole("button", { name: /resend .../ })` not found) | ✅ both pass after adding the Resend button + mutation | ✅ 2 cases (success notice, failure notice) |

## Evidence

### Backend focused command (real ephemeral Postgres)
```
cd backend && go test ./internal/organizations -run Resend -v -p 1 -parallel 1
```
Result: all 7 new tests **PASS** (`TestResendInvitationRouteRefreshesExpiryAndNotifiesOnce`, `TestResendInvitationRouteRejectsNonPending`, `TestResendInvitationRouteRequiresAdmin`, `TestResendInvitationRefreshesExpiryButKeepsToken`, `TestResendInvitationRejectsNonPending`, `TestResendInvitationRejectsNonAdmin`, `TestResendInvitationNotFoundForWrongOrganization`).

### Backend full suite (real ephemeral Postgres)
```
cd backend && go test ./... -p 1 -parallel 1
```
Result: all 12 packages **PASS** (`access`, `auth`, `bookmarks`, `config`, `database`, `groups`, `httpapi`, `mailer`, `organizations`, `sync`, `websocket`, `workspaces`). Postgres was a temporary `postgres:16-alpine` container spun up on the sandbox's `dtf-netwok` bridge for this run and removed afterward — no persistent DB dependency added.

`gofmt -l internal/organizations/*.go` and `go vet ./...`: clean, no output.

### Frontend focused command
```
cd admin-web && npx vitest run src/features/members/MembersPage.test.tsx
```
Result: **8 tests, all PASS** (6 pre-existing + 2 new).

### Frontend full suite
```
cd admin-web && npm test -- --run
```
Result: **9 test files, 51 tests, all PASS** (49 pre-existing + 2 new). No pre-existing test broken.

`npx tsc --noEmit`: clean, no output.

## Deviations from the (informal) scope

None. Implementation matches the user's scope note exactly: no `ExecutePrepared`/idempotency machinery, same token/link preserved, single simpler transaction, best-effort post-commit notify reusing the existing `MailInvitationNotifier` error-swallowing contract, response shaped like `PendingInvitation` (not the token-bearing creation shape), no rate-limiting added, no deployment/compose/env files touched.

## Rollback Boundary

Revert `backend/internal/organizations/{service.go,handler.go}` (+ their two test files) and `admin-web/src/{lib/api/organizations.ts,features/members/{mutations.ts,MembersPage.tsx,MembersPage.test.tsx}}`. No migration, no schema change — `expires_at`/`token`/`status` columns already existed. Reverting removes the resend route and button with nothing to undo server-side.

## Status

9/9 addendum tasks (9.1–9.9) complete. Not committed — left in the working tree per instruction.
