import test from "node:test";
import assert from "node:assert/strict";

import { pruneExclusions, removeExclusions } from "../dist/shared/exclusions.js";
import { filterFoldersForProjection } from "../dist/shared/projection-helpers.js";
import { runCoalescedWorkspaceTask } from "../dist/background/projection.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createProjection(overrides = {}) {
  return {
    workspace: {
      workspaceId: "workspace-1",
      workspaceName: "Workspace",
      workspaceType: "shared",
      organizationId: "org-1",
      organizationName: "Org",
      role: "viewer",
    },
    chromeIdByBackendId: {},
    backendIdByChromeId: {},
    entityTypeByBackendId: {},
    excludedBackendNodeIds: [],
    lastCursor: 0,
    status: "ready",
    ...overrides,
  };
}

test("filterFoldersForProjection preserves local exclusions across snapshot rebuilds", () => {
  const projection = createProjection({
    excludedBackendNodeIds: ["folder-hidden", "bookmark-hidden"],
  });

  const filtered = filterFoldersForProjection([
    {
      id: "folder-visible",
      name: "Visible Folder",
      position: 0,
      folders: [
        {
          id: "folder-hidden",
          name: "Hidden Folder Renamed Remotely",
          position: 0,
          folders: [],
          bookmarks: [
            {
              id: "bookmark-under-hidden-folder",
              folderId: "folder-hidden",
              title: "Should stay hidden with parent",
              url: "https://example.com/hidden-parent",
              position: 0,
            },
          ],
        },
      ],
      bookmarks: [
        {
          id: "bookmark-visible",
          folderId: "folder-visible",
          title: "Visible Bookmark",
          url: "https://example.com/visible",
          position: 0,
        },
        {
          id: "bookmark-hidden",
          folderId: "folder-visible",
          title: "Hidden Bookmark Renamed Remotely",
          url: "https://example.com/hidden-bookmark",
          position: 1,
        },
      ],
    },
  ], projection);

  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0].folders, []);
  assert.deepEqual(filtered[0].bookmarks.map((bookmark) => bookmark.id), ["bookmark-visible"]);
});

test("removeExclusions clears mapped descendant exclusions after canonical folder deletion", () => {
  const projection = createProjection({
    excludedBackendNodeIds: ["folder-a", "folder-b", "bookmark-c", "bookmark-keep"],
  });

  removeExclusions(projection, ["folder-a", "folder-b", "bookmark-c"]);

  assert.deepEqual(projection.excludedBackendNodeIds, ["bookmark-keep"]);
});

test("pruneExclusions drops deleted subtree exclusions during resync", () => {
  const projection = createProjection({
    excludedBackendNodeIds: ["folder-deleted", "bookmark-deleted", "folder-still-visible"],
  });

  pruneExclusions(projection, new Set(["folder-still-visible", "bookmark-still-visible"]));

  assert.deepEqual(projection.excludedBackendNodeIds, ["folder-still-visible"]);
});

test("runCoalescedWorkspaceTask coalesces burst triggers into one follow-up run", async () => {
  const locks = new Map();
  const runs = [];
  const firstPass = deferred();
  const secondPass = deferred();

  let invocation = 0;
  const runner = async (reason) => {
    runs.push(reason);
    invocation += 1;
    if (invocation === 1) {
      await firstPass.promise;
      return;
    }
    await secondPass.promise;
  };

  const initial = runCoalescedWorkspaceTask(locks, "workspace-1", "initial trigger", runner);
  await Promise.resolve();

  const waitingA = runCoalescedWorkspaceTask(locks, "workspace-1", "burst trigger A", runner);
  const waitingB = runCoalescedWorkspaceTask(locks, "workspace-1", "burst trigger B", runner);

  assert.deepEqual(runs, ["initial trigger"]);
  firstPass.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(runs, ["initial trigger", "burst trigger B"]);
  secondPass.resolve();

  await Promise.all([initial, waitingA, waitingB]);
  assert.deepEqual(runs, ["initial trigger", "burst trigger B"]);
  assert.equal(locks.size, 0);
});
