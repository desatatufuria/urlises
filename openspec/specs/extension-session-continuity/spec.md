# Extension Session Continuity Specification

## Purpose

Maintain a renewable, device-scoped extension session without exposing secrets or losing sync state.

## Requirements

### Requirement: Renewable Device Sessions

The system MUST issue a short-lived access token and a rotating, device-bound refresh-token family. The server MUST retain only a secure refresh-secret hash and non-secret family metadata, and MUST NOT persist or log plaintext refresh tokens. A remembered session MUST remain renewable until sign-out, revocation, reuse detection, password change, or account recovery; routine user-facing inactivity MUST NOT end it.

#### Scenario: Rotate a valid device refresh token
- GIVEN a valid refresh token for a device family
- WHEN the device renews its access token
- THEN the server issues a new access/refresh pair and invalidates the presented refresh token

#### Scenario: Detect old-token reuse
- GIVEN a rotated refresh token is presented again
- WHEN reuse is detected
- THEN the system revokes the affected family/device and returns an unauthenticated result without secrets

### Requirement: Bounded REST Renewal

The extension MUST coordinate concurrent renewal as one single-flight operation. Each REST request that receives an authentication failure MAY renew once and MUST replay its original request exactly once with its original mutation identity; it MUST NOT retry indefinitely or create a new mutation identity.

#### Scenario: Five requests encounter expiry
- GIVEN five concurrent API calls share an expired access token and a valid refresh token
- WHEN they receive authentication failure
- THEN exactly one refresh occurs and each original request is replayed at most once

#### Scenario: Replay remains unauthorized
- GIVEN a request has already been replayed after renewal
- WHEN its replay receives authentication failure
- THEN it fails without another refresh or replay

### Requirement: Safe Socket and Restart Recovery

The extension MUST authenticate WebSocket connection or renewal without placing access or refresh credentials in URLs or logs. After renewal or reconnect, replay MUST resume from the durable cursor. On browser or service-worker restart, a valid private refresh credential MUST restore the session safely without concurrent refresh races or secret leakage.

#### Scenario: Socket expires during replay
- GIVEN a socket expires while a workspace has a durable cursor
- WHEN renewal succeeds
- THEN the socket reconnects with renewed authentication and resumes from that cursor

#### Scenario: Worker restarts during renewal
- GIVEN the worker stops while renewal is in progress
- WHEN it restarts with a valid persisted refresh credential
- THEN at most one effective renewal is completed and no credential appears in diagnostics

### Requirement: Revocation and Authentication Pause

Current-device sign-out MUST revoke only its device family. Password change or recovery MUST revoke every device family. An invalid or revoked refresh token MUST pause all sync work, preserve selected workspaces, mappings, projections, and checkpoints, display login-required state, and reconcile only after successful login.

#### Scenario: Refresh is revoked during resync
- GIVEN a resync is active and refresh renewal is rejected
- WHEN the rejection is received
- THEN all sync pauses, durable workspace state remains intact, and login is required

#### Scenario: Login resumes preserved work
- GIVEN sync is paused for authentication with preserved workspace state
- WHEN the user logs in successfully
- THEN reconciliation resumes from durable cursor/checkpoint without reset of selection or mappings

### Requirement: Session Compatibility

Existing access-only sessions MUST require one interactive login before renewable operation. Migration of existing persisted session state MUST preserve non-secret workspace and projection data and MUST NOT synthesize a refresh credential.

#### Scenario: Upgrade from access-only session
- GIVEN an extension has a legacy access-only session
- WHEN it runs the upgraded extension
- THEN it requires login once while retaining its selected workspaces and projection state
