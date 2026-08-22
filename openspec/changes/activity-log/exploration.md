## Exploration: activity-log

### Current State

**1. Enumeration of existing "notable write" call sites — every plausible audit-worthy mutation, with actor/target info already in scope.**

| Mutation | Function | File:line | Actor in scope | Target/org in scope |
|---|---|---|---|---|
| Organization created | `CreateOrganizationTx` | `backend/internal/organizations/service.go:178-207` | `userID` param | new `organizationID` (returned) |
| Invitation created | `CreateInvitationTx` | `backend/internal/organizations/service.go:370-477` | `requesterUserID` | `organizationID` param |
| Invitation resent | `ResendInvitation` | `backend/internal/organizations/service.go:485-564` | `requesterUserID` | `organizationID`, `invitationID` |
| Invitation accepted | `AcceptInvitation` | `backend/internal/organizations/service.go:614-677` | `userID` (acceptor) | `record.OrganizationID` (loaded from token row) |
| Org member role changed / removed | `PatchMember` | `backend/internal/organizations/service.go:256-352` | `requesterUserID` | `organizationID`, target `userID` |
| Workspace created | `CreateTx` | `backend/internal/workspaces/service.go:256-293` | `requesterUserID` | `organizationID` param, new `workspaceID` |
| Workspace user-access granted | `GrantUserAccess` | `backend/internal/workspaces/service.go:299-336` | `requesterUserID` | `workspaceID`, target `userID`, `role` |
| Workspace user-access revoked | `RevokeUserAccess` | `backend/internal/workspaces/service.go:338-369` | `requesterUserID` | `workspaceID`, target `userID` |
| Workspace group-access granted | `GrantGroupAccess` | `backend/internal/workspaces/service.go:371-412` | `requesterUserID` | `workspaceID`, `groupID`, `role` |
| Workspace group-access revoked | `RevokeGroupAccess` | `backend/internal/workspaces/service.go:414-445` | `requesterUserID` | `workspaceID`, `groupID` |
| Group created | `CreateTx` | `backend/internal/groups/service.go:108-127` | `requesterUserID` | `organizationID` param, new group |
| Group renamed | `Update` | `backend/internal/groups/service.go:133-158` | `requesterUserID` | `organizationID`, `groupID` |
| Group deleted | `Delete` | `backend/internal/groups/service.go:160-177` | `requesterUserID` | `organizationID`, `groupID` |
| Group member added | `AddMemberTx` | `backend/internal/groups/service.go:195-226` | `requesterUserID` | `groupID` → resolved `organizationID`, target `userID` |
| Group member removed | `RemoveMember` | `backend/internal/groups/service.go:272-303` | `requesterUserID` | `groupID` → resolved `organizationID`, target `userID` |
| Secret created | `Create` | `backend/internal/secrethide/service.go:88-124` | `userID` (creator) | **no `organizationID` anywhere in scope** — see finding 3 |
| Secret read (burned) | `Burn` | `backend/internal/secrethide/service.go:175-225` | anonymous caller (public route) — only `creatorUserID` resolved from the row | same org gap as above |
| Secret sent by email | handler's `POST /secrets/{token}/send-email` | `backend/internal/secrethide/handler.go:140-183` | `principal.UserID` | same org gap |

Every mutation except the three `secrethide` ones already has both an authenticated actor `userID` and an `organizationID` (or a resolvable path to one via `workspaceID`/`groupID`) in scope at the exact call site — no threading of new parameters is needed for those. `secrethide` is the one package with a structural gap (finding 3).

**2. `PostCommit`/`ExecutePrepared` vs. a shared `activity` package — and why the two existing patterns are actually the wrong fit for durability-sensitive audit rows.**

Two proven patterns exist:
- `httpapi.IdempotencyExecutor.ExecutePrepared` → `PostCommit` (`backend/internal/httpapi/idempotency.go:37,133`), used today only for the invitation-created email (`organizations/handler.go:169-190`) — fires *after* the transaction has already committed, best-effort, logged-only-on-failure.
- Handler-local flush-then-notify, used for secret-read WebSocket push (`secrethide/handler.go:134-137`) and send-email (`handler.go:164-183`) — same after-commit, fire-and-forget shape.

