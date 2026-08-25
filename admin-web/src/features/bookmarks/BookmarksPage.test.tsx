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
