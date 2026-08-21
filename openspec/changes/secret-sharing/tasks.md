# Tasks: Secret Sharing

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 2,000–2,500 |
| 800-line session budget risk | High |
| 400-line reviewer-burden signal | High |
| Chained PRs recommended | Yes |
| Suggested split | 5 work units (see below) — unit 1 (~830 lines) was split into 1a/1b at the user's explicit request to keep every unit strictly under the 800-line budget |
| Delivery strategy | ask-on-risk (cached this session) — RESOLVED: user confirmed the split into 5 units |
| Chain strategy | feature-branch-chain — matches this project's established convention this session (each `feat/*` branch merged into `develop` in sequence); each unit branches off the previous unit's branch, PR'd and merged to `develop` before the next unit starts |

Decision needed before apply: No — resolved
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain (5 sequential branches off `develop`, each merged before the next starts)
400-line budget risk: High (mitigated by the 5-way split; largest unit ≈450 lines)

### Estimate basis

| File | Action | Est. lines |
|---|---|---|
| `backend/migrations/000010_secrets.sql` | Create | ~50 |
| `backend/internal/onetimesecrets/service.go` (+tests) | Create | ~180 + ~200 |
| `backend/internal/onetimesecrets/handler.go` (+tests) | Create | ~180 + ~150 |
| `backend/internal/httpapi/ratelimit.go` (+tests) | Create | ~100 + ~120 |
| `backend/internal/websocket/hub.go` (+tests) | Modify | ~70 + ~100 |
| `backend/internal/websocket/handler.go` | Modify | ~25 |
| `backend/cmd/api/main.go` | Modify | ~20 |
| integration test (`handler_integration_test.go` extension) | Modify | ~150 |
| `admin-web/src/app/router.tsx` | Modify | ~8 |
| `admin-web/src/app/views/SecretRevealPage.tsx` (+tests) | Create | ~180 + ~120 |
| `admin-web/src/lib/api/secrets.ts` | Create | ~50 |
| `admin-web/src/lib/crypto.ts` (+tests) | Create | ~130 + ~60 |
| `extension/src/shared/crypto.ts` (+tests) | Create | ~130 + ~150 |
| `extension/src/shared/websocket.ts` | Modify | ~20 |
| `extension/src/shared/api.ts` | Modify | ~30 |
| `extension/src/background/projection.ts` | Modify | ~60 |
| `extension/src/popup/popup.ts`, `popup.html` | Modify | ~150 |

### Suggested Work Units

| Unit | Goal | Branch | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|---|
| 1a | Backend foundation: migration + `secrets` service (token/TTL/Create/Reveal/Burn) | `feat/secret-sharing-backend-core` off `develop` | PR 1a | `cd backend && go test ./internal/onetimesecrets` | `docker compose up -d backend`; exercise `Service` via a Go test harness (no HTTP routes yet) | `backend/migrations/000010_secrets.sql`, `backend/internal/onetimesecrets/service.go`(+test) |
| 1b | Backend handler: `onetimesecrets.Handler` (field allow-list, content limit, status mapping) + rate-limit middleware | `feat/secret-sharing-backend-api` off `feat/secret-sharing-backend-core` | PR 1b, base = 1a | `cd backend && go test ./internal/onetimesecrets ./internal/httpapi` | `docker compose up -d backend`; `curl -X POST http://localhost:8080/secrets` with a session cookie, then `GET`/`burn` the returned token | `backend/internal/onetimesecrets/handler.go`(+test), `backend/internal/httpapi/ratelimit.go`(+test) |
| 2 | `websocket.Hub` `byUser`/`PublishToUser`, `Subscribe` signature change, `main.go` composition wiring (real notifier into `onetimesecrets.RegisterRoutes`) | `feat/secret-sharing-websocket` off `feat/secret-sharing-backend-api` | PR 2, base = 1b | `cd backend && go test ./internal/websocket ./internal/onetimesecrets -run Integration` | `docker compose up -d`; open two extension popups as the same user, burn a secret via `curl`, confirm both sockets receive `secret_read` | `backend/internal/websocket/{hub.go,handler.go}`, `backend/cmd/api/main.go` |
| 3 | Admin-web public reveal: `/s/:token` route, `SecretRevealPage`, `lib/crypto.ts`, `lib/api/secrets.ts` | `feat/secret-sharing-admin-web` off `feat/secret-sharing-websocket` | PR 3, base = 2 | `cd admin-web && npm test -- SecretRevealPage crypto` | `npm run dev`; open `/s/:token` for a secret created via `curl`, confirm decrypt+burn end to end | `admin-web/src/{app/router.tsx,app/views/SecretRevealPage.tsx,lib/crypto.ts,lib/api/secrets.ts}` |
| 4 | Extension: `shared/crypto.ts`, `shared/websocket.ts` `onSecretRead`, `shared/api.ts` `createSecret`, `background/projection.ts`, popup create/read-confirmation UI | `feat/secret-sharing-extension` off `feat/secret-sharing-admin-web` | PR 4, base = 3 | `cd extension && npm test -- crypto projection` | load unpacked extension, create a secret, open the `/s/:token` link in another profile, confirm the popup shows the read confirmation | `extension/src/{shared/crypto.ts,shared/websocket.ts,shared/api.ts,background/projection.ts,popup/}` |

