# Design: Invitation Email Delivery

## Technical Approach

Two slices joined by one URL contract.

**Backend.** `CreateInvitationTx` gains an expiry and two extra columns of context (organization name, inviter identity) read inside the caller's `pgx.Tx`, and returns them in a new `InvitationCreation` struct so `Invitation`'s JSON shape is untouched. The invitation route switches from `IdempotencyExecutor.Execute` to `ExecutePrepared`, whose `Command` returns a `PostCommit` closure capturing that data. The handler runs the hook after the response is written and flushed. Message composition lives in the `organizations` package behind a narrow consumer-defined `invitationNotifier` port; `main.go` constructs `mailer.NewSMTP(cfg.Mail)` and wraps it in `organizations.NewMailInvitationNotifier`, mirroring `invitationAccepterAdapter`. `internal/mailer` is not modified.

**Frontend.** A public `/invitations/:token` route outside `RequireSession` is the single entry point. It inspects `useAuth().status` and either bounces to `/login`/`/register` with `invitation` and `email` preserved, or calls `POST /invitations/{token}/accept` and lands the invitee. `LoginPage` and `RegisterPage` gain `useSearchParams` plumbing so the post-auth `Navigate` returns to the accept page instead of `/`.

## Architecture Decisions

| Decision | Options / tradeoff | Choice and rationale |
|---|---|---|
| `PublicBaseURL` placement | Field on `MailConfig` vs sibling `AppConfig` | New `Config.App AppConfig{PublicBaseURL}`. `MailConfig` is the argument to `mailer.NewSMTP`; a product URL is not an SMTP transport parameter and the mailer never reads it. Adding it there would widen the frozen adapter's input surface for no consumer. Conditional validation lives in `Load`, which already knows both structs. |
| Delivery trigger | Inline `Send` in the service vs `PostCommit` hook | `ExecutePrepared` + `PostCommit`. It is the existing primitive for "after durable commit only" (`idempotency.go:170-173`), and it is the only option that is replay-safe by construction. |
| Hook execution | Goroutine vs synchronous after response | Synchronous, after `WriteJSON` plus an explicit `http.NewResponseController(w).Flush()`, on `context.WithoutCancel(r.Context())`. The flush guarantees the client already has the 201 before the SMTP dial starts, so the caller sees no added latency; synchronous keeps handler tests deterministic (no goroutine race) and keeps `server.Shutdown` able to wait for in-flight sends, which a detached goroutine would orphan. |
| Send deadline | New timeout const vs config-owned | No extra deadline. `WithoutCancel` strips the request cancellation; `MAIL_TIMEOUT` stays the single owner of the send bound (`smtp.go` takes the earlier of caller deadline and `MAIL_TIMEOUT`, so an outer bound would be a dead knob). |
| Message ownership | Compose in `main` vs in `organizations` | `organizations/invitation_mail.go`. Email copy is invitation-domain content; the composition root only injects the transport. `organizations` importing `internal/mailer` is a feature depending on a port — the allowed direction. |
| Return-value shape | Extend `Invitation` vs new struct | New `InvitationCreation{Invitation, OrganizationName, InviterEmail, InviterName, ExpiresAt}`. `Invitation` is serialized directly on the non-idempotent branch (`handler.go:182`); extending it would silently change that response body and the `invitationCreation` mapper. |
| Expiry source | `NOW() + INTERVAL '7 days'` in SQL vs Go `time.Now()` | Go: `expiresAt := time.Now().UTC().Add(invitationTTL)` passed as `$6`. The enforcement path already compares against the Go clock (`service.go:514`), so a Go-computed value is the consistent one, is exact for the email copy with no re-scan, and keeps `168h` in one testable constant. |
| Accept-API module | Extend `organizations.ts` vs new `invitations.ts` | New `lib/api/invitations.ts`. Every function in `organizations.ts` is an `/organizations/*` call taking an `organizationId`; the accept route is registered by `auth.RegisterRoutes` and is called by a user who is not yet a member of anything. `organizations.ts` is also imported by `AuthProvider`, so keeping the invitee path separate avoids widening that module's role. |
| Invited-email field on register | `disabled` vs `readOnly` | `readOnly` + `aria-readonly` + hint text. `disabled` inputs are excluded from form submission and are skipped by some assistive tech; `readOnly` keeps the value in the payload and focusable. Locked because `AcceptInvitation` requires exact email equality (`service.go:517`) — an editable field guarantees a 400 at the final step. |

