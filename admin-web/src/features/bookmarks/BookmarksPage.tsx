import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../app/providers/AuthProvider";
import type { BookmarkNode, FolderNode } from "../../lib/api/bookmarks";
import { ApiError } from "../../lib/api/client";
import { Badge } from "../../lib/ui/components/Badge";
import { ConfirmByTyping } from "../../lib/ui/components/ConfirmByTyping";
import { ContextPanel } from "../../lib/ui/components/ContextPanel";
import { DataState } from "../../lib/ui/components/DataState";
import { BookmarkForm } from "./BookmarkForm";
import { BookmarkTree } from "./BookmarkTree";
import { FolderForm } from "./FolderForm";
import {
  useCreateBookmarkMutation,
  useCreateFolderMutation,
  useDeleteBookmarkMutation,
  useDeleteFolderMutation,
  useUpdateBookmarkMutation,
  useUpdateFolderMutation,
} from "./mutations";
import { useWorkspaceTree } from "./queries";
import type { TreeActions } from "./TreeRow";

function findFolder(folders: FolderNode[], id: string): FolderNode | null {
  for (const folder of folders) {
    if (folder.id === id) {
      return folder;
    }
    const found = findFolder(folder.folders, id);
    if (found) {
      return found;
    }
  }
  return null;
}

function findBookmark(folders: FolderNode[], id: string): BookmarkNode | null {
  for (const folder of folders) {
    const found = folder.bookmarks.find((bookmark) => bookmark.id === id);
    if (found) {
      return found;
    }
    const nested = findBookmark(folder.folders, id);
    if (nested) {
      return nested;
    }
  }
  return null;
}

type Notice = { tone: "neutral" | "danger"; title: string; description: string };

