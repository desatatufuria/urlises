# WebSocket User Notifications Specification

## Purpose

Extend the workspace-scoped `websocket.Hub` with user-identity routing so a server-side event tied to a user (not a workspace/bookmark-sync event) can be delivered to any of that user's currently-open sockets, with a defined fallback when none are open.

## Requirements

### Requirement: Per-User Subscription Index

The system MUST track each active `Subscription` by `UserID` in addition to the existing `WorkspaceID` index. `Hub.Subscribe` MUST accept and store the subscribing user's identity, and unsubscription MUST remove the subscription from both indexes.

#### Scenario: Subscribing populates the byUser index

- GIVEN an authenticated principal with `UserID = "u1"` opens a workspace socket
- WHEN `Hub.Subscribe(workspaceID, userID, clientID)` is called
- THEN the resulting `Subscription` MUST be retrievable via the `byUser["u1"]` index
- AND it MUST also remain retrievable via the existing `byWorkspace` index

#### Scenario: Closing a connection cleans up both indexes

- GIVEN a subscription exists in both `byWorkspace` and `byUser`
- WHEN the subscription is closed/unsubscribed
- THEN the system MUST remove it from `byUser` as well as `byWorkspace`
- AND no stale entry MUST remain in either map

#### Scenario: A user with multiple open workspace sockets has multiple entries

- GIVEN the same user has two open sockets for two different workspaces
- WHEN both are subscribed
- THEN `byUser[userID]` MUST contain both subscriptions

### Requirement: PublishToUser Delivery

The system MUST provide `Hub.PublishToUser(ctx, userID, message)` that delivers `message` to every currently-open subscription for that user, regardless of which workspace each subscription belongs to. This delivery path MUST be independent of `syncapi.Envelope`-shaped bookmark-sync events and MUST NOT require a `WorkspaceID` to route.

#### Scenario: Delivery reaches all of a user's open sockets

- GIVEN a user has two open workspace sockets (workspace A and workspace B)
- WHEN `Hub.PublishToUser(ctx, userID, secretReadMessage)` is called
- THEN both open sockets MUST receive the message

#### Scenario: PublishToUser is a no-op when the user has no open socket

- GIVEN a user has no currently-open subscription
- WHEN `Hub.PublishToUser(ctx, userID, message)` is called
- THEN the call MUST return without error
- AND no delivery attempt MUST be made

#### Scenario: PublishToUser does not affect other users' sockets

- GIVEN user A and user B both have open sockets
- WHEN `Hub.PublishToUser(ctx, userA, message)` is called
- THEN user B's socket MUST NOT receive the message

### Requirement: Secret-Read Notification Frame

The system MUST deliver a secret burn notification to the secret's creator via a distinct message frame type (`"secret_read"`) over the existing WebSocket protocol, discriminated the same way as existing `"ack"`/`"event"`/`"resync_required"` frames, triggered from a `PostCommit` hook after the burn transaction durably commits.

#### Scenario: Burn triggers a post-commit notification

- GIVEN a secret's burn transaction has just committed
- WHEN the `PostCommit` hook runs
- THEN the system MUST call `Hub.PublishToUser` with a `"secret_read"` frame identifying the burned secret, addressed to the secret creator's `UserID`

#### Scenario: Notification failure does not affect the burn response

- GIVEN the burn transaction committed successfully
- WHEN `PublishToUser` delivery fails or the user has no open socket
- THEN the already-returned burn HTTP response MUST remain unaffected
- AND the failure or no-op MUST be logged, not surfaced as an error to the anonymous caller

### Requirement: Offline Fallback Via Persisted State

When a user has no open socket at the time of a `"secret_read"` event, the system MUST persist the notification so it can be retrieved via the existing `session/get` pattern on the user's next popup open, reusing the `activitySignal`/`recordActivity` mechanism rather than introducing a new delivery channel.

#### Scenario: Offline user sees the notification on next popup open

- GIVEN a secret was burned while the creator had no open workspace socket
- WHEN the creator later opens the extension popup and it calls `session/get`
- THEN the response MUST include the pending read-confirmation
- AND the popup MUST render it as a distinct signal from ordinary sync activity

#### Scenario: Acknowledged notification does not resurface

- GIVEN the creator has viewed and acknowledged a read-confirmation notification
- WHEN they open the popup again later
- THEN the same notification MUST NOT be shown again