## Data Flow

    admin POST /organizations/{id}/invitations
      -> ExecutePrepared: advisory lock -> Authorize -> claimReceipt
         |- receipt found  -> replayed SafeResult, hook = nil            (no send)
         |- receipt absent -> Command: CreateInvitationTx (expiry, org+inviter read)
                              -> completeReceipt -> tx.Commit -> hook != nil
      -> WriteJSON(201) -> Flush -> hook(WithoutCancel(ctx))
      -> invitationNotifier.NotifyInvitation -> mailer.Send -> SMTP

    invitee clicks {PUBLIC_BASE_URL}/invitations/{token}?email=...
      -> InvitationAcceptPage
         |- anonymous      -> /login?invitation={token}&email=...
         |- setupRequired  -> /register?invitation={token}&email=...
         |- authenticated  -> POST /invitations/{token}/accept -> outcome screen

Both `/login` and `/register` compute `returnTo = /invitations/{token}?email=...` from their own params and use it as their `Navigate` target once `status` becomes `authenticated`, so the accept call always runs from the dedicated page and never from an auth view.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/config/config.go` | Modify | Add `AppConfig{PublicBaseURL}`, `Config.App`, `PUBLIC_BASE_URL` parsing with trailing-slash trim, and conditional URL validation in `Load`. |
| `backend/internal/config/config_test.go` | Modify | Cases for missing-when-enabled, malformed scheme/host, query/fragment rejection, trailing-slash normalization, empty-when-disabled. |
| `backend/internal/organizations/service.go` | Modify | `invitationTTL` const, `InvitationCreation` struct, expiry on the INSERT, org/inviter read query, new `CreateInvitationTx`/`CreateInvitation` return types. |
| `backend/internal/organizations/invitation_mail.go` | Create | `InvitationNotification`, `invitationNotifier` port, `MailInvitationNotifier`, link builder, subject/text/HTML composition, structured send logging. |
| `backend/internal/organizations/invitation_mail_test.go` | Create | Link construction, required fields in both bodies, CR/LF sanitization, HTML escaping, `ErrDisabled` logging. |
| `backend/internal/organizations/handler.go` | Modify | `creationTxService`/`routeService` return-type change, `notifier` parameter, `Execute` → `ExecutePrepared`, `idempotencyScope` helper, post-response hook invocation. |
| `backend/internal/organizations/handler_test.go` | Modify | Update stub signatures; add replay-no-send and send-failure-does-not-fail-response cases. |
| `backend/internal/organizations/service_test.go` | Modify | Assert `expires_at` is set to `now + 168h` and that org/inviter fields are populated. |
| `backend/cmd/api/main.go` | Modify | Construct `mailer.NewSMTP(cfg.Mail)`, wrap in `organizations.NewMailInvitationNotifier`, pass to `organizations.RegisterRoutes`. |
| `admin-web/src/lib/api/invitations.ts` | Create | `acceptInvitation(accessToken, invitationToken)` for `POST /invitations/{token}/accept`. |
| `admin-web/src/lib/api/types.ts` | Modify | Add `AcceptedInvitation` alongside `PendingInvitation`. |
| `admin-web/src/app/views/InvitationAcceptPage.tsx` | Create | Public accept entry point: status routing, single-flight accept, outcome and error screens. |
| `admin-web/src/app/views/InvitationAcceptPage.test.tsx` | Create | Redirect targets per status, accept-once under StrictMode, each error mapping. |
| `admin-web/src/app/router.tsx` | Modify | Register `/invitations/:token` as a top-level public route. |
| `admin-web/src/app/router.test.tsx` | Modify | Assert the route resolves publicly and is not swallowed by the `*` catch-all. |
| `admin-web/src/app/views/LoginPage.tsx` | Modify | Read `invitation`/`email`, prefill email, `returnTo` navigation, preserve params on the register link. |
| `admin-web/src/app/views/RegisterPage.tsx` | Modify | Read params, allow anonymous access when `invitation` is present, prefill and lock email, `returnTo` after `signUp`, preserve params on the login link. |
| `docker-compose.yml` | Modify | `PUBLIC_BASE_URL: http://localhost:5173` on `backend`. |
| `docker-compose.prod.yml` | Modify | `PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://admin.urlises.lab.dtfuria.xyz}` on `backend`. |
| `.env.example` | Modify | Document `PUBLIC_BASE_URL` next to the mail variables. |
| `docs/deployment.md`, `docs/installation.md` | Modify | Add `PUBLIC_BASE_URL` to the environment tables and state it is required when `MAIL_ENABLED=true`. |

