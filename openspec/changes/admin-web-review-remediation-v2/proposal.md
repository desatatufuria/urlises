# Proposal: Admin Web Review Remediation v2

## Intent

Successor amendment to blocked `admin-web-review-remediation`: correct all 18 frozen severe findings without mutating its review counters, transaction, store, or mirror. The approved outcome keeps every deployment migration-safe, prevents unauthorized or cross-target replay, contains failures safely, and makes retry intent explicit.

## Scope

### In Scope
1. **Ordered dual migration** — `000003` reconciles legacy rows before its index when unapplied; new idempotent `000005` fix-forwards environments that recorded the old `000003`. Prove both migration states.
2. **Authorized target-bound idempotency** — reauthorize inside the transaction before lookup/replay; revoked replay returns 403 without stored content; canonical targets join identity/fingerprint; test all five keyed POST routes on production migrations.
3. **Production DB evidence gate** — include `httpapi`; reject absent, unreachable, skipped, or unnamed contract evidence.
4. **Failure containment** — recover panics to sanitized 500s, accept caller `X-Request-ID` only when a valid UUID (otherwise generate one), and log cleanup failure without raw database text.
5. **Explicit UI retry and grant evidence** — mutation-owned creation key persists only for uncertain retry, resets for new intent/confirmation, and group-grant creation refetches and renders. No update/delete expansion.

### Out of Scope
- The 25 informational findings, SMTP, broad refactors, tooling changes, and old review-store mutation.
- Commit or PR creation before a new post-implementation review receipt.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `organization-administration-safety`: migration reconciliation and conditional history.
- `admin-mutation-resilience`: authorized target-bound replay, retry ownership, and containment.
- `admin-access-runtime-contracts`: DB execution evidence and visible group grants.

v2 specs MUST copy each full predecessor requirement block before editing; no unrelated duplicate capabilities.

## Approach

Deliver the five units above, mapping frozen IDs: migration `RISK-003, RESILIENCE-001, RELIABILITY-006`; idempotency `RISK-001, RISK-002, RESILIENCE-002, RELIABILITY-001, RELIABILITY-005`; DB gate `RESILIENCE-004, RESILIENCE-005, RELIABILITY-003, RELIABILITY-004`; containment `RESILIENCE-006..008`; UI `RESILIENCE-003, RELIABILITY-002, RELIABILITY-007`. Forecast: 940–1,310 authored lines. Prefer one PR within 1,600; exceeding it requires an explicit new delivery decision, never a silent exception.

## Review Lineage and Dependencies

After implementation, explicitly start the distinct new review lineage only when no valid receipt exists. Its genesis snapshots every correction path in `exploration.md`, explicitly `backend/migrations/000003_admin_remediation.sql`, new `backend/migrations/000005_admin_remediation_v2_fix_forward.sql`, migration/idempotency/error/handler-service tests, DB harness, and admin-web API/mutation/access evidence. The receipt is produced only after review approval/final verification; no commit or PR occurs until it passes `review-validate`. It never reuses predecessor review state.

## Risks and Rollback

Migration state is decisive: amend `000003` only for unapplied history; `000005` is the durable fix-forward and applied SQL is not rolled back. Revert each non-SQL work unit with its tests; prove authorization occurs after the transaction lock and before replay. A committed panic response is logged safely, not rewritten.

## Success Criteria

- [ ] Both migration states reach the invariant through `000005` with no skips.
- [ ] Five POST routes allow one authorized creation; revoked replay is 403 with no response disclosure or target aliasing.
- [ ] DB gate produces named, non-skipped evidence including `httpapi`.
- [ ] Panic, request-ID, and cleanup paths expose no sensitive diagnostics.
- [ ] Uncertain retry retains its key; new group grants render after refetch.
