import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { canonicalCommand, parseSampleCommand } from "./lib/sample-command.mjs";
import {
  isSampleEvidenceRunId,
  SAMPLE_PERFORMANCE_BUDGET_MS,
  SAMPLE_PERFORMANCE_METRIC,
  SAMPLE_SCREENSHOT_REPORT_FORMAT,
  SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY,
  SAMPLE_SCREENSHOT_VARIANTS,
} from "./lib/sample-gates.mjs";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = require("@playwright/test/package.json").version;
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(projectRoot, "samples/contract/v2/schemas/sample-gate-receipt.schema.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const liveEvidenceSchema = JSON.parse(
  await readFile(path.join(projectRoot, "samples/contract/v1/schemas/sample-evidence.schema.json"), "utf8"),
);
const sampleCatalog = JSON.parse(await readFile(path.join(projectRoot, "samples/catalog.v2.json"), "utf8"));
const catalogSamples = new Map(sampleCatalog.samples.map((sample) => [sample.id, sample]));
const kitManifest = JSON.parse(await readFile(path.join(projectRoot, "examples/_kit/manifest.v1.json"), "utf8"));
const playwrightContracts = new Map(kitManifest.samples.map((sample) => [sample.id, sample]));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);
const validateLiveEvidenceSchema = ajv.compile(liveEvidenceSchema);
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const READ_ONLY_NO_FOLLOW =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const PLAYWRIGHT_BROWSERS = new Set(["chromium", "firefox", "webkit"]);

export const SAMPLE_GATE_NAMES = Object.freeze([
  "packed-build",
  "browser",
  "accessibility",
  "console",
  "responsive",
  "screenshot",
  "performance",
  "fixture",
  "live",
]);

const profileGateNames = Object.freeze({
  packedBuild: "packed-build",
  browser: "browser",
  accessibility: "accessibility",
  console: "console",
  responsive: "responsive",
  screenshot: "screenshot",
  performance: "performance",
  liveEvidence: "live",
});

const gateArtifactKinds = Object.freeze({
  "packed-build": "packed-build-report",
  browser: "playwright-gate-report",
  accessibility: "playwright-gate-report",
  console: "playwright-gate-report",
  responsive: "playwright-gate-report",
  screenshot: "screenshot-report",
  performance: "performance-report",
  fixture: "fixture-probe-report",
  live: "live-evidence-report",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

// Derived-artifact decoupling (honua-io/honua-sdk-js#677): when this signal is
// set (PR CI), the evidence-neutral source-digest BINDING is relaxed so gate
// evidence committed by a prior trunk reseal is accepted without requiring the
// PR author to reseal against their tree. Everything else -- receipt schema,
// 7-day freshness, artifact digests, gate semantics, run-root and command
// bindings -- stays fully enforced. The producer digest is also deferred
// because a feature PR can legitimately change the producer before trunk has
// resealed its receipts. Defaults to strict (fail-closed):
// trunk pushes and the regenerate-derived-artifacts workflow leave it unset, so
// the reseal there remains strictly bound to the trunk source digest.
function derivedArtifactsRelaxed() {
  return /^(1|true|yes|on)$/i.test(process.env.HONUA_DERIVED_ARTIFACTS_RELAX ?? "");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitOutput(args, root) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Paths that are regenerated OUTPUT rather than authored SOURCE, and are
// therefore excluded from the "evidence-neutral" source digest:
//  - samples/evidence: the gate receipts and captured artifacts themselves.
//  - samples/dist, samples/contract/v2/consumer-fixtures: dist projections
//    (golden-journey visual evidence, capability matrix, site consumer
//    handoff/fixtures) generated FROM qualification evidence by
//    `samples:generate`. These embed the evidence capture's own
//    sourceRevision/runId/observedAt, so including them in the digest would
//    make the digest a function of its own output: regenerating them after
//    a capture changes the tree, which would invalidate the very receipts
//    that capture just produced, and no commit could ever be self-consistent.
//    Their integrity is instead enforced by generatedOutputDrift's direct
//    byte comparison against a fresh generation, and each entry's own
//    receipt-bound sourceRevision/sourceDigest fields.
//
//  The remaining entries are DERIVED build outputs and NON-runtime CI config.
//  They are excluded on the same principle: including them would make the
//  evidence digest a function of artifacts that are themselves regenerated
//  from source on trunk (honua-io/honua-sdk-js#677), which serialized every
//  feature PR behind a full reseal. Excluding them is integrity-preserving
//  because NONE of them affect SDK or sample RUNTIME behaviour:
//   - .github: CI/workflow configuration. Not SDK/sample source; no sample or
//     test reads it at runtime. (Including it is why a one-line ci.yml fix used
//     to force a full kit re-qualification -- honua-io/honua-sdk-js#674.)
//   - docs/bundle-sizes.md, docs/comparison.md, docs/errors.md: report docs
//     regenerated deterministically from source. NOTE: docs/ is deliberately
//     NOT excluded wholesale -- docs/examples/* holds runnable sample source
//     that MUST stay bound to the digest; only these generated report files go.
//   - llms.txt, llms-full.txt: generated documentation projections.
//   - api-report: a derived public-surface snapshot; the real surface is still
//     validated at PR time (verify:root-surface / verify:public-surface).
//   - bench/cross-sdk/corpus.json: a derived source-tree pin regenerated from
//     the very src/ tree that IS still inside the digest.
//   - examples/migration-workbench/public/artifacts: deterministically
//     generated migration artifacts (regenerated from src + committed fixtures
//     that remain in the digest).
//  Because every excluded path is either non-runtime config or is
//  deterministically derived from source that remains inside the digest,
//  excluded content cannot let gate evidence drift away from the real SDK and
//  sample behaviour it attests to.
const EVIDENCE_NEUTRAL_EXCLUDED_ROOTS = Object.freeze([
  "samples/evidence",
  "samples/dist",
  "samples/contract/v2/consumer-fixtures",
  ".github",
  "docs/bundle-sizes.md",
  "docs/comparison.md",
  "docs/errors.md",
  "llms.txt",
  "llms-full.txt",
  "api-report",
  "bench/cross-sdk/corpus.json",
  "examples/migration-workbench/public/artifacts",
]);

// Digest narrowing (honua-io/honua-sdk-js#746 REQ-003): the excluded roots
// above remove regenerated OUTPUT and non-runtime CI config from an
// otherwise whole-tree digest. That still leaves the digest a function of
// content that can never influence what the maplibre-quickstart sample
// renders or how it behaves -- docs/ prose, mcp/, bench/ narrative, test/
// suites for unrelated SDK areas, and so on -- so an unrelated merge (a
// typo fix in docs/, an mcp/ feature) still invalidated sample evidence and
// forced a reseal (#746 context). This allowlist is the positive half of
// the digest: only these roots can ever be included, and the exclusions
// above are then subtracted from that included set (e.g. samples/evidence
// stays out even though samples/ is included). Every root here is either
// SDK runtime source a sample imports (src/), a sample's own source
// (examples/, docs/examples/ -- see sample-runner.mjs's sourcePath check),
// a dependency manifest that changes what gets installed
// (package.json/package-lock.json), the harness/config that produces and
// verifies sample evidence itself (samples/, config/, and the specific
// scripts/ files the sample tooling loads -- see the imports of
// sample-contract.mjs, sample-runner.mjs, and this file), or the browser
// evidence-capture inputs sample-runner.mjs binds a receipt to: PLAYWRIGHT_EVIDENCE_ROOT
// ("test/playwright", holding every sample's playwrightFile plus shared
// helpers like sample-gate-assertions.mjs) and the root Playwright config
// each sample's npm script loads implicitly or via an explicit
// playwrightConfig override (playwright.config.mjs is the default every
// `playwright test <file>` invocation resolves; playwright.first-map.config.mjs
// is maplibre-quickstart's explicit override and carries the release-matrix
// Firefox/xvfb projects from #736). Without these, weakening a spec or the
// browser matrix config would still verify against a previously sealed
// receipt -- exactly the drift class this digest exists to catch. Widen
// this list deliberately: anything omitted here can change without ever
// invalidating evidence, so it must be genuinely incapable of affecting
// sample behavior or how its evidence is captured/verified.
const EVIDENCE_NEUTRAL_INCLUDED_ROOTS = Object.freeze([
  "examples",
  "docs/examples",
  "src",
  "samples",
  "test/playwright",
  "package.json",
  "package-lock.json",
  "config",
  "playwright.config.mjs",
  "playwright.first-map.config.mjs",
  "scripts/sample-contract.mjs",
  "scripts/sample-gate-receipt.mjs",
  "scripts/sample-runner.mjs",
  "scripts/build-sample-bundles.mjs",
  "scripts/lib",
]);

function evidenceNeutralIncludePathspecs() {
  return [...EVIDENCE_NEUTRAL_INCLUDED_ROOTS];
}

function evidenceNeutralExcludePathspecs() {
  return EVIDENCE_NEUTRAL_EXCLUDED_ROOTS.map((root) => `:(exclude)${root}`);
}

function evidenceNeutralPathspecs() {
  return [...evidenceNeutralIncludePathspecs(), ...evidenceNeutralExcludePathspecs()];
}

function isEvidenceNeutralIncluded(file) {
  return EVIDENCE_NEUTRAL_INCLUDED_ROOTS.some((root) => file === root || file.startsWith(`${root}/`));
}

function isEvidenceNeutralExcluded(file) {
  return EVIDENCE_NEUTRAL_EXCLUDED_ROOTS.some((root) => file === root || file.startsWith(`${root}/`));
}

// A file is inside the evidence-neutral source digest iff it matches the
// allowlist above AND is not one of the regenerated-output/CI-config roots
// subtracted from it.
function isEvidenceNeutral(file) {
  return isEvidenceNeutralIncluded(file) && !isEvidenceNeutralExcluded(file);
}

function canonicalTreeListing(buffer, format, excludeEvidence = false) {
  const records = buffer.toString("utf8").split("\0").filter(Boolean);
  const entries = [];
  for (const record of records) {
    const tab = record.indexOf("\t");
    invariant(tab > 0, `invalid Git ${format} tree record`);
    const metadata = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    invariant(file.length > 0 && !file.includes("\0"), `invalid Git ${format} tree path`);
    if (excludeEvidence && !isEvidenceNeutral(file)) continue;
    if (format === "index") {
      invariant(metadata.length === 3 && metadata[2] === "0", "source index contains an unresolved stage");
      entries.push(`${metadata[0]}\0${metadata[1]}\0${file}\0`);
    } else {
      invariant(metadata.length === 3, "source revision contains an invalid tree entry");
      entries.push(`${metadata[0]}\0${metadata[2]}\0${file}\0`);
    }
  }
  entries.sort();
  return Buffer.from(entries.join(""));
}

function indexSourceListing(root) {
  const index = execFileSync("git", ["ls-files", "-s", "-z", "--", ...evidenceNeutralPathspecs()], {
    cwd: root,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return canonicalTreeListing(index, "index");
}

function revisionSourceDigest(revision, root) {
  invariant(/^[a-f0-9]{40}$/.test(revision), "source revision must be a full lowercase Git SHA");
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    throw new Error(`source revision does not name an existing commit: ${revision}`);
  }
  const tree = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", revision],
    { cwd: root, encoding: null, stdio: ["ignore", "pipe", "pipe"] },
  );
  return sha256(
    Buffer.concat([Buffer.from("honua-sdk-sample-source.v1\0"), canonicalTreeListing(tree, "revision", true)]),
  );
}

function rejectHiddenIndexInputs(root) {
  const output = execFileSync("git", ["ls-files", "-v", "-z", "--", ...evidenceNeutralPathspecs()], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const record of output.split("\0").filter(Boolean)) {
    const tag = record[0];
    invariant(
      tag !== "S" && tag === tag.toUpperCase(),
      `gate evidence rejects skip-worktree or assume-unchanged source input: ${record.slice(2)}`,
    );
  }
}

export function evidenceNeutralSourceDigest(root = projectRoot) {
  return sha256(Buffer.concat([Buffer.from("honua-sdk-sample-source.v1\0"), indexSourceListing(root)]));
}

export function verifyEvidenceNeutralCheckout(expectedSourceDigest, root = projectRoot, sourceRevision) {
  rejectHiddenIndexInputs(root);
  const status = gitOutput(
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...evidenceNeutralPathspecs()],
    root,
  );
  invariant(
    status === "",
    `gate evidence requires a clean source checkout of the evidence-neutral roots (examples/, docs/examples/, src/, samples/ minus generated output, test/playwright/, package.json, package-lock.json, config/, playwright.config.mjs, playwright.first-map.config.mjs, and the sample harness scripts); found ${status.split("\n")[0]}`,
  );
  const digest = evidenceNeutralSourceDigest(root);
  if (expectedSourceDigest !== undefined) {
    invariant(/^[a-f0-9]{64}$/.test(expectedSourceDigest), "source digest must be a lowercase SHA-256");
    invariant(digest === expectedSourceDigest, "gate receipt source digest does not match the evidence-neutral checkout");
  }
  const head = gitOutput(["rev-parse", "HEAD"], root);
  const headDigest = revisionSourceDigest(head, root);
  invariant(headDigest === digest, "gate evidence index is not bound to the evidence-neutral HEAD tree");
  if (sourceRevision !== undefined) {
    invariant(
      revisionSourceDigest(sourceRevision, root) === digest,
      "gate receipt source revision does not match its source digest",
    );
    // sourceRevision must still name a real commit object whose
    // evidence-neutral tree is byte-identical (via the SHA-256 check just
    // above) to the current clean checkout -- that continues to reject
    // garbage/forged revisions and genuine content drift. It is
    // deliberately NOT also required to be a git-graph ancestor of HEAD via
    // `git merge-base --is-ancestor`: a GitHub squash-merge rewrites a
    // sample PR's reseal commit into a brand-new trunk commit with the same
    // resulting tree, so the original commit is content-identical but never
    // becomes the squashed commit's ancestor. That topology constraint adds
    // no integrity guarantee beyond the content match above (a commit
    // fabricated to match this digest via SHA-256 preimage/collision is
    // infeasible) and does not survive squashing, which orphaned every
    // squash-merged sample PR's own evidence on the very next trunk push
    // (#647, #651, #653 -- honua-io/honua-sdk-js#650).
  }
  return digest;
}

async function collectTree(
  root,
  {
    maxFiles = 10_000,
    maxEntries = 20_000,
    maxBytes = 128 * 1024 * 1024,
    label = "source integrity tree",
  } = {},
) {
  const rootMetadata = await lstat(root);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), `${label} root must be a non-symlink directory`);
  const files = [];
  const directories = [];
  let bytes = 0;
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      invariant(!metadata.isSymbolicLink(), `source integrity tree contains a symlink: ${absolute}`);
      if (metadata.isDirectory()) {
        directories.push(absolute);
        invariant(files.length + directories.length <= maxEntries, `${label} exceeds its path-count budget`);
        await visit(absolute);
      }
      else if (metadata.isFile()) {
        files.push(absolute);
        bytes += metadata.size;
        invariant(files.length <= maxFiles, `${label} exceeds its file-count budget`);
        invariant(files.length + directories.length <= maxEntries, `${label} exceeds its path-count budget`);
        invariant(bytes <= maxBytes, `${label} exceeds its byte budget`);
      }
      else throw new Error(`source integrity tree contains an unsupported path: ${absolute}`);
    }
  };
  await visit(root);
  return { directories, files };
}

