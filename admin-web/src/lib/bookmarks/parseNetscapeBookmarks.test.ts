import { describe, expect, it } from "vitest";
import { BookmarkParseError, parseNetscapeBookmarks } from "./parseNetscapeBookmarks";

// Real Chrome export shape: a folder's child <DL> lands INSIDE its <DT>,
// per HTML5 tree-construction rules (a <dl> start tag does not close an
// open <dt>). This is the shape a browser's own "Export bookmarks" produces.
const chromeExportFixture = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/one" ADD_DATE="1700000001" ICON="data:image/png;base64,abc">Example One</A>
        <DT><H3 ADD_DATE="1700000002">Work</H3>
        <DL><p>
            <DT><A HREF="https://example.com/two" ADD_DATE="1700000003">Example Two</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://example.com/three" ADD_DATE="1700000004">Example Three</A>
</DL><p>
`;

// A sibling-shaped export: sanitizers and non-browser exporters emit the
// nested <DL> as a SIBLING of its <DT>, not nested inside it. Both shapes
// must parse identically (design.md D1.2).
const siblingExportFixture = `<DL><p>
    <DT><H3>Bookmarks bar</H3>
    </DT>
    <DL><p>
        <DT><A HREF="https://example.com/one">Example One</A></DT>
        <DT><H3>Work</H3></DT>
        <DL><p>
            <DT><A HREF="https://example.com/two">Example Two</A></DT>
        </DL>
    </DL>
