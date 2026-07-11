import { screen } from "@testing-library/react";
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

    expect(await screen.findByText(/create new workspaces, review the current portfolio/i)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /admin sections/i })).toBeInTheDocument();
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
