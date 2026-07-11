# Delta for Organization Administration Safety

## MODIFIED Requirements

### Requirement: Deterministic Invitation Reconciliation

The system MUST reconcile legacy expired and duplicate pending invitations deterministically before enforcing invitation uniqueness. It MUST retain the newest eligible duplicate and cancel or expire older duplicates. The reconciliation MUST produce the same newest survivor for equivalent legacy rows.
(Previously: Reconciliation required a deterministic newest survivor before uniqueness enforcement.)

#### Scenario: Reconcile legacy duplicates

- GIVEN multiple pending invitations exist for one organization and email
- WHEN reconciliation runs before uniqueness enforcement
- THEN the newest eligible invitation remains and older duplicates are inactive

#### Scenario: Reconcile expired rows

- GIVEN a pending invitation is expired during reconciliation
- WHEN uniqueness enforcement is prepared
- THEN the expired invitation is inactive and cannot block a new invitation

### Requirement: Conditional Migration History

The system MUST reconcile within migration `000003` before its unique index when `000003` is unapplied. It MUST provide idempotent `000005` to fix forward environments that already recorded `000003`. Ordered migration execution from pre-`000003` and post-`000003` states MUST reach the invariant without skips. The system MUST NOT manually alter `schema_migrations` or rewrite recorded migration history.
(Previously: Inventory determined whether to amend an unapplied historical migration or use a forward migration.)

#### Scenario: Historical migration is unapplied

- GIVEN inventory proves the relevant migration is unapplied in shared environments
- WHEN the migration is prepared
- THEN reconciliation precedes its uniqueness enforcement

#### Scenario: Historical migration may be applied

- GIVEN inventory cannot prove the historical migration is unapplied
- WHEN remediation is prepared
- THEN a forward migration is used and applied history is unchanged

#### Scenario: Migrate from before 000003

- GIVEN legacy invitation rows exist before `000003`
- WHEN ordered migrations run through `000005`
- THEN `000003` reconciles before uniqueness and migration succeeds

#### Scenario: Fix forward recorded 000003

- GIVEN `000003` is already recorded with legacy rows requiring reconciliation
- WHEN ordered migrations continue through `000005`
- THEN `000005` establishes the invariant without editing migration history
