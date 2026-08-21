# Proposal: Secret Sharing

## Intent

Users have no way to share a one-time secret (credential, token, note) with another account without sending plaintext through chat/email that then sits in history forever. Add a OneTimeSecret-style, zero-knowledge sharing flow: the extension encrypts client-side, the server stores only ciphertext it can never read, and the recipient's browser decrypts via a link. Fills a real gap — this codebase has no ephemeral, self-destructing sharing primitive today.

## Proposal Question Round

Automatic mode — no interactive round was possible this turn. Open items below are taken positions, explicitly flagged for confirmation before spec/design, not settled decisions:
1. TTL numbers — is 24h default / 7-day hard cap correct, or should product set different bounds?
2. Rate-limit thresholds — what request/IP/minute limits are acceptable for the new public GET/burn routes (no existing precedent in this codebase to anchor on)?
3. Offline recipient UX — is "persisted notification pulled on next popup open" (reusing `activitySignal`) sufficient, or is a stronger nudge (e.g. badge count) needed?
4. Content limits — is there a max secret size/length to enforce (encrypted blob storage cost, UX for huge pastes)?

## Scope

### In Scope
- `backend/internal/onetimesecrets/`: create (authenticated), public reveal-fetch (no burn), public burn/confirm (client-asserted), TTL expiry, `expires_at NOT NULL`.
- Client-side AES-256-GCM encryption; optional passphrase wraps the content key via PBKDF2-SHA256 (≥210,000 iterations, per-secret salt) — server never sees plaintext, key, or passphrase.
- New public admin-web route (`/s/:token`) — first unauthenticated resource-disclosure route in this codebase.
- Extension: create-secret UI + read-confirmation surfacing.
- `websocket.Hub` extended with a `byUser` index + `PublishToUser`, fired via the shipped `PostCommit` pattern on burn.
- Minimal IP-based rate limiting scoped to the new public secret routes (first of its kind in this backend).

### Out of Scope
- Argon2id/wasm KDF (PBKDF2 accepted as the OWASP-fallback tradeoff).
- Multi-read / non-burning secrets, secret editing, org-owned secrets.
- General-purpose rate-limiting middleware beyond the secret routes.
- Server-side passphrase verification (structurally impossible in zero-knowledge).

## Capabilities

### New Capabilities
- `secret-sharing`: zero-knowledge create/store/reveal/burn lifecycle across backend, admin-web reveal page, and extension crypto/UI.
- `websocket-user-notifications`: per-user `Hub` index and `PublishToUser`, extending the workspace-only Hub with user-identity routing.

### Modified Capabilities
- None (no prior specs exist for auth/websocket in `openspec/specs/`).

## Approach

Backend mirrors `organizations`' service/handler shape and reuses `generateInviteToken`'s `crypto/rand`(24B)/hex pattern. Reveal is a separate call from burn so a wrong passphrase (client-side GCM auth-tag failure) never consumes the read. Burn's `PostCommit` hook calls `Hub.PublishToUser` with a new `"secret_read"` frame; offline fallback reuses `activitySignal`/`recordActivity`.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `backend/internal/onetimesecrets/` | New | Service, handler, token/TTL logic |
| `backend/migrations/` | New | `secrets` table, `expires_at NOT NULL` |
| `backend/internal/websocket/hub.go` | Modified | `byUser` index, `PublishToUser` |
| `backend/internal/httpapi/` | New | IP rate-limit middleware (public routes only) |
| `admin-web/src/app/router.tsx`, `views/` | New | Public `/s/:token` reveal page |
| `extension/src/shared/`, `background/`, `popup/` | New/Modified | Crypto helper, create UI, read-confirmation pill |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Client-asserted burn lets anyone with the link burn before the recipient reads | High (by design) | Accepted risk, stated explicitly — matches real OneTimeSecret behavior |
| Fragment-key leakage (logging, referrers, history) | Medium | Design phase: hard rule never to log/transmit full URL with fragment |
| Hub change touches shared, tested infra (`hub_test.go`) | Medium | Additive `byUser` index alongside existing `byWorkspace`, keep tests green |
| No rate-limiting precedent to build on | Medium | Minimal scoped IP limiter, new but narrow surface |
| PBKDF2 weaker than Argon2id vs GPU attacks | Low | High iteration count; documented tradeoff, not silent |

## Rollback Plan

Feature is additive and isolated: drop the `secrets` migration, remove the route registrations in `main.go` and `router.tsx`, and revert the `Hub`/extension changes. No existing data model touched; `byUser` index is additive to `Hub` and safe to remove independently.

## Delivery Intent

Branch `feat/secret-sharing`; likely split into backend+migration, Hub/websocket, and extension+admin-web slices given the 400-line review budget. Depends on nothing merged; extends already-shipped `PostCommit`/`ExecutePrepared` and WebSocket infra.

## Success Criteria

- [ ] A user can create a secret in the extension and receive a shareable, zero-knowledge link (optionally passphrase-protected).
- [ ] Server storage never contains plaintext, content key, passphrase, or wrapping key.
- [ ] A wrong passphrase does not burn the secret; a successful decrypt does.
- [ ] Creator receives a read-confirmation via WebSocket (or on next popup open if offline).
- [ ] Unread secrets expire automatically; `expires_at` is never NULL.
