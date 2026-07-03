import { DEFAULT_BACKEND_URL } from "./runtime.js";
import { getState, updateState } from "./storage.js";
import type { SessionData } from "./types.js";

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

export async function saveSession(session: SessionData): Promise<void> {
  await updateState((state) => ({
    ...state,
    session,
    settings: {
      ...state.settings,
      clientId: session.clientId,
    },
  }));
}

export async function clearSession(): Promise<void> {
  await updateState((state) => ({ ...state, session: null }));
}
