// Extracted from package.mjs (design.md ADR-507) so tests/release-allowlist.test.mjs
// can import the array directly without running a full packaging pass —
// package.mjs calls main() at module scope, so it cannot be imported safely
// from a test.
//
// This is the packager's explicit allowlist: every file shipped in the
// Chrome Web Store zip must be listed here. See package.mjs's
// getForbiddenReason/collectReleaseFiles for the classification and
// existence checks run against every entry.
export const releaseAllowlist = [
  "dist/background/bookmark-listeners.js",
  "dist/background/chrome-bookmarks.js",
  "dist/background/convergence.js",
  "dist/background/projection.js",
  "dist/background/service-worker.js",
  "dist/create-secret/content-limit.js",
  "dist/create-secret/create-secret.js",
  "dist/create-secret/recipient-filter.js",
  "dist/options/options.js",
  "dist/options/secret-history.js",
  "dist/popup/advanced-toggle.js",
  "dist/popup/popup.js",
  "dist/popup/status-detail.js",
  "dist/quick-search/quick-search.js",
  "dist/quick-search/search-results.js",
  "dist/quick-search/workspace-scope.js",
  "dist/shared/api.js",
  "dist/shared/crypto.js",
  "dist/shared/diagnostics.js",
  "dist/shared/exclusions.js",
  "dist/shared/mapping.js",
  "dist/shared/messaging.js",
  "dist/shared/projection-helpers.js",
  "dist/shared/runtime.js",
  "dist/shared/session.js",
  "dist/shared/storage.js",
  "dist/shared/types.js",
  "dist/shared/ui/status.js",
  "dist/shared/websocket.js",
  "dist/shared/window-geometry.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "src/create-secret/create-secret.html",
  "src/options/options.html",
  "src/popup/popup.html",
  "src/quick-search/quick-search.html",
  "src/shared/ui/theme.css",
].sort(comparePaths);

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
