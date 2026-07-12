import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdminSnapshot, renderAppRoute } from "../test/renderRoute";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("admin router", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.localStorage.clear();
  });

  it("redirects anonymous users to login", async () => {
    renderAppRoute("/members", null);

    expect(await screen.findByRole("heading", { name: /sign in to admin web/i })).toBeInTheDocument();
  });

  it("redirects a protected members visit after restoration fails without rendering protected content", async () => {
    window.localStorage.setItem("admin-web/session", JSON.stringify({ session: { accessToken: "expired", clientId: "client-1", expiresAt: "2099-01-01T00:00:00Z", user: { id: "user-1", email: "owner@example.com" } } }));
    fetchMock.mockImplementation(() => jsonResponse({ error: "unauthorized" }, 401));
    renderAppRoute("/members", null);
    expect(await screen.findByRole("heading", { name: /sign in to admin web/i })).toBeInTheDocument();
    expect(screen.queryByText(/invite member/i)).not.toBeInTheDocument();
  });

  it("renders the admin shell for owner/admin memberships", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/workspaces")) {
        return jsonResponse({ workspaces: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/workspaces", defaultAdminSnapshot);

    expect((await screen.findAllByRole("heading", { name: /workspaces/i })).length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: /admin sections/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invitations" })).not.toBeInTheDocument();
  });

  it("renders the state home at the root with pending invitation attention", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/org-1/members")) return jsonResponse({ members: [{ userId: "user-1", email: "owner@example.com", role: "owner" }] });
      if (url.endsWith("/organizations/org-1/invitations")) return jsonResponse({ invitations: [{ id: "invite-1", organizationId: "org-1", email: "new@example.com", role: "member", status: "pending", invitedByUserId: "user-1", createdAt: "2026-07-01" }] });
      if (url.endsWith("/organizations/org-1/groups")) return jsonResponse({ groups: [] });
      if (url.endsWith("/organizations/org-1/workspaces")) return jsonResponse({ workspaces: [] });
      return jsonResponse({ error: "not found" }, 404);
    });
    const { router } = renderAppRoute("/", defaultAdminSnapshot);
    expect(await screen.findByText(/1 pending invitation/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "People" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /review people/i }));
    expect(router.state.location.pathname).toBe("/members");
    expect(router.state.location.search).toBe("?panel=invite");
    expect(await screen.findByRole("dialog", { name: /invite person/i })).toBeInTheDocument();
  });

  it("blocks authenticated non-admin users", async () => {
    renderAppRoute("/members", {
      session: {
        accessToken: "token",
        clientId: "client-1",
        expiresAt: "2099-01-01T00:00:00Z",
        user: { id: "user-1", email: "member@example.com" },
      },
      principal: { userId: "user-1", email: "member@example.com", clientId: "client-1" },
      organizations: [{ organizationId: "org-1", organizationName: "Acme", role: "member" }],
    });

    expect(await screen.findByText(/organization admin access required/i)).toBeInTheDocument();
  });
});
