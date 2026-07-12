# Exploration: Extension Sync Convergence and Session Recovery

### Current State

The extension persists one `ExtensionState` record in `chrome.storage.local`: selected workspace IDs, one projection per workspace, mappings, cursor, and a session containing only `accessToken`, `expiresAt`, `clientId`, and user data. `storage.ts` serializes read-modify-write calls only while the current service-worker process remains alive.

Workspace selection calls `setSelectedWorkspaces()` -> `syncSelectedWorkspaces()` -> catalog refresh -> `ensureWorkspaceProjection()` -> bootstrap resync if needed -> one websocket per workspace. Manual resync calls `resyncWorkspace()` then reconnects each workspace. `doResyncWorkspace()` fetches the canonical tree, resets mappings, clears all managed children, rematerializes the tree, then replays events from cursor zero. `runCoalescedWorkspaceTask()` limits a workspace to one active run plus one requested rerun, but `resyncAll()` itself is not a single-flight/generation coordinator.

Chrome listeners call projection handlers without awaiting them. A local create/change/move/remove resolves a mapping and calls the REST mutation API, then resyncs. Remote replay/websocket events use `applyRemoteEnvelope()` and mutate Chrome. Remote folder and create/delete paths still use process-local `suppressedChromeIds` with a 250 ms release; bookmark update/move additionally uses a process-local shape-correlated pending-op ledger. Neither ledger survives service-worker termination. Mapping writes occur after Chrome creation, so an event delivered before that checkpoint or after a worker restart can look local. A full rebuild intentionally deletes and recreates every managed child on every resync.

The backend accepts a JWT plus `X-Client-Id` for REST and websocket upgrade. Login/register issue only a short-lived access token. There is no refresh-token field, persistence, endpoint, rotation, expiry preflight, 401 refresh/retry, or websocket refresh/reconnect path. Websocket credentials are placed in the URL query. The REST mutation client generates a new `X-Sync-Event-Id` per call; backend sync mutations can deduplicate an identical event ID, but an interrupted mutation cannot be safely retried with a newly generated ID.

### Call Paths and Feedback Edges

1. **Selection/startup/manual resync**: `setSelectedWorkspaces()` / `initializeBackground()` / `resyncAll()` -> `syncSelectedWorkspaces()` or `resyncWorkspace()` -> `doResyncWorkspace()` -> `GET /workspaces/{id}/tree` -> `ensureManagedPath()` -> clear managed children -> `materializeFolder()` / `materializeBookmark()` -> Chrome `onRemoved` / `onCreated` -> listener -> local REST mutation unless correlation is still live.
2. **Local mutation**: Chrome listener -> `handleBookmarkCreated|Changed|Moved|Removed()` -> `create|update|delete Folder|Bookmark()` -> sync routes carrying event ID and base cursor -> canonical event -> hub/websocket and replay -> `applyRemoteEnvelope()` -> Chrome mutation -> listener. Update/move bookmark correlation closes this edge only when its in-memory expected shape matches; folders and creates/removes rely on time/ID suppression.
3. **Live/reconnect/replay**: websocket ack with a higher cursor -> `replayWorkspaceDelta()` -> `GET /sync/events` -> `applyRemoteEnvelope()`; cursor gap, socket close, or apply failure -> `recoverWorkspace()` -> reconnect, replay, or full rebuild -> the first edge again.
4. **Expiry edge**: expired REST request/websocket handshake -> 401/close -> generic rejected mutation/resync or reconnect recovery. The unchanged expired session is reused, so recovery can repeatedly fail while mutation/apply state remains partially progressed.

**Survival assessment:** workspace IDs and mappings are partitioned by workspace and persist across a normal worker restart; in-memory locks, socket tokens, suppression, pending bookmark ops, and abandoned-mutation keys do not. Serialized storage does not make the Chrome mutation plus mapping checkpoint atomic. Missing mappings can reuse same-name folders/bookmarks, which is not a stable identity proof. Reconnect uses the stored cursor but can initiate full recovery; multiple workspaces have separate locks but no cross-workspace session-refresh coordination.

