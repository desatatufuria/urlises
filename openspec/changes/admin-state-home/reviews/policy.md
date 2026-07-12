# Admin State Home Review Policy

## Boundary

| Field | Value |
| --- | --- |
| Target | current-changes |
| Lineage | admin-state-home |
| Generation | 1 |
| Lifecycle | ordinary_4r |
| Severity profile | HIGH |
| Changed lines | 776 |

Review only the current `admin-web` UX-redesign diff and its intended untracked admin-web paths. Do not inspect or assess backend, SMTP, prior review artifacts, or `openspec/changes/review-mirror-revert/**`.

## Review Focus

- State home gives an actionable attention signal and an at-a-glance organization summary.
- Organization context remains secondary to the active task.
- Horizontal navigation exposes Overview, People, Groups, Workspaces, and Access.
- Invitations remain within the People flow.
- Contextual panels are represented in the URL, restore on direct navigation, and close cleanly without losing the parent route.
- Existing member, invitation, group, workspace, access, sign-out, loading, empty, error, retry, and mutation flows remain functional.
- The responsive visual system is calm and precise while preserving keyboard access, visible focus, semantic controls, dialog behavior, and usable narrow layouts.

## Severity Guardrails

Report severe findings only for demonstrated functional regressions, accessibility blockers, security issues, or route-state failures. Do not classify generic aesthetic preferences or absent aggregate metrics as severe findings.

## Bounded Lifecycle

Use the standard bounded `ordinary_4r` lifecycle for this HIGH review. Keep findings within the stated diff and review focus; do not expand scope into historical or unrelated artifacts.
