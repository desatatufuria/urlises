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

describe("groups page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("shows a calm empty state when no groups exist yet", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/groups")) {
        return jsonResponse({ groups: [] });
      }
      if (url.endsWith("/organizations/org-1/members")) {
        return jsonResponse({ members: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/groups");

    expect(await screen.findByText(/no groups yet/i)).toBeInTheDocument();
  });

  it("adds and removes group members from the selected panel", async () => {
    const groupMembers = [{ groupId: "group-1", userId: "user-1", email: "owner@example.com", name: "Owner" }];

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/org-1/groups") && method === "GET") {
        return jsonResponse({
          groups: [{ id: "group-1", organizationId: "org-1", name: "Operators", createdAt: "2026-07-03T22:00:00Z" }],
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

      if (url.endsWith("/groups/group-1/members") && method === "GET") {
        return jsonResponse({ members: groupMembers });
      }

      if (url.endsWith("/groups/group-1/members") && method === "POST") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { userId: string };
        groupMembers.push({ groupId: "group-1", userId: payload.userId, email: "editor@example.com", name: "Editor" });
        return jsonResponse(groupMembers[groupMembers.length - 1], 201);
      }

      if (url.endsWith("/groups/group-1/members/user-2") && method === "DELETE") {
        groupMembers.splice(
          groupMembers.findIndex((member) => member.userId === "user-2"),
          1,
        );
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/groups");

    expect(await screen.findByText(/operators/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add member/i }));
    expect(await screen.findByText(/member added/i)).toBeInTheDocument();
    expect((await screen.findAllByText(/editor@example.com/i)).length).toBeGreaterThan(0);

    const removeButtons = await screen.findAllByRole("button", { name: /remove/i });
    await userEvent.click(removeButtons[1]);
    expect(await screen.findByText(/member removed/i)).toBeInTheDocument();
  });

  it("creates, renames, deletes, and reports group mutation failures", async () => {
    const groups = [{ id: "group-1", organizationId: "org-1", name: "Operators" }];
    vi.stubGlobal("confirm", vi.fn(() => true));
    fetchMock.mockImplementation((input, init) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [] });
      if (url.endsWith("/organizations/org-1/groups") && method === "GET") return jsonResponse({ groups });
      if (url.endsWith("/organizations/org-1/groups") && method === "POST") { groups.push({ id: "group-2", organizationId: "org-1", name: "Created" }); return jsonResponse(groups[1], 201); }
      if (url.endsWith("/organizations/org-1/groups/group-1") && method === "PATCH") { groups[0].name = "Renamed"; return jsonResponse(groups[0]); }
      if (url.endsWith("/organizations/org-1/groups/group-1") && method === "DELETE") { groups.splice(0, 1); return Promise.resolve(new Response(null, { status: 204 })); }
      if (url.endsWith("/groups/group-1/members") && method === "GET") return jsonResponse({ members: [] });
      return jsonResponse({ error: "not found" }, 404);
    });
    renderAppRoute("/groups");
    await userEvent.type(await screen.findByLabelText(/new group name/i), "Created");
    await userEvent.click(screen.getByRole("button", { name: /create group/i }));
    expect(await screen.findByText(/group created/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /operators/i }));
    await userEvent.clear(screen.getByLabelText(/^group name$/i));
    await userEvent.type(screen.getByLabelText(/^group name$/i), "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /save name/i }));
    expect(await screen.findByText(/group updated/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /delete group/i }));
    expect(await screen.findByText(/group deleted/i)).toBeInTheDocument();
  });

  it.each(["create", "rename", "delete"])("preserves the current group state when %s fails", async (operation) => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    fetchMock.mockImplementation((input, init) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [] });
      if (url.endsWith("/organizations/org-1/groups") && method === "GET") return jsonResponse({ groups: [{ id: "group-1", organizationId: "org-1", name: "Operators" }] });
      if (url.endsWith("/groups/group-1/members") && method === "GET") return jsonResponse({ members: [] });
      if ((operation === "create" && method === "POST") || (operation === "rename" && method === "PATCH") || (operation === "delete" && method === "DELETE")) return jsonResponse({ error: "write failed" }, 500);
      return jsonResponse({ error: "not found" }, 404);
    });
    renderAppRoute("/groups");
    expect(await screen.findByText("Operators")).toBeInTheDocument();
    if (operation === "create") {
      await userEvent.type(screen.getByLabelText(/new group name/i), "Unavailable");
      await userEvent.click(screen.getByRole("button", { name: /create group/i }));
      expect(await screen.findByText(/group creation failed/i)).toBeInTheDocument();
    } else if (operation === "rename") {
      await userEvent.clear(await screen.findByLabelText(/^group name$/i));
      await userEvent.type(screen.getByLabelText(/^group name$/i), "Unavailable");
      await userEvent.click(screen.getByRole("button", { name: /save name/i }));
      expect(await screen.findByText(/group update failed/i)).toBeInTheDocument();
    } else {
      await userEvent.click(await screen.findByRole("button", { name: /delete group/i }));
      expect(await screen.findByText(/group deletion failed/i)).toBeInTheDocument();
    }
    expect(screen.getByText("Operators")).toBeInTheDocument();
  });
});
