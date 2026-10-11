#!/usr/bin/env node
/**
 * Prove that the pinned client pair really co-installs under default npm
 * resolution.
 *
 * `@honua/mcp-server` peer-depends on `@honua/sdk-js`, so the release journey's
 * "install the exact pinned clientArtifacts on a clean machine" step installs
 * both into one project. npm's default resolver refuses that install when the
 * MCP server's peer range does not admit the SDK beside it, and a caret range
 * over a prerelease admits exactly one `major.minor.patch` tuple -- so the pair
 * is uninstallable the moment its two halves land on different tuples (#1529).
 *
 * `scripts/verify-mcp-pin.mjs` decides the same question as a predicate,
 * offline, in PR CI. This script is the empirical proof: a throwaway consumer,
 * a real `npm install` of the real specifiers, and **no resolution-relaxing
 * flags**. `--legacy-peer-deps` and `--force` are exactly the flags a customer
 * is not going to pass, so this gate must never pass them either --
 * `coInstallArgs()` refuses to build a command containing one, and
 * `test/scripts/verify-client-pair-install.test.mjs` holds that line.
 *
 * This is the same shape as the packed-SDK certification (#1531): assert
 * against the bytes about to be published, from the publish workflow.
 *
 * Three lanes:
 *
 * - `--sdk-source packed` (default): `npm pack` this tree and install that
 *   tarball beside the pinned registry MCP artifact. Runs pre-publish, so a
 *   cut that would ship an uninstallable pair never reaches the registry.
 * - `--sdk-source registry`: install both halves from the public registry.
 *   Answers "is the pair a customer can fetch today installable?", which is the
 *   question the scheduled pin lane exists to keep answering.
 * - `--sdk-source registry --mcp-source packed`: pack the MCP candidate and
 *   install it beside the exact public SDK. Gates MCP publication while the
 *   coordinated SDK release may still be resealing; retry the same immutable
 *   MCP tag after SDK publication if the public peer is not yet available.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runNpmSync } from "./lib/npm-cli.mjs";
import { verifyClientPairCoInstallable } from "./verify-mcp-pin.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Flags that would let an ERESOLVE pair install anyway. A gate that passes one
 * of these cannot observe the defect it exists to catch -- which is why
 * `verify:packed-sdk`, whose install carries `--legacy-peer-deps` for the SDK's
 * own dependency tree, never saw #1529.
 */
export const RESOLUTION_RELAXING_FLAGS = ["--legacy-peer-deps", "--force", "-f"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * The `npm install` argv for a co-install proof.
 *
 * Everything here either isolates the consumer or quiets output; nothing
 * relaxes peer resolution, and the assertion below makes that structural rather
 * than a comment somebody can delete.
 */
export function coInstallArgs(specifiers) {
  invariant(Array.isArray(specifiers) && specifiers.length >= 2, "a co-install proof needs at least two specifiers");
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...specifiers];
  for (const arg of args) {
    invariant(
      !RESOLUTION_RELAXING_FLAGS.includes(arg),
      `${arg} relaxes npm peer resolution, so the install would no longer prove the pair co-installs for a ` +
        "customer who passes no flags at all. Fix the pair, not the gate.",
    );
  }
  return args;
}

export function parseArgs(argv) {
  const options = { sdkSource: "packed", mcpSource: "registry" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sdk-source" || arg === "--mcp-source") {
      invariant(!seen.has(arg), `${arg} may only be supplied once`);
      seen.add(arg);
      const value = argv[index + 1];
      invariant(value === "packed" || value === "registry", `${arg} must be 'packed' or 'registry'`);
      options[arg === "--sdk-source" ? "sdkSource" : "mcpSource"] = value;
      index += 1;
      continue;
    }
    invariant(false, `unrecognised argument ${arg}`);
  }
  invariant(
    options.mcpSource !== "packed" || options.sdkSource === "registry",
    "packed MCP admission requires the registry SDK",
  );
  return options;
}

function run(label, args, options = {}) {
  const result = (options.runNpm ?? runNpmSync)(args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 600_000,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`${label} failed${result.status === null ? "" : ` (exit ${result.status})`}:\n${detail}`);
  }
  return result.stdout ?? "";
}

function packPackage(packageRoot, destination, options) {
  const output = run("npm pack", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, packageRoot], {
    ...options,
    cwd: packageRoot,
    timeout: 300_000,
  });
  const packed = JSON.parse(output);
  const filename = packed[0]?.filename;
  invariant(typeof filename === "string", "npm pack did not report a tarball filename");
  return path.join(destination, filename);
}

