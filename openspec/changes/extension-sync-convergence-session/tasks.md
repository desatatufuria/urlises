# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated authored changed lines | 2,710–3,390 |
| 400-line budget risk | High |
| Delivery / chain | auto-forecast / stacked-to-main; each unit merges to `develop` before the next starts |
| Units | PR1a 350–400 → PR1b-auth 300–380 → PR1b-ticket 230–330 → PR1b-ws-upgrade 220–320 → PR2a 300–400 → PR2b 280–380 → PR3 330–380 → PR4a 350–400 → PR4b 350–400 |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

```text
develop ← PR1a ← PR1b-auth ← PR1b-ticket ← PR1b-ws-upgrade ← PR2a REST ← PR2b WS/TTL ← PR3 journal ← PR4a ownership ← PR4b repair
```

CodeGraph preflight found PR2 crosses 22 session/state callers and cannot fit one review. It is split without exception; completed PR1a–PR1b-ws-upgrade tasks remain checked: 12/24. `000006` is immutable; `000007` remains ticket-only.

| Unit | Start → end; dependency / out of scope / rollback | Focused test; runtime harness | Evidence |
|---|---|---|---|
| PR1a | Inert refresh domain; no endpoints/tickets/TTL/extension; revert consumers/gate. | `cd backend && go test ./internal/auth`; PostgreSQL migration. | Exact result; migration/security/rollback. |
| PR1b-auth | Capability-gated auth endpoints; no WS ticket work; revert routes/capability. | `cd backend && go test ./internal/auth`; DB auth. | Exact result; compatibility/threat/rollback. |
| PR1b-ticket | Ticket issue/persistence; no WS handler/subprotocol/proxy; revert `000007` consumers/endpoint. | `cd backend && go test ./internal/auth`; DB clock/concurrency. | Exact result; no-cache/secret/migration rollback. |
| PR1b-ws-upgrade | Ticket-consuming upgrade; no migration/extension/TTL; revert handler, preserve legacy query path. | `cd backend && go test ./internal/websocket`; Gorilla/proxy. | Exact result; protocol/no-downgrade/rollback. |
| PR2a | PR1b-ws-upgrade → private REST session; no WS ticket/TTL/convergence; revert coordinator/transport/background wiring. | `cd extension && npm test -- auth-transport`; Chromium login/restart/REST expiry. | Exact result; private-state/pause/rollback trace. |
| PR2b | PR2a → ticket socket and TTL cutover; no convergence change; revert socket/cutover, backend legacy route remains. | `cd extension && npm test -- auth-transport`; Chromium socket expiry/reconnect. | Exact result; cursor/secret/threat/rollback trace. |
| PR3 | PR2b → dormant journal; legacy projection unchanged; revert journal/gate. | `cd extension && npm test -- convergence`; fake storage restart. | Exact result; migration/invariants. |
| PR4a | PR3 → ownership/listener/outbox; no controls; revert engine gate. | `cd extension && npm test -- convergence`; fake Chrome reorder/crash. | Exact result; checkpoint/isolation. |
| PR4b | PR4a → repair/enablement; no unrelated bookmarks; revert gate restores legacy projection. | `cd extension && npm test -- convergence`; manual Chromium Retry/Rebuild. | Exact result; bounded pause/rollback. |

## Phase 1: PR1a — Refresh-family persistence/domain (complete)

Candidate paths: `backend/migrations/000006_refresh_sessions.sql`, `backend/internal/auth/{service,refresh_repository}.go`, `backend/internal/auth/*_test.go`.

- [x] 1.1 RED: PostgreSQL table-driven migration/domain tests for hash-only metadata, valid rotation, deterministic same-`attemptId` response-loss retry, and 60s retry result.
- [x] 1.2 RED: test late/other reuse revokes its family, logout/revoke-all operations, generic secret-safe errors, and absence of plaintext tokens in persisted/error output.
- [x] 1.3 Add migration, family/token repository, transactional rotation/reuse, logout and `RevokeAllRefreshFamilies` domain/service operations; do not add handlers or issue refresh credentials.
- [x] 1.4 Record DB harness, migration/rollback, and security-inspection evidence; document this as safe inert infrastructure merged to `develop`.

