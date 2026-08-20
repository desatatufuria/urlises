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