export function BookmarksPage() {
  const { session } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceId = searchParams.get("workspace");
  const token = session?.accessToken;
  const [notice, setNotice] = useState<Notice | null>(null);

  // enabled: Boolean(token && workspaceId) inside useWorkspaceTree — safe to
  // call unconditionally before the workspaceId presence check below.
  const treeQuery = useWorkspaceTree(token, workspaceId ?? undefined);

  const createFolderMutation = useCreateFolderMutation(token, workspaceId ?? undefined);
  const updateFolderMutation = useUpdateFolderMutation(token, workspaceId ?? undefined);
  const deleteFolderMutation = useDeleteFolderMutation(token, workspaceId ?? undefined);
  const createBookmarkMutation = useCreateBookmarkMutation(token, workspaceId ?? undefined);
  const updateBookmarkMutation = useUpdateBookmarkMutation(token, workspaceId ?? undefined);
  const deleteBookmarkMutation = useDeleteBookmarkMutation(token, workspaceId ?? undefined);

  const panel = searchParams.get("panel");
  const nodeId = searchParams.get("node");
  const parentId = searchParams.get("parent");

  // Always the updater form of setSearchParams — never the object form,
  // which replaces the whole query string and would drop ?workspace=,
  // unmounting the page mid-action (design.md).
  const closePanel = () =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("panel");
      next.delete("node");
      next.delete("parent");
      return next;
    });

  const openPanel = (next: { panel: string; node?: string; parent?: string }) =>
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("panel", next.panel);
      if (next.node) {
        params.set("node", next.node);
      } else {
        params.delete("node");
      }
      if (next.parent) {
        params.set("parent", next.parent);
      } else {
        params.delete("parent");
      }
      return params;
    });

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

  const readOnly = tree.workspace.role === "viewer";
  const folders = tree.folders;
  const editingFolder = nodeId && (panel === "folder-edit" || panel === "folder-delete") ? findFolder(folders, nodeId) : null;
  const editingBookmark = nodeId && (panel === "bookmark-edit" || panel === "bookmark-delete") ? findBookmark(folders, nodeId) : null;

  const actions: TreeActions = {
    readOnly,
    onAddFolder: (parent) => openPanel({ panel: "folder-create", parent }),
    onAddBookmark: (folderId) => openPanel({ panel: "bookmark-create", parent: folderId }),
    onRenameFolder: (folder) => openPanel({ panel: "folder-edit", node: folder.id }),
    onDeleteFolder: (folder) => openPanel({ panel: "folder-delete", node: folder.id }),
    onEditBookmark: (bookmark) => openPanel({ panel: "bookmark-edit", node: bookmark.id }),
    onDeleteBookmark: (bookmark) => openPanel({ panel: "bookmark-delete", node: bookmark.id }),
  };

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
            {!readOnly ? (
              <button className="ui-button ui-button-primary" type="button" onClick={() => openPanel({ panel: "folder-create" })}>
                New folder
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {notice ? <DataState compact tone={notice.tone} title={notice.title} description={notice.description} /> : null}

      <BookmarkTree folders={folders} workspaceName={tree.workspace.workspaceName} actions={actions} />

      {panel === "folder-create" ? (
        <ContextPanel title={parentId ? "Add folder inside" : "New folder"} onClose={closePanel}>
          <FolderForm
            submitting={createFolderMutation.isPending}
            submitLabel="Create folder"
            onSubmit={async ({ name }) => {
              setNotice(null);
              try {
                await createFolderMutation.mutateAsync({ parentId: parentId ?? null, name });
                setNotice({ tone: "neutral", title: "Folder created", description: `${name} was created.` });
                closePanel();
              } catch (error) {
                setNotice({ tone: "danger", title: "Folder creation failed", description: error instanceof Error ? error.message : "The folder could not be created." });
                throw error;
              }
            }}
          />
        </ContextPanel>
      ) : null}

      {panel === "bookmark-create" && parentId ? (
        <ContextPanel title="Add bookmark inside" onClose={closePanel}>
          <BookmarkForm
            submitting={createBookmarkMutation.isPending}
            submitLabel="Create bookmark"
            onSubmit={async ({ title, url }) => {
              setNotice(null);
              try {
                await createBookmarkMutation.mutateAsync({ folderId: parentId, title, url });
                setNotice({ tone: "neutral", title: "Bookmark created", description: `${title} was created.` });
                closePanel();
              } catch (error) {
                setNotice({ tone: "danger", title: "Bookmark creation failed", description: error instanceof Error ? error.message : "The bookmark could not be created." });
                throw error;
              }
            }}
          />
        </ContextPanel>
      ) : null}

      {panel === "folder-edit" && editingFolder ? (
        <ContextPanel key={editingFolder.id} title="Rename folder" onClose={closePanel}>
          <FolderForm
            initialName={editingFolder.name}
            submitting={updateFolderMutation.isPending}
            submitLabel="Save"
            onSubmit={async ({ name }) => {
              setNotice(null);
              try {
                await updateFolderMutation.mutateAsync({ folderId: editingFolder.id, input: { name } });
                setNotice({ tone: "neutral", title: "Folder renamed", description: `Renamed to ${name}.` });
                closePanel();
              } catch (error) {
                setNotice({ tone: "danger", title: "Rename failed", description: error instanceof Error ? error.message : "The folder could not be renamed." });
                throw error;
              }
            }}
          />
        </ContextPanel>
      ) : null}

      {panel === "bookmark-edit" && editingBookmark ? (
        <ContextPanel key={editingBookmark.id} title="Edit bookmark" onClose={closePanel}>
          <BookmarkForm
            initialTitle={editingBookmark.title}
            initialUrl={editingBookmark.url}
            submitting={updateBookmarkMutation.isPending}
            submitLabel="Save"
            onSubmit={async ({ title, url }) => {
              setNotice(null);
              try {
                await updateBookmarkMutation.mutateAsync({ bookmarkId: editingBookmark.id, input: { title, url } });
                setNotice({ tone: "neutral", title: "Bookmark updated", description: `${title} was updated.` });
                closePanel();
              } catch (error) {
                setNotice({ tone: "danger", title: "Update failed", description: error instanceof Error ? error.message : "The bookmark could not be updated." });
                throw error;
              }
            }}
          />
        </ContextPanel>
      ) : null}

      {panel === "folder-delete" && editingFolder ? (
        <ContextPanel key={editingFolder.id} title="Delete folder" onClose={closePanel}>
          <p className="ui-copy">
            {`Deleting ${editingFolder.name} also deletes every folder and bookmark inside it. This applies immediately to every browser synced to this workspace — there is no undo and no in-browser notice.`}
          </p>
          <ConfirmByTyping
            expected={editingFolder.name}
            confirmLabel="Delete folder"
            disabled={deleteFolderMutation.isPending}
            onConfirm={() => {
              setNotice(null);
              void deleteFolderMutation
                .mutateAsync(editingFolder.id)
                .then(() => {
                  setNotice({ tone: "neutral", title: "Folder deleted", description: `${editingFolder.name} and all of its contents have been removed.` });
                })
                .catch((error) => {
                  setNotice({ tone: "danger", title: "Folder deletion rejected", description: error instanceof Error ? error.message : "The backend rejected the deletion request." });
                })
                .finally(() => {
                  closePanel();
                });
            }}
          />
        </ContextPanel>
      ) : null}

      {panel === "bookmark-delete" && editingBookmark ? (
        <ContextPanel key={editingBookmark.id} title="Delete bookmark" onClose={closePanel}>
          <p className="ui-copy">{`This permanently deletes ${editingBookmark.title}. This cannot be undone.`}</p>
          <div className="ui-actions-row">
            <button
              className="ui-button ui-button-danger"
              type="button"
              disabled={deleteBookmarkMutation.isPending}
              onClick={() => {
                setNotice(null);
                void deleteBookmarkMutation
                  .mutateAsync(editingBookmark.id)
                  .then(() => {
                    setNotice({ tone: "neutral", title: "Bookmark deleted", description: `${editingBookmark.title} has been removed.` });
                  })
                  .catch((error) => {
                    setNotice({ tone: "danger", title: "Bookmark deletion rejected", description: error instanceof Error ? error.message : "The backend rejected the deletion request." });
                  })
                  .finally(() => {
                    closePanel();
                  });
              }}
            >
              Delete bookmark
            </button>
          </div>
        </ContextPanel>
      ) : null}
    </section>
  );
}
