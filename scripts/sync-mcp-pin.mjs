#!/usr/bin/env node
/**
 * Advance the generated-config MCP pin onto this SDK's own coordinated cut.
 *
 * `src/local-install.ts` pins an exact `@honua/mcp-server` version into every
 * generated `.mcp.json` / `claude_desktop_config.json`. That pin carries two
 * obligations that pull against each other:
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

import { parseSemver, verifyClientPairCoInstallable } from "./verify-mcp-pin.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN_SOURCE = path.join(PROJECT_ROOT, "src", "local-install.ts");
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

  if (current.version === version && current.integrity === integrity) {
    process.stdout.write(`mcp pin already current: ${LOCAL_INSTALL_MCP_PACKAGE_NAME}@${version}\n`);
    return;
  }
  if (check) {
    process.stderr.write(
      `mcp pin is stale: recorded ${current.version}, coordinated cut is ${version}. Run \`npm run sync:mcp-pin\`.\n`,
    );
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(PIN_SOURCE, applyPin(source, version, integrity));
  process.stdout.write(
    `mcp pin advanced: ${current.version} -> ${version} (integrity recorded from ${REGISTRY})\n` +
      "Rebuild and re-run `npm run verify:client-pair` before publishing.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`MCP pin sync FAILED:\n  - ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
