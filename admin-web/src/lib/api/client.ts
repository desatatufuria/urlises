const CLIENT_ID_STORAGE_KEY = "admin-web/client-id";
const CLIENT_ID_HEADER = "X-Client-Id";
const SYNC_EVENT_ID_HEADER = "X-Sync-Event-Id";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function resolveBaseUrl() {
  return (import.meta.env.VITE_API_BASE_URL?.trim() || "http://localhost:8081").replace(/\/$/, "");
}

function safeRandomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `client-${Math.random().toString(36).slice(2, 10)}`;
}

export function newIdempotencyKey() { return safeRandomId(); }

export function getStoredClientId() {
  if (typeof window === "undefined") {
    return safeRandomId();
  }

	let stored: string | null = null;
	try { stored = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY); } catch { return safeRandomId(); }
  if (stored) {
    return stored;
  }

  const next = safeRandomId();
	try { window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, next); } catch { /* storage is optional */ }
  return next;
}

// Mints a fresh device/client ID and persists it, replacing whatever was
// stored before. Used when a brand-new account registration is rejected
// because this browser's stored client ID is already bound to a different
// user (e.g. testing multiple accounts from the same browser) — a new
// account can never legitimately own an existing binding, so the stale ID
// must be swapped out rather than retried as-is.
export function regenerateStoredClientId() {
  const next = safeRandomId();
  setStoredClientId(next);
  return next;
}

export function setStoredClientId(clientId: string) {
  if (typeof window === "undefined") {
    return;
  }

  const normalized = clientId.trim();
  if (!normalized) {
    return;
  }

	try { window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, normalized); } catch { /* storage is optional */ }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  token?: string;
  clientId?: string;
  body?: unknown;
  idempotencyKey?: string;
  /** X-Sync-Event-Id — the ONLY idempotency header the bookmark/sync routes
   *  read (sync/headers.go:14). PATCH /folders|/bookmarks 400 without it;
   *  POST/DELETE silently mint a random one and lose retry protection.
   *  Deliberately distinct from idempotencyKey: never set both. */
  syncEventId?: string;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const clientId = options.clientId ?? (options.token ? getStoredClientId() : undefined);
  if (clientId) {
    headers.set(CLIENT_ID_HEADER, clientId);
  }

  const hasBody = options.body !== undefined;
	if (hasBody) {
		headers.set("Content-Type", "application/json");
	}
	if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
	if (options.syncEventId) headers.set(SYNC_EVENT_ID_HEADER, options.syncEventId);

  const response = await fetch(`${resolveBaseUrl()}${path}`, {
    ...options,
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json().catch(() => ({ error: response.statusText }))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(String(payload.error ?? payload.message ?? "Request failed"), response.status);
  }

  return payload as T;
}