async function collectFiles(root, options) {
  return (await collectTree(root, options)).files;
}

function controlledOutputRoot(value, root) {
  invariant(typeof value === "string" && !path.isAbsolute(value) && !value.includes("\\"), "controlled output root must be repository-relative");
  const normalized = path.posix.normalize(value);
  invariant(
    normalized === value && /^samples\/evidence\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized),
    `controlled output root is invalid: ${value}`,
  );
  const absolute = path.resolve(root, normalized);
  invariant(absolute.startsWith(`${path.resolve(root)}${path.sep}`), "controlled output root escapes repository");
  return { normalized, absolute };
}

function controlledRunRoot(value, output, root) {
  invariant(typeof value === "string" && !path.isAbsolute(value) && !value.includes("\\"), "controlled run root must be repository-relative");
  const normalized = path.posix.normalize(value);
  invariant(
    normalized === value &&
      normalized.startsWith(`${output.normalized}/runs/`) &&
      isSampleEvidenceRunId(normalized.slice(`${output.normalized}/runs/`.length)),
    `controlled run root is invalid: ${value}`,
  );
  return { normalized, absolute: path.resolve(root, normalized) };
}

function receiptRunRoot(value, sampleId, root) {
  const output = controlledOutputRoot(`samples/evidence/${sampleId}`, root);
  return { output, run: controlledRunRoot(value, output, root) };
}

async function canonicalProjectRoot(root) {
  const metadata = await lstat(root);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "project root must be a non-symlink directory");
  return realpath(root);
}

