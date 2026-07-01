# Bookmark Sync Projection Specification

## Purpose

Define snapshot and replay semantics.

## Requirements

### Requirement: Snapshot Bootstrap and Ordered Replay

The system MUST bootstrap each workspace from a snapshot and then apply realtime events in backend cursor/version order. A reconnecting client that presents its last acknowledged cursor SHALL receive only later events. If contiguous replay is unavailable, the system MUST require a fresh resync.

#### Scenario: Resume replay

- GIVEN a client applied state through cursor 120
- WHEN it reconnects and events 121-125 exist
- THEN it receives and applies only 121-125 in order

#### Scenario: Replay gap

- GIVEN a reconnecting client requests a missing or expired cursor
- WHEN contiguous replay cannot be produced
- THEN the system instructs the client to rebuild from a fresh snapshot

### Requirement: Idempotent Delivery and Origin Suppression

Each accepted shared mutation MUST persist its domain change and sync event transactionally in PostgreSQL. SQLite MUST NOT be used as the product event store for this MVP. Event IDs MUST be idempotent per workspace, duplicates MUST NOT create extra mutations, broadcasts SHALL exclude the origin client, and remote markers MUST suppress local re-emission.

#### Scenario: Broadcast excludes origin

- GIVEN client A creates a shared bookmark
- WHEN the backend broadcasts the event
- THEN client B receives it and client A does not