No migration: `invitations.expires_at` is already a nullable `TIMESTAMPTZ` (`000002_admin_backend_foundation.sql:25`).

## Interfaces / Contracts

### Configuration

```go
// internal/config
type Config struct { Server ServerConfig; Auth AuthConfig; Database DatabaseConfig; Mail MailConfig; App AppConfig; CORS CORSConfig }

type AppConfig struct { PublicBaseURL string }

func (c AppConfig) Validate(mailEnabled bool) error {
	if c.PublicBaseURL == "" {
		if mailEnabled {
			return fmt.Errorf("PUBLIC_BASE_URL is required when mail is enabled")
		}
		return nil
	}
	parsed, err := url.Parse(c.PublicBaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("PUBLIC_BASE_URL must be an absolute http(s) URL without query or fragment")
	}
	return nil
}
```

In `Load`, after the existing `mailConfig.Validate()`:

```go
appConfig := AppConfig{PublicBaseURL: strings.TrimRight(envString("PUBLIC_BASE_URL", ""), "/")}
if err := appConfig.Validate(mailConfig.Enabled); err != nil { return Config{}, err }
```

A non-empty value is validated even when mail is disabled, so a typo fails at startup rather than at the first invitation. `MailConfig` is unchanged.

### Service

```go
// internal/organizations
const invitationTTL = 168 * time.Hour // D1: 7 days, fixed in code

type InvitationCreation struct {
	Invitation       Invitation
	OrganizationName string
	InviterEmail     string
	InviterName      string // "" when users.name is NULL/blank
	ExpiresAt        time.Time
}

func (s *Service) CreateInvitationTx(ctx context.Context, tx pgx.Tx, requesterUserID, organizationID string, input CreateInvitationInput) (InvitationCreation, error)
func (s *Service) CreateInvitation(ctx context.Context, requesterUserID, organizationID string, input CreateInvitationInput) (InvitationCreation, error)
```

Inside `CreateInvitationTx`, all existing ordering is preserved — email/role/token validation, `requireOrganizationAdmin` (`:371`), the expire-pending `UPDATE`, the member-exists check, the pending-exists check — then the INSERT gains the expiry:

```go
expiresAt := time.Now().UTC().Add(invitationTTL)
// INSERT INTO invitations (organization_id, email, role, token, invited_by_user_id, expires_at)
// VALUES ($1, $2, $3, $4, $5, $6)
// RETURNING <unchanged column list, still expires_at::text>
```

One additional query runs after a successful INSERT (so failure paths pay nothing) and inside the same `tx`:

```sql
SELECT o.name, u.email, COALESCE(NULLIF(TRIM(u.name), ''), '')
FROM organizations o
JOIN users u ON u.id = $2
WHERE o.id = $1
```

