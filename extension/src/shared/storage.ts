import { DEFAULT_BACKEND_URL, STORAGE_KEY } from "./runtime.js";
import type { ActivitySignal, ExtensionState, ProjectionState, QuickSearchScope, SecretReadSignal } from "./types.js";
import { normalizeJournal } from "../background/convergence.js";

let stateMutationQueue: Promise<unknown> = Promise.resolve();

function defaultState(): ExtensionState {
  return {
    settings: {
      backendUrl: DEFAULT_BACKEND_URL,
      clientId: "",
    },
    session: null,
    selectedWorkspaceIds: [],
    cachedOrganizations: [],
    cachedWorkspacesByOrganization: {},
    projectionsByWorkspaceId: {},
    diagnostics: [],
    activitySignal: defaultActivitySignal(),
    secretRecords: [],
    secretReadConfirmations: [],
    secretReadSignal: defaultSecretReadSignal(),
    quickSearchScope: "workspace",
  };
}

export async function getState(): Promise<ExtensionState> {
  const result = await chromeStorageGet<ExtensionState>(STORAGE_KEY);
  const next = { ...defaultState(), ...(result ?? {}) };
  const projectionsByWorkspaceId = Object.fromEntries(
    Object.entries(next.projectionsByWorkspaceId).map(([workspaceId, projection]) => [workspaceId, normalizeProjectionState(projection)]),
  );
  return {
    ...next,
    projectionsByWorkspaceId,
    activitySignal: normalizeActivitySignal({
      ...next,
      projectionsByWorkspaceId,
    }),
    secretRecords: next.secretRecords ?? [],
    secretReadConfirmations: next.secretReadConfirmations ?? [],
    secretReadSignal: normalizeSecretReadSignal(next.secretReadSignal),
    quickSearchScope: normalizeQuickSearchScope(next.quickSearchScope),
  };
}

export async function setState(state: ExtensionState): Promise<void> {
  await enqueueStateMutation(() => chromeStorageSet({ [STORAGE_KEY]: state }));
}

export async function updateState(updater: (state: ExtensionState) => ExtensionState | Promise<ExtensionState>): Promise<ExtensionState> {
  return enqueueStateMutation(async () => {
    const current = await getState();
    const next = await updater(current);
    await chromeStorageSet({ [STORAGE_KEY]: next });
    return next;
  });
}

export async function resetStatePreservingSettings(): Promise<ExtensionState> {
  return updateState((current) => {
    const next = defaultState();
    next.settings = current.settings;
    return next;
  });
}

export function createProjectionState(workspace: ProjectionState["workspace"]): ProjectionState {
  return {
    workspace,
    chromeIdByBackendId: {},
    backendIdByChromeId: {},
    entityTypeByBackendId: {},
    excludedBackendNodeIds: [],
    lastCursor: 0,
    status: "idle",
    socketConnected: false,
    health: "bootstrap",
    recoveryAttemptCount: 0,
    autoRepairAttempts: 0,
    activityRevision: 0,
  };
}

function normalizeProjectionState(projection: ProjectionState): ProjectionState {
  return {
    ...projection,
    socketConnected: projection.socketConnected ?? false,
    health: projection.health ?? deriveLegacyHealth(projection),
    recoveryAttemptCount: projection.recoveryAttemptCount ?? 0,
    // C11: installs that predate this field get a full budget on their first pause after upgrade.
    autoRepairAttempts: projection.autoRepairAttempts ?? 0,
    activityRevision: projection.activityRevision ?? 0,
    convergenceJournal: normalizeJournal(projection.convergenceJournal),
  };
}

function defaultActivitySignal(): ActivitySignal {
  return {
    revision: 0,
    lastSeenRevision: 0,
  };
}

function defaultSecretReadSignal(): SecretReadSignal {
  return {
    revision: 0,
    lastSeenRevision: 0,
  };
}

// Coerces any absent or unrecognized persisted value to "workspace" (the
// documented default, design.md's Persisted Workspace/Global Scope Toggle
// requirement) so a state persisted before this field existed — or a state
// corrupted by a future/unknown value — upgrades cleanly rather than
// throwing or silently disabling the feature.
export function normalizeQuickSearchScope(scope?: QuickSearchScope): QuickSearchScope {
  return scope === "global" ? "global" : "workspace";
}

// Unlike activitySignal, secretReadSignal has no per-workspace projection to
// derive a revision floor from — it is a flat counter incremented only by
// recordSecretRead — so normalization here is just a clamp, not a max-merge.
function normalizeSecretReadSignal(signal?: SecretReadSignal): SecretReadSignal {
  const revision = signal?.revision ?? 0;
  const lastSeenRevision = Math.min(Math.max(signal?.lastSeenRevision ?? 0, 0), revision);
  return { revision, lastSeenRevision };
}

function normalizeActivitySignal(state: Pick<ExtensionState, "activitySignal" | "projectionsByWorkspaceId">): ActivitySignal {
  const derivedRevision = Math.max(
    0,
    ...Object.values(state.projectionsByWorkspaceId).map((projection) => projection.activityRevision ?? 0),
  );
  const revision = Math.max(state.activitySignal?.revision ?? 0, derivedRevision);
  const lastSeenRevision = Math.min(Math.max(state.activitySignal?.lastSeenRevision ?? 0, 0), revision);
  return {
    revision,
    lastSeenRevision,
  };
}

function deriveLegacyHealth(projection: Pick<ProjectionState, "status" | "socketConnected">): ProjectionState["health"] {
  if (projection.status === "error") {
    return "degraded";
  }
  if (projection.status === "syncing") {
    return "recovering";
  }
  if (projection.socketConnected) {
    return "live";
  }
  return "bootstrap";
}

function chromeStorageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items[key] as T | undefined);
    });
  });
}

function chromeStorageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function enqueueStateMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const next = stateMutationQueue.then(mutation, mutation);
  stateMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}
