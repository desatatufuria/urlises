# Admin-Web Invitation Acceptance Specification

## Purpose

Provide a public entry point in admin-web for following an invitation link, carrying the invitation through authentication, and completing acceptance.

## Requirements

### Requirement: Public Invitation Route

The system MUST expose a public route at `/invitations/:token` that does not require an existing session to load.

#### Scenario: Route loads without authentication

- GIVEN a visitor with no active session opens `/invitations/abc123?email=invitee%40example.com`
- WHEN the route renders
- THEN the page MUST load without being redirected by the authenticated-route guard for lacking a session

### Requirement: Unauthenticated Pass-Through

When the visitor's auth status is `anonymous` or `setupRequired`, the system MUST redirect to `/login` or `/register` respectively, preserving the invitation token and invitee email as query parameters. `LoginPage` and `RegisterPage` MUST preserve both parameters across their mutual navigation links.

#### Scenario: Anonymous visitor is carried to login with params preserved

- GIVEN an anonymous visitor opens `/invitations/abc123?email=invitee%40example.com`
- WHEN `useAuth().status` resolves to `anonymous`
- THEN the system MUST navigate to `/login` with `invitation=abc123` and `email=invitee%40example.com` present in the query string

#### Scenario: Params survive navigating between login and register

- GIVEN a visitor is on `/login?invitation=abc123&email=invitee%40example.com`
- WHEN the visitor follows the "create an account" link to `/register`
- THEN `invitation=abc123` and `email=invitee%40example.com` MUST remain present in the resulting URL

### Requirement: Register Email Prefill And Lock

When `RegisterPage` receives both an invitation token and an email query parameter, it MUST prefill the email field with that value and MUST prevent the user from editing it.

#### Scenario: Email field is prefilled and locked

- GIVEN `RegisterPage` loads with `invitation=abc123&email=invitee%40example.com`
- WHEN the form renders
- THEN the email field MUST display `invitee@example.com`
- AND the email field MUST be disabled or read-only for user input

#### Scenario: Email field remains editable without an invitation

- GIVEN `RegisterPage` loads with no `invitation` query parameter
- WHEN the form renders
- THEN the email field MUST remain editable

### Requirement: Post-Authentication Acceptance

After the visitor reaches an authenticated state on `/invitations/:token`, the system MUST call `POST /invitations/{token}/accept` and, on success, land the user in the authenticated application.

#### Scenario: Authenticated visitor accepts and lands in the app

- GIVEN a visitor authenticates while on `/invitations/abc123?email=invitee%40example.com`
- WHEN `useAuth().status` becomes `authenticated`
- THEN the system MUST call `POST /invitations/abc123/accept`
- AND on a successful response the visitor MUST be navigated into the authenticated application

#### Scenario: Token/email mismatch shows an inline error

- GIVEN an authenticated user's own email does not match the invitation's invited email
- WHEN `POST /invitations/{token}/accept` returns the email-mismatch error
- THEN the page MUST display a clear inline error explaining the mismatch
- AND the user MUST NOT be silently redirected away without an explanation
