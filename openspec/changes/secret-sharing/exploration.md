## Exploration: secret-sharing

### Current State

**1. Auth model and public-route precedent — there is no fully public, unauthenticated, token-addressed resource route in this codebase today.**

`auth.Principal{UserID, Email, Name, ClientID}` (`backend/internal/auth/service.go:74-79`) is the authenticated identity, produced by `AuthenticateToken` (`service.go:356-395`) from an HS256 JWT (`tokenClaims{ClientID, jwt.RegisteredClaims}`, `service.go:113-116`) and injected into request context via `Service.Middleware` (`backend/internal/auth/middleware.go:15`) / read back with `PrincipalFromContext` (`middleware.go:34`).

Every `mux.Handle`/`mux.HandleFunc` call across `backend/internal` (organizations, bookmarks, auth, websocket, sync, groups, workspaces) was enumerated. Only these are unauthenticated:
- `GET /setup/status` (`auth/handler.go:20`) — public, but returns only a boolean, no resource lookup.
- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` (`auth/handler.go:30,56,82,99`) — public, but identity-creation/exchange endpoints, not token-addressed resource fetches.

Every other route — including `POST /invitations/{token}/accept` (`auth/handler.go:179`) — is wrapped in `service.Middleware(...)` and requires a valid `Principal` (`handler.go:180-184`, 401 via `httpapi.WriteError` if absent). `GET /sync/ws` (`websocket/handler.go:27-38`) also authenticates via `authenticateWebsocket` (ticket-subprotocol or bearer token, `handler.go:90-117`) before upgrading. So the invitation-accept endpoint is **not** an example of "looked up by unguessable token alone" — it's auth-gated identically to every other mutating route; the token only narrows *which* invitation, not *whether* auth is required.

**Conclusion: a public, unauthenticated `GET /secrets/{token}` (and its reveal counterpart) would be the first route of its kind in this codebase.** There is no existing pattern to imitate for "public token-addressed read" — this is new surface and should be treated with proportionate scrutiny (see Risks).

**2. Invitation flow precedent — the frontend route is public, the backend action is not; and the `PostCommit` pattern this feature would reuse is already shipped.**

`admin-web/src/app/router.tsx:73-75` registers `/invitations/:token` → `InvitationAcceptPage` as a top-level route sibling to `/login`, outside `RequireSession` — the *page* is reachable anonymously. But `InvitationAcceptPage` (`admin-web/src/app/views/InvitationAcceptPage.tsx:66-80`) only calls the backend once `status === "authenticated"`; if anonymous it redirects to `/login?invitation={token}` or `/register?invitation={token}` first. The actual call, `acceptInvitation` (`admin-web/src/lib/api/invitations.ts:4-9`), hits `POST /invitations/{token}/accept` with a bearer token — still gated by `service.Middleware`. **No backend endpoint discloses invitation content to an unauthenticated caller.** This is the key structural difference from secret-sharing: a public reveal page for secrets *must* disclose ciphertext to an unauthenticated caller by design (zero-knowledge means the server can only gate on the token/passphrase, not identity) — this codebase has never done that before.

Token generation precedent, `backend/internal/organizations/service.go:916-923`:
```go
func generateInviteToken() (string, error) {
    buffer := make([]byte, 24)
    if _, err := rand.Read(buffer); err != nil { ... }
    return hex.EncodeToString(buffer), nil
}
```
`crypto/rand` (confirmed via import block, `service.go:5`), 24 bytes = 192 bits, hex-encoded to 48 chars — directly reusable for secret tokens.

The `httpapi.IdempotencyExecutor.ExecutePrepared` → `PostCommit` mechanism is now implemented and live: `organizations/handler.go:140-188` builds a `PostCommit` hook (`:174-178`) calling `notifier.NotifyInvitation(...)` only after the transaction commits — best-effort, logged, never blocks/rolls back the primary write. `main.go:69-70,117` shows the composition-root wiring. This is a proven precedent to reuse for the read-confirmation notification: after a reveal is durably recorded, a `PostCommit` hook publishes a WebSocket event to the creator.

`config.PublicBaseURL` already exists (`backend/internal/config/config.go:24,207`, env `PUBLIC_BASE_URL`) — reusable as-is for building reveal links; no new base-URL config needed.

**3. WebSocket infrastructure — the Hub is fundamentally workspace-scoped, with no user identity in its data model. This is the single most important finding.**

`backend/internal/websocket/hub.go`:
```go
type Hub struct {
    mu            stdsync.RWMutex
    subscriptions map[string]map[*Subscription]struct{}   // keyed by workspaceID
}
type Subscription struct {
    WorkspaceID string
    ClientID    string   // device ID, not user ID
    Messages    chan syncapi.Envelope
    hub         *Hub
}
func (h *Hub) Subscribe(workspaceID, clientID string) *Subscription { ... }  // no userID param
func (h *Hub) Publish(_ context.Context, event syncapi.Envelope) error {
    for subscription := range h.subscriptions[event.WorkspaceID] { ... }   // routes strictly by WorkspaceID
}
```
`websocket/handler.go:55` calls `hub.Subscribe(workspaceID, principal.ClientID)` — `principal.UserID` is available at that point (line 34-38) but never passed. `syncapi.Envelope` (`backend/internal/sync/types.go:27-37`) requires `WorkspaceID` to route at all; there is no `UserID` field on the envelope either.

Client-side, `extension/src/shared/websocket.ts:14-19` (`connectWorkspaceSocket`) opens one socket **per workspace**, and `extension/src/background/projection.ts:69` (`socketClosers = new Map<string, () => void>()`) keys open connections by `workspaceId` — a user with N synced workspaces holds N independent, workspace-scoped connections, none carrying user identity server-side.

**Direct answer**: no, an existing connection cannot carry a message to "the same user across all connections regardless of workspace" today — not a message-shape limitation, but because the Hub has no concept of user identity to route by. Reusing the WebSocket infra is still the right call, but requires a moderate, additive extension:
1. Add `UserID` to `Subscription` (free — `handler.go:34` already resolves `principal` before calling `Subscribe`).
2. Add a second index to `Hub`, `byUser map[string]map[*Subscription]struct{}`, populated/cleaned alongside `byWorkspace`.
3. Add `Hub.PublishToUser(ctx, userID string, message any)` delivering a differently-shaped message than `syncapi.Envelope` (a secret-read notification isn't a bookmark-sync event — forcing it into `Envelope` would be a semantic misuse). Client-side `onEvent` (`shared/websocket.ts:61-79`) already discriminates on a `payload.type` field (`"ack"`, `"event"`, `"resync_required"`), so a new frame type (`"secret_read"`) on the same socket is a natural, low-risk extension — no new socket, no new auth path. If no workspace socket is open, fall back to a persisted/pulled notification on next popup open (see point 4).

**4. Extension popup/background architecture — the activity-signal/revision pattern is the exact precedent to reuse for read-confirmation surfacing.**

`extension/src/background/service-worker.ts:37-83` is the single `chrome.runtime.onMessage` dispatcher; popup communicates via `sendMessage<T>()` (`extension/src/popup/popup.ts:168-179`) issuing typed messages resolved against persisted `ExtensionState`.

The "New updates" pill is driven by `activitySignal: {revision, lastSeenRevision}` (`projection.ts:825-832`, `ensureActivitySignal`) and `recordActivity()` (`projection.ts:1713-1740`), called whenever a remote sync event is applied. `popup.ts:138-146` (`acknowledgeActivityIfNeeded`) compares revisions, renders the pill, and fires `"ui/mark-activity-seen"` to clear it (`projection.ts:208-215`).

Directly reusable for "background detects an event, surfaces it to the popup, user acknowledges it": a secret-read confirmation can be its own signal (or folded into `activitySignal` with a `kind` discriminator), populated by a new `"secret_read"` WebSocket frame handler in `projection.ts`, rendered as a distinct pill/toast, cleared via the same acknowledge round-trip. No new IPC mechanism needed.

**5. Crypto capability — Web Crypto is already used raw, but only for hashing. This is genuinely new capability on a proven-safe substrate.**

Exactly one `crypto.subtle` usage repo-wide: `extension/src/background/projection.ts:397`, `crypto.subtle.digest("SHA-256", ...)` inside `opaqueLocalIntentEventId` — called raw with no wrapper, confirming `crypto.subtle` works fine in this MV3 service-worker context. `admin-web` has zero `crypto.subtle` usage. Neither codebase has ever used `encrypt`/`decrypt`/`deriveKey`/`generateKey`/`importKey`. No MV3 constraint blocks this (service workers support `crypto.subtle` fully).

**6. Migration/schema conventions.**

`backend/migrations/000001_initial_schema.sql` establishes the dominant FK convention: `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE` wherever a row is owned by a user with no independent lifecycle need (`devices:71`, `workspace_members:40`, `sync_events:89`). `000002_admin_backend_foundation.sql` shows the deliberate exception: `invitations.invited_by_user_id` uses `ON DELETE RESTRICT` (provenance must survive), `accepted_by_user_id` uses `ON DELETE SET NULL` (secondary/optional). A `secrets.user_id` column matches `devices.user_id` semantics — **`ON DELETE CASCADE` is the precedent-matching choice**.

`000009_user_ui_theme.sql` is a minimal, single-purpose migration template (additive `ALTER TABLE`, explicit `CHECK`, rollback-safety comment).

`invitations.expires_at` is nullable with no default (`000002...sql:25`) — invitations can silently never expire. The `secrets` table must not repeat this, given TTL is a hard requirement here.

**7. Rate limiting / abuse protection — none exists anywhere, and a server-side "passphrase-check" endpoint doesn't actually fit a genuine zero-knowledge design.**

Repo-wide grep for `rate.?limit|throttle|backoff|lockout|failedAttempts|attempt_count` across `backend/` returned zero matches. `backend/internal/httpapi/` has no rate-limiting middleware at any layer, including `/auth/login`.

In a true zero-knowledge design the server can never validate a passphrase (it never has the plaintext key to compare against) — passphrase verification has to happen 100% client-side (AES-GCM's auth tag fails cleanly on a wrong unwrap key). The actual abuse surfaces are narrower: (a) brute-forcing the 192-bit token on the public `GET /secrets/{token}` (infeasible given the entropy); (b) unlimited anonymous fetches of ciphertext without burning (low risk alone, but worth basic IP throttling against scraping/enumeration); (c) unlimited calls to the burn/confirm-read endpoint — since burn is necessarily a client-asserted event in zero-knowledge, anyone holding the token can burn a secret early. This last point is an inherent property of link-based one-time-secret sharing (true of this class of self-destructing link-based secret-sharing tools in general), not a defect this change introduces, but should be named explicitly as an accepted risk. Given zero existing rate-limiting infra, this change is a reasonable place to introduce a minimal, scoped IP-based limiter applied only to the new public secret routes.

### Affected Areas

- `backend/internal/secrets/` (new package) — service + handler, mirroring `organizations`' shape.
- `backend/migrations/0000XX_secrets.sql` (new) — `secrets` table: `id UUID PK`, `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `token TEXT NOT NULL UNIQUE` (same `crypto/rand` 24-byte-hex generation as `generateInviteToken`), `ciphertext BYTEA NOT NULL`, `iv BYTEA NOT NULL`, `passphrase_salt BYTEA` (nullable, passphrase mode only), `kdf_iterations INTEGER` (nullable, paired with salt), `status TEXT NOT NULL CHECK (status IN ('pending','read','expired')) DEFAULT 'pending'`, `expires_at TIMESTAMPTZ NOT NULL` (deliberately `NOT NULL`, unlike `invitations.expires_at`), `read_at TIMESTAMPTZ`, `created_at`/`updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; indexes on `user_id` and `(status, expires_at)` for a TTL sweep.
- `backend/internal/httpapi/` — new minimal rate-limit middleware, applied only to the new public secret routes.
- `backend/internal/websocket/hub.go` — new `byUser` index and `PublishToUser` method alongside `byWorkspace`; `Subscribe` needs a `userID` parameter.
- `backend/internal/websocket/handler.go:55` — pass `principal.UserID` to `Subscribe` once its signature changes.
- `backend/internal/config/config.go` — `cfg.App.PublicBaseURL` reusable as-is; a TTL-bounds config (min/max/default) would be new.
- `backend/cmd/api/main.go` — wire `secrets.NewService(pool)`, `secrets.RegisterRoutes(...)` (public reveal/burn routes, authenticated create route), and the shared `websocketHub` for the `PostCommit` read-confirmation hook — mirrors the existing invitation-notifier wiring at `main.go:69-70,116-122`.
- `admin-web/src/app/router.tsx` — new fully public route (e.g. `/s/:token`), outside `RequireSession`, not gated by an auth redirect like `/invitations/:token`.
- `admin-web/src/app/views/` — new `SecretRevealPage.tsx` (closest analog: `InvitationAcceptPage.tsx`'s shell/`DataState`, but must NOT require `useAuth()`).
- `admin-web/src/lib/api/secrets.ts` (new) — public fetch/burn calls, no bearer token.
- `extension/src/background/projection.ts` — new WebSocket frame handler for `"secret_read"`, plus an activity-style signal for it.
- `extension/src/popup/popup.ts`, `popup.html` — UI to create a secret (new message type, e.g. `"secrets/create"`) and render the read-confirmation pill, following `acknowledgeActivityIfNeeded`/`createIndicator`.
- `extension/src/shared/` — new crypto helper module (AES-GCM + PBKDF2 wrapper around `crypto.subtle`) — genuinely new, not an extension of the single existing `digest()` call.
- `extension/manifest.json` — no change needed; `host_permissions` already cover the backend origin.

### Approaches

**A. Zero-knowledge crypto scheme**

1. **AES-256-GCM content key in the URL fragment, optionally wrapped by a PBKDF2-derived passphrase key (recommended)** — client always generates a random 256-bit `contentKey`, encrypts the secret with AES-GCM. No passphrase: `contentKey` goes into the fragment (`#k=...`), never sent to the server. Passphrase set: derive `wrappingKey = PBKDF2-SHA256(passphrase, random 16B salt, 210,000 iterations)` via `crypto.subtle.deriveKey`, use it to AES-GCM-wrap `contentKey`; store only `{ciphertext, wrappedContentKey, salt, iterations}` server-side — fragment carries nothing in this mode. On reveal: fetch the blob (does not burn), attempt local unwrap/decrypt; GCM's auth tag fails cleanly and silently on a wrong passphrase, no network round-trip needed to "check" it — server never involved in passphrase verification. Only after a successful local decrypt does the client call a separate burn/confirm endpoint.
   - Pros: both primitives native to Web Crypto (no wasm/Argon2 dependency); naturally satisfies "wrong passphrase must not burn the read" since burn is decoupled from fetch; server genuinely never sees plaintext, key, passphrase, or wrapping key.
   - Cons: burn becomes a client-asserted event (anyone holding the token can burn without decrypting, exactly as in this class of self-destructing link-based secret-sharing tools); PBKDF2 is weaker than Argon2id against GPU attacks, so a high iteration count and passphrase-strength UX guidance matters.
   - Effort: Medium.

