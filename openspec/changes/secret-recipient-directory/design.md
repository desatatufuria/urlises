# Design: Secret Recipient Directory

## Technical Approach

Three additive layers, no schema change, no migration.

**Backend.** One new minimized type (`MemberName`) and one new service method
(`ListSecretRecipients`) in `organizations`, exposed as `GET /me/secret-recipients`. The method is a
single SQL query whose only parameterized input is `principal.UserID`; membership is the query's
`IN (SELECT …)` predicate, so cross-org leakage is structurally impossible rather than checked.
`ListMembers`, `requireOrganizationAdmin` and `loadOrganizationRole` are byte-for-byte untouched.

**Transport.** The create-secret page cannot call `shared/api.ts` — see the verification table — so
the directory travels the existing background message bus: a new `secrets/recipients` message next
to `secrets/create` / `secrets/send-email` / `secrets/list`.

**Extension.** A prefetched, filter-as-you-type list rendered as a sibling *outside*
`#send-email-form`, whose only effect is assigning `recipientEmailInput.value`. `runSendSecretEmail`
is unchanged.

### Verified against source, correcting the proposal and exploration

| Prior statement | Verified reality |
|---|---|
| Proposal Dependencies: "Existing org-membership check helper in `organizations` (or the `groups` equivalent) — design confirms which" | **Neither.** `organizations/service.go` has `requireOrganizationAdmin` (`:1046`) and `loadOrganizationRole` (`:1062`) only — no membership-only helper exists. `groups.requireOrganizationMembership` (`groups/service.go:404`) is the shape but a different package. This design creates **no helper at all**: the union query's subquery *is* the gate. |
| Proposal A: "Add `organizations.ListMemberNames`" | **Deviation 1 — not implemented.** The single-SQL union of Decision B never calls a per-org method, so `ListMemberNames` would ship with zero callers. Decision A's *safety content* (minimized non-role shape, membership instead of admin) is delivered in full by `MemberName` + `ListSecretRecipients`. **Confirm.** |
| Proposal A/B: `ListMemberNames` may need its own HTTP route | **No route.** Explicit call: a routed, org-scoped, non-admin member listing with no consumer is exactly the "widens into a `ListMembers` bypass" risk row, bought for nothing. |
| Proposal F: pending invitations excluded | **Confirmed structural, zero filtering needed.** `INSERT INTO organization_members` appears in exactly two non-test places: `CreateOrganizationTx` (`:195`, creator ⇒ owner) and `AcceptInvitation` (`:846`). Pending invitations live only in `invitations`. |
| Proposal (silent) on deactivated users | **Gap found.** `users.disabled_at` exists (`migrations/000013`). `auth.DeactivateSelf` (`auth/service.go:164`) sets `disabled_at` and **retains** every `organization_members` row. Without a filter a deactivated coworker appears as a delivery target. **Deviation 2 — this design adds `AND u.disabled_at IS NULL`.** |
| Exploration: "no `resolve everything reachable from principal.UserID` endpoint shape exists" | **Wrong.** `GET /organizations` (`ListMemberships`, `:137`) and `GET /organizations/deleted` (`ListDeletedOrganizations`, `:1013`) are exactly that shape. What is genuinely new is only that the returned rows describe *other users*. |
| Proposal Affected Areas: extension changes are `create-secret.*` + `shared/api.ts`/`types.ts` | **Incomplete.** `create-secret.ts` never imports `api.ts`; `api.ts`'s `requestRaw` (`:332`) signs requests with `getRuntimeAccessToken()`, a module-level in-memory variable in `shared/session.ts:10` that is only ever populated in the service worker (`state.session.accessToken` is persisted as `""`, `session.ts:48`). Calling `api.ts` from the window would send `Bearer ` (empty). `background/projection.ts` and `background/service-worker.ts` **must** change too. |
| — (not previously noticed) | `organizations/predicate_test.go:29` asserts the org-liveness JOIN appears **exactly 3 times**. The new subquery makes it 4, so that test **fails on the GREEN commit** unless updated in the same slice. It becomes choke point **CP14** (CP1-CP13 are all taken). |

