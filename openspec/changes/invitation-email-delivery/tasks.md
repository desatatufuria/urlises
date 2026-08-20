# Tasks: Invitation Email Delivery

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | 1,200–1,500 |
| 800-line session budget risk | High |
| 400-line reviewer-burden signal | High |
| Chained PRs recommended | Yes |
| Suggested split | Backend slice → Frontend slice |
| Delivery strategy | Resolved: chained (feature-branch-chain), overriding the session's `single-pr-default` default for this change per explicit user decision |
| Chain strategy | **feature-branch-chain** — tracker branch `feat/invitation-email-delivery` (draft, no direct merge to `develop`); PR 1 targets the tracker; PR 2 targets PR 1's branch; only the tracker merges to `develop` once both children are integrated |

Decision needed before apply: Resolved
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High (mitigated by the split below — each child PR is estimated under the 400-line reviewer-burden signal)

## PR Chain Plan

```text
develop
  └── feat/invitation-email-delivery (tracker, draft, no direct merge)
        └── feat/invitation-email-delivery-backend (PR 1 → tracker)
              └── feat/invitation-email-delivery-frontend (PR 2 → PR 1's branch)
```

- **PR 1 — Backend** (`feat/invitation-email-delivery-backend` → `feat/invitation-email-delivery`): Phases 1, 2, 3, 4, and the backend half of 7 (7.1) and 8. Review budget: ~600–750 lines (config/compose/docs + service + mail composition + handler wiring + backend tests).
- **PR 2 — Frontend** (`feat/invitation-email-delivery-frontend` → `feat/invitation-email-delivery-backend`), 📍 current after PR 1 merges: Phases 5, 6, and the frontend half of 7 (7.2, 7.3). Review budget: ~500–650 lines (API client + route + `InvitationAcceptPage` + `LoginPage`/`RegisterPage` changes + frontend tests).
- **Tracker** (`feat/invitation-email-delivery`): stays draft/no-merge until both child PRs are reviewed and merged into it; then one PR from the tracker into `develop` closes the change.

Each child PR must state: start state, end state, dependency on the prior PR, follow-up work (the next child, if any), and out-of-scope items — per the `chained-pr` skill's PR-body contract. Rollback boundary for each PR is the file list already given per work unit above.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Backend: config, expiry, invitation mail, handler wiring, compose/docs | PR 1 (or sole PR under exception) | `cd backend && go test ./internal/config ./internal/organizations` | `docker compose up -d backend`; create an invitation and inspect Mailpit at `127.0.0.1:8025` | `config.go`, `organizations/{service.go,invitation_mail.go,handler.go}`, `main.go`, `docker-compose*.yml`, `.env.example`, `docs/*` |
| 2 | Frontend: `/invitations/:token` route, accept client, login/register pass-through | PR 2; base = PR 1 branch, or same PR under exception | `cd admin-web && npm test -- InvitationAcceptPage router LoginPage RegisterPage` | `npm run dev`; follow a real Mailpit link end to end | `admin-web/src/{lib/api/invitations.ts,lib/api/types.ts,app/router.tsx,app/views/{InvitationAcceptPage,LoginPage,RegisterPage}.tsx}` |

## Phase 1: Backend Foundation — Config and Compose

- [x] 1.1 RED: `backend/internal/config/config_test.go` — table cases: missing `PUBLIC_BASE_URL` when `MAIL_ENABLED=true` fails load; malformed scheme/host fails; non-empty query or fragment fails; trailing slash is trimmed; empty value is allowed when mail is disabled.
- [x] 1.2 GREEN: `backend/internal/config/config.go` — add `AppConfig{PublicBaseURL}`, `Config.App`, `AppConfig.Validate(mailEnabled bool)`, and wire `appConfig.Validate` into `Load` right after `mailConfig.Validate()`.
- [x] 1.3 `docker-compose.yml` — add `PUBLIC_BASE_URL: http://localhost:5173` to `backend`. Land in the same commit as 1.2: local compose already sets `MAIL_ENABLED: "true"`, so `config.Load` fails at container start without this.
- [x] 1.4 `docker-compose.prod.yml` — add `PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://admin.urlises.lab.dtfuria.xyz}` to `backend`.
- [x] 1.5 `.env.example` — document `PUBLIC_BASE_URL` next to the `MAIL_*` variables. Applied directly by the orchestrator (sub-agents are permission-blocked from `.env*` paths by design; the orchestrator is not).
- [x] 1.6 `docs/deployment.md` and `docs/installation.md` — add `PUBLIC_BASE_URL` to the environment tables; state it is required when `MAIL_ENABLED=true`; add the Mailpit end-to-end manual check from the design's Testing Strategy.

