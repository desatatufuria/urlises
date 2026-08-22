import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, type AuthSnapshot } from "../../app/providers/AuthProvider";
import { OrganizationProvider } from "../../app/providers/OrganizationProvider";
import { TrashPage } from "./TrashPage";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const snapshot: AuthSnapshot = {
  session: {
    accessToken: "token",
    clientId: "client-1",
    expiresAt: "2099-01-01T00:00:00Z",
    user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  },
  principal: { userId: "user-1", email: "owner@example.com", name: "Owner", clientId: "client-1" },
  organizations: [],
};

function renderTrashPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider initialSnapshot={snapshot}>
        <OrganizationProvider>
          <MemoryRouter>
            <TrashPage />
          </MemoryRouter>
        </OrganizationProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("TrashPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("renders both the deleted organizations and deleted workspaces lists", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/deleted")) {
        return jsonResponse({
          organizations: [
            {
              organizationId: "org-9",
              organizationName: "Old Co",
              role: "owner",
              deletedAt: "2026-08-01T00:00:00Z",
              deletedByEmail: "admin@example.com",
              purgeAt: "2026-08-31T00:00:00Z",
            },
          ],
        });
      }
      if (url.endsWith("/workspaces/deleted")) {
        return jsonResponse({
          workspaces: [
            {
              workspaceId: "workspace-9",
              workspaceName: "Old Workspace",
              workspaceType: "shared",
              organizationId: "org-1",
              organizationName: "Acme",
              deletedAt: "2026-08-05T00:00:00Z",
              deletedByEmail: "admin@example.com",
              purgeAt: "2026-09-04T00:00:00Z",
            },
          ],
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderTrashPage();

    expect(await screen.findByText("Old Co")).toBeInTheDocument();
    expect(await screen.findByText("Old Workspace")).toBeInTheDocument();
  });

  it("derives days remaining from purgeAt", async () => {
    const purgeAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/deleted")) {
        return jsonResponse({
          organizations: [
            {
              organizationId: "org-9",
              organizationName: "Old Co",
              role: "owner",
              deletedAt: "2026-08-01T00:00:00Z",
              deletedByEmail: "admin@example.com",
              purgeAt,
            },
          ],
        });
      }
      if (url.endsWith("/workspaces/deleted")) {
        return jsonResponse({ workspaces: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderTrashPage();

    expect(await screen.findByText(/5 days? (left|remaining)/i)).toBeInTheDocument();
  });

  it("clamps days remaining so it never shows a negative number", async () => {
    const purgeAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/deleted")) {
        return jsonResponse({
          organizations: [
            {
              organizationId: "org-9",
              organizationName: "Old Co",
              role: "owner",
              deletedAt: "2026-07-01T00:00:00Z",
              deletedByEmail: "admin@example.com",
              purgeAt,
            },
          ],
        });
      }
      if (url.endsWith("/workspaces/deleted")) {
        return jsonResponse({ workspaces: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderTrashPage();

    expect(await screen.findByText(/0 days? (left|remaining)/i)).toBeInTheDocument();
    expect(screen.queryByText(/-\d+ days?/)).not.toBeInTheDocument();
  });

  it("degrades a missing deletedByEmail to a placeholder instead of crashing or showing undefined", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/organizations/deleted")) {
        return jsonResponse({
          organizations: [
            {
              organizationId: "org-9",
              organizationName: "Old Co",
              role: "owner",
              deletedAt: "2026-08-01T00:00:00Z",
              deletedByEmail: null,
              purgeAt: "2026-08-31T00:00:00Z",
            },
          ],
        });
      }
      if (url.endsWith("/workspaces/deleted")) {
        return jsonResponse({ workspaces: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderTrashPage();

    await screen.findByText("Old Co");
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("disables the Restore button for its own row while its mutation is pending", async () => {
    const restoreControl: { resolve: (() => void) | null } = { resolve: null };

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/deleted")) {
        return jsonResponse({
          organizations: [
            {
              organizationId: "org-9",
              organizationName: "Old Co",
              role: "owner",
              deletedAt: "2026-08-01T00:00:00Z",
              deletedByEmail: "admin@example.com",
              purgeAt: "2026-08-31T00:00:00Z",
            },
          ],
        });
      }
      if (url.endsWith("/workspaces/deleted")) {
        return jsonResponse({ workspaces: [] });
      }
      if (url.endsWith("/organizations/org-9/restore") && method === "POST") {
        return new Promise((resolve) => {
          restoreControl.resolve = () => resolve(new Response(null, { status: 204 }));
        });
      }
      if (url.endsWith("/organizations") && method === "GET") {
        return jsonResponse({ organizations: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderTrashPage();
    const user = userEvent.setup();

    const restoreButton = await screen.findByRole("button", { name: /restore old co/i });
    await user.click(restoreButton);

    expect(await screen.findByRole("button", { name: /restore old co/i })).toBeDisabled();

    restoreControl.resolve?.();
    await waitFor(() => expect(screen.getByRole("button", { name: /restore old co/i })).not.toBeDisabled());
  });

  it("triggers refreshOrganizations after a successful organization restore", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/organizations/deleted")) {
        return jsonResponse({
          organizations: [
            {
              organizationId: "org-9",
              organizationName: "Old Co",
              role: "owner",
              deletedAt: "2026-08-01T00:00:00Z",
              deletedByEmail: "admin@example.com",
              purgeAt: "2026-08-31T00:00:00Z",
            },
          ],
        });
      }
      if (url.endsWith("/workspaces/deleted")) {
        return jsonResponse({ workspaces: [] });
      }
      if (url.endsWith("/organizations/org-9/restore") && method === "POST") {
        return jsonResponse(undefined, 204);
      }
      if (url.endsWith("/organizations") && method === "GET") {
        return jsonResponse({ organizations: [{ organizationId: "org-9", organizationName: "Old Co", role: "owner" }] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderTrashPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /restore old co/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([requestInput, requestInit]) => String(requestInput).endsWith("/organizations") && (requestInit?.method ?? "GET") === "GET")).toBe(true),
    );
  });

  it("renders the shared admin nav so the Trash page is not a dead end", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: "not found" }, 404));

    renderTrashPage();

    expect(await screen.findByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "People" })).toBeInTheDocument();
  });
});
