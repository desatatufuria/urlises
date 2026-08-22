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

// SecretRecipient mirrors organizations.MemberName exactly. name is optional
// because the backend tags it omitempty. There is deliberately no role and
// no organization attribution (Decision F) -- do not add either.
export interface SecretRecipient {
  userId: string;
  email: string;
  name?: string;
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
  /** Cached from GET /config/public (best-effort, fetched once per session
   * start/login). Undefined when never fetched or the backend doesn't
   * support the endpoint yet — callers must fall back to
   * DEFAULT_PUBLIC_BASE_URL in that case. */
  publicBaseUrl?: string;
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

/** A secret the local user created, persisted so an incoming `secret_read`
 * frame's bare `secretId` can be resolved back to a share the popup once
 * created — the frame itself never carries the token (see design.md's
 * "Read-confirmation frame payload" decision). */
export interface SecretRecord {
  id: string;
  token: string;
  createdAt: string;
}

/** A read confirmation for a locally-created secret, recorded either from a
 * live `secret_read` socket frame or (implicitly) surfaced on next popup
 * open when no live delivery occurred while the secret was burned. */
export interface SecretReadConfirmation {
  secretId: string;
  readAt: string;
}

/** Same {revision, lastSeenRevision} shape as ActivitySignal, tracked as an
 * independent signal so a "Secret read" pill never gets silently folded
 * into (or cleared by) the unrelated "New updates" activity pill. */
export type SecretReadSignal = ActivitySignal;

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
  ownership?: { workspaceId: string; effect?: "create" | "delete"; type: "folder" | "bookmark"; parentChromeId?: string; title?: string; url?: string; index?: number; chromeId?: string; mappedChromeIds?: string[] };
}

export interface ReceiptNodeShape { parentId?: string; index?: number; title: string; url?: string; }
export interface RemoteReceipt {
  version: 1; workspaceId: string; backendId: string; chromeId: string; type: "folder" | "bookmark";
  before: ReceiptNodeShape; expectedAfter: ReceiptNodeShape; eventId: string; cursor: number;
  expectedSignatures: string[]; status: "pending" | "consumed";
  move?: { oldParentId: string; oldIndex: number; parentId: string; index: number };
}

export interface ConvergenceJournal {
  version: 1;
  epoch?: number;
  desired?: { snapshotId: string; cursor: number };
  phase: ConvergencePhase;
  operations: ConvergenceOperation[];
  receipts?: RemoteReceipt[];
  localIntents: { eventId: string; kind: string; payload: { workspaceId: string; backendId: string; chromeId: string; type: "folder" | "bookmark"; kind: string; node: { id: string; parentId?: string; index?: number; title: string; url?: string } }; status: "queued" | "sent" | "acked" }[];
  attempts: number;
  pauseReason?: "ambiguous-operation" | "identity-ambiguous" | "mapping-not-bijective" | "managed-root-missing" | "stale-mapping" | "operation-overflow" | "intent-overflow" | "cursor-zero-read-failed" | "receipt-overflow" | "receipt-capacity" | "durable-write-failed" | "complete-node-read-failed" | "final-verification-failed" | "chrome-effect-rejected" | "ambiguous-predecessor" | "bootstrap-required";
  failedCursor?: number;
  repairDisposition?: "retry" | "rebuild";
  queuedEpoch?: number;
}

export interface ProjectionState {
  workspace: WorkspaceAccess;
  rootChromeId?: string;
  organizationChromeId?: string;
  workspaceChromeId?: string;
  localOnlyChromeId?: string;
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

export type UITheme = "slate" | "indigo" | "teal";

export interface Preferences {
  uiTheme: string;
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
  uiTheme?: UITheme;
  secretRecords?: SecretRecord[];
  secretReadConfirmations?: SecretReadConfirmation[];
  secretReadSignal?: SecretReadSignal;
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
