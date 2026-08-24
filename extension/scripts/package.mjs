import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(extensionRoot, "release");
const manifestPath = path.join(extensionRoot, "manifest.json");
const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z");

const releaseAllowlist = [
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
  "src/shared/ui/theme.css",
].sort(comparePaths);
const releaseAllowlistSet = new Set(releaseAllowlist);
const packageMetadata = new Set([
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const forbiddenExtensions = [
  ".cts",
  ".key",
  ".map",
  ".mts",
  ".p12",
  ".pem",
  ".pfx",
  ".ts",
  ".tsx",
];

async function main() {
  await prepareReleaseRoot();
  try {
    const mode = process.argv[2];
    if (process.argv.length > 3 || (mode !== undefined && mode !== "--release")) {
      throw new Error("Usage: node scripts/package.mjs [--release]");
    }
    if (mode === "--release") await runReleaseGates();

    const manifest = await loadManifest();
    const version = validateVersion(manifest.version);
    const artifactName = `urlises-for-chrome-${version}.zip`;
    const artifactPath = path.join(releaseRoot, artifactName);
    const temporaryArtifactPath = path.join(releaseRoot, `.${artifactName}.${process.pid}.tmp.zip`);
    const stagingPath = path.join(releaseRoot, `.staging-${artifactName.slice(0, -4)}`);
    const stripsExtraMetadata = await inspectZipExecutable();
    const releaseFiles = await collectReleaseFiles();

    await validateReferencedAssets(manifest, releaseFiles);

    try {
      await mkdir(stagingPath, { recursive: true });
      await stageFiles(stagingPath, releaseFiles);
      await createZip(stagingPath, temporaryArtifactPath, releaseFiles, stripsExtraMetadata);

      const archive = await readFile(temporaryArtifactPath);
      const listing = readZipListing(archive);
      validateZipListing(listing, releaseFiles);

      await rename(temporaryArtifactPath, artifactPath);

      const digest = createHash("sha256").update(archive).digest("hex");
      process.stdout.write(
        [
          "Chrome Web Store package created.",
          `Artifact: ${artifactPath}`,
          `Files: ${listing.length}`,
          `Bytes: ${archive.byteLength}`,
          `SHA-256: ${digest}`,
        ].join("\n") + "\n",
      );
    } finally {
      await rm(stagingPath, { force: true, recursive: true });
      await rm(temporaryArtifactPath, { force: true });
    }
  } catch (error) {
    try {
      await prepareReleaseRoot();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Packaging failed and release output cleanup also failed.");
    }
    throw error;
  }
}

async function runReleaseGates() {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const prefix = npmExecPath ? [npmExecPath] : [];

  for (const script of ["typecheck", "test:projection"]) {
    const result = await runCommand(command, [...prefix, "run", script], {
      cwd: extensionRoot,
      inherit: true,
    });
    if (result.code !== 0) {
      throw new Error(`Release gate failed: npm run ${script} exited with code ${result.code}.`);
    }
  }
}

async function prepareReleaseRoot() {
  await mkdir(releaseRoot, { recursive: true });
  const metadata = await lstat(releaseRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Release path must be a real directory, not a symlink: ${releaseRoot}`);
  }

  for (const entry of await readdir(releaseRoot, { withFileTypes: true })) {
    const isPublishedArtifact = entry.name.startsWith("urlises-for-chrome-") && entry.name.endsWith(".zip");
    const isTemporaryArtifact = entry.name.startsWith(".urlises-for-chrome-") && entry.name.endsWith(".tmp.zip");
    const isStagingPath = entry.name.startsWith(".staging-urlises-for-chrome-");
    if (isPublishedArtifact || isTemporaryArtifact || isStagingPath) {
      await rm(path.join(releaseRoot, entry.name), { force: true, recursive: entry.isDirectory() });
    }
  }
}

async function loadManifest() {
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Required release file is missing or unreadable: ${manifestPath}`, { cause: error });
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${manifestPath}: ${error.message}`, { cause: error });
  }
}

function validateVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,3}$/.test(value)) {
    throw new Error(`manifest.json version must contain one to four dot-separated integers; received ${JSON.stringify(value)}.`);
  }

  const components = value.split(".").map(Number);
  if (components.some((component) => component > 65_535) || components.every((component) => component === 0)) {
    throw new Error(`manifest.json version is not valid for Chrome: ${value}.`);
  }
  return value;
}

async function inspectZipExecutable() {
  let result;
  try {
    result = await runCommand("zip", ["-h"]);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Required system executable 'zip' was not found. Install Info-ZIP (for example, `apt install zip`) and retry.");
    }
    throw error;
  }

  const help = `${result.stdout}\n${result.stderr}`;
  return /(^|\s)-X(?:\s|,|$)/m.test(help);
}

async function collectReleaseFiles() {
  for (const relativePath of releaseAllowlist) {
    const forbiddenReason = getForbiddenReason(relativePath);
    if (forbiddenReason) {
      throw new Error(`Invalid explicit release path ${relativePath}: ${forbiddenReason}.`);
    }
    await assertRegularFile(relativePath);
  }
  return [...releaseAllowlist];
}

async function assertRegularFile(relativePath) {
  const segments = relativePath.split("/");
  let currentPath = extensionRoot;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    let metadata;
    try {
      metadata = await lstat(currentPath);
    } catch (error) {
      const hint = relativePath.startsWith("dist/") ? " Run `npm run build` before invoking the packager directly." : "";
      throw new Error(`Required release file is missing: ${currentPath}.${hint}`, { cause: error });
    }

    if (metadata.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in release inputs: ${currentPath}`);
    }
    const isFile = index === segments.length - 1;
    if ((!isFile && !metadata.isDirectory()) || (isFile && !metadata.isFile())) {
      throw new Error(`Required release path has an unexpected file type: ${currentPath}`);
    }
  }
}

