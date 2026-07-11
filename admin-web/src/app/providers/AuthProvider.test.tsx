import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
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
    void signIn({ email: "admin@example.com", password: "secret123" });
  }, [signIn]);

  return <div data-testid="status">{status}</div>;
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
