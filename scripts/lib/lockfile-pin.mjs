import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The lockfile digest pinned into the content-addressed sample-bundle
 * publication path (honua-io/honua-sdk-js#1325).
 *
 * The privileged publish job never checks out source, so the only thing it can
 * judge a manifest's `build.lockfileSha256` against is a constant carried in
 * the workflow file itself. That constant is bound in two places -- the
 * workflow env and the policy validator that asserts the workflow's exact
 * shape -- and the two must move together or the validator rejects the
 * workflow. Everything in this module exists to make that pair one unit: read
 * both, compare both, rewrite both, and fail naming both.
 *
 * Deliberately dependency-free (builtins only). The policy tests that consume
 * it run in CI *before* `npm ci`, and the release-branch synchroniser runs from
 * a pristine trusted checkout, so a YAML parser is not available in either
 * place. The digest is therefore extracted by an anchored single-match regular
 * expression rather than by parsing; the sample-bundle attestation test
 * cross-checks that extraction against the genuinely parsed workflow document,
 * so the cheap reader can never drift from the real one.
 */
export const LOCKFILE_PATH = "package-lock.json";
export const MANIFEST_PATH = "package.json";
export const PIN_WORKFLOW_PATH =
  ".github/workflows/publish-content-addressed-sample-bundles.yml";
export const PIN_POLICY_PATH = "scripts/immutable-sample-bundle-attestation.mjs";

/**
 * The message of the one commit allowed to move the pin without a human.
 *
 * Declared here rather than beside the synchroniser so the trusted base-refresh
 * policy can recognise -- and rewind -- that commit without importing anything
 * that talks to GitHub.
 */
export const PIN_COMMIT_MESSAGE =
  "chore: pin the sample-bundle lockfile digest to the release version bump";

/** Every file the pin is bound into, in the order the failure message names them. */
export const BOUND_PIN_PATHS = Object.freeze([
  PIN_WORKFLOW_PATH,
  PIN_POLICY_PATH,
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

// Anchored, whole-line, and applied globally so a second occurrence is an
// error rather than a silently ignored copy.
const WORKFLOW_PIN =
  /^([ \t]*EXPECTED_LOCKFILE_SHA256:[ \t]*)([0-9a-f]{64})([ \t]*)$/gmu;
const POLICY_PIN =
  /^(export const EXPECTED_LOCKFILE_SHA256 =\n[ \t]*")([0-9a-f]{64})(";)$/gmu;

const PIN_PATTERNS = new Map([
  [PIN_WORKFLOW_PATH, WORKFLOW_PIN],
  [PIN_POLICY_PATH, POLICY_PIN],
]);

/** The remediation sentence. It must keep naming both bound files. */
export function boundPinRemediation() {
  return (
    `Update EXPECTED_LOCKFILE_SHA256 in ${PIN_WORKFLOW_PATH} and the bound copy in ` +
    `${PIN_POLICY_PATH}, or sample-bundle publication will fail at dispatch.`
  );
}

export function lockfileDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function patternFor(boundPath) {
  const pattern = PIN_PATTERNS.get(boundPath);
  if (!pattern) throw new Error(`${boundPath} does not carry the pinned lockfile digest.`);
  return pattern;
}

/** Extract the single pinned digest a bound file declares. */
export function readPinnedDigest(text, boundPath) {
  const pattern = new RegExp(patternFor(boundPath));
  const matches = [...String(text).matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${boundPath} must declare EXPECTED_LOCKFILE_SHA256 exactly once; found ${matches.length}. ` +
        boundPinRemediation(),
    );
  }
  return matches[0][2];
}

/** Rewrite the single pinned digest a bound file declares. */
export function writePinnedDigest(text, boundPath, digest) {
  if (!SHA256.test(String(digest))) {
    throw new Error("A pinned lockfile digest must be 64 lowercase hex characters.");
  }
  readPinnedDigest(text, boundPath);
  const pattern = new RegExp(patternFor(boundPath));
  return String(text).replace(pattern, (_match, prefix, _old, suffix = "") => `${prefix}${digest}${suffix}`);
}

/**
 * Compare a lockfile against the digest its bound files pin.
 *
 * Returns `{ status: "in-sync" | "stale" | "unbound", ... }` and never throws
 * for a mismatch, so callers can choose between failing (ordinary CI) and
 * rewriting (the release-branch synchroniser).
 */
export function inspectLockfilePin({ lockfile, boundTexts }) {
  const actual = lockfileDigest(lockfile);
  const pinned = new Map();
  for (const boundPath of BOUND_PIN_PATHS) {
    const text = boundTexts?.[boundPath];
    if (typeof text !== "string") throw new Error(`Bound pin source for ${boundPath} is required.`);
    pinned.set(boundPath, readPinnedDigest(text, boundPath));
  }
  const distinct = new Set(pinned.values());
  if (distinct.size !== 1) {
    return {
      status: "unbound",
      actual,
      pinned: Object.fromEntries(pinned),
      message:
        `The pinned lockfile digest disagrees between its bound copies: ` +
        BOUND_PIN_PATHS.map((boundPath) => `${boundPath} pins ${pinned.get(boundPath)}`).join(", ") +
        `. The copies must move together. ${boundPinRemediation()}`,
    };
  }
  const [only] = distinct;
  if (only === actual) {
    return { status: "in-sync", actual, pinned: Object.fromEntries(pinned) };
  }
  return {
    status: "stale",
    actual,
    pinned: Object.fromEntries(pinned),
    message: `${LOCKFILE_PATH} now hashes to ${actual}. ${boundPinRemediation()}`,
  };
}

async function readBoundTexts(root) {
  const entries = await Promise.all(
    BOUND_PIN_PATHS.map(async (boundPath) => [boundPath, await readFile(path.join(root, boundPath), "utf8")]),
  );
  return Object.fromEntries(entries);
}

/** Read a checkout and report whether the pin still matches its lockfile. */
export async function inspectLockfilePinAt(root) {
  return inspectLockfilePin({
    lockfile: await readFile(path.join(root, LOCKFILE_PATH)),
    boundTexts: await readBoundTexts(root),
  });
}

/**
 * Fail unless the pin matches the committed lockfile.
 *
 * This is the guard proper. It is a hard failure by design: the pin has to move
 * in the same change that moves the lockfile, so that an *undeclared* lockfile
 * change -- a smuggled dependency -- cannot reach the publication path.
 */
export async function assertLockfilePinInSync(root) {
  const result = await inspectLockfilePinAt(root);
  if (result.status !== "in-sync") throw new Error(result.message);
  return result;
}

/** Rewrite both bound copies to name `digest`. Returns the files it changed. */
export async function writeLockfilePinAt(root, digest) {
  const changed = [];
  for (const boundPath of BOUND_PIN_PATHS) {
    const absolute = path.join(root, boundPath);
    const text = await readFile(absolute, "utf8");
    const next = writePinnedDigest(text, boundPath, digest);
    if (next === text) continue;
    await writeFile(absolute, next);
    changed.push(boundPath);
  }
  return changed;
}

function collectDifferences(base, head, keyPath, differences) {
  if (base === head) return;
  const baseIsObject = base !== null && typeof base === "object";
  const headIsObject = head !== null && typeof head === "object";
  if (!baseIsObject || !headIsObject || Array.isArray(base) !== Array.isArray(head)) {
    differences.push({ path: [...keyPath], from: base, to: head });
    return;
  }
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const inBase = Object.hasOwn(base, key);
    const inHead = Object.hasOwn(head, key);
    if (!inBase || !inHead) {
      differences.push({
        path: [...keyPath, key],
        from: inBase ? base[key] : undefined,
        to: inHead ? head[key] : undefined,
      });
      continue;
    }
    collectDifferences(base[key], head[key], [...keyPath, key], differences);
  }
}

/** Every value that differs between two lockfile documents, as key paths. */
export function lockfileDifferences(baseLockfileText, headLockfileText) {
  const differences = [];
  collectDifferences(JSON.parse(baseLockfileText), JSON.parse(headLockfileText), [], differences);
  return differences;
}

function pointer(keyPath) {
  return keyPath.length === 0 ? "(document)" : keyPath.join(".");
}

/**
 * Prove that a lockfile changed by nothing but a first-party version bump.
 *
 * This is what keeps recomputing the pin on a release branch from becoming a
 * hole. The synchroniser does not trust whatever lockfile the branch happens to
 * carry; it proves the branch lockfile equals the *trusted trunk* lockfile
 * except for `version` strings on packages that are local to this repository,
 * each moving from exactly the trunk release version to exactly the version the
 * release is cutting. A dependency change cannot hide in that shape: it either
 * adds or removes a `packages` entry, or edits a `resolved`/`integrity`/range
 * value, and every one of those is a difference this rejects.
 */
export function assertMechanicalVersionBump({
  baseLockfileText,
  headLockfileText,
  baseVersion,
  headVersion,
}) {
  if (!VERSION.test(String(baseVersion)) || !VERSION.test(String(headVersion))) {
    throw new Error("The release version bump must move between two exact semantic versions.");
  }
  if (baseVersion === headVersion) {
    throw new Error(
      `The release branch declares the same version as trunk (${headVersion}), so no version bump is in flight ` +
        `and ${LOCKFILE_PATH} must not differ from trunk at all.`,
    );
  }
  const base = JSON.parse(baseLockfileText);
  const differences = lockfileDifferences(baseLockfileText, headLockfileText);
  if (differences.length === 0) {
    throw new Error(
      `The release branch bumps ${baseVersion} to ${headVersion} but left ${LOCKFILE_PATH} untouched, so the ` +
        `lockfile does not describe the release being cut.`,
    );
  }
  for (const difference of differences) {
    const label = `${LOCKFILE_PATH}: ${pointer(difference.path)}`;
    if (difference.from !== baseVersion || difference.to !== headVersion) {
      throw new Error(
        `${label} changed from ${JSON.stringify(difference.from)} to ${JSON.stringify(difference.to)}, which is not ` +
          `the ${baseVersion} to ${headVersion} release version bump. Refusing to recompute the pinned lockfile ` +
          `digest for an undeclared lockfile change.`,
      );
    }
    const isRootVersion = difference.path.length === 1 && difference.path[0] === "version";
    const isPackageVersion =
      difference.path.length === 3 && difference.path[0] === "packages" && difference.path[2] === "version";
    if (!isRootVersion && !isPackageVersion) {
      throw new Error(
        `${label} is not a first-party package version field. Refusing to recompute the pinned lockfile digest ` +
          `for an undeclared lockfile change.`,
      );
    }
    if (!isPackageVersion) continue;
    const entry = base.packages?.[difference.path[1]];
    if (
      entry === null ||
      typeof entry !== "object" ||
      Object.hasOwn(entry, "resolved") ||
      Object.hasOwn(entry, "integrity") ||
      entry.link === true
    ) {
      throw new Error(
        `${label} belongs to an installed dependency, not a package local to this repository. Refusing to ` +
          `recompute the pinned lockfile digest for an undeclared lockfile change.`,
      );
    }
  }
  return { differences, baseVersion, headVersion };
}

/** The `version` a package manifest declares, validated. */
export function manifestVersion(manifestText, label) {
  const manifest = JSON.parse(manifestText);
  const version = manifest?.version;
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error(`${label} does not declare an exact semantic version.`);
  }
  return version;
}
