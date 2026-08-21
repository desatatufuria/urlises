# Design: Secret Sharing

## Technical Approach

`backend/internal/secrethide` mirrors `organizations`' service/handler shape: `Service` wraps `*pgxpool.Pool`, `RegisterRoutes` takes `authMiddleware`, a `routeService`, and a `secretReadNotifier` port (unexported, matching `invitationNotifier`). `POST /secrets` runs behind `service.Middleware`; `GET /secrets/{token}` and `POST /secrets/{token}/burn` are unauthenticated and wrapped in a new `httpapi` IP rate limiter. Reveal and burn are separate DB operations so a failed client-side unwrap never touches `status`. Burn's own `Service.Burn` transaction commits, then the handler flushes the 200 response and calls `Hub.PublishToUser` — the same commit-then-notify ordering as invitation email, hand-rolled instead of via `IdempotencyExecutor.ExecutePrepared` because burn has no `Principal`/`Idempotency-Key` to build an `IdempotencyScope` from. `websocket.Hub` gains a `byUser` index and a second per-subscription channel so user-notifications never masquerade as `syncapi.Envelope`.

## Architecture Decisions

| Decision | Options / tradeoff | Choice and rationale |
|---|---|---|
| `wrappedContentKey` wire/storage format | Separate `wrap_iv` column/field vs. concatenated blob | `base64(iv(12B) \|\| gcmCiphertext)` in one field, one nullable `wrapped_content_key BYTEA` column. The spec's create/reveal payloads name only `wrappedContentKey`, `passphraseSalt`, `kdfIterations` — no wrap-IV field exists on the wire, so it must live inside the blob itself. |
| Migration column set | Follow exploration's list verbatim vs. add missing column | Exploration's column list omits a column for `wrappedContentKey`, but the spec requires persisting it verbatim. Adds `wrapped_content_key BYTEA` (nullable, paired with `passphrase_salt`/`kdf_iterations`) — spec is authoritative over exploration notes. |
| `POST /secrets` idempotency | Reuse `IdempotencyExecutor` (organizations pattern) vs. plain authenticated write | Plain write, no executor. A duplicate secret is cheap and self-expiring (unlike an org/invitation), and skipping it removes an `Idempotency-Key` requirement from the extension's create flow. |
| Burn's post-commit notify | Reuse `ExecutePrepared`/`PostCommit` vs. handler-local flush-then-notify | Handler-local: `Service.Burn` commits and returns `(creatorUserID, alreadyRead bool)`; handler does `WriteJSON(200)` → `Flush()` → `hub.PublishToUser(WithoutCancel(ctx), ...)` only when `!alreadyRead`. `ExecutePrepared` requires a `PrincipalID`/`Idempotency-Key`, neither of which an anonymous caller has. |
| Burn idempotency | Error on repeat vs. no-op success | `SELECT ... FOR UPDATE` inside the tx; `status == 'read'` returns success with the original `read_at` and skips the notify (so a second burn never double-notifies the creator). |
| Hub delivery channel | Reuse `Messages chan syncapi.Envelope` (cast to `any`) vs. new channel + index | New `Notifications chan any` field on `Subscription`, populated only via the new `byUser` index; `Messages`/`byWorkspace`/`Publish` are untouched, so `hub_test.go` stays green. `handler.go`'s read loop gains one `case msg := <-subscription.Notifications: connection.WriteJSON(msg)` — the frame is written raw (no `{"type":"event","event":...}` wrapper), same flat-JSON convention as `ack`/`resync_required`. |
| `Subscribe` signature | Keep `(workspaceID, clientID)` vs. add `userID` | `Subscribe(workspaceID, userID, clientID string)`, matching the spec's scenario text exactly; `handler.go:55` passes `principal.UserID`. |
| Rate limiter shape | Postgres-backed vs. in-memory | In-memory `httpapi.IPRateLimiter`: `map[string]*bucket{tokens float64, lastRefill time.Time}` behind a `sync.Mutex`, capacity 30, continuous refill (0.5 tok/s), lazy per-request refill (no goroutine); entries older than 2 minutes are evicted opportunistically on access. New, since no rate-limiting infra exists anywhere in `backend`. |
| Client IP resolution | `r.RemoteAddr` only vs. honor `X-Forwarded-For` | First `X-Forwarded-For` entry if present (compose runs behind a reverse proxy per `docker-compose.prod.yml`), else `SplitHostPort(r.RemoteAddr)`. New `httpapi.ClientIP(r)` helper. |
| Unknown-field rejection | Struct with `json:"-"` tags vs. explicit allow-list | Decode into `map[string]json.RawMessage` first; any key outside `{ciphertext,iv,wrappedContentKey,passphraseSalt,kdfIterations,ttlSeconds}` → 400. Catches `plaintext`/`passphrase` and any future accidental field, not just the two named in the spec. |
| Content-limit response code | 413 vs. 400 | 400, checked on the raw base64 string length before JSON-unmarshalling further. Every other validation failure in this backend already returns 400 (`httpapi.WriteError`); introducing 413 would be a one-off status with no precedent. |
| TTL sweep | Background cron vs. lazy check | Lazy only: `Reveal`/`Burn` compare `expires_at` against `NOW()` on every call. No sweeper — nothing reads expired rows except these two paths, so a stale row is inert until then. |
| Crypto helper module | Shared package vs. duplicated module | `extension/src/shared/crypto.ts` (new) and a parallel `admin-web/src/lib/crypto.ts` (new). Confirmed: no root workspace links `extension/` and `admin-web/` (each has its own `node_modules`), so there is no existing shared-package seam to extend; duplication is scoped to matching the wire format (base64 encodings, PBKDF2 params), not logic. |
| Fragment-key transmission | Trust callers not to leak it vs. structural guard | `SecretRevealPage` never reads `window.location.href`; it reads `useParams().token` for the fetch path and `window.location.hash` separately, only after decrypt. The fetch call is built as a literal `` `/secrets/${token}` `` string, never string-built from `location.href`, so the fragment cannot reach `fetch`, a logger, or a `Referer` header (fragments are never sent over HTTP by the browser regardless, but the literal-path rule removes any code path that could copy it in). |
| Read-confirmation frame payload | Include token vs. `secretId` only | `{"type":"secret_read","secretId":"<uuid>","readAt":"<RFC3339>"}` — no token. The extension already persists `{id, token, createdAt}` locally on creation (new, in `ExtensionState`), so the frame only needs `secretId` to look up a label, minimizing what crosses the wire/logs. |