### Root-Cause Hypotheses (ranked)

1. **High — a full rebuild emits uncorrelated Chrome events before durable identity is checkpointed.** `doResyncWorkspace()` clears all children and `materializeFolder()`/`materializeBookmark()` create nodes, while mapping is written only after `chrome.bookmarks.create` resolves. `withSuppression()` is process-local and expires after 250 ms. Listener registration dispatches promises without serialization. A fast callback, delayed callback, or worker restart can therefore classify a projection event as local and create canonical nodes; the next rebuild repeats it. Evidence: `projection.ts:670-744, 757-788, 932-947, 2043-2062`; `bookmark-listeners.ts:42-54`.
2. **High — durable state describes neither an apply generation nor an atomic apply checkpoint.** The worker can terminate after destructive clear/create but before mappings/cursor are persisted; startup repeats bootstrap/recovery against a partial tree. Chrome documents that MV3 workers may stop after 30 seconds idle and global variables are lost. Evidence: `projection.ts:65-67, 670-744`; Chrome lifecycle documentation.
3. **High — expiry is converted into repeated resync/reconnect with no renewal.** The persisted access token is used for every REST and websocket call; `requestRaw()` only throws on 401, and socket close invokes recovery which reconnects using the same token. Evidence: `types.ts:7-12`; `api.ts:177-223`; `websocket.ts:91-98`; `projection.ts:527-534`; `auth/service.go:214-236`.
4. **Medium — the current coalescer bounds concurrent resyncs but not causal work.** It permits one rerun for every trigger and does not discard stale triggers/events after a newer snapshot begins. A cursor advance during nested recovery can reapply old history or start repeated rebuilds. Evidence: `projection.ts:568-609, 791-874`; prior remediation recorded this exact stale-replay hazard, while manual Chromium validation 4.1/4.2 remains unchecked.
5. **Medium — semantic reuse by title/URL can attach a canonical identity to the wrong Chrome node.** It prevents a duplicate in some cases but cannot distinguish same-name folders or same-title/URL bookmarks, especially after partial persistence or multiple workspaces. Evidence: `reconcileFolderChromeNode()` and `reconcileBookmarkChromeNode()` reuse nodes by visible attributes.
6. **Medium — automated tests cannot reproduce the production ordering.** `projection-behavior.test.mjs` imports compiled `dist` modules after build and its bookmark mock updates in callbacks but does not emit Chrome bookmark listener events for create/update/move/remove. Existing focused tests therefore prove helper/control-flow behavior, not listener timing, worker restart, or browser delivery semantics.

### Affected Areas

- `extension/src/background/projection.ts` — resync/recovery, durable apply state, mapping, listener correlation, queue generations, diagnostics.
- `extension/src/background/bookmark-listeners.ts` and `extension/src/background/service-worker.ts` — listener dispatch and startup/revival boundary.
- `extension/src/shared/storage.ts`, `session.ts`, `types.ts` — persisted apply checkpoint and renewable session model.
- `extension/src/shared/api.ts`, `websocket.ts` — one-shot authenticated retry, durable idempotency key use, websocket reconnect after renewal, token URL exposure removal where feasible.
- `extension/tests/projection-behavior.test.mjs`, `storage-serialization.test.mjs`, new deterministic Chrome/auth fakes — event ordering, crash/restart, convergence, and recovery proofs.
- `backend/internal/auth/*`, configuration, migrations — refresh-token family storage, rotation/revocation, session endpoints, expiry and security tests.
- `backend/internal/websocket/handler.go` — token-safe websocket authentication/reconnect contract.
- `backend/internal/sync/*` — confirm/reuse mutation IDs across retry and preserve origin/event identity.

### Approaches

