import test from "node:test";
import assert from "node:assert/strict";

import { computeCenteredWindowPosition } from "../dist/shared/window-geometry.js";

// RED: the create-secret popup should land centered inside whatever browser
// window is currently focused, not wherever Chrome's default placement puts
// it (usually top-left).
test("centers the target window within a typical single-monitor browser window", () => {
  const current = { left: 0, top: 0, width: 1280, height: 800 };
  const position = computeCenteredWindowPosition(current, { width: 420, height: 500 });
  assert.deepEqual(position, { left: 430, top: 150 });
});

// RED: multi-monitor setups put the focused window at a non-zero origin —
// the centered position must be relative to that origin, not the screen's.
test("accounts for a non-zero current window origin (secondary monitor placement)", () => {
  const current = { left: 1920, top: 100, width: 1000, height: 900 };
  const position = computeCenteredWindowPosition(current, { width: 420, height: 500 });
  assert.deepEqual(position, { left: 2210, top: 300 });
});

// RED: fractional midpoints (odd current width/height) must round to a
// whole pixel, never leak a float into chrome.windows.create's left/top.
test("rounds fractional centered coordinates to the nearest integer", () => {
  const current = { left: 10, top: 20, width: 1281, height: 801 };
  const position = computeCenteredWindowPosition(current, { width: 420, height: 500 });
  assert.deepEqual(position, { left: 441, top: 171 });
});

// RED: chrome.windows.getCurrent()'s bounds are typed optional. If any of
// them is missing, omit left/top entirely so the caller lets Chrome choose
// a position instead of passing NaN into chrome.windows.create.
test("omits left/top when any current window bound is undefined", () => {
  assert.deepEqual(computeCenteredWindowPosition({}, { width: 420, height: 500 }), {});
  assert.deepEqual(
    computeCenteredWindowPosition({ left: 0, top: 0, width: undefined, height: 800 }, { width: 420, height: 500 }),
    {},
  );
});
