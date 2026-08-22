import { useState } from "react";
import { useAuth } from "../../app/providers/AuthProvider";
import { AdminShellContext } from "../../app/shell/AdminShellContext";
import { AppShell } from "../../lib/ui/components/AppShell";
import { DataState } from "../../lib/ui/components/DataState";
import { Table } from "../../lib/ui/components/Table";
import type { DeletedOrganization, DeletedWorkspace } from "../../lib/api/types";
import { useRestoreOrganizationMutation, useRestoreWorkspaceMutation } from "./mutations";
import { useDeletedOrganizations, useDeletedWorkspaces } from "./queries";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// daysRemaining clamps to 0 rather than going negative -- a row past its
// purgeAt is about to be (or already was) swept by the purge job, and a
// negative countdown reads as broken rather than informative.
function daysRemaining(purgeAt: string): number {
  const remainingMs = new Date(purgeAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(remainingMs / MS_PER_DAY));
}

function formatDeletedAt(deletedAt: string): string {
  const parsed = new Date(deletedAt);
  return Number.isNaN(parsed.getTime()) ? deletedAt : parsed.toLocaleString();
}

type Notice = { tone: "neutral" | "danger"; title: string; description: string };

export function TrashPage() {
  const { session } = useAuth();
  const token = session?.accessToken;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const deletedOrganizationsQuery = useDeletedOrganizations(token);
  const deletedWorkspacesQuery = useDeletedWorkspaces(token);
  const restoreOrganizationMutation = useRestoreOrganizationMutation(token);
  const restoreWorkspaceMutation = useRestoreWorkspaceMutation(token);

  const handleRestoreOrganization = (organization: DeletedOrganization) => {
    setNotice(null);
    setRestoringId(organization.organizationId);
    restoreOrganizationMutation
      .mutateAsync(organization.organizationId)
      .then(() => {
        setNotice({
          tone: "neutral",
          title: "Organization restored",
          description: `${organization.organizationName} is reachable again.`,
        });
      })
      .catch((error) => {
        setNotice({
          tone: "danger",
          title: "Restore failed",
          description: error instanceof Error ? error.message : "The backend rejected the restore request.",
        });
      })
      .finally(() => setRestoringId(null));
  };

  const handleRestoreWorkspace = (workspace: DeletedWorkspace) => {
    setNotice(null);
    setRestoringId(workspace.workspaceId);
    restoreWorkspaceMutation
      .mutateAsync({ workspaceId: workspace.workspaceId, organizationId: workspace.organizationId })
      .then(() => {
        setNotice({
          tone: "neutral",
          title: "Workspace restored",
          description: `${workspace.workspaceName} is reachable again.`,
        });
      })
      .catch((error) => {
        setNotice({
          tone: "danger",
          title: "Restore failed",
          description: error instanceof Error ? error.message : "The backend rejected the restore request.",
        });
      })
      .finally(() => setRestoringId(null));
  };

  if (!token) {
    return <DataState tone="danger" title="Session required" description="Sign in to view the trash." />;
  }

  return (
    <AppShell context={<AdminShellContext />}>
      <section className="ui-section-stack">
        <header className="ui-section-header">
          <h1 className="ui-page-title">Trash</h1>
          <p className="ui-copy">Deleted organizations and workspaces stay recoverable here for 30 days before they are permanently purged.</p>
        </header>

        {notice ? <DataState compact tone={notice.tone} title={notice.title} description={notice.description} /> : null}

        <section className="ui-grouped-section ui-section-stack">
          <header className="ui-section-header">
            <h3 className="ui-section-title">Deleted organizations</h3>
          </header>

          {deletedOrganizationsQuery.isPending ? (
            <DataState title="Loading deleted organizations" description="Checking which organizations you own or administer are in the trash." />
          ) : null}

          {deletedOrganizationsQuery.isError ? (
            <DataState
              tone="danger"
              title="Deleted organizations could not be loaded"
              description={deletedOrganizationsQuery.error instanceof Error ? deletedOrganizationsQuery.error.message : "Request failed."}
            />
          ) : null}

          {!deletedOrganizationsQuery.isPending && !deletedOrganizationsQuery.isError && (deletedOrganizationsQuery.data?.length ?? 0) === 0 ? (
            <DataState title="No deleted organizations" description="Organizations you own or administer will appear here for 30 days after deletion." />
          ) : null}

          {!deletedOrganizationsQuery.isPending && !deletedOrganizationsQuery.isError && (deletedOrganizationsQuery.data?.length ?? 0) > 0 ? (
            <Table columns={["Organization", "Deleted", "Deleted by", "Days remaining", "Actions"]}>
              {deletedOrganizationsQuery.data?.map((organization) => (
                <tr key={organization.organizationId}>
                  <td>{organization.organizationName}</td>
                  <td>{formatDeletedAt(organization.deletedAt)}</td>
                  <td>{organization.deletedByEmail ?? "—"}</td>
                  <td>{daysRemaining(organization.purgeAt)} days remaining</td>
                  <td>
                    <button
                      className="ui-button ui-button-secondary"
                      type="button"
                      disabled={restoringId === organization.organizationId}
                      aria-label={`Restore ${organization.organizationName}`}
                      onClick={() => handleRestoreOrganization(organization)}
                    >
                      {restoringId === organization.organizationId ? "Restoring…" : "Restore"}
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </section>

        <section className="ui-grouped-section ui-section-stack">
          <header className="ui-section-header">
            <h3 className="ui-section-title">Deleted workspaces</h3>
          </header>

          {deletedWorkspacesQuery.isPending ? (
            <DataState title="Loading deleted workspaces" description="Checking which workspaces you own or administer are in the trash." />
          ) : null}

          {deletedWorkspacesQuery.isError ? (
            <DataState
              tone="danger"
              title="Deleted workspaces could not be loaded"
              description={deletedWorkspacesQuery.error instanceof Error ? deletedWorkspacesQuery.error.message : "Request failed."}
            />
          ) : null}

          {!deletedWorkspacesQuery.isPending && !deletedWorkspacesQuery.isError && (deletedWorkspacesQuery.data?.length ?? 0) === 0 ? (
            <DataState title="No deleted workspaces" description="Workspaces in organizations you own or administer will appear here for 30 days after deletion." />
          ) : null}

          {!deletedWorkspacesQuery.isPending && !deletedWorkspacesQuery.isError && (deletedWorkspacesQuery.data?.length ?? 0) > 0 ? (
            <Table columns={["Workspace", "Organization", "Deleted", "Deleted by", "Days remaining", "Actions"]}>
              {deletedWorkspacesQuery.data?.map((workspace) => (
                <tr key={workspace.workspaceId}>
                  <td>{workspace.workspaceName}</td>
                  <td>{workspace.organizationName}</td>
                  <td>{formatDeletedAt(workspace.deletedAt)}</td>
                  <td>{workspace.deletedByEmail ?? "—"}</td>
                  <td>{daysRemaining(workspace.purgeAt)} days remaining</td>
                  <td>
                    <button
                      className="ui-button ui-button-secondary"
                      type="button"
                      disabled={restoringId === workspace.workspaceId}
                      aria-label={`Restore ${workspace.workspaceName}`}
                      onClick={() => handleRestoreWorkspace(workspace)}
                    >
                      {restoringId === workspace.workspaceId ? "Restoring…" : "Restore"}
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </section>
      </section>
    </AppShell>
  );
}
