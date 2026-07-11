# Admin Access Runtime Contracts Specification

## Purpose

Define fail-closed database evidence and visible access/authentication behavior.

## Requirements

### Requirement: Fail-Closed PostgreSQL Contract Evidence

The PostgreSQL contract command MUST fail when required database configuration is absent or the database is unreachable. It MUST prove contract tests executed and MUST NOT report success when tests were skipped.

#### Scenario: Missing database configuration

- GIVEN required PostgreSQL configuration is absent
- WHEN the contract command runs
- THEN it fails with evidence that no contract pass was claimed

#### Scenario: Unreachable database

- GIVEN required configuration points to an unreachable database
- WHEN the contract command runs
- THEN it fails closed rather than skipping tests

#### Scenario: Executed contract suite

- GIVEN a reachable configured PostgreSQL environment
- WHEN the contract command completes
- THEN its result proves contract tests executed and none were skipped

### Requirement: Visible Group Grant State

The user interface MUST refresh visible access state after successful group-grant creation so the new grant is shown without requiring unrelated navigation.

#### Scenario: Create a group grant

- GIVEN an authorized user can create a group grant
- WHEN creation succeeds
- THEN the visible access state includes the new grant

### Requirement: Protected Route Authentication Recovery

The user interface MUST redirect a protected-route visit to login when authentication restoration fails.

#### Scenario: Failed session restoration

- GIVEN a user opens a protected route with restorable authentication expected
- WHEN restoration fails
- THEN the user is redirected to login and protected content is not shown
