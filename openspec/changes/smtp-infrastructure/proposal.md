# Proposal: SMTP Infrastructure

## Intent

Establish a safe, provider-neutral mail boundary for future workflows. Disabled mail MUST return an explicit error, never silently discard a message.

## Proposal Question Round

Two interactive rounds confirmed: disabled sends error; text+HTML; local/production SMTP; verified platform From; organization display name/Reply-To with global fallback; owner/admin identity persistence/UI deferred; contract prepared now.

## Scope

### In Scope
- Mail configuration, validation, and local Compose defaults for Mailpit.
- A `Mailer` port and SMTP adapter with plain-text and HTML alternatives.
- Verified platform From address; organization display name/Reply-To with global defaults.
- Composition wiring, focused unit tests, and an opt-in Mailpit SMTP-acceptance smoke test.

### Out of Scope
- Invitation outbox/orchestration, invitation sending, expiry, status, resend, or cancellation.
- Admin-web invitation acceptance and persistence/UI for organization identity.
- Attachments, provider-specific APIs, queueing, retries, or delivery tracking.

## Capabilities

### New Capabilities
- `smtp-delivery`: Configured, secure SMTP delivery through a provider-neutral mail contract.

### Modified Capabilities
None. No existing OpenSpec capability defines backend mail delivery.

## Approach

Add `MailConfig` and `Mailer.Send(ctx, Message) error` in `backend/internal/mailer`. Use standard-library SMTP with bounded dialing, multipart alternatives, TLS modes (`none`, `starttls`, `tls`), and `PLAIN` auth only over TLS. Wire it in `cmd/api/main.go`, not invitations; disabled mode errors.

## Product and Documentation Impact

No user-facing flow changes yet. Document mail variables, Mailpit, smoke-test opt-in, and production security in `README.md` or backend operations docs.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `backend/internal/config/` | Modified | Settings and validation tests |
| `backend/internal/mailer/` | New | Contract, adapter, tests |
| `backend/cmd/api/main.go` | Modified | Composition wiring only |
| `docker-compose.yml` | Modified | Backend Mailpit environment/dependency |
| `README.md` | Modified | Mail configuration |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| TLS/auth misconfiguration | Medium | Reject insecure combinations; table tests |
| Sensitive data in errors | Medium | Stage errors without credentials or content |
| Frozen `net/smtp` API | Low | Keep adapter small behind the port |

## Rollback Plan

Revert the feature branch or disable mail; the explicit error prevents unintended delivery. No schema migration is introduced.

## Delivery Intent

Use Gitflow branch `feature/smtp-infrastructure` from `develop`; forecast one PR under 800 lines, splitting only if tasks exceed it.

## Dependencies

- Verified From address and production SMTP credentials in deployment secrets.
- Mailpit through Docker Compose locally.

## Success Criteria

- [ ] Disabled sends return a typed/explicit error; enabled settings validate secure transport and auth combinations.
- [ ] SMTP sends MIME alternatives with configured sender identity; unit tests and opt-in Mailpit acceptance test pass.
- [ ] No invitation or admin-web behavior changes.
