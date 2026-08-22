# Proposal: Secret Recipient Directory

## Intent

Sending a SecretHide one-time secret today means typing a colleague's address blind into a free-text field. No directory, no autocomplete, no confirmation the address is a real, reachable person. For banking/fintech users a mistyped address means a credential link delivered to a stranger, plus a support incident and a re-share cycle. Senders should pick a known colleague from a list; typos and misdeliveries drop; nothing new becomes visible that coworkers could not already infer about each other.

## Scope

### In Scope
- New non-admin, minimized member-listing capability in `organizations` (Decision A).
- One union endpoint resolving recipients across **all** orgs the caller belongs to, deduped by user (Decision B).
- Filter-as-you-type recipient picker in the create-secret window that pre-fills the existing `recipientEmail` input (Decisions C, D).
- Loading / empty / error states for the picker.

### Out of Scope (non-goals)
- Admin-managed cross-org visibility grants — unresolved "who may grant this" question; possible future extension, not designed around here.
- Any change to `ListMembers`, its `requireOrganizationAdmin` gate, or its `role` exposure.
- Any change to `send_email.go` validation or the `secrets/{token}/send-email` contract; the picker only pre-fills a field.
- Recipient search across orgs the sender does not belong to; workspace-level scoping inside an org.

## Capabilities

### New Capabilities
- `organization-member-directory`: non-admin, membership-gated, minimized (`userId`/`email`/`name`) cross-org recipient listing derived from the authenticated principal.
- `secret-recipient-picker`: extension-side picker that augments, never replaces, manual recipient entry.

### Modified Capabilities
- None.

## Approach — decisions resolved

**A. New minimized capability, not a relaxed `ListMembers`.** Add `organizations.ListMemberNames`, gated by org **membership** (same shape `groups` uses for its membership check), returning `userId`, `email`, `name` — deliberately **not** `role`. Safe because coworker identity inside a shared org is a normal company-directory expectation, not a secret; and because `ListMembers`' admin gate and `role` exposure are untouched, so no caller of any role gains admin-only fields through the new path. The narrow return type is the guard against this drifting into a `ListMembers` bypass.

**B. One server-side union endpoint** (`GET /me/secret-recipients`) resolving from `principal.UserID`, joining and deduping in SQL, reusing A's minimized shape internally. Chosen over N client calls: the client never supplies org IDs, so cross-org leakage is structurally impossible rather than merely enforced; and one round trip keeps a compact, time-sensitive modal responsive regardless of org count. The exploration's "no precedent for this endpoint shape" objection is real but not decisive — precedent is not a security property, and the N-call precedent (`refreshWorkspaceCatalog`) is sequential and was never built for a blocking modal.

**C. Lightweight filter-as-you-type list** (plain `<input>` + filtered list, no library) over `<datalist>`: `<datalist>` cannot render name+email together reliably and cannot express loading/error states, which this flow needs and already has a pattern for (`send-email-error`). Must fit the compact-window constraint; exact layout/copy is design's job.

**D. Graceful degradation.** Zero orgs, zero results, or a failed directory fetch never blocks sending: the free-text `recipientEmail` input stays visible and functional, and the picker is purely additive. Confirmed against `send_email.go`, which requires only a `mail.ParseAddress`-parseable address — sending to someone outside the product is a legitimate SecretHide use case and must survive this change.

**E. Roster visibility — confirmed with the user, not assumed.** Decision A's entire safety argument rests on "seeing your own org's coworkers is a normal directory expectation, not sensitive data" — given this product's banking/fintech clientele, that assumption was checked explicitly rather than taken for granted. Confirmed: a plain member seeing name/email (no role) of their own organization's coworkers is acceptable, the same way a company-wide directory in Slack/Teams is. No per-org opt-out or additional restriction is required for this change.

**F. Smaller UX defaults**, resolved with reasonable defaults rather than left open:
- The sender's own account is included in their own directory result (self-send is a plausible "move a credential to my other device" case).
- Only accepted members appear — a still-pending invitation is not a reliable delivery target and is excluded.
- When the same person is a coworker via more than one shared organization, they appear once (deduped), with no indication of which shared org(s) they came from — attribution is not needed to pick a recipient.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `backend/internal/organizations/service.go` | Modified | New `ListMemberNames` + membership gate; `ListMembers` untouched |
| `backend/internal/organizations/handler.go` | Modified | New union route resolving from principal |
| `extension/src/create-secret/create-secret.ts` / `.html` | Modified | Picker state, fetch, render; markup in compact panel |
| `extension/src/shared/api.ts` / `types.ts` | Modified | New fetch fn + response type |
| `backend/internal/secrethide/*` | Unchanged | Explicit non-goal |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| New capability widens into a `ListMembers` bypass | Med | Distinct method + narrow struct without `role`; admin gate untouched |
| Cross-org leakage | Low | Membership derived server-side from `principal.UserID`; no client-supplied org IDs |
| Directory grows large (many orgs) | Med | Server-side dedup; pagination/limit decided in design |
| New UI pattern (a11y, keyboard nav) | Med | Keep minimal; free-text fallback always available |

## Rollback Plan

Revert the feature commits. The picker is additive and the backend addition is a new method/route, so removing them restores blind free-text entry with no data migration, no schema change, and no altered send-email contract.

## Dependencies

- Existing org-membership check helper in `organizations` (or the `groups` equivalent) — design confirms which.
- Gitflow: work continues on `feat/secret-recipient-directory` off `develop`; no merge or new branch in this change.
- Documentation impact: this proposal plus spec/design artifacts under `openspec/changes/secret-recipient-directory/`.

## Success Criteria

- [ ] A plain `member` can list recipients across all their orgs without any admin role.
- [ ] `role` is not returned by the new path; `ListMembers`' admin gate is byte-for-byte unchanged.
- [ ] Orgs the sender does not belong to never appear; results deduped by `userId`.
- [ ] One round trip fills the picker.
- [ ] Sending still works with zero orgs, zero results, or a failed directory fetch.