`pgx.ErrNoRows` maps to `ErrNotFound`; it is defensive only, since `requireOrganizationAdmin` already proved both rows exist. `CreateInvitation` (non-tx wrapper) returns the same struct so both handler branches behave alike.

### Notification port and message

```go
// internal/organizations/invitation_mail.go
type InvitationNotification struct {
	InvitationID     string
	OrganizationID   string
	OrganizationName string
	InviterEmail     string
	InviterName      string
	InviteeEmail     string
	Role             string
	Token            string
	ExpiresAt        time.Time
}

type invitationNotifier interface {
	NotifyInvitation(context.Context, InvitationNotification) error
}

type MailInvitationNotifier struct {
	mailer        mailer.Mailer
	publicBaseURL string
	logger        *log.Logger
}

func NewMailInvitationNotifier(m mailer.Mailer, publicBaseURL string, logOutput io.Writer) *MailInvitationNotifier
func (n *MailInvitationNotifier) NotifyInvitation(ctx context.Context, notification InvitationNotification) error
```

The interface stays unexported, matching `routeService`/`creationTxService`; only the concrete type and constructor are exported so `main` can build one.

Link construction:

```go
func invitationAcceptURL(baseURL, token, inviteeEmail string) string {
	return strings.TrimRight(baseURL, "/") + "/invitations/" + url.PathEscape(token) +
		"?" + url.Values{"email": {inviteeEmail}}.Encode()
}
```

`url.Values.Encode` yields `email=invitee%40example.com`, matching the spec scenario exactly.

Copy (`org` is CR/LF-stripped and whitespace-collapsed before use; `inviter` is `"Name (email)"` when `InviterName != ""`, otherwise the bare email; `role` maps `owner|admin|member` to `an owner|an admin|a member`; `expiry` is `ExpiresAt.UTC().Format("2 January 2006 15:04 UTC")`):

- Subject: `You are invited to join {org} on URLises`
- Text:

      {inviter} invited you to join {org} on URLises as {role}.

      Accept the invitation:
      {acceptURL}

      This invitation expires on {expiry}, 7 days after it was sent.
      If you did not expect this invitation you can ignore this message.

- HTML (rendered through a package-level `html/template`, so `{org}`, `{inviter}` and the `href` are context-escaped):

      <!DOCTYPE html><html><body>
      <p>{inviter} invited you to join <strong>{org}</strong> on URLises as {role}.</p>
      <p><a href="{acceptURL}">Accept the invitation</a></p>
      <p>This invitation expires on {expiry}, 7 days after it was sent.
      If you did not expect this invitation you can ignore this message.</p>
      </body></html>

Both bodies are non-empty by construction, satisfying `compose`'s `message.Text == "" || message.HTML == ""` rejection at `smtp.go:125`. The subject is sanitized before composition because organization names are free user input and `safeHeader` (`smtp.go:125`, `:141`) rejects any CR/LF, which would otherwise turn an admin-chosen org name into a silent send failure.

`NotifyInvitation` returns the send error for testability and logs the outcome in the repo's `event=` style (`httpapi/errors.go:39-41`):

- `event=invitation_email_sent invitation_id=<id> organization_id=<id>`
- `event=invitation_email_failed invitation_id=<id> organization_id=<id> reason=disabled` for `errors.Is(err, mailer.ErrDisabled)`
- `event=invitation_email_failed invitation_id=<id> organization_id=<id> reason=send_error` otherwise

The invitee address, the token, the accept URL and the raw SMTP error are never logged: the token is a bearer credential and the mailer's own contract forbids leaking addresses, bodies and server replies.

### Handler

