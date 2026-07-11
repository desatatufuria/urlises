import { useAuth } from "../../app/providers/AuthProvider";
import { useOrganization } from "../../app/providers/OrganizationProvider";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { Table } from "../../lib/ui/components/Table";
import { useCreateWorkspaceMutation } from "./mutations";
import { useWorkspaces } from "./queries";
import { WorkspaceForm } from "./WorkspaceForm";
import { useState } from "react";

export function WorkspacesPage() {
  const { session } = useAuth();
  const { activeOrganization } = useOrganization();
  const [notice, setNotice] = useState<{ tone: "neutral" | "danger"; title: string; description: string } | null>(null);

  const token = session?.accessToken;
  const organizationId = activeOrganization?.organizationId;
  const workspacesQuery = useWorkspaces(token, organizationId);
  const createWorkspaceMutation = useCreateWorkspaceMutation(token, organizationId);

  if (!token || !organizationId) {
    return <DataState tone="danger" title="Organization context missing" description="Choose an admin organization before managing workspaces." />;
  }

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <h2 className="ui-section-title">Workspaces</h2>
        <p className="ui-copy">Create new workspaces, review the current portfolio, and keep bookmark-content management out of this operator shell.</p>
      </header>

      {notice ? <DataState compact tone={notice.tone} title={notice.title} description={notice.description} /> : null}

      <section className="ui-card ui-section-stack">
        <header className="ui-section-header">
          <h3 className="ui-section-title">Create workspace</h3>
          <p className="ui-copy">New workspaces start with only the creator as the initial admin until explicit user or group grants are added.</p>
        </header>

        <WorkspaceForm
          submitting={createWorkspaceMutation.isPending}
          onSubmit={async (input) => {
            setNotice(null);
            try {
              const workspace = await createWorkspaceMutation.mutateAsync(input);
              setNotice({
                tone: "neutral",
                title: "Workspace created",
                description: `${workspace.workspaceName} is ready for access review and grant assignment.`,
              });
            } catch (error) {
              setNotice({
                tone: "danger",
                title: "Workspace creation failed",
                description: error instanceof Error ? error.message : "The workspace could not be created.",
              });
              throw error;
            }
          }}
        />
      </section>

      <section className="ui-card ui-section-stack">
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
          <Table columns={["Workspace", "Type", "Current role", "Grant sources"]}>
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
                <td>{workspace.sources?.join(", ") || "creator-only access"}</td>
              </tr>
            ))}
          </Table>
        ) : null}
      </section>
    </section>
  );
}
