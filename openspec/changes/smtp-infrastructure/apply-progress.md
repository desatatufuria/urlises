# Apply Progress: SMTP Infrastructure

## Status

**Mode**: Standard (strict TDD disabled)

**Completed**: 12/12 tasks.

## Completed Tasks

- [x] 1.1–1.4 — recorded `/tmp/opencode/smtp-infrastructure-baseline.sha256` and `.diff`; added validated mail config, Compose Mailpit wiring, and README operations guidance.
- [x] 2.1–2.5 — added the provider-neutral mailer port, SMTP implementation, loopback tests, and preserved `backend/cmd/api/main.go` byte-for-byte.
- [x] 3.1 — added the opt-in Mailpit smoke test, skipped unless explicitly enabled.
- [x] 4.1 — rollback is limited to the mailer/config/Compose/README paths; `MAIL_ENABLED=false` returns `ErrDisabled` before dialing and requires no schema rollback.

## Final Runtime Evidence

- [x] 3.2 — Mailpit runs on `dtf-netwok` and `shared-bookmark-sync_default`, with exact host bindings `127.0.0.1:11025`/`:18025`.
- [x] Devcontainer DNS/TCP reaches `shared-bookmark-sync-mailpit:1025` and `:8025`.
- [x] `MAILPIT_SMOKE_TEST=1 MAILPIT_SMOKE_ADDR=shared-bookmark-sync-mailpit:1025 go test ./internal/mailer -run TestMailpitSmoke -count=1 -v` passed.
- [x] RESILIENCE-001 — `scripts/test-poc.sh` preserves an existing `dtf-netwok` or creates it before starting the root Compose backend/PostgreSQL/Mailpit stack. The root Compose file intentionally excludes admin-web; its supported devcontainer command is `cd admin-web && VITE_API_BASE_URL=/api npm run dev -- --host 0.0.0.0`. `bash -n`, `docker compose config`, and the isolated-credential runtime harness passed registration, organization creation, and the Mailpit smoke.

## Work Unit Evidence

| Unit | Focused test command/result | Runtime harness/result | Rollback boundary |
| --- | --- | --- | --- |
| Config and local setup | `cd backend && go test -v ./internal/config ./internal/mailer` — pass; 13 leaf cases passed, 1 opt-in smoke skipped | `docker compose config` — pass; Mailpit mappings are loopback only and backend depends only on PostgreSQL | `backend/internal/config/config.go`, config test, `docker-compose.yml`, README mail section |
| SMTP adapter | `cd backend && go test ./internal/mailer` — pass | Scripted loopback SMTP tests — pass for MIME alternatives and cancellation/connection closure | `backend/internal/mailer/{mailer.go,smtp.go,smtp_test.go}` |
| Backend regression | `DATABASE_URL=postgres://postgres:postgres@172.18.0.1:5433/shared_bookmark_sync?sslmode=disable go test ./...` — pass | `go build ./cmd/api` — pass | All SMTP paths above; no schema, invitation, persistence, admin-web, or `main.go` changes |

## External Smoke

The prior host-port conflicts were isolated to loopback bindings. Root Compose now uses verified-free loopback-only defaults `127.0.0.1:11025`/`:18025`, preserving internal `mailpit:1025` and the external `dtf-netwok` attachment. Mailpit is running on both networks; both devcontainer endpoints connect; the opt-in smoke passed.

## Delivery and Scope

Functional POC closure was explicitly selected in one writer thread. No branch, commit, PR, review workflow, archive, invitation, outbox, persistence, or admin-web work was performed.