```go
type creationTxService interface {
	AuthorizeOrganizationCreationTx(context.Context, pgx.Tx, string) error
	AuthorizeInvitationTx(context.Context, pgx.Tx, string, string) error
	CreateOrganizationTx(context.Context, pgx.Tx, string, CreateOrganizationInput) (Membership, error)
	CreateInvitationTx(context.Context, pgx.Tx, string, string, CreateInvitationInput) (InvitationCreation, error) // was (Invitation, error)
}

type routeService interface {
	// ...unchanged...
	CreateInvitation(context.Context, string, string, CreateInvitationInput) (InvitationCreation, error) // was (Invitation, error)
}

func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, service routeService, notifier invitationNotifier, executors ...*httpapi.IdempotencyExecutor)
```

`notifier` sits before the variadic and tolerates a nil interface, exactly as `auth.RegisterRoutes(mux, service, invitations invitationAccepter)` already does with its `if invitations != nil` guard; existing tests pass a literal `nil`.

The idempotent branch of `POST /organizations/{organizationId}/invitations` becomes:

```go
identity := idempotencyIdentity(r, principal.UserID, "POST /organizations/{organizationId}/invitations", []string{organizationID}, input)
result, _, hook, err := executor.ExecutePrepared(r.Context(), idempotencyScope(identity),
	func(ctx context.Context, tx pgx.Tx) (httpapi.Prepared, error) {
		if err := txService.AuthorizeInvitationTx(ctx, tx, principal.UserID, organizationID); err != nil {
			return httpapi.Prepared{}, err
		}
		return httpapi.Prepared{Fingerprint: identity.Fingerprint, Command: func(ctx context.Context, tx pgx.Tx) (httpapi.SafeResult, httpapi.PostCommit, error) {
			created, err := txService.CreateInvitationTx(ctx, tx, principal.UserID, organizationID, input)
			if err != nil {
				return httpapi.SafeResult{}, nil, err
			}
			var post httpapi.PostCommit
			if notifier != nil {
				notification := invitationNotification(created)
				post = func(ctx context.Context) error { return notifier.NotifyInvitation(ctx, notification) }
			}
			return httpapi.SafeResult{Status: http.StatusCreated, Body: invitationCreation(created.Invitation)}, post, nil
		}}, nil
	})
if err != nil {
	writeIdempotencyError(w, err, writeOrganizationError)
	return
}
httpapi.WriteJSON(w, result.Status, result.Body)
if hook != nil {
	_ = http.NewResponseController(w).Flush()
	_ = hook(context.WithoutCancel(r.Context()))
}
return
```

with

```go
func idempotencyScope(identity httpapi.IdempotencyIdentity) httpapi.IdempotencyScope {
	return httpapi.IdempotencyScope{PrincipalID: identity.PrincipalID, Method: identity.Method, Route: identity.Route, Key: identity.Key}
}
```

which reproduces exactly what `Execute` builds internally (`idempotency.go:119`), so scope, fingerprint and route string are byte-identical to today's behaviour and existing idempotency records stay valid. The hook error is discarded at the handler because the notifier already logged it and the response is already on the wire — this is the "delivery failure never fails the request" requirement made structural rather than conventional.

The non-idempotent branch calls `service.CreateInvitation`, writes `created.Invitation`, then performs the same flush-and-notify so the two branches cannot drift.

### Replay cannot double-send

The guarantee is by construction in `ExecutePrepared`, not by a check in our code:

- `idempotency.go:161` — when `claimReceipt` finds a completed receipt, the function returns `(replayed, IdempotencyReplayed, nil, tx.Commit(ctx))`. The third value is a **literal `nil`**, so a replayed request cannot carry a hook.
- `idempotency.go:163` — `prepared.Command(ctx, tx)` is reached only past that `if found` return, so the closure that captures the notification is never even constructed on a replay.
- `idempotency.go:170-173` — the hook is returned only after `tx.Commit(ctx)` succeeds; a commit error returns `(SafeResult{}, "", nil, err)`.
- `idempotency.go:186` — a fingerprint mismatch returns `ErrIdempotencyKeyConflict` before `Command`, so a key reused with a different body sends nothing.
- `idempotency.go:143-148` — a concurrent duplicate fails the advisory lock and returns `ErrIdempotencyInProgress` before `prepare` runs.

