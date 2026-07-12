# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated authored changed lines | 2,310–2,710 |
| 400-line budget risk | High |
| Delivery / chain | auto-forecast / stacked-to-main; each unit merges to `develop` before the next starts |
| Units | PR1a (350–400) → PR1b-auth (300–380) → PR1b-ws (250–350) → PR2 (380–400) → PR3 (330–380) → PR4a (350–400) → PR4b (350–400) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

```text
develop ← PR1a persistence/domain ← PR1b-auth endpoints ← PR1b-ws tickets ← PR2 transport ← PR3 journal ← PR4a ownership ← PR4b repair/enable
```

Preflight proved former PR1b is 550–700 lines; it is split with no exception. PR1a and PR1b-auth are complete; cumulative task progress is 7/25. `000006_refresh_sessions.sql` remains immutable; PR1b-ws adds fix-forward `000007_ws_tickets.sql`.

| Unit | Start → end; dependency / out of scope / rollback | Focused test; runtime harness | Evidence |
|---|---|---|---|
| PR1a | Existing backend → inert hash-only refresh domain; no handlers/responses/tickets/TTL/extension; revert consumers/gate, retain inert records. | `cd backend && go test ./internal/auth`; PostgreSQL migration/rotation/reuse harness. | Exact result; migration receipt; SQL/log secret inspection; rollback proof. |
| PR1b-auth | PR1a → capability-gated auth endpoints; no WS ticket migration/endpoint/handler; revert routes/capability, retain PR1a domain. | `cd backend && go test ./internal/auth`; DB login/refresh/logout harness. | Exact result; capability/compatibility/threat/rollback trace. |
| PR1b-ws | PR1b-auth → ticket endpoint and WS consumption; legacy access-token WS stays; revert `000007` consumers/routes/upgrade, preserve legacy WS. | `cd backend && go test ./internal/auth ./internal/websocket`; real upgrade/proxy harness. | Exact result; subprotocol, no-secret, migration/rollback trace. |
| PR2 | PR1b-ws → private extension transport/socket; no convergence projection; revert transport/gate. | `cd extension && npm test -- auth-transport`; Chromium login/restart/expiry. | Exact result; redacted storage/diagnostic and cursor trace. |
| PR3 | PR2 → dormant journal/planner; legacy projection unchanged; revert journal/gate. | `cd extension && npm test -- convergence`; fake-storage restart. | Exact result; migration fixture/invariant trace. |
| PR4a | PR3 → ownership/listener/outbox; no controls/destructive-path removal; revert engine gate. | `cd extension && npm test -- convergence`; fake Chrome reorder/crash. | Exact result; checkpoint/isolation trace. |
| PR4b | PR4a → repair controls/engine enablement; no unrelated bookmark work; revert gate restores legacy projection. | `cd extension && npm test -- convergence`; manual Chromium Retry/Rebuild. | Exact result; bounded-pause/enable rollback checklist. |

## Phase 1: PR1a — Refresh-family persistence/domain (complete)

Candidate paths: `backend/migrations/000006_refresh_sessions.sql`, `backend/internal/auth/{service,refresh_repository}.go`, `backend/internal/auth/*_test.go`.

- [x] 1.1 RED: PostgreSQL table-driven migration/domain tests for hash-only metadata, valid rotation, deterministic same-`attemptId` response-loss retry, and 60s retry result.
- [x] 1.2 RED: test late/other reuse revokes its family, logout/revoke-all operations, generic secret-safe errors, and absence of plaintext tokens in persisted/error output.
- [x] 1.3 Add migration, family/token repository, transactional rotation/reuse, logout and `RevokeAllRefreshFamilies` domain/service operations; do not add handlers or issue refresh credentials.
- [x] 1.4 Record DB harness, migration/rollback, and security-inspection evidence; document this as safe inert infrastructure merged to `develop`.

## Phase 2: PR1b-auth — Capability-gated auth endpoints

Candidate paths: `backend/internal/auth/{service,handler,middleware}.go`, `backend/internal/auth/*_test.go`, `backend/config/config.go`.

