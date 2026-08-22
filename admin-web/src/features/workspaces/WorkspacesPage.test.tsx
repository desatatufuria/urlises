import { screen, waitFor } from "@testing-library/react";
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

describe("workspaces page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("shows a calm empty state when no workspaces exist yet", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({ workspaces: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");

    expect(await screen.findByText(/no workspaces yet/i)).toBeInTheDocument();
  });

  it("creates a workspace and refreshes the list", async () => {
    const workspaces: Array<Record<string, unknown>> = [];

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/workspaces") && method === "GET") {
        return jsonResponse({ workspaces });
      }

      if (url.endsWith("/organizations/org-1/workspaces") && method === "POST") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { name: string; type: string };
        const workspace = {
          workspaceId: "workspace-1",
          workspaceName: payload.name,
          workspaceType: payload.type,
          organizationId: "org-1",
          organizationName: "Acme",
          role: "admin",
          sources: ["direct"],
        };
        workspaces.splice(0, workspaces.length, workspace);
        return jsonResponse(workspace, 201);
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");

    await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
    await screen.findByLabelText(/workspace name/i);

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Launch Room");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    expect(await screen.findByText(/workspace created/i)).toBeInTheDocument();
    expect((await screen.findAllByText(/launch room/i)).length).toBeGreaterThan(0);
  });

  it("links each workspace row to its access panel and renders grant sources as badges", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-1",
              workspaceName: "Launch Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct", "group:Operators"],
            },
          ],
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");

    const link = await screen.findByRole("link", { name: /manage access/i });
    expect(link).toHaveAttribute("href", "/access?workspace=workspace-1");

    expect(screen.getByText("direct")).toBeInTheDocument();
    expect(screen.getByText("group:Operators")).toBeInTheDocument();
  });

  it("opens the delete confirmation panel via URL search params and sends no request on open", async () => {
    let deleteCalls = 0;

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/workspaces") && method === "GET") {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-1",
              workspaceName: "Launch Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct"],
            },
          ],
        });
      }

      if (url.endsWith("/workspaces/workspace-1") && method === "DELETE") {
        deleteCalls += 1;
        return jsonResponse(undefined, 204);
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    const { router } = renderAppRoute("/workspaces");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete launch room/i }));

    expect(router.state.location.search).toBe("?panel=workspace-delete&workspace=workspace-1");
    expect(screen.getByText('Type "Launch Room" to confirm')).toBeInTheDocument();
    expect(deleteCalls).toBe(0);
  });

  it("keeps the confirm button disabled on partial, mismatched, or whitespace-only input", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-1",
              workspaceName: "Launch Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct"],
            },
          ],
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete launch room/i }));
    const confirmButton = screen.getByRole("button", { name: "Delete workspace" });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "Launch");
    expect(confirmButton).toBeDisabled();

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "launch room");
    expect(confirmButton).toBeDisabled();

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "   ");
    expect(confirmButton).toBeDisabled();
  });

  it("enables the confirm button on an exact name match and fires exactly one delete request", async () => {
    let deleteCalls = 0;

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/workspaces") && method === "GET") {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-1",
              workspaceName: "Launch Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct"],
            },
          ],
        });
      }

      if (url.endsWith("/workspaces/workspace-1") && method === "DELETE") {
        deleteCalls += 1;
        return jsonResponse(undefined, 204);
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete launch room/i }));
    await user.type(screen.getByRole("textbox"), "Launch Room");
    const confirmButton = screen.getByRole("button", { name: "Delete workspace" });
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);

    await waitFor(() => expect(deleteCalls).toBe(1));
    expect(await screen.findByText(/workspace deleted/i)).toBeInTheDocument();
  });

  it("resets the typed confirmation text when switching the selected workspace", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-1",
              workspaceName: "Launch Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct"],
            },
            {
              workspaceId: "workspace-2",
              workspaceName: "Backup Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct"],
            },
          ],
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete launch room/i }));
    await user.type(screen.getByRole("textbox"), "Launch Ro");
    expect(screen.getByRole("textbox")).toHaveValue("Launch Ro");

    await user.click(screen.getByRole("button", { name: /delete backup room/i }));

    expect(screen.getByText('Type "Backup Room" to confirm')).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("sends no delete request when the panel is closed without confirming", async () => {
    let deleteCalls = 0;

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/workspaces") && method === "GET") {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-1",
              workspaceName: "Launch Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct"],
            },
          ],
        });
      }

      if (url.endsWith("/workspaces/workspace-1") && method === "DELETE") {
        deleteCalls += 1;
        return jsonResponse(undefined, 204);
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete launch room/i }));
    await user.type(screen.getByRole("textbox"), "Launch");

    await user.click(screen.getByRole("button", { name: /close panel/i }));

    expect(deleteCalls).toBe(0);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Launch Room")).toBeInTheDocument();
  });

  it("shows the rejection notice and resets busy/panel state without removing the row on backend rejection", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/workspaces") && method === "GET") {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-1",
              workspaceName: "Launch Room",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              role: "admin",
              sources: ["direct"],
            },
          ],
        });
      }

      if (url.endsWith("/workspaces/workspace-1") && method === "DELETE") {
        return jsonResponse({ error: "forbidden" }, 403);
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete launch room/i }));
    await user.type(screen.getByRole("textbox"), "Launch Room");
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));

    expect(await screen.findByText(/workspace deletion (rejected|failed)/i)).toBeInTheDocument();
    expect(screen.getByText("Launch Room")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /delete launch room/i })).not.toBeDisabled());
  });
});