## Architecture Decisions

| # | Decision | Options / tradeoff | Choice and rationale |
|---|---|---|---|
| 1 | **Shape of the new capability** | (a) `ListMemberNames(requester, orgID)` + `ListSecretRecipients(requester)`; (b) `ListMemberNames` only, N calls client-side; (c) `ListSecretRecipients` only | **(c).** (b) is Axis-1 option 1, rejected by Decision B. (a) is Decision A's literal wording, but the union's SQL dedup (Decision B, verbatim: "joining and deduping in SQL") means nothing would ever call the per-org method — dead code that is also a new non-admin authorization surface. **Deviation 1, confirm.** |
| 2 | **Return type** | Reuse `OrganizationMember`; add a distinct `MemberName` | **Distinct `MemberName{UserID,Email,Name}`.** `OrganizationMember` (`:54`) carries `Role`. Reusing it with `Role` left as `""` makes "no role leaks" a *runtime* property maintained by discipline; a type with no role field makes it a *compile-time* property. This type is Decision A's actual guard. |
| 3 | **Where the membership gate lives** | New `organizations.requireOrganizationMembership` helper called before the query; the query's own subquery | **The subquery.** A separate helper needs an `organizationID` to check, and the union has no single org — it would have to loop, reintroducing Decision 1(a). `WHERE peer.organization_id IN (SELECT … WHERE om.user_id = $1)` is a gate that cannot be forgotten, skipped, or called with the wrong argument. |
| 4 | **Dedup mechanism** | `DISTINCT`; `DISTINCT ON (u.id)`; `GROUP BY` | **`SELECT DISTINCT u.id, u.email, COALESCE(u.name,'')`.** `u.id` is `users`' PK, so the triple is functionally determined by it — DISTINCT over the triple is exactly DISTINCT over user identity. `DISTINCT ON (u.id)` would force `ORDER BY u.id` first and lose the email ordering. Decision F's "no org attribution" is what makes this trivial: no contributing-org column to collapse. |
| 5 | **Self-inclusion (Decision F)** | Explicit union of self; natural | **Natural, zero code.** The requester is a member of their own orgs, so `peer` already contains their row. *Excluding* self would need an extra `AND peer.user_id <> $1`. Test asserts the absence of that predicate's effect. |
| 6 | **Deactivated users** | Silent (proposal); `AND u.disabled_at IS NULL` | **Filter them out.** Decision F's own stated principle — "a still-pending invitation is not a reliable delivery target and is excluded" — applies identically. `ListMembers` deliberately keeps showing them, because an admin roster must be able to manage a deactivated member; a *delivery-target* directory must not offer one. **Deviation 2, confirm.** |
| 7 | **Route path** | `GET /me/secret-recipients` (proposal); `GET /organizations/recipients` | **`GET /me/secret-recipients`** as proposed. The path expresses the authorization derivation (principal-scoped, no path parameter to tamper with). Go 1.22 `ServeMux` matches `GET /me` as an exact literal, so there is no conflict or precedence interaction with auth's `/me`, `/me/preferences`, `/me/deactivate`. |
| 8 | **Route owner package** | `auth` (owns `/me/*`); `organizations` | **`organizations`.** `auth.RegisterRoutes` would need an `organizations` dependency — the exact coupling the existing `invitationAccepter` adapter (`auth/handler.go:15`) was invented to avoid, and here it buys nothing: the query, the errors (`writeOrganizationError`) and the data are 100% organizations-domain. Path namespace and package ownership are independent in this mux. Cost recorded: `/me/*` is now served by two packages — mitigated by a cross-reference comment in both handlers. |
| 9 | **Response envelope** | Bare array (`GET /secrets`); `{"recipients": […]}` | **`{"recipients": […]}`**, matching every list route in this package (`organizations`, `members`, `invitations`) and `workspaces`. The bare-array form is `secrethide`'s local convention, not this package's. |
| 10 | **Result cap** | Unbounded; `LIMIT` | **`LIMIT $2` with a package const `maxSecretRecipientResults = 500`**, mirroring `secrethide.ListOwned`'s `maxListOwnedResults` (`secrethide/service.go:279`). Closes the proposal's "directory grows large" risk row without inventing pagination for a picker that filters client-side. |
| 11 | **Extension transport** | Direct `api.ts` call from the window; background message | **Background message `secrets/recipients`.** Not a style preference — a direct call is broken (see verification table). |
| 12 | **Picker placement in the DOM** | Inside `#send-email-form`; sibling before it | **Sibling before the form, inside `#secret-link-result`.** A second text input inside a one-input form makes Enter trigger implicit submission; placing the picker outside removes the hazard structurally instead of with a `preventDefault` handler. |
| 13 | **When the directory is fetched** | On first focus/keystroke; at window open | **Fire-and-forget in `bootstrap()`, never awaited.** The flow guarantees a multi-second gap (paste secret → pick TTL → Create) before `#recipient-email` even exists, so the perceived latency is zero and the compact modal never blocks. It must not be awaited: a slow or failing directory fetch would otherwise delay or break the signed-in/signed-out gate rendering. |
| 14 | **Filter logic location** | Inline in `create-secret.ts`; new pure module | **New `create-secret/recipient-filter.ts`.** `create-secret.ts`'s own header comment states DOM wiring here is deliberately not unit tested; the repo's answer is a pure sibling module (`content-limit.ts`, `popup/advanced-toggle.ts`, `popup/status-detail.ts`). There is no DOM test harness in `extension/tests/` (plain `node --test` against `dist/`), so this is the only way the filter gets real coverage. |
| 15 | **Empty query renders no options** | Show first N unprompted; show nothing until 1 char | **Nothing until the user types**, with a hint line stating how many colleagues are searchable. Eight unprompted rows would dominate the deliberately compact panel. Recorded as a UX tradeoff (Open Questions). |
| 16 | **ARIA** | Full combobox/listbox pattern; plain list | **Plain `<ul>` of `<button type="button">`, no `role="listbox"`/`role="option"`, plus `aria-live="polite"` on the hint.** A `listbox` role without arrow-key navigation and active-descendant management is a worse lie than no role at all, and the proposal's mitigation for this risk row is "keep minimal; free-text fallback always available". Recorded as an Open Question, not an omission. |