2. **Passphrase directly derives the content key (no separate random key/wrap step)** — skip the random `contentKey`; when a passphrase is set, `contentKey = PBKDF2(passphrase, salt)` directly.
   - Pros: simpler data model.
   - Cons: passphrase becomes mandatory whenever set (no link-only fallback for the same secret); weaker default security posture for weak/short passphrases.
   - Effort: Low.

3. **Argon2id via a wasm library for passphrase KDF instead of PBKDF2.**
   - Pros: meaningfully better brute-force resistance.
   - Cons: new wasm dependency in both `extension` and `admin-web` (MV3 service-worker wasm loading has its own CSP/packaging constraints), meaningfully larger scope; native PBKDF2 with a strong iteration count is still an accepted OWASP fallback.
   - Effort: High.

**B. Read-confirmation delivery (WebSocket)**

1. **Extend `Hub` with a parallel per-user index (`byUser`) and a `PublishToUser` method, reusing the same connection/protocol (recommended)** — add `UserID` to `Subscription`, populate a second map alongside `byWorkspace`, deliver a new `"secret_read"` frame over whichever workspace socket(s) the user has open.
   - Pros: reuses existing ticket-auth, connection-management, and client-side dispatch almost entirely; smallest structural change; extension's discriminated-union message handling extends naturally.
   - Cons: delivery only live if a workspace socket is open; needs a fallback (persisted notification pulled via `session/get` on next popup open) for the offline case.
   - Effort: Medium.

