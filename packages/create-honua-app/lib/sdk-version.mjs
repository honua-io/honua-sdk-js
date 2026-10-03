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
//
// When npm launched the scaffold (`npm create`, `npx`), the registry is read
// through npm's own CLI (`npm view`), so the lookup sees exactly what the
// later `npm install` will: scope registries, `.npmrc` auth, proxies, and CA
// settings. Otherwise it is a direct read of the exported registry setting.
// A registry that answers 404 for the SDK, or that lists neither the channel
// version nor the certified fallback, is not "offline": the app it would
// scaffold could never install, so that fails the scaffold instead.

import { execFile } from "node:child_process";
import path from "node:path";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
export const REGISTRY_TIMEOUT_MS = 5000;
export const NPM_VIEW_TIMEOUT_MS = 30000;

// The SemVer 2.0.0 grammar (semver.org): numeric identifiers carry no leading
// zeros and every prerelease or build identifier is non-empty, so a malformed
// --sdk-version is refused even when the registry cannot be asked about it.
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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

/** A registry URL safe to print: any userinfo (`user:token@`) is removed. */
export function redactUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}

/**
 * The registry npm installs `packageName` from, as npm exported it to this
 * process: the scope's own registry (`@scope:registry`) first, then the
 * default `registry`, else npmjs. The setting is never echoed back, because a
 * registry URL may carry credentials.
 */
export function registryUrl(env = process.env, packageName = "") {
  const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
  const configured =
    (scope && (env[`npm_config_${scope}:registry`] || env[`NPM_CONFIG_${scope}:registry`])) ||
    env.npm_config_registry ||
    env.NPM_CONFIG_REGISTRY ||
    DEFAULT_REGISTRY;
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`The npm registry configured for ${packageName || "packages"} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`The npm registry configured for ${packageName || "packages"} must be an http(s) URL.`);
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

/**
 * Registry document URL for a package name. The whole name is one path
 * segment: `@scope/name` keeps its leading `@` and escapes everything else,
 * including the scope slash, exactly as the npm CLI requests it.
 */
export function packumentUrl(packageName, registry) {
  return new URL(encodeURIComponent(packageName).replace(/^%40/, "@"), registry).toString();
}

/** The registry answered that it has no such package: definitive, not a transport failure. */
export class PackageNotFoundError extends Error {}

/**
 * Read a package's dist-tags and published versions from the registry.
 * Throws `PackageNotFoundError` on HTTP 404 and a plain `Error` with a
 * reader-facing, credential-free reason on any other transport, status, or
 * shape failure.
 */
export async function fetchPackument(
  packageName,
  { registry = DEFAULT_REGISTRY, fetch: fetchImpl = globalThis.fetch, timeoutMs = REGISTRY_TIMEOUT_MS } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("this Node.js runtime has no fetch");
  const target = new URL(packumentUrl(packageName, registry));
  const headers = { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" };
  // fetch refuses a URL with userinfo; send it the way npm does for a
  // credentialed registry URL, as basic auth to that same registry.
  if (target.username || target.password) {
    const credentials = `${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`;
    headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  const url = redactUrl(target);
  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`${url} could not be reached (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 404) throw new PackageNotFoundError(`${url} returned HTTP 404`);
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

/** npm's own CLI script when npm launched this process; undefined for pnpm, yarn, or a direct run. */
export function npmCliPath(env = process.env) {
  const execpath = env.npm_execpath;
  return typeof execpath === "string" && path.basename(execpath) === "npm-cli.js" ? execpath : undefined;
}

/**
 * Read a package's dist-tags and published versions with `npm view`, under
 * npm's effective configuration. Throws `PackageNotFoundError` for npm's E404
 * and a plain `Error` naming only npm's error code otherwise, so nothing npm
 * printed (URLs included) reaches the scaffold's output.
 */
export function viewPackument(packageName, { npmCli, env = process.env, timeoutMs = NPM_VIEW_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [npmCli, "view", packageName, "dist-tags", "versions", "--json"],
      { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        let document;
        try {
          document = JSON.parse(stdout);
        } catch {
          document = undefined;
        }
        if (error) {
          const code = typeof document?.error?.code === "string" ? document.error.code : undefined;
          if (code === "E404") {
            reject(new PackageNotFoundError(`npm view ${packageName} returned E404`));
            return;
          }
          reject(new Error(`npm view ${packageName} failed (${code ?? (error.killed ? "timed out" : "no result")})`));
          return;
        }
        const distTags = document?.["dist-tags"];
        const versions = typeof document?.versions === "string" ? [document.versions] : document?.versions;
        if (!distTags || typeof distTags !== "object" || !Array.isArray(versions)) {
          reject(new Error(`npm view ${packageName} did not return package metadata`));
          return;
        }
        resolve({ distTags, versions: new Set(versions) });
      },
    );
  });
}

/**
 * Decide which `manifest.sdk.package` version a scaffold pins.
 *
 * Returns `{ package, version, source, channel, note }` where `source` is
 * `"override"` (the user passed `--sdk-version`), `"channel"` (the promoted
 * dist-tag), or `"pinned"` (the certified fallback); `note` explains a
 * fallback or an unconfirmed override. Throws when the override is malformed
 * or unpublished, when the registry has no SDK package at all, or when it
 * lists neither a usable channel version nor the certified fallback.
 */
export async function resolveSdkVersion({
  manifest,
  override,
  env = process.env,
  fetch: fetchImpl,
  timeoutMs,
  npmCli = npmCliPath(env),
} = {}) {
  const { package: packageName, version: pinned, channel } = manifest.sdk;
  const base = { package: packageName, channel };
  if (override !== undefined && !parseVersion(override)) {
    throw new Error(`--sdk-version must be an exact version such as ${pinned}, found ${JSON.stringify(override)}.`);
  }
  const registry = npmCli ? undefined : registryUrl(env, packageName);
  const shownRegistry = npmCli ? "the npm registry npm is configured to use" : redactUrl(registry);
  const read = async () => {
    try {
      return npmCli
        ? await viewPackument(packageName, { npmCli, env, timeoutMs })
        : await fetchPackument(packageName, { registry, fetch: fetchImpl, timeoutMs });
    } catch (error) {
      if (!(error instanceof PackageNotFoundError)) throw error;
      throw new PackageNotFoundError(
        `${packageName} is not on ${npmCli ? shownRegistry : `the configured npm registry ${shownRegistry}`}, so the app could not install.`,
      );
    }
  };

  if (override !== undefined) {
    let packument;
    try {
      packument = await read();
    } catch (error) {
      if (error instanceof PackageNotFoundError) throw error;
      return {
        ...base,
        version: override,
        source: "override",
        note: `could not confirm ${packageName}@${override} is published: ${error.message}`,
      };
    }
    if (!packument.versions.has(override)) {
      throw new Error(`${packageName}@${override} is not published on ${shownRegistry}.`);
    }
    return { ...base, version: override, source: "override" };
  }

  let packument;
  try {
    packument = await read();
  } catch (error) {
    if (error instanceof PackageNotFoundError) throw error;
    return {
      ...base,
      version: pinned,
      source: "pinned",
      note: `could not read the ${channel} channel: ${error.message}`,
    };
  }
  // The registry answered, so the fallback must be installable from it too.
  const pinnedResult = (note) => {
    if (!packument.versions.has(pinned)) {
      throw new Error(
        `${note}, and ${shownRegistry} does not list the certified ${packageName}@${pinned}, so the app could not install. Pass --sdk-version to choose a published version.`,
      );
    }
    return { ...base, version: pinned, source: "pinned", note };
  };
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
