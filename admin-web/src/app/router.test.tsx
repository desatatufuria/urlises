import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "./providers/AuthProvider";
import { OrganizationProvider } from "./providers/OrganizationProvider";
import { AdminLayout } from "./shell/AdminLayout";
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

    expect(await screen.findByRole("heading", { name: /sign in to urlises control/i })).toBeInTheDocument();
  });

  it("resolves /invitations/:token as its own public route instead of the catch-all", async () => {
    fetchMock.mockImplementation((input) => (String(input).endsWith("/setup/status") ? jsonResponse({ required: false }) : jsonResponse({ error: "not found" }, 404)));

    const { router } = renderAppRoute("/invitations/abc123?email=invitee%40example.com", null);

    expect(await screen.findByRole("heading", { name: /you're invited to join urlises/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe("?invitation=abc123&email=invitee%40example.com");
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
    expect(await screen.findByRole("heading", { name: /sign in to urlises control/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("redirects a protected members visit after restoration fails without rendering protected content", async () => {
    window.localStorage.setItem("admin-web/session", JSON.stringify({ session: { accessToken: "expired", clientId: "client-1", expiresAt: "2099-01-01T00:00:00Z", user: { id: "user-1", email: "owner@example.com" } } }));
    fetchMock.mockImplementation(() => jsonResponse({ error: "unauthorized" }, 401));
    renderAppRoute("/members", null);
    expect(await screen.findByRole("heading", { name: /sign in to urlises control/i })).toBeInTheDocument();
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
    expect(screen.getByText("URLises")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active organization" })).toHaveDisplayValue("Acme");
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invitations" })).not.toBeInTheDocument();
  });

  it("offers organization creation only to eligible operators and protects its route", async () => {
    const user = userEvent.setup();
    const { router, unmount } = renderAppRoute("/", defaultAdminSnapshot);
    await user.click(await screen.findByRole("link", { name: /create organization/i }));
    expect(router.state.location.pathname).toBe("/organizations/new");
    expect(screen.getByRole("heading", { name: /create organization/i })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /cancel/i }));
    expect(router.state.location.pathname).toBe("/");
    expect(fetchMock.mock.calls.some(([input, request]) => String(input).endsWith("/organizations") && request?.method === "POST")).toBe(false);
    unmount();

    renderAppRoute("/organizations/new", { ...defaultAdminSnapshot, organizations: [{ organizationId: "org-1", organizationName: "Acme", role: "member" }] });
    expect(await screen.findByText(/organization admin access required/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /create organization/i })).not.toBeInTheDocument();
  });

  it("does not expose organization creation in a rendered member-only shell", () => {
    const memberSnapshot = {
      ...defaultAdminSnapshot,
      organizations: [{ organizationId: "org-1", organizationName: "Acme", role: "member" as const }],
    };

    render(
      <MemoryRouter>
        <AuthProvider initialSnapshot={memberSnapshot}>
          <OrganizationProvider initialOrganizationId="org-1">
            <AdminLayout />
          </OrganizationProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("navigation", { name: /admin sections/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /create organization/i })).not.toBeInTheDocument();
  });

  it("creates, selects, and replaces navigation to the new organization", async () => {
    const membership = { organizationId: "org-2", organizationName: "New org", role: "owner" };
    fetchMock.mockImplementation((input, init) => String(input).endsWith("/organizations") && init?.method === "POST" ? jsonResponse(membership, 201) : jsonResponse({ workspaces: [], members: [], invitations: [], groups: [] }));
    const user = userEvent.setup();
    const { router } = renderAppRoute("/organizations/new", defaultAdminSnapshot);
    const input = await screen.findByRole("textbox", { name: /organization name/i });
    expect(input).toHaveFocus();
    expect(input).toBeRequired();
    await user.type(input, "New org");
    await user.click(screen.getByRole("button", { name: /^create organization$/i }));
    expect(await screen.findByRole("navigation", { name: /admin sections/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(window.localStorage.getItem("admin-web/active-organization-id")).toBe("org-2");
    expect(JSON.parse(window.localStorage.getItem("admin-web/session") ?? "{}").organizations).toEqual([...defaultAdminSnapshot.organizations, membership]);
  });

  it("announces definite errors, retries uncertain failures with its key, and cancels without posting", async () => {
    let calls = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/organizations") && init?.method === "POST") {
        calls += 1;
        return calls === 1 ? jsonResponse({ error: "Name is required" }, 422) : calls === 2 ? Promise.reject(new TypeError("network")) : jsonResponse({ organizationId: "org-2", organizationName: "New org", role: "owner" }, 201);
      }
      return jsonResponse({ workspaces: [], members: [], invitations: [], groups: [] });
    });
    const user = userEvent.setup();
    const { router } = renderAppRoute("/organizations/new", defaultAdminSnapshot);
    await user.type(await screen.findByRole("textbox", { name: /organization name/i }), "New org");
    await user.click(screen.getByRole("button", { name: /^create organization$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Name is required");
    await user.click(screen.getByRole("button", { name: /^create organization$/i }));
    const definiteKey = new Headers(fetchMock.mock.calls[0][1]?.headers).get("Idempotency-Key");
    const uncertainKey = new Headers(fetchMock.mock.calls[1][1]?.headers).get("Idempotency-Key");
    expect(uncertainKey).not.toBe(definiteKey);
    await user.click(await screen.findByRole("button", { name: /retry creation/i }));
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Idempotency-Key")).toBe(uncertainKey);
    expect(calls).toBe(3);
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
