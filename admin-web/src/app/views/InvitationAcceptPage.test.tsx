import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../providers/AuthProvider";
import { OrganizationProvider } from "../providers/OrganizationProvider";
import { appRoutes } from "../router";
import { defaultAdminSnapshot, renderAppRoute } from "../../test/renderRoute";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function renderStrictAppRoute(path: string, snapshot = defaultAdminSnapshot) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });

  const view = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProvider initialSnapshot={snapshot}>
          <OrganizationProvider initialOrganizationId={snapshot.organizations[0]?.organizationId}>
            <RouterProvider router={router} />
          </OrganizationProvider>
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );

  return { ...view, router };
}

describe("InvitationAcceptPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.localStorage.clear();
  });

  it("redirects an anonymous visitor to /login with the invitation and email preserved", async () => {
    fetchMock.mockImplementation((input) => (String(input).endsWith("/setup/status") ? jsonResponse({ required: false }) : jsonResponse({ error: "not found" }, 404)));

    const { router } = renderAppRoute("/invitations/abc123?email=invitee%40example.com", null);

    await screen.findByRole("heading", { name: /you're invited to join urlises/i });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe("?invitation=abc123&email=invitee%40example.com");
  });

  it("redirects a visitor needing first-owner setup to /register with the invitation and email preserved", async () => {
    fetchMock.mockImplementation((input) => (String(input).endsWith("/setup/status") ? jsonResponse({ required: true }) : jsonResponse({ error: "not found" }, 404)));

    const { router } = renderAppRoute("/invitations/abc123?email=invitee%40example.com", null);

    await screen.findByRole("heading", { name: /create your account/i });
    expect(router.state.location.pathname).toBe("/register");
    expect(router.state.location.search).toBe("?invitation=abc123&email=invitee%40example.com");
  });

  it("never turns a crafted invitation token into a redirect off the fixed local path (open-redirect threat matrix)", async () => {
    fetchMock.mockImplementation((input) => (String(input).endsWith("/setup/status") ? jsonResponse({ required: false }) : jsonResponse({ error: "not found" }, 404)));
    const maliciousToken = "https://evil.example.com/phish";

    const { router } = renderAppRoute(`/invitations/${encodeURIComponent(maliciousToken)}`, null);

    await screen.findByRole("heading", { name: /you're invited to join urlises/i });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe(`?invitation=${encodeURIComponent(maliciousToken)}`);
  });

  it("accepts the invitation for an authenticated visitor and shows the console link for an admin role", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/abc123/accept") && init?.method === "POST") {
        return jsonResponse({ organizationId: "org-2", organizationName: "New Org", role: "admin" }, 200);
      }
      if (url.endsWith("/organizations")) {
        return jsonResponse({ organizations: [...defaultAdminSnapshot.organizations, { organizationId: "org-2", organizationName: "New Org", role: "admin" }] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/invitations/abc123?email=owner%40example.com", defaultAdminSnapshot);

    expect(await screen.findByRole("heading", { name: /you joined new org as admin/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to the admin console/i })).toBeInTheDocument();
    const acceptCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/invitations/abc123/accept") && init?.method === "POST");
    expect(acceptCalls).toHaveLength(1);
  });

  it("does not offer a console link when the accepted role is member", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/abc123/accept") && init?.method === "POST") {
        return jsonResponse({ organizationId: "org-2", organizationName: "New Org", role: "member" }, 200);
      }
      if (url.endsWith("/organizations")) {
        return jsonResponse({ organizations: defaultAdminSnapshot.organizations });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/invitations/abc123?email=owner%40example.com", defaultAdminSnapshot);

    expect(await screen.findByRole("heading", { name: /you joined new org as member/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to the admin console/i })).not.toBeInTheDocument();
    expect(screen.getByText(/urlises browser extension/i)).toBeInTheDocument();
  });

  it("calls accept exactly once under React StrictMode's double-invoked effects", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/abc123/accept") && init?.method === "POST") {
        return jsonResponse({ organizationId: "org-2", organizationName: "New Org", role: "owner" }, 200);
      }
      if (url.endsWith("/organizations")) {
        return jsonResponse({ organizations: defaultAdminSnapshot.organizations });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderStrictAppRoute("/invitations/abc123?email=owner%40example.com");

    await screen.findByRole("heading", { name: /you joined new org as owner/i });
    const acceptCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/invitations/abc123/accept") && init?.method === "POST");
    expect(acceptCalls).toHaveLength(1);
  });

  it("shows an inline error and a sign-out action on an email mismatch", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/abc123/accept") && init?.method === "POST") {
        return jsonResponse({ error: "invitation email does not match authenticated user" }, 400);
      }
      if (url.endsWith("/setup/status")) return jsonResponse({ required: false });
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/invitations/abc123?email=invitee%40example.com", defaultAdminSnapshot);

    expect(await screen.findByText(/signed in with a different address/i)).toBeInTheDocument();
    expect(screen.getByText(/invitee@example\.com/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /you're invited to join urlises/i })).toBeInTheDocument());
  });

  it("shows an inline error when the invitation is no longer pending", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/abc123/accept") && init?.method === "POST") {
        return jsonResponse({ error: "invitation is not pending" }, 400);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/invitations/abc123", defaultAdminSnapshot);

    expect(await screen.findByText(/this invitation is no longer valid/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("shows an inline error when the invitation is not found", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/missing-token/accept") && init?.method === "POST") {
        return jsonResponse({ error: "not found" }, 404);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/invitations/missing-token", defaultAdminSnapshot);

    expect(await screen.findByText(/invitation not found/i)).toBeInTheDocument();
  });

  it("shows a generic error with a working retry action for any other failure", async () => {
    let attempts = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/invitations/abc123/accept") && init?.method === "POST") {
        attempts += 1;
        return attempts === 1 ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ organizationId: "org-2", organizationName: "New Org", role: "owner" }, 200);
      }
      if (url.endsWith("/organizations")) return jsonResponse({ organizations: defaultAdminSnapshot.organizations });
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/invitations/abc123", defaultAdminSnapshot);

    expect(await screen.findByText(/could not accept the invitation/i)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByRole("heading", { name: /you joined new org as owner/i })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("lets an invitee with no account reach registration, prefills and locks the invited email, and lands back on the accept flow after signup (critical invitee path)", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/setup/status")) return jsonResponse({ required: false });
      if (url.endsWith("/auth/register") && method === "POST") {
        return jsonResponse({ accessToken: "invitee-token", clientId: "invitee-client", expiresAt: "2099-01-01T00:00:00Z", user: { id: "invitee-1", email: "invitee@example.com", name: "Invitee" } }, 201);
      }
      if (url.endsWith("/me")) return jsonResponse({ userId: "invitee-1", email: "invitee@example.com", name: "Invitee", clientId: "invitee-client" });
      if (url.endsWith("/organizations")) return jsonResponse({ organizations: [] });
      if (url.endsWith("/invitations/abc123/accept") && method === "POST") {
        return jsonResponse({ organizationId: "org-1", organizationName: "Acme", role: "member" }, 200);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    const user = userEvent.setup();
    const { router } = renderAppRoute("/invitations/abc123?email=invitee%40example.com", null);

    expect(await screen.findByRole("heading", { name: /you're invited to join urlises/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    await user.click(screen.getByRole("link", { name: /create an account to accept this invitation/i }));

    expect(await screen.findByRole("heading", { name: /create your account to join this organization/i })).toBeInTheDocument();
    const emailInput = screen.getByLabelText(/^email/i) as HTMLInputElement;
    expect(emailInput).toHaveValue("invitee@example.com");
    expect(emailInput).toHaveAttribute("readonly");

    await user.type(screen.getByLabelText("Name"), "Invitee");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /create account and join/i }));

    expect(await screen.findByRole("heading", { name: /you joined acme as member/i })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/invitations/abc123");
  });
});