1. **Add more TTL suppressions and retries** — extend current guards per event type.
   - Pros: Small apparent patch.
   - Cons: Does not survive restart, cannot prove identity, and adds more timing races. It cannot satisfy the absolute convergence requirement.
   - Effort: Medium; rejected.

2. **Convergent projection transaction + renewable session (recommended)** — make each workspace apply a desired-state reconciliation with durable ownership/identity and a checkpointed generation; make auth renewal a single-flight dependency of all REST/websocket work.
   - Pros: One set of invariants eliminates feedback rather than masking it; bounded recovery and expiry handling become explicit and testable.
   - Cons: Touches extension and backend auth; requires a migration and careful rollout.
   - Effort: High; best delivered as two chained implementation slices under one proposal.

3. **Replace the projection with a new sync engine / external queue** — rebuild broad runtime architecture.
   - Pros: Maximum design freedom.
   - Cons: Excessive scope and migration risk for a production incident; violates the requested simple solution.
   - Effort: Very High; rejected.

### Recommendation

Adopt approach 2 with these non-negotiable invariants:

- **Canonical desired state wins:** for `(workspaceId, canonical revision)`, applying the same snapshot/events N times produces one managed Chrome subtree with one Chrome node per backend ID and no backend mutation.
- **Stable identity before side effects:** persist a workspace-scoped managed-node ownership record and an apply checkpoint (`epoch`, phase, backend ID, Chrome ID, desired fingerprint, cursor) before/with each Chrome side effect; on restart, resume or reconcile that epoch instead of treating events as local. Never use title/URL as identity except as a migration candidate that must be verified and then checkpointed.
- **Explicit origin, not time:** listeners suppress only an owned, uncompleted remote operation from durable checkpoint data. An unmatched listener event is local. Correlation must include workspace, backend ID, Chrome ID, operation/fingerprint, and epoch; it must be consumed only after the intended event is observed or the actual Chrome state verifies it.
- **One bounded per-workspace work queue:** all selection, manual resync, socket, replay, and listener recovery requests enqueue intents. A newer snapshot epoch invalidates stale queued work/events; one active apply plus at most one latest desired epoch is allowed. Recovery has fixed attempt/backoff limits and transitions to degraded rather than recursively rebuilding.
- **Checkpointed reconciliation:** fetch snapshot/revision, reconcile incrementally (create/update/move/remove), persist progress/cursor after each idempotent step, then commit the epoch. Do not `clearManagedChildren` as the normal resync algorithm. A full repair is an explicit bounded fallback and still uses checkpoints.
- **Mutation idempotency survives renewal:** create a local operation record with a stable sync event ID before sending a local mutation; an expired request may be retried once after refresh with the same ID/body/base cursor, never re-created.
- **Session contract:** issue short-lived access token plus opaque, device-bound refresh token family. Store only a hash of the refresh secret server-side, rotate it on every refresh, revoke the family/device on reuse/invalid refresh, and return a generic unauthenticated state. Extension refresh is single-flight with early skew; 401 triggers exactly one refresh then exactly one original retry. Pause queue dispatch during refresh, reconnect every socket using the renewed access token, and sign out/stop mutation on refresh failure. Do not put bearer tokens in websocket URLs; prefer a header/subprotocol or a short-lived single-use websocket ticket.

This is one proposal because session expiry directly drives the sync feedback loop, but it should be **two chained slices**: (1) backend refresh contract plus extension authenticated transport/single-flight recovery; (2) durable convergent projection and deterministic browser-order tests. Each slice should remain below the supplied 800 changed-line review budget; forecast likely 650-800 authored lines total, so auto-forecast should recommend two reviewable PRs.

### Data Model / Protocol Implications

