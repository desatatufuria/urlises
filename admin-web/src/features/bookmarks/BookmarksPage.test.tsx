import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppRoute } from "../../test/renderRoute";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const treeFixture = {
  workspace: {
    workspaceId: "workspace-1",
    workspaceName: "Launch Room",
    workspaceType: "shared",
    organizationId: "org-1",
    organizationName: "Acme",
    role: "editor",
    sources: ["direct"],
  },
  folders: [
    {
      id: "folder-a",
      name: "Folder A",
      position: 0,
      folders: [
        {
          id: "folder-b",
          parentId: "folder-a",
          name: "Folder B",
          position: 0,
          folders: [],
          bookmarks: [{ id: "bookmark-c", folderId: "folder-b", title: "Bookmark C", url: "https://example.com/c", position: 0 }],
        },
      ],
      bookmarks: [{ id: "bookmark-d", folderId: "folder-a", title: "Bookmark D", url: "https://example.com/d", position: 0 }],
    },
    {
      id: "folder-e",
      name: "Folder E",
      position: 1,
      folders: [],
      bookmarks: [],
    },
  ],
};

describe("bookmarks page — read-only tree", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it("renders the full nested folder/bookmark tree from a mocked GET tree, in server order", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) return jsonResponse(treeFixture);
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");

    await screen.findByText("Folder A");
    expect(screen.getByText("Folder B")).toBeInTheDocument();
    expect(screen.getByText("Bookmark C")).toBeInTheDocument();
    expect(screen.getByText("Bookmark D")).toBeInTheDocument();
    expect(screen.getByText("Folder E")).toBeInTheDocument();

    const tree = screen.getByRole("list", { name: /bookmark tree for launch room/i });
    const labels = within(tree)
      .getAllByText(/^(Folder A|Folder B|Bookmark C|Bookmark D|Folder E)$/)
      .map((element) => element.textContent);
    expect(labels).toEqual(["Folder A", "Folder B", "Bookmark C", "Bookmark D", "Folder E"]);
  });

  it("shows a self-grant call to action when the tree request returns 403, never a generic error", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) return jsonResponse({ error: "forbidden" }, 403);
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");

    expect(await screen.findByText(/no access to this workspace/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /request access/i });
    expect(link).toHaveAttribute("href", "/access?workspace=workspace-1");
  });

  it("shows distinct copy for a 404, and never retries either terminal status", async () => {
    let treeCalls = 0;
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse({ error: "not found" }, 404);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");

    expect(await screen.findByText(/workspace not found/i)).toBeInTheDocument();
    expect(screen.queryByText(/no access to this workspace/i)).not.toBeInTheDocument();
    await waitFor(() => expect(treeCalls).toBe(1));
  });

  it("renders zero create/edit/delete/drag affordances when the workspace role is viewer", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        return jsonResponse({ ...treeFixture, workspace: { ...treeFixture.workspace, role: "viewer" } });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");

    await screen.findByText("Folder A");
    expect(screen.queryByRole("button", { name: /add folder|add bookmark|rename|^delete|new folder|import file/i })).not.toBeInTheDocument();
    expect(document.querySelector("[draggable='true']")).toBeNull();
    expect(screen.getByText("viewer")).toBeInTheDocument();
  });

  it("clicking manual Refresh refetches and advances the Updated HH:MM stamp", async () => {
    let treeCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy.mockReturnValue(new Date("2026-08-25T10:00:00Z").getTime());

    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeFixture);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");

    const firstStamp = new Date("2026-08-25T10:00:00Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(await screen.findByText(`Updated ${firstStamp}`)).toBeInTheDocument();

    dateNowSpy.mockReturnValue(new Date("2026-08-25T10:05:00Z").getTime());
    await userEvent.click(screen.getByRole("button", { name: /^refresh$/i }));

    const secondStamp = new Date("2026-08-25T10:05:00Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(await screen.findByText(`Updated ${secondStamp}`)).toBeInTheDocument();
    await waitFor(() => expect(treeCalls).toBe(2));
  });

  it("refetches the tree when the window regains focus (visibilitychange)", async () => {
    let treeCalls = 0;
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeFixture);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Folder A");
    await waitFor(() => expect(treeCalls).toBe(1));

    // React Query's refetchOnWindowFocus is driven by the "visibilitychange"
    // event in this library version (@tanstack/query-core's focusManager
    // registers only that listener, never a literal "focus" DOM event) —
    // verified against node_modules source, not assumed.
    window.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(treeCalls).toBe(2));
  });

  it("makes no client-side authorization decision — the 403 state comes only from the backend response", async () => {
    let treeCalls = 0;
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");

    expect(await screen.findByText(/no access to this workspace/i)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /bookmark tree/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Folder A")).not.toBeInTheDocument();
    await waitFor(() => expect(treeCalls).toBe(1));
  });
});

function headersOf(init: RequestInit | undefined) {
  return new Headers(init?.headers);
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
}

