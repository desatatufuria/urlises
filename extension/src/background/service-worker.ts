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
  setQuickSearchScope,
  setSelectedWorkspaces,
  setUiTheme,
} from "./projection.js";
import {
  CREATE_SECRET_WINDOW_ID_KEY,
  QUICK_SEARCH_TARGET_WINDOW_ID_KEY,
  QUICK_SEARCH_WINDOW_ID_KEY,
  STORAGE_KEY,
} from "../shared/runtime.js";
import { getState } from "../shared/storage.js";
import { computeCenteredWindowPosition } from "../shared/window-geometry.js";
import { getToolbarBadgeModel } from "../shared/ui/status.js";

// Window size constants stay local to this file, matching popup.ts's
// CREATE_SECRET_WINDOW_WIDTH/HEIGHT split — runtime.ts holds only
// cross-context keys and URLs, not per-window geometry (design.md §12).
const QUICK_SEARCH_WINDOW_WIDTH = 480;
const QUICK_SEARCH_WINDOW_HEIGHT = 420;

// Tracked window ids swept by the onRemoved listener below when the user
// closes a tracked window directly (not via its opener's idempotent-open
// helper). Generalized from the single-key CREATE_SECRET_WINDOW_ID_KEY
// listener (design.md §2.2/§12) so a second tracked window (quick-search)
// doesn't need a second listener.
const TRACKED_WINDOW_ID_KEYS = [CREATE_SECRET_WINDOW_ID_KEY, QUICK_SEARCH_WINDOW_ID_KEY];

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

// Keeps every tracked window's idempotent-open bookkeeping honest when the
// user closes it directly rather than via its opener's button/shortcut —
// without this, a stale id would linger in session storage until the next
// open's update()-then-catch fallback discovers it's gone. Generalized to
// TRACKED_WINDOW_ID_KEYS (currently create-secret and quick-search) so a
// new tracked window never needs a second onRemoved listener.
chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get<Record<string, unknown>>(TRACKED_WINDOW_ID_KEYS).then((result) => {
    const staleKey = TRACKED_WINDOW_ID_KEYS.find((key) => result[key] === windowId);
    if (staleKey !== undefined) {
      return chrome.storage.session.remove(staleKey);
    }
  });
});

// Registered synchronously at top level so an evicted MV3 worker is woken
// and still receives the command (design.md ADR-501).
chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-quick-search") return;
  void openOrFocusQuickSearchWindow().catch(() => undefined);
});

async function openOrFocusQuickSearchWindow(): Promise<void> {
  const host = await resolveTabHostWindow(); // ADR-502
  if (host?.id !== undefined) {
    await chrome.storage.session.set({ [QUICK_SEARCH_TARGET_WINDOW_ID_KEY]: host.id });
  }

  const stored = await getStoredWindowId(QUICK_SEARCH_WINDOW_ID_KEY);
  if (stored !== undefined && (await tryFocusWindow(stored))) {
    return;
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("src/quick-search/quick-search.html"),
    type: "popup",
    width: QUICK_SEARCH_WINDOW_WIDTH,
    height: QUICK_SEARCH_WINDOW_HEIGHT,
    focused: true,
    ...computeCenteredWindowPosition(host ?? {}, { width: QUICK_SEARCH_WINDOW_WIDTH, height: QUICK_SEARCH_WINDOW_HEIGHT }),
  });
  if (created?.id !== undefined) {
    await chrome.storage.session.set({ [QUICK_SEARCH_WINDOW_ID_KEY]: created.id });
  }
}

// resolveTabHostWindow captures the last focused *normal* window at the
// instant the shortcut fires (design.md ADR-502) — by the time the user
// picks a result, chrome.windows.getLastFocused() would return the
// quick-search popup itself (it is focused), and a type:"popup" window
// cannot host a tab. windowTypes on getLastFocused is deprecated, so the
// normal-window check is done here instead of via that filter.
async function resolveTabHostWindow(): Promise<chrome.windows.Window | undefined> {
  try {
    const candidate = await chrome.windows.getLastFocused();
    return candidate.type === "normal" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function getStoredWindowId(key: string): Promise<number | undefined> {
  const result = await chrome.storage.session.get<Record<string, unknown>>(key);
  const value = result[key];
  return typeof value === "number" ? value : undefined;
}

async function tryFocusWindow(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.update(windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

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
      case "quick-search/set-scope":
        sendResponse(await setQuickSearchScope((message.payload as { scope: "workspace" | "global" }).scope));
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
