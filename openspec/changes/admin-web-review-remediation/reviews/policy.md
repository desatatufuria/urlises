# Admin Web Review Remediation — Bounded Review Policy

## Review identity and decision

This policy authorizes one independent **HIGH** ordinary 4R review for lineage
`admin-web-review-remediation`, generation `1`.

| Binding | Value |
|---|---|
| Target kind | `fix-diff` |
| Immutable base tree | `b32c28fd52adbe62f92a74b12fa1b1ecaaaaea42` |
| Mode | `ordinary_4r` |
| Review tier | HIGH — permissions, owner invariants, migrations, idempotency, server-error reporting, and more than 400 authored lines |
| Provenance IDs | `RELIABILITY-005`, `RELIABILITY-006`, `RELIABILITY-009`, `RELIABILITY-010`, `RELIABILITY-012`, `RELIABILITY-014`, `RESILIENCE-002`, `RESILIENCE-005`, `RISK-001` |

This is a new transaction with its own review budget. It MUST NOT inherit,
mutate, or reuse any `admin-web-ui` transaction counters, state, chain, or
receipt. No receipt is asserted to exist.

## Immutable scope

The native snapshot MUST bind the complete delivered candidate tree and the
canonical intended-untracked proof. Reviewers MUST inspect only the immutable
`snapshot.paths` delta from the bound base tree to that candidate. The full
candidate remains the delivery binding; it is not permission to reopen the
pre-existing baseline outside the delta.

Out of scope: `openspec/changes/smtp-infrastructure/**`, all `**/reviews/**`
mirrors or stores, unrelated prior WARNING/SUGGESTION findings, and installed
Gentle AI tooling.

## Requirements under review

Review the following remediation requirements and their scenarios:

1. **Organization administration safety** — active invitation visibility,
   stable invalid/conflict handling, deterministic legacy duplicate/expiry
   reconciliation before uniqueness enforcement, conditional forward migration
   history, owner-only promotion, and atomic preservation of at least one owner.
2. **Administrative mutation resilience** — persisted creation idempotency by
   principal/route/key/fingerprint, replay, conflict, deterministic concurrent
   handling, failed-claim recovery, UI retry-key reuse, and sanitized 500
   responses with redacted structured diagnostics.
3. **Admin access runtime contracts** — fail-closed PostgreSQL evidence with
   executed non-skipped contracts, visible group-grant refresh, and protected
   route recovery to login after restoration failure.

The fourteen completed-task claims to verify are: U1 `1.1`–`1.5`, U2 `2.1`–
`2.2`, U3 `3.1`–`3.2`, and U4 `4.1`–`4.5`. Review against the three delta
specifications, not against task checkmarks alone.

## Evidence supplied for verification

Treat the following as supplied execution evidence to inspect and reproduce as
appropriate; it is not a receipt and does not replace independent review:

- Backend Go test and build evidence.
- The fail-closed database-contract script executed through the PostgreSQL
  gateway, with execution markers and zero skipped contract suites.
- Frontend typecheck, 27-test suite, and production build evidence.

## Bounded lifecycle

Run exactly one exhaustive sweep for each and only these four lenses: **risk**,
**resilience**, **readability**, and **reliability**. No additional lens or
second full sweep is permitted.

Freeze one explicit findings ledger after those sweeps. Each finding MUST carry
an ID, lens, location, supported severity, neutral claim, and concrete proof
reference. WARNING and SUGGESTION findings are `info` only: they neither drive
correction nor block approval.

Classify every BLOCKER/CRITICAL finding exactly once. Deterministic evidence is
corroborated and correction-bound. Inferential evidence goes to exactly one
detached, read-only refuter batch, which returns one corroborated, refuted, or
inconclusive result per finding. Insufficient, malformed, or incomplete
evidence is inconclusive and escalates; it is never implied corroboration.

If correction is required, the transaction permits one correction batch and
one detached scoped fix-delta validation only. The scoped validator receives
the frozen ledger and immutable fix delta, examines fix-touched lines only,
and may approve or escalate with concrete fix-caused findings. It cannot reopen
the original diff or start another loop.

Final verification is independent requirements/runtime verification of the
current candidate, scenario evidence, frozen-ledger resolution, snapshot
identity, and counter coherence. It cannot launch another review, refuter,
correction, or scoped-validation loop. Only `approved` and `escalated` are
terminal transaction states.

## Operating boundary

Review actors are detached and read-only. They do not edit code, start review
transactions, mutate a ledger, launch other actors, or choose lifecycle
routing. Model, provider, profile, and effort remain user-owned choices.
