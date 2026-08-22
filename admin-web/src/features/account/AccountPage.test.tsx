import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppRoute } from "../../test/renderRoute";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function accountPageFetchMock(extra: (url: string, method: string) => Response | undefined) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const extraResponse = extra(url, method);
    if (extraResponse) {
      return Promise.resolve(extraResponse);
    }
    if (url.endsWith("/organizations") && method === "GET") return Promise.resolve(jsonResponse({ organizations: [] }));
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  };
}

describe("account page deactivation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("keeps the deactivate action disabled until the account email is typed exactly, and confirm-dismissal sends no request", async () => {
    let deactivateCalls = 0;
    fetchMock.mockImplementation(
      accountPageFetchMock((url, method) => {
        if (url.endsWith("/me/deactivate") && method === "POST") {
          deactivateCalls += 1;
          return new Response(null, { status: 204 });
        }
        return undefined;
      }) as typeof fetch,
    );

    renderAppRoute("/account");
    const user = userEvent.setup();

    const confirmButton = await screen.findByRole("button", { name: "Deactivate my account" });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "not-the-right-email");
    expect(confirmButton).toBeDisabled();
    expect(deactivateCalls).toBe(0);

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "owner@example.com");
    expect(confirmButton).toBeEnabled();
    expect(deactivateCalls).toBe(0);
  });

  it("signs out and redirects to /login on successful deactivation", async () => {
    fetchMock.mockImplementation(
      accountPageFetchMock((url, method) => {
        if (url.endsWith("/me/deactivate") && method === "POST") {
          return new Response(null, { status: 204 });
        }
        return undefined;
      }) as typeof fetch,
    );

    renderAppRoute("/account");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Deactivate my account" }));

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("surfaces a specific message when the sole-owner guard blocks deactivation", async () => {
    fetchMock.mockImplementation(
      accountPageFetchMock((url, method) => {
        if (url.endsWith("/me/deactivate") && method === "POST") {
          return jsonResponse({ error: "transfer ownership or leave the organization before deactivating" }, 409);
        }
        return undefined;
      }) as typeof fetch,
    );

    renderAppRoute("/account");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Deactivate my account" }));

    expect(
      await screen.findByText(/sole owner of at least one organization.*transfer ownership or leave it/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
  });
});
