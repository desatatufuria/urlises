import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseAllowlist } from "../scripts/release-allowlist.mjs";

// RED (design.md ADR-507): validateReferencedAssets only scans HTML
// href/src attributes, so a helper module reachable solely via an ES
// `import` inside another module (e.g. search-results.js imported by
// quick-search.js) is never checked against the allowlist by the existing
// packaging gates. This test pins the invariant directly: every emitted
// dist/**/*.js file must be in the allowlist, and every dist/... allowlist
// entry must correspond to a file that was actually built — in both
// directions, so neither a missing-from-allowlist nor a
// missing-from-disk-but-still-allowlisted drift can ship silently.
//
// Requires `npm run build` to have already run so dist/ exists — guaranteed
// by `npm run test:projection` (package.json), which builds first.

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(extensionRoot, "dist");

test("every emitted dist/**/*.js file is present in the release allowlist", async () => {
  const emitted = await collectDistJsFiles();
  const allowlisted = new Set(releaseAllowlist.filter((entry) => entry.startsWith("dist/") && entry.endsWith(".js")));

  const missingFromAllowlist = [...emitted].filter((entry) => !allowlisted.has(entry));
  assert.deepEqual(missingFromAllowlist, [], `dist/**/*.js files missing from releaseAllowlist: ${missingFromAllowlist.join(", ")}`);
});

test("every dist/*.js entry in the release allowlist corresponds to an emitted file", async () => {
  const emitted = await collectDistJsFiles();
  const allowlisted = releaseAllowlist.filter((entry) => entry.startsWith("dist/") && entry.endsWith(".js"));

  const missingOnDisk = allowlisted.filter((entry) => !emitted.has(entry));
  assert.deepEqual(missingOnDisk, [], `releaseAllowlist dist/*.js entries missing from disk: ${missingOnDisk.join(", ")}`);
});

async function collectDistJsFiles() {
  const results = new Set();
  await walk(distRoot, "dist");
  return results;

  async function walk(absoluteDir, relativeDir) {
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`${absoluteDir} does not exist — run \`npm run build\` before this test (test:projection does this automatically).`, { cause: error });
      }
      throw error;
    }
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        results.add(relativePath);
      }
    }
  }
}