## Phase 2: Backend Service — Invitation Expiry and Context

- [x] 2.1 RED: `backend/internal/organizations/service_test.go` — assert `expires_at` on a newly created invitation equals `now + 168h` within a small skew; assert `InvitationCreation.OrganizationName`/`InviterEmail` are populated; assert a `NULL`/blank `users.name` yields `InviterName == ""`.
- [x] 2.2 GREEN: `backend/internal/organizations/service.go` — add `const invitationTTL = 168 * time.Hour` and `InvitationCreation{Invitation, OrganizationName, InviterEmail, InviterName, ExpiresAt}`; compute `expiresAt := time.Now().UTC().Add(invitationTTL)` and pass it as `$6` on the existing INSERT; add the post-INSERT org/inviter `SELECT` inside the same `tx`, mapping `pgx.ErrNoRows` to `ErrNotFound`; change `CreateInvitationTx`/`CreateInvitation` to return `(InvitationCreation, error)`.

## Phase 3: Backend Notification — Invitation Mail Composition

- [x] 3.1 RED: `backend/internal/organizations/invitation_mail_test.go` — exact accept URL for the spec scenario (`https://admin.example.com/invitations/abc123?email=invitee%40example.com`); organization name, inviter identity, role, and expiry present in both the text and HTML bodies.
- [x] 3.2 RED (subject-line correctness, not polish): same file — an organization name containing `\r`/`\n` must still produce a mailer-acceptable subject (no header-injection failure); assert the composed `Message` passes `mailer`'s CR/LF subject check rather than silently failing the send.
- [x] 3.3 RED: same file — an organization name containing `<script>` is HTML-escaped in the rendered body; `ErrDisabled` is logged with `reason=disabled` and the log buffer never contains the token, invitee address, or accept URL.
- [x] 3.4 GREEN: create `backend/internal/organizations/invitation_mail.go` — `InvitationNotification`, unexported `invitationNotifier` port, `MailInvitationNotifier` + `NewMailInvitationNotifier(m mailer.Mailer, publicBaseURL string, logOutput io.Writer)`, `invitationAcceptURL`, subject CR/LF-strip + whitespace-collapse helper, `html/template`-rendered HTML body, plain-text body, and `NotifyInvitation` with the `event=invitation_email_sent`/`event=invitation_email_failed reason=...` logging contract.

## Phase 4: Backend Wiring — Handler and main.go