- [x] 2.1 RED: handler/integration coverage for explicit renewable capability header, access-only login/register without secrets, renewable login/register, refresh same-attempt rotation/retry, malformed 400, generic 401, operational 503, logout, and password revoke-all hook contract.
- [x] 2.2 Wire capability-gated optional renewable login/register response and refresh/logout routes/services; preserve effective access TTL and make no WebSocket changes.
- [x] 2.3 Record DB/auth harness plus compatibility, secret/reuse threat matrix, rollback boundary, and delivery evidence.

## Phase 3: PR1b-ws — WS ticket capability

Candidate paths: `backend/migrations/000007_ws_tickets.sql`, `backend/internal/auth/{service,handler}.go`, `backend/internal/websocket/handler.go`, `backend/internal/{auth,websocket}/*_test.go`.

- [ ] 3.1 RED: cover one-use/expired 30s tickets, stripped/invalid subprotocol fail-closed, real upgrade/proxy preservation, and no URL/log secret output.
- [ ] 3.2 Add fix-forward `000007`, hash-only ticket repository/service, authenticated ws-ticket endpoint, and `Sec-WebSocket-Protocol` consumption/selection; preserve legacy access-token WS.
- [ ] 3.3 Record proxy harness, migration/rollback, secret inspection, and legacy-WS compatibility evidence.

## Phase 4: PR2 — Extension session transport and tickets

Candidate paths: `extension/src/shared/{types,storage,api,session,websocket}.ts`, `extension/src/background/service-worker.ts`, `extension/tests/auth-transport.test.mjs`.

- [ ] 4.1 RED: 5 concurrent 401s, one original-ID replay, response loss/reuse, restart during renewal, revoked refresh mid-sync, ticket/proxy preservation, and secret-free URL/diagnostics.
- [ ] 4.2 Migrate private refresh/durable state and session access/in-flight marker; background owns secrets; legacy state becomes `loginRequired` while mappings/cursor persist.
- [ ] 4.3 Implement single-flight refresh, ticket reconnect/cursor resume, invalid-refresh pause/preserve; then enable 15-minute TTL and remove legacy URL-token behavior compatibly.
- [ ] 4.4 Document migration/threat matrix; separately manually validate Chromium login, restart, expiry, and revoked-refresh pause; record evidence.

## Phase 5: PR3 — Dormant convergence planner/journal

Candidate paths: `extension/src/shared/{types,storage}.ts`, `extension/src/background/projection.ts`, `extension/tests/{chrome-fake,convergence}.test.mjs`.

- [ ] 5.1 RED: planner/reducer invariants for N snapshots, bijection, epochs/latest queue, 500/100 caps, restart migration, ambiguity pause, and no outside-root deletion.
- [ ] 5.2 Add versioned desired-state journal, serialized checkpoints, scheduler/reducers; retain legacy projection behind `convergent_projection` off.
- [ ] 5.3 Document schema/secret-free diagnostics; record fake-storage restart evidence and rollback-gate check.

## Phase 6: PR4a — Ownership and exact-once replay

Candidate paths: `extension/src/background/{projection,bookmark-listeners,service-worker}.ts`, `extension/tests/{chrome-fake,convergence}.test.mjs`.

- [ ] 6.1 RED: N snapshots, delayed/reordered duplicate listener events, crash after side effect/before checkpoint, two triggers plus reconnect, local edit once, and workspace isolation.
- [ ] 6.2 Wire journal-before-Chrome effects, durable listener correlation, verification-before-consume, local-intent outbox, and exact-once replay; keep engine gated.
- [ ] 6.3 Separately record fake-event-bus and manual Chromium crash/restart evidence; document ownership and rollback invariants.

## Phase 7: PR4b — Repair controls and enablement

Candidate paths: `extension/src/background/{projection,service-worker}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 7.1 RED: duplicate-title ambiguity pause, three-attempt bounded pause, Retry/Rebuild managed-root scope, auth pause/resume checkpoint, and no destructive normal resync.
- [ ] 7.2 Add controls, bounded backoff/auth resume, remove destructive normal resync, and enable the complete engine only after invariants pass.
- [ ] 7.3 Separately manually validate repeated resync, reconnect, Retry/Rebuild, and unrelated bookmarks; record operator docs, gate rollback, and boundary evidence.
