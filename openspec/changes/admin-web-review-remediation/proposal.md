# Proposal: Admin Web Review Remediation

## Intent

Resolve ten verified admin-web safety, resilience, and evidence gaps in a new `admin-web-review-remediation` lineage. It links to the immutable `admin-web-ui` transaction; it never resumes or mutates it.

## Scope

### In Scope
- Invitation expiry filtering, email/member validation, and deterministic duplicate-pending reconciliation.
- Conditional migration reconciliation, owner-only promotion, and atomic PostgreSQL last-owner protection.
- Persisted idempotency with retry-stable UI keys; sanitized structured 5xx server logs.
- Fail-closed PostgreSQL contract execution plus group-grant creation and post-restoration auth-routing tests.

### Out of Scope
- SMTP, external monitoring/Sentry, broad auth or observability refactors.
- Old review records, `admin-web-ui`, `smtp-infrastructure`, and unrelated WARNING/SUGGESTION findings.

## Capabilities

### New Capabilities
- `organization-administration-safety`: invitation lifecycle and owner-transition invariants; needed for new behavioral requirements.
- `admin-mutation-resilience`: persisted idempotency and sanitized 5xx reporting; needed for retry and failure contracts.
- `admin-access-runtime-contracts`: fail-closed database evidence and access/auth UI behavior; needed for executable acceptance scenarios.

### Modified Capabilities
None; `openspec/specs/` has no applicable admin capability.

## Approach

Create isolated remediation/provenance artifacts and one future single-PR correction, split into independently reversible work units. First inventory `000003` deployment state: if unapplied to shared environments, reconcile expired/duplicate rows before its index; if possibly applied, add a forward migration only. Retain the newest deterministic duplicate; cancel/expire older records. Persist idempotency by principal, route, key, and request fingerprint; replay completed safe responses and keep one frontend key across retries.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `backend/internal/organizations/` | Modified | Invitations, ownership, concurrency, PostgreSQL tests |
| `backend/migrations/` | Modified/New | State-dependent reconciliation |
| `backend/internal/httpapi/`, `cmd/api/main.go` | Modified | Sanitized 5xx logs, idempotency boundary |
| `admin-web/src/`, `scripts/verify-admin-db-contracts.sh` | Modified | Stable keys and missing fail-closed/UI evidence |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Migration history drift | High | Inventory first; use forward migration if uncertain |
| 1,350–1,700 changed lines | High | Reviewable units; apply needs explicit maintainer decision if final forecast exceeds 1,600 or the conventional guard requires it |

## Rollback Plan

Revert only the corresponding work unit and its tests/log middleware. Do not reverse an applied data migration blindly; use a reviewed forward corrective migration. Preserve old lineage and SMTP untouched.

## Dependencies

- Migration deployment inventory; PostgreSQL integration environment.
- Gitflow intent: future isolated remediation branch and single PR; documentation impact is this proposal and later delta specs.

## Success Criteria

- [ ] All ten verified issues have focused passing PostgreSQL, backend, script, and UI evidence.
- [ ] Expired/duplicate invitations, owner concurrency, idempotent retries, and protected-route redirect satisfy specified contracts.
- [ ] Contract command fails without its required database URLs; 5xx logs contain no secrets.
