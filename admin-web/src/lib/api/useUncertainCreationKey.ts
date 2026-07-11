import { useCallback, useRef } from "react";
import { ApiError, newIdempotencyKey } from "./client";

function normalizedIntent(intent: unknown) {
  return JSON.stringify(intent, (_key, value) => typeof value === "string" ? value.trim().toLowerCase() : value);
}

export function useUncertainCreationKey() {
  const keys = useRef(new Map<string, string>());
  const keyFor = useCallback((intent: unknown) => {
    const key = normalizedIntent(intent);
    const existing = keys.current.get(key);
    if (existing) return existing;
    const next = newIdempotencyKey();
    keys.current.set(key, next);
    return next;
  }, []);
  const confirm = useCallback((intent: unknown) => keys.current.delete(normalizedIntent(intent)), []);
  const cancel = useCallback((intent?: unknown) => {
    if (intent === undefined) keys.current.clear(); else keys.current.delete(normalizedIntent(intent));
  }, []);
  const retainAfterFailure = useCallback((intent: unknown, error: unknown) => {
    if (error instanceof ApiError) keys.current.delete(normalizedIntent(intent));
  }, []);
  return { keyFor, confirm, cancel, retainAfterFailure };
}
