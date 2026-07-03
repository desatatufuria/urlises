import type { ActivitySignal, ExtensionState, ProjectionActivityDetail, ProjectionState, StatusOverview } from "../types.js";

export type StatusTone = "neutral" | "live" | "attention";

export interface PopupStatusModel {
  headline: string;
  detail: string;
  tone: StatusTone;
  statusLabel: string;
  selectedWorkspaceCount: number;
  activeWorkspaceCount: number;
  liveWorkspaceCount: number;
  degradedWorkspaceCount: number;
  showOnline: boolean;
  showNewActivity: boolean;
  lastActivityLabel?: string;
  recentActivity: WorkspaceActivityModel[];
}

export interface WorkspaceActivityModel {
  workspaceId: string;
  workspaceName: string;
  summary: string;
  lastActivityLabel?: string;
}

export interface WorkspaceStatusModel {
  workspaceId: string;
  workspaceName: string;
  organizationName: string;
  role: string;
  tone: StatusTone;
  statusLabel: string;
  detail: string;
  showOnline: boolean;
  showNewActivity: boolean;
  activitySummary?: string;
  lastActivityLabel?: string;
  healthLabel: string;
  cardClassName: string;
}

export interface ToolbarBadgeModel {
  backgroundColor?: string;
  text: string;
  title: string;
}

const DEFAULT_EXTENSION_TITLE = "Shared Bookmarks Sync";
const TOOLBAR_ACTIVITY_BADGE_COLOR = "#7e9cd8";
const TOOLBAR_DEGRADED_BADGE_COLOR = "#c34043";
const MADRID_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

export function getStatusOverview(state: ExtensionState): StatusOverview {
  const projections = Object.values(state.projectionsByWorkspaceId);
  return {
    selectedWorkspaceCount: state.selectedWorkspaceIds.length,
    activeWorkspaceCount: projections.length,
    liveWorkspaceCount: projections.filter(isProjectionOnline).length,
    degradedWorkspaceCount: projections.filter((projection) => projection.health === "degraded").length,
  };
}

export function getToolbarBadgeModel(state: ExtensionState): ToolbarBadgeModel {
  const overview = state.statusOverview ?? getStatusOverview(state);
  if (overview.degradedWorkspaceCount > 0) {
    return {
      text: "•",
      backgroundColor: TOOLBAR_DEGRADED_BADGE_COLOR,
      title: `${DEFAULT_EXTENSION_TITLE} — degraded sync needs attention`,
    };
  }

  if (hasUnseenActivity(state.activitySignal)) {
    return {
      text: "•",
      backgroundColor: TOOLBAR_ACTIVITY_BADGE_COLOR,
      title: `${DEFAULT_EXTENSION_TITLE} — new activity available`,
    };
  }

  return {
    text: "",
    title: DEFAULT_EXTENSION_TITLE,
  };
}

export function hasUnseenActivity(signal?: ActivitySignal): boolean {
  return (signal?.revision ?? 0) > (signal?.lastSeenRevision ?? 0);
}

export function isProjectionOnline(projection: Pick<ProjectionState, "socketConnected" | "health">): boolean {
  return Boolean(projection.socketConnected) || projection.health === "live";
}

export function hasProjectionFreshActivity(
  projection: Pick<ProjectionState, "activityRevision">,
  signal?: ActivitySignal,
): boolean {
  return (projection.activityRevision ?? 0) > (signal?.lastSeenRevision ?? 0);
}

