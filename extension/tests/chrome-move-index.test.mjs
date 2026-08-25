import test from "node:test";
import assert from "node:assert/strict";
import { chromeMoveIndex } from "../dist/background/chrome-bookmarks.js";

test("chromeMoveIndex compensates only same-parent forward moves (T-M1)", () => {
  const cases = [
    { name: "same parent, forward by one (the incident)", input: { oldParentId: "p", oldIndex: 0, parentId: "p", index: 1 }, expected: 2 },
    { name: "same parent, forward by many (0 -> 2)", input: { oldParentId: "p", oldIndex: 0, parentId: "p", index: 2 }, expected: 3 },
    { name: "same parent, forward by many (1 -> 5)", input: { oldParentId: "p", oldIndex: 1, parentId: "p", index: 5 }, expected: 6 },
    { name: "same parent, backward (3 -> 1), unchanged", input: { oldParentId: "p", oldIndex: 3, parentId: "p", index: 1 }, expected: 1 },
    { name: "same parent, index === oldIndex, unreachable in production but pinned", input: { oldParentId: "p", oldIndex: 2, parentId: "p", index: 2 }, expected: 2 },
    { name: "cross-parent, forward, unchanged", input: { oldParentId: "p", oldIndex: 0, parentId: "q", index: 1 }, expected: 1 },
    { name: "cross-parent, backward, unchanged", input: { oldParentId: "p", oldIndex: 5, parentId: "q", index: 0 }, expected: 0 },
  ];

  for (const { name, input, expected } of cases) {
    const literal = { ...input };
    const result = chromeMoveIndex(input);
    assert.equal(result, expected, name);
    assert.deepEqual(input, literal, `${name}: input object must not be mutated (C1 guard)`);
    assert.equal(Number.isInteger(result), true, `${name}: result must be a total, defined integer`);
  }
});
