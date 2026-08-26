// Pure logic for the quick-search surface: no chrome.*, no DOM, unit-tested
// directly under node --test (see design.md ADR-505/ADR-506). The entry
// file (quick-search.ts) wires these into chrome.bookmarks.search and the
// page's DOM, following this repo's existing coverage boundary — see
// create-secret.ts:6-10.

export const RESULT_CAP = 50;
export const SEARCH_DEBOUNCE_MS = 120;

export interface SearchResultView {
  id: string;
  title: string;
  url: string;
}

interface SearchableBookmarkNode {
  id: string;
  title?: string;
  url?: string;
}

/**
 * Converts raw chrome.bookmarks.search() nodes into render-ready views,
 * dropping folders (no `url`) since they are not openable results. Chrome's
 * own ordering is preserved verbatim — no re-sorting.
 */
export function toResultViews(nodes: SearchableBookmarkNode[]): SearchResultView[] {
  const views: SearchResultView[] = [];
  for (const node of nodes) {
    if (!node.url) continue;
    views.push({ id: node.id, title: node.title ?? "", url: node.url });
  }
  return views;
}

/**
 * Caps the result list at `cap` (default RESULT_CAP), reporting whether
 * truncation happened so the caller can show the "refine your search" hint.
 * Must be called *after* the scope filter, never before — capping first
 * would silently hide workspace matches behind personal ones in Chrome's
 * ordering (design.md §5).
 */
export function capResults(views: SearchResultView[], cap: number = RESULT_CAP): { results: SearchResultView[]; truncated: boolean } {
  if (views.length <= cap) {
    return { results: views, truncated: false };
  }
  return { results: views.slice(0, cap), truncated: true };
}

/**
 * Computes the next highlight index for ArrowUp/ArrowDown, wrapping at both
 * ends. Returns -1 for an empty list regardless of direction or current
 * index — there is nothing to highlight.
 */
export function nextHighlightIndex(current: number, key: "ArrowUp" | "ArrowDown", length: number): number {
  if (length <= 0) return -1;
  if (key === "ArrowDown") return (current + 1) % length;
  return (current - 1 + length) % length;
}

export interface Debouncer {
  schedule(run: () => void): void;
  cancel(): void;
}

/**
 * Coalesces a burst of schedule() calls into a single run, delayMs after
 * the last call. cancel() suppresses a pending run without scheduling a
 * new one — used to clear stale results the instant the input is emptied
 * (design.md ADR-505's "empty query short-circuits the debouncer").
 */
export function createDebouncer(delayMs: number): Debouncer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(run: () => void): void {
      if (handle !== undefined) clearTimeout(handle);
      handle = setTimeout(() => {
        handle = undefined;
        run();
      }, delayMs);
    },
    cancel(): void {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

export interface QuerySequencer {
  begin(): number;
  isLatest(token: number): boolean;
}

/**
 * A monotonic token sequencer, independent from (and necessary in addition
 * to) the debouncer (design.md ADR-505): debouncing bounds how often a
 * search starts, but chrome.bookmarks.search() is async IPC whose responses
 * can resolve out of order. begin() is called both when a new search is
 * scheduled and from the input handler itself, so an in-flight search is
 * invalidated the moment the user types again.
 */
export function createQuerySequencer(): QuerySequencer {
  let latest = 0;
  return {
    begin(): number {
      latest += 1;
      return latest;
    },
    isLatest(token: number): boolean {
      return token === latest;
    },
  };
}
