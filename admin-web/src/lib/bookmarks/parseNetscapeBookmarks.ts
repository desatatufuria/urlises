// Client-side Netscape bookmarks.html parser (design.md "Model" /
// Phase D1). Pure and DOM-free of the LIVE document: `DOMParser` produces a
// detached Document that is never attached to `document`, so any <script>
// or event-handler attribute in the uploaded file never executes
// (Threat Matrix: Untrusted HTML parsing).

export interface ParsedFolder {
  kind: "folder";
  key: string;
  name: string;
  children: ParsedNode[];
}

export interface ParsedBookmark {
  kind: "bookmark";
  key: string;
  title: string;
  url: string;
}

export type ParsedNode = ParsedFolder | ParsedBookmark;

export interface SkippedEntry {
  title: string;
  rawHref: string;
  reason: "unsupported-scheme" | "missing-href";
}

export interface ParseResult {
  roots: ParsedNode[];
  /** folders + bookmarks, EXCLUDING skipped entries. */
  nodeCount: number;
  /** Drives the Decision 17 pre-flight check (root-level bookmarks). */
  topLevelBookmarkCount: number;
  skipped: SkippedEntry[];
}

export class BookmarkParseError extends Error {}

/**
 * Mirrors the backend's `validateURL` (bookmarks/service.go:777): only
 * http/https with a non-empty host is importable. `javascript:`, `place:`,
 * `data:`, `chrome://` and malformed URLs are all rejected.
 */
function isImportableUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * A folder's nested <DL> normally lands INSIDE its <DT> (HTML5 tree
 * construction: a <dl> start tag does not close an open <dt>) — that's
 * covered by `:scope > dl` inside `dt`. But sanitizers and non-browser
 * exporters emit the nested list as a SIBLING of the <DT> instead. This
 * walks `dt`'s following element siblings (skipping stray <p> spacers,
 * which the Netscape format uses liberally) looking for the first <dl>;
 * it stops at the first non-<p>/non-<dl> sibling (typically the next
 * <dt>), so it can never cross into an unrelated list.
 */
function siblingDl(dt: Element): Element | null {
  let sibling = dt.nextElementSibling;
  while (sibling) {
    if (sibling.tagName === "P") {
      sibling = sibling.nextElementSibling;
      continue;
    }
    if (sibling.tagName === "DL") {
      return sibling;
    }
    break;
  }
  return null;
}

function folderChildrenList(dt: Element): Element | null {
  return dt.querySelector(":scope > dl") ?? siblingDl(dt);
}

interface KeyCounter {
  value: number;
}

function nextKey(counter: KeyCounter): string {
  const key = `n${counter.value}`;
  counter.value += 1;
  return key;
}

/**
 * Iterates `:scope > dt` ONLY. Direct-child scoping is mandatory: because a
 * folder's nested <DL> can land inside its own <DT>, `dl.querySelectorAll("dt")`
 * would return every descendant <dt> (grandchildren included) and flatten
 * the entire tree into one level.
 */
function parseList(dl: Element, skipped: SkippedEntry[], counter: KeyCounter): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  const directChildDts = dl.querySelectorAll(":scope > dt");

  directChildDts.forEach((dt) => {
    const h3 = dt.querySelector(":scope > h3");
    const a = dt.querySelector(":scope > a");

    if (h3) {
      const childList = folderChildrenList(dt);
      const children = childList ? parseList(childList, skipped, counter) : [];
      nodes.push({
        kind: "folder",
        key: nextKey(counter),
        name: h3.textContent?.trim() || "Untitled folder",
        children,
      });
      return;
    }

    if (a) {
      const href = a.getAttribute("href");
      const label = a.textContent?.trim() ?? "";

      if (!href) {
        skipped.push({ title: label, rawHref: href ?? "", reason: "missing-href" });
        return;
      }

      if (!isImportableUrl(href)) {
        skipped.push({ title: label || href, rawHref: href, reason: "unsupported-scheme" });
        return;
      }

      nodes.push({
        kind: "bookmark",
        key: nextKey(counter),
        title: label || href,
        url: href,
      });
      return;
    }

    // Neither <H3> nor <A> — e.g. a bare <DD>, ignored.
  });

  return nodes;
}

function countNodes(nodes: ParsedNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "folder") {
      count += countNodes(node.children);
    }
  }
  return count;
}

export function parseNetscapeBookmarks(html: string): ParseResult {
  // Parsed-not-loaded: scripts never execute, and nothing here is ever
  // inserted into the live `document`.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rootDl = doc.querySelector("dl");
  if (!rootDl) {
    throw new BookmarkParseError("This file is not a Netscape bookmarks export — no <DL> list was found.");
  }

  const skipped: SkippedEntry[] = [];
  const counter: KeyCounter = { value: 0 };
  const roots = parseList(rootDl, skipped, counter);
  const nodeCount = countNodes(roots);

  if (nodeCount === 0) {
    throw new BookmarkParseError("No bookmarks or folders were found in this file.");
  }

  const topLevelBookmarkCount = roots.filter((node) => node.kind === "bookmark").length;

  return { roots, nodeCount, topLevelBookmarkCount, skipped };
}
