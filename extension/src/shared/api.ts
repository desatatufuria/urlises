import {
  CLIENT_ID_HEADER,
  SYNC_BASE_CURSOR_HEADER,
  SYNC_CURSOR_HEADER,
  SYNC_DUPLICATE_HEADER,
  SYNC_EVENT_ID_HEADER,
} from "./runtime.js";
import { RefreshError, getRuntimeAccessToken, refreshSession } from "./session.js";
import type {
  BookmarkDeletePayload,
  BookmarkResource,
  FolderDeletePayload,
  FolderResource,
  LoginRequest,
  MutationAck,
  OrganizationMembership,
  Preferences,
  ReplayResult,
  SessionData,
  RenewableSession,
  TreeResponse,
  WorkspaceAccess,
} from "./types.js";

export interface WSTicket {
  ticket: string;
  expiresAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface JSONRequestInit extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export async function login(request: LoginRequest, clientId: string): Promise<RenewableSession> {
  return requestJSON<RenewableSession>(request.backendUrl, "/auth/login", {
    method: "POST",
    headers: {
      [CLIENT_ID_HEADER]: clientId,
      "X-Session-Capability": "renewable-v1",
    },
    body: {
      email: request.email,
      password: request.password,
      deviceName: request.deviceName,
    },
  });
}

export async function getOrganizations(backendUrl: string, session: SessionData): Promise<OrganizationMembership[]> {
  const response = await requestJSON<{ organizations: OrganizationMembership[] }>(backendUrl, "/organizations", {
    headers: authHeaders(session),
  });
  return response.organizations;
}

export async function getWorkspaces(
  backendUrl: string,
  session: SessionData,
  organizationId: string,
): Promise<WorkspaceAccess[]> {
  const response = await requestJSON<{ workspaces: WorkspaceAccess[] }>(backendUrl, `/organizations/${organizationId}/workspaces`, {
    headers: authHeaders(session),
  });
  return response.workspaces;
}

export async function getWorkspaceTree(backendUrl: string, session: SessionData, workspaceId: string): Promise<TreeResponse> {
  return requestJSON<TreeResponse>(backendUrl, `/workspaces/${workspaceId}/tree`, {
    headers: authHeaders(session),
  });
}

export async function replayEvents(backendUrl: string, session: SessionData, workspaceId: string, afterCursor: number): Promise<ReplayResult> {
  return requestJSON<ReplayResult>(backendUrl, `/sync/events?workspaceId=${encodeURIComponent(workspaceId)}&afterCursor=${afterCursor}`, {
    headers: authHeaders(session),
  });
}

export function createWSTicket(backendUrl: string, session: SessionData): Promise<WSTicket> {
  return requestJSON<WSTicket>(backendUrl, "/auth/ws-ticket", { method: "POST", headers: authHeaders(session) });
}

export interface CreateSecretInput {
  ciphertext: string;
  iv: string;
  wrappedContentKey?: string;
  passphraseSalt?: string;
  kdfIterations?: number;
  ttlSeconds?: number;
}

export interface CreatedSecret {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

// createSecret is a plain authenticated write, not a workspace mutation: it
// carries no baseCursor/eventId (mutationHeaders' Idempotency-Key precursor)
// because the backend deliberately skips IdempotencyExecutor for secrets —
// a duplicate secret is cheap and self-expiring. It follows createWSTicket's
// shape (authHeaders only) rather than createBookmark's (mutationHeaders),
// since there is no sync cursor to advance.
export function createSecret(backendUrl: string, session: SessionData, input: CreateSecretInput): Promise<CreatedSecret> {
  return requestJSON<CreatedSecret>(backendUrl, "/secrets", {
    method: "POST",
    headers: authHeaders(session),
    body: input,
  });
}

export interface PublicConfig {
  publicBaseUrl: string;
}

// getPublicConfig hits the backend's unauthenticated config-bootstrap route
// (GET /config/public) — no session/auth headers, matching the fact that
// this endpoint is public by design. It exposes only the one safe value
// (PublicBaseURL) needed to build correct share links, never a full config
// dump. See backend/internal/config/config.go's AppConfig.PublicBaseURL.
export function getPublicConfig(backendUrl: string): Promise<PublicConfig> {
  return requestJSON<PublicConfig>(backendUrl, "/config/public", {});
}

export function getPreferences(backendUrl: string, session: SessionData): Promise<Preferences> {
  return requestJSON<Preferences>(backendUrl, "/me/preferences", { headers: authHeaders(session) });
}

export function updatePreferences(backendUrl: string, session: SessionData, uiTheme: string): Promise<Preferences> {
  return requestJSON<Preferences>(backendUrl, "/me/preferences", {
    method: "PUT",
    headers: authHeaders(session),
    body: { uiTheme },
  });
}

export async function createFolder(
  backendUrl: string,
  session: SessionData,
  workspaceId: string,
  input: { parentId?: string | null; name: string; position?: number },
  baseCursor: number,
): Promise<{ resource: FolderResource; ack: MutationAck }> {
  const response = await requestRaw(backendUrl, `/workspaces/${workspaceId}/folders`, {
    method: "POST",
    headers: mutationHeaders(session, baseCursor),
    body: {
      parentId: input.parentId ?? null,
      name: input.name,
      position: input.position,
    },
  });
  return { resource: await parseJSON<FolderResource>(response), ack: parseAck(response) };
}

export async function updateFolder(
  backendUrl: string,
  session: SessionData,
  folderId: string,
  input: { name?: string; parentId?: string | null; position?: number },
  baseCursor: number,
  eventId?: string,
): Promise<{ resource: FolderResource; ack: MutationAck }> {
  const response = await requestRaw(backendUrl, `/folders/${folderId}`, {
    method: "PATCH",
    headers: mutationHeaders(session, baseCursor, eventId),
    body: input,
  });
  return { resource: await parseJSON<FolderResource>(response), ack: parseAck(response) };
}

export async function deleteFolder(
  backendUrl: string,
  session: SessionData,
  folderId: string,
  baseCursor: number,
): Promise<MutationAck> {
  const response = await requestRaw(backendUrl, `/folders/${folderId}`, {
    method: "DELETE",
    headers: mutationHeaders(session, baseCursor),
  });
  return parseAck(response);
}

export async function createBookmark(
  backendUrl: string,
  session: SessionData,
  workspaceId: string,
  input: { folderId: string; title: string; url: string; position?: number },
  baseCursor: number,
): Promise<{ resource: BookmarkResource; ack: MutationAck }> {
  const response = await requestRaw(backendUrl, `/workspaces/${workspaceId}/bookmarks`, {
    method: "POST",
    headers: mutationHeaders(session, baseCursor),
    body: input,
  });
  return { resource: await parseJSON<BookmarkResource>(response), ack: parseAck(response) };
}

export async function updateBookmark(
  backendUrl: string,
  session: SessionData,
  bookmarkId: string,
  input: { folderId?: string | null; title?: string; url?: string; position?: number },
  baseCursor: number,
  eventId?: string,
): Promise<{ resource: BookmarkResource; ack: MutationAck }> {
  const response = await requestRaw(backendUrl, `/bookmarks/${bookmarkId}`, {
    method: "PATCH",
    headers: mutationHeaders(session, baseCursor, eventId),
    body: input,
  });
  return { resource: await parseJSON<BookmarkResource>(response), ack: parseAck(response) };
}

export async function deleteBookmark(
  backendUrl: string,
  session: SessionData,
  bookmarkId: string,
  baseCursor: number,
): Promise<MutationAck> {
  const response = await requestRaw(backendUrl, `/bookmarks/${bookmarkId}`, {
    method: "DELETE",
    headers: mutationHeaders(session, baseCursor),
  });
  return parseAck(response);
}

export function parseFolderDeletePayload(payload: unknown): FolderDeletePayload {
  return payload as FolderDeletePayload;
}

export function parseBookmarkDeletePayload(payload: unknown): BookmarkDeletePayload {
  return payload as BookmarkDeletePayload;
}

function authHeaders(session: SessionData): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    [CLIENT_ID_HEADER]: session.clientId,
  };
}

