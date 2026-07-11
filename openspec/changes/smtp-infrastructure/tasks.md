# Tasks: SMTP Infrastructure

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 900–1,100 |
| 800-line session budget risk | High |
| 400-line reviewer-burden signal | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | auto-forecast |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Validated config and local setup/docs | PR 1; base = feature/tracker | `cd backend && go test ./internal/config` | `docker compose config` | `config.go`, config tests, Compose mail env, README mail section |
| 2 | Provider-neutral SMTP adapter | PR 2; base = PR 1 branch | `cd backend && go test ./internal/mailer -run TestSMTP` | Scripted loopback SMTP in package tests | `internal/mailer/{mailer.go,smtp.go,smtp_test.go}` |
| 3 | Opt-in Mailpit proof | PR 3; base = PR 2 branch | `cd backend && go test ./internal/mailer` | `docker compose up -d mailpit`; opt-in smoke command | `internal/mailer/mailpit_test.go` only |

## Phase 1: Safe Foundation and Configuration

- [x] 1.1 Before apply, preserve the current `feature/admin-web-ui` dirty diff; begin only from an isolated SMTP branch/worktree and record baseline diffs for `README.md`, `docker-compose.yml`, and `backend/cmd/api/main.go`.
- [x] 1.2 Add behavior-first table tests in `backend/internal/config/config_test.go` for disabled defaults, enabled invalid fields/fallbacks, TLS/auth combinations, and credential-free `none`.
- [x] 1.3 Add `MailConfig`, enum parsing, conditional validation, and safe defaults to `backend/internal/config/config.go`; disabled loading must not dial and PLAIN requires TLS plus complete credentials.
- [x] 1.4 Update `docker-compose.yml` with backend Mailpit env and loopback-only `127.0.0.1:1025`/`127.0.0.1:8025` mappings; keep backend dependent only on PostgreSQL. Update `README.md` with variables, security, mappings, and smoke command.

## Phase 2: Mailer Contract and SMTP Delivery

- [x] 2.1 Add behavior-first `backend/internal/mailer/smtp_test.go` cases for `ErrDisabled`, missing alternatives, invalid recipients/subject/identity, CR/LF rejection, and no dial before validation.
- [x] 2.2 Create `backend/internal/mailer/mailer.go` with `Mailer`, `Message`, and distinguishable disabled-delivery error; implement preflight validation to satisfy Phase 2 tests.
- [x] 2.3 Extend `smtp_test.go` with scripted loopback cases for MIME alternatives, RFC 2047 headers, identity override/fallback, TLS/auth ordering, sanitized stage errors, and cancellation/deadline connection closure.
- [x] 2.4 Create `backend/internal/mailer/smtp.go` with injected dialing, explicit `none`/STARTTLS/implicit-TLS flows, post-TLS PLAIN auth, quoted-printable MIME, bounded deadlines, and safe errors.
- [x] 2.5 Keep `backend/cmd/api/main.go` unchanged: configuration is validated at startup, but no mailer is constructed, retained, connected, or coupled to invitations.

## Phase 3: Opt-in Verification and Scope Guard

- [x] 3.1 Add `backend/internal/mailer/mailpit_test.go`: skip unless `MAILPIT_SMOKE_TEST=1`; parse `MAILPIT_SMOKE_ADDR`, send valid alternatives, and prove Mailpit acceptance without external access by default.
- [x] 3.2 Run focused config/mailer tests, `cd backend && go test ./...`, and the opt-in `MAILPIT_SMOKE_TEST=1 MAILPIT_SMOKE_ADDR=127.0.0.1:1025 go test ./internal/mailer -run TestMailpitSmoke`; verify no invitation, outbox, persistence, state, admin-web, attachment, provider, or `main.go` changes.

Smoke evidence: Mailpit is running on `dtf-netwok` and `shared-bookmark-sync_default`, with exact loopback bindings `127.0.0.1:11025`/`:18025`. Both devcontainer endpoints resolve and connect; `TestMailpitSmoke` passed against `shared-bookmark-sync-mailpit:1025`.

## Phase 4: Review and Rollback

- [x] 4.1 Review each slice against its rollback boundary; a revert or `MAIL_ENABLED=false` must prevent delivery without schema rollback. Threat-matrix rows are N/A, so no additional threat RED tests apply.
