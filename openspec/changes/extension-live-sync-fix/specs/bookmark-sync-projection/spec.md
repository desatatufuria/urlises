# Delta for bookmark-sync-projection

## MODIFIED Requirements

### Requirement: Snapshot Bootstrap and Ordered Replay

The system MUST bootstrap each workspace from a snapshot and then apply realtime events in backend cursor/version order. During healthy operation, subscribed clients MUST receive and apply remote changes automatically as the normal visible sync path. A reconnecting client that presents its last acknowledged cursor SHALL receive only later events. Replay or full resync MUST remain recovery-only for reconnects, proven cursor gaps, or live-delivery failure, and MUST NOT be the normal user-visible path. If contiguous replay is unavailable, the system MUST require a fresh resync.

(Previously: snapshot bootstrap and ordered replay were defined, but healthy live delivery as the default path and replay/resync as recovery-only were not explicit.)

#### Scenario: Healthy live delivery

- GIVEN a subscribed client has healthy workspace connectivity
- WHEN another client commits a shared change
- THEN the subscribed client applies the remote event automatically without manual reload or manual resync

#### Scenario: Resume replay

- GIVEN a client applied state through cursor 120
- WHEN it reconnects and events 121-125 exist
- THEN it receives and applies only 121-125 in order

#### Scenario: Replay gap

- GIVEN a reconnecting client requests a missing or expired cursor
- WHEN contiguous replay cannot be produced
- THEN the system instructs the client to rebuild from a fresh snapshot