export function formatUiTimestamp(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const parts = Object.fromEntries(
    MADRID_TIMESTAMP_FORMATTER
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

export function formatProjectionActivity(detail?: ProjectionActivityDetail): string | undefined {
  if (!detail) {
    return undefined;
  }

  const action = getActivityActionLabel(detail.entityType, detail.action);
  const suffix = detail.parentLabel && detail.entityType === "bookmark"
    ? ` in ${detail.parentLabel}`
    : "";
  return `${action} · ${detail.label}${suffix}`;
}

export function getFreshWorkspaceActivity(state: ExtensionState): WorkspaceActivityModel[] {
  return Object.values(state.projectionsByWorkspaceId)
    .filter((projection) => hasProjectionFreshActivity(projection, state.activitySignal))
    .sort((left, right) => {
      const revisionDelta = (right.activityRevision ?? 0) - (left.activityRevision ?? 0);
      if (revisionDelta !== 0) {
        return revisionDelta;
      }
      return (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "");
    })
    .map((projection) => ({
      workspaceId: projection.workspace.workspaceId,
      workspaceName: projection.workspace.workspaceName,
      summary: formatProjectionActivity(projection.lastActivity) ?? "New activity available",
      lastActivityLabel: formatUiTimestamp(projection.lastActivityAt),
    }));
}

export function getPopupStatusModel(state: ExtensionState): PopupStatusModel {
  const overview = state.statusOverview ?? getStatusOverview(state);
  const projections = Object.values(state.projectionsByWorkspaceId);
  const recentActivity = getFreshWorkspaceActivity(state);
  const latestActivity = projections
    .map((projection) => projection.lastActivityAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  if (overview.degradedWorkspaceCount > 0) {
    return {
      headline: `${overview.degradedWorkspaceCount} workspace${overview.degradedWorkspaceCount === 1 ? "" : "s"} need attention`,
      detail: "Sync is still available, but degraded workspaces should be resynced from Settings.",
      tone: "attention",
      statusLabel: "Attention required",
      selectedWorkspaceCount: overview.selectedWorkspaceCount,
      activeWorkspaceCount: overview.activeWorkspaceCount,
      liveWorkspaceCount: overview.liveWorkspaceCount,
      degradedWorkspaceCount: overview.degradedWorkspaceCount,
      showOnline: overview.liveWorkspaceCount > 0,
      showNewActivity: hasUnseenActivity(state.activitySignal),
      lastActivityLabel: formatUiTimestamp(latestActivity),
      recentActivity,
    };
  }

  if (overview.selectedWorkspaceCount === 0) {
    return {
      headline: "Choose workspaces before sync starts",
      detail: "Open Settings to choose which workspaces appear in Chrome bookmarks.",
      tone: "neutral",
      statusLabel: "No workspaces selected",
      selectedWorkspaceCount: 0,
      activeWorkspaceCount: overview.activeWorkspaceCount,
      liveWorkspaceCount: overview.liveWorkspaceCount,
      degradedWorkspaceCount: 0,
      showOnline: false,
      showNewActivity: false,
      recentActivity: [],
    };
  }

  return {
    headline: overview.liveWorkspaceCount > 0 ? "Sync is healthy" : "Ready to connect",
    detail: overview.liveWorkspaceCount > 0
      ? "Selected workspaces are connected and updating normally."
      : "Selected workspaces are configured and will show live status once connectivity is active.",
    tone: overview.liveWorkspaceCount > 0 ? "live" : "neutral",
    statusLabel: overview.liveWorkspaceCount > 0 ? "Healthy sync" : "Standing by",
    selectedWorkspaceCount: overview.selectedWorkspaceCount,
    activeWorkspaceCount: overview.activeWorkspaceCount,
    liveWorkspaceCount: overview.liveWorkspaceCount,
    degradedWorkspaceCount: 0,
    showOnline: overview.liveWorkspaceCount > 0,
    showNewActivity: hasUnseenActivity(state.activitySignal),
    lastActivityLabel: formatUiTimestamp(latestActivity),
    recentActivity,
  };
}

export function getWorkspaceStatusModel(projection: ProjectionState, signal?: ActivitySignal): WorkspaceStatusModel {
  const tone = projection.health === "degraded"
    ? "attention"
    : isProjectionOnline(projection)
      ? "live"
      : "neutral";

  const detail = projection.health === "degraded"
    ? projection.degradedReason ?? projection.lastError ?? "Silent recovery budget was exhausted."
    : projection.health === "recovering"
      ? projection.lastError ?? "Recovery is in progress."
      : projection.lastSyncedAt
        ? `Last synced ${formatUiTimestamp(projection.lastSyncedAt)}.`
        : "Awaiting first successful sync.";

  return {
    workspaceId: projection.workspace.workspaceId,
    workspaceName: projection.workspace.workspaceName,
    organizationName: projection.workspace.organizationName,
    role: projection.workspace.role,
    tone,
    statusLabel: getHealthLabel(projection),
    detail,
    showOnline: isProjectionOnline(projection),
    showNewActivity: hasProjectionFreshActivity(projection, signal),
    activitySummary: formatProjectionActivity(projection.lastActivity),
    lastActivityLabel: formatUiTimestamp(projection.lastActivityAt),
    healthLabel: projection.health,
    cardClassName: getCardClassName(projection.health),
  };
}

function getActivityActionLabel(entityType: ProjectionActivityDetail["entityType"], action: ProjectionActivityDetail["action"]): string {
  switch (`${entityType}:${action}`) {
    case "workspace:resynced":
      return "Projection resynced";
    case "folder:created":
      return "Folder added";
    case "folder:updated":
      return "Folder updated";
    case "folder:deleted":
      return "Folder removed";
    case "bookmark:created":
      return "Bookmark added";
    case "bookmark:updated":
      return "Bookmark updated";
    case "bookmark:deleted":
      return "Bookmark removed";
    default:
      return "New activity";
  }
}

function getHealthLabel(projection: ProjectionState): string {
  switch (projection.health) {
    case "degraded":
      return "Degraded sync";
    case "recovering":
      return "Recovering";
    case "live":
      return "Live";
    default:
      return "Bootstrap pending";
  }
}

function getCardClassName(health: ProjectionState["health"]): string {
  switch (health) {
    case "degraded":
      return "ui-card--degraded";
    case "recovering":
      return "ui-card--recovering";
    default:
      return "ui-card--healthy";
  }
}