async function assertCanonicalDirectory(directory, expectedCanonical, label) {
  const metadata = await lstat(directory);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} must be a non-symlink directory`);
  invariant((await realpath(directory)) === expectedCanonical, `${label} resolves outside its canonical repository path`);
}

async function assertCanonicalPathComponents(root, relative, { directory = false, label = "canonical path" } = {}) {
  const canonicalRoot = await canonicalProjectRoot(root);
  const parts = relative.split("/");
  invariant(parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== ".."), `${label} is invalid`);
  let lexical = root;
  let expectedCanonical = canonicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    lexical = path.join(lexical, parts[index]);
    expectedCanonical = path.join(expectedCanonical, parts[index]);
    const metadata = await lstat(lexical);
    invariant(!metadata.isSymbolicLink(), `${label} contains a symlink: ${relative}`);
    if (index < parts.length - 1 || directory) invariant(metadata.isDirectory(), `${label} contains a non-directory ancestor`);
    else invariant(metadata.isFile(), `${label} must be a regular file`);
  }
  invariant((await realpath(lexical)) === expectedCanonical, `${label} resolves outside its canonical repository path`);
  return lexical;
}

function sameStableFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedDescriptor(handle, maxBytes, label) {
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = maxBytes + 1 - total;
    invariant(remaining > 0, `${label} exceeds its ${maxBytes}-byte budget`);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    invariant(total <= maxBytes, `${label} exceeds its ${maxBytes}-byte budget`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Read one repository-relative file through a no-follow descriptor while
 * binding its path, inode, size, and change timestamps before and after I/O.
 * The optional hook exists only so adversarial tests can force the race window.
 */
export async function readCanonicalBoundedFile(
  root,
  relative,
  { label = "bounded file", maxBytes = MAX_REPORT_BYTES, minimumMtimeMs, onBeforeOpen } = {},
) {
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 0, `${label} byte budget is invalid`);
  invariant(
    typeof relative === "string" &&
      !path.isAbsolute(relative) &&
      !relative.includes("\\") &&
      path.posix.normalize(relative) === relative,
    `${label} path is not canonical and repository-relative`,
  );
  const lexical = await assertCanonicalPathComponents(root, relative, { label });
  const before = await lstat(lexical, { bigint: true });
  invariant(before.isFile() && !before.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  invariant(before.size <= BigInt(maxBytes), `${label} exceeds its ${maxBytes}-byte budget`);
  await onBeforeOpen?.({ absolute: lexical, relative });

  let handle;
  try {
    handle = await open(lexical, READ_ONLY_NO_FOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label} changed to a symlink while it was being opened`);
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    invariant(opened.isFile() && sameStableFile(before, opened), `${label} changed while it was being opened`);
    const bytes = await readBoundedDescriptor(handle, maxBytes, label);
    const completed = await handle.stat({ bigint: true });
    invariant(
      sameStableFile(opened, completed) && completed.size === BigInt(bytes.byteLength),
      `${label} changed while it was being read`,
    );
    const pathAfterRead = await lstat(lexical, { bigint: true });
    invariant(sameStableFile(completed, pathAfterRead), `${label} path changed while it was being read`);
    await assertCanonicalPathComponents(root, relative, { label });
    const finalPath = await lstat(lexical, { bigint: true });
    invariant(sameStableFile(completed, finalPath), `${label} path changed after it was read`);
    if (minimumMtimeMs !== undefined) {
      invariant(
        Number(completed.mtimeNs / 1_000_000n) >= minimumMtimeMs - 1_000,
        `${label} predates this evidence run`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function validateReceiptRunRoot(runRoot, sampleId, root) {
  const { run } = receiptRunRoot(runRoot, sampleId, root);
  await assertCanonicalPathComponents(root, run.normalized, {
    directory: true,
    label: `${sampleId} receipt run root`,
  });
  return run;
}

async function ensureCanonicalDirectory(directory, expectedCanonical, label) {
  try {
    await mkdir(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertCanonicalDirectory(directory, expectedCanonical, label);
}

async function prepareCanonicalEvidenceDirectories(root, output) {
  const canonicalRoot = await canonicalProjectRoot(root);
  const samplesRoot = path.join(root, "samples");
  await assertCanonicalDirectory(samplesRoot, path.join(canonicalRoot, "samples"), "samples root");

  const evidenceRoot = path.join(root, "samples/evidence");
  await ensureCanonicalDirectory(evidenceRoot, path.join(canonicalRoot, "samples/evidence"), "canonical evidence root");
  await ensureCanonicalDirectory(
    output.absolute,
    path.join(canonicalRoot, output.normalized),
    "canonical sample evidence directory",
  );
  await ensureCanonicalDirectory(
    path.join(output.absolute, "runs"),
    path.join(canonicalRoot, output.normalized, "runs"),
    "canonical sample run directory",
  );
  await ensureCanonicalDirectory(
    path.join(output.absolute, "receipts"),
    path.join(canonicalRoot, output.normalized, "receipts"),
    "canonical sample receipt directory",
  );
  return canonicalRoot;
}

async function validateCanonicalEvidenceDirectories(root, output, run, requireRun) {
  const canonicalRoot = await canonicalProjectRoot(root);
  await assertCanonicalDirectory(path.join(root, "samples"), path.join(canonicalRoot, "samples"), "samples root");
  await assertCanonicalDirectory(
    path.join(root, "samples/evidence"),
    path.join(canonicalRoot, "samples/evidence"),
    "canonical evidence root",
  );
  await assertCanonicalDirectory(
    output.absolute,
    path.join(canonicalRoot, output.normalized),
    "canonical sample evidence directory",
  );
  await assertCanonicalDirectory(
    path.join(output.absolute, "runs"),
    path.join(canonicalRoot, output.normalized, "runs"),
    "canonical sample run directory",
  );
  await assertCanonicalDirectory(
    path.join(output.absolute, "receipts"),
    path.join(canonicalRoot, output.normalized, "receipts"),
    "canonical sample receipt directory",
  );
  if (requireRun) {
    await assertCanonicalDirectory(
      run.absolute,
      path.join(canonicalRoot, run.normalized),
      "canonical evidence run root",
    );
    return;
  }
  try {
    await lstat(run.absolute);
    invariant(false, "controlled evidence run root must be fresh");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function captureGateSourceSnapshot(options) {
  const root = options.projectRoot ?? projectRoot;
  const output = controlledOutputRoot(options.outputRoot, root);
  const run = controlledRunRoot(options.runRoot, output, root);
  await prepareCanonicalEvidenceDirectories(root, output);
  await validateCanonicalEvidenceDirectories(root, output, run, false);
  invariant(gitOutput(["rev-parse", "HEAD"], root) === options.sourceRevision, "gate source revision must match HEAD at capture time");
  const sourceDigest = verifyEvidenceNeutralCheckout(undefined, root, options.sourceRevision);
  const evidenceTree = await collectTree(path.join(root, "samples/evidence"), {
    maxFiles: 10_000,
    maxBytes: 256 * 1024 * 1024,
    label: "canonical sample evidence tree",
  });
  const baselineEvidence = [];
  for (const file of evidenceTree.files) {
    const bytes = await readFile(file);
    baselineEvidence.push({
      path: path.relative(root, file).replaceAll(path.sep, "/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  baselineEvidence.sort((left, right) => left.path.localeCompare(right.path));
  const baselineEvidenceDirectories = evidenceTree.directories
    .map((directory) => path.relative(root, directory).replaceAll(path.sep, "/"))
    .sort();
  const producerPath = path.join(root, "scripts/sample-runner.mjs");
  return Object.freeze({
    sourceRevision: options.sourceRevision,
    sourceDigest,
    producerSha256: sha256(await readFile(producerPath)),
    outputRoot: output.normalized,
    runRoot: run.normalized,
    baselineEvidence,
    baselineEvidenceDirectories,
    capturedAtMs: Date.now(),
  });
}

export async function verifyGateSourceSnapshot(snapshot, root = projectRoot) {
  invariant(snapshot && typeof snapshot === "object", "gate source snapshot is required");
  invariant(
    gitOutput(["rev-parse", "HEAD"], root) === snapshot.sourceRevision,
    "gate source revision changed during execution",
  );
  verifyEvidenceNeutralCheckout(snapshot.sourceDigest, root, snapshot.sourceRevision);
  invariant(
    sha256(await readFile(path.join(root, "scripts/sample-runner.mjs"))) === snapshot.producerSha256,
    "gate producer changed during execution",
  );
  const output = controlledOutputRoot(snapshot.outputRoot, root);
  const run = controlledRunRoot(snapshot.runRoot, output, root);
  await validateCanonicalEvidenceDirectories(root, output, run, true);
  const mutablePath = (relative) => relative.startsWith(`${run.normalized}/`);
  const evidenceTree = await collectTree(path.join(root, "samples/evidence"), {
    maxFiles: 10_000,
    maxBytes: 256 * 1024 * 1024,
    label: "canonical sample evidence tree",
  });
  invariant(Array.isArray(snapshot.baselineEvidence), "gate source snapshot has no canonical evidence baseline");
  const baseline = new Map();
  for (const binding of snapshot.baselineEvidence) {
    invariant(
      typeof binding?.path === "string" &&
        binding.path.startsWith("samples/evidence/") &&
        path.posix.normalize(binding.path) === binding.path &&
        !binding.path.includes("\\") &&
        Number.isInteger(binding.bytes) &&
        binding.bytes >= 0 &&
        /^[a-f0-9]{64}$/.test(binding.sha256) &&
        !baseline.has(binding.path),
      "gate source snapshot has an invalid canonical evidence baseline binding",
    );
    baseline.set(binding.path, binding);
  }
  let controlledChanges = 0;
  for (const file of evidenceTree.files) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    const binding = baseline.get(relative);
    const bytes = await readFile(file);
    if (mutablePath(relative)) {
      if (!binding || bytes.byteLength !== binding.bytes || sha256(bytes) !== binding.sha256) controlledChanges += 1;
      baseline.delete(relative);
      continue;
    }
    invariant(binding, `gate execution wrote outside its controlled canonical evidence paths: ${relative}`);
    invariant(
      bytes.byteLength === binding.bytes && sha256(bytes) === binding.sha256,
      `gate execution changed unrelated canonical evidence: ${relative}`,
    );
    baseline.delete(relative);
  }
  for (const [relative] of baseline) {
    invariant(false, `gate execution removed canonical evidence: ${relative}`);
  }
  invariant(
    Array.isArray(snapshot.baselineEvidenceDirectories),
    "gate source snapshot has no canonical evidence directory baseline",
  );
  const baselineDirectories = new Set();
  for (const relative of snapshot.baselineEvidenceDirectories) {
    invariant(
      typeof relative === "string" &&
        relative.startsWith("samples/evidence/") &&
        path.posix.normalize(relative) === relative &&
        !relative.includes("\\") &&
        !baselineDirectories.has(relative),
      "gate source snapshot has an invalid canonical evidence directory binding",
    );
    baselineDirectories.add(relative);
  }
  for (const directory of evidenceTree.directories) {
    const relative = path.relative(root, directory).replaceAll(path.sep, "/");
    if (relative === run.normalized || relative.startsWith(`${run.normalized}/`)) continue;
    invariant(
      baselineDirectories.delete(relative),
      `gate execution created an unrelated canonical evidence directory: ${relative}`,
    );
  }
  for (const relative of baselineDirectories) {
    invariant(false, `gate execution removed a canonical evidence directory: ${relative}`);
  }
  invariant(controlledChanges > 0, "gate execution produced no fresh controlled evidence output");
}

function relativeArtifactPath(value, root, sampleId, runRoot) {
  invariant(typeof value === "string" && value.length > 0, "artifact path is required");
  invariant(!path.isAbsolute(value) && !value.includes("\\"), `artifact path must be repository-relative: ${value}`);
  const normalized = path.posix.normalize(value);
  invariant(normalized === value && !normalized.startsWith("../") && normalized !== "..", `unsafe artifact path: ${value}`);
  const { run } = receiptRunRoot(runRoot, sampleId, root);
  invariant(normalized.startsWith(`${run.normalized}/`), `artifact is outside the receipt's bound evidence run: ${value}`);
  const absolute = path.resolve(root, normalized);
  invariant(absolute.startsWith(`${path.resolve(root)}${path.sep}`), `artifact escapes repository root: ${value}`);
  return { normalized, absolute };
}

async function verifiedArtifact(value, root, sampleId, runRoot, minimumMtimeMs) {
  const { normalized } = relativeArtifactPath(value.path ?? value, root, sampleId, runRoot);
  await validateReceiptRunRoot(runRoot, sampleId, root);
  const bytes = await readCanonicalBoundedFile(root, normalized, {
    label: `receipt artifact ${normalized}`,
    maxBytes: MAX_REPORT_BYTES,
    minimumMtimeMs,
  });
  return {
    kind: typeof value === "string" ? "gate-output" : value.kind,
    path: normalized,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    content: bytes,
  };
}

async function verifiedRunDirectory(value, root, sampleId, runRoot, label) {
  const { normalized } = relativeArtifactPath(value, root, sampleId, runRoot);
  const absolute = await assertCanonicalPathComponents(root, normalized, { directory: true, label });
  return { normalized, absolute };
}

function parseJsonReport(artifact, label) {
  try {
    return JSON.parse(artifact.content.toString("utf8"));
  } catch {
    throw new Error(`${label} must be JSON: ${artifact.path}`);
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(bytes) {
  invariant(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "screenshot artifact is not a PNG");
  let offset = 8;
  let dimensions;
  let sawIdat = false;
  let sawIend = false;
  let sawPlte = false;
  let sawNonIdatAfterIdat = false;
  const idatChunks = [];
  let chunkIndex = 0;
  while (offset < bytes.length) {
    invariant(offset + 12 <= bytes.length, "screenshot PNG contains a truncated chunk");
    const length = bytes.readUInt32BE(offset);
    invariant(length <= MAX_REPORT_BYTES && offset + 12 + length <= bytes.length, "screenshot PNG chunk length is invalid");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    invariant(/^[A-Za-z]{4}$/.test(type) && /[A-Z]/.test(type[2]), "screenshot PNG chunk type is invalid");
    invariant(chunkIndex === 0 || type !== "IHDR", "screenshot PNG contains a duplicate IHDR");
    if (/[A-Z]/.test(type[0])) {
      invariant(["IHDR", "PLTE", "IDAT", "IEND"].includes(type), `screenshot PNG has unknown critical chunk ${type}`);
    }
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    invariant(crc32(bytes.subarray(offset + 4, offset + 8 + length)) === expectedCrc, `screenshot PNG ${type} CRC is invalid`);
    if (chunkIndex === 0) {
      invariant(type === "IHDR" && length === 13, "screenshot PNG does not begin with a valid IHDR");
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const validDepths = {
        0: new Set([1, 2, 4, 8, 16]),
        2: new Set([8, 16]),
        3: new Set([1, 2, 4, 8]),
        4: new Set([8, 16]),
        6: new Set([8, 16]),
      };
      invariant(
        width > 0 &&
          height > 0 &&
          width <= 8_192 &&
          height <= 8_192 &&
          validDepths[colorType]?.has(bitDepth) === true &&
          data[10] === 0 &&
          data[11] === 0 &&
          data[12] === 0,
        "screenshot PNG IHDR dimensions or encoding are invalid",
      );
      dimensions = { width, height, bitDepth, colorType };
    }
    if (type === "PLTE") {
      invariant(!sawIdat && length > 0 && length % 3 === 0 && length <= 768, "screenshot PNG PLTE is invalid");
      sawPlte = true;
    }
    if (type === "IDAT") {
      invariant(!sawNonIdatAfterIdat && length > 0, "screenshot PNG IDAT sequence is invalid");
      sawIdat = true;
      idatChunks.push(data);
    } else if (sawIdat && type !== "IEND") sawNonIdatAfterIdat = true;
    if (type === "IEND") {
      invariant(length === 0, "screenshot PNG IEND is invalid");
      sawIend = true;
      offset += 12;
      break;
    }
    offset += 12 + length;
    chunkIndex += 1;
  }
  invariant(sawIdat && sawIend && offset === bytes.length, "screenshot PNG is incomplete or has trailing bytes");
  invariant(dimensions.colorType !== 3 || sawPlte, "indexed screenshot PNG is missing PLTE");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[dimensions.colorType];
  const rowBytes = Math.ceil((dimensions.width * channels * dimensions.bitDepth) / 8);
  const expectedBytes = dimensions.height * (rowBytes + 1);
  invariant(expectedBytes > 0 && expectedBytes <= 64 * 1024 * 1024, "screenshot PNG decoded size is invalid");
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedBytes });
  } catch {
    throw new Error("screenshot PNG image data is not decodable");
  }
  invariant(decoded.byteLength === expectedBytes, "screenshot PNG decoded scanline size is invalid");
  for (let row = 0; row < dimensions.height; row += 1) {
    invariant(decoded[row * (rowBytes + 1)] <= 4, "screenshot PNG scanline filter is invalid");
  }
  return { width: dimensions.width, height: dimensions.height };
}

function playwrightExecutions(report) {
  const executions = [];
  const visitSuite = (suite, inheritedFile) => {
    const suiteFile = suite.file ?? inheritedFile;
    for (const child of suite.suites ?? []) visitSuite(child, suiteFile);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        executions.push({
          file: spec.file ?? suiteFile,
          title: spec.title,
          projectName: test.projectName ?? "",
          expectedStatus: test.expectedStatus,
          results: test.results ?? [],
        });
      }
    }
  };
  for (const suite of report.suites ?? []) visitSuite(suite);
  return executions;
}

function declaredPlaywrightProjects(contract, sampleId) {
  invariant(
    Array.isArray(contract?.playwrightProjects) &&
      contract.playwrightProjects.length > 0 &&
      contract.playwrightProjects.length <= PLAYWRIGHT_BROWSERS.size &&
      contract.playwrightProjects.every(
        (project) =>
          project &&
          typeof project === "object" &&
          !Array.isArray(project) &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name) &&
          PLAYWRIGHT_BROWSERS.has(project.browserName),
      ) &&
      new Set(contract.playwrightProjects.map((project) => project.name)).size === contract.playwrightProjects.length &&
      new Set(contract.playwrightProjects.map((project) => project.browserName)).size ===
        contract.playwrightProjects.length,
    `${sampleId} has an invalid Playwright project matrix`,
  );
  return contract.playwrightProjects;
}

function exactPlaywrightResults(report, sampleId, contractOverride) {
  const contract = contractOverride ?? playwrightContracts.get(sampleId);
  invariant(contract, `${sampleId} has no declared Playwright evidence contract`);
  const reportRoot = report.config?.rootDir;
  invariant(
    typeof reportRoot === "string" &&
      !path.isAbsolute(reportRoot) &&
      !reportRoot.includes("\\") &&
      path.posix.normalize(reportRoot) === reportRoot &&
      reportRoot === "test/playwright",
    `${sampleId} Playwright root directory binding mismatch`,
  );
  const expectedFile = path.posix.relative("test/playwright", contract.playwrightFile);
  invariant(
    expectedFile.length > 0 &&
      expectedFile !== ".." &&
      !expectedFile.startsWith("../") &&
      path.posix.normalize(expectedFile) === expectedFile,
    `${sampleId} declared Playwright file is outside the test root`,
  );
  const projects = declaredPlaywrightProjects(contract, sampleId);
  const executions = playwrightExecutions(report);
  invariant(
    executions.length === projects.length,
    `${sampleId} report must contain exactly one declared test execution per Playwright project`,
  );
  const results = [];
  for (const project of projects) {
    const matches = executions.filter((execution) => execution.projectName === project.name);
    invariant(matches.length === 1, `${sampleId} Playwright project matrix binding mismatch for ${project.name}`);
    const execution = matches[0];
    invariant(execution.file === expectedFile, `${sampleId} Playwright file binding mismatch`);
    invariant(execution.title === contract.playwrightTestTitle, `${sampleId} Playwright test title binding mismatch`);
    invariant(execution.expectedStatus === "passed", `${sampleId} Playwright expected status is not passed`);
    invariant(execution.results.length === 1, `${sampleId} evidence cannot be accepted from retries`);
    const result = execution.results[0];
    invariant(
      result.status === "passed" && (result.retry ?? 0) === 0,
      `${sampleId} evidence requires a first-attempt passed result`,
    );
    const gateNames = (result.attachments ?? []).map((attachment) => attachment.name).sort();
    const expectedGateNames = ["accessibility", "browser", "console", "fixture", "responsive"]
      .map((gate) => `honua-gate:${gate}`)
      .sort();
    invariant(
      JSON.stringify(gateNames) === JSON.stringify(expectedGateNames),
      `${sampleId} Playwright gate attachment set is not exact`,
    );
    results.push({ project, result });
  }
  return { contract, results };
}

function assertionPayload(result, sampleId, gate) {
  const matches = result.attachments.filter((attachment) => attachment.name === `honua-gate:${gate}`);
  invariant(matches.length === 1, `${sampleId} ${gate} report requires exactly one passing gate assertion`);
  invariant(matches[0].contentType === "application/json" && typeof matches[0].body === "string", `${sampleId} ${gate} assertion is not inline JSON`);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(matches[0].body, "base64").toString("utf8"));
  } catch {
    throw new Error(`${sampleId} ${gate} assertion body is not valid inline JSON`);
  }
  invariant(payload.format === "honua.sdk.sample-gate-assertion.v1", `${sampleId} ${gate} assertion format is invalid`);
  invariant(payload.sampleId === sampleId && payload.gate === gate && payload.status === "passed", `${sampleId} ${gate} assertion binding mismatch`);
  return payload.observations;
}

export function validatePlaywrightGate(report, sampleId, gate, contractOverride) {
  invariant(report?.config && Array.isArray(report.suites), `${sampleId} ${gate} artifact is not a Playwright JSON report`);
  const { contract, results } = exactPlaywrightResults(report, sampleId, contractOverride);
  for (const { project, result } of results) {
    const observations = assertionPayload(result, sampleId, gate);
    if (gate === "browser") {
      invariant(
        observations?.runtimeReady === true &&
          observations.projectName === project.name &&
          observations.browserName === project.browserName,
        `${sampleId} browser runtime or engine binding is invalid for ${project.name}`,
      );
    }
    if (gate === "accessibility") {
      invariant(
        observations?.engine?.name === "axe-core" &&
          typeof observations.engine.version === "string" &&
          /^\d+\.\d+\.\d+/.test(observations.engine.version) &&
          Array.isArray(observations.violations) &&
          observations.violations.length === 0 &&
          Number.isInteger(observations.passes) &&
          observations.passes > 0,
        `${sampleId} accessibility evidence is not a passing axe-core audit`,
      );
      invariant(
        observations.keyboard?.selector === '[data-testid="honua-sample-evidence"] > summary' &&
          observations.keyboard.tabReachedTarget === true &&
          observations.keyboard.activated === true,
        `${sampleId} accessibility evidence lacks the keyboard focus workflow`,
      );
    }
    if (gate === "console") {
      invariant(
        Array.isArray(observations?.pageErrors) &&
          observations.pageErrors.length === 0 &&
          Array.isArray(observations?.consoleErrors) &&
          observations.consoleErrors.length === 0 &&
          observations.pageClosed === true &&
          observations.contextClosed === true &&
          observations.finalizationBoundary === "owned-page-and-context-close" &&
          observations.finalizedAfterTeardown === true,
        `${sampleId} browser console evidence is not clean`,
      );
    }
    if (gate === "responsive") {
      invariant(
        JSON.stringify(observations?.workflowSelectors) === JSON.stringify(contract.workflowSelectors) &&
          Array.isArray(observations?.viewports) &&
          observations.viewports.length === contract.responsiveViewports.length,
        `${sampleId} responsive evidence is invalid`,
      );
      for (let index = 0; index < contract.responsiveViewports.length; index += 1) {
        const expected = contract.responsiveViewports[index];
        const observed = observations.viewports[index];
        invariant(
          observed?.width === expected.width &&
            observed?.height === expected.height &&
            observed.noHorizontalOverflow === true &&
            Number.isInteger(observed.documentWidth) &&
            observed.documentWidth <= expected.width &&
            JSON.stringify(observed.workflows?.map(({ selector }) => selector)) ===
              JSON.stringify(contract.workflowSelectors) &&
            observed.workflows.every(({ visible }) => visible === true),
          `${sampleId} responsive viewport or required workflow evidence is invalid`,
        );
      }
    }
  }
}

function declaredEvidenceProject(sampleId) {
  const contract = playwrightContracts.get(sampleId);
  invariant(contract, `${sampleId} has no declared browser evidence contract`);
  const projects = declaredPlaywrightProjects(contract, sampleId);
  const project = projects.find((candidate) => candidate.name === contract.evidenceProject);
  invariant(project, `${sampleId} evidence project is not in its Playwright project matrix`);
  return project;
}

async function validateScreenshotReport(report, receipt, root) {
  invariant(report?.format === SAMPLE_SCREENSHOT_REPORT_FORMAT, "screenshot report format is invalid");
  invariant(report.sampleId === receipt.sampleId && report.sourceRevision === receipt.sourceRevision, "screenshot report binding mismatch");
  invariant(
    JSON.stringify(report.reproducibilityPolicy) ===
      JSON.stringify(SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY),
    "screenshot reproducibility policy is invalid",
  );
  const evidenceProject = declaredEvidenceProject(receipt.sampleId);
  invariant(
    report.runtime?.playwrightVersion === PLAYWRIGHT_VERSION &&
      report.runtime?.projectName === evidenceProject.name &&
      report.runtime?.browserName === evidenceProject.browserName &&
      typeof report.runtime?.browserVersion === "string" &&
      report.runtime.browserVersion.length > 0 &&
      report.runtime.browserVersion.length <= 128 &&
      typeof report.runtime?.platform === "string" &&
      /^[a-z0-9_-]+$/u.test(report.runtime.platform) &&
      typeof report.runtime?.architecture === "string" &&
      /^[a-z0-9_-]+$/u.test(report.runtime.architecture),
    "screenshot report is not bound to the declared Playwright project and browser runtime",
  );
  invariant(
    Array.isArray(report.screenshots) && report.screenshots.length === SAMPLE_SCREENSHOT_VARIANTS.length,
    "screenshot report must contain the complete desktop/mobile variant set",
  );
  const artifactPaths = report.screenshots.flatMap((screenshot) => [
    screenshot?.path,
    screenshot?.reproducibility?.repeatPath,
  ]);
  invariant(
    artifactPaths.every((artifactPath) => typeof artifactPath === "string") &&
      new Set(artifactPaths).size === SAMPLE_SCREENSHOT_VARIANTS.length * 2,
    "screenshot report primary and repeat paths must be unique",
  );
  for (let index = 0; index < SAMPLE_SCREENSHOT_VARIANTS.length; index += 1) {
    const expected = SAMPLE_SCREENSHOT_VARIANTS[index];
    const screenshot = report.screenshots[index];
    invariant(
      screenshot?.variant === expected.id &&
        screenshot.projectName === evidenceProject.name &&
        screenshot.browserName === evidenceProject.browserName &&
        screenshot.projectName === report.runtime.projectName &&
        screenshot.browserName === report.runtime.browserName &&
        screenshot.viewport?.width === expected.viewport.width &&
        screenshot.viewport?.height === expected.viewport.height &&
        screenshot.path.endsWith(`/artifacts/screenshot-${expected.id}.png`) &&
        screenshot.reproducibility?.captureCount ===
          SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.captureCount &&
        screenshot.reproducibility?.comparison ===
          SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.comparison &&
        screenshot.reproducibility.repeatPath.endsWith(
          `/artifacts/screenshot-${expected.id}-repeat.png`,
        ),
      `screenshot report ${expected.id} variant is not bound to the declared project, browser, viewport, and artifact identity`,
    );
    const image = await verifiedArtifact(
      { kind: `screenshot-${expected.id}`, path: screenshot.path },
      root,
      receipt.sampleId,
      receipt.runRoot,
    );
    const dimensions = validatePng(image.content);
    invariant(
      dimensions.width === screenshot.viewport.width && dimensions.height === screenshot.viewport.height,
      `screenshot ${expected.id} PNG dimensions do not match the declared viewport`,
    );
    invariant(
      image.sha256 === screenshot.sha256 && image.bytes === screenshot.bytes,
      `screenshot ${expected.id} report digest mismatch`,
    );
    const repeat = await verifiedArtifact(
      { kind: `screenshot-${expected.id}-repeat`, path: screenshot.reproducibility.repeatPath },
      root,
      receipt.sampleId,
      receipt.runRoot,
    );
    const repeatDimensions = validatePng(repeat.content);
    invariant(
      repeatDimensions.width === screenshot.viewport.width &&
        repeatDimensions.height === screenshot.viewport.height,
      `screenshot ${expected.id} repeat PNG dimensions do not match the declared viewport`,
    );
    invariant(
      repeat.sha256 === screenshot.reproducibility.repeatSha256 &&
        repeat.bytes === screenshot.reproducibility.repeatBytes,
      `screenshot ${expected.id} repeat report digest mismatch`,
    );
    invariant(
      image.sha256 === repeat.sha256 && image.bytes === repeat.bytes && image.content.equals(repeat.content),
      `screenshot ${expected.id} captures are not byte-identical within the bound browser session`,
    );
  }
}

async function validateLiveEvidence(evidence, evidencePath, receipt, root) {
  const persistedArtifact = await verifiedArtifact(
    { kind: "live-evidence", path: evidencePath },
    root,
    receipt.sampleId,
    receipt.runRoot,
  );
  const persistedEvidence = JSON.parse(persistedArtifact.content.toString("utf8"));
  invariant(JSON.stringify(persistedEvidence) === JSON.stringify(evidence), "live gate copy does not match its bound evidence file");
  invariant(validateLiveEvidenceSchema(evidence), "live evidence does not satisfy the executed evidence schema");
  const { validateEvidenceEnvelope, validateLiveEvidenceProducer } = await import("./sample-contract.mjs");
  validateEvidenceEnvelope(evidence, { now: receipt.observedAt, maxFutureSkewSeconds: 300 });
  const sample = catalogSamples.get(receipt.sampleId);
  invariant(sample, `${receipt.sampleId} is absent from the reviewed sample catalog`);
  invariant(
    Array.isArray(sample.evidence?.live?.commands) && sample.evidence.live.commands.length === 1,
    `${receipt.sampleId} live gate requires exactly one reviewed command`,
  );
  invariant(
    canonicalCommand(parseSampleCommand(sample.evidence.live.commands[0])) === canonicalCommand(receipt.command.argv),
    `${receipt.sampleId} live receipt command is not the reviewed catalog command`,
  );
  await validateLiveEvidenceProducer(evidence, sample);
  invariant(
    evidence.sampleId === receipt.sampleId && evidence.lane === "live" && evidence.status === "executed",
    "live evidence sample or lane binding mismatch",
  );
  invariant(evidence.sdk.gitCommit === receipt.sourceRevision, "live evidence source revision mismatch");
  invariant(
    typeof evidence.source.endpoint === "string" &&
      evidence.source.endpoint.startsWith("https://") &&
      evidence.provenance?.state === "live" &&
      evidence.semantics?.outcome &&
      Number.isInteger(evidence.semantics.itemCount) &&
      evidence.semantics.itemCount > 0 &&
      Array.isArray(evidence.semantics.assertions) &&
      evidence.semantics.assertions.length > 0 &&
      Number.isFinite(evidence.timing?.totalMs) &&
      evidence.degradation?.state !== "unexpected" &&
      evidence.degradation?.state !== "unavailable",
    "live evidence lacks successful source, semantic, timing, or degradation observations",
  );
  const evidenceTime = Date.parse(evidence.observedAt);
  invariant(
    Number.isFinite(evidenceTime) && Math.abs(Date.parse(receipt.observedAt) - evidenceTime) <= 5 * 60 * 1000,
    "live evidence observation is not fresh for this receipt",
  );
  for (const artifact of evidence.artifacts) {
    invariant(typeof artifact.path === "string" && !path.isAbsolute(artifact.path) && !artifact.path.includes("\\"), "live producer artifact path is unsafe");
    const normalized = path.posix.normalize(artifact.path);
    invariant(normalized === artifact.path && !normalized.startsWith("../"), "live producer artifact path escapes the repository");
    let bytes;
    if (artifact.kind === "producer-generator") {
      invariant(!normalized.startsWith("samples/evidence/"), "live producer source cannot be supplied by the evidence tree");
      bytes = await readCanonicalBoundedFile(root, normalized, {
        label: "live producer source",
        maxBytes: MAX_REPORT_BYTES,
      });
    } else {
      bytes = (
        await verifiedArtifact(
          { kind: artifact.kind, path: normalized },
          root,
          receipt.sampleId,
          receipt.runRoot,
        )
      ).content;
    }
    invariant(sha256(bytes) === artifact.sha256, "live producer artifact digest mismatch");
  }
}

async function validatePackedBuildReport(report, receipt, root) {
  const contract = playwrightContracts.get(receipt.sampleId);
  invariant(contract, `${receipt.sampleId} has no declared packed-build contract`);
  invariant(report.sdkMode === "packed" && report.resolution?.mode === "packed", "packed build did not use packed SDK resolution");
  invariant(/^[a-f0-9]{64}$/.test(report.packageTarballSha256), "packed build tarball digest is missing");
  const tarball = await verifiedArtifact(
    { kind: "packed-sdk-tarball", path: report.packageTarball },
    root,
    receipt.sampleId,
    receipt.runRoot,
  );
  invariant(
    tarball.sha256 === report.packageTarballSha256 && tarball.bytes === report.packageTarballBytes,
    "packed SDK tarball digest or byte count mismatch",
  );

  const { absolute: canonicalDist } = await verifiedRunDirectory(
    report.sampleDistRoot,
    root,
    receipt.sampleId,
    receipt.runRoot,
    "packed sample dist",
  );
  const actualFiles = await collectFiles(canonicalDist, {
    maxFiles: 1_000,
    maxBytes: 64 * 1024 * 1024,
    label: "packed sample dist",
  });
  invariant(actualFiles.length > 1, "packed sample dist file count is invalid");
  const actualInventory = [];
  for (const absolute of actualFiles) {
    const metadata = await lstat(absolute);
    actualInventory.push({
      path: path.relative(canonicalDist, absolute).replaceAll(path.sep, "/"),
      bytes: metadata.size,
      sha256: sha256(await readFile(absolute)),
    });
  }
  actualInventory.sort((left, right) => left.path.localeCompare(right.path));
  invariant(Array.isArray(report.files) && new Set(report.files.map((file) => file.path)).size === report.files.length, "packed build inventory is missing or duplicated");
  const declaredInventory = report.files
    .map(({ path: filePath, bytes, sha256: digest }) => ({ path: filePath, bytes, sha256: digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
  invariant(JSON.stringify(declaredInventory) === JSON.stringify(actualInventory), "packed build report does not match the bounded sample dist tree");

  const resolutionPath = path.join(canonicalDist, "honua-sample-sdk-resolution.json");
  const persistedResolution = JSON.parse(await readFile(resolutionPath, "utf8"));
  invariant(JSON.stringify(persistedResolution) === JSON.stringify(report.resolution), "packed resolution report does not match the emitted build artifact");
  invariant(
    report.resolution.format === "honua.sdk.sample-resolution.v1" &&
      report.resolution.schemaVersion === 1 &&
      report.resolution.package?.name === "@honua/sdk-js" &&
      typeof report.resolution.package.version === "string",
    "packed resolution format or package identity is invalid",
  );
  invariant(Array.isArray(report.resolution.entrypoints), "packed resolution entrypoints are missing");
  const declaredEntrypoints = report.resolution.entrypoints.map((entrypoint) => entrypoint.specifier).sort();
  invariant(
    new Set(declaredEntrypoints).size === declaredEntrypoints.length &&
      JSON.stringify(declaredEntrypoints) === JSON.stringify([...contract.sdkEntrypoints].sort()),
    "packed resolution entrypoint set does not match the sample contract",
  );
  for (const entrypoint of report.resolution.entrypoints) {
    const normalizedExportTarget =
      typeof entrypoint.exportTarget === "string" && entrypoint.exportTarget.startsWith("./")
        ? path.posix.normalize(entrypoint.exportTarget.slice(2))
        : undefined;
    invariant(
      entrypoint.hashSubject === "packed-published-entrypoint-file" &&
        typeof entrypoint.exportTarget === "string" &&
        normalizedExportTarget?.startsWith("dist/") &&
        `./${normalizedExportTarget}` === entrypoint.exportTarget &&
        /^[a-f0-9]{64}$/.test(entrypoint.sha256),
      "packed resolution entrypoint evidence is invalid",
    );
  }
  invariant(Array.isArray(report.resolution.bundle) && report.resolution.bundle.length > 0, "packed bundle evidence is empty");
  const actualBundle = new Map(
    actualInventory
      .map((file) => [file.path, file])
      .filter(([fileName]) => !["index.html", "honua-sample-sdk-resolution.json"].includes(fileName)),
  );
  invariant(actualBundle.size > 0, "packed sample dist has no Vite bundle files");
  const declaredBundleNames = report.resolution.bundle.map((entry) => entry.fileName);
  invariant(
    new Set(declaredBundleNames).size === declaredBundleNames.length &&
      JSON.stringify([...declaredBundleNames].sort()) === JSON.stringify([...actualBundle.keys()].sort()),
    "packed bundle evidence does not exactly cover the final Vite bundle",
  );
  for (const bundled of report.resolution.bundle) {
    invariant(
      typeof bundled.fileName === "string" &&
        path.posix.normalize(bundled.fileName) === bundled.fileName &&
        !bundled.fileName.startsWith("../") &&
        ["asset", "chunk"].includes(bundled.kind) &&
        bundled.hashSubject === "final-written-bundle-file" &&
        /^[a-f0-9]{64}$/.test(bundled.sha256) &&
        Number.isInteger(bundled.bytes) &&
        bundled.bytes >= 0,
      "packed bundle evidence entry is invalid",
    );
    const built = actualBundle.get(bundled.fileName);
    invariant(built && built.sha256 === bundled.sha256 && built.bytes === bundled.bytes, "packed bundle digest does not match final build output");
  }
}

async function validateGateSemantics(receipt, artifact, root) {
  const report = parseJsonReport(artifact, `${receipt.sampleId} ${receipt.gate} report`);
  invariant(report.sampleId === receipt.sampleId && report.sourceRevision === receipt.sourceRevision, `${receipt.gate} report source binding mismatch`);
  invariant(
    Array.isArray(report.command) && canonicalCommand(report.command) === canonicalCommand(receipt.command.argv),
    `${receipt.gate} report command mismatch`,
  );
  if (["browser", "accessibility", "console", "responsive"].includes(receipt.gate)) {
    invariant(
      report.format === "honua.sdk.sample-playwright-gate.v1" && report.gate === receipt.gate,
      `${receipt.sampleId} ${receipt.gate} Playwright wrapper binding mismatch`,
    );
    validatePlaywrightGate(report.playwright, receipt.sampleId, receipt.gate);
    return;
  }
  if (receipt.gate === "fixture") {
    invariant(report.format === "honua.sdk.sample-fixture-gate.v1", "fixture report format is invalid");
    invariant(report.sampleId === receipt.sampleId && report.sourceRevision === receipt.sourceRevision, "fixture report binding mismatch");
    invariant(
      report.transport === "loopback-http" &&
        report.networkScope === "loopback-only" &&
        report.host === "127.0.0.1" &&
        Number.isInteger(report.port) &&
        report.port > 0 &&
        report.port <= 65_535 &&
        report.ready === true &&
        report.started === true &&
        report.probe?.method === "GET" &&
        report.probe?.path === "/" &&
        report.probe?.status === 200 &&
        Number.isInteger(report.probe?.bodyBytes) &&
        report.probe.bodyBytes > 0 &&
        /^[a-f0-9]{64}$/.test(report.probe.bodySha256) &&
        report.closed === true &&
        report.listeningAfterClose === false &&
        report.activeConnectionsAfterClose === 0,
      "fixture report did not prove readiness, an isolated probe, and closed resources",
    );
    return;
  }
  if (receipt.gate === "packed-build") {
    invariant(report.format === "honua.sdk.sample-packed-build-gate.v1", "packed build report format is invalid");
    invariant(report.sampleId === receipt.sampleId && report.sourceRevision === receipt.sourceRevision, "packed build report binding mismatch");
    return validatePackedBuildReport(report, receipt, root);
  }
  if (receipt.gate === "screenshot") return validateScreenshotReport(report, receipt, root);
  if (receipt.gate === "performance") {
    invariant(report.format === "honua.sdk.sample-performance-gate.v1", "performance report format is invalid");
    const evidenceProject = declaredEvidenceProject(receipt.sampleId);
    const observations = report.measurement?.observations;
    const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0;
    const finitePositive = (value) => Number.isFinite(value) && value > 0;
    invariant(
      report.measurement?.projectName === evidenceProject.name &&
        report.measurement?.browserName === evidenceProject.browserName &&
        report.measurement?.source === "browser-performance-api" &&
        report.measurement?.metric === SAMPLE_PERFORMANCE_METRIC &&
        report.measurement?.unit === "ms" &&
        report.measurement?.budget?.operator === "<=" &&
        report.measurement?.budget?.value === SAMPLE_PERFORMANCE_BUDGET_MS &&
        Number.isFinite(report.measurement?.value) &&
        report.measurement.value >= 0 &&
        report.measurement.value <= SAMPLE_PERFORMANCE_BUDGET_MS &&
        observations?.navigation?.sampleReadyMs === report.measurement.value &&
        observations?.navigation?.entryType === "navigation" &&
        finitePositive(observations.navigation.responseStartMs) &&
        finitePositive(observations.navigation.domContentLoadedMs) &&
        finitePositive(observations.navigation.loadEventMs) &&
        observations.navigation.responseStartMs <= observations.navigation.domContentLoadedMs &&
        observations.navigation.domContentLoadedMs <= observations.navigation.loadEventMs &&
        observations.navigation.loadEventMs <= observations.navigation.sampleReadyMs &&
        Number.isInteger(observations?.resources?.count) &&
        observations.resources.count > 0 &&
        finiteNonnegative(observations.resources.transferBytes) &&
        finitePositive(observations.resources.decodedBodyBytes) &&
        finitePositive(observations.resources.completedByMs) &&
        observations.resources.completedByMs <= observations.navigation.sampleReadyMs &&
        observations?.interaction?.name === "evidence-drawer-keyboard-workflow" &&
        finitePositive(observations.interaction.durationMs),
      "performance report is not bound to browser-observed navigation, resource, interaction, and budget measurements",
    );
    return;
  }
  if (receipt.gate === "live") {
    invariant(report.format === "honua.sdk.sample-live-gate.v1", "live gate report format is invalid");
    return validateLiveEvidence(report.evidence, report.evidencePath, receipt, root);
  }
}

export function requiredReceiptGates(profile) {
  const required = ["fixture"];
  for (const [profileName, receiptName] of Object.entries(profileGateNames)) {
    if (profile?.gates?.[profileName] === true) required.push(receiptName);
  }
  return [...new Set(required)].sort();
}

export async function createGateReceipt(options) {
  const root = options.projectRoot ?? projectRoot;
  invariant(SAMPLE_GATE_NAMES.includes(options.gate), `unknown sample gate: ${options.gate}`);
  invariant(/^[a-f0-9]{40}$/.test(options.sourceRevision), "source revision must be a full lowercase Git SHA");
  canonicalCommand(options.command);
  if (options.verifyCheckout !== false) {
    invariant(options.sourceSnapshot, "gate receipt creation requires a pre-execution source snapshot");
    invariant(options.sourceSnapshot.sourceRevision === options.sourceRevision, "gate source snapshot revision mismatch");
    await verifyGateSourceSnapshot(options.sourceSnapshot, root);
  }
  const sourceDigest = options.sourceSnapshot?.sourceDigest ?? options.sourceDigest ?? evidenceNeutralSourceDigest(root);
  invariant(/^[a-f0-9]{64}$/.test(sourceDigest), "gate receipt source digest is invalid");
  const observedAt = options.observedAt ?? new Date().toISOString();
  const expiresAt = options.expiresAt ?? new Date(Date.parse(observedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const producerBytes = await readCanonicalBoundedFile(root, "scripts/sample-runner.mjs", {
    label: "gate receipt producer",
    maxBytes: MAX_REPORT_BYTES,
  });
  invariant(options.artifacts.length === 1, `${options.gate} receipt requires exactly one gate-specific report`);
  const artifact = await verifiedArtifact(
    options.artifacts[0],
    root,
    options.sampleId,
    options.sourceSnapshot?.runRoot ?? options.runRoot,
    options.verifyCheckout === false ? undefined : options.sourceSnapshot.capturedAtMs,
  );
  invariant(artifact.kind === gateArtifactKinds[options.gate], `${options.gate} receipt artifact kind must be ${gateArtifactKinds[options.gate]}`);

  const receipt = {
    $schema: path.posix.relative(
      path.posix.dirname(options.receiptPath ?? "samples/evidence/receipt.json"),
      "samples/contract/v2/schemas/sample-gate-receipt.schema.json",
    ),
    format: "honua.sdk.sample-gate-receipt.v1",
    schemaVersion: 1,
    sampleId: options.sampleId,
    gate: options.gate,
    status: "passed",
    sdkMode: options.sdkMode,
    sourceRevision: options.sourceRevision,
    sourceDigest,
    runRoot: options.sourceSnapshot?.runRoot ?? options.runRoot,
    command: { argv: [...options.command] },
    producer: {
      id: "honua-sdk-sample-runner",
      version: 1,
      path: "scripts/sample-runner.mjs",
      sha256: sha256(producerBytes),
    },
    observedAt,
    expiresAt,
    durationMs: options.durationMs,
    artifacts: [{ kind: artifact.kind, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 }],
  };
  await validateGateReceipt(receipt, {
    sampleId: options.sampleId,
    gate: options.gate,
    command: options.command,
    sourceRevision: options.sourceRevision,
    sourceDigest,
    now: observedAt,
    projectRoot: root,
    verifyCheckout: false,
  });
  return receipt;
}

export function validateGateReceiptStructure(receipt, options = {}) {
  invariant(receipt && typeof receipt === "object" && !Array.isArray(receipt), "gate receipt must be an object");
  if (!validateSchema(receipt)) {
    const detail = validateSchema.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`sample gate receipt schema validation failed: ${detail}`);
  }
  if (options.sampleId) invariant(receipt.sampleId === options.sampleId, "gate receipt sample binding mismatch");
  if (options.gate) invariant(receipt.gate === options.gate, "gate receipt gate binding mismatch");
  if (options.sourceRevision) invariant(receipt.sourceRevision === options.sourceRevision, "gate receipt source revision mismatch");
  if (options.sourceDigest) invariant(receipt.sourceDigest === options.sourceDigest, "gate receipt source digest mismatch");
  if (options.command) {
    invariant(canonicalCommand(receipt.command.argv) === canonicalCommand(options.command), "gate receipt command binding mismatch");
  }
  canonicalCommand(receipt.command.argv);
  invariant(
    receipt.runRoot.startsWith(`samples/evidence/${receipt.sampleId}/runs/`),
    "gate receipt run root does not match its sample",
  );
  invariant(receipt.artifacts.length === 1, `${receipt.gate} receipt requires exactly one gate-specific report`);
  const [artifact] = receipt.artifacts;
  invariant(artifact.kind === gateArtifactKinds[receipt.gate], `${receipt.gate} receipt artifact kind is invalid`);
  invariant(
    artifact.path.startsWith(`${receipt.runRoot}/`) && path.posix.normalize(artifact.path) === artifact.path,
    `${receipt.gate} receipt artifact is outside its evidence run`,
  );
  return receipt;
}

export async function validateGateReceipt(receipt, options = {}) {
  validateGateReceiptStructure(receipt, options);

  const now = Date.parse(options.now ?? new Date().toISOString());
  const observedAt = Date.parse(receipt.observedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  invariant(Number.isFinite(now), "receipt validation time is invalid");
  invariant(observedAt <= now + 5 * 60 * 1000, "gate receipt observation is more than five minutes in the future");
  invariant(expiresAt > observedAt, "gate receipt expiry must follow observation");
  invariant(expiresAt - observedAt <= 7 * 24 * 60 * 60 * 1000, "gate receipt exceeds seven-day freshness policy");
  invariant(now < expiresAt, "gate receipt is stale");

  const root = options.projectRoot ?? projectRoot;
  if (options.verifyCheckout !== false && !derivedArtifactsRelaxed()) {
    verifyEvidenceNeutralCheckout(receipt.sourceDigest, root, receipt.sourceRevision);
  }
  const producerBytes = await readCanonicalBoundedFile(root, receipt.producer.path, {
    label: "gate receipt producer",
    maxBytes: MAX_REPORT_BYTES,
  });
  if (!derivedArtifactsRelaxed()) {
    invariant(sha256(producerBytes) === receipt.producer.sha256, "gate receipt producer digest mismatch");
  }
  const artifact = receipt.artifacts[0];
  const verified = await verifiedArtifact(artifact, root, receipt.sampleId, receipt.runRoot);
  invariant(verified.bytes === artifact.bytes, `gate receipt artifact byte count mismatch: ${artifact.path}`);
  invariant(verified.sha256 === artifact.sha256, `gate receipt artifact digest mismatch: ${artifact.path}`);
  await validateGateSemantics(receipt, verified, root);
  return receipt;
}

export async function validateQualificationReceiptSet(options) {
  const root = options.projectRoot ?? projectRoot;
  const relaxed = options.verifyCheckout === false || derivedArtifactsRelaxed();
  const sourceDigest = relaxed ? options.sourceDigest : verifyEvidenceNeutralCheckout(options.sourceDigest, root);
  const required = requiredReceiptGates(options.profile);
  const directory = path.join(options.receiptRoot, options.sample.id, "receipts");
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${options.sample.id}: missing gate receipt directory`);
    throw error;
  }
  invariant(directoryMetadata.isDirectory() && !directoryMetadata.isSymbolicLink(), `${options.sample.id}: receipt directory must not be a symlink`);
  const canonicalDirectory = await realpath(directory);
  invariant(canonicalDirectory.startsWith(`${path.resolve(options.receiptRoot)}${path.sep}`), `${options.sample.id}: receipt directory escapes its root`);
  const expectedNames = required.map((gate) => `${gate}.v1.json`).sort();
  const names = [];
  const handle = await opendir(canonicalDirectory);
  try {
    for await (const entry of handle) {
      invariant(
        names.length < expectedNames.length,
        `${options.sample.id}: gate receipt set mismatch; expected [${expectedNames.join(", ")}], found more than ${expectedNames.length} entries`,
      );
      names.push(entry.name);
    }
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (error?.code !== "ERR_DIR_CLOSED") throw error;
    }
  }
  invariant(
    JSON.stringify([...names].sort()) === JSON.stringify(expectedNames),
    `${options.sample.id}: gate receipt set mismatch; expected [${expectedNames.join(", ")}], found [${[...names].sort().join(", ")}]`,
  );
  const commandGroups = new Map();
  for (const gate of required) {
    const receiptName = `${gate}.v1.json`;
    const receiptPath = path.join(directory, receiptName);
    const metadata = await lstat(receiptPath);
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${options.sample.id} ${gate} receipt must be a regular non-symlink file`);
    const receiptRelative = path.relative(options.receiptRoot, receiptPath).replaceAll(path.sep, "/");
    const receiptBytes = await readCanonicalBoundedFile(options.receiptRoot, receiptRelative, {
      label: `${options.sample.id} ${gate} qualification receipt`,
      maxBytes: 1024 * 1024,
    });
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const expectedCommand = options.expectedCommand(options.sample, gate);
    await validateGateReceipt(receipt, {
      sampleId: options.sample.id,
      gate,
      command: expectedCommand,
      sourceDigest,
      now: options.now,
      projectRoot: root,
      verifyCheckout: relaxed ? false : options.verifyCheckout,
    });
    const commandKey = canonicalCommand(expectedCommand);
    const group = commandGroups.get(commandKey);
    invariant(
      !group || group.runRoot === receipt.runRoot,
      `${options.sample.id}: gates produced by one command must share one evidence run root (${[
        ...(group?.gates ?? []),
        gate,
      ].join(", ")})`,
    );
    if (group) group.gates.push(gate);
    else commandGroups.set(commandKey, { runRoot: receipt.runRoot, gates: [gate] });
  }
}
