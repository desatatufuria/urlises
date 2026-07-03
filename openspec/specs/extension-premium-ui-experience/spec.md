# Extension Premium UI Experience Specification

## Purpose

Define the reusable premium UI foundation for extension popup, options, and status surfaces only.

## Requirements

### Requirement: Shared Theme Foundation

The system MUST provide shared visual foundations for popup, options, and status surfaces, including dark theme support, reusable surface states, and readable hierarchy across compact and expanded layouts.

#### Scenario: Dark theme is available across extension surfaces

- GIVEN the user opens the popup or options page
- WHEN the premium UI renders
- THEN the surface MUST use the shared theme foundation with dark-theme styling and accessible contrast

#### Scenario: Dense status content stays readable

- GIVEN multiple session or sync details are visible
- WHEN the surface shows summary, status, and actions together
- THEN the hierarchy SHALL keep primary status and actions visually clearer than secondary text

### Requirement: Subtle Motion Rules

The system SHALL use motion only to support state changes, hierarchy, and feedback, and MUST avoid decorative animation that competes with sync comprehension.

#### Scenario: Status transitions stay calm

- GIVEN a status chip or panel changes state
- WHEN the UI updates
- THEN any motion SHOULD be brief, subtle, and limited to the affected surface

#### Scenario: Critical status is never hidden by motion

- GIVEN sync health needs user attention
- WHEN the UI emphasizes that state
- THEN the attention cue MUST remain readable without depending on animation alone

### Requirement: Cross-Surface Activity Signals

The system MUST expose a subtle online indicator and a blue new-activity indicator on supported popup, options, and status surfaces when current UI state reports those conditions.

#### Scenario: Online state is visible

- GIVEN a projected workspace has live connectivity
- WHEN the user views popup or options status
- THEN the UI MUST show a calm online signal without interruptive alerts

#### Scenario: Fresh activity is highlighted without noise

- GIVEN new sync activity arrives after the user last reviewed status
- WHEN the relevant surface renders current state
- THEN the UI MUST show a blue new-activity indicator and MUST hide it when no fresh activity remains
