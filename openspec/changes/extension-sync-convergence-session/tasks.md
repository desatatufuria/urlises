# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated authored changed lines | 2,095–2,380 |
| 400-line budget risk | High |
| Delivery / chain | auto-forecast / stacked-to-main; every unit merges to `develop` before its successor starts |
| Units | PR1a (350–400) → PR1b (335–400) → PR2 (380–400) → PR3 (330–380) → PR4a (350–400) → PR4b (350–400) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

```text
develop ← PR1a persistence/domain ← PR1b endpoints/tickets ← PR2 transport ← PR3 dormant journal ← PR4a ownership ← PR4b repair/enable
```

Preflight proved the former PR1 is 685–900 lines; it is replaced by independently mergeable PR1a/PR1b. No size exception; PR1a now advances cumulative progress from 0/21 to 4/21.

| Unit | Start → end; dependency / out of scope / rollback | Focused test; runtime harness | Evidence |
|---|---|---|---|
| PR1a | Existing backend → inert hash-only refresh domain; base `develop`; no handlers, responses, tickets, TTL, or extension; revert migration consumers/gate, retain inert records. | `cd backend && go test ./internal/auth`; PostgreSQL migration/rotation/reuse harness. | Exact result; migration receipt; SQL/log secret inspection; rollback proof. |
| PR1b | PR1a on updated `develop` → capability-gated endpoints/ticket upgrade; legacy access WS and TTL retained; revert routes/WS capability while PR1a stays inert. | `cd backend && go test ./internal/auth ./internal/websocket`; proxy subprotocol/30s ticket harness. | Exact result; capability/compatibility trace; threat and rollback evidence. |
| PR2 | PR1b → private extension transport/ticket socket; no convergence projection; revert transport/gate. | `cd extension && npm test -- auth-transport`; Chromium login/restart/socket expiry. | Exact result; redacted storage/diagnostic and cursor trace. |
| PR3 | PR2 → dormant journal/planner; legacy projection unchanged; revert journal version/gate. | `cd extension && npm test -- convergence`; fake-storage restart. | Exact result; migration fixture/invariant trace. |
| PR4a | PR3 → ownership/listener/outbox; no controls or destructive-path removal; revert engine gate. | `cd extension && npm test -- convergence`; fake Chrome reorder/crash. | Exact result; checkpoint/isolation trace. |
| PR4b | PR4a → repair controls and engine enablement; no unrelated bookmark work; revert gate restores legacy projection. | `cd extension && npm test -- convergence`; manual Chromium Retry/Rebuild. | Exact result; bounded-pause and enable/rollback checklist. |

## Phase 1: PR1a — Refresh-family persistence/domain

Candidate paths: `backend/migrations/000006_refresh_sessions.sql`, `backend/internal/auth/{service,refresh_repository}.go`, `backend/internal/auth/*_test.go`.

- [x] 1.1 RED: PostgreSQL table-driven migration/domain tests for hash-only metadata, valid rotation, deterministic same-`attemptId` response-loss retry, and 60s retry result.
- [x] 1.2 RED: test late/other reuse revokes its family, logout/revoke-all operations, generic secret-safe errors, and absence of plaintext tokens in persisted/error output.
- [x] 1.3 Add migration, family/token repository, transactional rotation/reuse, logout and `RevokeAllRefreshFamilies` domain/service operations; do not add handlers or issue refresh credentials.
- [x] 1.4 Record DB harness, migration/rollback, and security-inspection evidence; document this as safe inert infrastructure merged to `develop`.

## Phase 2: PR1b — Capability-gated endpoints and WS tickets

Candidate paths: `backend/internal/auth/{service,handler,middleware}.go`, `backend/internal/websocket/handler.go`, `backend/config/config.go`, `backend/internal/{auth,websocket}/*_test.go`.

- [ ] 2.1 RED: handler/integration tests for malformed 400/generic 401, explicit renewable capability, access-only compatibility/no secret, refresh/logout, and password revoke-all hook contract.
- [ ] 2.2 RED: test one-use/expired 30s tickets and fail-closed stripped subprotocol; assert legacy access-token WS remains and no URL credential fallback occurs.
- [ ] 2.3 Wire optional renewable login/register response, refresh/logout/ws-ticket handlers, ticket upgrade, capability gate, and credential-change revoke-all hook; preserve effective access TTL.
- [ ] 2.4 Document endpoint migration and threat matrix (secret, reuse, header stripping); record proxy harness, compatibility, rollback, and delivery-boundary evidence.

## Phase 3: PR2 — Extension session transport and tickets

Candidate paths: `extension/src/shared/{types,storage,api,session,websocket}.ts`, `extension/src/background/service-worker.ts`, `extension/tests/auth-transport.test.mjs`.

- [ ] 3.1 RED: 5 concurrent 401s, one original-ID replay, response loss/reuse, restart during renewal, revoked refresh mid-sync, ticket/proxy preservation, and secret-free URL/diagnostics.
- [ ] 3.2 Migrate private refresh/durable state and session access/in-flight marker; background owns secrets; legacy state becomes `loginRequired` while mappings/cursor persist.
- [ ] 3.3 Implement single-flight refresh, ticket reconnect/cursor resume, and invalid-refresh pause/preserve; then enable 15-minute access TTL and remove legacy URL-token behavior compatibly.
- [ ] 3.4 Document migration/threat matrix; separately manually validate Chromium login, restart, expiry, and revoked-refresh pause; record evidence.

## Phase 4: PR3 — Dormant convergence planner/journal

Candidate paths: `extension/src/shared/{types,storage}.ts`, `extension/src/background/projection.ts`, `extension/tests/{chrome-fake,convergence}.test.mjs`.

- [ ] 4.1 RED: planner/reducer invariants for N snapshots, bijection, epochs/latest queue, 500/100 caps, restart migration, ambiguity pause, and no outside-root deletion.
- [ ] 4.2 Add versioned desired-state journal, serialized checkpoints, scheduler/reducers; retain legacy projection behind `convergent_projection` off.
- [ ] 4.3 Document schema/secret-free diagnostics; record fake-storage restart evidence and rollback-gate check.

## Phase 5: PR4a — Ownership and exact-once replay

Candidate paths: `extension/src/background/{projection,bookmark-listeners,service-worker}.ts`, `extension/tests/{chrome-fake,convergence}.test.mjs`.

- [ ] 5.1 RED: N snapshots, delayed/reordered duplicate listener events, crash after side effect/before checkpoint, two triggers plus reconnect, local edit once, and workspace isolation.
- [ ] 5.2 Wire journal-before-Chrome effects, durable listener correlation, verification-before-consume, local-intent outbox, and exact-once replay; keep engine gated.
- [ ] 5.3 Separately record fake-event-bus and manual Chromium crash/restart evidence; document ownership and rollback invariants.

## Phase 6: PR4b — Repair controls and enablement

Candidate paths: `extension/src/background/{projection,service-worker}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 6.1 RED: duplicate-title ambiguity pause, three-attempt bounded pause, Retry/Rebuild managed-root scope, auth pause/resume checkpoint, and no destructive normal resync.
- [ ] 6.2 Add controls, bounded backoff/auth resume, remove destructive normal resync, and enable the complete engine only after invariants pass.
- [ ] 6.3 Separately manually validate repeated resync, reconnect, Retry/Rebuild, and unrelated bookmarks; record operator docs, gate rollback, and boundary evidence.
