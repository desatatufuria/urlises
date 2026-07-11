# SMTP Delivery Specification

## Purpose

Define a provider-neutral SMTP delivery boundary for future workflows without adding any workflow integration.

## Requirements

### Requirement: Conditional Mail Configuration

The system MUST allow mail to be disabled without outbound SMTP settings. When enabled, it MUST parse and validate a non-empty host, port in the valid network range, positive timeout, and valid platform sender mailbox. It MUST support TLS modes `none`, `starttls`, and `tls`, and authentication modes `none` and `plain`.

#### Scenario: Disabled configuration

- GIVEN mail is disabled and SMTP fields are absent
- WHEN configuration is loaded
- THEN loading SHALL succeed without attempting an SMTP connection

#### Scenario: Invalid enabled configuration

- GIVEN mail is enabled with an invalid port, timeout, sender, TLS mode, or auth mode
- WHEN configuration is loaded
- THEN loading MUST return a validation error

### Requirement: Secure Authentication

The system MUST reject `plain` authentication unless encrypted transport is configured through `starttls` or `tls`. `plain` authentication MUST have complete, non-empty username and password credentials; missing or partial credentials MUST fail validation. Authentication mode `none` MUST NOT require, use, or transmit credentials.

#### Scenario: PLAIN over encrypted transport

- GIVEN enabled mail uses `plain` authentication, `starttls` or `tls`, and non-empty credentials
- WHEN configuration is validated
- THEN validation SHALL succeed

#### Scenario: PLAIN without encryption

- GIVEN enabled mail uses `plain` authentication and TLS mode `none`
- WHEN configuration is validated
- THEN validation MUST fail before sending

#### Scenario: Incomplete PLAIN credentials

- GIVEN enabled mail uses `plain` authentication with a missing username or password
- WHEN configuration is validated
- THEN validation MUST fail before sending

#### Scenario: Credential-free authentication

- GIVEN enabled mail uses authentication mode `none`
- WHEN configuration is validated or delivery is requested
- THEN it MUST NOT require, use, or transmit credentials

### Requirement: Explicit Disabled Delivery Error

The delivery contract MUST return an explicit, distinguishable error when send is requested while mail is disabled. It MUST NOT silently discard the message.

#### Scenario: Send while disabled

- GIVEN mail is disabled
- WHEN a caller requests delivery
- THEN the call MUST return the disabled-delivery error

### Requirement: Alternative Message Content

The system MUST deliver each message as one MIME alternative containing both plain-text and HTML representations.

#### Scenario: Alternative delivery

- GIVEN a valid message with text and HTML content
- WHEN delivery is accepted by SMTP
- THEN the submitted MIME message MUST expose both alternatives

#### Scenario: Missing alternative

- GIVEN a message lacks either plain-text or HTML content
- WHEN delivery is requested
- THEN the call MUST reject the message without network delivery

### Requirement: Sender Identity and Header Safety

The system MUST use the configured, platform-verified sender mailbox as `From`. It MUST use a per-message organization display name and Reply-To when provided, otherwise configured global fallbacks. A configured global display name MUST be safe and non-empty; a configured global Reply-To MUST be a valid address. It MUST reject malformed addresses and CR/LF or other header-injection input. Errors and logs MUST NOT expose credentials or message content.

#### Scenario: Organization identity override

- GIVEN a valid message provides organization display name and Reply-To
- WHEN delivery is composed
- THEN `From` SHALL retain the platform mailbox and use the organization values

#### Scenario: Unsafe header input

- GIVEN a message contains an injected or malformed header value
- WHEN delivery is requested
- THEN it MUST fail without sending or exposing sensitive values

#### Scenario: Unsafe global fallback

- GIVEN a configured global display name is empty or unsafe, or global Reply-To is malformed
- WHEN configuration is loaded
- THEN validation MUST fail without network delivery

### Requirement: Message Recipient and Subject Validation

The system MUST require at least one valid recipient and a safe, non-empty subject. It MUST reject malformed recipient addresses and CR/LF header injection in recipients or subject before network delivery.

#### Scenario: Valid recipient and subject

- GIVEN a message has one or more valid recipients and a safe non-empty subject
- WHEN delivery is requested
- THEN validation SHALL permit delivery to proceed

#### Scenario: Unsafe recipient or subject

- GIVEN a message has no valid recipient, a malformed recipient, an empty subject, or CR/LF input
- WHEN delivery is requested
- THEN it MUST fail before network delivery

### Requirement: Bounded, Context-Aware SMTP Operations

The system MUST perform SMTP network operations within the configured timeout and caller context. It MUST NOT connect during startup.

#### Scenario: Canceled send

- GIVEN an enabled SMTP operation whose context is canceled
- WHEN delivery is in progress
- THEN the operation MUST stop and return a non-sensitive error

### Requirement: Local Verification and Boundary Scope

The system SHOULD support Mailpit-compatible local SMTP defaults. A live Mailpit smoke test MUST be opt-in and verify SMTP acceptance. The delivery boundary MUST remain provider-neutral and MUST NOT add invitation, outbox, persistence, delivery-state, admin-web, attachment, or provider-specific behavior.

#### Scenario: Opt-in Mailpit smoke test

- GIVEN Mailpit is available and the smoke test is explicitly enabled
- WHEN the test submits a valid message
- THEN Mailpit MUST accept it

#### Scenario: Default test execution

- GIVEN the smoke-test opt-in is absent
- WHEN the standard test suite runs
- THEN it MUST NOT require Mailpit or external SMTP access
