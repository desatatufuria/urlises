import { registerBookmarkListeners } from "./bookmark-listeners.js";
import {
  getUiState,
  handleBookmarkChanged,
  handleBookmarkCreated,
  handleBookmarkMoved,
  handleBookmarkRemoved,
  initializeBackground,
  loadOptionsState,
  login,
  logout,
  resyncAll,
  setSelectedWorkspaces,
} from "./projection.js";

registerBookmarkListeners({
  onCreated: handleBookmarkCreated,
  onChanged: handleBookmarkChanged,
  onMoved: handleBookmarkMoved,
  onRemoved: handleBookmarkRemoved,
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
      case "diagnostics/get":
        sendResponse(await getUiState());
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

void initializeBackground();
