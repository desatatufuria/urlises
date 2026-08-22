import { screen } from "@testing-library/react";
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
    expect(link).toHaveAttribute("href", "/access?panel=access&workspace=workspace-1");

    expect(screen.getByText("direct")).toBeInTheDocument();
    expect(screen.getByText("group:Operators")).toBeInTheDocument();
  });
});