The handler's only obligation is `if hook != nil`, and the only way to break the guarantee would be to build the notification outside `Command` and send it unconditionally, which the code above does not do.

### Accept API client

```ts
// admin-web/src/lib/api/invitations.ts
import { apiRequest } from "./client";
import type { AcceptedInvitation } from "./types";

export function acceptInvitation(accessToken: string, invitationToken: string) {
  return apiRequest<AcceptedInvitation>(`/invitations/${encodeURIComponent(invitationToken)}/accept`, {
    method: "POST",
    token: accessToken,
  });
}
```

```ts
// admin-web/src/lib/api/types.ts
export interface AcceptedInvitation {
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}
```

The two distinct "tokens" are disambiguated in the parameter names. No `Idempotency-Key` is sent: the backend route is registered by `auth.RegisterRoutes` without an executor, and accepting twice is already handled server-side (`ErrInvitationNotPending`).

### Frontend routing

```tsx
// router.tsx, sibling of /login and /register, outside RequireSession
{ path: "/invitations/:token", element: <InvitationAcceptPage /> },
```

`InvitationAcceptPage` reads `useParams<{ token: string }>()` and `useSearchParams()`, then branches on `useAuth().status`:

| `status` | Behaviour |
|---|---|
| `loading` | `<DataState tone="neutral" title="Checking your session" …/>` |
| `anonymous` | `<Navigate replace to={`/login?${params}`}/>` where `params` is `invitation={token}` plus `email` when present |
| `setupRequired` | same, to `/register` |
| `authenticated` | `useEffect` guarded by a `useRef` flag calls `acceptInvitation(session.accessToken, token)` once, then `refreshOrganizations()` |

The `useRef` guard is required because React StrictMode double-invokes effects in development and the accept call is not idempotent from the client's point of view — the second call would return `invitation is not pending` and render a false failure.

On success the page renders its own outcome screen rather than navigating to `/`: `RequireAdminOrganization` (`router.tsx:37-60`) renders "Organization admin access required" for a membership with no owner/admin role, so an invitee accepting a `member` invitation would be dropped straight into an error screen. Instead the page shows "You joined {organizationName} as {role}" and offers a "Go to the admin console" link only when the accepted role is `owner` or `admin`; otherwise it states that the URLises browser extension is where a member works.

Error mapping, all rendered inline with `DataState tone="danger"` inside the same `ui-login-card` shell:

| Condition | Title | Description and action |
|---|---|---|
| `ApiError` 400, message `invitation email does not match authenticated user` | "Signed in with a different address" | "This invitation was sent to {email from the query param, when present}. Sign out and sign in with that address to accept it." Renders a **Sign out** button calling `signOut()`, which returns the visitor to `anonymous` and therefore back through `/login?invitation=…` on the next render. |
| `ApiError` 400, message `invitation is not pending` | "This invitation is no longer valid" | "It was already accepted, cancelled, or it expired. Invitations are valid for 7 days — ask an organization admin to send a new one." |
| `ApiError` 404 (`not found`) | "Invitation not found" | "The link is incomplete or the invitation was removed. Check the link in your email or ask for a new invitation." |
| any other error | "Could not accept the invitation" | Generic copy plus a **Try again** button that resets the `useRef` guard and re-runs the effect. |

Expired and invalid tokens are deliberately not distinguished beyond what the backend already returns, so the page never confirms whether an arbitrary token exists.

### LoginPage changes

New: `const [searchParams] = useSearchParams();`

```tsx
const invitation = searchParams.get("invitation");
const invitedEmail = searchParams.get("email");
const returnTo = invitation
  ? `/invitations/${encodeURIComponent(invitation)}${invitedEmail ? `?email=${encodeURIComponent(invitedEmail)}` : ""}`
  : "/";
```

