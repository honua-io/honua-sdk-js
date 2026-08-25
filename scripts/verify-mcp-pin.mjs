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
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NETWORK_GATE = "HONUA_MCP_PIN_LIVE_ENABLED";
const REGISTRY = "https://registry.npmjs.org";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

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
  const response = await fetchFn(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`, {
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
  return { name, version, integrity: published, tarball: manifest?.dist?.tarball };
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
  if (!isMcpPinLiveVerificationEnabled()) {
    process.stdout.write(`registry lane skipped: set ${NETWORK_GATE}=true to query the public registry\n`);
    return;
  }
  const published = await verifyMcpPinPublication({
    pin: LOCAL_INSTALL_MCP_PACKAGE,
    integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
  });
  process.stdout.write(`mcp pin published: ${published.tarball}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