- Add a refresh-session family table keyed by device/client and user: token hash, family ID, expiry, rotation/revocation/reuse metadata; never persist raw refresh secrets in the database or logs.
- Extend `SessionData` with `refreshToken` only in extension-private storage and metadata needed for expiry/skew; do not expose it to UI state unnecessarily.
- Add `POST /auth/refresh` (rotation) and optional revoke/logout endpoint; authenticate refresh against its device family, issue a new access+refresh pair, and invalidate old token atomically.
- Add durable per-workspace projection journal/checkpoint and local-mutation outbox to extension storage. Include schema version/migration from existing mappings; invalid legacy state must enter one controlled repair epoch, not repeated deletion.
- Carry/reuse one mutation operation ID through retry; keep backend event-id idempotency authoritative. Add a websocket auth mechanism that does not disclose bearer credentials in URLs.

### Observability and Deterministic Test Strategy

- Log/measure workspace ID, epoch, snapshot revision/cursor, operation ID, origin (`local|remote|repair`), phase, mapping counts, listener disposition, recovery attempt, refresh generation, and terminal reason. Never log tokens or raw refresh identifiers.
- Add a deterministic Chrome fake that emits `onCreated/onChanged/onMoved/onRemoved` synchronously, asynchronously, reordered, duplicated, and after an injected worker restart. Assert a normalized managed tree plus mapping bijection after every schedule.
- Property-style cases: applying the same snapshot/event sequence N times is idempotent; remote operations produce zero local REST mutations; selection/resync quiesces with bounded queue/recovery counts; two workspaces remain isolated; missing mappings and partial writes converge to the canonical tree.
- Crash matrix: interrupt before side effect, after Chrome side effect/before checkpoint, after checkpoint/before cursor commit, and during repair; reload state/runtime and prove resume without duplicates.
- Auth matrix: expired access before REST, 401 during mutation, concurrent requests needing one refresh, websocket handshake/close on expiry, worker restart with valid refresh, invalid/rotated refresh, and retry verification that uses the original operation ID exactly once.
- Keep focused unit tests, but add a real Chromium manual validation for the existing unchecked update/move cases and the production selection/resync scenario; current compiled-module mock tests are insufficient as release evidence.

### Industry Alignment

Chrome requires MV3 workers to tolerate termination and says globals are lost; persistent checkpoints are therefore required, not an optimization. RFC 9700 recommends refresh-token rotation (or sender constraint) for public clients and warns that resource-owner-password credentials should not be used. Its access-token guidance also makes a bearer token in websocket query parameters undesirable because URLs are commonly exposed to logs/history. These sources support short-lived access tokens, rotating device-bound refresh credentials, single-flight renewal, and reconnect with new credentials.

### Product / Business Questions

- Is transparent renewal allowed for the full refresh-token lifetime, and what idle/absolute duration, device-management, and forced sign-out policy are required?
- Does product require logout/revocation across all devices, and must password reset revoke every refresh family?
- Is a one-time controlled repair that removes/recreates only extension-owned nodes acceptable, or must user-local edits in the managed tree always be preserved as backend mutations?
- What telemetry retention and user-visible wording are acceptable for a degraded-but-safe sync state?
- Is the backend/websocket deployment able to accept Authorization headers or subprotocol credentials, or should a short-lived websocket ticket be the first secure transport increment?

### Risks

- Refresh-token storage increases bearer-secret exposure in an extension; mitigate with opaque hashed server storage, rotation/reuse detection, TLS, minimal UI exposure, and explicit revocation.
- A durable journal migration can misclassify legacy mappings; make migration fail closed into one bounded repair and retain diagnostics.
- Incremental reconciliation is more complex than rebuild; the invariants and deterministic schedule/crash tests are mandatory acceptance criteria.
- The existing manual Chromium validation is still incomplete, so current implementation status cannot be treated as production proof.

### Ready for Proposal

**Yes.** Propose one `extension-sync-convergence-session` change with two chained slices: renewable authenticated transport first, then durable convergent projection. The proposal must make the listed invariants, bounded terminal behavior, migration/security policy, and deterministic convergence evidence explicit; it must not authorize another suppression-only patch.
