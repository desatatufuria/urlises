import { apiRequest } from "./client";

// ActivityKind mirrors backend/internal/activity/service.go's Kind constants
// verbatim -- the wire value is a plain string, but this union gives
// compile-time exhaustiveness pressure in format.ts's switch.
export type ActivityKind =
  | "organization.created"
  | "invitation.created"
  | "invitation.resent"
  | "invitation.accepted"
  | "invitation.cancelled"
  | "organization_member.role_changed"
  | "organization_member.removed"
  | "workspace.created"
  | "workspace_access.user_granted"
  | "workspace_access.user_revoked"
  | "workspace_access.group_granted"
  | "workspace_access.group_revoked"
  | "group.created"
  | "group.renamed"
  | "group.deleted"
  | "group_member.added"
  | "group_member.removed";

// ActivityEvent mirrors backend/internal/activity/service.go's Event struct
// JSON tags verbatim. actorUserId/actorEmail/actorName are nullable --
// actor_user_id is ON DELETE SET NULL, so a former member's events survive
// their own removal with these fields absent/null.
export interface ActivityEvent {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  kind: ActivityKind;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ActivityPage mirrors backend/internal/activity/handler.go's response shape
// verbatim: {"events": [...], "nextCursor": "..."}. nextCursor is "" (never
// null) when no further page exists -- matches the handler's
// ListByOrganization contract, not design.md's earlier `string | null` draft.
export interface ActivityPage {
  events: ActivityEvent[];
  nextCursor: string;
}

// listOrgActivity fetches one page of an organization's activity feed,
// newest-first. cursor is the opaque token from a prior page's nextCursor;
// omit it (or pass "") for the first page, in which case no `cursor` query
// param is sent at all.
export function listOrgActivity(organizationId: string, token: string, cursor?: string, limit = 50) {
  const params = new URLSearchParams();
  if (cursor) {
    params.set("cursor", cursor);
  }
  params.set("limit", String(limit));

  return apiRequest<ActivityPage>(`/organizations/${encodeURIComponent(organizationId)}/activity?${params.toString()}`, {
    method: "GET",
    token,
  });
}
