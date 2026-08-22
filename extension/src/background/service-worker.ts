import { registerBookmarkListeners } from "./bookmark-listeners.js";
import {
  createSecret,
  getUiState,
  handleBookmarkChanged,
  handleBookmarkCreated,
  handleBookmarkMoved,
  handleBookmarkRemoved,
  initializeBackground,
  listSecrets,
  listSecretRecipients,
  loadOptionsState,
  login,
  markActivitySeen,
  markSecretReadSeen,
  logout,
  rebuildWorkspace,
  resyncAll,
  retryWorkspace,
  sendSecretEmail,
  setSelectedWorkspaces,
  setUiTheme,
} from "./projection.js";
import { CREATE_SECRET_WINDOW_ID_KEY, STORAGE_KEY } from "../shared/runtime.js";
import { getState } from "../shared/storage.js";
import { getToolbarBadgeModel } from "../shared/ui/status.js";

registerBookmarkListeners({
  onCreated: handleBookmarkCreated,
  onChanged: handleBookmarkChanged,
  onMoved: handleBookmarkMoved,
  onRemoved: handleBookmarkRemoved,
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(STORAGE_KEY in changes)) {
    return;
  }
  void refreshToolbarBadge();
});

// Keeps the popup's idempotent-open tracking (CREATE_SECRET_WINDOW_ID_KEY,
// see popup/popup.ts) honest when the user closes the create-secret window
// directly rather than via the popup — without this, a stale id would
// linger in session storage until the next click's update()-then-catch
// fallback discovers it's gone.
chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get<Record<string, unknown>>(CREATE_SECRET_WINDOW_ID_KEY).then((result) => {
    if (result[CREATE_SECRET_WINDOW_ID_KEY] === windowId) {
      return chrome.storage.session.remove(CREATE_SECRET_WINDOW_ID_KEY);
    }
  });
});

chrome.runtime.onMessage.addListener((message: { type: string; payload?: unknown }, _sender, sendResponse) => {
  void (async () => {
    switch (message.type) {
      case "auth/login":
        sendResponse(await login(message.payload as never));
        return;
      case "auth/logout":
        sendResponse(await logout());
        return;
      case "session/get":
        sendResponse(await getUiState());
        return;
      case "options/load":
        sendResponse(await loadOptionsState());
        return;
      case "projection/set-workspaces":
        sendResponse(await setSelectedWorkspaces((message.payload as { workspaceIds: string[] }).workspaceIds));
        return;
      case "projection/resync-all":
        sendResponse(await resyncAll());
        return;
      case "projection/retry":
        sendResponse(await retryWorkspace((message.payload as { workspaceId: string }).workspaceId));
        return;
      case "projection/rebuild":
        sendResponse(await rebuildWorkspace((message.payload as { workspaceId: string }).workspaceId));
        return;
      case "diagnostics/get":
        sendResponse(await getUiState());
        return;
      case "ui/mark-activity-seen":
        sendResponse(await markActivitySeen());
        return;
      case "ui/mark-secret-read-seen":
        sendResponse(await markSecretReadSeen());
        return;
      case "secrets/create":
        sendResponse(await createSecret(message.payload as never));
        return;
      case "secrets/send-email":
        sendResponse(await sendSecretEmail(message.payload as never));
        return;
      case "secrets/list":
        sendResponse(await listSecrets());
        return;
      case "secrets/recipients":
        sendResponse(await listSecretRecipients());
        return;
      case "preferences/set-theme":
        sendResponse(await setUiTheme((message.payload as { uiTheme: "slate" | "indigo" | "teal" }).uiTheme));
        return;
      default:
        sendResponse({ error: `unsupported message type ${message.type}` });
    }
  })().catch((error) => {
    sendResponse({
      error: error instanceof Error ? error.message : "unexpected background failure",
    });
  });

  return true;
});

void refreshToolbarBadge();
void initializeBackground();

async function refreshToolbarBadge(): Promise<void> {
  const badge = getToolbarBadgeModel(await getState());
  await setActionBadgeText(badge.text);
  if (badge.backgroundColor) {
    await setActionBadgeBackgroundColor(badge.backgroundColor);
  }
  await setActionTitle(badge.title);
}

function setActionBadgeText(text: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.action.setBadgeText({ text }, resolve);
  });
}

function setActionBadgeBackgroundColor(color: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.action.setBadgeBackgroundColor({ color }, resolve);
  });
}

function setActionTitle(title: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.action.setTitle({ title }, resolve);
  });
}