## Data Flow

    create-secret window                     background service worker            backend
    --------------------                     -------------------------            -------
    bootstrap()
      sendMessage session/get  ─────────────► getUiState()
      void loadRecipients()   (NOT awaited)
        sendMessage secrets/recipients ─────► projection.listSecretRecipients()
                                                requires state.session
                                                api.getSecretRecipients ─────────► GET /me/secret-recipients
                                                                                     authMiddleware -> principal
                                                                                     ListSecretRecipients(principal.UserID)
                                                                                       ONE query, dedup + cap in SQL
                                              ◄──────────────────────────────────  200 {"recipients":[…]}
        state = {status:"ready", candidates} | {status:"error"}
        renderRecipientPicker()

    user types in #recipient-filter
      -> filterRecipients(candidates, query)        [pure, no DOM, unit tested]
      -> renderRecipientOptions(matches)            [DOM only]

    click on an option (delegated listener on #recipient-options)
      -> recipientEmailInput.value = option.dataset.email
      -> clear filter, collapse list, focus #recipient-email
      -> submit #send-email-form
           runSendSecretEmail()  ── UNCHANGED ──►  secrets/send-email  ──► POST /secrets/{token}/send-email

    SQL, once:
      peer set   := organization_members rows whose organization_id is in
                    (my live orgs: JOIN organizations … AND o.deleted_at IS NULL, WHERE om.user_id = $1)
      projection := DISTINCT (u.id, u.email, COALESCE(u.name,''))  filtered by u.disabled_at IS NULL
      order/cap  := ORDER BY u.email, u.id  LIMIT $2

## Interfaces / Contracts

### `backend/internal/organizations/service.go`

```go
// MemberName is the deliberately minimized projection of a coworker used by
// the secret-recipient directory: enough to identify a delivery target and
// nothing else. It is a DISTINCT type from OrganizationMember (which carries
// Role) precisely so this non-admin path cannot leak a role even by
// accident -- there is no field to populate. Do not add fields here.
type MemberName struct {
    UserID string `json:"userId"`
    Email  string `json:"email"`
    Name   string `json:"name,omitempty"`
}

// maxSecretRecipientResults caps the directory, mirroring
// secrethide.maxListOwnedResults. The picker filters client-side, so this is
// a blast-radius bound, not pagination.
const maxSecretRecipientResults = 500

// ListSecretRecipients returns the deduplicated union of every accepted,
// active member of every LIVE organization the requester belongs to,
// including the requester (self-send is supported). It is gated by
// MEMBERSHIP, not by admin role, and it deliberately does not accept an
// organization ID: the only caller-derived input is requesterUserID, so a
// caller cannot name an organization they do not belong to. ListMembers'
// requireOrganizationAdmin gate and role exposure are untouched by this path.
func (s *Service) ListSecretRecipients(ctx context.Context, requesterUserID string) ([]MemberName, error)
```

CP14 — the membership subquery is both the authorization gate and the org-liveness gate:

```sql
SELECT DISTINCT u.id, u.email, COALESCE(u.name, '')
FROM organization_members peer
JOIN users u ON u.id = peer.user_id AND u.disabled_at IS NULL
WHERE peer.organization_id IN (
    SELECT om.organization_id
    FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
    WHERE om.user_id = $1
)
ORDER BY u.email, u.id
LIMIT $2
```

Differences from `ListMembers`' query (`:236`), each deliberate: no `om.role` column; no
`requireOrganizationAdmin` call; no `ORDER BY CASE om.role …` (impossible — role is not selected,
which is the point); `DISTINCT`; the membership subquery replaces `WHERE om.organization_id = $1`;
`u.disabled_at IS NULL`; `LIMIT`. Result slice is `make([]MemberName, 0)` so the JSON is `[]`,
matching `ListMembers`/`ListMemberships`. The `peer`/`om` aliasing mirrors
`auth.isSoleOwnerOfAnyOrganization`'s `mine`/`peers` self-join (`auth/service.go:226`), and `om`
keeps the CP JOIN text byte-identical to CP1/CP2/CP3 so `predicate_test.go` can count it.

### `backend/internal/organizations/handler.go`

```go
type routeService interface {
    // … existing 11 methods unchanged …
    ListSecretRecipients(context.Context, string) ([]MemberName, error)
}
```

```go
// GET /me/secret-recipients lives under auth's /me/* path namespace but is
// owned here: the query, the data and the error mapping are all
// organizations-domain, and registering it in auth would force an
// organizations dependency into that package. Go 1.22's ServeMux matches
// "GET /me" as an exact literal, so this pattern does not interact with it.
mux.Handle("GET /me/secret-recipients", authMiddleware(http.HandlerFunc(func(w, r) {
    principal, ok := auth.PrincipalFromContext(r.Context())   // 401 if absent
    recipients, err := service.ListSecretRecipients(r.Context(), principal.UserID)
    // err -> writeOrganizationError (unchanged)
    httpapi.WriteJSON(w, http.StatusOK, map[string]any{"recipients": recipients})
})))
```

A reciprocal `// GET /me/secret-recipients is registered in organizations/handler.go` comment goes
beside `POST /me/deactivate` in `auth/handler.go`.

### `extension/src/shared/types.ts`

```ts
// SecretRecipient mirrors organizations.MemberName exactly. name is optional
// because the backend tags it omitempty. There is deliberately no role and no
// organization attribution (Decision F) -- do not add either.
export interface SecretRecipient {
  userId: string;
  email: string;
  name?: string;
}
```

Placed beside `OrganizationMembership`/`WorkspaceAccess` (both organizations-domain response shapes
live in `types.ts`); `SecretHistoryEntry` lives in `api.ts` because it is secrethide-local.

### `extension/src/shared/api.ts`

```ts
// getSecretRecipients follows getOrganizations' shape exactly: authenticated
// GET, envelope unwrapped at the boundary, no mutation headers.
export async function getSecretRecipients(backendUrl: string, session: SessionData): Promise<SecretRecipient[]> {
  const response = await requestJSON<{ recipients: SecretRecipient[] }>(backendUrl, "/me/secret-recipients", {
    headers: authHeaders(session),
  });
  return response.recipients;
}
```

### `extension/src/background/projection.ts` and `service-worker.ts`

```ts
// listSecretRecipients follows listSecrets' shape (require a session, call
// the API, return the raw entries) -- the directory is not persisted state.
export async function listSecretRecipients(): Promise<SecretRecipient[]>   // throws "sign in required to list recipients"
```

```ts
case "secrets/recipients":
  sendResponse(await listSecretRecipients());
  return;
```

### `extension/src/create-secret/recipient-filter.ts` (new, pure)

```ts
export const MAX_RECIPIENT_SUGGESTIONS = 8;

/** Case-insensitive substring match on email OR name. Prefix matches rank
 *  before mid-string matches; within a rank the server's email order is
 *  preserved. An empty/whitespace query returns [] -- the compact panel shows
 *  no options until the user types (see Decision 15). */
export function filterRecipients(candidates: readonly SecretRecipient[], query: string): SecretRecipient[]
```

### `extension/src/create-secret/create-secret.html` — new markup

Inserted inside `#secret-link-result`, after the `<hr class="ui-divider" />` and **before**
`<form id="send-email-form">` (Decision 12):

```html
<div id="recipient-picker" class="ui-grid--compact hidden">
  <input id="recipient-filter" type="search" placeholder="Search colleagues" autocomplete="off" />
  <ul id="recipient-options" class="ui-list ui-option-list"></ul>
</div>
<p id="recipient-picker-hint" class="ui-muted" aria-live="polite"></p>
```

The hint is a sibling *outside* `#recipient-picker` so it can still speak when the picker itself is
hidden (the error state). It is `.ui-muted`, never `.ui-error` — a directory failure must not be
mistaken for a send failure, which owns `#send-email-error`.

### Directory state machine and the three degradation states

```ts
type RecipientDirectoryState =
  | { status: "loading" }
  | { status: "ready"; candidates: SecretRecipient[] }
  | { status: "error" };
```

| State | `#recipient-picker` | `#recipient-picker-hint` | `#recipient-email` |
|---|---|---|---|
| `loading` | hidden | empty | **enabled, focusable, submittable** |
| `ready`, 0 candidates (zero orgs) | hidden | empty — a solo user sees no broken widget | **enabled** |
| `ready`, N>0, empty query | visible, `<ul>` empty | `Type to search ${N} colleagues.` | **enabled** |
| `ready`, N>0, 0 matches | visible, `<ul>` empty | `No colleague matches — type the full address.` | **enabled** |
| `ready`, N>0, M matches | visible, M ≤ 8 options | empty | **enabled** |
| `error` | hidden | `Colleague search is unavailable — type the address.` | **enabled** |

`recipientEmailInput.disabled` is never assigned anywhere in this change. Zero orgs and a fetch
failure are deliberately distinguishable: the first shows nothing at all, the second one muted line.

### Selection wiring (zero change to the submission contract)

One delegated `click` listener on `#recipient-options` (the list re-renders on every keystroke, so
per-item listeners would leak). It does exactly:

```
recipientEmailInput.value = target.dataset.email;
recipientFilterInput.value = "";
renderRecipientPicker();          // collapses the list
recipientEmailInput.focus();
```

`runSendSecretEmail` (`:181`) still reads `recipientEmailInput.value.trim()` and is not edited.
`clearRecipientPicker()` (reset filter + collapse) is called from `resetToCreateForm()` and after a
successful send, because `sendEmailForm.reset()` (`:198`) cannot reach the now-external filter input.

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/internal/organizations/service.go` | Modify | `MemberName`; `maxSecretRecipientResults`; `ListSecretRecipients` + CP14 query. `ListMembers`, `requireOrganizationAdmin`, `loadOrganizationRole` **untouched** |
| `backend/internal/organizations/handler.go` | Modify | `routeService` gains one method; `GET /me/secret-recipients`; namespace comment |
| `backend/internal/organizations/predicate_test.go` | Modify | CP JOIN count 3 → 4; name CP14 in the comment and failure message |
| `backend/internal/organizations/handler_test.go` | Modify | `organizationsRouteStub` gains `ListSecretRecipients`; route cases |
| `backend/internal/organizations/service_test.go` | Modify | New DB-backed cases + a `disableOrganizationsTestUser` helper (mirrors `softDeleteGroupsTestOrganization`) |
| `backend/internal/auth/handler.go` | Modify | One cross-reference comment beside `POST /me/deactivate`. No behaviour change |
| `backend/cmd/api/main.go` | **Unchanged** | `organizations.RegisterRoutes` already receives the shared mux and `authService.Middleware` |
| `backend/internal/secrethide/**`, `send_email.go` | **Unchanged** | Explicit non-goal |
| `extension/src/shared/types.ts` | Modify | `SecretRecipient` |
| `extension/src/shared/api.ts` | Modify | `getSecretRecipients` |
| `extension/src/background/projection.ts` | Modify | `listSecretRecipients` (missing from the proposal's Affected Areas) |
| `extension/src/background/service-worker.ts` | Modify | `case "secrets/recipients"` (missing from the proposal's Affected Areas) |
| `extension/src/create-secret/recipient-filter.ts` | Create | Pure filter/rank module |
| `extension/src/create-secret/create-secret.html` | Modify | Picker markup + hint |
| `extension/src/create-secret/create-secret.ts` | Modify | Prefetch, state machine, render, delegated selection, `clearRecipientPicker` |
| `extension/src/shared/ui/theme.css` | Modify | One new class `.ui-option-list` (max-height + overflow-y) |
| `extension/tests/secret-recipients.test.mjs` | Create | api / projection / filter coverage |

## Testing Strategy

Strict TDD, RED first. Backend DB cases use the existing `openOrganizationsTestPool` harness
(`service_test.go:1238`), which skips cleanly without `ORGANIZATIONS_TEST_DATABASE_URL`/
`DATABASE_URL`. Extension cases are `node --test` `.mjs` against `dist/`, matching
`tests/list-secrets.test.mjs`.

| Layer | What to test | Approach |
|---|---|---|
| Unit (DB-free) | **CP14 present**: the org-liveness JOIN appears exactly 4 times in `service.go`, and `ListSecretRecipients`' body contains it plus `u.disabled_at IS NULL` | Extend `predicate_test.go` with a `chokePointFunctionBody`-style body assertion (borrow the helper shape from `groups/predicate_test.go:45`) |
| Unit (DB-free) | **Minimized shape**: `MemberName` has exactly 3 fields and no `role` JSON tag; marshalling a populated value never emits `"role"` | Reflection/`json.Marshal` assertion — makes Decision 2 a test, not a comment |
| Integration | **Cross-org union + dedup**: requester in org A and org B; a peer in both appears **exactly once**; peers of A and B both appear | New case in `service_test.go` |
| Integration | **Self-inclusion (F)**: the requester's own `userId` is present in their own result | Same fixture; guards against a future "exclude self" regression |
| Integration | **Membership gate, not admin gate**: a plain `member` gets a full non-empty result — the whole point of the change | Seed requester with role `member` |
| Integration | **Cross-org isolation**: an org the requester does **not** belong to contributes zero rows even when it shares no users | Third org fixture |
| Integration | **Pending invitations excluded**: an `invitations` row with `status='pending'` for a never-accepted email yields no row; after `AcceptInvitation`, that user appears | Uses `insertOrganizationsTestInvitation` (`:1340`); proves the exclusion is structural |
| Integration | **Deactivated users excluded** (Deviation 2): set `disabled_at`, assert the peer disappears while their `organization_members` row still exists | New `disableOrganizationsTestUser` helper |
| Integration | **Soft-deleted org contributes nothing** (CP14): stamp `deleted_at` on the shared org, assert its peers vanish | Mirrors `groups/service_integration_test.go:120`'s CP11 case |
| Integration | **Zero orgs ⇒ `[]`, not null, not error**: a user with no membership gets a 200 and an empty array | Backs extension degradation state 2 |
| Integration | **`LIMIT` honoured**: seeding more than `maxSecretRecipientResults` peers returns exactly the cap | Guards Decision 10 |
| Integration | **`ListMembers` regression — unchanged**: a plain `member` still gets `ErrForbidden`; an admin still gets `role` populated and the owner→admin→member ordering | Assert on the existing method in the *same* fixture that the new path succeeds against — the single strongest proof the admin gate did not move (Success Criterion 2) |
| Integration (handler) | `GET /me/secret-recipients` with no principal ⇒ **401**; with a principal ⇒ 200 and body `{"recipients":[…]}` with `userId`/`email`/`name` and **no `role` key** in the raw JSON | `organizationsRouteStub` records the requester id; assert on raw bytes, not a decoded struct, so an accidental role field is caught |
| Integration (handler) | The stub receives **exactly** `principal.UserID` and no organization id | Locks Decision 3's "no client-supplied org id" property |
| Extension unit | `api.getSecretRecipients` issues `GET /me/secret-recipients` with the bearer header and unwraps `recipients` | Mirrors `list-secrets.test.mjs:37` verbatim in shape |
| Extension unit | `projection.listSecretRecipients` rejects with `/sign in required/` without a session; returns raw entries with one | Mirrors `list-secrets.test.mjs:56,65` |
| Extension unit | `filterRecipients`: empty/whitespace query ⇒ `[]`; email substring; name substring; case-insensitive; prefix ranks before mid-string; result capped at `MAX_RECIPIENT_SUGGESTIONS`; no match ⇒ `[]`; empty candidate list ⇒ `[]` | Table-driven, pure — this is where the three degradation *inputs* are covered |
| Extension — **not covered** | The picker's DOM rendering, the delegated click that fills `#recipient-email`, and the visual rendering of the three states | Declared gap, not an omission: `create-secret.ts:6-10` states DOM wiring here is deliberately untested and `extension/tests/` has no DOM harness. Adding jsdom/vitest for this feature is a larger, separate decision. **Manual verification checklist required in tasks.md** — see Open Questions |

## Threat Matrix

Applicable rows only; the change adds one HTTP route and no shell, subprocess, VCS/PR automation, or
executable-file classification.

| Boundary | Applicable | Expected safe behaviour | RED test |
|---|---|---|---|
| **Routing — new authenticated route** | Yes | `authMiddleware` + the handler's own `PrincipalFromContext` check ⇒ 401 with no body leakage when unauthenticated | Handler 401 case |
| **Routing — pattern collision** | Yes | `GET /me/secret-recipients` does not shadow or get shadowed by `GET /me` (exact literal) or `GET /me/preferences` | Register all routes on one mux in the handler test and assert each still resolves |
| **Authorization / IDOR** | Yes | No path, query, or body parameter exists to name an organization or a user; the only input is the server-derived `principal.UserID` | Cross-org isolation case + the stub-argument case |
| **Data exposure** | Yes | `role` is unreachable through this path by type; deactivated and never-accepted users are not delivery targets | Raw-JSON no-`role` assertion; deactivated/pending cases |
| **SQL injection** | Yes | Both inputs are bound parameters (`$1` = user id, `$2` = a compile-time const). No string concatenation anywhere in the query | Covered by construction; the predicate test pins the literal query text |
| **Denial of service** | Yes | `LIMIT $2` bounds the row count regardless of org count | `LIMIT` honoured case |
| Shell / subprocess / VCS-PR / executable classification / process integration | **N/A** | No such boundary is crossed | — |

## Migration / Rollout

**No migration required.** No new table, column, or index. The subquery drives on
`organization_members`' existing `(organization_id, user_id)` primary key and the `users` PK join.

Deploy order is unconstrained and each layer degrades safely:

- Newer backend + older extension: the route exists and is never called.
- Newer extension + older backend: `GET /me/secret-recipients` 404s, `requestRaw` throws `ApiError`,
  `loadRecipients` catches it, the state becomes `error`, and sending by free text still works —
  degradation state 3 is also the forward/backward-compatibility story.

Rollback is a branch revert: the route, method, type, message case and picker all disappear, leaving
blind free-text entry exactly as today. No data was written, so nothing is orphaned.

All work stays on `feat/secret-recipient-directory` (already cut from `develop`). No merges, no new
branches.

## Risks / Deviations Requiring Re-confirmation

1. **Deviation 1 — `organizations.ListMemberNames` is not implemented.** Decision A names it
   explicitly; this design ships `MemberName` + `ListSecretRecipients` instead, because Decision B's
   single-SQL union gives the per-org method zero callers, and a routed non-admin per-org listing
   with no consumer is the very risk row Decision A exists to close. All of A's *safety* properties
   hold. **Confirm.**
2. **Deviation 2 — deactivated users are excluded.** The proposal is silent on `users.disabled_at`;
   this design filters them, extending Decision F's "not a reliable delivery target" principle. It
   makes the new path *narrower* than `ListMembers`, never wider. **Confirm.**
3. **`predicate_test.go` breaks on the GREEN commit** if CP14 is added without updating the count
   from 3 to 4 in the same slice. Sequence it explicitly in tasks.md.
4. **`/me/*` is now served by two packages.** A reader grepping `auth/handler.go` for `/me` routes
   will not find this one. Mitigated by reciprocal comments; the alternative (auth depending on
   organizations) is worse. Likely to be raised at review — a deliberate, bounded tradeoff.
5. **Picker DOM behaviour has no automated coverage** and depends on a manual checklist. This is the
   repo's existing boundary for `create-secret.ts`, not a new one, but this change adds materially
   more DOM logic than the file previously carried.
6. **New UI pattern with no keyboard navigation** (Decision 16). Mouse and free-text users are fully
   served; keyboard-only users fall back to typing the address, which always works.
7. **Roster visibility is a product decision already confirmed (Decision E).** No further
   verification designed here; recorded so review does not relitigate it silently.

## Open Questions

- [ ] Decision 15: no options render until the first keystroke. Should the picker instead show the
      first 8 colleagues on focus? It is more discoverable and one line of code, but it consumes the
      compact panel.
- [ ] Decision 16: ship without arrow-key navigation, or add it (roughly +25 lines, and it needs
      `aria-activedescendant` plus a real `listbox` role to be honest)?
- [ ] Manual verification checklist for the six rendering rows in the degradation table — confirm
      that a checklist in `tasks.md` is acceptable, or whether a jsdom/vitest harness for
      `extension/` should be added as separate scope.
- [ ] Copy review on the three hint strings; they are the only new user-facing text.
- [ ] `maxSecretRecipientResults = 500` is a judgement call with no measured basis. Confirm the
      number, or agree the trigger to revisit it.
