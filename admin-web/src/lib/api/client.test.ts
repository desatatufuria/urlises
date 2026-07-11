import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, newIdempotencyKey } from "./client";

describe("creation idempotency keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses one explicit key for an uncertain retry and creates a new key for a new intent", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const retryKey = newIdempotencyKey();
    await apiRequest("/organizations/org-1/groups", { method: "POST", token: "token", body: { name: "Operators" }, idempotencyKey: retryKey });
    await apiRequest("/organizations/org-1/groups", { method: "POST", token: "token", body: { name: "Operators" }, idempotencyKey: retryKey });
    const newIntentKey = newIdempotencyKey();
    await apiRequest("/organizations/org-1/groups", { method: "POST", token: "token", body: { name: "New intent" }, idempotencyKey: newIntentKey });
    const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
    expect(keys).toEqual([retryKey, retryKey, newIntentKey]);
    expect(retryKey).not.toBe(newIntentKey);
  });
});
