# Secret Sharing Specification

## Purpose

Let an authenticated user create a zero-knowledge, one-time-read secret (credential, token, note) and share it via a link the server can never read in plaintext. The recipient's browser decrypts it; the server stores and serves only ciphertext, an optional wrapped key, and metadata.

## Requirements

### Requirement: Zero-Knowledge Secret Creation

The system MUST allow an authenticated user to create a secret by submitting only `ciphertext`, `iv`, and, when passphrase-protected, `wrappedContentKey`, `passphraseSalt`, and `kdfIterations`. The system MUST NOT accept, receive, log, or persist plaintext content, the unwrapped content key, or a passphrase in any form.

#### Scenario: Authenticated user creates a link-only secret

- GIVEN an authenticated user has encrypted their content client-side with a random AES-256-GCM content key
- WHEN they call `POST /secrets` with `{ciphertext, iv}` and no passphrase fields
- THEN the system MUST persist a new secret row with a unique token, `expires_at NOT NULL`, and status `pending`
- AND the response MUST NOT echo back any content key material the client did not itself send

#### Scenario: Authenticated user creates a passphrase-protected secret

- GIVEN an authenticated user has wrapped their content key with a PBKDF2-SHA256-derived key (>= 210,000 iterations, per-secret random salt)
- WHEN they call `POST /secrets` with `{ciphertext, iv, wrappedContentKey, passphraseSalt, kdfIterations}`
- THEN the system MUST persist all supplied fields verbatim
- AND the system MUST NOT attempt to derive, validate, or store the passphrase itself

#### Scenario: Request containing plaintext-shaped fields is rejected

- GIVEN a client submits a body containing a `plaintext` or `passphrase` field
- WHEN `POST /secrets` is handled
- THEN the system MUST reject the request with a validation error and MUST NOT persist it

### Requirement: Content Size Limit

The system MUST enforce a maximum accepted `ciphertext` payload size of 64 KB (base64-encoded) per secret and MUST reject larger payloads without persisting them.

#### Scenario: Oversized ciphertext is rejected

- GIVEN a client submits `ciphertext` exceeding 64 KB
- WHEN `POST /secrets` is handled
- THEN the system MUST respond with a 413 or 400 validation error
- AND no row MUST be persisted

### Requirement: Public Reveal Fetch Without Burn

The system MUST expose an unauthenticated `GET /secrets/{token}` that returns the stored ciphertext blob (`ciphertext`, `iv`, and, if present, `wrappedContentKey`/`passphraseSalt`/`kdfIterations`) without changing the secret's status. Fetching MUST be idempotent and repeatable until the secret is burned or expires.

#### Scenario: Valid token returns ciphertext without burning

- GIVEN a secret exists with status `pending` and `expires_at` in the future
- WHEN an anonymous client calls `GET /secrets/{token}`
- THEN the system MUST return the ciphertext blob with a 200 response
- AND the secret's status MUST remain `pending` after the call
- AND a second identical `GET /secrets/{token}` MUST succeed the same way

#### Scenario: Unknown token returns 404

- GIVEN no secret exists for the given token
- WHEN `GET /secrets/{token}` is called
- THEN the system MUST respond 404

#### Scenario: Expired token returns 410

- GIVEN a secret's `expires_at` is in the past
- WHEN `GET /secrets/{token}` is called
- THEN the system MUST respond 410 Gone
- AND MUST NOT return the ciphertext body

#### Scenario: Already-burned token returns 410

- GIVEN a secret's status is `read`
- WHEN `GET /secrets/{token}` is called
- THEN the system MUST respond 410 Gone

### Requirement: Public Burn/Confirm As A Separate Call

The system MUST expose an unauthenticated `POST /secrets/{token}/burn` that marks a secret as read, distinct from and never triggered automatically by `GET /secrets/{token}`. Burn MUST be idempotent: repeated calls after the first successful burn MUST NOT error or change already-recorded `read_at`.

#### Scenario: Burn after successful local decrypt

- GIVEN a client fetched the ciphertext and successfully decrypted it locally
- WHEN it calls `POST /secrets/{token}/burn`
- THEN the system MUST set status to `read` and record `read_at`
- AND subsequent `GET /secrets/{token}` calls MUST return 410

#### Scenario: Wrong passphrase never burns the secret

- GIVEN a recipient enters an incorrect passphrase and the local AES-GCM decrypt fails
- WHEN no `POST /secrets/{token}/burn` call is made as a result
- THEN the secret's status MUST remain `pending` and it MUST remain fetchable until expiry

#### Scenario: Repeated burn is idempotent

- GIVEN a secret was already burned
- WHEN `POST /secrets/{token}/burn` is called again with the same token
- THEN the system MUST respond without error and MUST NOT change the original `read_at`

### Requirement: TTL Enforcement

The system MUST require a caller-independent `expires_at` on every secret, defaulting to 24 hours from creation and hard-capped at 7 days regardless of any client-requested value. `expires_at` MUST NOT be nullable.

#### Scenario: Default TTL applied when unspecified

- GIVEN a client creates a secret without specifying a TTL
- WHEN the row is persisted
- THEN `expires_at` MUST equal `created_at + 24h`

#### Scenario: Requested TTL beyond the cap is clamped

- GIVEN a client requests a TTL of 30 days
- WHEN the secret is created
- THEN `expires_at` MUST be clamped to `created_at + 7 days`

### Requirement: Rate Limiting On Public Secret Routes

The system MUST apply a per-IP rate limit of 30 requests per minute to `GET /secrets/{token}` and `POST /secrets/{token}/burn`, independently of each other. Requests over the limit MUST be rejected with 429 without touching secret state.

#### Scenario: Excess requests from one IP are throttled

- GIVEN one IP address has made 30 `GET /secrets/{token}` requests within the current minute
- WHEN it makes a 31st request within the same window
- THEN the system MUST respond 429 and MUST NOT read or return secret data

### Requirement: Extension Create And Read-Confirmation UI

The extension MUST provide a UI to create a secret (entering content and optional passphrase, generating a shareable link) and MUST surface a read-confirmation notification to the creator, persisted for retrieval on next popup open when no live delivery occurred.

#### Scenario: User creates a secret and receives a shareable link

- GIVEN a user opens the create-secret UI and enters content
- WHEN they submit the form
- THEN the extension MUST encrypt content locally, call `POST /secrets`, and display a shareable link containing the token (and content key in the fragment, if no passphrase)

#### Scenario: Creator sees read confirmation on next popup open

- GIVEN a creator's secret was burned while their extension had no live connection
- WHEN they next open the popup
- THEN the extension MUST display a read-confirmation notification pulled from persisted state
