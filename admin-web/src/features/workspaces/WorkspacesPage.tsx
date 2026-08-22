import { useAuth } from "../../app/providers/AuthProvider";
import { useOrganization } from "../../app/providers/OrganizationProvider";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { Table } from "../../lib/ui/components/Table";
import { useCreateWorkspaceMutation, useDeleteWorkspaceMutation } from "./mutations";
import { useWorkspaces } from "./queries";
import { WorkspaceForm } from "./WorkspaceForm";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ContextPanel } from "../../lib/ui/components/ContextPanel";

export function WorkspacesPage() {
  const { session } = useAuth();
  const { activeOrganization } = useOrganization();
  const [notice, setNotice] = useState<{ tone: "neutral" | "danger"; title: string; description: string } | null>(null);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const createOpen = searchParams.get("panel") === "workspace-create";
  const closePanel = () => setSearchParams((current) => { const next = new URLSearchParams(current); next.delete("panel"); return next; });

  const token = session?.accessToken;
  const organizationId = activeOrganization?.organizationId;
  const workspacesQuery = useWorkspaces(token, organizationId);
  const createWorkspaceMutation = useCreateWorkspaceMutation(token, organizationId);
  const deleteWorkspaceMutation = useDeleteWorkspaceMutation(token, organizationId);

  if (!token || !organizationId) {
    return <DataState tone="danger" title="Organization context missing" description="Choose an admin organization before managing workspaces." />;
  }

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <div className="ui-actions-spread"><div><h1 className="ui-page-title">Workspaces</h1><p className="ui-copy">Review the current portfolio and its backend-provided access summary.</p></div><button className="ui-button ui-button-primary" type="button" onClick={() => setSearchParams({ panel: "workspace-create" })}>New workspace</button></div>
      </header>

      {notice ? <DataState compact tone={notice.tone} title={notice.title} description={notice.description} /> : null}

      <section className="ui-grouped-section ui-section-stack">
        <header className="ui-section-header">
          <div className="ui-actions-spread">
            <div>
              <h3 className="ui-section-title">Workspace list</h3>
              <p className="ui-copy">The current role and source summary come from the backend effective-access view, not local UI assumptions.</p>
            </div>
            <Badge tone="neutral">{workspacesQuery.data?.length ?? 0} workspaces</Badge>
          </div>
        </header>

        {workspacesQuery.isPending ? <DataState title="Loading workspaces" description="Reviewing the accessible workspace inventory for the active organization." /> : null}

        {workspacesQuery.isError ? (
          <div className="ui-section-stack">
            <DataState tone="danger" title="Workspaces could not be loaded" description={workspacesQuery.error instanceof Error ? workspacesQuery.error.message : "Request failed."} />
            <div className="ui-actions-row">
              <button className="ui-button ui-button-secondary" type="button" onClick={() => void workspacesQuery.refetch()}>
                Retry workspaces
              </button>
            </div>
          </div>
        ) : null}

        {!workspacesQuery.isPending && !workspacesQuery.isError && (workspacesQuery.data?.length ?? 0) === 0 ? (
          <DataState title="No workspaces yet" description="Create the first workspace now, then use the Access route to add direct or group grants." />
        ) : null}

        {!workspacesQuery.isPending && !workspacesQuery.isError && (workspacesQuery.data?.length ?? 0) > 0 ? (
          <Table columns={["Workspace", "Type", "Current role", "Grant sources", "Actions"]}>
            {workspacesQuery.data?.map((workspace) => (
              <tr key={workspace.workspaceId}>
                <td>
                  <div className="ui-cell-stack">
                    <strong>{workspace.workspaceName}</strong>
                    <span className="ui-muted">{workspace.organizationName}</span>
                  </div>
                </td>
                <td>
                  <Badge tone="neutral">{workspace.workspaceType}</Badge>
                </td>
                <td>
                  <Badge tone={workspace.role === "admin" ? "accent" : "neutral"}>{workspace.role}</Badge>
                </td>
                <td>
                  {workspace.sources && workspace.sources.length > 0 ? (
                    <div className="ui-inline-badges">
                      {workspace.sources.map((source) => (
                        <Badge key={`${workspace.workspaceId}-${source}`} tone="neutral">
                          {source}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    "creator-only access"
                  )}
                </td>
                <td>
                  <div className="ui-actions-row">
                    <Link className="ui-button ui-button-secondary" to={`/access?panel=access&workspace=${workspace.workspaceId}`}>
                      Manage access
                    </Link>
                    <button
                      className="ui-button ui-button-secondary"
                      type="button"
                      disabled={deletingWorkspaceId === workspace.workspaceId}
                      aria-label={`Delete ${workspace.workspaceName}`}
                      onClick={() => {
                        if (!window.confirm(`Delete the workspace "${workspace.workspaceName}"? This cannot be undone.`)) {
                          return;
                        }
                        setNotice(null);
                        setDeletingWorkspaceId(workspace.workspaceId);
                        void deleteWorkspaceMutation
                          .mutateAsync(workspace.workspaceId)
                          .then(() => {
                            setNotice({
                              tone: "neutral",
                              title: "Workspace deleted",
                              description: `${workspace.workspaceName} and all of its contents have been removed.`,
                            });
                          })
                          .catch((error) => {
                            setNotice({
                              tone: "danger",
                              title: "Workspace deletion rejected",
                              description: error instanceof Error ? error.message : "The backend rejected the deletion request.",
                            });
                          })
                          .finally(() => setDeletingWorkspaceId(null));
                      }}
                    >
                      {deletingWorkspaceId === workspace.workspaceId ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : null}
      </section>
      {createOpen ? <ContextPanel title="Create workspace" onClose={closePanel}><p className="ui-copy">New workspaces begin with only the creator as the initial admin.</p><WorkspaceForm submitting={createWorkspaceMutation.isPending} onSubmit={async (input) => { setNotice(null); try { const workspace = await createWorkspaceMutation.mutateAsync(input); setNotice({ tone: "neutral", title: "Workspace created", description: `${workspace.workspaceName} is ready for access review and grant assignment.` }); closePanel(); } catch (error) { setNotice({ tone: "danger", title: "Workspace creation failed", description: error instanceof Error ? error.message : "The workspace could not be created." }); throw error; } }} /></ContextPanel> : null}
    </section>
  );
}
