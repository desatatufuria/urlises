import test from "node:test";
import assert from "node:assert/strict";

import {
  RESULT_CAP,
  SEARCH_DEBOUNCE_MS,
  capResults,
  createDebouncer,
  createQuerySequencer,
  nextHighlightIndex,
  toResultViews,
} from "../dist/quick-search/search-results.js";

// RED: chrome.bookmarks.search() returns folders too (title matches, no
// url) — they are not openable and must be dropped before the scope filter
// and the cap ever see them. Order is Chrome's own ordering, preserved.
test("toResultViews drops folders (no url) and preserves Chrome's order", () => {
  const nodes = [
    { id: "1", title: "Docs folder" },
    { id: "2", title: "Docs — Getting Started", url: "https://example.com/docs" },
    { id: "3", title: "Docs — API", url: "https://example.com/api" },
  ];
  assert.deepEqual(toResultViews(nodes), [
    { id: "2", title: "Docs — Getting Started", url: "https://example.com/docs" },
    { id: "3", title: "Docs — API", url: "https://example.com/api" },
  ]);
});

test("toResultViews defaults a missing title to an empty string", () => {
  const nodes = [{ id: "1", url: "https://example.com" }];
  assert.deepEqual(toResultViews(nodes), [{ id: "1", title: "", url: "https://example.com" }]);
});

test("RESULT_CAP is 50 and SEARCH_DEBOUNCE_MS is 120", () => {
  assert.equal(RESULT_CAP, 50);
  assert.equal(SEARCH_DEBOUNCE_MS, 120);
});

test("capResults returns every result untruncated when at or under the cap", () => {
  const views = Array.from({ length: 50 }, (_, index) => ({ id: String(index), title: "", url: "https://x" }));
  const { results, truncated } = capResults(views, 50);
  assert.equal(results.length, 50);
  assert.equal(truncated, false);
});

test("capResults truncates at the cap and reports truncated", () => {
  const views = Array.from({ length: 75 }, (_, index) => ({ id: String(index), title: "", url: "https://x" }));
  const { results, truncated } = capResults(views, 50);
  assert.equal(results.length, 50);
  assert.equal(truncated, true);
  assert.equal(results[0].id, "0");
  assert.equal(results[49].id, "49");
});

test("capResults defaults to RESULT_CAP when no cap is provided", () => {
  const views = Array.from({ length: 51 }, (_, index) => ({ id: String(index), title: "", url: "https://x" }));
  const { results, truncated } = capResults(views);
  assert.equal(results.length, RESULT_CAP);
  assert.equal(truncated, true);
});

test("nextHighlightIndex defaults highlighting the first item is handled by the caller, not this function", () => {
  // nextHighlightIndex only computes movement; ADR-506's "highlight 0 after
  // render" is the caller's responsibility (quick-search.ts), not this pure
  // helper's. This test documents the boundary.
  assert.equal(nextHighlightIndex(0, "ArrowDown", 3), 1);
});

test("nextHighlightIndex moves down and wraps past the last item back to 0", () => {
  assert.equal(nextHighlightIndex(0, "ArrowDown", 3), 1);
  assert.equal(nextHighlightIndex(1, "ArrowDown", 3), 2);
  assert.equal(nextHighlightIndex(2, "ArrowDown", 3), 0);
});

test("nextHighlightIndex moves up and wraps before the first item back to the last", () => {
  assert.equal(nextHighlightIndex(2, "ArrowUp", 3), 1);
  assert.equal(nextHighlightIndex(0, "ArrowUp", 3), 2);
});

test("nextHighlightIndex returns -1 for an empty list regardless of direction", () => {
  assert.equal(nextHighlightIndex(0, "ArrowDown", 0), -1);
  assert.equal(nextHighlightIndex(-1, "ArrowUp", 0), -1);
});

test("createQuerySequencer accepts the latest token and drops a stale one", () => {
  const sequencer = createQuerySequencer();
  const first = sequencer.begin();
  const second = sequencer.begin();
  assert.equal(sequencer.isLatest(first), false);
  assert.equal(sequencer.isLatest(second), true);
});

test("createQuerySequencer treats the very first token as latest until a newer one begins", () => {
  const sequencer = createQuerySequencer();
  const token = sequencer.begin();
  assert.equal(sequencer.isLatest(token), true);
});

test("createDebouncer coalesces a burst of schedule() calls into a single run", (t) => {
  t.mock.timers.enable(["setTimeout"]);
  const debouncer = createDebouncer(120);
  let runs = 0;
  debouncer.schedule(() => { runs += 1; });
  t.mock.timers.tick(50);
  debouncer.schedule(() => { runs += 1; });
  t.mock.timers.tick(50);
  debouncer.schedule(() => { runs += 1; });
  t.mock.timers.tick(120);
  assert.equal(runs, 1);
});

test("createDebouncer's cancel() suppresses a pending scheduled run", (t) => {
  t.mock.timers.enable(["setTimeout"]);
  const debouncer = createDebouncer(120);
  let runs = 0;
  debouncer.schedule(() => { runs += 1; });
  debouncer.cancel();
  t.mock.timers.tick(120);
  assert.equal(runs, 0);
});

test("createDebouncer runs again for a schedule() call after the delay has elapsed", (t) => {
  t.mock.timers.enable(["setTimeout"]);
  const debouncer = createDebouncer(120);
  let runs = 0;
  debouncer.schedule(() => { runs += 1; });
  t.mock.timers.tick(120);
  debouncer.schedule(() => { runs += 1; });
  t.mock.timers.tick(120);
  assert.equal(runs, 2);
});
