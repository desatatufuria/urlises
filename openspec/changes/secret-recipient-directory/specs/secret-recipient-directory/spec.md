# Secret Recipient Directory Specification

## Purpose

Let a sender pick a known coworker from a directory when sharing a SecretHide one-time secret,
instead of typing an address blind, while exposing nothing more than name/email of coworkers in
orgs the sender already belongs to, and never widening the existing admin-only member listing.

## Requirements

### Requirement: Minimized Member-Listing Capability

The system MUST provide `organizations.ListMemberNames`, gated by organization **membership**
(any accepted role), not by the `requireOrganizationAdmin` check. It MUST return only `userId`,
`email`, and `name` per member, and MUST NOT return `role` or any other field.

#### Scenario: Plain member lists their own org's members

- GIVEN an authenticated user with a plain `member` role in organization O
- WHEN they call `ListMemberNames` for O
- THEN they receive O's accepted members, each with only `userId`, `email`, and `name`
- AND no `role` field is present in the response

#### Scenario: Non-member of the target org is rejected

- GIVEN an authenticated user who does not belong to organization O
- WHEN they call `ListMemberNames` for O
- THEN the request is rejected and no member data for O is returned

#### Scenario: ListMembers and its admin gate are unaffected

- GIVEN the existing `organizations.ListMembers` capability and its `requireOrganizationAdmin`
  gate, including `role` exposure
- WHEN `ListMemberNames` is added
- THEN `ListMembers`' behavior, its admin-only gate, and its `role` field remain byte-for-byte
  unchanged for every caller

### Requirement: Cross-Org Union Recipient Endpoint

The system MUST expose `GET /me/secret-recipients`, resolving organization membership solely
from the authenticated principal (`principal.UserID`) and never from a client-supplied
organization ID. It MUST union and dedupe members (by `userId`) across every organization the
requester belongs to, using the minimized shape from `ListMemberNames`.

#### Scenario: Requester in multiple orgs gets the full deduped union

- GIVEN a requester who belongs to N organizations
- WHEN they call `GET /me/secret-recipients`
- THEN the response contains the deduped union of accepted members across all N organizations

#### Scenario: Coworker shared via two orgs appears exactly once

- GIVEN a coworker who shares two organizations with the requester
- WHEN the requester calls `GET /me/secret-recipients`
- THEN that coworker appears exactly once in the result, with no field indicating which shared
  organization(s) they came from

#### Scenario: Requester with zero organizations gets an empty result

- GIVEN a requester who belongs to no organization
- WHEN they call `GET /me/secret-recipients`
- THEN the response is an empty list, not an error

#### Scenario: Unauthenticated request is rejected

- GIVEN a request with no valid authenticated principal
- WHEN `GET /me/secret-recipients` is called
- THEN the request is rejected before any organization membership is resolved

### Requirement: Roster Contents

The roster returned by `ListMemberNames` and `GET /me/secret-recipients` MUST include the
requester's own account among their organizations' results, and MUST include only members whose
invitation has been accepted; pending invitations MUST be excluded.

#### Scenario: Requester appears in their own directory result

- GIVEN a requester who is an accepted member of organization O
- WHEN they call `GET /me/secret-recipients`
- THEN their own `userId`/`email`/`name` is present in the result

#### Scenario: Pending invitation is excluded from the roster

- GIVEN a person with a pending, not-yet-accepted invitation to organization O
- WHEN a member of O calls `ListMemberNames` or `GET /me/secret-recipients`
- THEN that pending invitee does not appear in the result

### Requirement: Extension Recipient Picker

The create-secret window MUST offer a filter-as-you-type recipient picker backed by
`GET /me/secret-recipients`, additive to the existing free-text `recipientEmail` input. Selecting
a candidate MUST populate that same input; the send-email submission MUST remain unchanged,
still sending only `recipientEmail` and `fragment` to the existing endpoint. The free-text input
MUST stay usable regardless of the picker's fetch state.

#### Scenario: Typing filters visible candidates

- GIVEN the picker has loaded directory results
- WHEN the sender types into the filter input
- THEN only candidates whose name or email substring-matches the typed text remain visible

#### Scenario: Selecting a candidate fills the existing field without changing submission

- GIVEN a filtered list of candidates is visible
- WHEN the sender selects one
- THEN the existing `recipientEmail` input is populated with that candidate's email
- AND sending still submits only `recipientEmail` and `fragment` to the unchanged send-email
  endpoint

#### Scenario: Free text stays usable while the directory is loading

- GIVEN the directory fetch for `GET /me/secret-recipients` is still in flight
- WHEN the sender types an address directly into `recipientEmail`
- THEN sending proceeds normally without waiting for the picker

#### Scenario: Free text stays usable when the directory fetch fails

- GIVEN the directory fetch for `GET /me/secret-recipients` has failed
- WHEN the sender types an address directly into `recipientEmail`
- THEN sending proceeds normally and no picker error blocks the free-text path

#### Scenario: Free text stays usable when the directory is empty

- GIVEN `GET /me/secret-recipients` returned zero results
- WHEN the sender types an address directly into `recipientEmail`
- THEN sending proceeds normally with no candidates shown

### Requirement: Existing Contracts Are Unaffected

This change MUST NOT alter `ListMembers`' behavior or its admin gate, and MUST NOT alter
`send_email.go`'s validation or the `secrets/{token}/send-email` submission contract, which MUST
continue accepting any `mail.ParseAddress`-parseable address regardless of organization
membership. Admin-managed cross-org visibility grants are explicitly out of scope for this
change and MAY be considered as a future extension.

#### Scenario: send-email accepts a non-directory address

- GIVEN an address that does not appear in the sender's `GET /me/secret-recipients` result
- WHEN the sender types it manually and submits the send-email form
- THEN the send-email endpoint accepts it exactly as it did before this change, with no
  membership check applied

#### Scenario: No cross-org visibility grant is introduced

- GIVEN this change ships
- WHEN a sender attempts to see recipients from an organization they do not belong to
- THEN no mechanism exists to grant that visibility; admin-managed cross-org grants remain
  unimplemented and out of scope
