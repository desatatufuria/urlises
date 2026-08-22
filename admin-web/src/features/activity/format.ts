import type { ActivityEvent } from "../../lib/api/activity";

// formatActivityEvent renders one activity_events row as a single
// human-readable sentence, covering all 16 recorded Kind values. It never
// names the actor -- ActivityPage already has a dedicated "Actor" column,
// and repeating "jane@co.com" at the start of every sentence in the
// adjacent "Event" column would say the same thing twice on one row.
// Metadata keys match exactly what each backend call site records
// (cross-checked against organizations/workspaces/groups service.go, not
// guessed) -- missing/partial metadata degrades to a generic placeholder
// instead of "undefined" ever reaching the rendered string.
export function formatActivityEvent(event: ActivityEvent): string {
  const m = event.metadata as Record<string, string | undefined>;

  switch (event.kind) {
    case "organization.created":
      return `Created the organization "${m.organizationName ?? ""}".`;
    case "organization.deleted":
      return `Deleted the organization "${m.organizationName ?? ""}".`;
    case "invitation.created":
      return `Invited ${m.email ?? "someone"} as ${m.role ?? "member"}.`;
    case "invitation.resent":
      return `Resent the invitation to ${m.email ?? "someone"}.`;
    case "invitation.accepted":
      return `Accepted the invitation to join as ${m.role ?? "member"}.`;
    case "invitation.cancelled":
      return `Cancelled the invitation to ${m.email ?? "someone"}.`;
    case "organization_member.role_changed":
      return `Changed ${m.targetEmail ?? "a member"}'s role from ${m.previousRole ?? "?"} to ${m.role ?? "?"}.`;
    case "organization_member.removed":
      return `Removed ${m.targetEmail ?? "a member"} (was ${m.previousRole ?? "?"}) from the organization.`;
    case "workspace.created":
      return `Created the workspace "${m.workspaceName ?? ""}" (${m.workspaceType ?? "unknown type"}).`;
    case "workspace.deleted":
      return `Deleted the workspace "${m.workspaceName ?? ""}".`;
    case "workspace_access.user_granted":
      return `Granted ${m.role ?? "?"} access to a user on workspace ${m.workspaceId ?? "?"}.`;
    case "workspace_access.user_revoked":
      return `Revoked a user's access on workspace ${m.workspaceId ?? "?"}.`;
    case "workspace_access.group_granted":
      return `Granted ${m.role ?? "?"} access to a group on workspace ${m.workspaceId ?? "?"}.`;
    case "workspace_access.group_revoked":
      return `Revoked a group's access on workspace ${m.workspaceId ?? "?"}.`;
    case "group.created":
      return `Created the group "${m.groupName ?? ""}".`;
    case "group.renamed":
      return `Renamed group "${m.previousName ?? "?"}" to "${m.name ?? "?"}".`;
    case "group.deleted":
      return `Deleted a group.`;
    case "group_member.added":
      return `Added ${m.targetEmail ?? "a user"} to group ${m.groupId ?? "?"}.`;
    case "group_member.removed":
      return `Removed a user from group ${m.groupId ?? "?"}.`;
    default:
      // Defensive only -- unreachable for the 16 recorded kinds today. A
      // future kind added to the backend without a matching branch here
      // degrades to a readable-if-generic sentence instead of throwing or
      // rendering blank/undefined text.
      return `Performed ${event.kind} on ${event.targetType} ${event.targetId}.`;
  }
}
