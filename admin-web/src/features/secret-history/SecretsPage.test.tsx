import { screen } from "@testing-library/react";
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

describe("secrets page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("shows a loading state before the secret history resolves", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    renderAppRoute("/secrets");

    expect(await screen.findByText(/loading your secrets/i)).toBeInTheDocument();
  });

  it("shows a calm empty state when the caller has never created a secret", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/secrets")) {
        return jsonResponse([]);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/secrets");

    expect(await screen.findByText(/haven.t created any secrets yet/i)).toBeInTheDocument();
  });

  it("surfaces the real error message when the history request fails", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/secrets")) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/secrets");

    expect(await screen.findByText("Unauthorized")).toBeInTheDocument();
  });

  it("renders one row per secret with created/status/sent-to/read-at columns and never implies org-wide visibility", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/secrets")) {
        return jsonResponse([
          {
            id: "secret-1",
            createdAt: "2026-08-01T00:00:00Z",
            expiresAt: "2026-08-08T00:00:00Z",
            status: "pending",
            readAt: null,
            sentToEmail: null,
          },
          {
            id: "secret-2",
            createdAt: "2026-08-02T00:00:00Z",
            expiresAt: "2026-08-09T00:00:00Z",
            status: "read",
            readAt: "2026-08-03T00:00:00Z",
            sentToEmail: "friend@example.com",
          },
          {
            id: "secret-3",
            createdAt: "2026-07-01T00:00:00Z",
            expiresAt: "2026-07-08T00:00:00Z",
            status: "expired",
            readAt: null,
            sentToEmail: null,
          },
        ]);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/secrets");

    expect(await screen.findByText("pending")).toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
    expect(screen.getByText("friend@example.com")).toBeInTheDocument();

    const heading = screen.getByRole("heading", { name: /my secrets/i });
    expect(heading).toBeInTheDocument();

    const description = screen.getByText(/secrets you.ve created/i);
    expect(description.textContent).not.toMatch(/organization|team/i);
  });
});