- [x] 4.1 RED: `backend/internal/organizations/handler_test.go` — update existing `creationTxService`/`routeService` stub signatures to return `(InvitationCreation, error)` from `CreateInvitationTx`/`CreateInvitation` (test-churn item flagged in design; touches every existing invitation-creation test double, not just new cases).
- [x] 4.2 RED: same file — add cases: a fresh command invokes a counting notifier stub exactly once; an idempotent replay invokes it zero times; a notifier error still yields `201` with the created body; a fingerprint conflict sends nothing.
- [x] 4.3 GREEN: `backend/internal/organizations/handler.go` — update `creationTxService`/`routeService` interfaces to the new `InvitationCreation` return type; add `notifier invitationNotifier` parameter to `RegisterRoutes` (nil-tolerant, mirroring `auth.RegisterRoutes`'s `invitations` guard); add `idempotencyScope` helper reproducing `Execute`'s internal scope construction.
- [x] 4.4 GREEN: same file — switch the idempotent branch of `POST /organizations/{organizationId}/invitations` from `executor.Execute` to `executor.ExecutePrepared`, returning a `PostCommit` closure from `Command` that captures the notification only when `notifier != nil`; apply the same flush-and-notify to the non-idempotent branch so both paths cannot drift.
- [x] 4.5 GREEN (load-bearing, not optional): both branches — after `httpapi.WriteJSON(w, result.Status, result.Body)`, call `http.NewResponseController(w).Flush()` before invoking `hook(context.WithoutCancel(r.Context()))`, guarded by `if hook != nil`. The flush is what guarantees the client already has the response before the SMTP dial starts.
- [x] 4.6 GREEN: `backend/cmd/api/main.go` — construct `mailer.NewSMTP(cfg.Mail)`, wrap it with `organizations.NewMailInvitationNotifier(mailer, cfg.App.PublicBaseURL, os.Stdout)` (or the repo's existing log sink), and pass it into `organizations.RegisterRoutes`.

## Phase 5: Frontend API Client

- [ ] 5.1 `admin-web/src/lib/api/types.ts` — add `AcceptedInvitation { organizationId, organizationName, role: OrganizationRole }` alongside `PendingInvitation`.
- [ ] 5.2 Create `admin-web/src/lib/api/invitations.ts` — `acceptInvitation(accessToken, invitationToken)` calling `POST /invitations/{token}/accept` via `apiRequest`, kept separate from `organizations.ts` per the design's module-ownership decision.

## Phase 6: Frontend Routing and Pages

- [ ] 6.1 RED: `admin-web/src/app/router.test.tsx` — assert `/invitations/:token` resolves to a public route and is not swallowed by the `*` catch-all.
- [ ] 6.2 GREEN: `admin-web/src/app/router.tsx` — register `{ path: "/invitations/:token", element: <InvitationAcceptPage /> }` as a top-level route outside `RequireSession`.
- [ ] 6.3 RED: `admin-web/src/app/views/InvitationAcceptPage.test.tsx` — redirect target per `status` (`anonymous`→`/login`, `setupRequired`→`/register`, both with `invitation`/`email` preserved); accept is called exactly once under React StrictMode's double-invoked effect; each error mapping (email-mismatch, not-pending, not-found, generic) renders its own copy; a "Try again" action resets the guard and retries.
- [ ] 6.4 RED (threat-matrix: open redirect via `returnTo`) — same file or `router.test.tsx`: assert `returnTo`/post-auth navigation never resolves to an external origin, only to the fixed `/invitations/:token` local path.
- [ ] 6.5 GREEN: create `admin-web/src/app/views/InvitationAcceptPage.tsx` — `useParams`/`useSearchParams`, branch on `useAuth().status`, `useRef`-guarded single-flight `acceptInvitation` call on `authenticated`, outcome screen ("joined {org} as {role}", console link only for `owner`/`admin`), and the four inline error mappings from the design.
- [ ] 6.6 `admin-web/src/app/views/LoginPage.tsx` — add `useSearchParams`; derive `invitation`/`invitedEmail`/`returnTo`; change the post-auth `<Navigate to="/" replace/>` (`:15`) to `returnTo`; prefill (editable) `email: invitedEmail ?? ""` (`:11`); preserve `searchParams` on the register link (`:70`).
- [ ] 6.7 GREEN (critical fix — primary invitee path is dead without this): `admin-web/src/app/views/RegisterPage.tsx:21-23` — change the unconditional `status === "anonymous"` redirect to `/login` into `if (status === "anonymous" && !invitation) return <Navigate to="/login" replace/>;` so an invitee with no account can reach the registration form.
- [ ] 6.8 `RegisterPage.tsx` — add `useSearchParams`/`returnTo` (defaulting to `/setup/organization`); change the authenticated `<Navigate to="/" .../>` (`:18-19`) and the post-`signUp` `navigate("/setup/organization", ...)` (`:35`) to `returnTo`; prefill `email: invitedEmail ?? ""` (`:11`); when `invitation && invitedEmail` are both present render the email input `readOnly aria-readonly="true"` with the locked-field hint (`:52`); invitation-aware heading/copy (`:47-49`); preserve `searchParams` on the login link (`:59`).

## Phase 7: Verification

- [x] 7.1 `cd backend && go test ./internal/config ./internal/organizations ./...` — full backend suite green, including the new expiry, mail-composition, sanitization, and handler-replay tests. (Confirmed green against a real ephemeral Postgres; without `DATABASE_URL` the DB-backed tests skip/fail-open per each package's pre-existing convention — see apply-progress for exact evidence.)
- [ ] 7.2 `cd admin-web && npm test` — full frontend suite green, including `InvitationAcceptPage.test.tsx`, `router.test.tsx`, and updated `LoginPage`/`RegisterPage` coverage.
- [ ] 7.3 Manual: `docker compose up`, create an invitation, open the received Mailpit message at `127.0.0.1:8025`, follow the link with no existing account, register, and land as a member — confirms 6.7's fix and the full link contract end to end.

## Phase 8: Review and Rollback

- [x] 8.1 Confirm `MAIL_ENABLED=false` still returns `ErrDisabled` (logged, `reason=disabled`) with invitation creation otherwise unaffected, and that reverting the branch removes the route and the `PUBLIC_BASE_URL` requirement with no data to undo. Confirmed via `TestNotifyInvitationLogsDisabledWithoutLeakingSecrets` (unit) and `TestInvitationRouteWithDisabledMailerStillCreatesInvitation` (real `mailer.NewSMTP(config.MailConfig{Enabled:false})` wired through the handler against a live Postgres instance) — both pass; the revert story is structural (no migration, no new required column) as stated in design's Rollback Plan.
- [ ] 8.2 Before requesting review, record the chain-strategy decision from the forecast above (`size:exception` for a single PR, or split per the Suggested Work Units) so `sdd-apply` does not proceed on an unresolved budget risk.