- `LoginPage.tsx:15` — `<Navigate to="/" replace/>` becomes `<Navigate to={returnTo} replace/>`. This is the whole post-auth return mechanism: `signIn` flips `status` to `authenticated`, the component re-renders, and the existing guard now carries the user back to the accept page.
- `LoginPage.tsx:11` — form initial state takes `email: invitedEmail ?? ""`. Prefilled but **editable**: an existing operator may legitimately hold the invited address under a different login, and the backend remains the authority.
- `LoginPage.tsx:70` — the register link becomes `<Link to={{ pathname: "/register", search: searchParams.toString() }}>` so both params survive the round trip.

`returnTo` is built from `encodeURIComponent(invitation)` interpolated into a fixed local path; no query parameter is ever used as a redirect target directly, so this introduces no open-redirect surface.

### RegisterPage changes

Same `useSearchParams`/`returnTo` derivation, with `returnTo` defaulting to `/setup/organization` instead of `/`.

- `RegisterPage.tsx:21-23` — today `status === "anonymous"` unconditionally redirects to `/login`. This must become `if (status === "anonymous" && !invitation) return <Navigate to="/login" replace/>;`. **Without this, the primary invitee path is dead**: `POST /auth/register` has no first-owner gate (`auth/service.go:140-190` inserts a user with no precondition), but `SetupRequired` is `NOT EXISTS(SELECT 1 FROM organizations)` (`auth/service.go:122-128`), so as soon as any organization exists every invitee without an account is bounced off the only registration form in the product.
- `RegisterPage.tsx:18-19` — `<Navigate to="/" .../>` becomes `<Navigate to={returnTo} .../>`.
- `RegisterPage.tsx:35` — `navigate("/setup/organization", { replace: true })` becomes `navigate(returnTo, { replace: true })`. An invitee is joining an existing organization and must not be pushed into first-run org creation.
- `RegisterPage.tsx:11` — initial `email: invitedEmail ?? ""`.
- `RegisterPage.tsx:52` — when `invitation && invitedEmail` are both present the email input renders `readOnly aria-readonly="true"` with `FormRow hint="This invitation was sent to this address, so it cannot be changed here."`.
- `RegisterPage.tsx:47-49` — heading and copy become invitation-aware ("Create your account to join {org is unknown here, so: this organization}") when `invitation` is present, since "Create the first owner" is wrong for an invitee.
- `RegisterPage.tsx:59` — the login link preserves `searchParams`.

The invited email is not treated as a secret: the token in the same link already grants membership for that exact address, so surfacing it in the URL adds no capability.

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit (config) | `PUBLIC_BASE_URL` required when enabled, scheme/host/query/fragment rejection, trailing-slash trim, empty allowed when disabled | Table-driven `config_test.go` with `t.Setenv`. |
| Unit (mail content) | Exact accept URL for the spec scenario; org name, inviter, role and expiry present in **both** bodies; CR/LF org name still produces a sendable subject; HTML escaping of a `<script>` org name | `invitation_mail_test.go` with a fake `mailer.Mailer` capturing the `Message`. |
| Unit (mail logging) | `ErrDisabled` logs `reason=disabled` and returns the error; no token, invitee address or URL appears in the log buffer | Inject a `bytes.Buffer` as `logOutput`; assert on substrings and on absence of the token. |
| Unit (handler) | Fresh command invokes the notifier exactly once; replay invokes it zero times; a notifier error still yields 201 with the created body; fingerprint conflict sends nothing | `handler_test.go` with a counting notifier stub and a fake `creationTxService`. |
| Integration (service) | `expires_at` lands at `now + 168h ± skew`; `InvitationCreation` carries org name and inviter email; a NULL `users.name` yields `InviterName == ""` | Existing `organizations` DB-backed test setup. |
| Unit (frontend) | Redirect target per `status`; params preserved through login/register links; accept called once under StrictMode; each error mapping renders its own copy; `readOnly` email on register | `InvitationAcceptPage.test.tsx` + `router.test.tsx` with a mocked `lib/api/invitations`. |
| Manual | End-to-end via Mailpit on `127.0.0.1:8025`: create an invitation, open the link from the received message, register, land as a member | Documented in `docs/deployment.md`. |

