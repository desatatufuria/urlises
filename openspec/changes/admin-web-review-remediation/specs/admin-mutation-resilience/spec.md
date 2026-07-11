# Admin Mutation Resilience Specification

## Purpose

Define retry-safe administrative mutations and privacy-safe unexpected-failure reporting.

## Requirements

### Requirement: Idempotent Administrative Creation Actions

The system MUST apply this idempotency contract to in-scope administrative commands that create resources or relationships. It MUST identify a creation action by authenticated principal, canonical creation route, idempotency key, and request payload fingerprint. A repeated completed creation with the same identity and fingerprint MUST replay one safe completed creation result without a second creation; the same key with a different fingerprint MUST return a conflict. Concurrent identical in-flight creation attempts MUST deterministically produce at most one creation, and a failed claim MUST be reclaimable according to existing accepted behavior. PATCH/PUT update and DELETE actions are not required to use this idempotency contract in this change.

#### Scenario: Replay a completed creation

- GIVEN a principal has completed an in-scope administrative creation with an idempotency key
- WHEN that principal repeats the canonical creation route, key, and payload
- THEN the system returns the original safe creation result without a second creation

#### Scenario: Reject fingerprint conflict

- GIVEN a principal has used an idempotency key for one creation payload
- WHEN the principal reuses that key with a different payload on the canonical creation route
- THEN the system returns a stable conflict and creates no new resource

#### Scenario: Concurrent duplicate requests

- GIVEN two identical in-scope creation requests arrive while the first is in flight
- WHEN they share principal, canonical creation route, key, and fingerprint
- THEN duplicate handling is deterministic and at most one creation completes

#### Scenario: Reclaim a failed creation claim

- GIVEN an in-scope creation claim failed before completing
- WHEN the same principal retries the same canonical creation route, key, and fingerprint
- THEN the claim is reclaimable according to existing accepted behavior

### Requirement: Retry-Stable Administrative Creation Actions

The user interface MUST reuse one idempotency key when retrying the same administrative creation intent and MUST create a new key only for a new creation intent. Update and delete actions are not required to use this contract in this change.

#### Scenario: Retry after uncertain delivery

- GIVEN an administrative creation submission has no confirmed response
- WHEN the user retries that same creation intent
- THEN the retry sends the original creation key

### Requirement: Sanitized Unexpected Failures

The system MUST return a sanitized 500 response for unexpected server failures and MUST emit structured diagnostic logs. Responses and logs MUST NOT contain tokens, request bodies, raw database errors, or other sensitive details.

#### Scenario: Report unexpected failure safely

- GIVEN an administrative mutation fails unexpectedly
- WHEN the failure is handled
- THEN the client receives a generic 500 response and a structured failure event is emitted

#### Scenario: Protect sensitive diagnostics

- GIVEN a failing request contains credentials, a body, and a database error
- WHEN failure reporting is inspected
- THEN neither the response nor emitted log contains those sensitive values
