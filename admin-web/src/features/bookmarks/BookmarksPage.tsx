import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../app/providers/AuthProvider";
import { ApiError } from "../../lib/api/client";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { BookmarkTree } from "./BookmarkTree";
import { useWorkspaceTree } from "./queries";

export function BookmarksPage() {
  const { session } = useAuth();
  const [searchParams] = useSearchParams();
  const workspaceId = searchParams.get("workspace");
  const token = session?.accessToken;

  // enabled: Boolean(token && workspaceId) inside useWorkspaceTree — safe to
  // call unconditionally before the workspaceId presence check below.
  const treeQuery = useWorkspaceTree(token, workspaceId ?? undefined);

  if (!token) {
    return <DataState tone="danger" title="Session missing" description="Sign in again before managing a workspace's bookmarks." />;
  }

  if (!workspaceId) {
    return (
      <section className="ui-section-stack">
        <DataState
          tone="danger"
          title="No workspace selected"
          description="Bookmarks are reached per-workspace from the Workspaces page. Open a workspace there and choose Bookmarks."
        />
        <div className="ui-actions-row">
          <Link className="ui-button ui-button-secondary" to="/workspaces">
            Go to Workspaces
          </Link>
        </div>
      </section>
    );
  }

  if (treeQuery.isPending) {
    return <DataState title="Loading bookmarks" description="Fetching this workspace's folder and bookmark tree." />;
  }

  if (treeQuery.isError) {
    const error = treeQuery.error;

    // 403 on GET /tree means exactly "no grant" (design.md Decision 12) —
    // admin-web makes no authorization decision of its own here, it only
    // relays what the backend already decided.
    if (error instanceof ApiError && error.status === 403) {
      return (
        <section className="ui-section-stack">
          <DataState
            tone="danger"
            title="No access to this workspace"
            description="You don't currently hold a grant on this workspace. Request editor or admin access to view and manage its bookmarks."
          />
          <div className="ui-actions-row">
            <Link className="ui-button ui-button-primary" to={`/access?workspace=${workspaceId}`}>
              Request access
            </Link>
          </div>
        </section>
      );
    }

    if (error instanceof ApiError && error.status === 404) {
      return (
        <section className="ui-section-stack">
          <DataState tone="danger" title="Workspace not found" description="This workspace does not exist or has been deleted." />
          <div className="ui-actions-row">
            <Link className="ui-button ui-button-secondary" to="/workspaces">
              Go to Workspaces
            </Link>
          </div>
        </section>
      );
    }

    return (
      <section className="ui-section-stack">
        <DataState tone="danger" title="Bookmarks could not be loaded" description={error instanceof Error ? error.message : "Request failed."} />
        <div className="ui-actions-row">
          <button className="ui-button ui-button-secondary" type="button" onClick={() => void treeQuery.refetch()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const tree = treeQuery.data;
  if (!tree) {
    return null;
  }

  // treeQuery.dataUpdatedAt, not local state — a second clock could disagree
  // with the cache after a focus refetch (design.md Decision 13).
  const updatedAt = treeQuery.dataUpdatedAt
    ? new Date(treeQuery.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <div className="ui-actions-spread">
          <div>
            <h1 className="ui-page-title">{tree.workspace.workspaceName}</h1>
            <p className="ui-copy">Bookmarks and folders for this workspace, read live from the backend.</p>
          </div>
          <div className="ui-actions-row">
            <Badge tone={tree.workspace.role === "admin" ? "accent" : "neutral"}>{tree.workspace.role}</Badge>
            {updatedAt ? <span className="ui-muted">{`Updated ${updatedAt}`}</span> : null}
            <button className="ui-button ui-button-secondary" type="button" onClick={() => void treeQuery.refetch()}>
              Refresh
            </button>
          </div>
        </div>
      </header>

      <BookmarkTree folders={tree.folders} workspaceName={tree.workspace.workspaceName} />
    </section>
  );
}
