#!/usr/bin/env node
/**
 * Advance every MCP pin in the tree onto this SDK's own coordinated cut.
 *
 * The pin has two homes, and they must name the identical `name@version`:
 * `src/local-install.ts`, which writes it into `.mcp.json` /
 * `claude_desktop_config.json` generated on a user's machine, and the
 * zero-to-map configs under `mcp/release/`, which ship it as committed bytes.
 * `verify-mcp-pin` enforces that equality, so this command has to move both --
 * advancing only the source constant would leave the tree failing its own gate
 * the moment this command succeeded (#1545).
 *
 * That pin carries two obligations that pull against each other:
 *
 * - it must name a version the registry actually serves (#1401 -- a pin that
 *   exists only in this repository's release lineage cannot install on a clean
 *   machine), and
 * - it must sit on the same `major.minor.patch` tuple as the SDK shipping
 *   beside it (#1529 -- `@honua/mcp-server` peer-depends on `@honua/sdk-js`,
 *   and a caret range over a prerelease admits exactly one tuple, so a lagging
 *   pin makes the pair fail `npm install` with ERESOLVE).
 *
 * Only a real coordinated publish satisfies both, which is why the pin cannot
 * be a release-please `extra-files` bump: release-please would advance the
 * version at release-PR time, before either half is published, and it cannot
 * compute the tarball integrity recorded next to it. So the pin advances here
 * instead, from the registry, after the cut -- and `npm run verify:client-pair`
 * refuses to publish an SDK whose pin has not caught up.
 *
 * Run after the coordinated `@honua/mcp-server` publish:
 *
 *     npm run sync:mcp-pin           # rewrite the pin and its integrity
 *     npm run sync:mcp-pin -- --check  # report drift without writing
 *
 * This lane queries the public npm registry and is never part of PR CI.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ZERO_TO_MAP_CONFIGS,
  parseSemver,
  verifyClientPairCoInstallable,
  verifyZeroToMapConfigPins,
} from "./verify-mcp-pin.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN_SOURCE_RELATIVE = "src/local-install.ts";
const PIN_SOURCE = path.join(PROJECT_ROOT, PIN_SOURCE_RELATIVE);
const REGISTRY = "https://registry.npmjs.org";
const VERSION_LINE = /(export const LOCAL_INSTALL_MCP_PACKAGE_VERSION = ")([^"]+)(";)/;
const INTEGRITY_LINE = /(export const LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY =\s*\n\s*")([^"]+)(";)/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sameTuple(left, right) {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

/**
 * The published `@honua/mcp-server` release on the SDK's own tuple.
 *
 * Deliberately not "the newest published version": pinning ahead of the SDK
 * would be just as uninstallable as lagging behind it, in the other direction.
 */
export function selectCoordinatedRelease(packument, sdkVersion, mcpName) {
  const target = parseSemver(sdkVersion);
  const candidates = Object.keys(packument?.versions ?? {}).filter((version) => {
    try {
      return sameTuple(parseSemver(version), target);
    } catch {
      return false;
    }
  });
  invariant(
    candidates.length > 0,
    `no published ${mcpName} sits on ${sdkVersion}'s ${target.major}.${target.minor}.${target.patch} tuple. The ` +
      "coordinated cut has not published its MCP half yet; publish it, then re-run this command. Do not hand-edit " +
      "the pin to a version the registry does not serve.",
  );
  // One tuple can carry several prereleases (0.1.9-beta.0, 0.1.9-beta.1);
  // the SDK's own prerelease identifier picks the coordinated one when it is
  // present, otherwise the lexically last candidate on the tuple.
  const exact = candidates.find((version) => version === sdkVersion);
  return exact ?? candidates[candidates.length - 1];
}

async function fetchPackument(name, fetchFn) {
  const response = await fetchFn(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/json" },
  });
  invariant(response.ok, `Registry lookup for ${name} failed with HTTP ${response.status}`);
  return response.json();
}

/** Rewrite both pin constants in place, returning the new source text. */
export function applyPin(source, version, integrity) {
  invariant(VERSION_LINE.test(source), "could not locate LOCAL_INSTALL_MCP_PACKAGE_VERSION in src/local-install.ts");
  invariant(INTEGRITY_LINE.test(source), "could not locate LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY in src/local-install.ts");
  return source
    .replace(VERSION_LINE, `$1${version}$3`)
    .replace(INTEGRITY_LINE, `$1${integrity}$3`);
}

export function readPin(source) {
  return {
    version: VERSION_LINE.exec(source)?.[2],
    integrity: INTEGRITY_LINE.exec(source)?.[2],
  };
}

/** The exact `name@version` a shipped zero-to-map config hands `npx --package`. */
export function readConfigPin(source, relativePath) {
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const args = config?.mcpServers?.honua?.args;
  invariant(Array.isArray(args), `${relativePath} must declare mcpServers.honua.args`);
  const packageFlag = args.indexOf("--package");
  invariant(packageFlag >= 0, `${relativePath} must invoke npx with --package`);
  const pin = args[packageFlag + 1];
  invariant(typeof pin === "string", `${relativePath} must put an exact package pin after --package`);
  return pin;
}

/**
 * Repoint one shipped config at `nextPin`, preserving its formatting.
 *
 * A parse/serialise round-trip would reflow these hand-formatted files (the
 * `args` array lives on one line), so the pin is replaced as an exact quoted
 * token instead -- but only after the structure has been validated, and the
 * result is re-read through the parser so a formatting-preserving edit still
 * has to produce a config that genuinely names the intended pin.
 */
