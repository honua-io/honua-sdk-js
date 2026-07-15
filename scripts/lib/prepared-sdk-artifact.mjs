import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PREPARED_SDK_ARTIFACT_FORMAT = "honua.prepared-sdk-artifact.v1";
export const PREPARED_SDK_RUN_ID_ENV = "HONUA_PREPARED_SDK_RUN_ID";
export const PREPARED_SDK_MANIFEST_PATH = path.join(".tmp", "prepared-sdk-artifact", "manifest.json");

const BUILD_INPUT_ROOTS = ["src", "test", "bench", "scripts", "config"];
const BUILD_INPUT_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  ".nvmrc",
  "LICENSE",
];
const REQUIRED_DIST_FILES = [
  "dist/src/migration/cli.js",
  "dist/src/esri-compat-entry.js",
  "dist/src/honua.js",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_TREE_FILES = 200_000;

export function manifestPathFor(projectRoot) {
  return path.join(projectRoot, PREPARED_SDK_MANIFEST_PATH);
}

export function snapshotBuildInputs(projectRoot) {
  const files = [];
  for (const relativePath of BUILD_INPUT_FILES) {
    collectFile(projectRoot, relativePath, files);
  }
  for (const relativePath of BUILD_INPUT_ROOTS) {
    collectTree(projectRoot, relativePath, files, (candidate) => !isExcludedBuildInput(candidate));
  }
  return snapshotFiles(projectRoot, files, "SDK build inputs");
}

export function snapshotDistTree(projectRoot) {
  const files = [];
  collectTree(projectRoot, "dist", files, () => true);
  const snapshot = snapshotFiles(projectRoot, files, "SDK dist tree");
  const paths = new Set(snapshot.entries.map((entry) => entry.path));
  for (const requiredPath of REQUIRED_DIST_FILES) {
    if (!paths.has(requiredPath)) {
      throw new Error(`Prepared SDK dist tree is incomplete: missing ${requiredPath}`);
    }
  }
  return snapshot;
}

export function readPreparedSdkManifest(projectRoot) {
  const manifestPath = manifestPathFor(projectRoot);
  let bytes;
  try {
    bytes = fs.readFileSync(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Prepared SDK manifest does not exist: ${manifestPath}. Run \`npm run prepare:test-sdk\` before Vitest.`,
      );
    }
    throw error;
  }
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`Prepared SDK manifest has an invalid size: ${bytes.length}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Prepared SDK manifest is not valid JSON: ${error.message}`);
  }
  validateManifest(manifest);
  return manifest;
}

export function verifyPreparedSdkArtifact(options) {
  const {
    projectRoot,
    expectedRunId,
    expectedInputSha256,
    expectedDistSha256,
    verifyTrees = true,
  } = options;
  const manifest = readPreparedSdkManifest(projectRoot);

  if (expectedRunId && manifest.runId !== expectedRunId) {
    throw new Error(`Prepared SDK run changed during Vitest: expected ${expectedRunId}, received ${manifest.runId}`);
  }
  if (expectedInputSha256 && manifest.inputs.sha256 !== expectedInputSha256) {
    throw new Error("Prepared SDK source digest changed during Vitest");
  }
  if (expectedDistSha256 && manifest.dist.sha256 !== expectedDistSha256) {
    throw new Error("Prepared SDK dist digest changed during Vitest");
  }

  if (verifyTrees) {
    try {
      assertSnapshotEqual("SDK build inputs", manifest.inputs, snapshotBuildInputs(projectRoot));
      assertSnapshotEqual("SDK dist tree", manifest.dist, snapshotDistTree(projectRoot));
    } catch (error) {
      throw new Error(
        `Prepared SDK artifact is stale or incomplete: ${error.message}. Run \`npm run prepare:test-sdk\` before Vitest.`,
      );
    }
  }
  return manifest;
}

export function verifyManifestArtifact(projectRoot, manifest, relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const entry = manifest.dist.entries.find((candidate) => candidate.path === normalizedPath);
  if (!entry) {
    throw new Error(`Prepared SDK manifest does not own ${normalizedPath}`);
  }
  let observed;
  try {
    observed = snapshotFiles(projectRoot, [normalizedPath], `prepared SDK artifact ${normalizedPath}`).entries[0];
  } catch (error) {
    if (isMissingOrInvalidFileError(error)) {
      throw new Error(`Prepared SDK artifact changed or was removed during Vitest: ${normalizedPath}`);
    }
    throw error;
  }
  if (!observed || observed.sha256 !== entry.sha256 || observed.bytes !== entry.bytes) {
    throw new Error(`Prepared SDK artifact changed during Vitest: ${normalizedPath}`);
  }
  return path.join(projectRoot, ...normalizedPath.split("/"));
}

