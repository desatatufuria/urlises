# Proposal: Activity Log

## Intent

admin-web has zero activity visibility today: no audit trail of who created a workspace, changed a role, or revoked access. Org admins have no way to answer "who did this and when" without querying the database directly. Add one canonical, organization-scoped event log in the backend, surfaced as a new read-only Activity page in admin-web.

## Proposal Question Round

Not run this turn — scope was shaped directly with the user before delegation, and all decisions below were made explicitly (not silently assumed by this agent). Recorded here for traceability, not as open items:
- Write pattern: synchronous, in-transaction (not PostCommit) — confirmed.
- Secret-sharing events: excluded from v1's org feed — confirmed as a stated scope boundary, not a TODO (see Out of Scope).
- Retention: paginate from day one, no auto-deletion in v1 — confirmed.
- Live push: none in v1 (polling/refetch only) — confirmed.

No residual open product questions. Flag for the user before continuing: the delivery-chain forecast below (13 call sites, 3 backend packages, 1 new admin-web page) likely exceeds a single 400-line PR — confirm chained-PR delivery is acceptable before `sdd-tasks`.

## Scope

### In Scope
- New `backend/internal/activity` package: `Record(ctx, tx pgx.Tx, orgID *string, actorUserID, kind, targetType, targetID string, metadata map[string]any) error`, `ListByOrganization(ctx, requesterUserID, organizationID, cursor)`, `RegisterRoutes`.
- New migration: `activity_events` table, org-scoped, paginated by `(organization_id, created_at DESC)`.
- ~13 call sites across `organizations`, `workspaces`, `groups` each add one `activity.Record(...)` call before `tx.Commit()`.
- Transaction-wrapping refactor of `groups.Update`/`Delete`/`ListMembers` (currently pool-direct, no `tx`) — required prerequisite for atomic recording there.
- admin-web: new `ActivityPage.tsx` + `activity.ts` API client, paginated, polling/refetch via TanStack Query — same shape as `SecretsPage.tsx`.
- `main.go` wiring: `activity.NewService(pool)`, threaded as a new constructor parameter into `organizations`/`workspaces`/`groups`.

### Out of Scope
- `secrethide` events (secret created/read). Secrets have `user_id` only, no `organization_id`, and a user can belong to multiple orgs — there is no unambiguous org to attribute a secret event to. Excluding them is a stated design decision, not a gap to fill later without first deciding whether/how to add org-scoping to `secrets`' data model.
- Extension `activitySignal`/`recordActivity` — stays a separate, local, device-derived signal. No extension changes.
- WebSocket live-push (`byOrg` Hub index). v2 candidate only.
- Retention/deletion policy — explicitly deferred; paginate only.

## Capabilities

### New Capabilities
- `activity-log`: organization-scoped audit event recording (backend `Record`/`ListByOrganization`) and read-only feed (admin-web `ActivityPage`).

### Modified Capabilities
- None.

## Approach

**Write pattern (deliberate departure from `PostCommit`)**: every existing after-commit pattern in this codebase (`IdempotencyExecutor.ExecutePrepared`→`PostCommit`, handler-local flush-then-notify) exists for external side effects — email, WebSocket push — where losing the callback on a crash between commit and hook is an already-accepted risk; the primary row is still correct either way. An audit row is the opposite case: if it's only written after commit, a crash in that window produces a real mutation with zero audit trail, defeating the log's purpose. `activity.Record(ctx, tx, ...)` is therefore called synchronously, inside each mutation's existing transaction, immediately before `tx.Commit()` — atomic with the change it describes, rolled back together if the transaction fails.

**Package shape**: `backend/internal/activity`, constructed like every other domain package (`activity.NewService(pool)`), zero import-cycle risk (imports nothing from the packages that call it).

**Event taxonomy** (`kind` — 16 values, one per row in exploration finding 1): `organization.created`, `invitation.created`, `invitation.resent`, `invitation.accepted`, `organization_member.role_changed`, `organization_member.removed`, `workspace.created`, `workspace_access.user_granted`, `workspace_access.user_revoked`, `workspace_access.group_granted`, `workspace_access.group_revoked`, `group.created`, `group.renamed`, `group.deleted`, `group_member.added`, `group_member.removed`.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `backend/internal/activity/` | New | `Record`, `ListByOrganization`, `RegisterRoutes` |
| `backend/migrations/` | New | `activity_events` table + indexes |
| `backend/internal/organizations/service.go` | Modified | 5 `Record` calls (create org, invite create/resend/accept, member patch) |
| `backend/internal/workspaces/service.go` | Modified | 5 `Record` calls (create, user/group grant/revoke) |
| `backend/internal/groups/service.go` | Modified | Tx-wrap refactor + 5 `Record` calls (create, rename, delete, member add/remove) |
| `backend/cmd/api/main.go` | Modified | Wire `activityService`, new constructor params, route registration |
| `admin-web/src/features/activity/ActivityPage.tsx` | New | Modeled on `SecretsPage.tsx` |
| `admin-web/src/lib/api/activity.ts` | New | `listOrgActivity(orgId, token, cursor)` |
| `admin-web/src/app/router.tsx` | Modified | New `activity` sibling route under existing admin guard |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `groups.Update`/`Delete`/`ListMembers` tx-wrap refactor touches existing, tested code | Medium | Land refactor + tests as its own reviewable slice before adding `Record` calls |
| `activity.Record` failure rolls back the whole primary mutation (shared tx) | Medium | Solid unit coverage on `Record` before wiring into 13 call sites |
| 13 call sites × 3 backend packages + new admin-web page will not fit one 400-line PR | High | Chain PRs like `secret-sharing`: e.g. (1) `activity` package + migration, (2) `organizations` wiring, (3) `workspaces`+`groups` wiring (incl. tx-wrap refactor), (4) admin-web page. Flag to `sdd-tasks`. |
| Constructor signature changes for `organizations`/`workspaces`/`groups` | Low | Contained to `main.go` and existing service test files |
| Unbounded `activity_events` growth, no retention policy | Low (accepted v1 risk) | Paginate always; retention is an explicit future decision |

## Rollback Plan

Additive and isolated: drop the `activity_events` migration, remove `activity.RegisterRoutes` and the new constructor parameters in `main.go` (revert to prior signatures), remove the `Record` calls from `organizations`/`workspaces`/`groups`, revert the `groups.go` tx-wrap refactor if unwanted independently, remove the admin-web route/page. No existing data model touched.

## Delivery Intent

Likely branch `feat/activity-log`, chained-PR delivery (see Risks) given ~13 call sites across 3 backend packages plus a new admin-web surface — do not attempt as a single PR against the 400-line review budget.

## Success Criteria

- [ ] All 16 listed mutation kinds record an atomic activity row in the same transaction as the mutation.
- [ ] `groups.Update`/`Delete`/`ListMembers` run inside an explicit transaction.
- [ ] Secret-sharing events are absent from the org activity feed by design.
- [ ] admin-web `ActivityPage` lists an org's events, paginated, no live-push.
- [ ] No automatic deletion of `activity_events` rows exists in v1.
