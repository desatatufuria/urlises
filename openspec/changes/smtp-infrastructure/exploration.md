## Exploration: smtp-infrastructure

### Current State
The Go API loads server, auth, and database settings in `internal/config`; `Load` currently has no tests and validates required database/JWT settings before constructing `Config`. `cmd/api/main.go` is the composition root and directly constructs concrete services. There is no mail package, SMTP dependency, or mailer port. Mailpit is present in Compose, but the backend does not yet receive SMTP settings or depend on it. Invitation creation persists an invitation and token, but this change must not inject or call a mailer from that flow.

### Affected Areas
- `backend/internal/config/config.go` — add `MailConfig` and validate mail settings only when sending is enabled.
- `backend/cmd/api/main.go` — construct and validate the SMTP adapter at composition time without connecting it to invitation creation.
- `backend/internal/mailer/` (new) — define the provider-neutral `Mailer` port, message value, and SMTP implementation.
- `backend/internal/config/config_test.go` (new) — table-driven enabled/disabled and invalid-combination configuration tests.
- `backend/internal/mailer/*_test.go` (new) — focused message, TLS/auth selection, and error-path unit tests; a separately opt-in Mailpit smoke test.
- `docker-compose.yml` — add backend-only local mail environment (`mailpit:1025`, no TLS/auth) and service ordering if needed; do not expose credentials.

### Approaches
1. **Standard-library SMTP client** — use `net/smtp` with `net.Dialer.DialContext`, `tls.Dialer` plus `smtp.NewClient` for implicit TLS, and `Client.StartTLS` for STARTTLS.
   - Pros: no new module dependency; supports plaintext Mailpit, STARTTLS, implicit TLS, and `PLAIN` auth; all transport behavior remains small and directly testable.
   - Cons: `net/smtp` is frozen, so MIME construction, timeouts, and the SMTP command sequence must be owned by the adapter.
   - Effort: Medium.

2. **Add a third-party SMTP/message library** — delegate MIME assembly and connection modes to an external package.
   - Pros: potentially richer message and attachment support later.
   - Cons: expands the currently small dependency surface for requirements limited to plain text delivery; still needs a port, configuration, and integration strategy.
   - Effort: Medium.

### Recommendation
Choose the standard-library adapter behind a narrow `Mailer` port. Add a `MailConfig` with `Enabled`, sender address, host, port, timeout, TLS mode (`none`, `starttls`, `tls`), and auth mode (`none`, `plain`). When disabled, no relay fields are required and composition provides a disabled/no-op mailer; when enabled, validate host, 1–65535 port, a parseable sender, supported modes, and complete credentials for `plain` auth. Reject `plain` auth with TLS mode `none` so credentials cannot be sent in cleartext. Local Compose config should enable delivery to `mailpit:1025` with TLS and auth both `none`; production must select `starttls` or implicit `tls` and may use `plain` auth only over one of those secure modes.

Define `Mailer.Send(ctx, Message) error` in `internal/mailer`, with a small message containing sender, recipient(s), subject, and text body. The SMTP adapter must dial only during `Send`, use context-aware dialing and a bounded timeout, build headers defensively, and return stage-specific errors without including credentials, message bodies, or invitation tokens. `main` should construct the configured mailer so startup validates composition, but no organization or invitation service should receive it in this change.

Use table-driven unit tests for configuration validation and adapter behavior. Add an opt-in smoke test that skips for `testing.Short()` and unless an explicit `MAILER_SMTP_SMOKE_ADDR` is set; point it to `mailpit:1025` from the Compose network (or a deliberately published host port when run from the host). It should send a fixed non-sensitive test message and verify SMTP acceptance only; inspecting Mailpit's UI/API is optional and should not become a production dependency.

### Risks
- `net/smtp` is frozen; keep the adapter deliberately small and revisit a maintained dependency only when richer MIME/provider features are actually required.
- Implicit TLS, STARTTLS, auth, and disabled-mode validation can be misconfigured; exhaustive table tests must cover each allowed and rejected combination.
- Do not establish an SMTP connection at API startup: Mailpit or a production relay may be temporarily unavailable. Surface delivery errors only when a future caller invokes `Send`.
- SMTP credentials, message bodies, and invitation tokens must never be logged or included in wrapped errors.

### Ready for Proposal
Yes — propose the bounded infrastructure slice above. Keep invitation/outbox delivery, invitation lifecycle behavior, and admin-web work explicitly excluded; forecast it as a single review unit under the 800-line budget, with the Mailpit smoke test opt-in.
