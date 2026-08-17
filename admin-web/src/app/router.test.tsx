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

  it("onboards the first owner and organization, then closes first-run registration", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/setup/status")) return jsonResponse({ required: true });
      if (url.endsWith("/auth/register")) return jsonResponse({ accessToken: "setup-token", clientId: "setup-client", expiresAt: "2099-01-01T00:00:00Z", user: { id: "owner-1", email: "owner@example.com", name: "Owner" } }, 201);
      if (url.endsWith("/me")) return jsonResponse({ userId: "owner-1", email: "owner@example.com", name: "Owner", clientId: "setup-client" });
      if (url.endsWith("/organizations") && method === "GET") return jsonResponse({ organizations: [] });
      if (url.endsWith("/organizations") && method === "POST") return jsonResponse({ organizationId: "org-1", organizationName: "Acme", role: "owner" }, 201);
      if (url.includes("/organizations/org-1/")) return jsonResponse(url.endsWith("/members") ? { members: [] } : url.endsWith("/invitations") ? { invitations: [] } : url.endsWith("/groups") ? { groups: [] } : { workspaces: [] });
      return jsonResponse({ error: "not found" }, 404);
    });

    const user = userEvent.setup();
    const { router } = renderAppRoute("/", null);
    expect(await screen.findByRole("heading", { name: /create the first owner/i })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Owner");
    await user.type(screen.getByRole("textbox", { name: "Email" }), "owner@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /create owner account/i }));

    expect(await screen.findByRole("heading", { name: /create your organization/i })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /organization name/i }), "Acme");
    await user.click(screen.getByRole("button", { name: /^create organization$/i }));

    expect(await screen.findByRole("navigation", { name: /admin sections/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    const organizationRequest = fetchMock.mock.calls.find(([input, request]) => String(input).endsWith("/organizations") && request?.method === "POST");
    expect(new Headers(organizationRequest?.[1]?.headers).get("Idempotency-Key")).toBeTruthy();
  });

  it("keeps first-run registration closed after an organization exists", async () => {
    fetchMock.mockImplementation((input) => String(input).endsWith("/setup/status") ? jsonResponse({ required: false }) : jsonResponse({ error: "not found" }, 404));
    const { router } = renderAppRoute("/register", null);
    expect(await screen.findByRole("heading", { name: /sign in to admin web/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
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
