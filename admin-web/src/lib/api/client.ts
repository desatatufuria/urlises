const CLIENT_ID_STORAGE_KEY = "admin-web/client-id";
const CLIENT_ID_HEADER = "X-Client-Id";

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
