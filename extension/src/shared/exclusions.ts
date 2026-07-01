import type { ProjectionState } from "./types.js";

export function addExclusion(projection: ProjectionState, backendId: string): ProjectionState {
  const next = new Set(projection.excludedBackendNodeIds);
  next.add(backendId);
  projection.excludedBackendNodeIds = [...next];
  return projection;
}

export function pruneExclusions(projection: ProjectionState, validBackendIds: Set<string>): ProjectionState {
  projection.excludedBackendNodeIds = projection.excludedBackendNodeIds.filter((id) => validBackendIds.has(id));
  return projection;
}

export function removeExclusions(projection: ProjectionState, backendIds: Iterable<string>): ProjectionState {
  const removedIds = new Set(backendIds);
  if (removedIds.size === 0) {
    return projection;
  }
  projection.excludedBackendNodeIds = projection.excludedBackendNodeIds.filter((id) => !removedIds.has(id));
  return projection;
}

export function isExcluded(projection: ProjectionState, backendId: string | undefined): boolean {
  if (!backendId) {
    return false;
  }
  return projection.excludedBackendNodeIds.includes(backendId);
}