describe("bookmarks page — mutations and panels", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it("renames a folder with a deliberate X-Sync-Event-Id, and shows the new name after refetch", async () => {
    let treeCalls = 0;
    const patchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const renamedTree = {
      ...treeFixture,
      folders: treeFixture.folders.map((folder) => (folder.id === "folder-a" ? { ...folder, name: "Renamed Folder" } : folder)),
    };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeCalls === 1 ? treeFixture : renamedTree);
      }
      if (url.endsWith("/folders/folder-a") && init?.method === "PATCH") {
        patchCalls.push({ url, init });
        return jsonResponse({ id: "folder-a", workspaceId: "workspace-1", name: "Renamed Folder", position: 0, createdAt: "", updatedAt: "" });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Folder A");

    await userEvent.click(screen.getByRole("button", { name: /actions for folder a/i }));
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));

    const nameInput = await screen.findByLabelText(/folder name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Renamed Folder");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await screen.findByText("Renamed Folder");
    expect(patchCalls).toHaveLength(1);
    expect(headersOf(patchCalls[0].init).get("X-Sync-Event-Id")).toBeTruthy();
    expect(bodyOf(patchCalls[0].init)).toEqual({ name: "Renamed Folder" });
  });

  it("edits a bookmark's title and URL together in a single PATCH", async () => {
    // Two clear+type sequences on two fields is the heaviest interaction in
    // this file; under full-suite parallel execution the default 5s vitest
    // timeout is occasionally too tight for real (non-zero-delay) userEvent
    // timers, though this test runs in well under 1s in isolation.
    let treeCalls = 0;
    const patchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const editedTree = {
      ...treeFixture,
      folders: treeFixture.folders.map((folder) =>
        folder.id === "folder-a"
          ? { ...folder, folders: folder.folders.map((child) => ({ ...child, bookmarks: child.bookmarks.map((bookmark) => (bookmark.id === "bookmark-c" ? { ...bookmark, title: "New Title", url: "https://example.com/new" } : bookmark)) })) }
          : folder,
      ),
    };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeCalls === 1 ? treeFixture : editedTree);
      }
      if (url.endsWith("/bookmarks/bookmark-c") && init?.method === "PATCH") {
        patchCalls.push({ url, init });
        return jsonResponse({ id: "bookmark-c", workspaceId: "workspace-1", folderId: "folder-b", title: "New Title", url: "https://example.com/new", position: 0, createdAt: "", updatedAt: "" });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Bookmark C");

    await userEvent.click(screen.getByRole("button", { name: /actions for bookmark c/i }));
    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    const titleInput = await screen.findByLabelText(/bookmark title/i);
    const urlInput = screen.getByLabelText(/bookmark url/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "New Title");
    await userEvent.clear(urlInput);
    await userEvent.type(urlInput, "https://example.com/new");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await screen.findByText("New Title");
    expect(patchCalls).toHaveLength(1);
    expect(headersOf(patchCalls[0].init).get("X-Sync-Event-Id")).toBeTruthy();
    expect(bodyOf(patchCalls[0].init)).toEqual({ title: "New Title", url: "https://example.com/new" });
  }, 15000);

  it("folder delete opens ConfirmByTyping with the cascade/blast-radius copy, and cancelling sends no DELETE", async () => {
    const deleteCalls: string[] = [];

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        return jsonResponse(treeFixture);
      }
      if (url.endsWith("/folders/folder-a") && init?.method === "DELETE") {
        deleteCalls.push(url);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Folder A");

    await userEvent.click(screen.getByRole("button", { name: /actions for folder a/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/deleting folder a also deletes every folder and bookmark inside it/i)).toBeInTheDocument();
    expect(screen.getByText(/applies immediately to every browser synced to this workspace/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /close panel/i }));

    expect(screen.queryByText(/type "folder a" to confirm/i)).not.toBeInTheDocument();
    expect(deleteCalls).toHaveLength(0);
  });

  it("bookmark delete requires confirmation before any DELETE, and confirming removes only that bookmark", async () => {
    let treeCalls = 0;
    const deleteCalls: Array<{ url: string; init?: RequestInit }> = [];
    const afterDeleteTree = {
      ...treeFixture,
      folders: treeFixture.folders.map((folder) => (folder.id === "folder-a" ? { ...folder, bookmarks: [] } : folder)),
    };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeCalls === 1 ? treeFixture : afterDeleteTree);
      }
      if (url.endsWith("/bookmarks/bookmark-d") && init?.method === "DELETE") {
        deleteCalls.push({ url, init });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Bookmark D");

    await userEvent.click(screen.getByRole("button", { name: /actions for bookmark d/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(deleteCalls).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /^delete bookmark$/i }));

    await waitFor(() => expect(deleteCalls).toHaveLength(1));
    expect(headersOf(deleteCalls[0].init).get("X-Sync-Event-Id")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Bookmark D")).not.toBeInTheDocument());
    expect(screen.getByText("Bookmark C")).toBeInTheDocument();
  });

  it("creates a folder at the workspace root when no parent is selected", async () => {
    let treeCalls = 0;
    const postCalls: Array<{ url: string; init?: RequestInit }> = [];
    const withNewFolder = { ...treeFixture, folders: [...treeFixture.folders, { id: "folder-new", name: "New Root Folder", position: 2, folders: [], bookmarks: [] }] };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeCalls === 1 ? treeFixture : withNewFolder);
      }
      if (url.endsWith("/workspaces/workspace-1/folders") && init?.method === "POST") {
        postCalls.push({ url, init });
        return jsonResponse({ id: "folder-new", workspaceId: "workspace-1", name: "New Root Folder", position: 2, createdAt: "", updatedAt: "" }, 201);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Folder A");

    await userEvent.click(screen.getByRole("button", { name: /^new folder$/i }));
    const nameInput = await screen.findByLabelText(/folder name/i);
    await userEvent.type(nameInput, "New Root Folder");
    await userEvent.click(screen.getByRole("button", { name: /^create folder$/i }));

    await screen.findByText("New Root Folder");
    expect(postCalls).toHaveLength(1);
    expect(bodyOf(postCalls[0].init)).toEqual({ parentId: null, name: "New Root Folder" });
  });

  it("creates a folder nested inside another folder via its Add-folder-inside action", async () => {
    let treeCalls = 0;
    const postCalls: Array<{ url: string; init?: RequestInit }> = [];
    const withNestedFolder = {
      ...treeFixture,
      folders: treeFixture.folders.map((folder) => (folder.id === "folder-a" ? { ...folder, folders: [...folder.folders, { id: "folder-nested", parentId: "folder-a", name: "Nested Folder", position: 1, folders: [], bookmarks: [] }] } : folder)),
    };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeCalls === 1 ? treeFixture : withNestedFolder);
      }
      if (url.endsWith("/workspaces/workspace-1/folders") && init?.method === "POST") {
        postCalls.push({ url, init });
        return jsonResponse({ id: "folder-nested", workspaceId: "workspace-1", parentId: "folder-a", name: "Nested Folder", position: 1, createdAt: "", updatedAt: "" }, 201);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Folder A");

    await userEvent.click(screen.getByRole("button", { name: /actions for folder a/i }));
    await userEvent.click(screen.getByRole("button", { name: /^add folder inside$/i }));
    const nameInput = await screen.findByLabelText(/folder name/i);
    await userEvent.type(nameInput, "Nested Folder");
    await userEvent.click(screen.getByRole("button", { name: /^create folder$/i }));

    await screen.findByText("Nested Folder");
    expect(postCalls).toHaveLength(1);
    expect(bodyOf(postCalls[0].init)).toEqual({ parentId: "folder-a", name: "Nested Folder" });
  });

  it("creates a bookmark inside a folder via its Add-bookmark-inside action", async () => {
    let treeCalls = 0;
    const postCalls: Array<{ url: string; init?: RequestInit }> = [];
    const withNewBookmark = {
      ...treeFixture,
      folders: treeFixture.folders.map((folder) => (folder.id === "folder-a" ? { ...folder, bookmarks: [...folder.bookmarks, { id: "bookmark-new", folderId: "folder-a", title: "New Bookmark", url: "https://example.com/new-bookmark", position: 1 }] } : folder)),
    };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/workspaces/workspace-1/tree")) {
        treeCalls += 1;
        return jsonResponse(treeCalls === 1 ? treeFixture : withNewBookmark);
      }
      if (url.endsWith("/workspaces/workspace-1/bookmarks") && init?.method === "POST") {
        postCalls.push({ url, init });
        return jsonResponse({ id: "bookmark-new", workspaceId: "workspace-1", folderId: "folder-a", title: "New Bookmark", url: "https://example.com/new-bookmark", position: 1, createdAt: "", updatedAt: "" }, 201);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/bookmarks?workspace=workspace-1");
    await screen.findByText("Folder A");

    await userEvent.click(screen.getByRole("button", { name: /actions for folder a/i }));
    await userEvent.click(screen.getByRole("button", { name: /^add bookmark inside$/i }));
    const titleInput = await screen.findByLabelText(/bookmark title/i);
    const urlInput = screen.getByLabelText(/bookmark url/i);
    await userEvent.type(titleInput, "New Bookmark");
    await userEvent.type(urlInput, "https://example.com/new-bookmark");
    await userEvent.click(screen.getByRole("button", { name: /^create bookmark$/i }));

    await screen.findByText("New Bookmark");
    expect(postCalls).toHaveLength(1);
    expect(bodyOf(postCalls[0].init)).toEqual({ folderId: "folder-a", title: "New Bookmark", url: "https://example.com/new-bookmark" });
  });
});
