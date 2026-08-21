import { fireEvent, screen, waitFor } from "@testing-library/react";
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

describe("RegisterPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.localStorage.clear();
  });

  it("forwards the invitation URL param to POST /auth/register so a locked backend can validate it", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);

      if (url.endsWith("/setup/status")) {
        return jsonResponse({ required: false });
      }
      if (url.endsWith("/auth/register")) {
        return jsonResponse({
          accessToken: "token-invited",
          clientId: "client-invited",
          expiresAt: "2099-01-01T00:00:00Z",
          user: { id: "user-1", email: "invitee@example.com", name: "Invitee" },
        });
      }
      if (url.endsWith("/me")) {
        return jsonResponse({ userId: "user-1", email: "invitee@example.com", name: "Invitee", clientId: "client-invited" });
      }
      if (url.endsWith("/organizations")) {
        return jsonResponse({ organizations: [] });
      }

      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/register?invitation=invite-token-abc&email=invitee%40example.com", null);

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Invitee" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "correct horse battery staple" } });

    fireEvent.click(screen.getByRole("button", { name: /create account and join/i }));

    await waitFor(() => {
      const registerRequest = fetchMock.mock.calls.find(([reqInput]) => String(reqInput).endsWith("/auth/register"));
      expect(registerRequest).toBeDefined();
    });

    const registerRequest = fetchMock.mock.calls.find(([reqInput]) => String(reqInput).endsWith("/auth/register"));
    const body = JSON.parse(String(registerRequest?.[1]?.body));
    expect(body.invitationToken).toBe("invite-token-abc");
    expect(body.email).toBe("invitee@example.com");
  });
});