## Phase 2: PR1b-auth — Capability-gated auth endpoints (complete)

- [x] 2.1 RED: handler/integration coverage for capability header, access-only/no-secret and renewable login/register, same-attempt refresh, 400/401/503, logout, and revoke-all hook.
- [x] 2.2 Wire optional renewable login/register plus refresh/logout, preserve TTL, and make no WebSocket change.
- [x] 2.3 Record DB/auth, compatibility, threat, rollback, and delivery evidence.

## Phase 3: PR1b-ticket — Ticket issue and persistence (complete)

- [x] 3.1 RED: DB-clock expiry, hash-only persistence, one-use/concurrent consume, credential errors, access/client binding, no-cache/no secret.
- [x] 3.2 Add `000007`, ticket repository/service, and authenticated `POST /auth/ws-ticket`; make no WebSocket handler change.
- [x] 3.3 Record DB/runtime/security, migration, and rollback evidence.

## Phase 4: PR1b-ws-upgrade — Ticket-consuming upgrade (complete)

- [x] 4.1 RED: Gorilla/proxy selection, consume, fail-closed prefixed protocol, workspace authorization, permitted legacy query path, no secret.
- [x] 4.2 Wire handler consumption, preserve legacy access-token WS, make no migration/extension/TTL change, and record proxy/rollback evidence.

## Phase 5: PR2a — Extension renewable REST session

Candidate paths: `extension/src/shared/{types,storage,api,session}.ts`, `extension/src/background/service-worker.ts`, `extension/tests/auth-transport.test.mjs`.

- [x] 5.1 RED: renewable-capability login; private durable refresh absent from UI state; legacy access-only → `loginRequired` preserving selection/mappings/cursor; five 401s → one refresh; one same-header/body replay; response-loss retry; restart recovery; invalid/revoked pause/preserve.
- [x] 5.2 Implement storage/types/session coordinator, authenticated REST transport, and background wiring; exclude WebSocket ticket use, TTL cutover, and convergence changes.
- [x] 5.3 Separately record Chromium login/restart/REST-expiry, private-state inspection, and rollback evidence.

## Phase 6: PR2b — Extension ticket WebSocket and TTL cutover

Candidate paths: `extension/src/shared/{api,session,websocket}.ts`, `extension/src/background/{service-worker,projection}.ts`, `extension/tests/auth-transport.test.mjs`, `backend/config/config.go`.

- [x] 6.1 RED: ticket acquisition via renewable transport, subprotocol/no URL credential, reconnect/cursor resume, invalid ticket/refresh pause, concurrent reconnect, and secret-free diagnostics.
- [x] 6.2 Wire only required websocket/service-worker/projection paths; after compatibility proof set backend TTL to 15m and stop extension legacy URL tokens while retaining the backend legacy route.
- [x] 6.3 Separately record Chromium socket-expiry/reconnect, docs/threat matrix, cutover and rollback evidence.

## Phase 7: PR3 — Dormant convergence planner/journal

- [x] 7.1 RED: planner/reducer invariants for N snapshots, bijection, epochs/latest queue, caps, restart migration, ambiguity pause, and no outside-root deletion.
- [x] 7.2 Add versioned journal/checkpoints/scheduler behind `convergent_projection` off; document diagnostics and record fake-storage restart/rollback evidence.

## Phase 8: PR4a — Ownership and exact-once replay

- [ ] 8.1 RED: N snapshots, delayed/reordered duplicates, crash before checkpoint, two triggers plus reconnect, local edit once, and workspace isolation.
- [ ] 8.2 Wire journal-before-Chrome effects, durable listener correlation, verification-before-consume, and exact-once outbox replay; keep gated and record evidence.

## Phase 9: PR4b — Repair controls and enablement

- [ ] 9.1 RED: duplicate-title pause, bounded three-attempt pause, Retry/Rebuild scope, auth checkpoint resume, and no destructive normal resync.
- [ ] 9.2 Add controls/backoff/auth resume, remove destructive normal resync, enable only after invariants pass, and record manual/operator/rollback evidence.
