# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated authored changed lines | 2,510–2,990 |
| 400-line budget risk | High |
| Delivery / chain | auto-forecast / stacked-to-main; each unit merges to `develop` before the next starts |
| Units | PR1a (350–400) → PR1b-auth (300–380) → PR1b-ticket (230–330) → PR1b-ws-upgrade (220–320) → PR2 (380–400) → PR3 (330–380) → PR4a (350–400) → PR4b (350–400) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

```text
develop ← PR1a domain ← PR1b-auth endpoints ← PR1b-ticket issue ← PR1b-ws-upgrade consume ← PR2 transport ← PR3 journal ← PR4a ownership ← PR4b repair/enable
```

Preflight proved PR1b-ws is 455–545 lines; no exception. PR1a and PR1b-auth remain complete: 7/23 checkboxes. `000006` is immutable; fix-forward `000007_ws_tickets.sql` belongs only to PR1b-ticket.

| Unit | Start → end; dependency / out of scope / rollback | Focused test; runtime harness | Evidence |
|---|---|---|---|
| PR1a | Existing backend → inert refresh domain; no endpoints/tickets/TTL/extension; revert consumers/gate. | `cd backend && go test ./internal/auth`; PostgreSQL migration harness. | Exact result; migration/security/rollback receipt. |
| PR1b-auth | PR1a → capability-gated auth endpoints; no WS ticket work; revert routes/capability. | `cd backend && go test ./internal/auth`; DB auth harness. | Exact result; compatibility/threat/rollback trace. |
| PR1b-ticket | PR1b-auth → ticket issue/persistence; no WS handler/subprotocol/proxy; revert `000007` consumers/endpoint. | `cd backend && go test ./internal/auth`; DB clock/concurrent-consume harness. | Exact result; no-cache/secret/migration rollback trace. |
| PR1b-ws-upgrade | PR1b-ticket → ticket-consuming WS upgrade; no migration/extension/TTL; revert handler, preserve legacy query path. | `cd backend && go test ./internal/websocket`; real Gorilla/proxy harness. | Exact result; protocol/no-downgrade/rollback trace. |
| PR2 | PR1b-ws-upgrade → private extension transport; no convergence projection; revert transport/gate. | `cd extension && npm test -- auth-transport`; Chromium login/restart/expiry. | Exact result; redacted storage/cursor trace. |
| PR3 | PR2 → dormant journal; legacy projection unchanged; revert journal/gate. | `cd extension && npm test -- convergence`; fake-storage restart. | Exact result; migration/invariant trace. |
| PR4a | PR3 → ownership/listener/outbox; no controls; revert engine gate. | `cd extension && npm test -- convergence`; fake Chrome reorder/crash. | Exact result; checkpoint/isolation trace. |
| PR4b | PR4a → repair/enablement; no unrelated bookmark work; revert gate restores legacy projection. | `cd extension && npm test -- convergence`; manual Chromium Retry/Rebuild. | Exact result; bounded-pause/rollback checklist. |

## Phase 1: PR1a — Refresh-family persistence/domain (complete)

Candidate paths: `backend/migrations/000006_refresh_sessions.sql`, `backend/internal/auth/{service,refresh_repository}.go`, `backend/internal/auth/*_test.go`.

- [x] 1.1 RED: PostgreSQL table-driven migration/domain tests for hash-only metadata, valid rotation, deterministic same-`attemptId` response-loss retry, and 60s retry result.
- [x] 1.2 RED: test late/other reuse revokes its family, logout/revoke-all operations, generic secret-safe errors, and absence of plaintext tokens in persisted/error output.
- [x] 1.3 Add migration, family/token repository, transactional rotation/reuse, logout and `RevokeAllRefreshFamilies` domain/service operations; do not add handlers or issue refresh credentials.
- [x] 1.4 Record DB harness, migration/rollback, and security-inspection evidence; document this as safe inert infrastructure merged to `develop`.

## Phase 2: PR1b-auth — Capability-gated auth endpoints (complete)

Candidate paths: `backend/internal/auth/{service,handler,middleware}.go`, `backend/internal/auth/*_test.go`, `backend/config/config.go`.

