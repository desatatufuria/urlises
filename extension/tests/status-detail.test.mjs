import test from "node:test";
import assert from "node:assert/strict";

import { shouldShowStatusDetail } from "../dist/popup/status-detail.js";

test("status detail sentence is shown only when the popup tone needs attention", () => {
  // Attention is the one case with genuinely new information to explain
  // before the user clicks into Settings.
  assert.equal(shouldShowStatusDetail("attention"), true);

  // Neutral and live tones are already fully conveyed by the status pill,
  // so the detail sentence would just repeat "everything is fine".
  assert.equal(shouldShowStatusDetail("neutral"), false);
  assert.equal(shouldShowStatusDetail("live"), false);
});
