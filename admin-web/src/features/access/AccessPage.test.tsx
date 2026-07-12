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

describe("access page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("shows the highest-role-wins access review with contributing sources", async () => {
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

      if (url.endsWith("/organizations/org-1/members")) {
        return jsonResponse({
          members: [
            { userId: "user-1", email: "owner@example.com", name: "Owner", role: "owner" },
            { userId: "user-2", email: "editor@example.com", name: "Editor", role: "member" },
          ],
        });
      }

      if (url.endsWith("/organizations/org-1/groups")) {
        return jsonResponse({ groups: [{ id: "group-1", organizationId: "org-1", name: "Operators" }] });
      }

      if (url.endsWith("/workspaces/workspace-1/access")) {
        return jsonResponse({
          workspace: {
            workspaceId: "workspace-1",
            workspaceName: "Launch Room",
            workspaceType: "shared",
            organizationId: "org-1",
            organizationName: "Acme",
            role: "admin",
          },
          userGrants: [{ userId: "user-2", email: "editor@example.com", role: "viewer" }],
          groupGrants: [{ groupId: "group-1", groupName: "Operators", role: "editor" }],
          effectiveAccess: [{ userId: "user-2", email: "editor@example.com", role: "editor", sources: ["direct", "group:Operators"] }],
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/access?panel=access&workspace=workspace-1");

    expect(await screen.findByText(/effective access review/i)).toBeInTheDocument();
    expect(screen.getAllByText(/launch room/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^editor$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/direct grant/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/group: operators/i)).toBeInTheDocument();
  });

  it("adds a new direct grant and refreshes the snapshot", async () => {
    const accessSnapshot = {
      workspace: {
        workspaceId: "workspace-1",
        workspaceName: "Launch Room",
        workspaceType: "shared",
        organizationId: "org-1",
        organizationName: "Acme",
        role: "admin",
      },
      userGrants: [] as Array<{ userId: string; email: string; role: string }>,
      groupGrants: [] as Array<{ groupId: string; groupName: string; role: string }>,
      effectiveAccess: [{ userId: "user-1", email: "owner@example.com", role: "admin", sources: ["direct"] }],
    };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

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

      if (url.endsWith("/organizations/org-1/members")) {
        return jsonResponse({
          members: [
            { userId: "user-1", email: "owner@example.com", name: "Owner", role: "owner" },
            { userId: "user-2", email: "editor@example.com", name: "Editor", role: "member" },
          ],
        });
      }

      if (url.endsWith("/organizations/org-1/groups")) {
        return jsonResponse({ groups: [] });
      }

      if (url.endsWith("/workspaces/workspace-1/access") && method === "GET") {
        return jsonResponse(accessSnapshot);
      }

      if (url.endsWith("/workspaces/workspace-1/users/user-2/access") && method === "PUT") {
        accessSnapshot.userGrants = [{ userId: "user-2", email: "editor@example.com", role: "editor" }];
        accessSnapshot.effectiveAccess = [
          { userId: "user-1", email: "owner@example.com", role: "admin", sources: ["direct"] },
          { userId: "user-2", email: "editor@example.com", role: "editor", sources: ["direct"] },
        ];
        return jsonResponse({ workspaceId: "workspace-1", userId: "user-2", role: "editor" });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/access?panel=access&workspace=workspace-1");

    expect(await screen.findByText(/creator-only access/i)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/^organization member$/i), "user-2");
    await userEvent.selectOptions(screen.getByLabelText(/^organization member role$/i), "editor");
    const saveGrantButtons = screen.getAllByRole("button", { name: /^save grant$/i });
    await userEvent.click(saveGrantButtons.find((button) => !button.hasAttribute("disabled"))!);

    expect(await screen.findByText(/direct grant saved/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("editor@example.com").length).toBeGreaterThan(0));
  });

  it("updates and revokes direct and group grants", async () => {
    const snapshot = {
      workspace: { workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" },
      userGrants: [{ userId: "user-2", email: "editor@example.com", role: "viewer" }],
      groupGrants: [{ groupId: "group-1", groupName: "Operators", role: "viewer" }],
      effectiveAccess: [],
    };
    fetchMock.mockImplementation((input, init) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/organizations/org-1/workspaces")) return jsonResponse({ workspaces: [{ workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" }] });
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [{ userId: "user-2", email: "editor@example.com", role: "member" }] });
      if (url.endsWith("/organizations/org-1/groups")) return jsonResponse({ groups: [{ id: "group-1", organizationId: "org-1", name: "Operators" }] });
      if (url.endsWith("/workspaces/workspace-1/access") && method === "GET") return jsonResponse(snapshot);
      if (url.includes("/workspaces/workspace-1/users/user-2/access") && method === "PUT") { snapshot.userGrants[0].role = "editor"; return jsonResponse({}); }
      if (url.includes("/workspaces/workspace-1/users/user-2/access") && method === "DELETE") { snapshot.userGrants.splice(0, 1); return Promise.resolve(new Response(null, { status: 204 })); }
      if (url.includes("/workspaces/workspace-1/groups/group-1/access") && method === "PUT") { snapshot.groupGrants[0].role = "admin"; return jsonResponse({}); }
      if (url.includes("/workspaces/workspace-1/groups/group-1/access") && method === "DELETE") { snapshot.groupGrants.splice(0, 1); return Promise.resolve(new Response(null, { status: 204 })); }
      return jsonResponse({ error: "not found" }, 404);
    });
    renderAppRoute("/access?panel=access&workspace=workspace-1");
    await userEvent.selectOptions(await screen.findByLabelText(/direct role for editor@example.com/i), "editor");
    expect(await screen.findByText(/direct grant updated/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/group role for operators/i), "admin");
    expect(await screen.findByText(/group grant updated/i)).toBeInTheDocument();
    const removes = screen.getAllByRole("button", { name: /^remove$/i });
    await userEvent.click(removes[0]);
    expect(await screen.findByText(/direct grant removed/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(await screen.findByText(/group grant removed/i)).toBeInTheDocument();
  });
});