Each unit is developed, tested, and merged into `develop` before the next unit's branch is created — matching this session's established branch/merge pattern. Every unit now estimates under 450 lines, comfortably inside the 800-line budget.

## Phase 1: Backend Foundation — Migration & Secrets Service

- [x] 1.1 `backend/migrations/000010_secrets.sql` — create `secrets` table: `id`, `user_id` (creator, FK), `token` (unique), `ciphertext`, `iv`, `wrapped_content_key BYTEA` (nullable), `passphrase_salt` (nullable), `kdf_iterations` (nullable), `status` (`pending`/`read`), `created_at`, `expires_at NOT NULL`, `read_at` (nullable); indexes on `user_id` and `(status, expires_at)`.
- [x] 1.2 RED: `backend/internal/onetimesecrets/service_test.go` — default TTL (`expires_at == created_at + 24h`) when unspecified; requested TTL clamped to 7 days; `generateToken` produces 24B/hex tokens mirroring `generateInviteToken`; `Reveal` returns the blob without mutating `status`; `Reveal` on unknown/expired/already-read token maps to a distinguishable not-found/gone error.
- [x] 1.3 RED: same file — `Burn` sets `status='read'`+`read_at` and returns the creator's `user_id`; repeated `Burn` after first success is a no-op returning the original `read_at` (idempotent, does not re-trigger notify per the design's `alreadyRead` return).
- [x] 1.4 GREEN: `backend/internal/onetimesecrets/service.go` — `Service` wrapping `*pgxpool.Pool`; `generateToken` (24B `crypto/rand`/hex); `Create(ctx, userID, input) (Secret, error)` (24h default / 7d hard cap TTL clamp); `Reveal(ctx, token) (SecretBlob, error)`; `Burn(ctx, token) (creatorUserID string, alreadyRead bool, error)` using `SELECT ... FOR UPDATE` inside a tx.

## Phase 2: Backend Handler — Validation, Field Allow-List, Content Limit

- [x] 2.1 RED: `backend/internal/onetimesecrets/handler_test.go` — `POST /secrets` rejects a body containing `plaintext` or `passphrase` fields (400, no row persisted); rejects `ciphertext` over 64KB base64 (400, checked before further unmarshal); persists `wrappedContentKey`/`passphraseSalt`/`kdfIterations` verbatim when supplied.
- [x] 2.2 RED: same file — `GET /secrets/{token}` returns 200+blob and leaves `status` unchanged, repeatable; unknown token → 404; expired token → 410 with no ciphertext body; already-read token → 410.
- [x] 2.3 RED: same file — `POST /secrets/{token}/burn` after fetch sets `status='read'`; a repeated burn call responds without error and does not change the original `read_at`.
- [x] 2.4 GREEN: `backend/internal/onetimesecrets/handler.go` — `RegisterRoutes(mux, authMiddleware, routeService, notifier secretReadNotifier)`; `POST /secrets` behind `authMiddleware`; unauthenticated `GET /secrets/{token}` and `POST /secrets/{token}/burn`; decode into `map[string]json.RawMessage` first, reject any key outside `{ciphertext,iv,wrappedContentKey,passphraseSalt,kdfIterations,ttlSeconds}` with 400; check raw base64 `ciphertext` length against 64KB before further unmarshalling; map service errors to 404/410/429 per status.
- [x] 2.5 GREEN: same file — after `Burn` succeeds and `!alreadyRead`, `httpapi.WriteJSON(w, 200, ...)` → `http.NewResponseController(w).Flush()` → `notifier.NotifySecretRead(context.WithoutCancel(ctx), creatorUserID, secretID)` (unexported `secretReadNotifier` port, matching the `invitationNotifier` shape).

