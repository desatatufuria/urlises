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

describe("LoginPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation((input) => (String(input).endsWith("/setup/status") ? jsonResponse({ required: false }) : jsonResponse({ error: "not found" }, 404)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.localStorage.clear();
  });

  it("promotes account creation over sign-in when arriving via an invitation", async () => {
    renderAppRoute("/login?invitation=abc123&email=invitee%40example.com", null);

    expect(await screen.findByRole("heading", { name: /you're invited to join urlises/i })).toBeInTheDocument();

    const createAccountLink = screen.getByRole("link", { name: /create an account to accept this invitation/i });
    expect(createAccountLink).toHaveClass("ui-button-primary");

    const signInButton = screen.getByRole("button", { name: /already have an account\? sign in/i });
    expect(signInButton).toHaveClass("ui-button-secondary");
  });

  it("keeps the plain sign-in form as the primary action outside of an invitation", async () => {
    renderAppRoute("/login", null);

    expect(await screen.findByRole("heading", { name: /sign in to urlises control/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /create an account to accept this invitation/i })).not.toBeInTheDocument();

    const signInButton = screen.getByRole("button", { name: "Sign in" });
    expect(signInButton).toHaveClass("ui-button-primary");
  });
});
