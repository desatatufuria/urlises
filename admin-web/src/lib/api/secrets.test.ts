import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { listMySecrets } from "./secrets";

describe("listMySecrets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the caller's own secret history with an authenticated GET and returns the parsed entries", async () => {
    const entries = [
      {
        id: "secret-1",
        createdAt: "2026-08-01T00:00:00Z",
        expiresAt: "2026-08-08T00:00:00Z",
        status: "pending",
        readAt: null,
        sentToEmail: null,
      },
    ];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(entries), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listMySecrets("token-1");

    expect(result).toEqual(entries);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/secrets");
    expect(String(url)).not.toContain("/secrets/");
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("propagates the backend error message when the request fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMySecrets("token-1")).rejects.toThrow("Unauthorized");
    await expect(listMySecrets("token-1")).rejects.toBeInstanceOf(ApiError);
  });
});
