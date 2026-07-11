# Design: SMTP Infrastructure

## Technical Approach

Add a bounded `internal/mailer` port and SMTP adapter, with configuration loaded but no workflow invocation. This implements `smtp-delivery` while preserving the stated boundary: no invitation, outbox, persistence, or UI changes.

## Architecture Decisions

| Decision | Options / tradeoff | Choice and rationale |
|---|---|---|
| Boundary | Direct `net/smtp` calls vs port | `mailer.Mailer` port plus `SMTPMailer`; callers depend only on `Send`, so the frozen stdlib client can be replaced. |
| Composition | Construct in `main` now vs no consumer | `config.Load` validates `Mail`; do **not** construct/store a mailer in `main` until a workflow owns it. Proposal “wiring” means configuration is composition-ready, not a dead variable, fake endpoint, or invitation coupling. A future composition root constructs `mailer.NewSMTP(cfg.Mail)` and injects it into that workflow. |
| Transport | `smtp.SendMail` vs explicit client | Explicit dial/client flow permits TLS modes, deadlines, cancellation, and stage-safe errors. |
| Test seam | Mock SMTP package vs real protocol | Inject an unexported `dialContext` into `newSMTP`; unit tests use a scripted loopback SMTP server and parse MIME. |

## Data Flow

    environment -> config.Load/validate -> config.Mail
    future workflow -> mailer.Mailer.Send -> validate/compose -> SMTP server

`Send` validates before dialing. It uses `net.Dialer.DialContext`, computes the earlier of caller deadline and `MAIL_TIMEOUT`, applies that deadline to the connection, and closes the connection from a cancellation watcher. Closing interrupts every non-context `net/smtp` stage (`NewClient`, `StartTLS`, `Auth`, `Mail`, `Rcpt`, `Data`, `Quit`); `tls.Conn.HandshakeContext` is used for implicit TLS. Return `context.Canceled`/deadline when applicable, otherwise a sanitized stage error.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/config/config.go` | Modify | Add `Config.Mail`, enums, environment parsing and conditional validation. |
| `backend/internal/config/config_test.go` | Create | Table-driven environment/validation tests. |
| `backend/internal/mailer/mailer.go` | Create | Exported port, message and disabled error contracts. |
| `backend/internal/mailer/smtp.go` | Create | SMTP adapter, MIME composition, transport and safe errors. |
| `backend/internal/mailer/smtp_test.go` | Create | Scripted SMTP and cancellation/MIME tests. |
| `backend/internal/mailer/mailpit_test.go` | Create | Opt-in smoke test using `MAILPIT_SMOKE_ADDR`. |
| `docker-compose.yml` | Modify | Backend uses `mailpit:1025`; publish SMTP/UI only on loopback; no Mailpit dependency. |
| `README.md` | Modify | Variables, loopback mappings, security, smoke-test command. |

`backend/cmd/api/main.go` is intentionally unchanged: startup must not connect to or retain an unused mailer.

## Interfaces / Contracts

```go
// internal/mailer
type Mailer interface { Send(context.Context, Message) error }
var ErrDisabled = errors.New("mail delivery is disabled")
type Message struct {
  To []string; Subject, Text, HTML string
  DisplayName, ReplyTo string // per-message overrides
}
type SMTPMailer struct { /* config + unexported dialContext */ }
func NewSMTP(config.MailConfig) Mailer
```

`MailConfig` has `Enabled`, `Host`, `Port`, `Timeout`, `TLSMode`, `AuthMode`, `Username`, `Password`, `FromAddress`, `FromDisplayName`, and `ReplyTo`. String enums are `none|starttls|tls` and `none|plain`. Safe names/defaults: `MAIL_ENABLED=false`; `MAIL_SMTP_PORT=587`; `MAIL_TIMEOUT=10s`; `MAIL_TLS_MODE=starttls`; `MAIL_AUTH_MODE=none`; all other enabled settings are required. Enabled validation requires host, port 1–65535, positive timeout, valid From/Reply-To mailboxes, and non-empty safe display name. `plain` requires `starttls`/`tls` and both credentials; `none` discards and never transmits credentials.

The adapter uses the verified configured mailbox for envelope sender and `From`; message display name/Reply-To override global fallbacks. It rejects empty/malformed recipients, subject, addresses, display names, and every CR/LF header value. It emits RFC 2047-encoded headers and `multipart/alternative` with quoted-printable UTF-8 `text/plain` and `text/html` parts. Safe errors/log fields contain only a stage (`dial`, `tls`, `auth`, `data`) and class; never credentials, addresses when sensitive, bodies, tokens, or raw server replies.

Transport is: plaintext client for `none`; plaintext then advertised `STARTTLS` and TLS handshake for `starttls`; TLS dial/handshake before `smtp.NewClient` for `tls`. PLAIN is created only after encryption is established.

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit | Defaults, disabled/invalid combinations, header and message rejection | Table-driven `config`/`mailer` tests; assert no dial. |
| Unit | MIME, overrides/fallbacks, TLS/auth command order, safe errors | Scripted `net.Listener` plus injected dialer; parse MIME, never snapshot random boundaries. |
| Unit | Cancel/deadline at blocked protocol stages | Server blocks a stage; cancel context; assert prompt return and closed connection. |
| Integration | Mailpit accepts both alternatives from host Go tests | Opt-in only: `MAILPIT_SMOKE_TEST=1 MAILPIT_SMOKE_ADDR=127.0.0.1:1025 go test ./internal/mailer -run TestMailpitSmoke`; otherwise `t.Skip`. The test parses this test-only address into enabled, TLS/auth-`none` mail config. |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or application process-integration boundary. Compose declares service configuration but the application does not execute a process.

## Migration / Rollout

No migration required. Compose configures backend delivery with `MAIL_SMTP_HOST=mailpit`, port `1025`, TLS/auth `none`, and sender identity. Mailpit publishes `127.0.0.1:1025:1025` for host smoke tests and `127.0.0.1:8025:8025` for its UI; containers use `mailpit:1025`. `backend` depends only on PostgreSQL: it neither waits for Mailpit health nor connects at startup. Roll back by disabling mail or reverting; future providers implement `Mailer`.

## Open Questions

None.
