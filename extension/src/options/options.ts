import type { ExtensionState, StatusOverview, UiState } from "../shared/types.js";
import { formatUiTimestamp, getStatusOverview, getWorkspaceStatusModel } from "../shared/ui/status.js";

const summary = document.querySelector<HTMLElement>("#summary")!;
const workspaceGroups = document.querySelector<HTMLElement>("#workspace-groups")!;
const liveSyncStatusNode = document.querySelector<HTMLElement>("#live-sync-status")!;
const liveSyncStatusTextNode = document.querySelector<HTMLElement>("#live-sync-status-text")!;
const diagnosticsNode = document.querySelector<HTMLElement>("#diagnostics")!;
const overviewMetrics = document.querySelector<HTMLElement>("#overview-metrics")!;
let lastAcknowledgedRevision = 0;

document.querySelector<HTMLButtonElement>("#save-selection")!.addEventListener("click", () => {
  const selected = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-workspace-id]:checked")).map((input) => input.dataset.workspaceId!);
  void sendMessage<UiState>({ type: "projection/set-workspaces", payload: { workspaceIds: selected } })
    .then(render)
    .catch(showError);
});

void load();

async function load(): Promise<void> {
  const ui = await sendMessage<UiState>({ type: "options/load" });
  render(ui);
}

function render(ui: UiState): void {
  const state = ui.state;
  const overview = state.statusOverview ?? getStatusOverview(state);
  if (!state.session) {
    summary.textContent = "Sign in from the popup before selecting workspaces.";
    workspaceGroups.innerHTML = "";
    liveSyncStatusNode.hidden = true;
    liveSyncStatusTextNode.textContent = "";
    renderDiagnostics([{ time: "", level: "info", scope: "session", message: "No active session." }]);
    overviewMetrics.replaceChildren();
    return;
  }

  summary.textContent = `Signed in as ${state.session.user.email}. Choose which workspaces appear under Shared Bookmarks / Organization / Workspace.`;
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

function renderOverviewMetrics(overview: StatusOverview): void {
  overviewMetrics.replaceChildren(
    createMetric(String(overview.selectedWorkspaceCount), "Selected"),
    createMetric(String(overview.liveWorkspaceCount), "Live now"),
    createMetric(String(overview.degradedWorkspaceCount), "Need attention"),
  );
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

function createMetric(value: string, label: string): HTMLElement {
  const metric = document.createElement("div");
  metric.className = "ui-kpi";
  const strong = document.createElement("strong");
  strong.textContent = value;
  const copy = document.createElement("span");
  copy.className = "ui-muted";
  copy.textContent = label;
  metric.append(strong, copy);
  return metric;
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
