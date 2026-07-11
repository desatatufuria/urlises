# POC Final Review Policy

## Lineage

This is review lineage `poc-feature-finalization`, generation 1, targeting `current-changes`.

This lineage is independent from and supersedes the delivery scope of the old `admin-web-ui`, `admin-web-review-remediation`, `admin-web-review-remediation-v2`, `smtp-infrastructure`, and accidental `x` lineages. It does not mutate those lineages.

## Immutable Review Target

The review target is the final current dirty candidate. It is immutable for this review: reviewers inspect only the paths listed in the frozen `snapshot.paths` ledger. No path outside that ledger is in scope.

## POC Acceptance Boundary

The normal user path must work end to end:

- Compose service reachability.
- Backend authentication, organization, workspace, group, and access behavior.
- Admin browser proxy behavior and displayed backend state.
- SMTP adapter behavior and a Mailpit smoke path.

Do not escalate solely because extreme or rare edge cases are unexercised, because of code aesthetics, robustness hardening opportunities, or historical informational review findings. Record those observations as `WARNING` or `SUGGESTION` information only.

A demonstrable functional or security defect that breaks the normal POC path, including data loss or an authentication bypass, remains a `BLOCKER` or `CRITICAL` finding.

## Required Lifecycle

The target is HIGH risk because it includes authentication, permissions, migrations, idempotency, networking, and more than 400 lines of change.

Run the full ordinary_4r review exactly once. Maintain one frozen ledger and follow the standard bounded lifecycle, allowing at most one correction, one scoped validation, and one final verification.

## Supplied Evidence

- Backend: `go test ./...` and build.
- Admin: typecheck, 28 tests, and build.
- Database gate.
- SMTP smoke.
- Manual authentication, organization, workspace, and group-access flow.
- The admin proxy runs Vite with `/api`.
