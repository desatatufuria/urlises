// Entry glue for the quick-search surface: bootstrap, debounced search loop,
// render, keyboard/mouse selection, open-and-close. DOM and chrome.* wiring
// in this file is intentionally not unit tested, matching this repo's
// existing coverage boundary — see create-secret.ts:6-10. The pure logic it
// depends on (search-results.ts) is unit tested under tests/quick-search-results.test.mjs.

import { QUICK_SEARCH_TARGET_WINDOW_ID_KEY } from "../shared/runtime.js";
import { sendMessage } from "../shared/messaging.js";
import type { UiState } from "../shared/types.js";
import {
  RESULT_CAP,
  SEARCH_DEBOUNCE_MS,
  capResults,
  createDebouncer,
  createQuerySequencer,
  nextHighlightIndex,
  type SearchResultView,
} from "./search-results.js";

const searchInput = document.querySelector<HTMLInputElement>("#quick-search-input")!;
const resultsList = document.querySelector<HTMLUListElement>("#quick-search-results")!;
const hint = document.querySelector<HTMLElement>("#quick-search-hint")!;

const debouncer = createDebouncer(SEARCH_DEBOUNCE_MS);
const sequencer = createQuerySequencer();

let currentResults: SearchResultView[] = [];
let highlightIndex = -1;

searchInput.addEventListener("input", onInput);
document.addEventListener("keydown", onKeyDown);

// One delegated click listener on the list, not per-item: the list is
// rebuilt on every render (design.md §8, following create-secret.ts's
// recipient list wiring).
resultsList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const item = target.closest<HTMLElement>("[data-index]");
  if (!item?.dataset.index) return;
  void openResult(Number(item.dataset.index));
});

void bootstrap().catch(() => undefined);

async function bootstrap(): Promise<void> {
  const ui = await sendMessage<UiState>({ type: "session/get" });
  document.documentElement.dataset.theme = ui.state.uiTheme ?? "slate";
  searchInput.focus();
}

function onInput(): void {
  const query = searchInput.value.trim();
  const token = sequencer.begin();

  if (!query) {
    debouncer.cancel();
    renderEmpty();
    return;
  }

  debouncer.schedule(() => {
    void runSearch(query, token);
  });
}

async function runSearch(query: string, token: number): Promise<void> {
  let nodes: chrome.bookmarks.BookmarkTreeNode[];
  try {
    nodes = await chrome.bookmarks.search(query);
  } catch {
    nodes = [];
  }
  if (!sequencer.isLatest(token)) return; // a newer keystroke already won; drop this response

  const views = nodes.filter((node): node is chrome.bookmarks.BookmarkTreeNode & { url: string } => Boolean(node.url));
  const { results, truncated } = capResults(
    views.map((node) => ({ id: node.id, title: node.title ?? "", url: node.url })),
    RESULT_CAP,
  );
  render(results, truncated, query);
}

function renderEmpty(): void {
  currentResults = [];
  highlightIndex = -1;
  resultsList.replaceChildren();
  hint.textContent = "Type to search your bookmarks.";
}

function render(results: SearchResultView[], truncated: boolean, query: string): void {
  currentResults = results;
  highlightIndex = results.length > 0 ? 0 : -1; // first result highlighted by default (ADR-506)

  resultsList.replaceChildren(
    ...results.map((result, index) => {
      const item = document.createElement("li");
      item.dataset.index = String(index);
      item.setAttribute("role", "option");
      if (index === highlightIndex) item.classList.add("ui-result--active");

      const title = document.createElement("span");
      title.className = "ui-result-title";
      title.textContent = result.title || result.url;
      const url = document.createElement("span");
      url.className = "ui-result-url";
      url.textContent = result.url;

      item.append(title, url);
      return item;
    }),
  );

  if (results.length === 0) {
    hint.textContent = `No bookmarks match "${query}".`;
  } else if (truncated) {
    hint.textContent = "Showing the first 50 — refine your search.";
  } else {
    hint.textContent = "";
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    window.close();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveHighlight(event.key);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (highlightIndex >= 0) void openResult(highlightIndex);
  }
}

function moveHighlight(key: "ArrowUp" | "ArrowDown"): void {
  if (currentResults.length === 0) return;
  highlightIndex = nextHighlightIndex(highlightIndex, key, currentResults.length);
  for (const item of Array.from(resultsList.children)) {
    if (!(item instanceof HTMLElement)) continue;
    item.classList.toggle("ui-result--active", item.dataset.index === String(highlightIndex));
  }
}

async function openResult(index: number): Promise<void> {
  const result = currentResults[index];
  if (!result) return;

  const windowId = await getTargetWindowId();
  try {
    if (windowId !== undefined) {
      await chrome.tabs.create({ url: result.url, windowId });
      await chrome.windows.update(windowId, { focused: true });
    } else {
      await chrome.windows.create({ url: result.url, focused: true });
    }
  } catch {
    await chrome.windows.create({ url: result.url, focused: true });
  }
  window.close();
}

async function getTargetWindowId(): Promise<number | undefined> {
  const result = await chrome.storage.session.get<Record<string, unknown>>(QUICK_SEARCH_TARGET_WINDOW_ID_KEY);
  const value = result[QUICK_SEARCH_TARGET_WINDOW_ID_KEY];
  return typeof value === "number" ? value : undefined;
}
