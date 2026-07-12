# Apply Progress: Extension Sync Convergence Session

## Cumulative Status

7/25 tasks complete: PR1a tasks 1.1–1.4 and PR1b-auth tasks 2.1–2.3. The approved delivery remains stacked-to-`develop`, with no `size:exception`.

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

## PR1b Workload Guard

The former combined PR1b was pending at 4/21. Before production edits, the required minimum was forecast above the 400 authored-line limit: capability-gated auth endpoints and PostgreSQL handler coverage require roughly 250–320 lines; hash-only ticket persistence, real upgrade/subprotocol handling, and proxy-path coverage require roughly 300–380 more. The combined 550–700-line minimum could not be safely compressed without dropping required RED, security, or runtime evidence.

Recommended split: PR1b-auth implements tasks 2.1 plus the auth portion of 2.3 (capability header, access-only compatibility, refresh/logout, and revoke-all contract); PR1b-ws follows with task 2.2 plus ticket persistence/upgrade and the corresponding portions of 2.3–2.4. No task checkbox changed, no production file changed, and `000006_refresh_sessions.sql` remains untouched; the WS ticket table belongs in fix-forward `000007_ws_tickets.sql` when the WS slice is authorized.

## PR1b-auth Completion

- [x] 2.1 RED PostgreSQL handler coverage was written and failed first on the absent renewable seam/routes.
- [x] 2.2 Added `X-Session-Capability: renewable-v1`, renewable register/login/refresh/logout, transactional registration family creation, client binding, and generic 401/503 mapping.
- [x] 2.3 Recorded focused database harness, compatibility, threat, rollback, and delivery evidence.

### Contracts and Evidence

- No capability or any value other than the exact `renewable-v1` returns the unchanged four-field access-only session JSON. Exact capability adds `refreshToken`.
- `POST /auth/refresh` requires `refreshToken`, `attemptId`, and the existing client-ID header: malformed is 400; invalid/mismatched/reused is generic 401; operational repository/commit failures are generic 503. Same attempt within 60 seconds returns the deterministic successor.
- `POST /auth/logout` is unauthenticated and returns 204 for valid, invalid, repeated, or mismatched credentials without revealing validity; it never revokes unless the client binding matches.
- `DATABASE_URL=… go test ./internal/auth -run 'Test(RenewableAuthHandlerPostgres|RefreshFamiliesPostgres)$' -count=1 -v`: PASS, 10 executed test nodes, 0 skips. The real isolated-schema harness invokes production `database.Migrate`; `go test ./internal/auth -count=1 -v`: PASS, 10 nodes, 0 skips; `go build ./...`: PASS.
- Authored implementation/test delta is 396 lines (356 additions, 40 deletions), excluding pre-existing SDD split-artifact edits. No migration, WebSocket, extension, admin, SMTP, or TTL/config file changed. Errors/logs do not include submitted refresh values; persistence remains hash-only.
- Roll back by reverting the three auth source files and handler test while retaining PR1a's inert `000006` rows. PR1b-ws remains pending and alone may add `000007_ws_tickets.sql`.