2. **Stand up a second, parallel per-user WebSocket channel independent of workspace sync.**
   - Pros: fully decoupled from bookmark-sync semantics.
   - Cons: duplicates connection-management/ticket-auth/reconnect logic that already exists and works; doubles open sockets per user; contradicts the instruction to reuse existing infra.
   - Effort: High.

3. **No push at all — poll for read-confirmation status on popup open.**
   - Pros: trivial.
   - Cons: explicitly rejected by the product decision to reuse WebSocket infra, not polling.
   - Effort: Low (out of scope per constraints).

### Recommendation

**Crypto scheme**: A.1 — random AES-256-GCM `contentKey` always generated client-side; no-passphrase mode puts it in the URL fragment; passphrase mode wraps it via a PBKDF2-SHA256-derived key (≥210,000 iterations, per-secret random 16-byte salt) and stores only the wrapped key server-side. Burn is decoupled from fetch and triggered only after a client-confirmed successful local unwrap/decrypt — the only way to honestly satisfy "wrong passphrase must not burn the read" when the server never sees the key.

**WebSocket delivery**: B.1 — extend `Hub` with a `byUser` index and `PublishToUser`, fired from a `PostCommit` hook on the burn/confirm-read transaction, mirroring the shipped `ExecutePrepared`/`PostCommit` pattern used for invitation emails. Fall back to persisted/polled state on next popup open for users with no live socket, reusing the `activitySignal`/`recordActivity` precedent.

