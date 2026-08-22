# Exploration: secret-recipient-directory

## Current State

**Send-by-email flow (extension → backend), confirmed end to end:**

- `extension/src/create-secret/create-secret.html` has a single free-text `<input id="recipient-email" type="email">` inside `#send-email-form`, inline in the compact `#secret-link-result` panel (only shown after a secret is created).
- `extension/src/create-secret/create-secret.ts`'s `runSendSecretEmail()` (lines 181–199) reads `recipientEmailInput.value.trim()`, does no validation beyond emptiness, and sends a `secrets/send-email` background message with `{ token: createdToken, recipientEmail, fragment }`.
- Backend: `backend/internal/secrethide/handler.go`'s `POST /secrets/{token}/send-email` (line 140) is `authMiddleware`-gated, decodes via `send_email.go`'s `decodeSendSecretLinkInput` (allow-lists exactly `recipientEmail`/`fragment`, validates the email is `mail.ParseAddress`-parseable), loads the secret via `service.LoadOwned` (creator-only), then calls `secretLinkMailer.SendSecretLink` (`mail.go`) which composes and sends the email, logging only the recipient's domain. On success it best-effort records the recipient into the secret's own row via `service.RecordEmailSent` (surfaced later as `sentToEmail` in `GET /secrets`'s history view, consumed by admin-web).
- There is **no directory, autocomplete, or recipient-validation lookup anywhere in this path today** — it is blind free-text.

**Member-listing authorization — the critical finding:**

- `backend/internal/organizations/service.go`'s `ListMembers` (line 231) is the **only** organization-member-listing capability in the entire backend, and it is unconditionally gated by `requireOrganizationAdmin` (line 1046 → `loadOrganizationRole` must return `owner` or `admin`, else `ErrForbidden`).
- Its only route, `GET /organizations/{organizationId}/members` (`handler.go:101`), passes `principal.UserID` straight into `service.ListMembers` with no separate authorization branch for plain members.
- A repo-wide search confirms `ListMembers` exists in exactly two places: `organizations` (admin-gated) and `groups` (`groups/service.go:289`, also admin-gated — it resolves the group's organization and calls `requireOrganizationAdmin`, and is a workspace-access-group concept, unrelated to org membership anyway).
- **A plain `member` role in an organization cannot list that organization's other members through any existing endpoint.** This is confirmed, not assumed — no non-admin member-listing capability exists anywhere in the codebase today.
- By contrast, `ListMemberships` (`service.go:137`, route `GET /organizations` at `handler.go:40`) is unscoped — any authenticated user gets their own membership list (org id/name/role) with no admin gate. This is the piece the extension already fetches.

**What the extension already fetches:**

- `extension/src/shared/api.ts` exposes exactly `getOrganizations` (→ `OrganizationMembership[]`: `organizationId`, `organizationName`, `role` — no email/name of other users, see `types.ts:18-22`) and `getWorkspaces` (per-org). No function fetches full member lists with emails anywhere in the extension.
- `extension/src/background/projection.ts`'s `refreshWorkspaceCatalog` (line 1673) is the established pattern for aggregating across all of a user's organizations: it calls `getOrganizations` once, then **sequentially loops** `for (const organization of organizations) { workspacesByOrganization[...] = await getWorkspaces(...) }` — one round trip per org, not parallelized, no server-side union endpoint. This is the only existing precedent in this codebase for "combine per-org data across all my orgs," and it does so client-side with N round trips.
- Every existing multi-scope listing endpoint in this codebase (`organizations.ListMembers`, `workspaces.ListByOrganization`, `groups.ListMembers`) takes a single `organizationId`/scope parameter and returns data for exactly one scope — there is no existing "resolve everything reachable from `principal.UserID` across all scopes" endpoint shape (e.g. no `GET /me/directory`-style precedent) anywhere in `organizations` or `workspaces`.

**UI/UX real estate:**

- `create-secret.html` is deliberately compact per this session's earlier design work (`ui-shell--compact-window`, `ui-hero--compact`, `ui-panel--compact`, `ui-grid--compact` classes throughout) — confirmed still true by reading the current file, not just recalled.
- No autocomplete/typeahead/searchable-list/`<datalist>`/combobox pattern exists anywhere in `extension/src` (checked `options.ts`, and repo-wide grep for `datalist`, `combobox`, `role="listbox"` returned zero matches). A recipient picker would introduce an entirely new UI pattern for this extension, and it must fit inside the compact-window constraint.

**Privacy/data shape:**

- `OrganizationMember` (`service.go:54-59`) exposes `UserID, Email, Name, Role`. A picker only needs enough to identify a send target — `Email`/`Name` — not `Role`.
- There is no existing precedent in this codebase for a *redacted/narrower listing of other users' data for a non-admin audience*. `access.GetEffectiveWorkspaceAccess` is a different shape entirely — it computes one user's own effective access to one workspace, not a filtered list of other users. Every existing member-listing capability (`ListMembers` in both `organizations` and `groups`) returns the identical full shape and is always admin-only. A non-admin-facing directory endpoint would be establishing a new data-minimization precedent for this codebase, not following one.

**admin-web scope confirmed:** `admin-web/src/features/secret-history/SecretsPage.tsx` is read-only (`useMySecrets`, a `DataState`/`Table` of the signed-in user's own past secrets, explicit copy: "Use the URLises extension's 'Create a secret' window to share a new one"). No create-secret or send-email code exists anywhere under `admin-web/src`. Confirmed still true.

## Affected Areas

- `extension/src/create-secret/create-secret.ts` — `runSendSecretEmail`, `recipientEmailInput` wiring; needs new picker state/fetch/render logic.
- `extension/src/create-secret/create-secret.html` — needs new picker markup within the existing compact-window constraint.
- `extension/src/shared/api.ts` / `extension/src/shared/types.ts` — needs a new fetch function and response type for directory data (no existing member-list fetcher to extend).
- `backend/internal/organizations/service.go` / `handler.go` — the admin gate on `ListMembers` is the blocking constraint; a non-admin-safe capability (new method and/or new route) is required here, this is the crux of the design decision.
- `backend/internal/secrethide/handler.go` / `send_email.go` — the send-email endpoint itself does not need to change (still just `recipientEmail` + `fragment`); the directory is a pre-fill/pick mechanism, not a change to what's ultimately submitted.
- `backend/internal/groups/service.go` — confirmed as an unrelated, separately-admin-gated concept (workspace-access groups, not org membership); not a viable shortcut.

## Approaches

Two independent axes emerged, both real forks worth carrying into the proposal phase (not decided here):

### Axis 1 — where the union/dedup happens

1. **N client-side round trips** (extend `ListMemberships` result, then call a new non-admin per-org member-listing endpoint once per org, dedup by `userId` in the extension) — mirrors the exact existing `refreshWorkspaceCatalog` pattern.
   - Pros: matches an established codebase precedent exactly; smaller backend surface (one new per-org endpoint, admin-gate removed/relaxed); incremental.
   - Cons: N round trips before the picker is usable (latency scales with org count); dedup/minimization logic duplicated on the client; the existing precedent is sequential/non-parallel and was never built for a modal-blocking UI.

2. **One new server-side union endpoint** (e.g. `GET /me/directory`, resolving from `principal.UserID`, joining `organization_members` across every org the caller belongs to, deduped in SQL) — no existing precedent of this shape in this codebase.
   - Pros: single round trip; dedup and minimization enforced server-side in one place; simpler extension code.
   - Cons: net-new endpoint shape with no direct precedent to mirror; combines authorization logic that today lives in two separate service methods into one new code path.

### Axis 2 — UI shape for the picker

1. **New lightweight filter-as-you-type list** inside the existing compact panel (plain `<input>` + filtered `<ul>`, no external library) — smallest addition consistent with this extension's plain-DOM style.
2. **Native `<datalist>`** bound to the email input — zero new interaction code, but doesn't render a name alongside an email cleanly in most browsers, and doesn't support loading/error-state feedback this flow already needs.

## Recommendation

Not resolved here — exploration only. The single most consequential fact for the proposal phase: **the sender-facing directory cannot be built by calling `ListMembers` as it exists today**, because it is unconditionally admin-gated and the sender is frequently a plain member. Any proposal must explicitly decide how to expose a non-admin-safe, minimized (`name`/`email` only, no `role`) member-listing capability, and must explicitly choose one of the two round-trip shapes above — both are architecturally defensible but have no single obvious "matches existing pattern" answer.

## Risks

- **Authorization redesign risk**: loosening or adding an alternative to `requireOrganizationAdmin` for member-listing touches a security-sensitive choke point; needs careful scoping so a non-admin capability can't be widened into a de facto `ListMembers` bypass for admin-only fields (`role`, potentially future fields).
- **Cross-org leakage risk**: the explicit exclusion (no visibility into orgs the sender doesn't belong to) must be enforced identically whether implemented as N calls or as one union endpoint — the union-endpoint approach is structurally safer here since it derives membership from `principal.UserID` server-side, never from client-supplied org IDs.
- **Latency/UX risk**: if N-round-trips is chosen and a sender belongs to many orgs, the picker's fill time scales with org count inside an already-compact, time-sensitive modal.
- **New UI pattern risk**: no autocomplete/filter pattern exists anywhere in this extension today — genuinely new surface (accessibility, keyboard nav, empty/loading/error states), not an extension of an existing one.
- **Scope creep risk**: the out-of-scope admin-managed cross-org grant idea (discussed earlier this session as a maybe-later idea) must stay explicitly out of this proposal.

## Ready for Proposal

Yes. The two real forks (round-trip shape, picker UI shape) and the hard authorization constraint are now grounded in actual code and should be carried directly into `sdd-propose` as explicit open decisions.
