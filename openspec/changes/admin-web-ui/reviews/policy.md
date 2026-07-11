# Bounded Review Policy: admin-web-ui

## Target

- Change: `admin-web-ui`
- Target kind: current working changes with an explicit intended-untracked manifest.
- Lineage: `admin-web-ui`
- Mode: ordinary 4R.
- Risk tier: high because the candidate touches authentication/authorization paths and exceeds 400 authored changed lines.

## Included Scope

- The `admin-web/` application and its tests.
- Admin-facing backend organization, group, workspace-access, and local CORS behavior.
- Admin-web documentation, SDD artifacts, and the local invitation activation helper.
- Existing tracked changes listed by the frozen snapshot after SMTP isolation.

## Excluded Scope

- `openspec/changes/smtp-infrastructure/**`.
- The stashed Mailpit `docker-compose.yml` change.
- The stashed SMTP-oriented `openspec/config.yaml` refresh.
- Invitation email delivery, outbox processing, SMTP configuration, and invitation acceptance UI.

## Review Execution

- Run exactly one initial sweep for each lens: risk, resilience, readability, and reliability.
- Freeze findings after those four sweeps.
- BLOCKER and CRITICAL findings require deterministic corroboration or one batched refuter operation when inferential.
- WARNING and SUGGESTION findings are informational and do not trigger correction.
- Ordinary review permits at most one correction transaction and one scoped fix-delta validation.
- Reviewers are detached, read-only, and may not modify code or launch further agents.

## Acceptance Evidence

- Backend and admin-web tests/builds must be current during independent final verification.
- Manual evidence covers admin login, non-admin rejection, invitation visibility, workspace creation, persisted group membership, and mixed direct/group highest-role-wins access.
- The known group-source UUID display is a non-blocking usability follow-up unless review proves incorrect authorization behavior.
