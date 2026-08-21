import { DEFAULT_BACKEND_URL } from "../shared/runtime.js";
import { getPopupStatusModel } from "../shared/ui/status.js";
import type { ExtensionState, LoginRequest, UiState } from "../shared/types.js";
import { nextAdvancedToggleState } from "./advanced-toggle.js";
import { shouldShowStatusDetail } from "./status-detail.js";

const signedOut = document.querySelector<HTMLElement>("#signed-out")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const errorNode = document.querySelector<HTMLElement>("#error")!;
const sessionSummary = document.querySelector<HTMLElement>("#session-summary")!;
const statusDetail = document.querySelector<HTMLElement>("#status-detail")!;
const statusIndicators = document.querySelector<HTMLElement>("#status-indicators")!;
const lastActivity = document.querySelector<HTMLElement>("#last-activity")!;
const recentActivitySection = document.querySelector<HTMLElement>("#recent-activity")!;
const recentActivityList = document.querySelector<HTMLElement>("#recent-activity-list")!;

const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url")!;
const emailInput = document.querySelector<HTMLInputElement>("#email")!;
const passwordInput = document.querySelector<HTMLInputElement>("#password")!;
const deviceNameInput = document.querySelector<HTMLInputElement>("#device-name")!;
const toggleAdvancedButton = document.querySelector<HTMLButtonElement>("#toggle-advanced")!;
const advancedPanel = document.querySelector<HTMLElement>("#advanced-panel")!;
const advancedChevron = toggleAdvancedButton.querySelector<SVGElement>(".ui-chevron")!;
let lastAcknowledgedRevision = 0;

document.querySelector<HTMLFormElement>("#login-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void runLogin().catch(showError);
});

document.querySelector<HTMLButtonElement>("#logout")!.addEventListener("click", () => {
  void sendMessage<UiState>({ type: "auth/logout" }).then(render).catch(showError);
});

document.querySelector<HTMLButtonElement>("#open-options")!.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

toggleAdvancedButton.addEventListener("click", () => {
  const isExpanded = toggleAdvancedButton.getAttribute("aria-expanded") === "true";
  const next = nextAdvancedToggleState(isExpanded);
  advancedPanel.classList.toggle("hidden", !next.expanded);
  advancedChevron.classList.toggle("ui-chevron--open", next.expanded);
  toggleAdvancedButton.setAttribute("aria-expanded", next.ariaExpanded);
});

void bootstrap().catch(showError);

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
    deviceName: deviceNameInput.value.trim() || "URLises for Chrome",
  };
  const ui = await sendMessage<UiState>({ type: "auth/login", payload: request });
  render(ui);
}

function render(ui: UiState): void {
  const { state } = ui;
  document.documentElement.dataset.theme = state.uiTheme ?? "slate";
  const statusModel = getPopupStatusModel(state);
  const signedInActive = Boolean(state.session);
  signedOut.classList.toggle("hidden", signedInActive);
  signedIn.classList.toggle("hidden", !signedInActive);

  if (!state.session) {
    sessionSummary.textContent = "";
    statusDetail.textContent = "";
    statusDetail.classList.add("hidden");
    lastActivity.textContent = "";
    lastActivity.classList.add("hidden");
    statusIndicators.replaceChildren();
    recentActivitySection.classList.add("hidden");
    recentActivityList.replaceChildren();
    return;
  }

  sessionSummary.textContent = `${state.session.user.email} • ${state.settings.backendUrl}`;
  const showDetail = shouldShowStatusDetail(statusModel.tone);
  statusDetail.textContent = showDetail ? statusModel.detail : "";
  statusDetail.classList.toggle("hidden", !showDetail);
  renderIndicators(statusModel);
  renderLastActivity(statusModel);
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
  if (model.showNewActivity) {
    statusIndicators.appendChild(createIndicator("New updates", "ui-activity-dot", true));
  }
}

function renderLastActivity(model: ReturnType<typeof getPopupStatusModel>): void {
  if (!model.lastActivityLabel) {
    lastActivity.textContent = "";
    lastActivity.classList.add("hidden");
    return;
  }
  lastActivity.textContent = `Last activity ${model.lastActivityLabel}`;
  lastActivity.classList.remove("hidden");
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