</DL>
`;

describe("parseNetscapeBookmarks", () => {
  it("parses a real Chrome export fixture into a node tree whose nesting matches the source file", () => {
    const result = parseNetscapeBookmarks(chromeExportFixture);

    // Root: [Bookmarks bar (folder), Example Three (bookmark)] — the
    // fixture's closing </DL> tags place "Example Three" back at the
    // outer list's level, a sibling of "Bookmarks bar", not its child.
    expect(result.roots).toHaveLength(2);
    const [bar, three] = result.roots;
    if (bar.kind !== "folder") throw new Error("expected a folder");
    expect(bar.name).toBe("Bookmarks bar");
    expect(bar.children).toHaveLength(2);

    const [one, work] = bar.children;
    if (one.kind !== "bookmark") throw new Error("expected a bookmark");
    expect(one.title).toBe("Example One");
    expect(one.url).toBe("https://example.com/one");

    if (work.kind !== "folder") throw new Error("expected a folder");
    expect(work.name).toBe("Work");
    expect(work.children).toHaveLength(1);
    const two = work.children[0];
    if (two.kind !== "bookmark") throw new Error("expected a bookmark");
    expect(two.title).toBe("Example Two");
    expect(two.url).toBe("https://example.com/two");

    if (three.kind !== "bookmark") throw new Error("expected a bookmark");
    expect(three.title).toBe("Example Three");

    // folders: Bookmarks bar, Work (2); bookmarks: one, two, three (3)
    expect(result.nodeCount).toBe(5);
    expect(result.topLevelBookmarkCount).toBe(1);
  });

  it("parses nested <DL> inside <DT> and nested <DL> as a sibling of <DT> identically", () => {
    const nested = parseNetscapeBookmarks(chromeExportFixture);
    const sibling = parseNetscapeBookmarks(siblingExportFixture);

    function shape(nodes: typeof nested.roots): unknown {
      return nodes.map((node) =>
        node.kind === "folder" ? { kind: "folder", name: node.name, children: shape(node.children) } : { kind: "bookmark", title: node.title, url: node.url },
      );
    }

    // Sibling fixture has no "Example Three" trailing bookmark — compare
    // only the shared subtree (Bookmarks bar > [Example One, Work > [Example Two]]).
    expect(shape(sibling.roots)).toEqual([
      {
        kind: "folder",
        name: "Bookmarks bar",
        children: [
          { kind: "bookmark", title: "Example One", url: "https://example.com/one" },
          { kind: "folder", name: "Work", children: [{ kind: "bookmark", title: "Example Two", url: "https://example.com/two" }] },
        ],
      },
    ]);

    const nestedBar = nested.roots[0];
    if (nestedBar.kind !== "folder") throw new Error("expected a folder");
    expect(shape(nestedBar.children.slice(0, 2))).toEqual([
      { kind: "bookmark", title: "Example One", url: "https://example.com/one" },
      { kind: "folder", name: "Work", children: [{ kind: "bookmark", title: "Example Two", url: "https://example.com/two" }] },
    ]);
  });

  it("handles 3-level nesting, ignores <DD>/<H1>/<META>/PERSONAL_TOOLBAR_FOLDER/ADD_DATE/ICON, and falls back to the URL for an empty title", () => {
    const threeLevel = `<DL><p>
      <DT><H3>Level 1</H3>
      <DL><p>
        <DT><H3>Level 2</H3>
        <DL><p>
          <DT><H3>Level 3</H3>
          <DL><p>
            <DT><A HREF="https://example.com/deep"></A>
            <DD>A description that must be ignored
          </DL>
        </DL>
      </DL>
    </DL>`;

    const result = parseNetscapeBookmarks(threeLevel);
    const level1 = result.roots[0];
    if (level1.kind !== "folder") throw new Error("expected folder");
    const level2 = level1.children[0];
    if (level2.kind !== "folder") throw new Error("expected folder");
    const level3 = level2.children[0];
    if (level3.kind !== "folder") throw new Error("expected folder");
    expect(level3.children).toHaveLength(1);
    const deep = level3.children[0];
    if (deep.kind !== "bookmark") throw new Error("expected bookmark");
    // Empty title falls back to the URL.
    expect(deep.title).toBe("https://example.com/deep");
    expect(deep.url).toBe("https://example.com/deep");
    // The <DD> description contributes no node — nodeCount only reflects
    // the 3 folders + 1 bookmark actually parsed.
    expect(result.nodeCount).toBe(4);
  });

  it("skips javascript:, place:, data:, chrome://, and missing href entries with the correct reason, never counting them", () => {
    const html = `<DL><p>
      <DT><A HREF="javascript:alert(1)">JS link</A>
      <DT><A HREF="place:sort=1">Place link</A>
      <DT><A HREF="data:text/html,hi">Data link</A>
      <DT><A HREF="chrome://settings">Chrome link</A>
      <DT><A>No href</A>
      <DT><A HREF="">Empty href</A>
      <DT><A HREF="https://example.com/kept">Kept link</A>
    </DL>`;

    const result = parseNetscapeBookmarks(html);

    expect(result.roots).toHaveLength(1);
    expect(result.nodeCount).toBe(1);
    expect(result.skipped).toHaveLength(6);
    expect(result.skipped.filter((entry) => entry.reason === "unsupported-scheme")).toHaveLength(4);
    expect(result.skipped.filter((entry) => entry.reason === "missing-href")).toHaveLength(2);
  });

  it("throws BookmarkParseError for non-bookmark HTML (no <dl>), and for a <dl> with zero nodes", () => {
    expect(() => parseNetscapeBookmarks("<html><body><p>Not a bookmarks file</p></body></html>")).toThrow(BookmarkParseError);
    expect(() => parseNetscapeBookmarks("<DL><p></DL>")).toThrow(BookmarkParseError);
  });

  it("never executes a <script> or an onerror-bearing <img>, and inserts no parsed node into the live document", () => {
    const originalBodyChildCount = document.body.childElementCount;
    let executed = false;
    // A global the injected script would call if it ever actually ran.
    (window as unknown as { __shouldNeverRun?: () => void }).__shouldNeverRun = () => {
      executed = true;
    };

    const malicious = `<DL><p>
      <DT><A HREF="https://example.com/safe">Safe link</A>
      <script>window.__shouldNeverRun && window.__shouldNeverRun();</script>
      <img src="x" onerror="window.__shouldNeverRun && window.__shouldNeverRun();" />
    </DL>`;

    const result = parseNetscapeBookmarks(malicious);

    expect(executed).toBe(false);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(document.body.childElementCount).toBe(originalBodyChildCount);
    expect(result.roots).toHaveLength(1);

    delete (window as unknown as { __shouldNeverRun?: () => void }).__shouldNeverRun;
  });
});
