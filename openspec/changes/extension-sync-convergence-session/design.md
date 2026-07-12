# Design: Extension Sync Convergence Session

## Technical Approach

Ship renewable transport first, then durable desired-state convergence. Slice B pauses its journal on expiry.

## Architecture Decisions

| Decision | Choice and rationale |
|---|---|
| Lifetime | Access JWT is **15 minutes**. Refresh families have **no routine idle or absolute expiry**: remembered sessions end only on current-device sign-out, device/server revocation, reuse compromise, or password change/recovery. |
| Family security | Device family, hash-only metadata, rotation/reuse detection, explicit and optional admin revocation secure non-expiring sessions without periodic login. |
| Lost refresh response | Persist UUID `attemptId` before refresh. Transactional rotation derives child secret as `HMAC(parentSecret, attemptId)`, stores only its SHA-256 hash, and accepts retired parent only for that attempt for 60s. Retry returns the same child without server plaintext; other/late reuse revokes family. |
| Socket credential | `POST /auth/ws-ticket` requires access auth and returns a 30-second single-use opaque ticket in `Sec-WebSocket-Protocol`; upgrade consumes its hash. Header stripping fails closed: no socket, journal pauses/retries, never refresh-token or URL fallback. |
| Projection | A durable desired-state journal replaces normal destructive rebuild; mapping, not title/URL, is identity. |

## Slice A — Session Continuity

Migration `000006_refresh_sessions.sql` adds `refresh_families(id,user_id,device_id,revoked_at,reuse_detected_at)` and `refresh_tokens(id,family_id,secret_hash,retired_at,retry_attempt_id,retry_until,rotated_to_id,created_at)`, plus hash-only one-use WS tickets, indexes and cascade FKs. Login/register bind the existing device, create family/token, and return `{accessToken,expiresAt,refreshToken,clientId,user}`. `POST /auth/refresh {refreshToken,attemptId}` rotates atomically; `POST /auth/logout` revokes its family. Invalid/reused refresh is generic `401 unauthenticated`; malformed input is `400`; expired/consumed ticket is `401`. Legacy access-only state becomes `loginRequired`, retaining selection, mapping, cursor, and journal.

`auth.Service.RevokeAllRefreshFamilies(ctx,userID)` revokes every family in the same transaction as current/future password-change or recovery credential updates. No account UI/endpoints are added. Service tests prove a credential change rejects every family; future handlers use this transaction.

`chrome.storage.local` holds private refresh data plus durable state; `chrome.storage.session` holds access JWT/expiry and in-flight marker. Background alone reads secrets; UI receives redacted status. Storage is persistence, not encryption: no content-script exposure or secret diagnostics.

`AuthenticatedTransport` owns REST: refresh near expiry, single-flight, one replay using persisted `X-Sync-Event-Id`; refresh/ticket bypass interception. Failure pauses journals; success reconnects sockets and replays cursors.

```text
401 x5 -> one refresh -> private state -> each original request replayed once
socket close -> ticket(access JWT) -> WS upgrade -> replay(cursor)
```

## Slice B — Convergence Engine

Each `ProjectionState` gains:

```ts
{version:1,epoch,desired:{snapshotId,cursor},phase:"plan"|"apply"|"replay"|"live"|"paused",
 operations:[{id,kind,backendId,chromeId?,fingerprint,status:"planned"|"started"|"done"}],
 localIntents:[{eventId,kind,payload,status:"queued"|"sent"|"acked"}],attempts,pauseReason?,queuedEpoch?}
```

Serialized `updateState` commits `started` before every Chrome call, then mapping/result and `done`. On revival: prove done, retry not-started, or pause `ambiguous-operation`; never create ambiguously. Planner fetches snapshot, inventories mappings, emits `epoch:backendId:kind:fingerprint`, checkpoints each, replays cursor, then sends queued intents once. During repair persist unmatched local listeners. Identical Chrome events are indistinguishable: dedupe only the same durable event/operation.

Mapping is workspace-scoped bijection. Inventory stays under managed root; adoption requires parent mapping, type, canonical order, and one candidate. Duplicate title/URL pauses `identity-ambiguous`; Rebuild deletes only managed-root children. No deletion targets outside root.

Listeners inspect durable `started` operations by workspace, Chrome/backend ID and shape. A match is owned before promises resolve or after restart; consume only after tree verification. Others become local intent or queue during repair.

| Transition | Rule |
|---|---|
| Request | one active epoch/workspace plus latest `queuedEpoch` |
| Checkpoint | stale epoch stops; latest runs once afterward |
| Retry | 3 attempts, 1/5/25s backoff, then paused with Retry/Rebuild |
| Auth failure | preserve same journal/cursor; renewal/login resumes it |

## Interfaces / File Changes

| File | Action | Impact |
|---|---|---|
| `backend/migrations/000006_refresh_sessions.sql` | Create | non-expiring families, tokens, tickets |
| `backend/internal/auth/{service,handler,middleware}.go`, `config/config.go` | Modify | rotation, revocation, `RevokeAllRefreshFamilies`, 15m config, ticket routes |
| `backend/internal/websocket/handler.go` | Modify | fail-closed ticket upgrade |
| `extension/src/shared/{types,storage,api,session,websocket}.ts` | Modify | secret boundary, transport, journal |
| `extension/src/background/{service-worker,projection,bookmark-listeners}.ts` | Modify | reducer/planner/listeners/UI actions |
| `extension/tests/{chrome-fake,auth-transport,convergence}.test.mjs` | Create/modify | deterministic evidence |

## Verification Strategy

Extract pure planner/reducer tests. Fake Chrome persists storage across worker restart and fires callbacks before API promises. Cover repeated snapshots, reordered events, every checkpoint crash, reconnect/triggers, duplicate-title mapping loss, repair edit, bounded pause, five 401s, response loss/reuse, revoked refresh. Slice A: Go auth/WS integration verifies password-transaction revocation and proxy subprotocol preservation; stripped header rejects without fallback. Add extension transport and manual Chromium login/restart/socket-expiry evidence. Slice B: fake schedules and manual repeated resync/restart/Retry/Rebuild with unrelated-bookmark inspection.

## Migration / Rollout

Gate `renewable_sessions`, then `convergent_projection`; retain legacy projection while B is off. Migration is additive; rollback disables issuance/tickets and forces login, leaving inert hashes. Preserve mappings only with proof; otherwise pause for Rebuild. Diagnostics exclude secrets. Cap journals at 500 operations/100 intents; overflow pauses.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

**Delivery forecast:** Slice A ~510 authored lines; Slice B ~760; each is within 800, total ~1,270. Chained PRs: A then B.
