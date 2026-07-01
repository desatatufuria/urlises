import { DEFAULT_BACKEND_URL, STORAGE_KEY } from "./runtime.js";
import type { ExtensionState, ProjectionState } from "./types.js";

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
  };
}

export async function getState(): Promise<ExtensionState> {
  const result = await chromeStorageGet<ExtensionState>(STORAGE_KEY);
  return { ...defaultState(), ...(result ?? {}) };
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
  };
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
