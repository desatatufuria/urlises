# Admin Organization Creation Specification

## Purpose

Enable eligible Admin Web operators to create an additional organization and enter it immediately, without changing first-run setup or backend authorization.

## Requirements

### Requirement: Eligible Creation Discoverability

The Admin Web MUST show an organization-creation shell entry point only after the authenticated user has a resolved `owner` or `admin` membership. The entry point MUST reach the dedicated creation page.

#### Scenario: Eligible operator opens creation

- GIVEN an authenticated user with a resolved owner or admin membership
- WHEN the user selects the shell creation entry point
- THEN the dedicated organization-creation page is displayed

#### Scenario: Ineligible operator lacks entry point

- GIVEN an authenticated Admin Web user without an owner or admin membership
- WHEN the shell is displayed
- THEN no organization-creation entry point is displayed

### Requirement: Protected Creation Route

The dedicated creation page MUST deny direct routed access to Admin Web users who are not eligible operators.

#### Scenario: Ineligible direct-route attempt

- GIVEN an authenticated user without an owner or admin membership
- WHEN the user navigates directly to the creation route
- THEN the creation page is not rendered

#### Scenario: Eligible direct-route access

- GIVEN an authenticated user with a resolved owner or admin membership
- WHEN the user navigates directly to the creation route
- THEN the creation form is available

### Requirement: Authenticated Creation and Active Switch

The form MUST submit the existing authenticated `POST /organizations` contract. On success, the Admin Web MUST persist exactly the membership returned by that contract, select its organization as active, and navigate to that organization's overview before organization-scoped work resumes.

#### Scenario: Successful additional organization creation

- GIVEN an eligible operator submits valid organization data
- WHEN `POST /organizations` succeeds with a membership
- THEN that returned membership is persisted and its organization is active
- AND the operator is navigated to that organization's overview

#### Scenario: Returned owner membership is retained exactly

- GIVEN the creation response contains the creator's owner membership
- WHEN the success state is persisted
- THEN the stored membership matches the returned membership without substitution

### Requirement: Definite Failure Recovery

The Admin Web MUST show definite API errors and permit corrected resubmission with a fresh idempotency key.

#### Scenario: Definite validation failure

- GIVEN an eligible operator submits invalid organization data
- WHEN the API returns a definite error
- THEN the error is displayed and corrected resubmission is available
- AND the corrected submission uses a fresh idempotency key

### Requirement: Uncertain Creation Retry

The Admin Web MUST retain the same idempotency key for a same-intent retry after an uncertain transport failure, and MUST NOT treat that failure as a definite API error.

#### Scenario: Retry after uncertain transport failure

- GIVEN a creation submission has an idempotency key
- WHEN transport completion is uncertain
- THEN the failure state permits retrying the same intent with that key

### Requirement: Setup and Authorization Boundaries

First-run setup MUST remain the only creation path for users with no organizations and MUST remain otherwise unchanged. This UI specification MUST NOT redefine existing backend authorization for `POST /organizations`. `OdA` branding is out of scope.

#### Scenario: First-run user remains in setup

- GIVEN an authenticated user has no organizations
- WHEN the user enters the Admin Web
- THEN existing first-run setup behavior remains unchanged

#### Scenario: Backend authorization boundary

- GIVEN a request reaches `POST /organizations`
- WHEN this Admin Web feature is present
- THEN backend authorization behavior remains unchanged