## Threat Matrix

| Surface | Risk | Mitigation |
|---|---|---|
| Invitation token in a URL | Token appears in browser history, referrers and any forwarded copy of the mail | Already the token's designed transport; scoped to one organization, one email and now bounded to 7 days by D1. The `Referer` risk is limited because the accept call is same-origin `fetch`, not a cross-origin navigation. |
| Token in logs | A leaked log grants membership | The notifier logs only `invitation_id` and `organization_id`; the token, the invitee address and the accept URL are never logged. |
| Header injection via organization name | A name containing CR/LF turns into forged mail headers | The subject is CR/LF-stripped and whitespace-collapsed before composition; `compose` (`smtp.go:125`, `:141`) independently rejects anything that slips through, so a malicious name degrades to a failed send, never a forged header. |
| HTML injection in the mail body | A name containing markup executes in the invitee's mail client | The HTML body is rendered through `html/template`, which context-escapes both text nodes and the `href`. |
| Open redirect via `returnTo` | A crafted `/login?...` sends the user off-site after auth | `returnTo` is a fixed local path with only `encodeURIComponent(invitation)` interpolated; no query value is used as a redirect target. |
| Invitation existence oracle | An unauthenticated visitor probes tokens | No unauthenticated lookup endpoint is added; `/invitations/:token` renders nothing token-specific until the visitor is authenticated, and 404/400 copy does not distinguish "expired" from "never existed". |
| Email mismatch bypass | A visitor accepts an invitation addressed to somebody else | Unchanged: `AcceptInvitation` (`service.go:517`) compares the authenticated user's email to the invitation's. The frontend prefill is UX only and is never trusted. |
| SMTP availability coupling | A hung relay stalls the admin console | The hook runs after `WriteJSON` + `Flush`, so the 201 is already on the wire; `MAIL_TIMEOUT` bounds the dial. |

No shell, subprocess, VCS or process-integration boundary is introduced.

## Migration / Rollout

No schema migration. `expires_at` is already nullable, existing rows keep `NULL` and therefore never-expires semantics (`service.go:514`); only invitations created after this change carry the 7-day bound, and nothing backfills.

`PUBLIC_BASE_URL` must be set in every environment where `MAIL_ENABLED=true` before deploying, otherwise `config.Load` fails fast at startup — a deliberate fail-closed choice, since a silently wrong base URL produces invitations that look delivered but cannot be accepted. Local compose already sets `MAIL_ENABLED: "true"`, so `docker-compose.yml` and `docker-compose.prod.yml` must land in the same commit as the config change.

Rollback: `MAIL_ENABLED=false` returns `ErrDisabled` before any dial, the notifier logs `reason=disabled`, and invitation creation is otherwise unaffected — the pre-change out-of-band token workflow still works. Reverting the branch removes the route and the config requirement with no data to undo; invitations created while the change was live keep their `expires_at` and simply expire.

## Open Questions

None blocking. Two observations recorded for follow-up work, both out of scope here:

- `admin-web`'s `normalizeInvitation` (`organizations.ts:11,25`) reads an `invitedByEmail` field the backend never emits. `CreateInvitationTx` now fetches exactly that value, so extending `ListInvitations` and `invitationCreation` to emit it would close a pre-existing gap cheaply — but it is a response-shape change unrelated to email delivery.
- Nothing resends, cancels or lists delivery outcomes. An admin can only infer a failed send from `event=invitation_email_failed` in the API logs, which is the accepted cost of the "no outbox, no retry" boundary.
