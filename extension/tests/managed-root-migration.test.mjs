import test from "node:test";
import assert from "node:assert/strict";

import { ensureManagedPath } from "../dist/background/chrome-bookmarks.js";
import { createChromeHarness } from "./helpers/fake-chrome.mjs";

const call = (method, ...args) => new Promise((resolve) => method(...args, resolve));

function bookmarkTree(children) {
  return {
    id: "0",
    title: "",
    children: [
      { id: "1", title: "Bookmarks bar", children: [] },
      { id: "2", title: "Other Bookmarks", children },
    ],
  };
}

async function withChrome(tree, run) {
  const harness = createChromeHarness({ tree });
  globalThis.chrome = harness.chrome;
  try {
    await run(harness);
  } finally {
    delete globalThis.chrome;
    harness.teardown();
  }
}

test("renames the exact legacy managed root in place", async () => {
  const tree = bookmarkTree([
    {
      id: "legacy-root",
      title: "Shared Bookmarks",
      children: [
        {
          id: "organization-acme",
          title: "Acme",
          children: [{ id: "workspace-oda", title: "OdA", children: [] }],
        },
      ],
    },
  ]);

  await withChrome(tree, async (harness) => {
    const path = await ensureManagedPath("Acme", "OdA");

    assert.deepEqual(path, {
      rootId: "legacy-root",
      organizationId: "organization-acme",
      workspaceId: "workspace-oda",
    });
    assert.equal((await call(harness.chrome.bookmarks.get, "legacy-root"))[0].title, "URLises");
    assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "2")).map(({ id, title }) => ({ id, title })), [
      { id: "legacy-root", title: "URLises" },
    ]);
  });
});

test("prefers an existing URLises root without merging or deleting the legacy root", async () => {
  const tree = bookmarkTree([
    {
      id: "urlises-root",
      title: "URLises",
      children: [
        {
          id: "organization-acme",
          title: "Acme",
          children: [{ id: "workspace-oda", title: "OdA", children: [] }],
        },
      ],
    },
    {
      id: "legacy-root",
      title: "Shared Bookmarks",
      children: [{ id: "legacy-content", title: "Keep me", children: [] }],
    },
  ]);

  await withChrome(tree, async (harness) => {
    const path = await ensureManagedPath("Acme", "OdA");

    assert.equal(path.rootId, "urlises-root");
    assert.equal((await call(harness.chrome.bookmarks.get, "legacy-root"))[0].title, "Shared Bookmarks");
    assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "legacy-root")).map(({ id, title }) => ({ id, title })), [
      { id: "legacy-content", title: "Keep me" },
    ]);
    assert.deepEqual((await call(harness.chrome.bookmarks.getChildren, "2")).map(({ id, title }) => ({ id, title })), [
      { id: "urlises-root", title: "URLises" },
      { id: "legacy-root", title: "Shared Bookmarks" },
    ]);
  });
});

test("creates URLises when neither current nor exact legacy root exists", async () => {
  const tree = bookmarkTree([
    { id: "near-match", title: "Shared Bookmarks (old)", children: [] },
    { id: "bookmark-match", title: "Shared Bookmarks", url: "https://example.com" },
  ]);

  await withChrome(tree, async (harness) => {
    const path = await ensureManagedPath("Acme", "OdA");
    const roots = await call(harness.chrome.bookmarks.getChildren, "2");
    const bookmarkMatch = roots.find((node) => node.id === "bookmark-match");
    const selectedRoot = roots.find((node) => node.id === path.rootId);

    assert.equal(bookmarkMatch?.title, "Shared Bookmarks");
    assert.notEqual(path.rootId, bookmarkMatch?.id);
    assert.equal(selectedRoot?.title, "URLises");
    assert.equal(selectedRoot?.url, undefined);
    assert.equal(roots.find((node) => node.id === "near-match")?.title, "Shared Bookmarks (old)");
    assert.equal(bookmarkMatch?.url, "https://example.com");
  });
});
