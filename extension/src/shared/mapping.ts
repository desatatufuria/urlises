import type { ProjectionState } from "./types.js";

export function setMapping(
  projection: ProjectionState,
  backendId: string,
  chromeId: string,
  entityType: "folder" | "bookmark",
): ProjectionState {
  projection.chromeIdByBackendId[backendId] = chromeId;
  projection.backendIdByChromeId[chromeId] = backendId;
  projection.entityTypeByBackendId[backendId] = entityType;
  return projection;
}

export function removeMappingsByChromeIds(projection: ProjectionState, chromeIds: string[]): ProjectionState {
  for (const chromeId of chromeIds) {
    const backendId = projection.backendIdByChromeId[chromeId];
    if (!backendId) {
      continue;
    }
    delete projection.backendIdByChromeId[chromeId];
    delete projection.chromeIdByBackendId[backendId];
    delete projection.entityTypeByBackendId[backendId];
  }
  return projection;
}

export function removeMappingsByBackendIds(projection: ProjectionState, backendIds: Iterable<string>): ProjectionState {
  for (const backendId of backendIds) {
    removeMappingByBackendId(projection, backendId);
  }
  return projection;
}

export function removeMappingByBackendId(projection: ProjectionState, backendId: string): ProjectionState {
  const chromeId = projection.chromeIdByBackendId[backendId];
  if (chromeId) {
    delete projection.backendIdByChromeId[chromeId];
  }
  delete projection.chromeIdByBackendId[backendId];
  delete projection.entityTypeByBackendId[backendId];
  return projection;
}
