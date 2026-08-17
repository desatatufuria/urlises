import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";

const SESSION_STORAGE_KEY = "admin-web/session";
const CLIENT_ID_STORAGE_KEY = "admin-web/client-id";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function StatusProbe() {
  const { status } = useAuth();

  return <div data-testid="status">{status}</div>;
}

function SignInOnMount() {
  const { signIn, status } = useAuth();

  useEffect(() => {
    if (status === "anonymous") void signIn({ email: "admin@example.com", password: "secret123" });
  }, [signIn, status]);

  return <div data-testid="status">{status}</div>;
}

function CreateOrganizationProbe() {
  const { createOwnerOrganization, organizations } = useAuth();
  const created = useRef(false);

  useEffect(() => {
    if (!created.current) {
      created.current = true;
      void createOwnerOrganization("Ignored name", "create-key");
    }
  }, [createOwnerOrganization]);

  return <div data-testid="organizations">{JSON.stringify(organizations)}</div>;
}

describe("AuthProvider client id propagation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.localStorage.clear();
  });

  it("reuses the restored session client id for authenticated bootstrap requests", async () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        session: {
          accessToken: "token-restore",
          clientId: "client-restore",
          expiresAt: "2099-01-01T00:00:00Z",
          user: { id: "user-1", email: "admin@example.com" },
        },
        principal: null,
        organizations: [],
      }),
    );

    const authenticatedRequestClientIds: string[] = [];

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/me") || url.endsWith("/organizations")) {
        authenticatedRequestClientIds.push(new Headers(init?.headers).get("X-Client-Id") ?? "");
      }

      if (url.endsWith("/me")) {
        return jsonResponse({ userId: "user-1", email: "admin@example.com", clientId: "client-restore" });
      }

      if (url.endsWith("/organizations")) {
        return jsonResponse({ organizations: [] });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    render(
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    expect(authenticatedRequestClientIds).toEqual(["client-restore", "client-restore"]);
    expect(window.localStorage.getItem(CLIENT_ID_STORAGE_KEY)).toBe("client-restore");
  });

  it("stores the login session client id before authenticated follow-up requests", async () => {
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, "stale-client");

    const authenticatedRequestClientIds: string[] = [];

    fetchMock.mockImplementation((input, init) => {
      const url = String(input);

      if (url.endsWith("/auth/login")) {
        return jsonResponse({
          accessToken: "token-login",
          clientId: "server-client",
          expiresAt: "2099-01-01T00:00:00Z",
          user: { id: "user-1", email: "admin@example.com" },
        });
      }

      if (url.endsWith("/setup/status")) {
        return jsonResponse({ required: false });
      }

      if (url.endsWith("/me") || url.endsWith("/organizations")) {
        authenticatedRequestClientIds.push(new Headers(init?.headers).get("X-Client-Id") ?? "");
      }

      if (url.endsWith("/me")) {
        return jsonResponse({ userId: "user-1", email: "admin@example.com", clientId: "server-client" });
      }

      if (url.endsWith("/organizations")) {
        return jsonResponse({ organizations: [] });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    render(
      <AuthProvider>
        <SignInOnMount />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    expect(authenticatedRequestClientIds).toEqual(["server-client", "server-client"]);
    expect(window.localStorage.getItem(CLIENT_ID_STORAGE_KEY)).toBe("server-client");
    const loginRequest = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/auth/login"));
    expect(JSON.parse(String(loginRequest?.[1]?.body)).deviceName).toBe("URLises Control");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns and persists the exact created owner membership", async () => {
    const membership = { organizationId: "org-2", organizationName: "Server name", role: "owner" as const };
    fetchMock.mockImplementation((input) => String(input).endsWith("/organizations") ? jsonResponse(membership, 201) : jsonResponse({ error: "not found" }, 404));
    const snapshot = {
      session: { accessToken: "token", clientId: "client", expiresAt: "2099-01-01T00:00:00Z", user: { id: "user-1", email: "owner@example.com" } },
      principal: { userId: "user-1", email: "owner@example.com", clientId: "client" },
      organizations: [],
    };

    render(<AuthProvider initialSnapshot={snapshot}><CreateOrganizationProbe /></AuthProvider>);

    await waitFor(() => expect(screen.getByTestId("organizations")).toHaveTextContent(JSON.stringify([membership])));
    expect(JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "{}").organizations).toEqual([membership]);
  });

  it.each(["rejected me", "expired session", "partial bootstrap failure", "malformed snapshot"]) ("leaves restoration anonymous for %s", async (scenario) => {
    if (scenario === "malformed snapshot") {
      window.localStorage.setItem(SESSION_STORAGE_KEY, "{");
    } else {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ session: { accessToken: "expired", clientId: "client", expiresAt: "2000-01-01T00:00:00Z", user: { id: "user-1", email: "admin@example.com" } } }));
      fetchMock.mockImplementation((input) => {
        const url = String(input);
        if (scenario === "partial bootstrap failure" && url.endsWith("/me")) return jsonResponse({ userId: "user-1", email: "admin@example.com", clientId: "client" });
        return jsonResponse({ error: "unauthorized" }, 401);
      });
    }
    render(<AuthProvider><StatusProbe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });
});
