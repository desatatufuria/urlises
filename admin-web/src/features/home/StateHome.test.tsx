import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppRoute } from "../../test/renderRoute";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stateHomeFetchMock(extra: (url: string, method: string) => Response | undefined) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const extraResponse = extra(url, method);
    if (extraResponse) {
      return Promise.resolve(extraResponse);
    }
    if (/\/organizations\/[^/]+\/members$/.test(url) && method === "GET") return Promise.resolve(jsonResponse({ members: [] }));
    if (/\/organizations\/[^/]+\/invitations$/.test(url) && method === "GET") return Promise.resolve(jsonResponse({ invitations: [] }));
    if (/\/organizations\/[^/]+\/groups$/.test(url) && method === "GET") return Promise.resolve(jsonResponse({ groups: [] }));
    if (/\/organizations\/[^/]+\/workspaces$/.test(url) && method === "GET") return Promise.resolve(jsonResponse({ workspaces: [] }));
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  };
}

describe("state home danger zone", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("keeps the delete-organization action disabled until the organization name is typed exactly", async () => {
    fetchMock.mockImplementation(stateHomeFetchMock(() => undefined) as typeof fetch);

    renderAppRoute("/");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete organization/i }));
    const confirmButton = screen.getByRole("button", { name: "Delete organization" });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "not the name");
    expect(confirmButton).toBeDisabled();

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Acme");
    expect(confirmButton).toBeEnabled();
  });

  it("signs out after deleting the requester's last organization", async () => {
    let deleteCalls = 0;
    fetchMock.mockImplementation(
      stateHomeFetchMock((url, method) => {
        if (url.endsWith("/organizations/org-1") && method === "DELETE") {
          deleteCalls += 1;
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/organizations") && method === "GET") {
          return jsonResponse({ organizations: [] });
        }
        return undefined;
      }) as typeof fetch,
    );

    renderAppRoute("/");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete organization/i }));
    await user.type(screen.getByRole("textbox"), "Acme");
    await user.click(screen.getByRole("button", { name: "Delete organization" }));

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(deleteCalls).toBe(1);
  });

  it("navigates home without signing out when other organizations remain after deletion", async () => {
    fetchMock.mockImplementation(
      stateHomeFetchMock((url, method) => {
        if (url.endsWith("/organizations/org-1") && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/organizations") && method === "GET") {
          return jsonResponse({ organizations: [{ organizationId: "org-2", organizationName: "Second Org", role: "owner" }] });
        }
        return undefined;
      }) as typeof fetch,
    );

    renderAppRoute("/");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete organization/i }));
    await user.type(screen.getByRole("textbox"), "Acme");
    await user.click(screen.getByRole("button", { name: "Delete organization" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Second Org" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("surfaces a specific error when the orphan guard blocks deletion", async () => {
    fetchMock.mockImplementation(
      stateHomeFetchMock((url, method) => {
        if (url.endsWith("/organizations/org-1") && method === "DELETE") {
          return jsonResponse({ error: "deleting this organization would leave a member with no organization" }, 409);
        }
        return undefined;
      }) as typeof fetch,
    );

    renderAppRoute("/");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /delete organization/i }));
    await user.type(screen.getByRole("textbox"), "Acme");
    await user.click(screen.getByRole("button", { name: "Delete organization" }));

    expect(await screen.findByText(/can't be deleted because it would leave a member without any organization/i)).toBeInTheDocument();
  });
});
