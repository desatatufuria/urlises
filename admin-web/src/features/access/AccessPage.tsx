import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../app/providers/AuthProvider";
import { useOrganization } from "../../app/providers/OrganizationProvider";
import { useGroups } from "../groups/queries";
import { useOrganizationMembers } from "../members/queries";
import { useWorkspaces } from "../workspaces/queries";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { Table } from "../../lib/ui/components/Table";
import type { WorkspaceRole } from "../../lib/api/types";
import { AccessGrantForm } from "./AccessGrantForm";
import {
  useGrantGroupWorkspaceAccessMutation,
  useGrantUserWorkspaceAccessMutation,
  useRevokeGroupWorkspaceAccessMutation,
  useRevokeUserWorkspaceAccessMutation,
} from "./mutations";
import { useWorkspaceAccess } from "./queries";

const roleOptions: WorkspaceRole[] = ["admin", "editor", "viewer"];

function formatSourceLabel(source: string) {
  if (source === "direct") {
    return "Direct grant";
  }

  if (source.startsWith("group:")) {
    return `Group: ${source.slice("group:".length)}`;
  }

  return source;
}

export function AccessPage() {
  const { session } = useAuth();
  const { activeOrganization } = useOrganization();
  const [searchParams] = useSearchParams();
  const selectedWorkspaceId = searchParams.get("workspace");
  const [notice, setNotice] = useState<{ tone: "neutral" | "danger"; title: string; description: string } | null>(null);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [savingGroupId, setSavingGroupId] = useState<string | null>(null);
  const [showRawGrants, setShowRawGrants] = useState(false);

  const token = session?.accessToken;
  const organizationId = activeOrganization?.organizationId;

  const workspacesQuery = useWorkspaces(token, organizationId);
  const membersQuery = useOrganizationMembers(token, organizationId);
  const groupsQuery = useGroups(token, organizationId);

  const selectedWorkspace = useMemo(
    () => workspacesQuery.data?.find((workspace) => workspace.workspaceId === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspacesQuery.data],
  );

  const dependencyError = membersQuery.isError ? membersQuery : groupsQuery.isError ? groupsQuery : null;
  if (dependencyError) {
    return (
      <section className="ui-section-stack">
        <DataState tone="danger" title="Assignment options could not be loaded" description={dependencyError.error instanceof Error ? dependencyError.error.message : "Request failed."} />
        <button className="ui-button ui-button-secondary" type="button" onClick={() => void dependencyError.refetch()}>Retry assignment options</button>
      </section>
    );
  }

  const accessQuery = useWorkspaceAccess(token, selectedWorkspace?.workspaceId);
  const grantUserMutation = useGrantUserWorkspaceAccessMutation(token, selectedWorkspace?.workspaceId);
  const revokeUserMutation = useRevokeUserWorkspaceAccessMutation(token, selectedWorkspace?.workspaceId);
  const grantGroupMutation = useGrantGroupWorkspaceAccessMutation(token, selectedWorkspace?.workspaceId);
  const revokeGroupMutation = useRevokeGroupWorkspaceAccessMutation(token, selectedWorkspace?.workspaceId);

  const availableUsers = useMemo(() => {
    const grantedUserIds = new Set(accessQuery.data?.userGrants.map((grant) => grant.userId) ?? []);
    return (membersQuery.data ?? [])
      .filter((member) => !grantedUserIds.has(member.userId))
      .map((member) => ({ value: member.userId, label: member.email }));
  }, [accessQuery.data?.userGrants, membersQuery.data]);

  const availableGroups = useMemo(() => {
    const grantedGroupIds = new Set(accessQuery.data?.groupGrants.map((grant) => grant.groupId) ?? []);
    return (groupsQuery.data ?? [])
      .filter((group) => !grantedGroupIds.has(group.groupId))
      .map((group) => ({ value: group.groupId, label: group.name }));
  }, [accessQuery.data?.groupGrants, groupsQuery.data]);

  if (!token || !organizationId) {
    return <DataState tone="danger" title="Organization context missing" description="Choose an admin organization before reviewing workspace access." />;
  }

  if (workspacesQuery.isPending) {
    return (
      <section className="ui-section-stack">
        <DataState title="Loading workspace" description="Resolving the requested workspace before showing its access grants." />
      </section>
    );
  }

  if (workspacesQuery.isError) {
    return (
      <section className="ui-section-stack">
        <DataState tone="danger" title="Workspaces could not be loaded" description={workspacesQuery.error instanceof Error ? workspacesQuery.error.message : "Request failed."} />
        <div className="ui-actions-row">
          <button className="ui-button ui-button-secondary" type="button" onClick={() => void workspacesQuery.refetch()}>
            Retry workspaces
          </button>
        </div>
      </section>
    );
  }

  if (!selectedWorkspace) {
    return (
      <section className="ui-section-stack">
        <DataState
          tone="danger"
          title="No workspace selected"
          description="Workspace access is reached per-workspace from the Workspaces page. Open a workspace there and choose Manage access."
        />
        <div className="ui-actions-row">
          <Link className="ui-button ui-button-secondary" to="/workspaces">
            Go to Workspaces
          </Link>
        </div>
      </section>
    );
  }

  const accessSnapshot = accessQuery.data;

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <h2 className="ui-section-title">{selectedWorkspace.workspaceName} access</h2>
        <p className="ui-copy">Assign direct and group-based workspace grants, then verify the backend highest-role-wins result without exposing bookmark content tools.</p>
      </header>

      {notice ? <DataState compact tone={notice.tone} title={notice.title} description={notice.description} /> : null}

      <section className="ui-card ui-section-stack">
        <header className="ui-section-header">
          <div className="ui-actions-spread">
            <div>
              <h3 className="ui-section-title">{selectedWorkspace.workspaceName}</h3>
              <p className="ui-copy">{selectedWorkspace.workspaceType} workspace in {selectedWorkspace.organizationName}.</p>
            </div>
            <Badge tone={selectedWorkspace.role === "admin" ? "accent" : "neutral"}>{selectedWorkspace.role}</Badge>
          </div>
        </header>

        {accessQuery.isPending ? <DataState title="Loading access snapshot" description="Resolving raw grants and highest-role effective access for the selected workspace." /> : null}

        {accessQuery.isError ? (
          <div className="ui-section-stack">
            <DataState tone="danger" title="Workspace access could not be loaded" description={accessQuery.error instanceof Error ? accessQuery.error.message : "Request failed."} />
            <div className="ui-actions-row">
              <button className="ui-button ui-button-secondary" type="button" onClick={() => void accessQuery.refetch()}>
                Retry access snapshot
              </button>
            </div>
          </div>
        ) : null}

        {!accessQuery.isPending && !accessQuery.isError && accessSnapshot ? (
          <>
            {accessSnapshot.userGrants.length === 0 && accessSnapshot.groupGrants.length === 0 ? (
              <DataState
                title="Creator-only access"
                description="No extra grants exist yet. The creator remains the only initial admin until you add a direct user or group grant."
              />
            ) : null}

            <section className="ui-card ui-card--subtle ui-section-stack">
              <AccessGrantForm
                userOptions={availableUsers}
                groupOptions={availableGroups}
                submittingUser={grantUserMutation.isPending}
                submittingGroup={grantGroupMutation.isPending}
                onSubmitUser={async ({ subjectId, role }) => {
                  setNotice(null);
                  try {
                    await grantUserMutation.mutateAsync({ userId: subjectId, role });
                    const member = membersQuery.data?.find((entry) => entry.userId === subjectId);
                    setNotice({
                      tone: "neutral",
                      title: "Direct grant saved",
                      description: `${member?.email ?? "The selected member"} now has ${role} access to ${selectedWorkspace.workspaceName}.`,
                    });
                  } catch (error) {
                    setNotice({
                      tone: "danger",
                      title: "Direct grant failed",
                      description: error instanceof Error ? error.message : "The selected user grant could not be saved.",
                    });
                    throw error;
                  }
                }}
                onSubmitGroup={async ({ subjectId, role }) => {
                  setNotice(null);
                  try {
                    await grantGroupMutation.mutateAsync({ groupId: subjectId, role });
                    const group = groupsQuery.data?.find((entry) => entry.groupId === subjectId);
                    setNotice({
                      tone: "neutral",
                      title: "Group grant saved",
                      description: `${group?.name ?? "The selected group"} now has ${role} access to ${selectedWorkspace.workspaceName}.`,
                    });
                  } catch (error) {
                    setNotice({
                      tone: "danger",
                      title: "Group grant failed",
                      description: error instanceof Error ? error.message : "The selected group grant could not be saved.",
                    });
                    throw error;
                  }
                }}
              />
            </section>

            <section className="ui-section-stack">
              <header className="ui-section-header">
                <h3 className="ui-section-title">Effective access review</h3>
                <p className="ui-copy">This table reflects the backend highest-role-wins result plus the contributing grant paths.</p>
              </header>

              {accessSnapshot.effectiveAccess.length === 0 ? <DataState compact title="No effective access" description="No subject currently resolves to workspace access for this target." /> : null}

              {accessSnapshot.effectiveAccess.length > 0 ? (
                <Table columns={["Member", "Resolved role", "Sources"]}>
                  {accessSnapshot.effectiveAccess.map((entry) => (
                    <tr key={entry.userId}>
                      <td>{entry.email}</td>
                      <td>
                        <Badge tone={entry.role === "admin" ? "accent" : "neutral"}>{entry.role}</Badge>
                      </td>
                      <td>
                        <div className="ui-inline-badges">
                          {entry.sources.map((source) => (
                            <Badge key={`${entry.userId}-${source}`} tone="neutral">
                              {formatSourceLabel(source)}
                            </Badge>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </Table>
              ) : null}
            </section>

            <div className="ui-actions-row">
              <button
                className="ui-button ui-button-secondary"
                type="button"
                aria-expanded={showRawGrants}
                onClick={() => setShowRawGrants((current) => !current)}
              >
                {showRawGrants ? "Hide raw grants" : "Show raw grants"}
              </button>
            </div>

            {showRawGrants ? (
              <>
                <section className="ui-section-stack">
                  <header className="ui-section-header">
                    <h3 className="ui-section-title">Direct user grants</h3>
                    <p className="ui-copy">Changing a role updates the raw direct grant and then refreshes the effective-access view.</p>
                  </header>

                  {accessSnapshot.userGrants.length === 0 ? <DataState compact title="No direct user grants" description="Add a member grant when a workspace needs explicit access beyond the creator." /> : null}

                  {accessSnapshot.userGrants.length > 0 ? (
                    <Table columns={["Member", "Role", "Actions"]}>
                      {accessSnapshot.userGrants.map((grant) => (
                        <tr key={grant.userId}>
                          <td>
                            <strong>{grant.email}</strong>
                          </td>
                          <td>
                            <select
                              aria-label={`Direct role for ${grant.email}`}
                              disabled={savingUserId === grant.userId}
                              value={grant.role}
                              onChange={(event) => {
                                const role = event.target.value as WorkspaceRole;
                                if (!window.confirm(`Change ${grant.email}'s access to ${selectedWorkspace.workspaceName} from ${grant.role} to ${role}?`)) {
                                  event.target.value = grant.role;
                                  return;
                                }
                                setSavingUserId(grant.userId);
                                setNotice(null);
                                void grantUserMutation
                                  .mutateAsync({ userId: grant.userId, role })
                                  .then(() => {
                                    setNotice({ tone: "neutral", title: "Direct grant updated", description: `${grant.email} now uses the ${role} workspace role.` });
                                  })
                                  .catch((error) => {
                                    setNotice({
                                      tone: "danger",
                                      title: "Direct grant update failed",
                                      description: error instanceof Error ? error.message : "The direct grant could not be updated.",
                                    });
                                  })
                                  .finally(() => setSavingUserId(null));
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
                            <button
                              className="ui-button ui-button-secondary"
                              disabled={savingUserId === grant.userId}
                              type="button"
                              onClick={() => {
                                if (!window.confirm(`Remove ${grant.email}'s direct access to ${selectedWorkspace.workspaceName}?`)) {
                                  return;
                                }
                                setSavingUserId(grant.userId);
                                setNotice(null);
                                void revokeUserMutation
                                  .mutateAsync(grant.userId)
                                  .then(() => {
                                    setNotice({ tone: "neutral", title: "Direct grant removed", description: `${grant.email} no longer has an explicit direct grant.` });
                                  })
                                  .catch((error) => {
                                    setNotice({
                                      tone: "danger",
                                      title: "Direct grant removal failed",
                                      description: error instanceof Error ? error.message : "The direct grant could not be removed.",
                                    });
                                  })
                                  .finally(() => setSavingUserId(null));
                              }}
                            >
                              {savingUserId === grant.userId ? "Saving…" : "Remove"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </Table>
                  ) : null}
                </section>

                <section className="ui-section-stack">
                  <header className="ui-section-header">
                    <h3 className="ui-section-title">Group grants</h3>
                    <p className="ui-copy">Group grants remain flat and reusable, but they only matter after the workspace explicitly includes the group.</p>
                  </header>

                  {accessSnapshot.groupGrants.length === 0 ? <DataState compact title="No group grants" description="Attach a group when multiple members should inherit the same workspace role path." /> : null}

                  {accessSnapshot.groupGrants.length > 0 ? (
                    <Table columns={["Group", "Role", "Actions"]}>
                      {accessSnapshot.groupGrants.map((grant) => (
                        <tr key={grant.groupId}>
                          <td>
                            <strong>{grant.groupName}</strong>
                          </td>
                          <td>
                            <select
                              aria-label={`Group role for ${grant.groupName}`}
                              disabled={savingGroupId === grant.groupId}
                              value={grant.role}
                              onChange={(event) => {
                                const role = event.target.value as WorkspaceRole;
                                if (!window.confirm(`Change ${grant.groupName}'s access to ${selectedWorkspace.workspaceName} from ${grant.role} to ${role}?`)) {
                                  event.target.value = grant.role;
                                  return;
                                }
                                setSavingGroupId(grant.groupId);
                                setNotice(null);
                                void grantGroupMutation
                                  .mutateAsync({ groupId: grant.groupId, role })
                                  .then(() => {
                                    setNotice({ tone: "neutral", title: "Group grant updated", description: `${grant.groupName} now uses the ${role} workspace role.` });
                                  })
                                  .catch((error) => {
                                    setNotice({
                                      tone: "danger",
                                      title: "Group grant update failed",
                                      description: error instanceof Error ? error.message : "The group grant could not be updated.",
                                    });
                                  })
                                  .finally(() => setSavingGroupId(null));
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
                            <button
                              className="ui-button ui-button-secondary"
                              disabled={savingGroupId === grant.groupId}
                              type="button"
                              onClick={() => {
                                if (!window.confirm(`Remove ${grant.groupName}'s group access to ${selectedWorkspace.workspaceName}?`)) {
                                  return;
                                }
                                setSavingGroupId(grant.groupId);
                                setNotice(null);
                                void revokeGroupMutation
                                  .mutateAsync(grant.groupId)
                                  .then(() => {
                                    setNotice({ tone: "neutral", title: "Group grant removed", description: `${grant.groupName} no longer grants access to this workspace.` });
                                  })
                                  .catch((error) => {
                                    setNotice({
                                      tone: "danger",
                                      title: "Group grant removal failed",
                                      description: error instanceof Error ? error.message : "The group grant could not be removed.",
                                    });
                                  })
                                  .finally(() => setSavingGroupId(null));
                              }}
                            >
                              {savingGroupId === grant.groupId ? "Saving…" : "Remove"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </Table>
                  ) : null}
                </section>
              </>
            ) : null}
          </>
        ) : null}
      </section>
    </section>
  );
}