Both are deliberately used for **external side effects** (SMTP send, WebSocket push) where losing the notification on a crash between commit and hook is an acceptable, already-accepted risk — the primary state (invitation row, secret row) is still correct even if the email/push never fires.

An audit-log row is different: **losing it silently defeats the entire point of a compliance/audit trail.** If `Record()` is only called after commit (PostCommit-style), a crash or panic between commit and the hook produces a real mutation with zero audit trail — silently wrong for a fintech/compliance framing. The right fit is closer to `PatchMember`'s or `CreateInvitationTx`'s existing shape: **write the activity row inside the same transaction as the primary mutation**, so it commits atomically with the state change it describes (if the transaction rolls back, no orphan activity row exists either).

Recommendation: a new `backend/internal/activity` package exposing
```go
func Record(ctx context.Context, tx pgx.Tx, orgID *string, actorUserID string, kind Kind, targetType, targetID string, metadata map[string]any) error
```
taking a `pgx.Tx` (matching the `dbQuerier`/`pgx.Tx` shape already common to `organizations`, `workspaces`, `groups`) so every call site simply adds one `activity.Record(ctx, tx, ...)` line inside its existing transaction, right before `tx.Commit()`. No `PostCommit` hook, no new idempotency machinery, no risk of "mutation happened but audit row didn't."

Every existing service constructor (`organizations.NewService(pool)`, `workspaces.NewService(pool, accessService)`, `groups.NewService(pool)`, `secrethide.NewService(pool)` — all confirmed in `backend/cmd/api/main.go:99-125`) depends only on `*pgxpool.Pool` (+ narrow siblings) at the composition root. `activity.NewService(pool)` fits the exact same shape with zero import-cycle risk — `organizations`/`workspaces`/`groups`/`secrethide` would each add a small import of `internal/activity` and one `Record(...)` call per mutation; `activity` itself imports nothing from them.

**3. Organization scoping — confirmed, and the secrets ambiguity is real.**

`organization_members` (`backend/migrations/000001_initial_schema.sql:19-26`) has `UNIQUE (organization_id, user_id)` — this permits, and does not prevent, **the same `user_id` belonging to multiple organizations** (only duplicate membership in the *same* org is blocked). So "which org does this user's secret belong to" is genuinely ambiguous for any user in >1 org — there is no deterministic single answer derivable from `secrets.user_id` alone.

`secrets` (`backend/migrations/000010_secrets.sql:1-14`) has `user_id UUID NOT NULL REFERENCES users(id)` and nothing else identity-related — no `organization_id`, no `workspace_id`. This is a deliberate prior decision (per package doc comment, `secrethide/service.go:1-4`: "zero-knowledge, one-time-read secret sharing"), consistent with secrets being explicitly personal, not organizational, resources in this codebase's data model today.

**Open decision, flagged for proposal stage** (not silently resolved here): should secret-created/secret-read events appear in the org-scoped activity feed at all?
- **Option A (recommended default): exclude secret events from the org-scoped feed entirely, v1.** Treat them as a personal-only signal, already served by `GET /secrets` (`secrethide/handler.go:99-113`) and `SecretsPage.tsx`. Reasoning: the ambiguity described above is not a minor edge case — a user in 2 orgs creating a secret would need an arbitrary tie-break (first org? most-recently-active org? every org they belong to?), and any of those choices leaks information about a personal action into an org-scoped audit view that other org admins can see, without an unambiguous, justifiable rule for *which* org. Given `secrets` was a deliberate prior decision to keep personal/not-org-scoped, folding it into an org feed contradicts that decision unless it's revisited on purpose.
- **Option B: resolve org at write time by picking the user's sole org if they have exactly one, else omit / require the caller to specify.** Only cleanly correct for users with exactly one org — degrades to Option A's problem for multi-org users, so it's a partial fix, not a full one.
- **Option C: only add real org-scoping to `secrets` (a `workspace_id` or `organization_id` column) as a prerequisite.** Doable but is a larger, separate change to `secrethide`'s data model — this exploration recommends treating it as out of scope for `activity-log` v1 and revisiting later if the fintech-compliance requirement genuinely demands org-visible secret events.

**4. WebSocket `Hub` — already extended with `byUser`/`PublishToUser`. No new infra needed for a first version; org-scoped push is a deliberate non-goal for v1.**