function installedVersion(consumerRoot, name) {
  const manifest = path.join(consumerRoot, "node_modules", ...name.split("/"), "package.json");
  invariant(fs.existsSync(manifest), `${name} is not present in the installed tree`);
  return JSON.parse(fs.readFileSync(manifest, "utf8"));
}

/** Ignore caller npm configuration so a publication gate cannot inherit relaxed peers or a private registry. */
export function publicResolverEnv(baseEnv, tempRoot) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")));
  const userConfig = path.join(tempRoot, "empty-user.npmrc");
  const globalConfig = path.join(tempRoot, "empty-global.npmrc");
  fs.writeFileSync(userConfig, "");
  fs.writeFileSync(globalConfig, "");
  return {
    ...env,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_registry: "https://registry.npmjs.org",
  };
}

export async function verifyPair(argv, { projectRoot = PROJECT_ROOT, runNpm = runNpmSync, env = process.env } = {}) {
  const { sdkSource, mcpSource } = parseArgs(argv);
  const sdk = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  invariant(sdk.name === "@honua/sdk-js", "SDK package identity is invalid");
  let mcp;
  if (mcpSource === "packed") {
    mcp = JSON.parse(fs.readFileSync(path.join(projectRoot, "mcp/package.json"), "utf8"));
    invariant(mcp.name === "@honua/mcp-server", "packed MCP package identity is invalid");
  } else {
    const pin = await import(path.join(projectRoot, "dist/src/local-install.js"));
    mcp = { name: pin.LOCAL_INSTALL_MCP_PACKAGE_NAME, version: pin.LOCAL_INSTALL_MCP_PACKAGE_VERSION };
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-client-pair-"));
  const consumerRoot = path.join(tempRoot, "consumer");
  const packRoot = path.join(tempRoot, "pack");
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.mkdirSync(packRoot, { recursive: true });
  try {
    const runOptions = { runNpm, env: publicResolverEnv(env, tempRoot) };
    fs.writeFileSync(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "honua-client-pair-smoke", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
    );

    const sdkSpecifier = sdkSource === "packed" ? packPackage(projectRoot, packRoot, runOptions) : `${sdk.name}@${sdk.version}`;
    const mcpSpecifier = mcpSource === "packed"
      ? packPackage(path.join(projectRoot, "mcp"), packRoot, runOptions)
      : `${mcp.name}@${mcp.version}`;
    const args = coInstallArgs([sdkSpecifier, mcpSpecifier]);
    const retryHint = mcpSource === "packed"
      ? "; if the SDK is not yet published, retry the same MCP tag after SDK publication"
      : "";
    run(`pinned client pair co-install (${sdkSource} SDK, ${mcpSource} MCP)${retryHint}`, args, {
      ...runOptions,
      cwd: consumerRoot,
    });

    const installedSdk = installedVersion(consumerRoot, sdk.name);
    const installedMcp = installedVersion(consumerRoot, mcp.name);
    invariant(installedSdk.name === sdk.name && installedMcp.name === mcp.name, "installed package name mismatch");
    invariant(
      installedSdk.version === sdk.version,
      `installed ${sdk.name}@${installedSdk.version} is not the ${sdk.version} this tree ships`,
    );
    invariant(
      installedMcp.version === mcp.version,
      `installed ${mcp.name}@${installedMcp.version} is not the expected ${mcp.version}`,
    );
    // npm resolved the tree, so the pair installs; re-deciding it against the
    // *installed* manifest's own peer range catches a future npm that resolves
    // this more loosely than a customer's npm would.
    verifyClientPairCoInstallable({
      sdkName: sdk.name,
      sdkVersion: installedSdk.version,
      mcpName: mcp.name,
      mcpVersion: installedMcp.version,
      peerRange: installedMcp.peerDependencies?.[sdk.name],
    });

    process.stdout.write(
      `clientPair=ok sdkSource=${sdkSource} mcpSource=${mcpSource} ${sdk.name}@${installedSdk.version} + ` +
        `${mcp.name}@${installedMcp.version} ` +
        `peer="${installedMcp.peerDependencies?.[sdk.name]}" defaultPeerResolution=true relaxingFlags=none\n`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPair(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Pinned client pair co-install FAILED:\n  - ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
