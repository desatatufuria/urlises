import test from "node:test";
import assert from "node:assert/strict";

import {
  formatUiTimestamp,
  formatProjectionActivity,
  getFreshWorkspaceActivity,
  getToolbarBadgeModel,
  getPopupStatusModel,
  getStatusOverview,
  getWorkspaceStatusModel,
  hasProjectionFreshActivity,
  hasUnseenActivity,
} from "../dist/shared/ui/status.js";

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
    socketConnected: true,
    health: "live",
    recoveryAttemptCount: 0,
    activityRevision: 0,
    ...overrides,
  };
}

function createState(overrides = {}) {
  const projection = createProjection();
  return {
    settings: { backendUrl: "http://localhost:8081", clientId: "client-1" },
    session: {
      accessToken: "token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      clientId: "client-1",
      user: { id: "user-1", email: "user@example.com" },
    },
    selectedWorkspaceIds: ["workspace-1"],
    cachedOrganizations: [],
    cachedWorkspacesByOrganization: {},
    projectionsByWorkspaceId: { "workspace-1": projection },
    diagnostics: [],
    activitySignal: { revision: 0, lastSeenRevision: 0 },
    ...overrides,
  };
}

test("status overview counts live and degraded workspaces", () => {
  const state = createState({
    selectedWorkspaceIds: ["workspace-1", "workspace-2"],
    projectionsByWorkspaceId: {
      "workspace-1": createProjection(),
      "workspace-2": createProjection({
        workspace: {
          workspaceId: "workspace-2",
          workspaceName: "Workspace B",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        health: "degraded",
        socketConnected: false,
      }),
    },
  });

  assert.deepEqual(getStatusOverview(state), {
    selectedWorkspaceCount: 2,
    activeWorkspaceCount: 2,
    liveWorkspaceCount: 1,
    degradedWorkspaceCount: 1,
  });
});

test("popup status model surfaces unseen activity without noise", () => {
  const state = createState({
    activitySignal: { revision: 3, lastSeenRevision: 1 },
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        activityRevision: 3,
        lastActivityAt: "2026-07-03T16:00:00.000Z",
        lastActivity: {
          entityType: "bookmark",
          action: "updated",
          label: "Remote Bookmark",
        },
      }),
    },
  });

  const model = getPopupStatusModel(state);
  assert.equal(model.showNewActivity, true);
  assert.equal(model.showOnline, true);
  assert.equal(model.statusLabel, "Healthy sync");
  assert.equal(model.lastActivityLabel, "2026-07-03 18:00:00 CEST");
   assert.deepEqual(model.recentActivity, [{
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    summary: "Bookmark updated · Remote Bookmark",
    lastActivityLabel: "2026-07-03 18:00:00 CEST",
  }]);
});

test("workspace status model keeps degraded sync explicit", () => {
  const model = getWorkspaceStatusModel(createProjection({
    health: "degraded",
    socketConnected: false,
    degradedReason: "replay gap detected",
  }), { revision: 4, lastSeenRevision: 4 });

  assert.equal(model.tone, "attention");
  assert.equal(model.statusLabel, "Degraded sync");
  assert.match(model.detail, /replay gap detected/);
  assert.equal(model.showNewActivity, false);
});

test("toolbar badge prefers degraded state over unseen activity and clears when seen", () => {
  const degraded = getToolbarBadgeModel(createState({
    activitySignal: { revision: 4, lastSeenRevision: 2 },
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        activityRevision: 4,
        health: "degraded",
        socketConnected: false,
      }),
    },
  }));

  assert.equal(degraded.text, "•");
  assert.equal(degraded.backgroundColor, "#c34043");

  const activity = getToolbarBadgeModel(createState({
    activitySignal: { revision: 4, lastSeenRevision: 2 },
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        activityRevision: 4,
      }),
    },
  }));

  assert.equal(activity.text, "•");
  assert.equal(activity.backgroundColor, "#7e9cd8");

  const cleared = getToolbarBadgeModel(createState({
    activitySignal: { revision: 4, lastSeenRevision: 4 },
  }));

  assert.equal(cleared.text, "");
  assert.equal(cleared.backgroundColor, undefined);
});

test("UI timestamps use Europe/Madrid with DST-aware labels", () => {
  assert.equal(formatUiTimestamp("2026-01-03T16:00:00.000Z"), "2026-01-03 17:00:00 CET");
  assert.equal(formatUiTimestamp("2026-07-03T16:00:00.000Z"), "2026-07-03 18:00:00 CEST");
});

test("activity helpers hide seen revisions and show fresh ones", () => {
  assert.equal(hasUnseenActivity({ revision: 2, lastSeenRevision: 1 }), true);
  assert.equal(hasUnseenActivity({ revision: 2, lastSeenRevision: 2 }), false);
  assert.equal(hasProjectionFreshActivity({ activityRevision: 4 }, { revision: 4, lastSeenRevision: 3 }), true);
  assert.equal(hasProjectionFreshActivity({ activityRevision: 3 }, { revision: 4, lastSeenRevision: 3 }), false);
});

test("activity formatting keeps workspace and item summaries lightweight", () => {
  assert.equal(formatProjectionActivity({
    entityType: "workspace",
    action: "resynced",
    label: "Workspace",
  }), "Projection resynced · Workspace");
  assert.equal(formatProjectionActivity({
    entityType: "bookmark",
    action: "updated",
    label: "Remote Bookmark",
    parentLabel: "Docs",
  }), "Bookmark updated · Remote Bookmark in Docs");
});

test("fresh workspace activity is sorted by newest revision", () => {
  const state = createState({
    activitySignal: { revision: 4, lastSeenRevision: 2 },
    projectionsByWorkspaceId: {
      "workspace-1": createProjection({
        activityRevision: 3,
        lastActivityAt: "2026-07-03T16:00:00.000Z",
        lastActivity: { entityType: "folder", action: "updated", label: "Docs" },
      }),
      "workspace-2": createProjection({
        workspace: {
          workspaceId: "workspace-2",
          workspaceName: "Workspace B",
          workspaceType: "shared",
          organizationId: "org-1",
          organizationName: "Org",
          role: "editor",
        },
        activityRevision: 4,
        lastActivityAt: "2026-07-03T16:05:00.000Z",
        lastActivity: { entityType: "bookmark", action: "created", label: "Launch plan" },
      }),
    },
  });

  assert.deepEqual(getFreshWorkspaceActivity(state).map((item) => item.workspaceId), ["workspace-2", "workspace-1"]);
});
