# Extension Access and Projection Specification

## Purpose

Define the premium redesign behavior for popup, options, toolbar status badge, and projection-status presentation without changing backend or admin scope.

## Requirements

### Requirement: Popup Session Overview

The popup MUST preserve sign-in and sign-out flows while presenting a stronger session summary, selected-workspace summary, and projection-status overview with a clear path to options.

#### Scenario: Signed-in users see concise operational status

- GIVEN a user has an active session
- WHEN the popup loads
- THEN it MUST show session identity, backend context, selected workspace count, and current projection status summary

#### Scenario: No workspace is selected yet

- GIVEN a user is signed in with zero selected workspaces
- WHEN the popup renders
- THEN it SHALL show an empty-state summary that directs the user to options instead of implying sync is active

### Requirement: Options Status Hierarchy

The options page MUST keep workspace selection and resync controls while presenting per-workspace status, online state, diagnostics, and new-activity cues in a clearer hierarchy.

#### Scenario: Healthy workspaces remain easy to scan

- GIVEN the user opens options with selected workspaces in healthy sync
- WHEN workspace groups render
- THEN each workspace SHOULD show calm status information without a degraded warning banner

#### Scenario: Degraded sync remains explicit

- GIVEN one or more workspaces are degraded
- WHEN the options page renders
- THEN the degraded warning MUST stay prominent and MUST preserve supporting diagnostics and recovery actions

### Requirement: Toolbar Status Badge

The extension toolbar icon MUST mirror the existing projection health/activity lifecycle with a compact badge that stays quieter than popup/options content.

#### Scenario: Unseen activity appears as a subtle toolbar cue

- GIVEN live sync has recorded fresh activity that has not been acknowledged by popup/options
- WHEN the background state refreshes
- THEN the toolbar icon MUST show a subtle blue badge until that activity is marked as seen

#### Scenario: Degraded sync takes precedence in the toolbar

- GIVEN one or more workspaces are degraded
- WHEN the toolbar badge is derived from extension state
- THEN the toolbar icon MUST show a red degraded badge and MUST override the unseen-activity blue badge until degradation clears

### Requirement: Operational Scope Guardrail

The system MUST limit this redesign to popup, options, toolbar badge, and status surfaces, and MUST NOT introduce bookmark-management, backend-administration, or unrelated hardening features.

#### Scenario: Surface scope stays constrained

- GIVEN the premium redesign is delivered
- WHEN a reviewer inspects popup and options capabilities
- THEN only authentication, backend selection, workspace projection, status, and resync controls SHALL be expanded
