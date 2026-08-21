// Pure helper for centering a chrome.windows.create()'d popup window inside
// whatever browser window is currently focused. Kept side-effect free (no
// chrome.* access) so it can be unit tested directly, mirroring
// create-secret/content-limit.ts and popup/advanced-toggle.ts.

/** Subset of chrome.windows.Window's geometry fields — all optional to
 * match chrome.windows.getCurrent()'s type, which allows them to be
 * undefined (e.g. on windows without a known position/size yet). */
export interface WindowBoundsInput {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface WindowTargetSize {
  width: number;
  height: number;
}

export interface CenteredWindowPosition {
  left?: number;
  top?: number;
}

/**
 * Computes the `left`/`top` to pass into chrome.windows.create() so a
 * window of `target` size lands centered within `current` (the currently
 * focused browser window's bounds).
 *
 * If any of `current`'s bounds is undefined — chrome.windows.getCurrent()'s
 * type allows this — this returns `{}` so the caller omits `left`/`top`
 * and lets Chrome choose a default position instead of passing NaN.
 */
export function computeCenteredWindowPosition(
  current: WindowBoundsInput,
  target: WindowTargetSize,
): CenteredWindowPosition {
  const { left, top, width, height } = current;
  if (left === undefined || top === undefined || width === undefined || height === undefined) {
    return {};
  }
  return {
    left: Math.round(left + (width - target.width) / 2),
    top: Math.round(top + (height - target.height) / 2),
  };
}