function mutationHeaders(session: SessionData, baseCursor: number, eventId: string = crypto.randomUUID()): Record<string, string> {
  return {
    ...authHeaders(session),
    [SYNC_EVENT_ID_HEADER]: eventId,
    [SYNC_BASE_CURSOR_HEADER]: String(baseCursor),
  };
}

function parseAck(response: Response): MutationAck {
  return {
    eventId: response.headers.get(SYNC_EVENT_ID_HEADER) ?? "",
    cursor: Number(response.headers.get(SYNC_CURSOR_HEADER) ?? 0),
    duplicate: response.headers.get(SYNC_DUPLICATE_HEADER) === "true",
  };
}

async function requestJSON<T>(backendUrl: string, path: string, init: JSONRequestInit): Promise<T> {
  const response = await requestRaw(backendUrl, path, init);
  return parseJSON<T>(response);
}

async function requestRaw(backendUrl: string, path: string, init: JSONRequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (headers.has("Authorization")) headers.set("Authorization", `Bearer ${getRuntimeAccessToken()}`);
  const execute = () => fetch(`${backendUrl.replace(/\/$/, "")}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let response = await execute();
  if (response.status === 401 && headers.has("Authorization")) {
    try {
      const session = await refreshSession(backendUrl);
      headers.set("Authorization", `Bearer ${getRuntimeAccessToken()}`);
      headers.set(CLIENT_ID_HEADER, session.clientId);
      response = await execute();
    } catch (error) {
      if (error instanceof RefreshError) throw new ApiError(error.message, error.status);
      throw error;
    }
  }

  if (!response.ok) {
    let message = response.statusText;
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error ?? message;
    } catch {
      // ignore parse failure
    }
    throw new ApiError(message, response.status);
  }

  return response;
}

async function parseJSON<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
