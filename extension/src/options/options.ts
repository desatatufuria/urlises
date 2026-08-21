import type { SecretHistoryEntry } from "../shared/api.js";
import type { ExtensionState, StatusOverview, UiState, UITheme } from "../shared/types.js";
import { formatUiTimestamp, getStatusOverview, getWorkspaceStatusModel } from "../shared/ui/status.js";
import { nextAdvancedToggleState } from "../popup/advanced-toggle.js";
import { formatSecretHistoryEntry, type FormattedSecretHistoryEntry } from "./secret-history.js";

const summary = document.querySelector<HTMLElement>("#summary")!;
const workspaceGroups = document.querySelector<HTMLElement>("#workspace-groups")!;
const liveSyncStatusNode = document.querySelector<HTMLElement>("#live-sync-status")!;
const liveSyncStatusTextNode = document.querySelector<HTMLElement>("#live-sync-status-text")!;
const diagnosticsNode = document.querySelector<HTMLElement>("#diagnostics")!;
const secretHistoryNode = document.querySelector<HTMLElement>("#secret-history")!;
const overviewMetrics = document.querySelector<HTMLElement>("#overview-metrics")!;
const themeSwatches = document.querySelector<HTMLElement>("#theme-swatches")!;

const toggleSecretHistoryButton = document.querySelector<HTMLButtonElement>("#toggle-secret-history")!;
const secretHistoryPanel = document.querySelector<HTMLElement>("#secret-history-panel")!;
const toggleLogButton = document.querySelector<HTMLButtonElement>("#toggle-log")!;
const logPanel = document.querySelector<HTMLElement>("#log-panel")!;

let lastAcknowledgedRevision = 0;

const THEME_OPTIONS: Array<{ value: UITheme; label: string; background: string; accent: string }> = [
  { value: "slate", label: "Ink", background: "#101215", accent: "#3e5468" },
  { value: "indigo", label: "Champagne", background: "#171512", accent: "#b08d57" },
  { value: "teal", label: "Oxblood", background: "#17120f", accent: "#9c4a44" },
];

document.querySelector<HTMLButtonElement>("#save-selection")!.addEventListener("click", () => {
  const selected = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-workspace-id]:checked")).map((input) => input.dataset.workspaceId!);
  void sendMessage<UiState>({ type: "projection/set-workspaces", payload: { workspaceIds: selected } })
    .then(render)
    .catch(showError);
});

// Both start collapsed by default — the Log and Secret history sections
// take up too much space to leave expanded. Data fetching/population
// (loadSecretHistory, renderDiagnostics) is not gated on this: it keeps
// running in the background exactly as before, so content is already
// there the instant the user expands a panel.
wireCollapsibleSection(toggleSecretHistoryButton, secretHistoryPanel);
wireCollapsibleSection(toggleLogButton, logPanel);

void load();

function wireCollapsibleSection(button: HTMLButtonElement, panel: HTMLElement): void {
  const chevron = button.querySelector<SVGElement>(".ui-chevron")!;
  button.addEventListener("click", () => {
    const isExpanded = button.getAttribute("aria-expanded") === "true";
    const next = nextAdvancedToggleState(isExpanded);
    panel.classList.toggle("hidden", !next.expanded);
    chevron.classList.toggle("ui-chevron--open", next.expanded);
    button.setAttribute("aria-expanded", next.ariaExpanded);
  });
}

async function load(): Promise<void> {
  const ui = await sendMessage<UiState>({ type: "options/load" });
  render(ui);
  if (ui.state.session) {
    void loadSecretHistory();
  }
}

// loadSecretHistory fetches the caller's secret micro-registry once when
// the page loads (not on every render()), matching the "flat list, no
// pagination" scope — there is nothing here to refresh on a per-action
// basis the way workspace state is.
async function loadSecretHistory(): Promise<void> {
  try {
    const entries = await sendMessage<SecretHistoryEntry[]>({ type: "secrets/list" });
    renderSecretHistory(entries);
  } catch (error) {
    renderSecretHistory([]);
    showError(error);
  }
}

