import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUncertainCreationKey } from "./useUncertainCreationKey";
import * as client from "./client";

describe("useUncertainCreationKey", () => {
  it("retains a key for normalized uncertain intent and clears it after confirmation, cancel, or changed intent", () => {
    vi.spyOn(client, "newIdempotencyKey").mockReturnValueOnce("key-1").mockReturnValueOnce("key-2").mockReturnValueOnce("key-3");
    const { result } = renderHook(() => useUncertainCreationKey());
    const intent = { name: "  Launch  " };
    expect(result.current.keyFor(intent)).toBe("key-1");
    expect(result.current.keyFor({ name: "launch" })).toBe("key-1");
    act(() => result.current.confirm(intent));
    expect(result.current.keyFor(intent)).toBe("key-2");
    act(() => result.current.cancel(intent));
    expect(result.current.keyFor({ name: "different" })).toBe("key-3");
  });
});