function isAllowlisted(relativePath) {
  return releaseAllowlistSet.has(relativePath);
}

function getForbiddenReason(relativePath) {
  if (/[\x00-\x1f\x7f]/.test(relativePath)) return "ASCII control character";
  if (relativePath.includes("\\") || relativePath.startsWith("/")) return "unsafe path";

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "unsafe path segment";
  if (segments.some((segment) => segment.startsWith("."))) return "hidden path";

  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = lowerSegments.at(-1);
  if (lowerSegments.some((segment) => segment === "node_modules" || segment === "test" || segment === "tests" || segment === "__macosx")) {
    return "test, dependency, or operating-system metadata path";
  }
  if (packageMetadata.has(basename)) return "package metadata";
  if (forbiddenExtensions.some((extension) => basename.endsWith(extension))) return "forbidden source, source-map, or private-key extension";
  if (/(^|[.-])(test|spec)\.[^.]+$/i.test(basename)) return "test file";
  // "secret" appears in some of this extension's own filenames as part of
  // its zero-knowledge secret-sharing feature name (create-secret.*,
  // secret-history.*), not credential material -- excluded here so the
  // allowlisted files don't trip the heuristic below.
  const knownSafeSecretBasenames = new Set(["create-secret.js", "create-secret.html", "secret-history.js"]);
  if (!knownSafeSecretBasenames.has(basename) && /(^|[-_.])(secret|secrets|credential|credentials|private-key)([-_.]|$)/i.test(basename)) return "potential secret";
  if (basename === "thumbs.db" || basename === "desktop.ini") return "operating-system metadata";
  return null;
}

async function validateReferencedAssets(manifest, releaseFiles) {
  const included = new Set(releaseFiles);
  const references = collectManifestReferences(manifest);

  for (const htmlPath of ["src/options/options.html", "src/popup/popup.html"]) {
    const html = await readFile(path.join(extensionRoot, ...htmlPath.split("/")), "utf8");
    for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const reference = resolveLocalReference(htmlPath, match[1]);
      if (reference) references.add(reference);
    }
  }

  for (const reference of [...references].sort(comparePaths)) {
    if (!included.has(reference)) {
      throw new Error(
        `Release asset ${reference} is referenced by manifest.json or packaged HTML but is missing from the package. Run \`npm run build\` and check the release allowlist.`,
      );
    }
  }
}

function collectManifestReferences(manifest) {
  const references = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const reference = resolveLocalReference("manifest.json", value);
    if (reference) references.add(reference);
  };
  const addValues = (value) => {
    if (typeof value === "string") add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(add);
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  addValues(manifest.action?.default_icon);
  addValues(manifest.icons);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.side_panel?.default_path);
  add(manifest.devtools_page);
  addValues(manifest.chrome_url_overrides);
  manifest.sandbox?.pages?.forEach(add);
  manifest.content_scripts?.forEach((contentScript) => {
    contentScript?.js?.forEach(add);
    contentScript?.css?.forEach(add);
  });
  manifest.declarative_net_request?.rule_resources?.forEach((resource) => add(resource?.path));
  manifest.web_accessible_resources?.forEach((resource) => {
    resource?.resources?.filter((value) => !/[?*[{]/.test(value)).forEach(add);
  });

  return references;
}

function resolveLocalReference(ownerPath, rawReference) {
  if (typeof rawReference !== "string" || rawReference === "" || rawReference.startsWith("#")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(rawReference) || rawReference.startsWith("//")) return null;
  if (rawReference.includes("\\") || /[\x00-\x1f\x7f]/.test(rawReference)) {
    throw new Error(`Unsafe local asset reference in ${ownerPath}: ${rawReference}`);
  }

  const pathOnly = rawReference.split(/[?#]/, 1)[0];
  const reference = pathOnly.startsWith("/")
    ? path.posix.normalize(pathOnly.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), pathOnly));
  if (reference === "" || reference === "." || reference === ".." || reference.startsWith("../")) {
    throw new Error(`Local asset reference escapes the extension root in ${ownerPath}: ${rawReference}`);
  }
  return reference;
}

async function stageFiles(stagingPath, releaseFiles) {
  for (const relativePath of releaseFiles) {
    await assertRegularFile(relativePath);
    const sourcePath = path.join(extensionRoot, ...relativePath.split("/"));
    const destinationPath = path.join(stagingPath, ...relativePath.split("/"));
    await mkdir(path.dirname(destinationPath), { recursive: true });

    // Node has no portable openat traversal for every parent component. Packaging therefore
    // requires a trusted, quiescent local checkout; repeated lstat checks, O_NOFOLLOW on the
    // final file, and before/after fstat checks reject ordinary symlink and content races.
    const source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await source.stat();
      const contents = await source.readFile();
      const after = await source.stat();
      if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error(`Release input changed while it was being read: ${sourcePath}`);
      }
      await writeFile(destinationPath, contents, { flag: "wx", mode: 0o644 });
      await chmod(destinationPath, 0o644);
      await utimes(destinationPath, fixedTimestamp, fixedTimestamp);
    } finally {
      await source.close();
    }
  }
}

