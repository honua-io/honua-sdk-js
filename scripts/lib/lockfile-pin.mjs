import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The dependency digest pinned into the content-addressed sample-bundle
 * publication path (honua-io/honua-sdk-js#1325, #1357).
 *
 * The privileged publish job never checks out source, so the only thing it can
 * judge a manifest's `build.lockfileSha256` against is a constant carried in
 * the workflow file itself. That constant is bound in two places -- the
 * workflow env and the policy validator that asserts the workflow's exact
 * shape -- and the two must move together or the validator rejects the
 * workflow. Everything in this module exists to make that pair one unit: read
 * both, compare both, rewrite both, and fail naming both.
 *
 * The digest is taken over a *dependency projection* of `package-lock.json`
 * rather than its literal bytes, and that is what makes the pin enforceable at
 * all. Release Please's version bump rewrites the lockfile's own `version`
 * fields on every release, so a byte digest was unsatisfiable on any release
 * branch by construction -- every release pull request broke the pin, and the
 * failure reached trunk through `release-please-ci` (#1357). Nothing could
 * repair it either: `GITHUB_TOKEN` cannot create a commit that touches
 * `.github/workflows/**`, so no job in this repository is able to move the
 * workflow's copy. The projection removes the problem instead of automating
 * around it -- the mechanical change cannot move the digest, and nothing else
 * about the lockfile can hide from it. See `lockfileDependencyDigest`.
 *
 * Deliberately dependency-free (builtins only). The policy tests that consume
 * it run in CI *before* `npm ci`, and `scripts/build-sample-bundles.mjs` is
 * imported by the attestation policy from the pristine `governance/` checkout,
 * which is never `npm ci`-installed. The pinned constant is likewise extracted
 * by an anchored single-match regular expression rather than by parsing YAML;
 * the sample-bundle attestation test cross-checks that extraction against the
 * genuinely parsed workflow document, so the cheap reader cannot drift from
 * the real one.
 */
export const LOCKFILE_PATH = "package-lock.json";
export const PIN_WORKFLOW_PATH =
  ".github/workflows/publish-content-addressed-sample-bundles.yml";
export const PIN_POLICY_PATH = "scripts/immutable-sample-bundle-attestation.mjs";

/** Every file the pin is bound into, in the order the failure message names them. */
export const BOUND_PIN_PATHS = Object.freeze([
  PIN_WORKFLOW_PATH,
  PIN_POLICY_PATH,
]);

const SHA256 = /^[0-9a-f]{64}$/u;

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

// A value no semantic version can equal, so a normalised entry is never
// confused with a real one.
const FIRST_PARTY_VERSION = "\u0000first-party";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function parseLockfile(text, label) {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return parsed;
}

/** A package entry this repository owns, rather than one npm installed. */
function firstPartyPackage(entryPath) {
  return !entryPath.split("/").includes("node_modules");
}

/**
 * The lockfile reduced to what it says about *dependencies*.
 *
 * Every installed package keeps its name, version, `resolved`, `integrity`,
 * flags and declared ranges, so adding, removing, re-pointing or re-versioning
 * a dependency always moves the digest -- including a dependency whose version
 * is made to look exactly like the release bump. The only thing normalised
 * away is the `version` of a package this repository owns: the root document
 * and any `packages` entry that is not inside `node_modules`. That is
 * precisely, and only, what Release Please rewrites when it cuts a release,
 * which is why a release branch no longer breaks the pin.
 *
 * Serialised canonically (sorted keys), so reformatting the lockfile does not
 * move the digest either. npm writes it deterministically, and a reformat by
 * definition changes no dependency.
 */
export function lockfileDependencyProjection(lockfileText, label = LOCKFILE_PATH) {
  const lockfile = parseLockfile(
    typeof lockfileText === "string" ? lockfileText : Buffer.from(lockfileText).toString("utf8"),
    label,
  );
  if (typeof lockfile.version === "string") lockfile.version = FIRST_PARTY_VERSION;
  const packages = lockfile.packages;
  if (packages !== null && typeof packages === "object" && !Array.isArray(packages)) {
    for (const [entryPath, entry] of Object.entries(packages)) {
      if (!firstPartyPackage(entryPath)) continue;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (typeof entry.version === "string") entry.version = FIRST_PARTY_VERSION;
    }
  }
  return canonicalJson(lockfile);
}

/**
 * The pinned digest: sha256 over the dependency projection.
 *
 * This is the value the builder records as `manifest.build.lockfileSha256` and
 * the value the privileged publish job compares against its constant, so all
 * three must be computed here and nowhere else.
 */
export function lockfileDependencyDigest(lockfileText, label = LOCKFILE_PATH) {
  return createHash("sha256").update(lockfileDependencyProjection(lockfileText, label)).digest("hex");
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
  const actual = lockfileDependencyDigest(lockfile);
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
    message: `${LOCKFILE_PATH} dependencies now hash to ${actual}. ${boundPinRemediation()}`,
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
