# Verify Report: Invitation Email Delivery — PR 2 (Frontend / admin-web)

**Scope**: `admin-web/` only — Phases 5, 6, 7.2, 8.2 of `tasks.md`. Backend (PR 1) was independently verified in `verify-report-backend.md` (PASS) and is out of scope here; confirmed no `backend/` files are touched by this branch's diff against `feat/invitation-email-delivery-backend`.

**Mode**: Full spec-driven verification (proposal, spec, design, tasks all present). Strict TDD evidence present in `apply-progress.md`, consistent with observed test structure.

## Completeness — Task Checklist

| Task | Status | Evidence |
|---|---|---|
| 5.1 `AcceptedInvitation` type | Done | `admin-web/src/lib/api/types.ts:47-51` |
| 5.2 `acceptInvitation` client | Done | `admin-web/src/lib/api/invitations.ts` |
| 6.1/6.2 public route registration | Done | `admin-web/src/app/router.tsx:73-75` (top-level, outside `RequireSession`); `router.test.tsx:38` |
| 6.3/6.4 RED tests (redirects, open-redirect) | Done | `InvitationAcceptPage.test.tsx` |
| 6.5 `InvitationAcceptPage` | Done | `admin-web/src/app/views/InvitationAcceptPage.tsx` |
| 6.6 `LoginPage` pass-through | Done | `admin-web/src/app/views/LoginPage.tsx` |
| 6.7 critical `RegisterPage` guard fix | Done | `RegisterPage.tsx:27-29` |
| 6.8 `RegisterPage` prefill/lock/returnTo | Done | `RegisterPage.tsx` |
| 7.2 full frontend suite green | Done (re-run by verifier) | see below |
| 8.2 chain-strategy record | Done | `tasks.md`, `apply-progress.md` |
| 7.3 manual Mailpit end-to-end | **Not done — documented, known gap** | see "Known Gap" below |

All tasks assigned to PR 2 except 7.3 are checked and match code state. No discrepancy between `tasks.md` claims and the actual diff.

## Runtime Evidence (executed by this verifier, not re-reading prior claims)

```
cd admin-web && npm test -- --run
```
Result: `Test Files 9 passed (9)`, `Tests 49 passed (49)`, 0 failures. Includes `InvitationAcceptPage.test.tsx` (11/11) and `router.test.tsx` (12/12, including the new `/invitations/:token` catch-all case).

```
cd admin-web && npx tsc --noEmit
```
Result: exit 0, no output — no type errors.

## Spec Compliance Matrix (`specs/admin-web-invitation-acceptance/spec.md`)

| Requirement / Scenario | Compliant | Covering test |
|---|---|---|
| Public route loads without auth guard redirect | Yes | `router.test.tsx` "resolves /invitations/:token as its own public route instead of the catch-all"; route sits at `router.tsx:73-75`, sibling to `/login`, outside `RequireSession` |
| Anonymous visitor carried to `/login` with `invitation`+`email` preserved | Yes | `InvitationAcceptPage.test.tsx` "redirects an anonymous visitor…" |
| `setupRequired` visitor carried to `/register` with params preserved | Yes | same file, "redirects a visitor needing first-owner setup…" |
| Params survive `/login` ↔ `/register` mutual links | Yes | `LoginPage.tsx:78` and `RegisterPage.tsx:85` both use `{ pathname, search: searchParams.toString() }`; exercised end-to-end by the "critical invitee path" test |
| Register email prefill+lock when both params present | Yes | `RegisterPage.tsx:72-73` — actual `<input readOnly={emailLocked} aria-readonly={emailLocked || undefined}>`, not just local state; test asserts `toHaveAttribute("readonly")` on the real DOM node |
| Register email remains editable with no invitation | Yes | `emailLocked = Boolean(invitation && invitedEmail)` is false with no `invitation` param; no dedicated regression test found for this exact negative case, but the logic is a direct boolean AND — low risk (SUGGESTION below) |
| Post-auth `POST /invitations/{token}/accept`, success lands in app | Yes | `InvitationAcceptPage.tsx:66-80` effect; "accepts the invitation…admin role" test |
| Email-mismatch shows inline error, not silent redirect | Yes | `mapAcceptError` + "shows an inline error and a sign-out action on an email mismatch" test |

All 8 spec scenarios have a passing covering test. No CRITICAL `UNTESTED`/`FAILING` findings.

## Critical Points Called Out by the Orchestrator — Verified Directly

1. **RegisterPage guard** (`RegisterPage.tsx:27-29`): `if (status === "anonymous" && !invitation) return <Navigate to="/login" replace/>;` — confirmed exact condition in current code. An anonymous visitor with `invitation` set falls through to the registration form. Matches design and the critical-fix intent of task 6.7.

2. **Email prefill+lock enforced on the rendered input, not just state** (`RegisterPage.tsx:68-76`): the `<input>` itself carries `readOnly={emailLocked}` and `aria-readonly`; `emailLocked = Boolean(invitation && invitedEmail)`. Confirmed via direct source read (not trusting apply-progress prose) and via the "critical invitee path" test asserting `emailInput.toHaveAttribute("readonly")` on the actual queried DOM node.

