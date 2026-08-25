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

describe("sync event id header", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sets X-Sync-Event-Id only when options.syncEventId is passed", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/workspaces/w-1/folders/f-1", { method: "PATCH", token: "token", body: { name: "Renamed" }, syncEventId: "sync-event-1" });
    await apiRequest("/workspaces/w-1/folders/f-2", { method: "GET", token: "token" });

    const [withSyncEvent, withoutSyncEvent] = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(withSyncEvent.get("X-Sync-Event-Id")).toBe("sync-event-1");
    expect(withoutSyncEvent.has("X-Sync-Event-Id")).toBe(false);
  });

  it("keeps X-Sync-Event-Id independent of Idempotency-Key — never conflated, both may be considered but only the passed one is set", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/organizations/org-1/groups", { method: "POST", token: "token", body: { name: "Operators" }, idempotencyKey: "idem-key-1" });
    await apiRequest("/workspaces/w-1/bookmarks/b-1", { method: "PATCH", token: "token", body: { title: "New title" }, syncEventId: "sync-event-2" });

    const [idempotentCall, syncEventCall] = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(idempotentCall.get("Idempotency-Key")).toBe("idem-key-1");
    expect(idempotentCall.has("X-Sync-Event-Id")).toBe(false);
    expect(syncEventCall.get("X-Sync-Event-Id")).toBe("sync-event-2");
    expect(syncEventCall.has("Idempotency-Key")).toBe(false);
  });
});
