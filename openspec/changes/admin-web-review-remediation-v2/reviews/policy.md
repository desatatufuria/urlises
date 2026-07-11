# Admin Web Review Remediation v2 - Bounded Review Policy

## Review Identity

This policy authorizes one independent **HIGH** ordinary 4R review for lineage
`admin-web-review-remediation-v2`, generation `1`.

| Binding | Value |
|---|---|
| Target kind | `fix-diff` |
| Immutable base tree | `59a859834f1fd8e72ce3091a04824c1e5f9061ac` |
| Mode | `ordinary_4r` |
| Review tier | HIGH - authentication, permissions, migrations, idempotency, process controls, and more than 400 authored lines |

These and only these 18 CRITICAL predecessor findings are provenance for this
review:

- `RISK-001`, `RISK-002`, `RISK-003`
- `RESILIENCE-001`, `RESILIENCE-002`, `RESILIENCE-003`, `RESILIENCE-004`, `RESILIENCE-005`, `RESILIENCE-006`, `RESILIENCE-007`, `RESILIENCE-008`
- `RELIABILITY-001`, `RELIABILITY-002`, `RELIABILITY-003`, `RELIABILITY-004`, `RELIABILITY-005`, `RELIABILITY-006`, `RELIABILITY-007`

This is a new transaction with its own review budget. It is explicitly
independent from `admin-web-ui`, `admin-web-review-remediation`, and the
quarantined accidental lineage `x`. It MUST NOT inherit, mutate, or reuse any
of their counters, receipts, transaction state, ledgers, chains, or stores. No
prior receipt is reusable or asserted for this lineage.

## Immutable Scope

The sole review target is the immutable `snapshot.paths` v2 delta from the
bound base tree to the bound candidate. The complete candidate tree and the
canonical intended-untracked manifest provide delivery identity only; they do
not authorize reopening baseline or v1 paths outside that immutable v2 delta.

The following are out of scope:

- `openspec/changes/smtp-infrastructure/**` and all SMTP work.
- Every review mirror or store, including all paths under any `reviews/`
  directory and any authoritative review store under `.git`.
- Predecessor WARNING or SUGGESTION work and other old informational findings.
- Installed Gentle AI or other review tooling.
- Any path not present in the immutable v2 `snapshot.paths` delta.

## Requirements Under Review

Review the complete requirement blocks and scenarios in exactly these three v2
delta specifications:

1. `specs/organization-administration-safety/spec.md` - ordered migration
   reconciliation, conditional fix-forward history, owner-only administration,
   and atomic last-owner protection.
2. `specs/admin-mutation-resilience/spec.md` - authorized target-bound
   idempotency, safe replay and recovery, mutation-owned uncertain retry keys,
   and sanitized failure containment.
3. `specs/admin-access-runtime-contracts/spec.md` - fail-closed database
   evidence and visible group-grant refresh behavior.

Verify all 13 completed tasks: `1.1`-`1.2`, `2.1`-`2.3`, `3.1`-`3.2`,
`4.1`-`4.2`, and `5.1`-`5.4`. Task checkmarks are claims, not substitutes for
the three v2 specifications or runtime evidence.

## Supplied Evidence

The following execution evidence is supplied for inspection and independent
reproduction as appropriate. It is not a receipt and does not replace review:

- Full backend test and build evidence.
- Database gate evidence for all four named contracts (`4/4`) with zero skips.
- The fail-closed database-gate shell harness.
- Admin-web typecheck, 28-test suite with zero skips, and production build.

## Standard Bounded Contract

Run exactly one initial exhaustive sweep for each and only these four lenses:
**risk**, **resilience**, **readability**, and **reliability**. No additional
lens or second full sweep is permitted.

Freeze one explicit findings ledger after the four initial sweeps. Each finding
MUST have an ID, lens, location, supported severity, neutral claim, and concrete
proof reference. The frozen ledger cannot be expanded or reopened. WARNING and
SUGGESTION findings are informational only and cannot drive correction or block
approval.

Classify each severe finding exactly once. Deterministic BLOCKER or CRITICAL
evidence is corroborated directly. Only inferential severe findings may enter
exactly one detached, read-only refuter batch, with one corroborated, refuted,
or inconclusive result per submitted finding. Missing, malformed, or incomplete
evidence is inconclusive and escalates; it is never implied corroboration.

If correction is required, permit at most one correction batch followed by at
most one detached, scoped validator. The validator receives the frozen ledger
and immutable fix delta, examines only correction-touched lines, and may approve
or escalate with concrete fix-caused findings. It cannot reopen the original
delta or start another review loop.

Final verification is independent requirements and runtime verification of the
current candidate, all three v2 specifications, supplied scenario evidence,
frozen-ledger resolution, immutable snapshot identity, provenance, and counter
coherence. It cannot launch or repeat a review, refuter, correction, or scoped
validation. Only `approved` and `escalated` are terminal states.

## Operating Boundary

Review actors are detached and read-only. They do not edit code or tests, alter
SDD implementation artifacts, mutate review stores or ledgers, change Git state,
launch other actors, or choose lifecycle routing. Model, provider, profile, and
effort remain user-owned choices.
