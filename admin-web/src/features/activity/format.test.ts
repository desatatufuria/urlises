import { describe, expect, it } from "vitest";
import type { ActivityEvent, ActivityKind } from "../../lib/api/activity";
import { formatActivityEvent } from "./format";

function event(overrides: Partial<ActivityEvent> & { kind: ActivityKind }): ActivityEvent {
  return {
    id: "event-1",
    organizationId: "org-1",
    actorUserId: "user-1",
    actorEmail: "admin@example.com",
    actorName: "Admin",
    targetType: "organization",
    targetId: "org-1",
    metadata: {},
    createdAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("formatActivityEvent", () => {
  it("organization.created", () => {
    expect(
      formatActivityEvent(event({ kind: "organization.created", metadata: { organizationName: "Acme" } })),
    ).toBe('Created the organization "Acme".');
  });

  it("invitation.created", () => {
    expect(
      formatActivityEvent(event({ kind: "invitation.created", metadata: { email: "new@example.com", role: "member" } })),
    ).toBe("Invited new@example.com as member.");
  });

  it("invitation.resent", () => {
    expect(formatActivityEvent(event({ kind: "invitation.resent", metadata: { email: "new@example.com" } }))).toBe(
      "Resent the invitation to new@example.com.",
    );
  });

  it("invitation.accepted", () => {
    expect(
      formatActivityEvent(event({ kind: "invitation.accepted", metadata: { email: "new@example.com", role: "member" } })),
    ).toBe("Accepted the invitation to join as member.");
  });

  it("organization_member.role_changed", () => {
    expect(
      formatActivityEvent(
        event({
          kind: "organization_member.role_changed",
          metadata: { role: "editor", previousRole: "member", targetEmail: "jane@example.com" },
        }),
      ),
    ).toBe("Changed jane@example.com's role from member to editor.");
  });

  it("organization_member.removed", () => {
    expect(
      formatActivityEvent(
        event({
          kind: "organization_member.removed",
          metadata: { targetEmail: "jane@example.com", previousRole: "member" },
        }),
      ),
    ).toBe("Removed jane@example.com (was member) from the organization.");
  });

  it("workspace.created", () => {
    expect(
      formatActivityEvent(
        event({ kind: "workspace.created", metadata: { workspaceName: "Launch Room", workspaceType: "shared" } }),
      ),
    ).toBe('Created the workspace "Launch Room" (shared).');
  });

  it("workspace_access.user_granted", () => {
    expect(
      formatActivityEvent(
        event({ kind: "workspace_access.user_granted", metadata: { workspaceId: "workspace-1", role: "editor" } }),
      ),
    ).toBe("Granted editor access to a user on workspace workspace-1.");
  });

  it("workspace_access.user_revoked", () => {
    expect(
      formatActivityEvent(event({ kind: "workspace_access.user_revoked", metadata: { workspaceId: "workspace-1" } })),
    ).toBe("Revoked a user's access on workspace workspace-1.");
  });

  it("workspace_access.group_granted", () => {
    expect(
      formatActivityEvent(
        event({ kind: "workspace_access.group_granted", metadata: { workspaceId: "workspace-1", role: "viewer" } }),
      ),
    ).toBe("Granted viewer access to a group on workspace workspace-1.");
  });

  it("workspace_access.group_revoked", () => {
    expect(
      formatActivityEvent(event({ kind: "workspace_access.group_revoked", metadata: { workspaceId: "workspace-1" } })),
    ).toBe("Revoked a group's access on workspace workspace-1.");
  });

  it("group.created", () => {
    expect(formatActivityEvent(event({ kind: "group.created", metadata: { groupName: "Operators" } }))).toBe(
      'Created the group "Operators".',
    );
  });

  it("group.renamed", () => {
    expect(
      formatActivityEvent(event({ kind: "group.renamed", metadata: { previousName: "Ops", name: "Operators" } })),
    ).toBe('Renamed group "Ops" to "Operators".');
  });

  it("group.deleted", () => {
    expect(formatActivityEvent(event({ kind: "group.deleted", metadata: {} }))).toBe("Deleted a group.");
  });

  it("group_member.added", () => {
    expect(
      formatActivityEvent(
        event({ kind: "group_member.added", metadata: { groupId: "group-1", targetEmail: "jane@example.com" } }),
      ),
    ).toBe("Added jane@example.com to group group-1.");
  });

  it("group_member.removed", () => {
    expect(formatActivityEvent(event({ kind: "group_member.removed", metadata: { groupId: "group-1" } }))).toBe(
      "Removed a user from group group-1.",
    );
  });

  it("degrades gracefully with missing metadata instead of rendering undefined", () => {
    const message = formatActivityEvent(event({ kind: "organization.created", metadata: {} }));
    expect(message).not.toContain("undefined");
  });

  it("renders a readable default sentence for an unrecognized future kind", () => {
    const message = formatActivityEvent(
      event({
        kind: "some_future.kind" as ActivityKind,
        targetType: "widget",
        targetId: "widget-1",
        metadata: {},
      }),
    );
    expect(message).toBe("Performed some_future.kind on widget widget-1.");
  });
});