3. **No open-redirect surface**: traced every `returnTo`/navigation-target construction site.
   - `LoginPage.tsx:14-16` and `RegisterPage.tsx:14-16`: `returnTo` is always `` `/invitations/${encodeURIComponent(invitation)}...` `` or a fixed fallback (`"/"` / `"/setup/organization"`) — never derived from an arbitrary query value used as a full URL.
   - `InvitationAcceptPage.tsx:87,91` and `invitationRedirectQuery` (`:18-24`): builds `/login?...`/`/register?...` with `token` and `email` placed only inside `URLSearchParams`, never as the path itself.
   - Confirmed a test exists (`InvitationAcceptPage.test.tsx` "never turns a crafted invitation token into a redirect off the fixed local path") AND independently re-derived from the source that the token can only ever land inside a query-string value or `encodeURIComponent`-escaped path segment under a fixed `/invitations/` or `/login`/`/register` prefix — there is no code path where a query param is interpolated as a redirect target directly. No open-redirect surface found.

4. **Query-param preservation across `/login` ↔ `/register`**: both `LoginPage.tsx:78` and `RegisterPage.tsx:85` render `<Link to={{ pathname: ..., search: searchParams.toString() }}>`, so both `invitation` and `email` survive a bounce in either direction. Exercised by the "critical invitee path" test which actually clicks the register link and asserts the invitation flow completes.

5. **Single-flight accept under StrictMode**: `InvitationAcceptPage.tsx:64,66-70` — `attempted` is a `useRef(false)`; the effect checks `attempted.current` before doing anything and sets it synchronously before the async call starts, which is safe under StrictMode's dev-mode double-invoke (same fiber, ref persists across the simulated unmount/remount). Verified by a dedicated `<StrictMode>`-wrapped render helper (`renderStrictAppRoute`) and an assertion that exactly one `POST /invitations/{token}/accept` fetch call occurred. Test passed under the actual `npm test` run in this verification, not just claimed.

## Design Coherence

- Module ownership: `invitations.ts` kept separate from `organizations.ts` as decided — confirmed.
- `readOnly` (not `disabled`) chosen for the locked email field, with `aria-readonly` — matches the design's stated interface-decision table.
- Two documented deviations from the design in `apply-progress.md` (fetch-level mocking instead of `vi.mock`; `LoginPage`'s register-link visibility condition widened to `status === "setupRequired" || invitation`) are both reviewed and judged correct/necessary completions of the design's stated intent, not scope creep — they don't contradict any spec scenario and are covered by passing tests.
- No backend files touched; diff isolated to `admin-web/` plus SDD planning docs, matching PR 2's stated rollback boundary.

## Issues

**CRITICAL**: None.

**WARNING**: None.

**SUGGESTION**:
- No dedicated unit/integration assertion isolates "email field remains editable when there is no `invitation` param" (spec scenario "Email field remains editable without an invitation") as its own test case; existing tests exercise the locked path directly but the unlocked path is only implied by the `emailLocked` boolean logic and the pre-existing (pre-change) register flow. Low risk since the logic is a trivial `Boolean(invitation && invitedEmail)` AND, but a one-line assertion would close the gap for full scenario-level test traceability.
- `package-lock.json` at the repo root is untracked and unrelated to this change's `File Changes` list in the design; it predates this verification session (already present in the initial git status) and is not something this PR introduced, but it is worth the user cleaning it up or adding to `.gitignore` before opening the PR so it doesn't get swept into a `git add -A` accidentally.

## Known Gap (pre-existing, not a new finding)

Task 7.3 — manual end-to-end check against a live `docker compose` stack with Mailpit (`127.0.0.1:8025`): create an invitation, open the received email, follow the link with no existing account, register, and land as a member. **Not executable by either the apply agent or this verify agent** — no Docker daemon / running compose stack is available in this sandbox. This is already documented in `tasks.md` (left unchecked with an explicit note) and `apply-progress.md`. A human must run this manually against a live stack before the change is considered fully end-to-end verified; it is not a code defect and does not block PR 2 from being opened for review, but it should be run before the tracker branch is merged to `develop`.

## Verdict

**PASS WITH WARNINGS** (0 CRITICAL, 0 WARNING, 2 SUGGESTION).

The frontend slice is functionally complete, spec-compliant, and matches its own apply-progress claims under direct source and runtime re-verification (not just re-reading prior claims). All 49 frontend tests pass, `tsc --noEmit` is clean, and every critical point flagged by the orchestrator (RegisterPage guard, email lock enforcement, open-redirect surface, param preservation, single-flight accept) was independently traced in the actual code and found correct.

**Ready to be committed and opened as PR 2** (`feat/invitation-email-delivery-frontend` → `feat/invitation-email-delivery-backend`), contingent only on: (a) the pre-existing, already-documented Phase 7.3 manual Mailpit check being run by a human against a live stack before the tracker branch merges to `develop`, and (b) optionally addressing the two low-severity suggestions above.
