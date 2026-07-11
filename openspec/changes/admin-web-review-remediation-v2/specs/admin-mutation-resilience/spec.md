# Delta for Admin Mutation Resilience

## MODIFIED Requirements

### Requirement: Idempotent Administrative Creation Actions

Only `POST /organizations`, `POST /organizations/{organizationId}/invitations`, `POST /organizations/{organizationId}/groups`, `POST /groups/{groupId}/members`, and `POST /organizations/{organizationId}/workspaces` MUST use idempotency. Identity and fingerprint MUST include principal, method, route template, normalized target UUIDs, key, and payload. Authorization MUST occur in the transaction after lock and before lookup/replay. An authorized identical completed request MUST replay one safe DTO, not create again; revoked access MUST be 403 without stored content. Mismatch MUST conflict. In-flight duplicates MUST create once; failed claims MUST be reclaimable. Others are out of scope.
(Previously: Identity omitted targets and replay lacked transaction-scoped reauthorization.)

#### Scenario: Replay a completed creation

- GIVEN a principal completed an in-scope keyed creation
- WHEN they repeat its canonical route, key, and payload
- THEN it returns the original safe result without another creation

#### Scenario: Reject fingerprint conflict

- GIVEN a principal used a key for one creation payload
- WHEN they reuse it with a different payload on that route
- THEN it returns a conflict and creates no resource

#### Scenario: Concurrent duplicate requests

- GIVEN two identical keyed creations arrive in flight
- WHEN they share principal, route, key, and fingerprint
- THEN at most one creation completes

#### Scenario: Reclaim a failed creation claim

- GIVEN an in-scope creation claim failed
- WHEN its principal retries its route, key, and fingerprint
- THEN the claim is reclaimable

#### Scenario: Complete each keyed route

- GIVEN an authorized principal submits every keyed route
- WHEN each request uses a unique valid key
- THEN each creates once and returns its safe DTO

#### Scenario: Isolate canonical targets

- GIVEN matching requests target different normalized UUIDs
- WHEN the same principal submits both
- THEN neither request replays or aliases the other target

#### Scenario: Deny revoked replay

- GIVEN a completed keyed creation and subsequently revoked access
- WHEN the principal retries the same request
- THEN the response is 403 and exposes no stored content

### Requirement: Retry-Stable Administrative Creation Actions

The user interface MUST retain its key only for uncertain retry; confirmed completion and new intent MUST use a new key. Updates and deletes are out of scope.
(Previously: The interface reused a key for the same intent.)

#### Scenario: Retry after uncertain delivery

- GIVEN an administrative creation submission has no confirmed response
- WHEN the user retries that same creation intent
- THEN the retry sends the original creation key

#### Scenario: Confirmed or new creation intent

- GIVEN a creation has confirmed completion or the user starts a new intent
- WHEN the next creation is submitted
- THEN it uses a new key

### Requirement: Sanitized Unexpected Failures

The system MUST recover panics to a sanitized 500 and emit diagnostics. Caller request IDs MUST be valid UUIDs; otherwise it MUST generate one. Cleanup failures MUST log only a generic class. Responses and logs MUST NOT contain tokens, bodies, raw database errors, or sensitive details.
(Previously: Failures required sanitized 500 responses and diagnostics.)

#### Scenario: Report unexpected failure safely

- GIVEN an administrative mutation fails unexpectedly
- WHEN the failure is handled
- THEN the client receives a generic 500 response and a structured failure event is emitted

#### Scenario: Protect sensitive diagnostics

- GIVEN a failing request contains credentials, a body, and a database error
- WHEN failure reporting is inspected
- THEN neither the response nor emitted log contains those sensitive values

#### Scenario: Recover a panic

- GIVEN an administrative request panics before commitment
- WHEN the failure boundary handles it
- THEN the client receives a sanitized 500 and one safe event

#### Scenario: Validate request IDs and cleanup logs

- GIVEN a request has an invalid request ID and cleanup fails
- WHEN diagnostics are emitted
- THEN a server-generated ID and only a generic cleanup class are exposed