## Phase 3: Rate Limiting Middleware

- [x] 3.1 RED: `backend/internal/httpapi/ratelimit_test.go` — 30 requests/minute from one IP allowed, 31st denied (429) with a fake clock; independent buckets per IP; a request over the limit does not touch secret state (asserted at the middleware layer via a spy handler).
- [x] 3.2 RED: same file — `ClientIP(r)` returns the first `X-Forwarded-For` entry when present, else `SplitHostPort(r.RemoteAddr)`.
- [x] 3.3 GREEN: `backend/internal/httpapi/ratelimit.go` — `IPRateLimiter{buckets map[string]*bucket, mu sync.Mutex}`, `bucket{tokens float64, lastRefill time.Time}`, capacity 30, refill 0.5 tok/s, lazy per-request refill, opportunistic eviction of entries idle > 2 minutes; `ClientIP(r *http.Request) string` helper; wrap `GET /secrets/{token}` and `POST /secrets/{token}/burn` in this middleware in `onetimesecrets.RegisterRoutes` (2.4).

## Phase 4: WebSocket Hub — Per-User Index and PublishToUser

- [x] 4.1 RED: `backend/internal/websocket/hub_test.go` — `Subscribe(workspaceID, userID, clientID)` populates `byUser[userID]` alongside the existing `byWorkspace`; closing a subscription removes it from both indexes with no stale entries; a user with two open workspace sockets has two entries in `byUser`.
- [x] 4.2 RED: same file — `PublishToUser` delivers to all of a user's open sockets across workspaces; is a no-op (no error, no delivery attempt) when the user has no open subscription; does not deliver to another user's sockets.
- [x] 4.3 GREEN: `backend/internal/websocket/hub.go` — add `byUser` index; add `Notifications chan any` field on `Subscription` (new channel, `Messages`/`byWorkspace`/`Publish` untouched); `Subscribe(workspaceID, userID, clientID string) *Subscription` signature change; `PublishToUser(ctx context.Context, userID string, message any) error`.
- [x] 4.4 GREEN: `backend/internal/websocket/handler.go` — pass `principal.UserID` into `Subscribe`; add a `case msg := <-subscription.Notifications: connection.WriteJSON(msg)` branch to the read loop (raw frame, no `{"type":"event",...}` wrapper).
- [x] 4.5 RED: `backend/internal/onetimesecrets/hub_integration_test.go` (new) — full create→reveal→burn flow asserts a real `*websocket.Hub`'s `Notifications` channel receives a `{"type":"secret_read","secretId":...,"readAt":...}` frame for the creator and `hub_test.go`'s existing `Messages`/`byWorkspace` behavior is untouched.
- [x] 4.6 GREEN: satisfy 4.5 by wiring `*websocket.Hub` as the `secretReadNotifier` implementation (`NotifySecretRead` → `PublishToUser`) and confirming the assertions pass.

## Phase 5: Backend Composition Wiring

- [x] 5.1 `backend/cmd/api/main.go` — construct `onetimesecrets.NewService(pool)` and call `onetimesecrets.RegisterRoutes(mux, authMiddleware, secretsService, hubSecretReadNotifierAdapter{hub: websocketHub})` after `websocketHub` is constructed (real notifier, not a stub). The IP rate limiter is constructed internally by `onetimesecrets.RegisterRoutes` itself (Phase 3.3), so no separate `httpapi.NewIPRateLimiter` call is needed in `main.go`.

## Phase 6: Admin-web — Crypto Helper and Reveal Page

