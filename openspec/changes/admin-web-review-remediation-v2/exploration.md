# Exploration: admin-web-review-remediation-v2

### Current State
The prior lineage is immutable and must remain untouched. Its frozen severe findings are correctable only through a distinct lineage: its original genesis omitted `000003`, while the migrator sorts filenames, records only filenames (no checksum), and skips every recorded filename. Today `000003` creates the pending-invitation unique index before `000004` can reconcile legacy rows; the migration test explicitly applies `000001` and `000002`, then jumps to `000004`, so it cannot prove the production ordering.

The idempotency executor replays a completed record before the service callback, and handler identities fingerprint only route template plus body. Thus a revoked principal can replay and the same key/body can alias different path targets. Admin-web API wrappers create a default key per invocation, while React Query mutation functions do not own a key across an uncertain retry. The DB-contract script omits `httpapi`, accepts generic `PASS` output rather than named execution evidence, and the idempotency integration test creates a hand-written table instead of applying production migrations. Error middleware lacks `recover`, accepts any printable caller request ID, and API cleanup logs the wrapped pgx error verbatim.

### Affected Areas
- `backend/migrations/000003_admin_remediation.sql` — required historical-unapplied path: reconcile before its unique index.
- `backend/migrations/000005_admin_remediation_v2_fix_forward.sql` — new applied-history path: idempotently reconcile and ensure constraints/indexes without rewriting recorded migrations.
- `backend/internal/database/migrator.go` and `backend/internal/database/migrator_test.go` — prove filename ordering and filename-only/no-checksum semantics against a production-like schema; do not change migrator behavior unless the test exposes a separate defect.
- `backend/internal/organizations/remediation_integration_test.go` — replace the skip-over-`000003` migration scenario with the full production migrator sequence from `000002` legacy data.
- `backend/internal/httpapi/idempotency.go` and `{idempotency,idempotency_integration}_test.go` — authorize before lookup/replay; bind canonical target values into identity and fingerprint; use migrated schema rather than a hand-written table.
- `backend/internal/{organizations,groups,workspaces}/{handler,handler_test,service}.go` — pass route-specific transaction authorization and canonical targets for all five keyed POST routes; exercise successful keyed routes.
- `backend/cmd/api/main.go`, `backend/internal/httpapi/{errors,errors_test,httpapi}.go` — recover panics to sanitized 500 responses, generate safe server request IDs, and emit cleanup failures without raw database text.
- `scripts/verify-admin-db-contracts.sh` and `scripts/verify-admin-db-contracts_test.sh` — include `httpapi`; require explicit, named, non-skipped markers from every contract package.
- `admin-web/src/lib/api/{client,client.test,groups,organizations,workspaces}.ts` and `admin-web/src/features/{groups,members,workspaces}/mutations.ts` — make the mutation attempt, not API-wrapper defaulting, own and retain a creation key until confirmed success or explicit new intent.
- `admin-web/src/features/access/AccessPage.test.tsx` — cover new group-grant creation followed by refetch/render of the grant.

### Expanded Future Review Genesis Paths
The new lineage MUST snapshot every path above, including new files, plus only these direct dependencies:

```
backend/migrations/000003_admin_remediation.sql
backend/migrations/000005_admin_remediation_v2_fix_forward.sql
backend/internal/database/migrator.go
backend/internal/database/migrator_test.go
backend/internal/organizations/remediation_integration_test.go
backend/internal/httpapi/idempotency.go
backend/internal/httpapi/idempotency_test.go
backend/internal/httpapi/idempotency_integration_test.go
backend/internal/httpapi/errors.go
backend/internal/httpapi/errors_test.go
backend/internal/httpapi/httpapi.go
backend/cmd/api/main.go
backend/internal/organizations/handler.go
backend/internal/organizations/handler_test.go
backend/internal/organizations/service.go
backend/internal/groups/handler.go
backend/internal/groups/handler_test.go
backend/internal/groups/service.go
backend/internal/workspaces/handler.go
backend/internal/workspaces/handler_test.go
backend/internal/workspaces/service.go
scripts/verify-admin-db-contracts.sh
scripts/verify-admin-db-contracts_test.sh
admin-web/src/lib/api/client.ts
admin-web/src/lib/api/client.test.ts
admin-web/src/lib/api/groups.ts
admin-web/src/lib/api/organizations.ts
admin-web/src/lib/api/workspaces.ts
admin-web/src/features/groups/mutations.ts
admin-web/src/features/members/mutations.ts
admin-web/src/features/workspaces/mutations.ts
admin-web/src/features/access/AccessPage.test.tsx
```

The review must start only after implementation, as a new lineage with this complete genesis snapshot. It MUST NOT reuse old counters, mirrors, transaction state, or review store.

### Approaches
1. **Rewrite only `000003`** — reconcile before its index.
   - Pros: fixes fresh databases at the exact failure point.
   - Cons: recorded `000003` is skipped forever; no remedy for already-applied deployments.
   - Effort: Low, but insufficient.

2. **Forward-only `000005`** — leave `000003` unchanged.
   - Pros: preserves applied history.
   - Cons: a database at `000002` still executes the unsafe `000003` first and fails.
   - Effort: Medium, but insufficient.

3. **Dual-path, fix-forward (recommended)** — amend `000003` to reconcile before its index and add idempotent `000005` to reconcile/ensure the same invariant for environments where old `000003` is already recorded.
   - Pros: correct for fresh/unapplied `000003`; safe for recorded `000003`; respects filename ordering and absence of checksums; no silent history corruption.
   - Cons: requires real migration-sequence evidence and careful idempotent SQL.
   - Effort: Medium.