function render(ui: UiState): void {
  const state = ui.state;
  document.documentElement.dataset.theme = state.uiTheme ?? "slate";
  renderAppearance(state.uiTheme ?? "slate");
  const overview = state.statusOverview ?? getStatusOverview(state);
  if (!state.session) {
    summary.textContent = "Sign in from the popup before selecting workspaces.";
    workspaceGroups.innerHTML = "";
    liveSyncStatusNode.hidden = true;
    liveSyncStatusTextNode.textContent = "";
    renderDiagnostics([{ time: "", level: "info", scope: "session", message: "No active session." }]);
    overviewMetrics.replaceChildren();
    secretHistoryNode.replaceChildren();
    return;
  }

  summary.textContent = `Signed in as ${state.session.user.email}. Choose which workspaces appear under URLises / Organization / Workspace.`;
  workspaceGroups.innerHTML = "";
  renderOverviewMetrics(overview);

  for (const organization of state.cachedOrganizations) {
    const panel = document.createElement("section");
    panel.className = "ui-surface ui-panel ui-grid ui-surface--soft";
    const heading = document.createElement("div");
    heading.className = "ui-grid ui-grid--compact";
    const headingTitle = document.createElement("h3");
    headingTitle.className = "ui-card-title";
    headingTitle.textContent = organization.organizationName;
    const headingCopy = document.createElement("p");
    headingCopy.className = "ui-card-copy";
    headingCopy.textContent = `Organization role: ${organization.role}`;
    heading.append(headingTitle, headingCopy);
    panel.appendChild(heading);

    const workspaceList = document.createElement("div");
    workspaceList.className = "ui-grid";
    const workspaces = state.cachedWorkspacesByOrganization[organization.organizationId] ?? [];
    for (const workspace of workspaces) {
      const projection = state.projectionsByWorkspaceId[workspace.workspaceId];
      const model = projection ? getWorkspaceStatusModel(projection, state.activitySignal) : null;
      const label = document.createElement("label");
      label.className = `ui-surface ui-panel ui-grid ui-card--workspace ${model?.cardClassName ?? "ui-card--healthy"}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.workspaceId = workspace.workspaceId;
      checkbox.checked = state.selectedWorkspaceIds.includes(workspace.workspaceId);
      const checkboxRow = document.createElement("div");
      checkboxRow.className = "ui-checkbox-row";
      const body = document.createElement("div");
      body.className = "ui-grid ui-grid--compact";
      const title = document.createElement("strong");
      title.textContent = workspace.workspaceName;
      const copy = document.createElement("span");
      copy.className = "ui-muted";
      copy.textContent = `${workspace.role} • ${workspace.workspaceType}`;
      body.append(title, copy);
      checkboxRow.append(checkbox, body);
      label.appendChild(checkboxRow);
      if (model) {
        label.appendChild(createStatusRow(model));
        if (projection.convergenceJournal?.phase === "paused") {
          const actions = document.createElement("div");
          actions.className = "ui-actions";
          const repairActions = projection.convergenceJournal.repairDisposition === "rebuild"
            ? [["Rebuild", "projection/rebuild"]] as const
            : [["Retry", "projection/retry"], ["Rebuild", "projection/rebuild"]] as const;
          for (const [text, type] of repairActions) {
            const button = document.createElement("button"); button.type = "button"; button.className = "ui-button-secondary"; button.textContent = text;
            button.addEventListener("click", () => void sendMessage<UiState>({ type, payload: { workspaceId: workspace.workspaceId } }).then(render).catch(showError));
            actions.appendChild(button);
          }
          label.appendChild(actions);
        }
      } else {
        const empty = document.createElement("p");
        empty.className = "ui-card-copy";
        empty.textContent = "Not active yet. Save the selection to start sync.";
        label.appendChild(empty);
      }
      workspaceList.appendChild(label);
    }
    panel.appendChild(workspaceList);
    workspaceGroups.appendChild(panel);
  }

  const degradedSummaries = getDegradedProjectionSummaries(state);
  liveSyncStatusNode.hidden = degradedSummaries.length === 0;
  liveSyncStatusTextNode.textContent = degradedSummaries.join(" ");
  renderDiagnostics(getDiagnosticEntries(state));
  acknowledgeActivityIfNeeded(state);
}

function getDegradedProjectionSummaries(state: ExtensionState): string[] {
  return Object.values(state.projectionsByWorkspaceId)
    .filter((projection) => projection.health === "degraded")
    .map((projection) => {
      const reason = projection.degradedReason ?? projection.lastError ?? "silent recovery budget exhausted";
      return `Sync is degraded for ${projection.workspace.workspaceName}. Resync is required: ${reason}.`;
    });
}

function getDiagnosticEntries(state: ExtensionState): Array<{ time: string; level: string; scope: string; message: string }> {
  const degradedLines = Object.values(state.projectionsByWorkspaceId)
    .filter((projection) => projection.health === "degraded")
    .map((projection) => ({
      time: projection.degradedAt ?? projection.lastSyncedAt ?? "",
      level: "warn",
      scope: projection.workspace.workspaceName,
      message: projection.degradedReason ?? projection.lastError ?? "silent recovery budget exhausted",
    }));

  const diagnosticLines = state.diagnostics.map((entry) => ({
    time: entry.time,
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
  }));

  return [...degradedLines, ...diagnosticLines];
}

function showError(error: unknown): void {
  renderDiagnostics([{
    time: new Date().toISOString(),
    level: "error",
    scope: "options",
    message: error instanceof Error ? error.message : "Unexpected options error",
  }]);
}

function renderAppearance(activeTheme: UITheme): void {
  themeSwatches.replaceChildren();
  for (const theme of THEME_OPTIONS) {
    const isActive = theme.value === activeTheme;
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = `ui-theme-swatch${isActive ? " ui-theme-swatch--active" : ""}`;
    swatch.style.background = theme.background;
    swatch.setAttribute("aria-pressed", String(isActive));
    swatch.addEventListener("click", () => {
      void sendMessage<UiState>({ type: "preferences/set-theme", payload: { uiTheme: theme.value } })
        .then(render)
        .catch(showError);
    });

    const chip = document.createElement("span");
    chip.className = "ui-theme-swatch__chip";
    chip.style.background = theme.accent;
    swatch.appendChild(chip);

    const label = document.createElement("span");
    label.className = "ui-theme-swatch__label";
    label.textContent = theme.label;
    swatch.appendChild(label);

    if (isActive) {
      const check = document.createElement("span");
      check.className = "ui-theme-swatch__check";
      check.textContent = "✓";
      swatch.appendChild(check);
    }

    themeSwatches.appendChild(swatch);
  }
}

const STAT_ICON_SELECTED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
const STAT_ICON_LIVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const STAT_ICON_ATTENTION = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

function renderOverviewMetrics(overview: StatusOverview): void {
  const stats = [
    createStat(String(overview.selectedWorkspaceCount), "Selected", STAT_ICON_SELECTED),
    createStat(String(overview.liveWorkspaceCount), "Live now", STAT_ICON_LIVE),
    createStat(String(overview.degradedWorkspaceCount), "Need attention", STAT_ICON_ATTENTION, overview.degradedWorkspaceCount > 0),
  ];
  overviewMetrics.replaceChildren();
  stats.forEach((stat, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "ui-stat-separator";
      overviewMetrics.appendChild(separator);
    }
    overviewMetrics.appendChild(stat);
  });
}

function createStat(value: string, label: string, iconSvg: string, attention = false): HTMLElement {
  const stat = document.createElement("span");
  stat.className = attention ? "ui-stat ui-stat--attention" : "ui-stat";
  stat.innerHTML = iconSvg;
  const strong = document.createElement("strong");
  strong.textContent = value;
  const copy = document.createElement("span");
  copy.className = "ui-muted";
  copy.textContent = label;
  stat.append(strong, copy);
  return stat;
}

function createStatusRow(model: ReturnType<typeof getWorkspaceStatusModel>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "ui-grid ui-grid--compact";

  const pills = document.createElement("div");
  pills.className = "ui-status-row";
  pills.appendChild(createPill(model.statusLabel, model.tone));
  if (model.showOnline) {
    pills.appendChild(createIndicator("Online", "ui-indicator-dot"));
  }
  if (model.showNewActivity) {
    pills.appendChild(createIndicator("New updates", "ui-activity-dot", true));
  }

  const detail = document.createElement("p");
  detail.className = "ui-card-copy";
  detail.textContent = model.lastActivityLabel
    ? `${model.detail} Last activity ${model.lastActivityLabel}.`
    : model.detail;

  wrapper.append(pills, detail);

  if (model.showNewActivity && model.activitySummary) {
    const summary = document.createElement("p");
    summary.className = "ui-card-copy";
    summary.textContent = `New activity: ${model.activitySummary}.`;
    wrapper.appendChild(summary);
  }

  return wrapper;
}

function createPill(label: string, tone: "neutral" | "live" | "attention"): HTMLElement {
  const pill = document.createElement("span");
  pill.className = `ui-pill ui-pill--${tone}`;
  pill.textContent = label;
  return pill;
}

function createIndicator(label: string, dotClassName: string, activity = false): HTMLElement {
  const indicator = document.createElement("span");
  indicator.className = activity ? "ui-pill ui-pill--activity" : "ui-indicator";
  const dot = document.createElement("span");
  dot.className = dotClassName;
  indicator.append(dot, document.createTextNode(label));
  return indicator;
}

function renderDiagnostics(entries: Array<{ time: string; level: string; scope: string; message: string }>): void {
  diagnosticsNode.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ui-log__empty";
    empty.textContent = "No log entries yet.";
    diagnosticsNode.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    diagnosticsNode.appendChild(createLogLine(entry));
  }
}

function createLogLine(entry: { time: string; level: string; scope: string; message: string }): HTMLElement {
  const line = document.createElement("div");
  const normalizedLevel = entry.level.toLowerCase();
  line.className = `ui-log__line ui-log__line--${normalizedLevel}`;

  const time = document.createElement("span");
  time.className = "ui-log__time";
  time.textContent = formatUiTimestamp(entry.time) ?? "—";

  const level = document.createElement("span");
  level.className = "ui-log__level";
  level.textContent = `[${normalizedLevel}]`;

  const message = document.createElement("span");
  message.className = "ui-log__message";
  message.textContent = `${entry.scope}: ${entry.message}`;

  line.append(time, level, message);
  return line;
}

// renderSecretHistory renders the compact, read-only micro-registry: one
// row per secret, created time plus a computed status label. No actions,
// no links, no re-fetch-content affordance — deliberately not exhaustive.
function renderSecretHistory(entries: SecretHistoryEntry[]): void {
  secretHistoryNode.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ui-log__empty";
    empty.textContent = "No secrets created yet.";
    secretHistoryNode.appendChild(empty);
    return;
  }

  const now = new Date();
  for (const entry of entries) {
    secretHistoryNode.appendChild(createSecretHistoryLine(formatSecretHistoryEntry(entry, now)));
  }
}

function createSecretHistoryLine(formatted: FormattedSecretHistoryEntry): HTMLElement {
  const line = document.createElement("div");
  line.className = `ui-log__line ui-log__line--${formatted.statusTag}`;

  const time = document.createElement("span");
  time.className = "ui-log__time";
  time.textContent = formatted.createdLabel;

  const level = document.createElement("span");
  level.className = "ui-log__level";
  level.textContent = `[${formatted.statusTag}]`;

  const message = document.createElement("span");
  message.className = "ui-log__message";
  message.textContent = formatted.statusLabel;

  line.append(time, level, message);
  return line;
}

function acknowledgeActivityIfNeeded(state: ExtensionState): void {
  const revision = state.activitySignal?.revision ?? 0;
  const lastSeen = state.activitySignal?.lastSeenRevision ?? 0;
  if (revision === 0 || revision <= lastSeen || revision <= lastAcknowledgedRevision) {
    return;
  }
  lastAcknowledgedRevision = revision;
  queueMicrotask(() => {
    void sendMessage<UiState>({ type: "ui/mark-activity-seen" }).catch(() => {
      lastAcknowledgedRevision = Math.min(lastAcknowledgedRevision, lastSeen);
    });
  });
}

function sendMessage<T>(message: { type: string; payload?: unknown }): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T & { error?: string }) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}
