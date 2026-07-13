export interface User {
  id: string;
  email: string;
  name?: string;
}

export interface SessionData {
  accessToken: string;
  expiresAt: string;
  clientId: string;
  user: User;
}

export interface RenewableSession extends SessionData {
  refreshToken: string;
}

export interface OrganizationMembership {
  organizationId: string;
  organizationName: string;
  role: string;
}

export interface WorkspaceAccess {
  workspaceId: string;
  workspaceName: string;
  workspaceType: string;
  organizationId: string;
  organizationName: string;
  role: string;
}

export interface FolderNode {
  id: string;
  parentId?: string;
  name: string;
  position: number;
  folders: FolderNode[];
  bookmarks: BookmarkNode[];
}

export interface BookmarkNode {
  id: string;
  folderId: string;
  title: string;
  url: string;
  position: number;
}

export interface TreeResponse {
  workspace: WorkspaceAccess;
  folders: FolderNode[];
}

export interface FolderResource {
  id: string;
  workspaceId: string;
  parentId?: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkResource {
  id: string;
  workspaceId: string;
  folderId: string;
  title: string;
  url: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface FolderDeletePayload {
  id: string;
  workspaceId: string;
  parentId?: string;
}

export interface BookmarkDeletePayload {
  id: string;
  workspaceId: string;
  folderId: string;
}

export interface SyncEnvelope {
  cursor: number;
  eventId: string;
  workspaceId: string;
  originClientId: string;
  kind: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
}

export interface ReplayResult {
  events: SyncEnvelope[];
  currentCursor: number;
  resyncRequired?: boolean;
}

export interface MutationAck {
  eventId: string;
  cursor: number;
  duplicate: boolean;
}

export interface BackendSettings {
  backendUrl: string;
  clientId: string;
}

export interface DiagnosticEntry {
  time: string;
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
}

export interface ActivitySignal {
  revision: number;
  lastSeenRevision: number;
}

export interface ProjectionActivityDetail {
  entityType: "workspace" | "folder" | "bookmark";
  action: "created" | "updated" | "deleted" | "resynced";
  label: string;
  parentLabel?: string;
}

export interface StatusOverview {
  selectedWorkspaceCount: number;
  activeWorkspaceCount: number;
  liveWorkspaceCount: number;
  degradedWorkspaceCount: number;
}

export type ProjectionHealth = "bootstrap" | "live" | "recovering" | "degraded";

export type ConvergencePhase = "plan" | "apply" | "replay" | "live" | "paused";

export interface ConvergenceOperation {
  id: string;
  kind: "create" | "adopt" | "reconcile" | "delete";
  backendId: string;
  chromeId?: string;
  fingerprint: string;
  status: "planned" | "started" | "done";
  ownership?: { workspaceId: string; type: "folder" | "bookmark"; parentChromeId: string; title: string; url?: string; index: number };
}

export interface ConvergenceJournal {
  version: 1;
  epoch?: number;
  desired?: { snapshotId: string; cursor: number };
  phase: ConvergencePhase;
  operations: ConvergenceOperation[];
  localIntents: { eventId: string; kind: string; payload: unknown; status: "queued" | "sent" | "acked" }[];
  attempts: number;
  pauseReason?: "ambiguous-operation" | "identity-ambiguous" | "mapping-not-bijective" | "managed-root-missing" | "stale-mapping" | "operation-overflow" | "intent-overflow";
  queuedEpoch?: number;
}

export interface ProjectionState {
  workspace: WorkspaceAccess;
  rootChromeId?: string;
  organizationChromeId?: string;
  workspaceChromeId?: string;
  chromeIdByBackendId: Record<string, string>;
  backendIdByChromeId: Record<string, string>;
  entityTypeByBackendId: Record<string, "folder" | "bookmark">;
  excludedBackendNodeIds: string[];
  lastCursor: number;
  lastSyncedAt?: string;
  lastError?: string;
  status: "idle" | "syncing" | "ready" | "error";
  socketConnected?: boolean;
  health: ProjectionHealth;
  recoveryAttemptCount: number;
  recoveryStartedAt?: string;
  degradedAt?: string;
  degradedReason?: string;
  lastActivityAt?: string;
  lastActivity?: ProjectionActivityDetail;
  activityRevision?: number;
  convergenceJournal?: ConvergenceJournal;
}

export interface ExtensionState {
  settings: BackendSettings;
  session: SessionData | null;
  authState?: "authenticated" | "loginRequired";
  selectedWorkspaceIds: string[];
  cachedOrganizations: OrganizationMembership[];
  cachedWorkspacesByOrganization: Record<string, WorkspaceAccess[]>;
  projectionsByWorkspaceId: Record<string, ProjectionState>;
  diagnostics: DiagnosticEntry[];
  activitySignal?: ActivitySignal;
  statusOverview?: StatusOverview;
}

export interface LoginRequest {
  backendUrl: string;
  email: string;
  password: string;
  deviceName: string;
}

export interface UiState {
  state: ExtensionState;
}