`backend/internal/websocket/hub.go:10-131` — already shipped this session: `Hub.byUser` index (`hub.go:13-19`), `Subscription.UserID`/`Notifications` channel (`hub.go:22-33`), and `PublishToUser(ctx, userID, message)` (`hub.go:119-131`). There is **no `byOrg` index** — `Publish` (workspace-scoped) and `PublishToUser` (user-scoped) are the only two routing shapes that exist.

Building a third, org-scoped index (`byOrg`) to live-push new activity rows to every admin viewing an org's activity feed is a real, additive extension (same shape as `byUser` was) — but admin-web's WebSocket usage today is nonexistent (extension is the only WS client; admin-web is pure REST + polling via TanStack Query, confirmed by `admin-web/src/lib/api/secrets.ts` and `SecretsPage.tsx`'s `useMySecrets` query hook). Introducing WebSocket into admin-web for the first time, just for a live activity feed, is a nontrivial scope increase for a v1 audit view. **Recommendation: polling/refetch-on-mount (TanStack Query default) is the pragmatic v1** — matches every other admin-web list page (`MembersPage`, `GroupsPage`, `WorkspacesPage`, `AccessPage`, `SecretsPage`, all REST+refetch, no WS). Live-push via a new `byOrg` Hub index is a reasonable v2 if the product genuinely needs live updates, not a v1 requirement.

**5. admin-web design system precedent — direct, ready-to-reuse.**

`admin-web/src/features/secret-history/SecretsPage.tsx:1-85` is the closest analog: `useAuth()` for session/token, a TanStack Query hook (`useMySecrets`), `DataState` for loading/error/empty states, `Table` with a `columns` prop and a `<tr>`-per-row body, and `Badge` for status coloring. An `ActivityPage` should follow this shape exactly: `useMyOrgActivity`-style query hook, `DataState` for the three states, `Table` with columns like `["When", "Actor", "Kind", "Target"]`, `Badge` for `kind`. Router precedent: `admin-web/src/app/router.tsx:120-122` registers `secrets` as a sibling route under `AdminLayout`/`RequireAdminOrganization` (`router.tsx:95-122`) — a new `activity` route belongs at the same nesting level, same guard.

**6. Extension's `activitySignal`/`recordActivity` — should NOT be unified with the backend activity log. This is a local, device-derived signal, not a discrete persisted event.**

`recordActivity(workspaceId, activity)` (`extension/src/background/projection.ts:1853-1880`) is called only from two call sites tied directly to the bookmark-sync protocol. It mutates purely local extension state, never sent to or read from the backend. `ensureActivitySignal` (`projection.ts:954-963`) derives a revision as `max()` across all local per-workspace projections. `popup.ts` uses this only to toggle a "New updates" dot, acknowledged via `acknowledgeActivityIfNeeded`.

There is already a second, separate, structurally-identical signal — `secretReadSignal`/`recordSecretRead` (`projection.ts:965-974, 1889-1907`) — created for the secret-read-notification feature, and it's already kept **distinct** from `activitySignal` rather than folded in (code comment at `projection.ts:965-967` explains why: no per-workspace projection to derive a floor from). This is direct precedent from earlier in this same session for "don't force-unify signals with different semantics" — the same reasoning applies here, more strongly: `activitySignal` is inherently local/per-device (revision numbers are locally generated, not server-issued), while a backend activity feed's events have server-assigned IDs/ordering and organization scope. **Recommendation: keep them fully separate.** If/when the extension wants to surface backend activity events, that's a third, independent signal fetched via REST from the new `GET /organizations/{id}/activity` endpoint, not a repurposing of `activitySignal`.

**7. Retention/volume — correction to the initial framing: `secrets` does NOT actually self-prune.**

Repo-wide search for any `DELETE FROM secrets` or scheduled secrets-cleanup job returned zero matches. `secrethide.Service.ListOwned` applies `LIMIT 50` (`secrethide/service.go:263-280`) — a **read-side display cap**, not a deletion job; expired/read rows remain in the table forever, just excluded from `Reveal`/`Burn` at read time. The one real scheduled-pruning precedent in this codebase is `idempotencyExecutor.Cleanup(ctx, 100)`, fired hourly (`backend/cmd/api/main.go:108-121`).

For `activity`: unbounded growth is real and worse than `secrets` (every org mutation, indefinitely), so pagination is non-negotiable from day one (`GET /organizations/{id}/activity?cursor=...`, not a flat list like `ListOwned`'s `LIMIT 50`). Unlike `secrets`, deleting audit rows may directly conflict with the fintech/compliance framing motivating this feature — audit trails are often expected to be retained for a defined regulatory period, not silently pruned. **Recommendation: paginate always; do not add automatic deletion in v1**; treat a retention/archival policy as an explicit, separate proposal-stage decision informed by the actual compliance requirement.

### Affected Areas

- `backend/internal/activity/` (new package) — `Service` + `Record(ctx, tx pgx.Tx, orgID *string, actorUserID, kind, targetType, targetID string, metadata map[string]any) error`, plus `ListByOrganization(ctx, requesterUserID, organizationID, cursor)` and its own `RegisterRoutes`.
- `backend/migrations/0000XX_activity.sql` (new) — `activity_events` table: `id UUID PK`, `organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`, `actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL` (mirrors `invitations.accepted_by_user_id`'s "provenance survives, don't block user deletion" precedent), `kind TEXT NOT NULL`, `target_type TEXT NOT NULL`, `target_id TEXT NOT NULL`, `metadata JSONB NOT NULL DEFAULT '{}'`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; indexes on `(organization_id, created_at DESC)` and `actor_user_id`.
- `backend/internal/organizations/service.go` — `activity.Record(...)` calls inside `CreateOrganizationTx`, `CreateInvitationTx`, `ResendInvitation`, `AcceptInvitation`, `PatchMember`, right before each existing `tx.Commit()`.
- `backend/internal/workspaces/service.go` — same, inside `CreateTx`, `GrantUserAccess`, `RevokeUserAccess`, `GrantGroupAccess`, `RevokeGroupAccess`.
- `backend/internal/groups/service.go` — same, inside `CreateTx`, `Update`, `Delete`, `AddMemberTx`, `RemoveMember`. Note `Update`/`Delete`/`ListMembers` currently run outside an explicit `tx` (`s.pool.QueryRow`/`s.pool.Exec` directly) — these need wrapping in a transaction first so the activity row is atomic with the mutation.
- `backend/internal/secrethide/` — excluded from `activity.Record(...)` in v1 per the recommended default in finding 3 (open decision for proposal stage).
- `backend/cmd/api/main.go` — wire `activityService := activity.NewService(pool)`, pass into `organizations.NewService`, `workspaces.NewService`, `groups.NewService` constructors (each needs a new constructor parameter), and call `activity.RegisterRoutes(mux, authService.Middleware, activityService)`.
- `admin-web/src/app/router.tsx` — new route `activity`, sibling to `secrets`/`access`, same `AdminLayout`/`RequireAdminOrganization` guard.
- `admin-web/src/features/activity/ActivityPage.tsx` (new) — modeled directly on `SecretsPage.tsx`.
- `admin-web/src/lib/api/activity.ts` (new) — `listOrgActivity(orgId, token, cursor)`, mirroring `secrets.ts`'s shape (authenticated, unlike `secrets.ts`'s deliberately-public calls).
- `extension/src/background/projection.ts`, `extension/src/popup/popup.ts` — no change recommended for v1 (finding 6).

### Approaches

**A. Where activity rows are written**

1. **Synchronous `activity.Record(ctx, tx, ...)` call inside each mutation's existing transaction, before `tx.Commit()` (recommended).**
   - Pros: audit row is atomic with the state change — no lost-event window; no new idempotency/PostCommit machinery; smallest new surface.
   - Cons: touches ~13 existing call sites across 3 packages; `groups.Update`/`Delete`/`ListMembers` need a small transaction-wrapping refactor first.
   - Effort: Medium.

2. **`PostCommit`-style, fired after each transaction commits (reusing the existing invitation-email pattern).**
   - Pros: zero changes to existing transactions; purely additive hooks matching a proven pattern.
   - Cons: reintroduces exactly the "mutation succeeded, audit row silently didn't" failure mode that makes PostCommit appropriate for email/WS but wrong for a compliance audit trail.
   - Effort: Medium.

3. **Async/queued writer decoupled from the request path entirely.**
   - Pros: zero latency added to mutation requests; naturally batches inserts.
   - Cons: new infrastructure with no existing precedent anywhere in this codebase; reintroduces the durability gap of Approach 2 unless backed by something more durable — disproportionate complexity for a v1 audit log.
   - Effort: High.

**B. Package shape**

1. **New shared `backend/internal/activity` package with a `Record(ctx, tx, ...)` helper any package can call (recommended).**
   - Pros: one definition of the event taxonomy and row shape; matches this codebase's existing pattern of small, pool-backed packages; easy to unit-test in isolation.
   - Cons: every calling package gains one new import and one new constructor parameter.
   - Effort: Medium.

2. **Repeat the `PostCommit`-notifier-interface pattern per package (each package defines its own narrow `activityRecorder` port, like `secretReadNotifier`).**
   - Pros: keeps each package's dependency surface minimal/decoupled, matching existing notifier-port patterns.
   - Cons: duplicates the same tiny interface 3+ times for no real benefit — there's nothing package-specific about "write an audit row," unlike a notifier where the underlying transport genuinely differs per package.
   - Effort: Medium-High.

### Recommendation

**Write pattern**: A.1 — synchronous `activity.Record(ctx, tx, ...)` inside each mutation's existing transaction, immediately before `tx.Commit()`. This is the one place the two proven "after-commit" patterns genuinely don't fit: they exist specifically to make external side effects best-effort and non-blocking, but an audit row is neither external nor safe-to-lose — it must be atomic with the mutation it records.

**Package shape**: B.1 — a new `backend/internal/activity` package, constructed the same way every other domain package is (`activity.NewService(pool)`), with a single `Record` entrypoint.

**Event taxonomy (`kind` enum)** — one value per row in the finding-1 table:
`organization.created`, `invitation.created`, `invitation.resent`, `invitation.accepted`, `organization_member.role_changed`, `organization_member.removed`, `workspace.created`, `workspace_access.user_granted`, `workspace_access.user_revoked`, `workspace_access.group_granted`, `workspace_access.group_revoked`, `group.created`, `group.renamed`, `group.deleted`, `group_member.added`, `group_member.removed`.
(Secret-related kinds — `secret.created`, `secret.read` — are deliberately omitted pending the open decision in finding 3.)

**Secret-events org-scoping (finding 3)**: default to **excluding** secret events from the org-scoped feed in v1 (Option A). Explicit open decision the proposal stage must confirm.

**Live push**: not in v1. Polling/refetch-on-mount via TanStack Query, matching every other admin-web list page.

**Retention**: paginate from day one; do not build automatic deletion in v1.

### Risks

- `groups.Update`, `groups.Delete`, and `groups.ListMembers` currently run outside an explicit transaction — adding an atomic activity row requires first wrapping them in `tx.Begin()/Commit()`, a small but real behavior-adjacent change to existing, tested code.
- The secret-events org-scoping question (finding 3) has no clean default — every option has a real tradeoff. Must be a proposal-stage product decision.
- Touching ~13 existing mutation call sites across 3 packages is a real, if mechanical, diff — worth sizing against the 400-line PR review budget; likely needs a chained-PR split (e.g. organizations in one unit, workspaces+groups in another).
- No retention/deletion policy exists yet for `activity` — if the org grows large and no follow-up retention decision is made, the table grows unboundedly forever; accepted v1 risk to name explicitly.
- `activity.Record` failing mid-transaction would roll back the *entire* primary mutation alongside the audit row, since they share a transaction — correct for atomicity, but means a bug in the audit-recording code becomes a production incident for unrelated features. Needs solid test coverage on `activity.Record` itself before wiring it into ~13 call sites.
- Introducing `activity` as a new constructor dependency of `organizations`, `workspaces`, and `groups` changes those packages' public constructor signatures — a breaking change contained to `main.go` and their test files today.

### Ready for Proposal

Yes — all seven investigation areas have concrete, file/line-backed answers. The write-pattern question has a definitive, reasoned recommendation that deliberately diverges from the two existing "obvious" precedents (PostCommit, flush-then-notify) with an explicit justification. The WebSocket question confirms `byUser`/`PublishToUser` already exists and recommends not building a third index for v1. The extension-unification question has a clear "keep separate" answer backed by this session's own `secretReadSignal`-vs-`activitySignal` precedent. Two things must be explicitly confirmed at proposal stage rather than assumed: (1) the secret-events org-scoping decision (recommended default: exclude from v1), and (2) the retention/deletion policy for `activity_events` (recommended default: none in v1, paginate only).