## Data Flow

    extension popup: create-secret
      -> crypto.ts: generateContentKey, encrypt, (optional) deriveWrappingKey+wrap
      -> POST /secrets (auth)  -> secrethide.Service.Create -> INSERT, token, expires_at
      -> link = {PUBLIC_BASE_URL}/s/{token}[#k=...]     -> persist {id,token} locally

    recipient opens /s/:token (public, outside RequireSession)
      -> SecretRevealPage: GET /secrets/{token}          -> ciphertext blob (no burn)
      -> local decrypt (fragment key or passphrase-unwrap); wrong passphrase: no network call
      -> on success: POST /secrets/{token}/burn
         -> Service.Burn: tx UPDATE status='read' RETURNING user_id
         -> WriteJSON(200) -> Flush -> Hub.PublishToUser(userID, secret_read frame)

    extension background: onSecretRead -> record local notification (activitySignal-style)
      -> popup open: acknowledgeActivityIfNeeded renders/clears the pill

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/migrations/000010_secrets.sql` | Create | `secrets` table + `wrapped_content_key`; indexes on `user_id`, `(status, expires_at)` |
| `backend/internal/secrethide/service.go` | Create | `Create`, `Reveal`, `Burn`, `generateToken` (24B/hex, mirrors `generateInviteToken`) |
| `backend/internal/secrethide/handler.go` | Create | `RegisterRoutes`; field allow-list, TTL clamp, status mapping (404/410/429) |
| `backend/internal/httpapi/ratelimit.go` | Create | `IPRateLimiter`, `ClientIP` |
| `backend/internal/websocket/hub.go` | Modify | `byUser` index, `Notifications` channel, `PublishToUser` |
| `backend/internal/websocket/handler.go` | Modify | `Subscribe(workspaceID, principal.UserID, principal.ClientID)`, second `select` case |
| `backend/cmd/api/main.go` | Modify | wire `secrethide.NewService`, `secrethide.RegisterRoutes(..., websocketHub)`, rate limiter instance |
| `admin-web/src/app/router.tsx` | Modify | `{ path: "/s/:token", element: <SecretRevealPage/> }`, sibling of `/login`, no `RequireSession` |
| `admin-web/src/app/views/SecretRevealPage.tsx` | Create | no `useAuth()`; fetch/decrypt/burn flow |
| `admin-web/src/lib/api/secrets.ts` | Create | `apiRequest` calls with no `token` option |
| `admin-web/src/lib/crypto.ts` | Create | AES-GCM/PBKDF2 helpers |
| `extension/src/shared/crypto.ts` | Create | same helpers, extension side |
| `extension/src/shared/websocket.ts` | Modify | `onSecretRead` callback, `type === "secret_read"` branch |
| `extension/src/background/projection.ts` | Modify | frame handler, local secret record, notification signal |
| `extension/src/popup/popup.ts`, `popup.html` | Modify | create-secret UI, read-confirmation pill |

## Interfaces / Contracts

```go
func (h *Hub) Subscribe(workspaceID, userID, clientID string) *Subscription
func (h *Hub) PublishToUser(ctx context.Context, userID string, message any) error
type Subscription struct { WorkspaceID, UserID, ClientID string; Messages chan syncapi.Envelope; Notifications chan any; hub *Hub }
```
```go
type CreateSecretInput struct {
    Ciphertext, IV                        string `json:"ciphertext"` // base64
    WrappedContentKey, PassphraseSalt     *string `json:"wrappedContentKey,omitempty"`
    KDFIterations                         *int    `json:"kdfIterations,omitempty"`
    TTLSeconds                            *int    `json:"ttlSeconds,omitempty"`
}
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (secrets service) | TTL default/clamp, burn idempotency, expiry gating, unknown-field rejection | table-driven, fake `pgxmock`/test DB |
| Unit (rate limiter) | 30/min allow, 31st denies, per-IP isolation, eviction | pure Go, fake clock |
| Unit (hub) | `byUser` populate/cleanup alongside `byWorkspace`, `PublishToUser` no-op when offline, delivers to all sockets, isolation across users | extends `hub_test.go` |
| Integration | full create→reveal→burn→notify against `handler_integration_test.go`'s harness | assert `Messages` untouched, `Notifications` receives frame |
| Frontend unit | `SecretRevealPage` never includes hash in fetch URL/logs; wrong passphrase leaves status `pending` | mocked `fetch`, spy on `console.*`/`window.location` |
| Extension unit | crypto round-trip, `secret_read` dispatch to `onSecretRead` only (not `onEvent`) | vitest |

## Threat Matrix

N/A — no shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. `/s/:token` is a new public HTTP route, covered under Fragment-key-transmission and Rate-limiter decisions above, not the process-integration matrix.

## Migration / Rollout

Additive migration `000010_secrets.sql`; no backfill. Rollback: drop the table, remove `secrethide.RegisterRoutes`/router entry, revert `Hub`'s additive fields (unused if `PublishToUser` is never called). No existing data touched.

## Open Questions

- [ ] Exact 429 response body shape (bare `httpapi.WriteError` vs. `Retry-After` header) — default to `WriteError` only, no header, unless product wants it surfaced in the UI.
