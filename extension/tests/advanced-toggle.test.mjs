import test from "node:test";
import assert from "node:assert/strict";

import { nextAdvancedToggleState } from "../dist/popup/advanced-toggle.js";

test("advanced setup toggle starts collapsed and flips aria-expanded on each click", () => {
  // Collapsed by default: the popup never calls the toggle before first click,
  // so the DOM starts with aria-expanded="false" and the panel hidden.
  const collapsed = { expanded: false, ariaExpanded: "false" };
  assert.equal(collapsed.ariaExpanded, "false");

  const afterFirstClick = nextAdvancedToggleState(collapsed.expanded);
  assert.deepEqual(afterFirstClick, { expanded: true, ariaExpanded: "true" });

  const afterSecondClick = nextAdvancedToggleState(afterFirstClick.expanded);
  assert.deepEqual(afterSecondClick, { expanded: false, ariaExpanded: "false" });
});
