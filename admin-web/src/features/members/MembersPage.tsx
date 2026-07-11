import { useMemo, useState } from "react";
import { useAuth } from "../../app/providers/AuthProvider";
import { useOrganization } from "../../app/providers/OrganizationProvider";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { Table } from "../../lib/ui/components/Table";
import type { OrganizationRole } from "../../lib/api/types";
import { InviteMemberForm } from "./InviteMemberForm";
import { useInviteMemberMutation, useUpdateMemberRoleMutation } from "./mutations";
import { useOrganizationInvitations, useOrganizationMembers } from "./queries";

const roleOptions: OrganizationRole[] = ["owner", "admin", "member"];

function formatTimestamp(value?: string | null) {
  if (!value) {
    return "No expiry";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function MembersPage({ focus = "members" }: { focus?: "members" | "invitations" }) {
  const { session } = useAuth();
  const { activeOrganization } = useOrganization();
  const [notice, setNotice] = useState<{ tone: "neutral" | "danger"; title: string; description: string } | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const organizationId = activeOrganization?.organizationId;
  const token = session?.accessToken;
  const membersQuery = useOrganizationMembers(token, organizationId);
  const invitationsQuery = useOrganizationInvitations(token, organizationId);
  const inviteMutation = useInviteMemberMutation(token, organizationId);
  const updateRoleMutation = useUpdateMemberRoleMutation(token, organizationId);

  const pageTitle = focus === "invitations" ? "Invitations" : "Members";
  const pageDescription =
    focus === "invitations"
      ? "Invite admins or members, then review the pending queue without leaving the calm operator shell."
      : "Review live members, adjust roles, and keep pending invites visible in the same organization surface.";

  const sections = useMemo(
    () => (focus === "invitations" ? ["invitations", "members"] : ["members", "invitations"]),
    [focus],
  );

  if (!token || !organizationId) {
    return <DataState tone="danger" title="Organization context missing" description="Choose an admin organization before managing people." />;
  }

  const renderMembersSection = () => {
    if (membersQuery.isPending) {
      return <DataState title="Loading members" description="Checking the current organization roster and role assignments." />;
    }

    if (membersQuery.isError) {
      return (
        <div className="ui-section-stack">
          <DataState
            tone="danger"
            title="Members could not be loaded"
            description={membersQuery.error instanceof Error ? membersQuery.error.message : "Request failed."}
          />
          <div className="ui-actions-row">
            <button className="ui-button ui-button-secondary" type="button" onClick={() => void membersQuery.refetch()}>
              Retry members
            </button>
          </div>
        </div>
      );
    }

    const members = membersQuery.data ?? [];
    if (members.length === 0) {
      return <DataState title="No members yet" description="Send the first invitation to start building this organization roster." />;
    }

    return (
      <Table columns={["Member", "Role", "Actions"]}>
        {members.map((member) => (
          <tr key={member.userId}>
            <td>
              <div className="ui-cell-stack">
                <strong>{member.name || member.email}</strong>
                <span className="ui-muted">{member.email}</span>
              </div>
            </td>
            <td>
              <select
                aria-label={`Role for ${member.email}`}
                disabled={updatingUserId === member.userId}
                value={member.role}
                onChange={(event) => {
                  const nextRole = event.target.value as OrganizationRole;
                  setNotice(null);
                  setUpdatingUserId(member.userId);
                  void updateRoleMutation
                    .mutateAsync({ userId: member.userId, role: nextRole })
                    .then(() => {
                      setNotice({
                        tone: "neutral",
                        title: "Role updated",
                        description: `${member.email} now uses the ${nextRole} organization role.`,
                      });
                    })
                    .catch((error) => {
                      setNotice({
                        tone: "danger",
                        title: "Role update rejected",
                        description: error instanceof Error ? error.message : "The backend rejected the requested role change.",
                      });
                    })
                    .finally(() => setUpdatingUserId(null));
                }}
              >
                {roleOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <Badge tone={member.role === "owner" ? "accent" : "neutral"}>{updatingUserId === member.userId ? "Saving…" : "Synced"}</Badge>
            </td>
          </tr>
        ))}
      </Table>
    );
  };

  const renderInvitationsSection = () => {
    const invitations = invitationsQuery.data ?? [];

    return (
      <div className="ui-section-stack">
        <InviteMemberForm
          submitting={inviteMutation.isPending}
          onSubmit={async (input) => {
            setNotice(null);
            try {
              await inviteMutation.mutateAsync(input);
              setNotice({
                tone: "neutral",
                title: "Invitation queued",
                description: `${input.email} now appears in the pending invitation list.`,
              });
            } catch (error) {
              setNotice({
                tone: "danger",
                title: "Invitation failed",
                description: error instanceof Error ? error.message : "The invite could not be created.",
              });
              throw error;
            }
          }}
        />

        {invitationsQuery.isPending ? <DataState title="Loading invitations" description="Reviewing the pending invite queue for this organization." /> : null}

        {invitationsQuery.isError ? (
          <div className="ui-section-stack">
            <DataState
              tone="danger"
              title="Pending invitations could not be loaded"
              description={invitationsQuery.error instanceof Error ? invitationsQuery.error.message : "Request failed."}
            />
            <div className="ui-actions-row">
              <button className="ui-button ui-button-secondary" type="button" onClick={() => void invitationsQuery.refetch()}>
                Retry invitations
              </button>
            </div>
          </div>
        ) : null}

        {!invitationsQuery.isPending && !invitationsQuery.isError && invitations.length === 0 ? (
          <DataState title="No pending invitations" description="Invite teammates when you are ready to expand organization access." />
        ) : null}

        {!invitationsQuery.isPending && !invitationsQuery.isError && invitations.length > 0 ? (
          <Table columns={["Invitee", "Role", "Status", "Expires"]}>
            {invitations.map((invitation) => (
              <tr key={invitation.invitationId}>
                <td>
                  <div className="ui-cell-stack">
                    <strong>{invitation.email}</strong>
                    <span className="ui-muted">Sent by {invitation.invitedByEmail ?? invitation.invitedByUserId}</span>
                  </div>
                </td>
                <td>
                  <Badge tone="neutral">{invitation.role}</Badge>
                </td>
                <td>
                  <Badge tone={invitation.status === "pending" ? "accent" : "neutral"}>{invitation.status}</Badge>
                </td>
                <td>{formatTimestamp(invitation.expiresAt)}</td>
              </tr>
            ))}
          </Table>
        ) : null}
      </div>
    );
  };

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <h2 className="ui-section-title">{pageTitle}</h2>
        <p className="ui-copy">{pageDescription}</p>
      </header>

      {notice ? <DataState compact tone={notice.tone} title={notice.title} description={notice.description} /> : null}

      {sections.map((section) => (
        <section key={section} className="ui-card ui-section-stack">
          <header className="ui-section-header">
            <h3 className="ui-section-title">{section === "members" ? "Active members" : "Invite and review pending access"}</h3>
            <p className="ui-copy">
              {section === "members"
                ? "Role changes stay server-authoritative. Rejected updates keep the previous state visible."
                : "Invitations use the backend pending-invite read model added in the earlier chain slice."}
            </p>
          </header>
          {section === "members" ? renderMembersSection() : renderInvitationsSection()}
        </section>
      ))}
    </section>
  );
}
