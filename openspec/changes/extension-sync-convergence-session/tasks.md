# Tasks: Extension Sync Convergence Session

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated authored changed lines | 3,480–4,610 |
| 400-line budget risk | High |
| Delivery / chain | auto-forecast / stacked-to-main; each unit merges to `develop` before the next starts |
| Units | PR1a → PR1b-auth → PR1b-ticket → PR1b-ws-upgrade → PR2a → PR2b → PR3 → PR4h 250–350 → PR4h2 120–220 → PR4a1a-create 250–350 → PR4a1a-delete 250–350 → PR4a1b 250–350 → PR4a2 300–400 → PR4b 350–400 |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Progress: 26/34. PR4a1a-create is complete; delete ownership follows.

```text
develop ← PR1a ← PR1b-auth ← PR1b-ticket ← PR1b-ws-upgrade ← PR2a REST ← PR2b WS/TTL ← PR3 journal ← PR4h harness ← PR4h2 harness fidelity ← PR4a1a-create ← PR4a1a-delete ← PR4a1b update/move ← PR4a2 outbox ← PR4b repair
```

| Unit | Start → end; out of scope | Focused test; runtime harness | Rollback boundary |
|---|---|---|---|
| PR1a–PR2b | Completed session work. | Recorded in completed evidence. | Completed-unit boundaries. |
| PR3 | Completed dormant journal; legacy projection unchanged. | `cd extension && npm run build && node --test tests/convergence.test.mjs`; fake-storage restart. | Journal/module/types/gate. |
| PR4h | PR3 → deterministic ownership harness; no production code or PR4 behavior assertions. | `cd extension && npm run build && node --test tests/chrome-harness.test.mjs`; event-mode/restart/no-handle self-tests. | Test helpers and harness self-tests. |
| PR4h2 | PR4h → faithful fake Chrome self-tests/fixes only; no production source or ownership behavior. | `cd extension && npm run build && node --test tests/chrome-harness.test.mjs`; reset/order/timer/clone/listener/no-handle scenarios. | `fake-chrome.mjs` and chrome-harness self-tests. |
| PR4a1a-create | PR4h2 → durable folder/bookmark create ownership; no delete/update/move/outbox/resync replacement. | `cd extension && npm run build && node --test tests/convergence.test.mjs`; create early/delayed/duplicate/restart. | Create ownership, correlation, and tests. |
| PR4a1a-delete | PR4a1a-create → durable folder/bookmark delete ownership; no update/move/outbox/resync replacement. | `cd extension && npm run build && node --test tests/convergence.test.mjs`; remove early/delayed/duplicate/restart. | Delete ownership, correlation, and tests. |
| PR4a1b | PR4a1a-delete → durable update/move ownership; no outbox/controls. | `cd extension && npm run build && node --test tests/convergence.test.mjs`; fake Chrome update/move reorder/restart. | Update/move ownership and gated wiring. |
| PR4a2 | PR4a1b → durable local-intent outbox/replay; no controls or destructive-resync removal. | `cd extension && npm run build && node --test tests/convergence.test.mjs`; fake Chrome repair/auth/restart. | Outbox/replay wiring and gated engine. |
| PR4b | PR4a2 → repair controls/enablement; no unrelated bookmarks. | `cd extension && npm run build && node --test tests/convergence.test.mjs`; Chromium Retry/Rebuild. | Controls, enablement, destructive-normal-resync removal. |

## Phase 1: PR1a — Refresh-family persistence/domain (complete)
- [x] 1.1 RED: hash-only rotation and response-loss.
- [x] 1.2 RED: reuse, revocation, and secret safety.
- [x] 1.3 Add persistence/domain only.
- [x] 1.4 Record DB and rollback evidence.

## Phase 2: PR1b-auth — Capability-gated auth endpoints (complete)
- [x] 2.1 RED: capability and refresh/logout errors.
- [x] 2.2 Wire endpoints; exclude WebSocket work.
- [x] 2.3 Record auth and rollback evidence.

## Phase 3: PR1b-ticket — Ticket issue and persistence (complete)
- [x] 3.1 RED: expiry, one-use, binding, and secrecy.
- [x] 3.2 Add `000007`, domain, and issue endpoint.
- [x] 3.3 Record DB and rollback evidence.

## Phase 4: PR1b-ws-upgrade — Ticket-consuming upgrade (complete)
- [x] 4.1 RED: protocol, authorization, legacy, and secrecy.
- [x] 4.2 Wire handler; preserve legacy path.

## Phase 5: PR2a — Extension renewable REST session (complete)
- [x] 5.1 RED: private session, refresh/replay, restart/pause.
- [x] 5.2 Implement REST coordinator and wiring.
- [x] 5.3 Record Chromium and rollback evidence.

## Phase 6: PR2b — Extension ticket WebSocket and TTL cutover (complete)
- [x] 6.1 RED: ticket transport, reconnect, pause, secrecy.
- [x] 6.2 Wire cutover and 15m TTL; retain legacy route.
- [x] 6.3 Record Chromium and rollback evidence.