export function applyConfigPin(source, nextPin, relativePath) {
  const current = readConfigPin(source, relativePath);
  if (current === nextPin) return source;
  const token = JSON.stringify(current);
  const occurrences = source.split(token).length - 1;
  invariant(
    occurrences === 1,
    `${relativePath} must name ${current} exactly once so the rewrite is unambiguous; found ${occurrences}`,
  );
  const updated = source.replace(token, JSON.stringify(nextPin));
  invariant(
    readConfigPin(updated, relativePath) === nextPin,
    `${relativePath} pin rewrite did not take effect`,
  );
  return updated;
}

/**
 * Compute every rewrite, running every invariant, before anything is written.
 *
 * The rewrites validate as they build -- `applyConfigPin` refuses a config
 * whose pin token is ambiguous, and that refusal is only reachable here, not in
 * the `readConfigPin` pass that decides which sites are stale. Writing inside
 * that loop would therefore let a refusal on the second config land after the
 * source constant and the first config were already on disk, leaving exactly
 * the half-migrated tree this command exists to prevent. Planning first makes
 * the write phase pure I/O over contents that have all already been proven.
 */
export function planPinWrites({ source, sourceStale, version, integrity, staleConfigs, expectedPin }) {
  const writes = [];
  if (sourceStale) {
    writes.push({
      relativePath: PIN_SOURCE_RELATIVE,
      file: PIN_SOURCE,
      contents: applyPin(source, version, integrity),
    });
  }
  for (const config of staleConfigs) {
    writes.push({
      relativePath: config.relativePath,
      file: config.file,
      contents: applyConfigPin(config.source, expectedPin, config.relativePath),
    });
  }
  return writes;
}

/** Every file that carries the pin, with what it names today. */
function readPinSites(expectedPin) {
  return ZERO_TO_MAP_CONFIGS.map((relativePath) => {
    const file = path.join(PROJECT_ROOT, relativePath);
    const source = fs.readFileSync(file, "utf8");
    const pin = readConfigPin(source, relativePath);
    return { relativePath, file, source, pin, stale: pin !== expectedPin };
  });
}

async function main(argv) {
  const check = argv.includes("--check");
  for (const arg of argv) {
    invariant(arg === "--check", `unrecognised argument ${arg}`);
  }
  const sdk = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const source = fs.readFileSync(PIN_SOURCE, "utf8");
  const current = readPin(source);
  const { LOCAL_INSTALL_MCP_PACKAGE_NAME } = await import(path.join(PROJECT_ROOT, "dist/src/local-install.js"));

  const packument = await fetchPackument(LOCAL_INSTALL_MCP_PACKAGE_NAME, fetch);
  const version = selectCoordinatedRelease(packument, sdk.version, LOCAL_INSTALL_MCP_PACKAGE_NAME);
  const manifest = packument.versions[version];
  const integrity = manifest?.dist?.integrity;
  invariant(typeof integrity === "string", `registry served no tarball integrity for ${version}`);

  // Never write a pin that does not solve the problem it exists to solve.
  verifyClientPairCoInstallable({
    sdkName: sdk.name,
    sdkVersion: sdk.version,
    mcpName: LOCAL_INSTALL_MCP_PACKAGE_NAME,
    mcpVersion: version,
    peerRange: manifest.peerDependencies?.[sdk.name],
  });

  // The pin lives in more than one place. `src/local-install.ts` writes it into
  // configurations generated on a user's machine; the zero-to-map configs under
  // mcp/release/ ship it as committed bytes. `verify-mcp-pin` requires all of
  // them to name the identical pin, so advancing only the source constant would
  // leave the tree failing its own gate the moment this command succeeded.
  const expectedPin = `${LOCAL_INSTALL_MCP_PACKAGE_NAME}@${version}`;
  const configs = readPinSites(expectedPin);
  const staleConfigs = configs.filter((config) => config.stale);
  const sourceStale = current.version !== version || current.integrity !== integrity;

  if (!sourceStale && staleConfigs.length === 0) {
    process.stdout.write(
      `mcp pin already current: ${expectedPin} in src/local-install.ts and ${configs.length} shipped configs\n`,
    );
    return;
  }
  if (check) {
    if (sourceStale) {
      process.stderr.write(
        `mcp pin is stale: src/local-install.ts records ${current.version}, coordinated cut is ${version}.\n`,
      );
    }
    for (const config of staleConfigs) {
      process.stderr.write(`mcp pin is stale: ${config.relativePath} pins ${config.pin}, coordinated cut is ${expectedPin}.\n`);
    }
    process.stderr.write("Run `npm run sync:mcp-pin`.\n");
    process.exitCode = 1;
    return;
  }

  // Validate every rewrite first; a refusal here leaves the tree untouched.
  const writes = planPinWrites({ source, sourceStale, version, integrity, staleConfigs, expectedPin });
  for (const write of writes) fs.writeFileSync(write.file, write.contents);
  // Same discipline as the pre-write co-install check: prove the bytes just
  // written actually satisfy the gate rather than trusting the edit.
  verifyZeroToMapConfigPins({ expectedPin });

  const advanced = [
    sourceStale ? `src/local-install.ts ${current.version} -> ${version}` : null,
    staleConfigs.length > 0 ? `${staleConfigs.length} shipped config${staleConfigs.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  process.stdout.write(
    `mcp pin advanced: ${advanced.join(", ")} (integrity recorded from ${REGISTRY})\n` +
      "Rebuild and re-run `npm run verify:client-pair` before publishing.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`MCP pin sync FAILED:\n  - ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
