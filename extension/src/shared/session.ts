import { ACCESS_TOKEN_STORAGE_KEY, DEFAULT_BACKEND_URL } from "./runtime.js";
import { getState, updateState } from "./storage.js";
import type { RenewableSession, SessionData } from "./types.js";

const PRIVATE_STORAGE_KEY = "sharedBookmarkSyncPrivate";
type PrivateSession = { refreshToken: string; pendingAttemptId?: string };
let refreshFlight: Promise<SessionData> | undefined;
let pauseHandler: (() => void) | undefined;
let sessionEpoch = 0;
let runtimeAccessToken = "";

export async function ensureClientId(): Promise<string> {
  const state = await getState();
  if (state.settings.clientId) {
    return state.settings.clientId;
  }

  const clientId = crypto.randomUUID();
  await updateState((current) => ({
    ...current,
    settings: {
      ...current.settings,
      clientId,
    },
  }));
  return clientId;
}

export async function setBackendUrl(backendUrl: string): Promise<void> {
  const normalized = backendUrl.trim() || DEFAULT_BACKEND_URL;
  await updateState((state) => ({
    ...state,
    settings: {
      ...state.settings,
      backendUrl: normalized,
    },
  }));
}

export async function saveSession(session: RenewableSession): Promise<void> {
  sessionEpoch += 1;
  const { refreshToken, ...access } = session;
  await privateSet({ refreshToken });
  runtimeAccessToken = access.accessToken;
  await accessTokenSet(runtimeAccessToken);
  await updateState((state) => ({
    ...state,
    session: { ...access, accessToken: "" },
    authState: "authenticated",
    settings: {
      ...state.settings,
      clientId: access.clientId,
    },
  }));
}

export async function clearSession(): Promise<void> {
  sessionEpoch += 1;
  runtimeAccessToken = "";
  await Promise.all([privateRemove(), accessTokenRemove()]);
  await updateState((state) => ({ ...state, session: null }));
}

export async function bestEffortLogout(backendUrl: string, clientId: string): Promise<void> {
  const privateSession = await privateGet();
  if (privateSession?.refreshToken) await fetch(`${backendUrl.replace(/\/$/, "")}/auth/logout`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Client-Id": clientId },
    body: JSON.stringify({ refreshToken: privateSession.refreshToken }),
  }).catch(() => undefined);
}

export async function restoreSession(): Promise<void> {
  runtimeAccessToken = (await accessTokenGet()) ?? "";
  const state = await getState();
  const privateSession = await privateGet();
  if (privateSession?.refreshToken && !runtimeAccessToken) await refreshSession(state.settings.backendUrl);
  else if (state.session && !privateSession?.refreshToken) await pauseForLogin();
}

export function setSessionPauseHandler(handler: () => void): void { pauseHandler = handler; }
export function getRuntimeAccessToken(): string { return runtimeAccessToken; }
export function withRuntimeAccessToken(session: SessionData): SessionData { return { ...session, accessToken: runtimeAccessToken }; }

export function refreshSession(backendUrl: string): Promise<SessionData> {
  refreshFlight ??= refresh(backendUrl).finally(() => { refreshFlight = undefined; });
  return refreshFlight;
}

async function refresh(backendUrl: string): Promise<SessionData> {
  const epoch = sessionEpoch;
  const privateSession = await privateGet();
  if (!privateSession?.refreshToken) return pauseAndThrow(401);
  const attemptId = privateSession.pendingAttemptId ?? crypto.randomUUID();
  if (!privateSession.pendingAttemptId) await privateSet({ ...privateSession, pendingAttemptId: attemptId });
  let response: Response;
  try {
    response = await fetch(`${backendUrl.replace(/\/$/, "")}/auth/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Client-Id": (await getState()).settings.clientId },
      body: JSON.stringify({ refreshToken: privateSession.refreshToken, attemptId }),
    });
  } catch { throw new RefreshError("Refresh unavailable", 503); }
  if (response.status === 401) return pauseAndThrow(401);
  if (!response.ok) throw new RefreshError("Refresh unavailable", response.status);
  const next = await response.json() as RenewableSession;
  if (epoch !== sessionEpoch) throw new RefreshError("Session changed", 401);
  await privateSet({ refreshToken: next.refreshToken });
  const { refreshToken: _secret, ...access } = next;
  runtimeAccessToken = access.accessToken;
  await accessTokenSet(runtimeAccessToken);
  const redacted = { ...access, accessToken: "" };
  await updateState((state) => ({ ...state, session: redacted, authState: "authenticated" }));
  return redacted;
}

async function pauseForLogin(): Promise<void> {
  runtimeAccessToken = "";
  await Promise.all([privateRemove(), accessTokenRemove()]);
  await updateState((state) => ({ ...state, session: null, authState: "loginRequired" }));
  pauseHandler?.();
}

async function pauseAndThrow(status: number): Promise<never> {
  await pauseForLogin();
  throw new RefreshError("Login required", status);
}
export class RefreshError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function privateGet(): Promise<PrivateSession | undefined> { return credentialStorage("local", PRIVATE_STORAGE_KEY, "get"); }
function privateSet(value: PrivateSession): Promise<void> { return credentialStorage("local", PRIVATE_STORAGE_KEY, "set", value) as Promise<void>; }
function privateRemove(): Promise<void> { return credentialStorage("local", PRIVATE_STORAGE_KEY, "remove") as Promise<void>; }
function accessTokenGet(): Promise<string | undefined> { return credentialStorage("session", ACCESS_TOKEN_STORAGE_KEY, "get"); }
function accessTokenSet(value: string): Promise<void> { return credentialStorage("session", ACCESS_TOKEN_STORAGE_KEY, "set", value) as Promise<void>; }
function accessTokenRemove(): Promise<void> { return credentialStorage("session", ACCESS_TOKEN_STORAGE_KEY, "remove") as Promise<void>; }
function credentialStorage<T>(area: "local" | "session", key: string, action: "get" | "set" | "remove", value?: T): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const callback = (items?: Record<string, unknown>) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(action === "get" ? items?.[key] as T | undefined : undefined);
    };
    const storage = chrome.storage[area] as unknown as {
      get(key: string, done: (items: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, done: () => void): void;
      remove(key: string, done: () => void): void;
    };
    if (action === "set") storage.set({ [key]: value }, callback);
    else if (action === "remove") storage.remove(key, callback);
    else storage.get(key, callback);
  });
}
export const sessionTestHooks = { reset: () => { refreshFlight = undefined; pauseHandler = undefined; sessionEpoch = 0; runtimeAccessToken = ""; } };
