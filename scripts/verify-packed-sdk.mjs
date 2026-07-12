#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeSmokeSource,
  supportedEntrypoints,
  typeSmokeSource,
  validateInstalledManifest,
} from "./lib/packed-sdk-smoke.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));
const surface = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "config", "public-surface.json"), "utf8"),
);
const entrypoints = supportedEntrypoints(surface);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-packed-sdk-"));
const consumerRoot = path.join(tempRoot, "consumer");
const packRoot = path.join(tempRoot, "pack");

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout?.trim(), result.stderr?.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${label} failed${result.status === null ? "" : ` (exit ${result.status})`}: ${detail}`,
    );
  }
  return result.stdout;
}

function runFailure(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
  });
  if (result.error || result.status === 0 || result.status === null) {
    throw new Error(`${label} did not fail closed as expected: ${result.error?.message ?? result.stdout ?? result.stderr}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function packInstalledDependency(packageRoot, index) {
  const dependency = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const stagingRoot = path.join(tempRoot, "dependency-pack", String(index));
  const stagingPackage = path.join(stagingRoot, "package");
  const safeName = dependency.name.replaceAll("@", "").replaceAll("/", "-");
  const tarballPath = path.join(packRoot, `${safeName}-${dependency.version}.tgz`);
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.cpSync(packageRoot, stagingPackage, { recursive: true, dereference: true });
  run(`pack installed dependency ${dependency.name}`, "tar", [
    "-czf",
    tarballPath,
    "-C",
    stagingRoot,
    "package",
  ]);
  return tarballPath;
}

function linkPeerFixtures(installedPackageJson) {
  let linked = 0;
  for (const name of Object.keys(installedPackageJson.peerDependencies ?? {})) {
    const source = path.join(projectRoot, "node_modules", ...name.split("/"));
    if (!fs.existsSync(source)) continue;
    const target = path.join(consumerRoot, "node_modules", ...name.split("/"));
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    linked += 1;
  }
  return linked;
}

try {
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.mkdirSync(packRoot, { recursive: true });
  const offlineNpmEnv = {
    ...process.env,
    npm_config_cache: path.join(tempRoot, "npm-cache"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };

  const productionDependencyRoots = Object.entries(packageLock.packages ?? {})
    .filter(
      ([relative, metadata]) => relative.startsWith("node_modules/") && metadata.dev !== true,
    )
    .map(([relative]) => path.join(projectRoot, relative));
  const packedOutput = run(
    "npm pack",
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot, projectRoot],
    { env: offlineNpmEnv, timeout: 120_000 },
  );
  const packed = JSON.parse(packedOutput);
  const tarballName = packed.find((artifact) => artifact.name === packageJson.name)?.filename;
  if (typeof tarballName !== "string") {
    throw new Error("npm pack did not report a tarball filename");
  }
  const tarballPath = path.join(packRoot, tarballName);
  const dependencyTarballs = productionDependencyRoots.map(packInstalledDependency);

  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      { name: "honua-packed-sdk-smoke", version: "0.0.0", private: true, type: "module" },
      null,
      2,
    )}\n`,
  );
  run(
    "offline packed-tarball install",
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--legacy-peer-deps",
      tarballPath,
      ...dependencyTarballs,
    ],
    {
      cwd: consumerRoot,
      timeout: 600_000,
      env: offlineNpmEnv,
    },
  );

  const installedRoot = path.join(consumerRoot, "node_modules", "@honua", "sdk-js");
  const installedPackageJson = JSON.parse(
    fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"),
  );
  const installedSchema = fs.readFileSync(path.join(installedRoot, "schemas", "diagnostic-bundle.v1.json"));
  if (
    installedSchema.byteLength !== 6494 ||
    createHash("sha256").update(installedSchema).digest("hex") !==
      "4dd7282d17bb417d56f1c3cfa243e03b612a401e5d22be766658849287e431a9"
  ) {
    throw new Error("installed diagnostic-bundle schema does not match the canonical byte pin");
  }
  const manifestFailures = validateInstalledManifest({
    packageRoot: installedRoot,
    packageJson: installedPackageJson,
    entrypoints,
  });
  if (manifestFailures.length > 0) throw new Error(manifestFailures.join("\n"));
  const peerFixtureCount = linkPeerFixtures(installedPackageJson);

  fs.writeFileSync(
    path.join(consumerRoot, "runtime-smoke.mjs"),
    runtimeSmokeSource(packageJson.name, entrypoints),
  );
  run("installed runtime imports", process.execPath, ["runtime-smoke.mjs"], {
    cwd: consumerRoot,
  });
  fs.writeFileSync(
    path.join(consumerRoot, "plugin-registry-smoke.mjs"),
    `import { HONUA_PLUGIN_API_VERSION, HONUA_PLUGIN_MANIFEST_VERSION, HonuaPluginRegistry } from "@honua/sdk-js/plugin";
