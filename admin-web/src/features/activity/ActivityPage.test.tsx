import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("activity page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("shows a loading state while the first page is in flight", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    renderAppRoute("/activity");

    expect(await screen.findByText(/loading activity/i)).toBeInTheDocument();
  });

  it("renders an explicit empty state instead of an empty table or spinner", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/organizations/org-1/activity")) {
        return jsonResponse({ events: [], nextCursor: "" });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/activity");

    expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders an error state with a retry action when the feed fails to load", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/organizations/org-1/activity")) {
        return jsonResponse({ error: "internal server error" }, 500);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/activity");

    expect(await screen.findByText(/activity could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders a populated table with formatted event sentences and loads the next page on demand", async () => {
    const firstPage = {
      events: [
        {
          id: "event-1",
          organizationId: "org-1",
          actorUserId: "user-1",
          actorEmail: "owner@example.com",
          actorName: "Owner",
          kind: "organization.created",
          targetType: "organization",
          targetId: "org-1",
          metadata: { organizationName: "Acme" },
          createdAt: "2026-08-02T00:00:00Z",
        },
      ],
      nextCursor: "cursor-1",
    };
    const secondPage = {
      events: [
        {
          id: "event-2",
          organizationId: "org-1",
          actorUserId: "user-1",
          actorEmail: "owner@example.com",
          actorName: "Owner",
          kind: "group.created",
          targetType: "group",
          targetId: "group-1",
          metadata: { groupName: "Operators" },
          createdAt: "2026-08-01T00:00:00Z",
        },
      ],
      nextCursor: "",
    };

    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/organizations/org-1/activity")) {
        return url.includes("cursor=cursor-1") ? jsonResponse(secondPage) : jsonResponse(firstPage);
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderAppRoute("/activity");

    expect(await screen.findByText(/created the organization "acme"/i)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /when/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /actor/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /event/i })).toBeInTheDocument();
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);

    const loadMore = screen.getByRole("button", { name: /load more/i });
    await userEvent.click(loadMore);

    expect(await screen.findByText(/created the group "operators"/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument());
  });
});