**Default TTL**: 24 hours, hard-capped server-side regardless of client-requested value (max 7 days, matching this codebase's existing TTL culture from invitations), with `secrets.expires_at` set `NOT NULL` at creation — learning directly from the `invitations.expires_at`-always-`NULL` gap. Justification: this feature is for ephemeral credential/text sharing, not public link distribution, so a short default minimizes ciphertext-at-rest exposure; 24h is generous enough for cross-timezone recipients without drifting toward "long-lived storage." This is a recommendation for the proposal/product owner to confirm, not a settled decision.

**New public-route surface**: this is the first fully unauthenticated, token-addressed resource route in the codebase — pair it with the new minimal rate-limiting middleware, scoped only to the public secret routes.

### Risks

- The Hub's `Publish`/`Subscribe` are hard-wired to `WorkspaceID` with zero user-identity concept — extending it is a real code change to shared, already-tested infrastructure (`hub_test.go`, `handler_integration_test.go` exist and must keep passing), not a config toggle.
- Burn/confirm-read is unavoidably a client-asserted event in a genuine zero-knowledge design — anyone holding the token can burn a secret before the intended recipient decrypts it. Mirrors the standard behavior of this class of self-destructing link-based secret-sharing tools; not a regression this change introduces, but must be stated explicitly as an accepted risk.
- This backend has zero rate-limiting infrastructure anywhere — the new public GET/burn routes are the first genuinely public resource-fetch surface, making this an unusually important place to add at least minimal IP-based throttling, which is new infrastructure this change must build.
- Fragment-key leakage is an implementation-discipline risk: accidental logging of `location.href` (browser history, analytics, `console.log`, error reporters, referrer headers) could leak the decryption key. Design phase must call out "never log or transmit the full URL with fragment" as a hard rule for both the extension's link-creation surface and admin-web's reveal page.
- PBKDF2 (native, no new dependency) is chosen over Argon2id (would require a new wasm dependency in both `extension` and `admin-web`) — a deliberate strength-vs-scope tradeoff to name in the proposal.
- `secrets.user_id ON DELETE CASCADE` means deleting a user account silently destroys their unread secrets with no grace period — acceptable (mirrors existing account-deletion behavior elsewhere), worth one sentence in the proposal so it's a stated decision.
- The extension's popup/background architecture has no existing "no active workspace socket" fallback UX for a live push notification — needs an explicit decision on how read-confirmation surfaces for users who aren't actively syncing (persisted state read on next popup open is the natural fit, reusing `session/get`, but needs to be designed, not assumed).

### Ready for Proposal

Yes — all seven investigation areas are answered with concrete file/line evidence, the WebSocket per-user-vs-per-workspace question has a definitive, code-backed answer (Hub is workspace-only; extending it with a `byUser` index is the right, moderate-effort path), a specific crypto scheme is recommended with exact native Web Crypto primitives, and a default TTL (24h, `NOT NULL`, hard-capped) is recommended with justification. Two things should be explicitly confirmed/decided at proposal or design stage rather than assumed: (1) the exact offline-notification fallback UX for read-confirmation when no workspace socket is open, and (2) the TTL default/cap values themselves (24h/7d are a recommendation, not a mandate from product decisions already made).
