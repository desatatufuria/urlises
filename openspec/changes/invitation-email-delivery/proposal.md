# Proposal: Invitation Email Delivery

## Intent

`POST /organizations/{organizationId}/invitations` persists a token that is never emailed, and admin-web has no route that consumes one. Invitees can only join if an admin passes the token out of band. Deliver the email and a working accept link.

## Proposal Question Round

Automatic mode — no interactive round was possible. D1 and D2 are taken positions, open to correction before spec/design.

## Scope

### In Scope
- Best-effort invitation email (plain text + minimal HTML) after the invitation row commits; failures logged only.
- `PUBLIC_BASE_URL` config with validation (required when `MAIL_ENABLED=true`), plus compose files and `.env.example`.
- `expires_at` set at creation; stated in the email.
- `CreateInvitationTx` also returns organization name and inviter email for the body.
- Public admin-web `/invitations/:token` route calling the existing `POST /invitations/{token}/accept`; token/email pass-through in `LoginPage` and `RegisterPage`.

### Out of Scope
- Outbox, queue, retry, resend, cancel, or delivery tracking.
- Any change to `backend/internal/mailer` (stable, tested).
- Email branding beyond a functional text + minimal-HTML pair.
- Backfilling `expires_at`; NULL keeps never-expires semantics.
- A general return-to redirect system, or a public invitation-preview endpoint.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | `expires_at = now + 168h` (7 days), fixed in service code: no env knob, no migration. | Truthful expiry in the email. `AcceptInvitation` already enforces expiry and treats NULL as never-expiring, so no backfill. |
| D2 | Link is `{PUBLIC_BASE_URL}/invitations/{token}?email={invitee}`. `/invitations/:token` forwards `invitation` and `email` to `/login` and `/register`, which preserve both across their mutual links; `RegisterPage` prefills and locks the email when both are present. | Prevents the `ErrInvitationEmailMismatch` dead end with no unauthenticated lookup endpoint. Backend email equality stays the authority; mismatch still maps to a clear inline error. |

## Capabilities

### New Capabilities
- `invitation-email-delivery`: invitation message content, link construction, expiry, best-effort post-commit send.
- `admin-web-invitation-acceptance`: `/invitations/:token` entry point, auth pass-through contract, accept and landing.

### Modified Capabilities
- `organization-admin-control-plane`: invitations MUST carry an expiry set at creation (today unbounded).

## Approach

Backend: `main.go` builds `mailer.NewSMTP(cfg.Mail)` and injects a notifier into the invitation route, mirroring `invitationAccepterAdapter`. The route moves from `IdempotencyExecutor.Execute` to `ExecutePrepared`, returning a `PostCommit` closure that sends after durable commit; replays return a nil hook, so no double-send. Frontend: `/invitations/:token` reads `useAuth().status`, redirects unauthenticated visitors with params preserved, then accepts.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `backend/internal/config/config.go` | Modified | `PublicBaseURL` + validation |
| `backend/internal/organizations/` | Modified | Expiry, org/inviter data, notifier, `ExecutePrepared` |
| `backend/cmd/api/main.go` | Modified | Mailer composition |
| `admin-web/src/app/router.tsx`, `views/` | Modified | Accept route, login/register params |
| `admin-web/src/lib/api/` | New | Accept-invitation client |
| `docker-compose*.yml`, `.env.example`, `docs/deployment.md` | Modified | `PUBLIC_BASE_URL` |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Silent delivery failure | Medium | Structured log per send attempt; `MAIL_ENABLED` documented |
| Idempotent replay double-send | Low | `ExecutePrepared` returns nil hook on replay |
| Interface change breaks handler tests | Medium | Update stubs with the route change |
| Invited email leaked via forwarded link | Low | Token already grants that address; prefill is UX only |

## Rollback Plan

Set `MAIL_ENABLED=false`: sends return `ErrDisabled` (logged), invitation creation unaffected. Otherwise revert the branch. No migration to undo.

## Delivery Intent

Branch `feat/invitation-email-delivery`; one PR forecast, split into backend and admin-web slices if tasks exceed the 400-line review budget. Depends on the merged `smtp-infrastructure` mailer and a canonical public admin-web origin per environment.

## Success Criteria

- [ ] Creating an invitation emails the invitee a working link stating a real expiry; SMTP failure never fails the request.
- [ ] Following the link registers or signs in and accepts the invitation, with the invited email prefilled and locked.
- [ ] `PUBLIC_BASE_URL` is validated, documented, and set in every environment.