- [ ] 6.1 RED: `admin-web/src/lib/crypto.test.ts` — AES-256-GCM `encrypt`/`decrypt` round-trip; `deriveWrappingKey` PBKDF2-SHA256 with >= 210,000 iterations and per-call salt; wrong passphrase produces a decrypt failure (GCM auth-tag mismatch), not silent garbage.
- [ ] 6.2 GREEN: `admin-web/src/lib/crypto.ts` — `generateContentKey`, `encrypt`, `decrypt`, `deriveWrappingKey`, `wrapKey`, `unwrapKey`, base64 helpers, matching the wire format `base64(iv(12B) || gcmCiphertext)` for `wrappedContentKey`.
- [ ] 6.3 `admin-web/src/lib/api/secrets.ts` — `getSecret(token)`, `burnSecret(token)` via `apiRequest` calls with no `token`/session option (unauthenticated).
- [ ] 6.4 RED: `admin-web/src/app/views/SecretRevealPage.test.tsx` — the fetch URL is always the literal `` `/secrets/${token}` `` string, never built from `window.location.href`; the fragment/hash is never passed to `fetch`, `console.*`, or any logger; a wrong passphrase leaves the page in `pending` state and never calls burn.
- [ ] 6.5 RED: same file — successful local decrypt calls `burnSecret` exactly once; a second render/mount does not re-burn; 404/410 responses render distinct "not found"/"already read or expired" copy.
- [ ] 6.6 GREEN: create `admin-web/src/app/views/SecretRevealPage.tsx` — no `useAuth()`; `useParams().token` for the fetch path; reads `window.location.hash` separately, only after decrypt setup; passphrase input when `wrappedContentKey` is present; calls `burnSecret` only after a successful local decrypt.
- [ ] 6.7 `admin-web/src/app/router.tsx` — register `{ path: "/s/:token", element: <SecretRevealPage /> }` as a top-level route outside `RequireSession`, sibling of `/login`.

## Phase 7: Extension — Crypto Helper, Create UI, Read Confirmation

- [ ] 7.1 RED: `extension/tests/crypto.test.mjs` (or vitest equivalent) — same round-trip/PBKDF2/wrong-passphrase cases as 6.1, confirming wire-format parity with `admin-web/src/lib/crypto.ts`.
- [ ] 7.2 GREEN: `extension/src/shared/crypto.ts` — same helper set as 6.2 (`generateContentKey`, `encrypt`, `decrypt`, `deriveWrappingKey`, `wrapKey`, `unwrapKey`, base64 helpers).
- [ ] 7.3 `extension/src/shared/api.ts` — add `createSecret(backendUrl, session, input)` following the existing `createBookmark`-style call shape.
- [ ] 7.4 RED: `extension/tests/projection-behavior.test.mjs` — a `type === "secret_read"` frame dispatches to a new `onSecretRead` callback only, never to `onEvent`; the frame's `secretId` is used to look up the locally-persisted `{id, token, createdAt}` record.
- [ ] 7.5 GREEN: `extension/src/shared/websocket.ts` — add an `onSecretRead` callback option, branch on `type === "secret_read"` before the existing `onEvent`/`ack`/`resync_required` handling.
- [ ] 7.6 GREEN: `extension/src/background/projection.ts` — wire the `onSecretRead` handler to persist a read-confirmation notification (activitySignal-style, via `extension/src/shared/storage.ts`), keyed off the locally-persisted secret record from creation.
- [ ] 7.7 RED: `extension/tests/status-ui.test.mjs` (or popup equivalent) — an offline-created read confirmation is rendered as a distinct pill on next popup open and is cleared (does not resurface) once acknowledged.
- [ ] 7.8 GREEN: `extension/src/popup/popup.ts`, `extension/src/popup/popup.html` — create-secret form (content + optional passphrase), on submit: `crypto.ts` generate/encrypt (and wrap if passphrase set) → `api.ts createSecret` → render shareable link (`{PUBLIC_BASE_URL}/s/{token}[#k=...]`), persist `{id, token, createdAt}` locally; render/clear the read-confirmation pill from persisted state.

## Phase 8: Verification

- [ ] 8.1 `cd backend && go test ./internal/onetimesecrets ./internal/httpapi ./internal/websocket ./...` — full backend suite green.
- [ ] 8.2 `cd admin-web && npm test` — full suite green, including `SecretRevealPage.test.tsx` and `crypto.test.ts`.
- [ ] 8.3 `cd extension && npm test` — full suite green, including crypto round-trip and `secret_read` dispatch tests.
- [ ] 8.4 Manual: `docker compose up`, create a secret in the extension (with and without passphrase), open `/s/{token}` in another browser profile, confirm reveal-then-burn and the creator's read-confirmation (live socket and, separately, next-popup-open fallback with the socket closed).

## Phase 9: Review and Rollback

- [ ] 9.1 Chain strategy resolved: `feature-branch-chain`, 5 sequential branches (1a → 1b → 2 → 3 → 4) off `develop`, each unit merged before the next starts.
- [ ] 9.2 Confirm rollback: dropping `000010_secrets.sql`, removing `onetimesecrets.RegisterRoutes`/router entries in `main.go`/`router.tsx`, and reverting `Hub`'s additive `byUser`/`Notifications`/`PublishToUser` fields leaves `hub_test.go` and all existing workspace-sync behavior unaffected (no existing data model touched).
