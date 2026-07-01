import type { ExtensionState, UiState } from "../shared/types.js";

const summary = document.querySelector<HTMLElement>("#summary")!;
const workspaceGroups = document.querySelector<HTMLElement>("#workspace-groups")!;
const diagnosticsNode = document.querySelector<HTMLElement>("#diagnostics")!;

document.querySelector<HTMLButtonElement>("#save-selection")!.addEventListener("click", () => {
  const selected = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-workspace-id]:checked")).map((input) => input.dataset.workspaceId!);
  void sendMessage<UiState>({ type: "projection/set-workspaces", payload: { workspaceIds: selected } })
    .then(render)
    .catch(showError);
});

document.querySelector<HTMLButtonElement>("#resync-all")!.addEventListener("click", () => {
  void sendMessage<UiState>({ type: "projection/resync-all" }).then(render).catch(showError);
});

void load();

async function load(): Promise<void> {
  const ui = await sendMessage<UiState>({ type: "options/load" });
  render(ui);
}

function render(ui: UiState): void {
  const state = ui.state;
  if (!state.session) {
    summary.textContent = "Sign in from the popup before selecting workspaces.";
    workspaceGroups.innerHTML = "";
    diagnosticsNode.textContent = "No active session.";
    return;
  }

  summary.textContent = `Signed in as ${state.session.user.email}. Select the workspaces that should be projected under Shared Bookmarks / Organization / Workspace.`;
  workspaceGroups.innerHTML = "";

  for (const organization of state.cachedOrganizations) {
    const panel = document.createElement("section");
    panel.className = "panel";
    const heading = document.createElement("h3");
    heading.textContent = `${organization.organizationName} (${organization.role})`;
    panel.appendChild(heading);

    const workspaceList = document.createElement("div");
    workspaceList.className = "workspace";
    const workspaces = state.cachedWorkspacesByOrganization[organization.organizationId] ?? [];
    for (const workspace of workspaces) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.workspaceId = workspace.workspaceId;
      checkbox.checked = state.selectedWorkspaceIds.includes(workspace.workspaceId);
      label.appendChild(checkbox);
      label.append(` ${workspace.workspaceName} (${workspace.role})`);
      workspaceList.appendChild(label);
    }
    panel.appendChild(workspaceList);
    workspaceGroups.appendChild(panel);
  }

  diagnosticsNode.textContent = formatDiagnostics(state);
}

function formatDiagnostics(state: ExtensionState): string {
  const projectionLines = Object.values(state.projectionsByWorkspaceId).map((projection) => {
    return `${projection.workspace.workspaceName}: status=${projection.status}, cursor=${projection.lastCursor}, socket=${projection.socketConnected ? "connected" : "disconnected"}, exclusions=${projection.excludedBackendNodeIds.length}${projection.lastError ? `, error=${projection.lastError}` : ""}`;
  });

  const diagnosticLines = state.diagnostics.map((entry) => `${entry.time} [${entry.level}] ${entry.scope}: ${entry.message}`);
  return [...projectionLines, "", ...diagnosticLines].join("\n").trim() || "No diagnostics yet.";
}

function showError(error: unknown): void {
  diagnosticsNode.textContent = error instanceof Error ? error.message : "Unexpected options error";
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
