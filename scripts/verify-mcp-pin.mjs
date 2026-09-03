#!/usr/bin/env node
/**
 * Verify that the MCP/CLI candidate artifact pinned into generated terminal MCP
 * client configurations is actually installable.
 *
 * `src/local-install.ts` writes `npx -y --package <pin> honua-mcp-proxy` into
 * `.mcp.json` and `claude_desktop_config.json`. A pin that exists only in this
 * repository's release lineage - a tagged version whose npm publish failed, or
 * a version bumped ahead of the last successful publish - produces a
 * configuration that cannot install on a clean machine. Repository tags and
 * `mcp/CHANGELOG.md` entries are therefore *not* publication evidence.
 *
 * Two lanes:
 *
 * - Offline (always available, used by `test/local-install.test.ts`):
 *   `verifyMcpPinLineage()` proves the pin is exact (no tag, range, or floating
 *   specifier), belongs to this repository's own release lineage, and never runs
 *   ahead of `mcp/package.json`.
 * - Live (`HONUA_MCP_PIN_LIVE_ENABLED=true npm run verify:mcp-pin:live`):
 *   `verifyMcpPinPublication()` resolves the pin against the public registry and
 *   compares the recorded tarball integrity. This lane touches the network and
 *   must never run in PR CI.
 *
 * Publication is necessary but not sufficient. `@honua/mcp-server` peer-depends
 * on `@honua/sdk-js`, so the two are a *pair*, and npm's default resolver
 * refuses a pair whose peer range excludes the SDK installed beside it
 * (#1529). `verifyClientPairCoInstallable()` decides that question offline with
 * `satisfiesUnderNpmDefaults()`, a faithful implementation of the rule npm
 * actually applies to prereleases -- see its docstring. `verify:client-pair`
 * then proves the same thing by really installing the pair.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NETWORK_GATE = "HONUA_MCP_PIN_LIVE_ENABLED";
const REGISTRY = "https://registry.npmjs.org";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/**
 * npm package name: an optional `@scope/` prefix and then one name segment.
 * A name therefore carries at most one `/`. Enforcing that here is what makes
 * the registry URL below identify the artifact being verified -- an unchecked
 * name with extra separators would silently address a different registry path
 * while every later assertion still compared the version it found there.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
export const ZERO_TO_MAP_CONFIGS = [
  "mcp/release/zero-to-map/configs/claude-code.mcp.json",
  "mcp/release/zero-to-map/configs/claude-desktop.json",
  "mcp/release/zero-to-map/configs/cursor.json",
];
export const CREATE_APP_PIN_SITES = [
  "packages/create-honua-app/templates.manifest.json",
  "packages/create-honua-app/templates/vanilla-ts/package.json",
  "packages/create-honua-app/templates/react-ts/package.json",
];

/** The dedicated live gate for the registry lane. Never enabled in PR CI. */
export function isMcpPinLiveVerificationEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env?.[NETWORK_GATE] ?? ""));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Parse `name@version`, rejecting tags, ranges, and floating specifiers. */
export function parsePackagePin(pin) {
  const separator = pin.lastIndexOf("@");
  invariant(separator > 0, `MCP package pin ${pin} must be an exact name@version specifier`);
  const name = pin.slice(0, separator);
  const version = pin.slice(separator + 1);
  invariant(
    PACKAGE_NAME.test(name),
    `MCP package pin ${pin} must name a valid npm package (an optional @scope/ prefix and one name segment)`,
  );
  invariant(
    EXACT_VERSION.test(version),
    `MCP package pin ${pin} must name an exact version; tags and ranges ("latest", "^", "~", "*") are floating ` +
      "references and can resolve to an artifact nobody reviewed",
  );
  return { name, version };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Minimal semver precedence comparison, sufficient for this repo's versions. */
export function compareVersions(left, right) {
  const [leftCore, leftPre = ""] = left.split("-", 2);
  const [rightCore, rightPre = ""] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (leftPre === rightPre) return 0;
  if (leftPre === "") return 1;
  if (rightPre === "") return -1;
  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
    const leftId = leftIds[index];
    const rightId = rightIds[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const delta = compareIdentifiers(leftId, rightId);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

/** Read and verify the exact package pins shipped in the zero-to-map configs. */
export function verifyZeroToMapConfigPins({ expectedPin, readConfig = readJson }) {
  return ZERO_TO_MAP_CONFIGS.map((relativePath) => {
    const config = readConfig(relativePath);
    const args = config?.mcpServers?.honua?.args;
    invariant(Array.isArray(args), `${relativePath} must declare mcpServers.honua.args`);
    const packageFlag = args.indexOf("--package");
    invariant(packageFlag >= 0, `${relativePath} must invoke npx with --package`);
    const pin = args[packageFlag + 1];
    invariant(typeof pin === "string", `${relativePath} must put an exact package pin after --package`);
    parsePackagePin(pin);
    invariant(
      pin === expectedPin,
      `${relativePath} pins ${pin}, but generated client configurations pin ${expectedPin}. Advance every shipped ` +
        "config to the coordinated, registry-served pair.",
    );
    return { relativePath, pin };
  });
}

/** Read the SDK coordinate carried by a create-honua-app pin site. */
export function readCreateAppSdkPin(config, relativePath, sdkName) {
  const version = relativePath.endsWith("templates.manifest.json")
    ? config?.sdk?.package === sdkName
      ? config.sdk.version
      : undefined
    : config?.dependencies?.[sdkName];
  invariant(
    typeof version === "string",
    `${relativePath} must pin ${sdkName} in ${
      relativePath.endsWith("templates.manifest.json") ? "sdk.version" : "dependencies"
    }`,
  );
  invariant(EXACT_VERSION.test(version), `${relativePath} must pin ${sdkName} to an exact version, found ${version}`);
  return version;
}

/** Keep every scaffold on the SDK half of the coordinated MCP/SDK pair. */
export function verifyCreateAppPins({ sdkName, expectedVersion, readConfig = readJson }) {
  return CREATE_APP_PIN_SITES.map((relativePath) => {
    const version = readCreateAppSdkPin(readConfig(relativePath), relativePath, sdkName);
    invariant(
      version === expectedVersion,
      `${relativePath} pins ${sdkName}@${version}, but generated MCP clients pin the coordinated ${expectedVersion} pair. ` +
        "Run `npm run sync:mcp-pin` after the pair is published.",
    );
    return { relativePath, pin: `${sdkName}@${version}` };
  });
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** A range token: an operator (possibly empty) followed by a version. */
const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;
/** Stands in for the unbounded comparator an `*`/`x` range desugars to. */
const ANY = Symbol("any");

/** Parse a strict semver string into its ordered parts. Throws on anything else. */
export function parseSemver(raw) {
  const match = SEMVER.exec(String(raw).trim());
  invariant(match, `${raw} is not a strict semver version`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  // A version without a prerelease outranks the same tuple with one.
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftId = left[index];
    const rightId = right[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const delta = compareIdentifiers(leftId, rightId);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function compareSemver(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function sameTuple(left, right) {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function comparator(op, version) {
  return { op, version: parseSemver(version) };
}

/** `1`, `1.2`, `1.x`, `1.2.x` -- a range with a wildcard or omitted part. */
const X_RANGE = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

function isWildcard(part) {
  return part === undefined || part === "x" || part === "X" || part === "*";
}

/**
 * Desugar an X-range into its bounds, or return null when the token names a
 * complete version and the caller should parse it directly.
 *
 * A caret over an X-range is not the same as the band the X-range alone
 * denotes, and it is not the caret of the zero-filled floor either: `^1.2.x`
 * holds the *major*, so it reaches `<2.0.0-0` rather than the `<1.3.0-0` that
 * `1.2.x` and `~1.2.x` stop at. Only the parts the token actually specifies
 * count when picking the part to hold, so `^0.0.x` widens to `<0.1.0-0` rather
 * than the `<0.0.1-0` that caret over a literal `0.0.0` would give.
 *
 * Both bounds are stable versions, so no comparator carries a prerelease --
 * which is precisely why `0.1.x` excludes `0.1.9-beta.0` under npm defaults.
 */
function expandXRange(op, raw) {
  const match = X_RANGE.exec(raw);
  if (!match || (!isWildcard(match[2]) && !isWildcard(match[3]))) return null;
  const [, majorPart, minorPart] = match;
  if (isWildcard(majorPart)) return [{ op: ">=", version: ANY }];
  const major = Number(majorPart);
  const minorWildcard = isWildcard(minorPart);
  const floor = minorWildcard ? `${major}.0.0` : `${major}.${Number(minorPart)}.0`;
  // The band the X-range itself denotes: the whole major for `1.x`, the minor
  // for `1.2.x`.
  const band = minorWildcard ? `${major + 1}.0.0-0` : `${major}.${Number(minorPart) + 1}.0-0`;
  if (op === ">" || op === ">=") return [comparator(">=", floor)];
  if (op === "<") return [comparator("<", floor)];
  if (op === "<=") return [comparator("<", band)];
  invariant(
    op === "" || op === "=" || op === "^" || op === "~",
    `${op}${raw} is not a comparator this verifier understands`,
  );
  // `^1.2.x` holds the major; `^0.2.x` and `^0.0.x` fall back to the band,
  // which is already the minor for both. `^1.x`/`~1.x` widen to the whole
  // major because the minor is the wildcard, so the band is right there too.
  if (op === "^" && !minorWildcard && major !== 0) {
    return [comparator(">=", floor), comparator("<", `${major + 1}.0.0-0`)];
  }
  return [comparator(">=", floor), comparator("<", band)];
}

/**
 * Desugar one range token into the comparators npm compares against.
 *
 * Only the shapes this repository's manifests can actually contain are
 * accepted; anything else throws rather than being silently treated as
 * satisfied. A range parser that shrugs at a token it does not understand is
 * the failure mode this whole check exists to prevent.
 */
function expandToken(token) {
  if (token === "" || token === "*" || token === "x" || token === "X") return [{ op: ">=", version: ANY }];
  const match = COMPARATOR.exec(token);
  invariant(match, `${token} is not a comparator this verifier understands`);
  const [, op = "", raw] = match;
  const xRange = expandXRange(op, raw);
  if (xRange) return xRange;
  const version = parseSemver(raw);
  const { major, minor, patch, prerelease } = version;
  const floor = comparator(">=", raw);
  if (op === "^") {
    // npm's caret: the leftmost non-zero part is the one held fixed.
    if (major !== 0) return [floor, comparator("<", `${major + 1}.0.0-0`)];
    if (minor !== 0) return [floor, comparator("<", `0.${minor + 1}.0-0`)];
    return [floor, comparator("<", `0.0.${patch + 1}-0`)];
  }
  if (op === "~") return [floor, comparator("<", `${major}.${minor + 1}.0-0`)];
  if (op === "" || op === "=") {
    return [
      comparator(">=", raw),
      comparator("<=", prerelease.length === 0 ? `${major}.${minor}.${patch}` : raw),
    ];
  }
  return [comparator(op, raw)];
}

/** Split a range into its `||`-joined comparator sets. */
export function parseRange(range) {
  invariant(typeof range === "string" && range.trim() !== "", `${range} is not a version range`);
  return range.split("||").map((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "")
      .flatMap((token) => expandToken(token)),
  );
}

function comparatorHolds({ op, version }, candidate) {
  if (version === ANY) return true;
  const order = compareSemver(candidate, version);
  if (op === ">=") return order >= 0;
  if (op === ">") return order > 0;
  if (op === "<=") return order <= 0;
  if (op === "<") return order < 0;
  return order === 0;
}

/**
 * Does `version` satisfy `range` under the resolution `npm install` actually
 * performs -- that is, without `includePrerelease`?
 *
 * The rule that matters here, and the one #1529 was filed against: a version
 * carrying a prerelease tag satisfies a range only if some comparator in the
 * *same* comparator set names the identical `[major, minor, patch]` tuple and
 * itself carries a prerelease. Bounds are irrelevant to that test, which is why
 * widening the range does not help -- `*` excludes `0.1.9-beta.0` just as
 * `^0.1.8-beta.0` does. The only ranges that admit a prerelease are ones
 * anchored on its own tuple.
 */
export function satisfiesUnderNpmDefaults(version, range) {
  const candidate = parseSemver(version);
  for (const set of parseRange(range)) {
    if (!set.every((entry) => comparatorHolds(entry, candidate))) continue;
    if (candidate.prerelease.length === 0) return true;
    const anchored = set.some(
      (entry) => entry.version !== ANY && entry.version.prerelease.length > 0 && sameTuple(entry.version, candidate),
    );
    if (anchored) return true;
  }
  return false;
}

/**
 * Prove that a `@honua/sdk-js` + `@honua/mcp-server` pair co-installs under
 * default npm resolution -- no `--legacy-peer-deps`, no `--force`.
 *
 * This is the invariant the caret peer range silently loses the moment the two
 * halves land on different patch tuples: `npm install` then fails ERESOLVE for
 * anyone following the documented install, which is exactly how the pinned
 * client pair reached a customer uninstallable (#1529).
 */
export function verifyClientPairCoInstallable({ sdkName, sdkVersion, mcpName, mcpVersion, peerRange, remedy }) {
  invariant(
    typeof peerRange === "string" && peerRange !== "",
    `${mcpName}@${mcpVersion} must declare a ${sdkName} peer range`,
  );
  invariant(
    satisfiesUnderNpmDefaults(sdkVersion, peerRange),
    `${mcpName}@${mcpVersion} peer-depends on ${sdkName}@"${peerRange}", which npm's default resolver does NOT ` +
      `consider satisfied by ${sdkName}@${sdkVersion}. Installing the pair fails ERESOLVE unless the consumer ` +
      "passes --legacy-peer-deps or --force, so the documented install is broken. A prerelease satisfies a range " +
      "only when a comparator in it carries a prerelease on the same major.minor.patch tuple, so widening the " +
      `range cannot fix this -- the pair has to be cut, pinned, and published on one tuple.${
        remedy ? `\n\nTo fix: ${remedy}` : ""
      }`,
  );
  return { sdkName, sdkVersion, mcpName, mcpVersion, peerRange };
}

/**
 * How a lagging generated-config pin is put right.
 *
 * Named in the failure message rather than left to the reader: the pin can only
 * legitimately advance after the coordinated MCP publish, so "update the pin"
 * is not actionable on its own -- the operator needs to know that the publish
 * comes first and that one command records both the version and its integrity.
 */
export const PIN_SYNC_REMEDY =
  "publish the coordinated @honua/mcp-server cut for this SDK version, then run `npm run sync:mcp-pin` to advance " +
  "LOCAL_INSTALL_MCP_PACKAGE_VERSION and LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY in src/local-install.ts onto it. Do " +
  "not hand-edit the pin to a version the registry does not serve.";

/** Every version this repository has cut a release entry for, newest first. */
export function releaseLineage(changelog) {
  return [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/gm)].map((match) => match[1]);
}

/**
 * Offline lineage proof. Cannot prove publication - only the registry can - but
 * it does reject the exact failure that shipped an uninstallable config: a pin
 * bumped ahead of the working tree's own package version.
 */
export function verifyMcpPinLineage({ pin, integrity, changelog, packageVersion, packageName }) {
  const { name, version } = parsePackagePin(pin);
  invariant(name === packageName, `MCP package pin ${pin} must name ${packageName}`);
  invariant(
    SHA512_INTEGRITY.test(integrity),
    `MCP package pin ${pin} must record a sha512 registry tarball integrity, not ${integrity}`,
  );
  const lineage = releaseLineage(changelog);
  invariant(
    lineage.includes(version),
    `MCP package pin ${pin} is not in this repository's release lineage (${lineage.slice(0, 5).join(", ")}, ...)`,
  );
  invariant(
    compareVersions(version, packageVersion) <= 0,
    `MCP package pin ${pin} runs ahead of mcp/package.json (${packageVersion}); a version this tree has not ` +
      "released can never have been published, so the generated MCP configuration would be uninstallable",
  );
  return { name, version, packageVersion, lineage };
}

/** Registry proof. Requires the network and the dedicated live gate. */
export async function verifyMcpPinPublication({ pin, integrity, fetchFn = fetch }) {
  const { name, version } = parsePackagePin(pin);
  // The package name is one path segment, so every character it contains is
  // percent-encoded rather than only the scope separator.
  const response = await fetchFn(`${REGISTRY}/${encodeURIComponent(name)}/${version}`, {
    headers: { accept: "application/json" },
  });
  invariant(
    response.status !== 404,
    `MCP package pin ${pin} is NOT published to the public registry. A generated terminal MCP configuration ` +
      "referencing it cannot install on a clean machine.",
  );
  invariant(response.ok, `Registry lookup for ${pin} failed with HTTP ${response.status}`);
  const manifest = await response.json();
  invariant(manifest?.version === version, `Registry returned ${manifest?.version} for ${pin}`);
  const published = manifest?.dist?.integrity;
  invariant(
    published === integrity,
    `MCP package pin ${pin} integrity drifted: recorded ${integrity}, registry serves ${published}`,
  );
  return {
    name,
    version,
    integrity: published,
    tarball: manifest?.dist?.tarball,
    peerDependencies: manifest?.peerDependencies ?? {},
  };
}

async function main() {
  const { LOCAL_INSTALL_MCP_PACKAGE, LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY, LOCAL_INSTALL_MCP_PACKAGE_NAME } =
    await import(path.join(PROJECT_ROOT, "dist/src/local-install.js"));
  const lineage = verifyMcpPinLineage({
    pin: LOCAL_INSTALL_MCP_PACKAGE,
    integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
    changelog: fs.readFileSync(path.join(PROJECT_ROOT, "mcp/CHANGELOG.md"), "utf8"),
    packageVersion: readJson("mcp/package.json").version,
    packageName: LOCAL_INSTALL_MCP_PACKAGE_NAME,
  });
  process.stdout.write(`mcp pin lineage ok: ${lineage.name}@${lineage.version}\n`);
  const zeroToMapConfigs = verifyZeroToMapConfigPins({ expectedPin: LOCAL_INSTALL_MCP_PACKAGE });
  process.stdout.write(`zero-to-map config pins ok: ${zeroToMapConfigs.length} configs name ${LOCAL_INSTALL_MCP_PACKAGE}\n`);
  const { name: sdkName, version: sdkVersion } = readJson("package.json");
  const createAppPins = verifyCreateAppPins({ sdkName, expectedVersion: sdkVersion });
  process.stdout.write(`create-honua-app pins ok: ${createAppPins.length} sites name ${sdkName}@${sdkVersion}\n`);

  // The pair this working tree would cut: mcp/package.json's declared peer
  // range against the SDK version sitting beside it.
  const mcpManifest = readJson("mcp/package.json");
  verifyClientPairCoInstallable({
    sdkName,
    sdkVersion,
    mcpName: mcpManifest.name,
    mcpVersion: mcpManifest.version,
    peerRange: mcpManifest.peerDependencies?.[sdkName],
  });
  process.stdout.write(
    `source pair co-installable: ${mcpManifest.name}@${mcpManifest.version} + ${sdkName}@${sdkVersion}\n`,
  );

  // The pair a customer actually gets: the *pinned* published MCP artifact
  // against the SDK this tree ships. release-please writes the peer range as a
  // caret on the MCP version at the commit that cut it, so that is the range
  // the published tarball carries; the live lane below re-reads it from the
  // registry rather than trusting this reconstruction.
  //
  // This check is a publish gate, not a PR gate. Between a release-please bump
  // and the coordinated MCP publish the pin legitimately lags the SDK version,
  // and no edit can fix that until the MCP half is on the registry -- so
  // reddening every release PR here would only make releases impossible. PR CI
  // asserts the source pair above (which release-please keeps in lockstep) and
  // that this rule rejects the lagging pin; `verify:client-pair` in
  // publish-js-sdk.yml is what stops a lagging pin from actually shipping.
  verifyClientPairCoInstallable({
    sdkName,
    sdkVersion,
    mcpName: lineage.name,
    mcpVersion: lineage.version,
    peerRange: `^${lineage.version}`,
    remedy: PIN_SYNC_REMEDY,
  });
  process.stdout.write(`pinned pair co-installable: ${lineage.name}@${lineage.version} + ${sdkName}@${sdkVersion}\n`);

  if (!isMcpPinLiveVerificationEnabled()) {
    process.stdout.write(`registry lane skipped: set ${NETWORK_GATE}=true to query the public registry\n`);
    return;
  }
  const published = await verifyMcpPinPublication({
    pin: LOCAL_INSTALL_MCP_PACKAGE,
    integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
  });
  process.stdout.write(`mcp pin published: ${published.tarball}\n`);
  process.stdout.write(`zero-to-map config pins published: ${zeroToMapConfigs.length} configs resolve to ${published.tarball}\n`);
  // The published peer range, not the one reconstructed above.
  verifyClientPairCoInstallable({
    sdkName,
    sdkVersion,
    mcpName: published.name,
    mcpVersion: published.version,
    peerRange: published.peerDependencies?.[sdkName],
    remedy: PIN_SYNC_REMEDY,
  });
  process.stdout.write(
    `published pair co-installable: ${published.name}@${published.version} peer ${sdkName}@"${published.peerDependencies?.[sdkName]}"\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
