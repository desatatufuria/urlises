# Apply Progress: Extension Sync Convergence Session

## Cumulative Status

4/21 tasks complete: PR1a tasks 1.1–1.4. The approved delivery remains stacked-to-`develop`, with no `size:exception`.

## Preserved Prior Apply Attempt

The original unsplit PR1 was blocked at 0/4 because its combined migration, domain, handlers, tickets, PostgreSQL coverage, and documentation forecast 685–900 authored lines (the design estimated Slice A at ~510). The replanned 21-task chain split it into PR1a/PR1b; this record preserves that decision.

## PR1a Completion

- [x] 1.1 RED PostgreSQL migration/domain test written and run before production code.
- [x] 1.2 RED invalid/reuse/logout/revoke-all/secret-safety cases run.
- [x] 1.3 Added inert hash-only family/token persistence and service revocation operation.
- [x] 1.4 Recorded migration, runtime, security, and rollback evidence.

### Contracts

- `refresh_families` binds a user to the existing durable device; `refresh_tokens` stores only SHA-256 hashes, rotation count, retry metadata, and revocation timestamps.
- Initial and child credentials are deterministic HMAC values using the server secret; no plaintext credential is persisted.
- Rotation locks token/family rows. A matching retry within 60 seconds returns the same child; a late or different attempt revokes the family and returns `ErrUnauthorized`.
- `Logout` revokes only the token's family. `Service.RevokeAllRefreshFamilies` updates all user families in one transaction.
- No HTTP, login/register response, WebSocket, ticket, extension, or access-TTL behavior changed. Infrastructure is inert until PR1b.

### Work Unit Evidence

| Evidence | Exact result |
|---|---|
| RED | `go test ./internal/auth -run TestRefreshFamiliesPostgres -count=1 -v` initially failed to build because the repository and service operation did not exist. |
| Focused GREEN / runtime harness | `DATABASE_URL=… go test ./internal/auth -run TestRefreshFamiliesPostgres -count=1 -v`: PASS; 1 parent test + 2 table subtests; 0 skips. It creates an isolated PostgreSQL schema and invokes production `database.Migrate`, including `000006_refresh_sessions.sql`. |
| Full affected package | `DATABASE_URL=… go test ./internal/auth -count=1 -v`: PASS; 3 executed test nodes; 0 skips. |
| Build | `go build ./...`: PASS. |
| Security inspection | SQL contains only `secret_hash BYTEA`; repository has no logging and returns generic `ErrUnauthorized`; tests prove the raw credential is absent from stored values and errors. |
| Rollback | Fix-forward after `000006_refresh_sessions.sql` is applied: disable/avoid all future consumers (PR1b is not present), leaving inert hash rows. Do not delete the applied migration. |

### Boundary

Backend authored implementation/test/migration delta: 292 lines (7 service + 118 repository + 144 test + 23 migration). No PR1b or later surface was changed.