- [x] 2.1 RED: handler/integration coverage for explicit renewable capability header, access-only login/register without secrets, renewable login/register, refresh same-attempt rotation/retry, malformed 400, generic 401, operational 503, logout, and password revoke-all hook contract.
- [x] 2.2 Wire capability-gated optional renewable login/register response and refresh/logout routes/services; preserve effective access TTL and make no WebSocket changes.
- [x] 2.3 Record DB/auth harness plus compatibility, secret/reuse threat matrix, rollback boundary, and delivery evidence.

## Phase 3: PR1b-ticket — Ticket issue and persistence

Candidate paths: `backend/migrations/000007_ws_tickets.sql`, `backend/internal/auth/{service,handler,ticket_repository}.go`, `backend/internal/auth/*_test.go`.

- [x] 3.1 RED: PostgreSQL/auth tests for creation, DB-clock 30s expiry, hash-only persistence, one-use/concurrent consume, malformed/unknown/expired credential, and endpoint access auth/client binding/no-cache/no secret.
- [x] 3.2 Add fix-forward `000007`, ticket repository/service, and authenticated `POST /auth/ws-ticket`; make no WebSocket handler/subprotocol/proxy change.
- [x] 3.3 Record DB/runtime/security, migration, and rollback evidence.

## Phase 4: PR1b-ws-upgrade — Ticket-consuming upgrade

Candidate paths: `backend/internal/websocket/handler.go`, `backend/internal/websocket/*_test.go`, `backend/internal/auth/service.go`.

- [ ] 4.1 RED: Gorilla upgrade/proxy tests for exact `Sec-WebSocket-Protocol` selection, one-use consume, stripped/invalid prefixed protocol fail-closed/no downgrade, workspace authorization, legacy query path only without ticket protocol, and no URL/log secret.
- [ ] 4.2 Wire ticket consumption into the WebSocket handler; preserve legacy access-token WS, make no migration/extension/TTL change, and record proxy/rollback evidence.

## Phase 5: PR2 — Extension session transport and tickets

Candidate paths: `extension/src/shared/{types,storage,api,session,websocket}.ts`, `extension/src/background/service-worker.ts`, `extension/tests/auth-transport.test.mjs`.

- [ ] 5.1 RED: 5 concurrent 401s, one original-ID replay, response loss/reuse, restart during renewal, revoked refresh mid-sync, ticket/proxy preservation, and secret-free URL/diagnostics.
- [ ] 5.2 Migrate private refresh/durable state and session access/in-flight marker; background owns secrets; legacy state becomes `loginRequired` while mappings/cursor persist.
- [ ] 5.3 Implement single-flight refresh, ticket reconnect/cursor resume, invalid-refresh pause/preserve; then enable 15-minute TTL and remove legacy URL-token behavior compatibly.
- [ ] 5.4 Document migration/threat matrix; separately manually validate Chromium login, restart, expiry, and revoked-refresh pause; record evidence.

## Phase 6: PR3 — Dormant convergence planner/journal

Candidate paths: `extension/src/shared/{types,storage}.ts`, `extension/src/background/projection.ts`, `extension/tests/{chrome-fake,convergence}.test.mjs`.

- [ ] 6.1 RED: planner/reducer invariants for N snapshots, bijection, epochs/latest queue, caps, restart migration, ambiguity pause, and no outside-root deletion.
- [ ] 6.2 Add versioned journal/checkpoints/scheduler behind `convergent_projection` off; document diagnostics and record fake-storage restart/rollback evidence.

## Phase 7: PR4a — Ownership and exact-once replay

Candidate paths: `extension/src/background/{projection,bookmark-listeners,service-worker}.ts`, `extension/tests/{chrome-fake,convergence}.test.mjs`.

- [ ] 7.1 RED: N snapshots, delayed/reordered duplicates, crash before checkpoint, two triggers plus reconnect, local edit once, and workspace isolation.
- [ ] 7.2 Wire journal-before-Chrome effects, durable listener correlation, verification-before-consume, and exact-once outbox replay; keep the engine gated and record fake/manual evidence.

## Phase 8: PR4b — Repair controls and enablement

Candidate paths: `extension/src/background/{projection,service-worker}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 8.1 RED: duplicate-title pause, bounded three-attempt pause, Retry/Rebuild scope, auth checkpoint resume, and no destructive normal resync.
- [ ] 8.2 Add controls/backoff/auth resume, remove destructive normal resync, enable only after invariants pass, and separately record Chromium/operator/rollback evidence.