### Recommendation
Use approach 3. `000003` must expire stale pending rows and deterministically cancel all but the newest eligible `(organization_id, lower(email))` row before creating its partial unique index. `000005` must repeat that safe reconciliation and `CREATE UNIQUE INDEX IF NOT EXISTS` as a forward repair; it must not delete data or alter `schema_migrations`. Test two states: (a) legacy duplicates at `000002` followed by `database.Migrate`, proving `000003` succeeds; (b) a schema with old `000003` recorded, then `database.Migrate`, proving only `000005` supplies the forward repair. The current migrator has filename ordering and no checksum validation, so changing an already-recorded `000003` has no deployment effect; that is precisely why `000005` is mandatory.

At the executor boundary, add an authorization callback executed inside the same transaction after the advisory lock and before record lookup/replay. Each handler supplies a non-mutating, route-target-specific authorization check; command mutation remains the existing `...Tx` callback. Canonicalize UUID path values into the identity route key and hash stable JSON `{canonicalTarget, typedRequest}`. This prevents target aliasing in both the uniqueness lookup and fingerprint.

Generate server-owned opaque request IDs rather than reflecting arbitrary caller values. Wrap the downstream handler with `defer recover`, return the existing generic 500 envelope if headers are not committed, and log exactly one sanitized event. Replace the cleanup `log.Printf(... %v, err)` path with a fixed structured failure event that carries no database error text.

For the frontend, generate a key when a create mutation begins and retain it in mutation-owned retry state; reuse it only for an uncertain retry, then clear it on confirmed response or explicit reset/new submission. Do not apply this to PUT/PATCH/DELETE grants. Keep the existing access-query invalidation and add the missing UI scenario for a newly created group grant.

### ID-to-Work-Unit Map
| Work unit | Frozen IDs | Scope and focused evidence | Runtime evidence / rollback | Likely changed lines |
|---|---|---|---|---:|
| 1. Ordered migration dual path | RISK-003, RESILIENCE-001, RELIABILITY-006 | Full migrator test from legacy `000002` duplicates; recorded-old-`000003` forward test; `go test ./internal/database ./internal/organizations -run 'Test.*Migration' -count=1` | Fresh schemas run `database.Migrate` through `000005`, zero skips. Roll back Go tests only; SQL is forward-corrected, never reverted after apply. | 180–260 |
| 2. Authorized target-bound idempotency | RISK-001, RISK-002, RESILIENCE-002, RELIABILITY-001, RELIABILITY-005 | Table-driven canonical-target/fingerprint tests; successful keyed handler route table for five POSTs; replay after authorization revocation returns forbidden/no replay. | PostgreSQL production-migration schema: five create/replay paths, target isolation, one mutation, zero skips. Roll back executor/handler/service changes together; schema stays forward. | 380–500 |
| 3. Production DB evidence gate | RESILIENCE-004, RESILIENCE-005, RELIABILITY-003, RELIABILITY-004 | Shell harness rejects absent/unreachable/skipped/missing-marker output and accepts all named markers; `httpapi` included. | `ADMIN_TEST_DATABASE_URL=... bash scripts/verify-admin-db-contracts.sh` proves named execution markers and zero skips. Roll back script/harness and marker tests together. | 100–150 |
| 4. Failure containment and redaction | RESILIENCE-006, RESILIENCE-007, RESILIENCE-008 | `go test ./internal/httpapi -run 'Test(ErrorMiddleware|UnexpectedFailure|Panic|RequestID|Cleanup)' -count=1`; assert panic 500, no supplied sensitive ID, and no pgx error text. | `httptest` panic and failing cleanup path produce one sanitized event. Roll back middleware/main/error tests together. | 100–150 |
| 5. UI retry ownership and group grant | RESILIENCE-003, RELIABILITY-002, RELIABILITY-007 | Mutation-level uncertain retry retains one key, new intent rotates it; AccessPage creates a group grant then refetches/renders it. | `cd admin-web && npm run test -- --run` plus typecheck/build. Roll back mutation/API/test files only. | 180–250 |

### Forecast
**One PR under 1,600 lines is credible, but not yet approved.** Estimated authored change: **940–1,310 lines** (including tests and SQL). The largest uncertainty is the five-route authorization harness; if it exceeds the upper bound, implementation must stop for a new delivery decision rather than take an exception. Work units remain independent rollback boundaries inside one PR.

Decision needed before apply: No
Chained PRs recommended: No
400-line budget risk: High

### Risks
- Historical migration edits are safe only because `000005` covers recorded `000003`; deployment-state tests must prove both paths.
- Authorization checks must be transaction-aware and target-specific; a handler-only precheck reintroduces replay-after-revocation risk.
- A panic after response commitment cannot be converted to a valid JSON 500; middleware must avoid a second write and only log safely.
- Browser retry UX needs an explicit definition of uncertain failure; keys must not survive a confirmed completion or become a permanent client-side ledger.
- Do not expand into the 25 informational findings, SMTP, unrelated baseline, old review artifacts/stores, or tooling.

### Ready for Proposal
Yes. Create proposal/spec/design/tasks only after preserving this expanded genesis path set and the dual-path migration decision. Future review starts post-implementation in a new distinct lineage; the frozen `admin-web-review-remediation` lineage remains immutable.