export function prepareSdkArtifact(options) {
  const { projectRoot, mode = "build-if-needed", runBuild } = options;
  if (!["build-if-needed", "force-build", "already-prepared", "capture", "adopt-additions"].includes(mode)) {
    throw new Error(`Unsupported prepared SDK mode: ${mode}`);
  }

  if (mode === "already-prepared") {
    const current = verifyPreparedSdkArtifact({ projectRoot });
    return publishVerifiedManifest(projectRoot, current.inputs, current.dist);
  }

  if (mode === "adopt-additions") {
    const current = readPreparedSdkManifest(projectRoot);
    assertSnapshotEqual("SDK build inputs", current.inputs, snapshotBuildInputs(projectRoot));
    const nextDist = snapshotDistTree(projectRoot);
    assertOwnedDistEntriesUnchanged(current.dist, nextDist);
    return publishVerifiedManifest(projectRoot, current.inputs, nextDist);
  }

  if (mode === "build-if-needed") {
    try {
      const current = verifyPreparedSdkArtifact({ projectRoot });
      return publishVerifiedManifest(projectRoot, current.inputs, current.dist);
    } catch {
      if (typeof runBuild !== "function") {
        throw new Error("Prepared SDK artifact needs a rebuild, but no build owner was provided");
      }
    }
  }

  const inputsBefore = snapshotBuildInputs(projectRoot);
  removePreparedSdkManifest(projectRoot);
  if (mode === "build-if-needed" || mode === "force-build") {
    if (typeof runBuild !== "function") {
      throw new Error("Prepared SDK artifact needs a rebuild, but no build owner was provided");
    }
    try {
      runBuild();
    } catch (error) {
      removePreparedSdkManifest(projectRoot);
      throw new Error(`Prepared SDK build failed without publishing a manifest: ${error.message}`);
    }
  }

  const inputsAfter = snapshotBuildInputs(projectRoot);
  assertSnapshotEqual("SDK build inputs changed while preparing artifacts", inputsBefore, inputsAfter);
  const dist = snapshotDistTree(projectRoot);
  return publishVerifiedManifest(projectRoot, inputsAfter, dist);
}

export function publishPreparedSdkManifest(projectRoot, inputs, dist) {
  validateSnapshot(inputs, "inputs");
  validateSnapshot(dist, "dist");
  const manifest = {
    format: PREPARED_SDK_ARTIFACT_FORMAT,
    runId: randomUUID(),
    preparedAt: new Date().toISOString(),
    inputs,
    dist,
  };
  validateManifest(manifest);

  const serialized = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (serialized.length > MAX_MANIFEST_BYTES) {
    throw new Error(`Prepared SDK manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }

  const manifestPath = manifestPathFor(projectRoot);
  const manifestDir = path.dirname(manifestPath);
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(manifestDir, `.manifest-${process.pid}-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, manifestPath);
    fsyncDirectory(manifestDir);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
  }
  return manifest;
}

export function removePreparedSdkManifest(projectRoot) {
  fs.rmSync(manifestPathFor(projectRoot), { force: true });
}

function assertOwnedDistEntriesUnchanged(previous, observed) {
  const observedByPath = new Map(observed.entries.map((entry) => [entry.path, entry]));
  for (const entry of previous.entries) {
    const observedEntry = observedByPath.get(entry.path);
    if (!observedEntry || observedEntry.bytes !== entry.bytes || observedEntry.sha256 !== entry.sha256) {
      throw new Error(`Prepared SDK dist entry was removed or mutated: ${entry.path}`);
    }
  }
}

function publishVerifiedManifest(projectRoot, inputs, dist) {
  const manifest = publishPreparedSdkManifest(projectRoot, inputs, dist);
  try {
    verifyPreparedSdkArtifact({
      projectRoot,
      expectedRunId: manifest.runId,
      expectedInputSha256: inputs.sha256,
      expectedDistSha256: dist.sha256,
    });
    return manifest;
  } catch (error) {
    removeManifestIfOwned(projectRoot, manifest.runId);
    throw error;
  }
}

function removeManifestIfOwned(projectRoot, runId) {
  try {
    const current = readPreparedSdkManifest(projectRoot);
    if (current.runId === runId) removePreparedSdkManifest(projectRoot);
  } catch {
    // A concurrent writer or corrupt partial state is not ours to remove.
  }
}

