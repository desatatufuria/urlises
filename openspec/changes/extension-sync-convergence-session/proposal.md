# Proposal: Extension Sync Convergence Session

## Intent

Stop recurring duplicate Chrome/backend mutations and expired-session recovery loops by making authenticated transport renewable and projection convergence durable. Earlier symptom patches bounded particular timing paths; they could not survive MV3 worker termination or prove event ownership, so this change addresses the shared lifecycle boundary without assigning blame.

## Scope

### In Scope
- **Slice A — session transport and recovery (first):** backend refresh-session migration, rotating device-bound refresh families, refresh/revoke endpoints, and extension private session storage; one refresh single-flight, one 401 replay using the original mutation ID, pause-on-invalid refresh, and websocket authentication/reconnect after refresh.
- **Slice B — convergence engine (after A):** per-workspace durable journal, epochs, owned-operation correlation, mutation outbox, bounded queue/recovery, incremental canonical reconciliation, listener/event ownership, and explicit Retry/Rebuild UX.
- Focused backend/extension API, storage, websocket, projection/listener, migration, UX, and deterministic recovery/convergence tests; sync diagnostics that exclude secrets.

### Out of Scope
- New bookmark product features, admin-web redesign, general analytics, arbitrary sync-engine rewrite, or cross-browser support beyond current Chrome/MV3 unless required.
- Account-wide sign-out UI (a future operation); explicit sign-out revokes only this device session.

## Capabilities

### New Capabilities
- `extension-renewable-session-recovery`: renewable device sessions and safe authenticated extension recovery.
- `extension-sync-convergence`: durable, idempotent canonical projection and bounded repair.

### Modified Capabilities
- None.

## Approach

Slice A precedes Slice B so expiry failures cannot contaminate convergence evidence. Use short-lived access tokens plus opaque hashed, rotating device-bound refresh tokens; reuse revokes that family, password change/recovery revokes all user sessions, and invalid refresh preserves workspace/mapping/projection state while pausing sync and requesting login. Replace URL bearer credentials with a safer websocket mechanism.

Slice B journals ownership and apply epochs before/with Chrome effects. A latest-only per-workspace queue discards stale work; repeated snapshots/events are idempotent, local edits are queued exactly once during repair and applied only after convergence, and exhaustion pauses sync with Retry/Rebuild—not infinite retry.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `backend/internal/auth`, migrations | Modified | Refresh family lifecycle and revocation |
| `backend/internal/websocket`, `sync` | Modified | Safe auth and stable mutation identity |
| `extension/src/{shared,background}` | Modified | Session, journal, epochs, projection, listeners |
| `extension/tests` | Modified | Deterministic ordering/restart/auth proofs |
| OpenSpec docs | Modified | Proposal, later delta specs/design/tasks; Gitflow branch intent recorded downstream |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Refresh secret exposure | Med | Private storage, hashed server records, rotation/revocation, no secret logs |
| Legacy mapping misclassification | Med | Versioned migration; fail closed into one bounded repair |
| Incremental reconciliation regression | Med | Epoch/checkpoint invariants and deterministic crash/order tests |

## Rollback Plan

Feature-gate Slice A and Slice B separately. Disable Slice B to retain the prior projection path; revoke new refresh families/disable refresh issuance to force re-login while retaining selected workspace and projection state. Roll back migrations only when data-safe; otherwise retain inert session records.

## Dependencies

- Backend migration deployment and a websocket credential transport that avoids URL bearer tokens.
- Two reviewable delivery slices under the 800-line auto-forecast budget.

## Success Criteria

- [ ] Repeated snapshots/events create no duplicate Chrome or backend mutation and converge or pause.
- [ ] Recovery is bounded; worker restart resumes safely; repair-local edits apply exactly once after convergence.
- [ ] Concurrent expiry causes one refresh, one 401 replay, and websocket reconnect with renewed credentials.
- [ ] Revoked refresh preserves selected workspaces/mappings/projection, pauses sync, requests login, then reconciles after login.
