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

    renderAppRoute("/access?workspace=workspace-1");

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

    renderAppRoute("/access?workspace=workspace-1");

    expect(await screen.findByText(/creator-only access/i)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/^organization member$/i), "user-2");
    await userEvent.selectOptions(screen.getByLabelText(/^organization member role$/i), "editor");
    await userEvent.click(screen.getByRole("button", { name: /^grant access$/i }));

    expect(await screen.findByText(/direct grant saved/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("editor@example.com").length).toBeGreaterThan(0));
  });

  it("adds a new group grant via the group toggle", async () => {
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
          members: [{ userId: "user-1", email: "owner@example.com", name: "Owner", role: "owner" }],
        });
      }

      if (url.endsWith("/organizations/org-1/groups")) {
        return jsonResponse({ groups: [{ id: "group-1", organizationId: "org-1", name: "Operators" }] });
      }

      if (url.endsWith("/workspaces/workspace-1/access") && method === "GET") {
        return jsonResponse(accessSnapshot);
      }

      if (url.endsWith("/workspaces/workspace-1/groups/group-1/access") && method === "PUT") {
        accessSnapshot.groupGrants = [{ groupId: "group-1", groupName: "Operators", role: "editor" }];
        accessSnapshot.effectiveAccess = [
          { userId: "user-1", email: "owner@example.com", role: "admin", sources: ["direct"] },
        ];
        return jsonResponse({ workspaceId: "workspace-1", groupId: "group-1", role: "editor" });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/access?workspace=workspace-1");

    expect(await screen.findByText(/creator-only access/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^group$/i }));
    expect(await screen.findByLabelText(/^group$/i)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/^group$/i), "group-1");
    await userEvent.selectOptions(screen.getByLabelText(/^group role$/i), "editor");
    await userEvent.click(screen.getByRole("button", { name: /^grant access$/i }));

    expect(await screen.findByText(/group grant saved/i)).toBeInTheDocument();
  });

  it("shows an empty state instead of a dropdown when nothing is left to grant", async () => {
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
          members: [{ userId: "user-2", email: "editor@example.com", name: "Editor", role: "member" }],
        });
      }

      if (url.endsWith("/organizations/org-1/groups")) {
        return jsonResponse({ groups: [] });
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
          groupGrants: [],
          effectiveAccess: [{ userId: "user-2", email: "editor@example.com", role: "viewer", sources: ["direct"] }],
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/access?workspace=workspace-1");

    expect(await screen.findByText(/everyone already has a direct grant/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^organization member$/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^grant access$/i })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /^group$/i }));
    expect(await screen.findByText(/every group already has a grant/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^group$/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^grant access$/i })).toBeDisabled();
  });

  it("updates and revokes direct and group grants after confirming", async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
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
    renderAppRoute("/access?workspace=workspace-1");
    await userEvent.click(await screen.findByRole("button", { name: /show raw grants/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/direct role for editor@example.com/i), "editor");
    expect(confirmSpy).toHaveBeenCalledWith("Change editor@example.com's access to Launch Room from viewer to editor?");
    expect(await screen.findByText(/direct grant updated/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/group role for operators/i), "admin");
    expect(confirmSpy).toHaveBeenCalledWith("Change Operators's access to Launch Room from viewer to admin?");
    expect(await screen.findByText(/group grant updated/i)).toBeInTheDocument();
    const removes = screen.getAllByRole("button", { name: /^remove$/i });
    await userEvent.click(removes[0]);
    expect(confirmSpy).toHaveBeenCalledWith("Remove editor@example.com's direct access to Launch Room?");
    expect(await screen.findByText(/direct grant removed/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(confirmSpy).toHaveBeenCalledWith("Remove Operators's group access to Launch Room?");
    expect(await screen.findByText(/group grant removed/i)).toBeInTheDocument();
  });

  it("cancels a role change or removal when the confirmation is dismissed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const snapshot = {
      workspace: { workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" },
      userGrants: [{ userId: "user-2", email: "editor@example.com", role: "viewer" }],
      groupGrants: [{ groupId: "group-1", groupName: "Operators", role: "viewer" }],
      effectiveAccess: [],
    };
    let putCalls = 0;
    let deleteCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/organizations/org-1/workspaces")) return jsonResponse({ workspaces: [{ workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" }] });
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [{ userId: "user-2", email: "editor@example.com", role: "member" }] });
      if (url.endsWith("/organizations/org-1/groups")) return jsonResponse({ groups: [{ id: "group-1", organizationId: "org-1", name: "Operators" }] });
      if (url.endsWith("/workspaces/workspace-1/access") && method === "GET") return jsonResponse(snapshot);
      if (url.includes("/workspaces/workspace-1/users/user-2/access") && method === "PUT") { putCalls += 1; return jsonResponse({}); }
      if (url.includes("/workspaces/workspace-1/users/user-2/access") && method === "DELETE") { deleteCalls += 1; return Promise.resolve(new Response(null, { status: 204 })); }
      return jsonResponse({ error: "not found" }, 404);
    });
    renderAppRoute("/access?workspace=workspace-1");
    await userEvent.click(await screen.findByRole("button", { name: /show raw grants/i }));
    const select = await screen.findByLabelText(/direct role for editor@example.com/i);
    await userEvent.selectOptions(select, "editor");
    expect(putCalls).toBe(0);
    await waitFor(() => expect(select).toHaveValue("viewer"));

    const removeButtons = screen.getAllByRole("button", { name: /^remove$/i });
    await userEvent.click(removeButtons[0]);
    expect(deleteCalls).toBe(0);
  });

  it("shows the effective access review first and keeps raw grant tables collapsed by default", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({ workspaces: [{ workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" }] });
      }
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [{ userId: "user-2", email: "editor@example.com", role: "member" }] });
      if (url.endsWith("/organizations/org-1/groups")) return jsonResponse({ groups: [{ id: "group-1", organizationId: "org-1", name: "Operators" }] });
      if (url.endsWith("/workspaces/workspace-1/access")) {
        return jsonResponse({
          workspace: { workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" },
          userGrants: [{ userId: "user-2", email: "editor@example.com", role: "viewer" }],
          groupGrants: [{ groupId: "group-1", groupName: "Operators", role: "viewer" }],
          effectiveAccess: [{ userId: "user-2", email: "editor@example.com", role: "viewer", sources: ["direct"] }],
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/access?workspace=workspace-1");

    await screen.findByText(/effective access review/i);
    expect(screen.queryByText(/direct user grants/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^group grants$/i)).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /show raw grants/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);

    expect(await screen.findByText(/direct user grants/i)).toBeInTheDocument();
    expect(screen.getByText(/^group grants$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hide raw grants/i })).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("button", { name: /hide raw grants/i }));
    expect(screen.queryByText(/direct user grants/i)).not.toBeInTheDocument();
  });

  it("shows a link back to Workspaces instead of a picker when no workspace query param is present", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({ workspaces: [{ workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" }] });
      }
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [] });
      if (url.endsWith("/organizations/org-1/groups")) return jsonResponse({ groups: [] });
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/access");

    expect(await screen.findByText(/no workspace selected/i)).toBeInTheDocument();
    expect(screen.queryByText(/workspace access targets/i)).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /go to workspaces/i });
    expect(link).toHaveAttribute("href", "/workspaces");
  });

  it("shows a link back to Workspaces when the workspace query param does not resolve to an accessible workspace", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({ workspaces: [{ workspaceId: "workspace-1", workspaceName: "Launch Room", workspaceType: "shared", organizationId: "org-1", organizationName: "Acme", role: "admin" }] });
      }
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [] });
      if (url.endsWith("/organizations/org-1/groups")) return jsonResponse({ groups: [] });
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/access?workspace=unknown-workspace");

    expect(await screen.findByText(/no workspace selected/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to workspaces/i })).toHaveAttribute("href", "/workspaces");
  });
});
