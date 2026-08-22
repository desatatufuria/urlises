import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { listOrgActivity } from "./activity";

describe("listOrgActivity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests an organization's activity feed with an authenticated GET and no cursor param on the first page", async () => {
    const events = [
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
        createdAt: "2026-08-01T00:00:00Z",
      },
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ events, nextCursor: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listOrgActivity("org-1", "token-1");

    expect(result).toEqual({ events, nextCursor: "" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/organizations/org-1/activity");
    expect(String(url)).not.toContain("cursor=");
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("includes the cursor query param when provided", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ events: [], nextCursor: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await listOrgActivity("org-1", "token-1", "cursor-abc");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("cursor=cursor-abc");
  });

  it("omits the category query param entirely when category is \"all\" (rollback guarantee)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ events: [], nextCursor: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await listOrgActivity("org-1", "token-1", undefined, "all");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("category=");
  });

  it("includes the category query param when a non-default category is passed", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ events: [], nextCursor: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await listOrgActivity("org-1", "token-1", undefined, "bookmarks");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("category=bookmarks");
  });

  it("propagates the backend error message when the request fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listOrgActivity("org-1", "token-1")).rejects.toThrow("Forbidden");
    await expect(listOrgActivity("org-1", "token-1")).rejects.toBeInstanceOf(ApiError);
  });
});
