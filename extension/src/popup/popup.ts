import { DEFAULT_BACKEND_URL } from "../shared/runtime.js";
import { getPopupStatusModel } from "../shared/ui/status.js";
import type { ExtensionState, LoginRequest, UiState } from "../shared/types.js";

const signedOut = document.querySelector<HTMLElement>("#signed-out")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const errorNode = document.querySelector<HTMLElement>("#error")!;
const sessionSummary = document.querySelector<HTMLElement>("#session-summary")!;
const workspaceSummary = document.querySelector<HTMLElement>("#workspace-summary")!;
const statusHeadline = document.querySelector<HTMLElement>("#status-headline")!;
const statusDetail = document.querySelector<HTMLElement>("#status-detail")!;
const statusIndicators = document.querySelector<HTMLElement>("#status-indicators")!;
const workspaceMetrics = document.querySelector<HTMLElement>("#workspace-metrics")!;
const recentActivitySection = document.querySelector<HTMLElement>("#recent-activity")!;
const recentActivityList = document.querySelector<HTMLElement>("#recent-activity-list")!;

const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url")!;
const emailInput = document.querySelector<HTMLInputElement>("#email")!;
const passwordInput = document.querySelector<HTMLInputElement>("#password")!;
const deviceNameInput = document.querySelector<HTMLInputElement>("#device-name")!;
let lastAcknowledgedRevision = 0;

document.querySelector<HTMLFormElement>("#login-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void runLogin();
});

document.querySelector<HTMLButtonElement>("#logout")!.addEventListener("click", () => {
  void sendMessage<UiState>({ type: "auth/logout" }).then(render).catch(showError);
});

document.querySelector<HTMLButtonElement>("#open-options")!.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void bootstrap();

async function bootstrap(): Promise<void> {
  backendUrlInput.value = DEFAULT_BACKEND_URL;
  const ui = await sendMessage<UiState>({ type: "session/get" });
  if (ui.state.settings.backendUrl) {
    backendUrlInput.value = ui.state.settings.backendUrl;
  }
  render(ui);
}

async function runLogin(): Promise<void> {
  clearError();
  const request: LoginRequest = {
    backendUrl: backendUrlInput.value.trim(),
    email: emailInput.value.trim(),
    password: passwordInput.value,
    deviceName: deviceNameInput.value.trim() || "Chrome Extension",
  };
  const ui = await sendMessage<UiState>({ type: "auth/login", payload: request });
  render(ui);
}

function render(ui: UiState): void {
  const { state } = ui;
  const statusModel = getPopupStatusModel(state);
  const signedInActive = Boolean(state.session);
  signedOut.classList.toggle("hidden", signedInActive);
  signedIn.classList.toggle("hidden", !signedInActive);

  if (!state.session) {
    sessionSummary.textContent = "";
    workspaceSummary.textContent = "";
    statusHeadline.textContent = "";
    statusDetail.textContent = "";
    statusIndicators.replaceChildren();
    workspaceMetrics.replaceChildren();
    recentActivitySection.classList.add("hidden");
    recentActivityList.replaceChildren();
    return;
  }

  const selectedCount = state.selectedWorkspaceIds.length;
  sessionSummary.textContent = `${state.session.user.email} • ${state.settings.backendUrl}`;
  workspaceSummary.textContent = selectedCount === 0
    ? "No workspaces selected yet. Use Settings to choose the scope."
    : `${selectedCount} workspace${selectedCount === 1 ? "" : "s"} selected.`;
  statusHeadline.textContent = statusModel.headline;
  statusDetail.textContent = statusModel.detail;
  renderIndicators(statusModel);
  renderMetrics(statusModel);
  renderRecentActivity(statusModel);
  acknowledgeActivityIfNeeded(state);
}

function showError(error: unknown): void {
  errorNode.textContent = error instanceof Error ? error.message : "Unexpected popup error";
}

function clearError(): void {
  errorNode.textContent = "";
}

function renderIndicators(model: ReturnType<typeof getPopupStatusModel>): void {
  statusIndicators.replaceChildren();
  statusIndicators.appendChild(createPill(model.statusLabel, model.tone));
  if (model.showOnline) {
    statusIndicators.appendChild(createIndicator("Online", "ui-indicator-dot"));
  }
  if (model.showNewActivity) {
    statusIndicators.appendChild(createIndicator("New updates", "ui-activity-dot", true));
  }
  if (model.lastActivityLabel) {
    const meta = document.createElement("span");
    meta.className = "ui-muted";
    meta.textContent = `Last activity ${model.lastActivityLabel}`;
    statusIndicators.appendChild(meta);
  }
}

function renderMetrics(model: ReturnType<typeof getPopupStatusModel>): void {
  workspaceMetrics.replaceChildren(
    createMetric(String(model.selectedWorkspaceCount), "Selected"),
    createMetric(String(model.liveWorkspaceCount), "Live"),
    createMetric(String(model.degradedWorkspaceCount), "Needs attention"),
  );
}

function renderRecentActivity(model: ReturnType<typeof getPopupStatusModel>): void {
  recentActivityList.replaceChildren();
  recentActivitySection.classList.toggle("hidden", model.recentActivity.length === 0);
  for (const activity of model.recentActivity.slice(0, 3)) {
    const item = document.createElement("li");
    item.textContent = activity.lastActivityLabel
      ? `${activity.workspaceName} — ${activity.summary} (${activity.lastActivityLabel})`
      : `${activity.workspaceName} — ${activity.summary}`;
    recentActivityList.appendChild(item);
  }
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
