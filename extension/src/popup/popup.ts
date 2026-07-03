import { DEFAULT_BACKEND_URL } from "../shared/runtime.js";
import type { ExtensionState, LoginRequest, UiState } from "../shared/types.js";

const signedOut = document.querySelector<HTMLElement>("#signed-out")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const errorNode = document.querySelector<HTMLElement>("#error")!;
const sessionSummary = document.querySelector<HTMLElement>("#session-summary")!;
const workspaceSummary = document.querySelector<HTMLElement>("#workspace-summary")!;

const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url")!;
const emailInput = document.querySelector<HTMLInputElement>("#email")!;
const passwordInput = document.querySelector<HTMLInputElement>("#password")!;
const deviceNameInput = document.querySelector<HTMLInputElement>("#device-name")!;

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
  const signedInActive = Boolean(state.session);
  signedOut.classList.toggle("hidden", signedInActive);
  signedIn.classList.toggle("hidden", !signedInActive);

  if (!state.session) {
    sessionSummary.textContent = "";
    workspaceSummary.textContent = "";
    return;
  }

  const selectedCount = state.selectedWorkspaceIds.length;
  sessionSummary.textContent = `${state.session.user.email} • ${state.settings.backendUrl}`;
  workspaceSummary.textContent = `${selectedCount} workspace${selectedCount === 1 ? "" : "s"} selected for projection.`;
}

function showError(error: unknown): void {
  errorNode.textContent = error instanceof Error ? error.message : "Unexpected popup error";
}

function clearError(): void {
  errorNode.textContent = "";
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