function isMissingOrInvalidFileError(error) {
  return ["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code) || /non-regular file/i.test(error?.message ?? "");
}

function snapshotFiles(projectRoot, relativePaths, label) {
  const uniquePaths = [...new Set(relativePaths.map(normalizeRelativePath))].sort(compareUtf8);
  if (uniquePaths.length === 0) throw new Error(`${label} contains no regular files`);
  if (uniquePaths.length > MAX_TREE_FILES) throw new Error(`${label} exceeds ${MAX_TREE_FILES} files`);

  const treeHash = createHash("sha256");
  const entries = [];
  for (const relativePath of uniquePaths) {
    const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if (isMissingOrInvalidFileError(error)) {
        const missing = new Error(`${label} is missing a regular file: ${relativePath}`, { cause: error });
        missing.code = error.code;
        throw missing;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} contains a non-regular file: ${relativePath}`);
    }
    const bytes = fs.readFileSync(absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    updateLengthFramed(treeHash, Buffer.from(relativePath, "utf8"));
    updateLengthFramed(treeHash, bytes);
    entries.push({ path: relativePath, bytes: bytes.length, sha256 });
  }
  return { sha256: treeHash.digest("hex"), fileCount: entries.length, entries };
}

function collectTree(projectRoot, relativeRoot, files, include) {
  const normalizedRoot = normalizeRelativePath(relativeRoot);
  const absoluteRoot = path.join(projectRoot, ...normalizedRoot.split("/"));
  let rootStat;
  try {
    rootStat = fs.lstatSync(absoluteRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Required SDK tree does not exist: ${normalizedRoot}`);
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Required SDK tree is not a regular directory: ${normalizedRoot}`);
  }

  const visit = (relativeDirectory) => {
    const absoluteDirectory = path.join(projectRoot, ...relativeDirectory.split("/"));
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) =>
      compareUtf8(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(path.posix.join(relativeDirectory, entry.name));
      if (!include(relativePath)) continue;
      if (entry.isSymbolicLink()) throw new Error(`SDK tree contains a symlink: ${relativePath}`);
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`SDK tree contains a special file: ${relativePath}`);
      }
    }
  };
  visit(normalizedRoot);
}

function collectFile(projectRoot, relativePath, files) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const absolutePath = path.join(projectRoot, ...normalizedPath.split("/"));
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Required SDK build input does not exist: ${normalizedPath}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Required SDK build input is not a regular file: ${normalizedPath}`);
  }
  files.push(normalizedPath);
}

function isExcludedBuildInput(relativePath) {
  return relativePath === "test/fixtures" || relativePath.startsWith("test/fixtures/");
}

function updateLengthFramed(hash, bytes) {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeRelativePath(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe prepared SDK path: ${relativePath}`);
  }
  return normalized;
}

function assertSnapshotEqual(label, expected, observed) {
  if (
    expected.sha256 !== observed.sha256 ||
    expected.fileCount !== observed.fileCount ||
    !sameEntries(expected.entries, observed.entries)
  ) {
    throw new Error(
      `${label}: expected ${expected.sha256}/${expected.fileCount}, received ${observed.sha256}/${observed.fileCount}`,
    );
  }
}

function sameEntries(left, right) {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) =>
      entry.path === right[index]?.path && entry.bytes === right[index]?.bytes && entry.sha256 === right[index]?.sha256,
  );
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Prepared SDK manifest must be an object");
  }
  const keys = Object.keys(manifest).sort();
  const expectedKeys = ["dist", "format", "inputs", "preparedAt", "runId"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Prepared SDK manifest has unknown or missing fields");
  }
  if (manifest.format !== PREPARED_SDK_ARTIFACT_FORMAT) throw new Error("Prepared SDK manifest format is invalid");
  if (typeof manifest.runId !== "string" || !UUID_PATTERN.test(manifest.runId)) {
    throw new Error("Prepared SDK manifest runId is invalid");
  }
  if (typeof manifest.preparedAt !== "string" || !Number.isFinite(Date.parse(manifest.preparedAt))) {
    throw new Error("Prepared SDK manifest preparedAt is invalid");
  }
  validateSnapshot(manifest.inputs, "inputs");
  validateSnapshot(manifest.dist, "dist");
  const paths = new Set(manifest.dist.entries.map((entry) => entry.path));
  for (const requiredPath of REQUIRED_DIST_FILES) {
    if (!paths.has(requiredPath)) throw new Error(`Prepared SDK manifest is partial: missing ${requiredPath}`);
  }
}

function validateSnapshot(snapshot, label) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`Prepared SDK ${label} snapshot must be an object`);
  }
  const keys = Object.keys(snapshot).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["entries", "fileCount", "sha256"])) {
    throw new Error(`Prepared SDK ${label} snapshot has unknown or missing fields`);
  }
  if (typeof snapshot.sha256 !== "string" || !SHA256_PATTERN.test(snapshot.sha256)) {
    throw new Error(`Prepared SDK ${label} digest is invalid`);
  }
  if (!Number.isInteger(snapshot.fileCount) || snapshot.fileCount < 1 || snapshot.fileCount > MAX_TREE_FILES) {
    throw new Error(`Prepared SDK ${label} fileCount is invalid`);
  }
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length !== snapshot.fileCount) {
    throw new Error(`Prepared SDK ${label} entries do not match fileCount`);
  }
  let previousPath;
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Prepared SDK ${label} entry must be an object`);
    }
    const entryKeys = Object.keys(entry).sort();
    if (JSON.stringify(entryKeys) !== JSON.stringify(["bytes", "path", "sha256"])) {
      throw new Error(`Prepared SDK ${label} entry has unknown or missing fields`);
    }
    const normalizedPath = normalizeRelativePath(entry.path);
    if (normalizedPath !== entry.path) throw new Error(`Prepared SDK ${label} entry path is not canonical`);
    if (previousPath !== undefined && compareUtf8(previousPath, normalizedPath) >= 0) {
      throw new Error(`Prepared SDK ${label} entries are not uniquely sorted`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`Prepared SDK ${label} entry metadata is invalid: ${normalizedPath}`);
    }
    previousPath = normalizedPath;
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EPERM"]).has(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
