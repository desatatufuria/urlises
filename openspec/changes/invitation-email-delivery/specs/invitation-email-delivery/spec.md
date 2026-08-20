# Invitation Email Delivery Specification

## Purpose

Deliver a best-effort email when an OdA invitation is created, containing enough information and a working link for the invitee to accept it, without coupling invitation creation to SMTP availability.

## Requirements

### Requirement: Post-Commit Best-Effort Delivery

The system MUST send the invitation email only after the invitation row is durably committed, using the `IdempotencyExecutor.ExecutePrepared` `PostCommit` hook. Delivery failure MUST NOT fail the HTTP response or roll back the invitation. Every send attempt MUST be logged with its outcome.

#### Scenario: Invitation creation triggers a post-commit send

- GIVEN an owner or admin submits `POST /organizations/{organizationId}/invitations` for `invitee@example.com`
- WHEN the invitation row commits successfully
- THEN the system MUST invoke the mailer exactly once after commit
- AND the HTTP response MUST reflect the created invitation regardless of send outcome

#### Scenario: SMTP failure does not fail invitation creation

- GIVEN the invitation row has just committed
- WHEN the mailer send fails (timeout, refused connection, or `ErrDisabled`)
- THEN the system MUST log the failure
- AND the already-returned HTTP response and persisted invitation MUST remain unaffected

#### Scenario: Idempotent replay does not re-trigger a send

- GIVEN a client retries the same `POST /organizations/{organizationId}/invitations` request with the same idempotency key after the first attempt already committed
- WHEN `ExecutePrepared` serves the replayed response
- THEN the system MUST NOT invoke the mailer a second time

### Requirement: Invitation Message Content

The invitation email MUST state the organization name, the inviter's identity, the invited role, and the invitation's expiry, in both a plain-text and an HTML representation.

#### Scenario: Message contains required fields

- GIVEN an invitation is created for organization "Acme" by inviter `owner@acme.com` with role `admin`
- WHEN the invitation email is composed
- THEN the text and HTML bodies MUST each include the organization name, the inviter's identity, the role, and the expiry date

### Requirement: Accept Link Construction

The accept link MUST be built as `{PUBLIC_BASE_URL}/invitations/{token}?email={invitee}`. `PUBLIC_BASE_URL` MUST be a required, validated configuration value whenever `MAIL_ENABLED=true`.

#### Scenario: Link is built from configured public base URL

- GIVEN `PUBLIC_BASE_URL=https://admin.example.com` and an invitation token `abc123` for `invitee@example.com`
- WHEN the invitation email is composed
- THEN the accept link MUST equal `https://admin.example.com/invitations/abc123?email=invitee%40example.com`

#### Scenario: Missing PUBLIC_BASE_URL fails configuration when mail is enabled

- GIVEN `MAIL_ENABLED=true` and `PUBLIC_BASE_URL` is unset or empty
- WHEN configuration is loaded
- THEN loading MUST return a validation error
