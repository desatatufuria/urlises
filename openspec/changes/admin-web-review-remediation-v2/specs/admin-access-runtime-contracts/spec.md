# Delta for Admin Access Runtime Contracts

## MODIFIED Requirements

### Requirement: Fail-Closed PostgreSQL Contract Evidence

The PostgreSQL contract command MUST fail when required database configuration is absent or the database is unreachable. It MUST prove non-skipped, named contract execution for `organizations`, `groups`, `workspaces`, and `httpapi` against production migrations. It MUST provide a return-coverage mapping for all required packages and MUST NOT report success when any required package is skipped, unnamed, or absent.
(Previously: The command required reachable configuration and proof that tests executed without skips.)

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

#### Scenario: Map required production-migration packages

- GIVEN the contract command runs against production migrations
- WHEN it reports successful execution
- THEN named non-skipped evidence and return coverage map `organizations`, `groups`, `workspaces`, and `httpapi`

### Requirement: Visible Group Grant State

The user interface MUST refetch visible access state after successful group-grant creation so the new grant is shown without requiring unrelated navigation.
(Previously: Successful group-grant creation required a visible state refresh.)

#### Scenario: Create a group grant

- GIVEN an authorized user can create a group grant
- WHEN creation succeeds
- THEN the refetched visible access state includes the new grant
