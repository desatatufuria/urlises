import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { defaultAdminSnapshot, renderAppRoute } from "../../test/renderRoute";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

describe("AdminShellContext", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(() => jsonResponse({ error: "not found" }, 404));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("marks the History nav trigger active when the route is /activity", async () => {
    renderAppRoute("/activity", defaultAdminSnapshot);

    expect(await screen.findByRole("button", { name: "History" })).toHaveClass("ui-nav__link--active");
  });

  it("marks the History nav trigger active when the route is /trash", async () => {
    renderAppRoute("/trash", defaultAdminSnapshot);

    expect(await screen.findByRole("button", { name: "History" })).toHaveClass("ui-nav__link--active");
  });

  it("does not mark the History nav trigger active on unrelated routes", async () => {
    renderAppRoute("/", defaultAdminSnapshot);

    expect(await screen.findByRole("button", { name: "History" })).not.toHaveClass("ui-nav__link--active");
  });

  it("opens the History submenu to reveal links to /activity and /trash, closing on click", async () => {
    const user = userEvent.setup();
    const { router } = renderAppRoute("/", defaultAdminSnapshot);

    await user.click(await screen.findByRole("button", { name: "History" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/activity");
    expect(within(menu).getByRole("link", { name: "Trash" })).toHaveAttribute("href", "/trash");

    await user.click(within(menu).getByRole("link", { name: "Trash" }));

    expect(router.state.location.pathname).toBe("/trash");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the Account menu when switching organizations but keeps it open when using the theme toggle", async () => {
    const snapshot = {
      ...defaultAdminSnapshot,
      organizations: [
        { organizationId: "org-1", organizationName: "Acme", role: "owner" as const },
        { organizationId: "org-2", organizationName: "Other Co", role: "owner" as const },
      ],
    };
    const user = userEvent.setup();
    renderAppRoute("/", snapshot);

    await user.click(await screen.findByRole("button", { name: /owner/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Active organization" }), "org-2");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