## Phase 7: PR3 — Dormant convergence planner/journal (complete)
- [x] 7.1 RED: planner, queue, cap, migration, ambiguity.
- [x] 7.2 Add gated journal/checkpoints and evidence.

## Phase 8: PR4h — Deterministic Chrome ownership harness

Candidate paths: `extension/tests/{helpers/fake-chrome,convergence}.mjs`, `extension/package.json`.

- [x] 8.1 RED: self-test structured-cloned persistence, one callback mode at a time, before/after/delayed/duplicate/reordered delivery, workspace trees, module/runtime reset, and zero open timers/sockets; add no PR4 behavior assertions.
- [x] 8.2 Build reusable fake Chrome bookmarks/storage/runtime bus with controllable mutator promises, explicit timer/socket teardown, persisted-worker reload, and backend fetch/mutation recording utilities; keep the suite green without skipped/failing cases.

## Phase 9: PR4h2 — Chrome harness fidelity hardening

Candidate paths: `extension/tests/{helpers/fake-chrome,chrome-harness.test}.mjs`, `extension/package.json` only if a script correction is required.

- [x] 9.1 RED: prove queued delayed events survive persisted runtime reset; `after` follows a Promise continuation; duplicates capture count at schedule time; timer flush snapshots recurring/new timers; revived local/session/tree values are isolated structured clones; explicit numeric seed IDs never collide; fetch counts only bookmark/folder writes; changed/moved/removed payload/order and `removeListener` are faithful; production reload hook only if practical; teardown leaves zero handles.
- [x] 9.2 Fix only fake Chrome helper/self-tests to satisfy 9.1, including event queues, timer flushing, clone revival, ID allocation, fetch filtering, listener removal, and teardown; add no production source or ownership assertions.

## Phase 10: PR4a1a-create — Durable create ownership

Candidate paths: `extension/src/background/{projection,bookmark-listeners,convergence}.ts`, `extension/src/shared/{types,storage}.ts`, `extension/tests/convergence.test.mjs`.

- [x] 10.1 RED: prove remote folder/bookmark create persists `started` before mutation; `onCreated` early/delayed/duplicate/restart correlation, final parent/type/title/url/index verification, workspace isolation, and unmatched local create exactly once.
- [x] 10.2 Add create-only journal ownership and `onCreated` correlation; checkpoint only after final verification while retaining unmatched-local create exactly once. Exclude delete/update/move/outbox/resync replacement.

## Phase 11: PR4a1a-delete — Durable delete ownership

Candidate paths: `extension/src/background/{projection,bookmark-listeners,convergence}.ts`, `extension/src/shared/{types,storage}.ts`, `extension/tests/convergence.test.mjs`.

- [x] 11.1 RED: prove remote folder/bookmark delete persists `started` before mutation; `onRemoved` early/delayed/duplicate/restart correlation, mapping/absence verification, workspace isolation, and unmatched local delete exactly once.
- [x] 11.2 Add delete-only journal ownership and `onRemoved` correlation; checkpoint only after mapping/absence verification while retaining unmatched-local delete exactly once. Exclude update/move/outbox/resync replacement.

## Phase 12: PR4a1b — Durable update/move ownership

Candidate paths: `extension/src/background/{projection,bookmark-listeners,convergence}.ts`, `extension/src/shared/{types,storage,api}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 12.1 RED: fake Chrome bus emits changed/moved before resolution and delayed, duplicate, reordered callbacks; prove final parent/index/title/url verification, restart, and workspace isolation.
- [ ] 12.2 Persist `started` before remote folder/bookmark update/move; correlate `onChanged`/`onMoved`, replace covered process-local pending operations after final verification, and keep planner/engine gated without an outbox.

## Phase 13: PR4a2 — Durable local intent outbox and exact-once replay

Candidate paths: `extension/src/background/{projection,bookmark-listeners,convergence}.ts`, `extension/src/shared/{types,storage,api}.ts`, `extension/tests/convergence.test.mjs`.

- [ ] 13.1 RED: local edits during repair, auth pause, and restart retain stable IDs; prove one replay/request, ack checkpoint, cap, and workspace isolation.
- [ ] 13.2 Queue unmatched local events during active repair; replay through existing idempotency headers once after convergence and resume after auth/restart, retaining the off gate and excluding Retry/Rebuild UI.

## Phase 14: PR4b — Repair controls and enablement

Candidate paths: `extension/src/background/{projection,convergence}.ts`, `extension/src/{shared,ui}/**`, `extension/tests/convergence.test.mjs`.

- [ ] 14.1 RED: ambiguous duplicates pause; bounded three-attempt recovery, scoped Retry/Rebuild, auth-checkpoint resume, and no destructive normal resync.
- [ ] 14.2 Add controls/backoff/auth resume; remove destructive normal resync and enable only after invariants/evidence pass.