const events = [];
const manifest = {
  manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
  id: "com.example.installed-style",
  version: "1.0.0",
  kind: "style",
  package: { name: "@example/installed-style", entrypoint: "./plugin.js" },
  compatibility: { pluginApi: HONUA_PLUGIN_API_VERSION, minimumSdk: "0.1.0-beta.0", environments: ["node"] },
  capabilities: ["validate"], requestedGrants: {},
  data: { cache: "none", freshness: "snapshot", authentication: "none", provenance: "preserved", mutation: "none", realtime: "none" },
  lifecycle: { initialization: "explicit", disposal: "required" }, support: "community",
};
const registry = new HonuaPluginRegistry({ host: JSON.stringify({ pluginApi: HONUA_PLUGIN_API_VERSION, sdkVersion: "0.1.0-beta.0", environment: "node" }) });
await registry.register([{ manifest: JSON.stringify(manifest), initialize(context) { events.push("initialize"); return { extension: { id: context.manifest.id, kind: "style" }, dispose() { events.push("dispose"); } }; } }]);
if (registry.get("style", manifest.id)?.id !== manifest.id) throw new Error("installed plugin registry lookup failed");
await registry.dispose();
if (events.join(",") !== "initialize,dispose") throw new Error(\`installed plugin lifecycle mismatch: \${events}\`);
`,
  );
  run("installed plugin registry lifecycle", process.execPath, ["plugin-registry-smoke.mjs"], {
    cwd: consumerRoot,
  });

  fs.writeFileSync(
    path.join(consumerRoot, "types-smoke.ts"),
    typeSmokeSource(packageJson.name, entrypoints),
  );
  fs.writeFileSync(
    path.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
          types: [],
        },
        files: ["types-smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(
    "installed TypeScript declarations",
    process.execPath,
    [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: consumerRoot },
  );

  const cli = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "honua.cmd" : "honua",
  );
  run("installed honua --help", cli, ["--help"], { cwd: consumerRoot });

  const exchangePath = path.join(consumerRoot, "doctor-exchange.json");
  const bundlePath = path.join(consumerRoot, "doctor-bundle.json");
  fs.writeFileSync(
    exchangePath,
    JSON.stringify({
      request: {
        method: "GET",
        url: "https://user:password@example.test/api/v1/services?token=raw-token",
        headers: { authorization: "Bearer raw-auth", "x-request-id": "packed-request" },
      },
      response: {
        status: 500,
        mediaType: "application/json",
        headers: { "content-type": "application/json" },
        body: { error: "fixture", apiKey: "raw-key" },
      },
    }),
  );
  run(
    "installed honua doctor emit",
    cli,
    [
      "doctor",
      "--exchange",
      exchangePath,
      "--classification",
      "internal",
      "--redaction-acknowledged=true",
      "--share-with-support=false",
      "--output",
      bundlePath,
      "--json",
    ],
    { cwd: consumerRoot },
  );
  const installedBundleText = fs.readFileSync(bundlePath, "utf8");
  for (const forbidden of ["raw-token", "raw-auth", "raw-key", "password"]) {
    if (installedBundleText.includes(forbidden)) throw new Error(`installed doctor artifact leaked ${forbidden}`);
  }

  const malformedPath = path.join(consumerRoot, "doctor-malformed.json");
  fs.writeFileSync(malformedPath, JSON.stringify({ schemaVersion: "0", envelopes: [] }));
  runFailure(
    "installed honua doctor validation failure",
    cli,
    ["doctor", "--replay", malformedPath, "--base-url", "https://example.test", "--output", "invalid.json"],
    { cwd: consumerRoot },
  );

  const unsafeBundle = JSON.parse(installedBundleText);
  unsafeBundle.envelopes[0] = { method: "POST", normalizedPath: "/api/v1/applyEdits" };
  const unsafePath = path.join(consumerRoot, "doctor-unsafe-replay.json");
  fs.writeFileSync(unsafePath, JSON.stringify(unsafeBundle));
  runFailure(
    "installed honua doctor unsafe replay",
    cli,
    ["doctor", "--replay", unsafePath, "--base-url", "https://example.test", "--output", "replay.json"],
    { cwd: consumerRoot },
  );

  process.stdout.write(
    `packedSdk=ok package=${packageJson.name}@${packageJson.version} runtimeImports=${entrypoints.length} typeImports=${entrypoints.length} peerFixtures=${peerFixtureCount} bin=honua doctor=emit+validate+replay-refusal offlineInstall=true\n`,
  );
} catch (error) {
  process.stderr.write(
    `Packed-SDK verification FAILED:\n  - ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
