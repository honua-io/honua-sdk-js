// Scaffold-time SDK version resolution (#1824, honua-release#376 ruling R18).
//
// A starter follows the promoted release channel: the npm dist-tag that only
// release promotion moves. A new SDK promotion therefore reaches fresh
// scaffolds without a `create-honua-app` republish, and the scaffolded
// `package.json` still records one exact version so the app stays
// reproducible.
//
// The channel is trusted only for a stable version on the starter's own SDK
// line (same major, and same minor while the SDK is 0.x), because the template
// source is written against that API. Anything else — the channel is not
// promoted yet, it names a prerelease or another line, or the registry cannot
// be read — falls back to the certified version the manifest pins, so a first
// map never lands on a beta the user did not ask for. An explicit
// `--sdk-version` is the only way to scaffold a prerelease.

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
export const REGISTRY_TIMEOUT_MS = 5000;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse an exact semver version, or return undefined for anything else (ranges, tags, garbage). */
export function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value));
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] };
}

/** True for an exact release version with no prerelease suffix. */
export function isStableVersion(value) {
  const parsed = parseVersion(value);
  return parsed !== undefined && parsed.prerelease === undefined;
}

/**
 * True when `candidate` is a stable release on the same SDK line as the
 * certified `pinned` version: the line a caret range on the pin would accept,
 * ignoring the lower bound so a promoted channel may also move back within it.
 */
export function onPinnedLine(candidate, pinned) {
  const next = parseVersion(candidate);
  const pin = parseVersion(pinned);
  if (!next || !pin || next.prerelease !== undefined) return false;
  if (next.major !== pin.major) return false;
  return pin.major !== 0 || next.minor === pin.minor;
}

/** The registry a scaffold reads: npm's configured registry when npm launched us, else npmjs. */
export function registryUrl(env = process.env) {
  const configured = env.npm_config_registry || env.NPM_CONFIG_REGISTRY || DEFAULT_REGISTRY;
  const url = new URL(configured);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`npm registry ${configured} must be an http(s) URL.`);
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

/** Registry document URL for a package name (`@scope/name` keeps its `@` and escapes the slash). */
export function packumentUrl(packageName, registry) {
  return new URL(packageName.replace("/", "%2f"), registry).toString();
}

/**
 * Read a package's dist-tags and published versions from the registry.
 * Throws with a reader-facing reason on any transport, status, or shape failure.
 */
export async function fetchPackument(
  packageName,
  { registry = DEFAULT_REGISTRY, fetch: fetchImpl = globalThis.fetch, timeoutMs = REGISTRY_TIMEOUT_MS } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("this Node.js runtime has no fetch");
  const url = packumentUrl(packageName, registry);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${url} could not be reached (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  let document;
  try {
    document = await response.json();
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
  const distTags = document?.["dist-tags"];
  const versions = document?.versions;
  if (!distTags || typeof distTags !== "object" || !versions || typeof versions !== "object") {
    throw new Error(`${url} did not return package metadata`);
  }
  return { distTags, versions: new Set(Object.keys(versions)) };
}

/**
 * Decide which `manifest.sdk.package` version a scaffold pins.
 *
 * Returns `{ package, version, source, channel, note }` where `source` is
 * `"override"` (the user passed `--sdk-version`), `"channel"` (the promoted
 * dist-tag), or `"pinned"` (the certified fallback); `note` explains a
 * fallback or an unconfirmed override.
 */
export async function resolveSdkVersion({ manifest, override, env = process.env, fetch: fetchImpl, timeoutMs } = {}) {
  const { package: packageName, version: pinned, channel } = manifest.sdk;
  const base = { package: packageName, channel };
  const registry = registryUrl(env);
  const read = () => fetchPackument(packageName, { registry, fetch: fetchImpl, timeoutMs });

  if (override !== undefined) {
    if (!parseVersion(override)) {
      throw new Error(`--sdk-version must be an exact version such as ${pinned}, found ${JSON.stringify(override)}.`);
    }
    let packument;
    try {
      packument = await read();
    } catch (error) {
      return {
        ...base,
        version: override,
        source: "override",
        note: `could not confirm ${packageName}@${override} is published: ${error.message}`,
      };
    }
    if (!packument.versions.has(override)) {
      throw new Error(`${packageName}@${override} is not published on ${registry}.`);
    }
    return { ...base, version: override, source: "override" };
  }

  const pinnedResult = (note) => ({ ...base, version: pinned, source: "pinned", note });
  let packument;
  try {
    packument = await read();
  } catch (error) {
    return pinnedResult(`could not read the ${channel} channel: ${error.message}`);
  }
  const promoted = packument.distTags[channel];
  if (typeof promoted !== "string" || promoted.length === 0) {
    return pinnedResult(`the ${channel} channel has not been promoted yet`);
  }
  if (!onPinnedLine(promoted, pinned)) {
    return pinnedResult(
      `the ${channel} channel names ${promoted}, which is not a stable release on this starter's ${pinned} line`,
    );
  }
  if (!packument.versions.has(promoted)) {
    return pinnedResult(`the ${channel} channel names ${promoted}, which the registry does not list`);
  }
  return { ...base, version: promoted, source: "channel" };
}