async function createZip(stagingPath, artifactPath, releaseFiles, stripsExtraMetadata) {
  const unsafePath = releaseFiles.find((relativePath) => /[\x00-\x1f\x7f]/.test(relativePath));
  if (unsafePath !== undefined) {
    throw new Error(`Refusing to pass an ASCII control character to zip -@: ${JSON.stringify(unsafePath)}.`);
  }

  const args = ["-q", "-9"];
  if (stripsExtraMetadata) args.push("-X");
  args.push(artifactPath, "-@");

  const result = await runCommand("zip", args, {
    cwd: stagingPath,
    env: { ...process.env, TZ: "UTC" },
    input: `${releaseFiles.join("\n")}\n`,
  });
  if (result.code !== 0) {
    throw new Error(`zip failed with exit code ${result.code}: ${result.stderr.trim() || "no diagnostic output"}`);
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const inherit = options.inherit === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    if (!inherit) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
    if (!inherit) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    }
  });
}

function readZipListing(archive) {
  const endOfCentralDirectory = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOfCentralDirectory + 10);
  const centralDirectorySize = archive.readUInt32LE(endOfCentralDirectory + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOfCentralDirectory + 16);

  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported for extension release validation.");
  }
  if (archive.readUInt16LE(endOfCentralDirectory + 4) !== 0 || archive.readUInt16LE(endOfCentralDirectory + 6) !== 0) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (centralDirectoryOffset + centralDirectorySize > endOfCentralDirectory) {
    throw new Error("Invalid ZIP central directory bounds.");
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry at index ${index}.`);
    }

    const flags = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length) throw new Error(`Truncated ZIP central directory entry at index ${index}.`);

    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.includes("\uFFFD") || (flags & 0x0001) !== 0) {
      throw new Error(`Unsupported ZIP entry encoding or encryption at index ${index}.`);
    }
    entries.push({ name, uncompressedSize: archive.readUInt32LE(offset + 24) });
    offset = end;
  }

  if (offset !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error("ZIP central directory size does not match its entries.");
  }
  return entries;
}

function findEndOfCentralDirectory(archive) {
  const minimumLength = 22;
  if (archive.length < minimumLength) throw new Error("Generated ZIP is too small to be valid.");

  const minimumOffset = Math.max(0, archive.length - minimumLength - 0xffff);
  for (let offset = archive.length - minimumLength; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + minimumLength + commentLength === archive.length) return offset;
  }
  throw new Error("Generated ZIP has no valid end-of-central-directory record.");
}

function validateZipListing(entries, releaseFiles) {
  const expected = [...releaseFiles].sort(comparePaths);
  const actual = entries.map((entry) => entry.name).sort(comparePaths);
  const unique = new Set(actual);

  if (!unique.has("manifest.json")) throw new Error("Generated ZIP does not contain manifest.json at its root.");
  if (unique.size !== actual.length) throw new Error("Generated ZIP contains duplicate entries.");

  for (const entry of entries) {
    const forbiddenReason = getForbiddenReason(entry.name);
    if (entry.name.endsWith("/") || !isAllowlisted(entry.name) || forbiddenReason) {
      throw new Error(`Generated ZIP contains forbidden entry ${entry.name}${forbiddenReason ? `: ${forbiddenReason}` : ""}.`);
    }
  }

  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    const missing = expected.filter((entry) => !unique.has(entry));
    const unexpected = actual.filter((entry) => !expected.includes(entry));
    throw new Error(`Generated ZIP listing differs from the release allowlist. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`Packaging failed: ${error.message}\n`);
  process.exitCode = 1;
});
