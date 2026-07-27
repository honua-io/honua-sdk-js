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
  const consumerNpmEnv = {
    ...process.env,
    npm_config_cache: path.join(tempRoot, "npm-cache"),
    npm_config_update_notifier: "false",
  };

  const packedOutput = run(
    "npm pack",
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot, projectRoot],
    { env: consumerNpmEnv, timeout: 120_000 },
  );
  const packed = JSON.parse(packedOutput);
  const tarballName = packed.find((artifact) => artifact.name === packageJson.name)?.filename;
  if (typeof tarballName !== "string") {
    throw new Error("npm pack did not report a tarball filename");
  }
  const tarballPath = path.join(packRoot, tarballName);

  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      { name: "honua-packed-sdk-smoke", version: "0.0.0", private: true, type: "module" },
      null,
      2,
    )}\n`,
  );
  // The SDK's runtime dependency tree now includes registry packages whose
  // nested duplicate versions (for example rbush@3's quickselect@2 next to
  // maplibre-gl-style-spec's quickselect@3) cannot be expressed as a flat set
  // of same-named tarball arguments, so the pre-publish offline install proof
  // is no longer representable. With @honua/honua-migrate published, the real
  // consumer scenario is a registry install of the packed tarball: npm must
  // resolve every declared dependency from the registry with no help from
  // this repository's node_modules.
  run(
    "packed-tarball registry install",
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--legacy-peer-deps",
      tarballPath,
    ],
    {
      cwd: consumerRoot,
      timeout: 600_000,
      env: consumerNpmEnv,
    },
  );

  const installedRoot = path.join(consumerRoot, "node_modules", "@honua", "sdk-js");
  const installedPackageJson = JSON.parse(
    fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"),
  );
  for (const publishedGuidance of ["config/root-surface.json", "docs/root-surface-migration.md"]) {
    const source = fs.readFileSync(path.join(projectRoot, publishedGuidance));
    const installed = fs.readFileSync(path.join(installedRoot, publishedGuidance));
    if (!source.equals(installed)) throw new Error(`installed ${publishedGuidance} differs from the reviewed source`);
  }
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
    path.join(consumerRoot, "geocoding-smoke.mjs"),
    `import { HonuaGeocodingClient } from "@honua/sdk-js/geocoding";
if (typeof HonuaGeocodingClient !== "function") throw new Error("installed geocoding entrypoint is missing HonuaGeocodingClient");
`,
  );
  run("installed geocoding subpath", process.execPath, ["geocoding-smoke.mjs"], {
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

  fs.copyFileSync(
    path.join(projectRoot, "test", "fixtures", "pmtiles", "sample-vector.pmtiles"),
    path.join(consumerRoot, "pmtiles-fixture.pmtiles"),
  );
  fs.writeFileSync(
    path.join(consumerRoot, "pmtiles-connect-smoke.mjs"),
    `import { readFileSync } from "node:fs";
import { connect } from "@honua/sdk-js";

const fixture = readFileSync(new URL("./pmtiles-fixture.pmtiles", import.meta.url));
const asset = Buffer.alloc(64 * 1024);
fixture.copy(asset);
const ranges = [];
const requests = [];
const fetchFn = async (input, init) => {
  const headers = new Headers(init?.headers);
  const range = headers.get("range");
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range ?? "");
  if (!match) return new Response("missing range", { status: 400 });
  const start = Number(match[1]);
  const end = Number(match[2]);
  ranges.push(range);
  requests.push({ authorization: headers.get("authorization"), cache: init?.cache });
  const body = asset.subarray(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Length": String(body.byteLength),
      "Content-Range": \`bytes \${start}-\${end}/\${asset.byteLength}\`,
      ETag: '"packed-fixture-v1"',
    },
  });
};

const connected = await connect({
  endpoint: "https://assets.example.test/maps/packed.pmtiles",
  protocol: "pmtiles",
  authorizationScopeFingerprint: "public",
  clientOptions: { fetchFn, bearerToken: "packed-secret" },
});
if (ranges.length !== 1 || ranges[0] !== "bytes=0-16383") {
  throw new Error(\`installed PMTiles discovery exceeded its bounded range plan: \${ranges.join(",")}\`);
}
if (requests[0]?.authorization !== "Bearer packed-secret" || requests[0]?.cache !== "no-store") {
  throw new Error("installed PMTiles discovery bypassed auth/cache pipeline semantics");
}
if (connected.inspection.protocol !== "pmtiles") throw new Error("installed PMTiles protocol classification failed");
if (connected.inspection.sources[0]?.metadata?.pmtiles?.tileKind !== "mvt") {
  throw new Error("installed PMTiles metadata discovery failed");
}
if (!connected.source().capabilities.has("tiles")) throw new Error("installed PMTiles source lacks tiles capability");
const described = await connected.source().protocol("pmtiles")?.describe();
if (described?.tileKind !== "mvt" || ranges.length !== 1) {
  throw new Error("installed PMTiles typed adapter did not reuse reviewed metadata");
}
`,
  );
  run("installed bounded PMTiles connect", process.execPath, ["pmtiles-connect-smoke.mjs"], {
    cwd: consumerRoot,
  });

  fs.copyFileSync(
    path.join(projectRoot, "test", "root-surface", "moved-runtime.mjs"),
    path.join(consumerRoot, "root-migration-runtime.mjs"),
  );
  run("installed moved root runtime replacements", process.execPath, ["root-migration-runtime.mjs"], {
    cwd: consumerRoot,
  });

  fs.writeFileSync(
    path.join(consumerRoot, "types-smoke.ts"),
    typeSmokeSource(packageJson.name, entrypoints),
  );
  fs.copyFileSync(
    path.join(projectRoot, "test", "root-surface", "moved-types.ts"),
    path.join(consumerRoot, "root-migration-types.ts"),
  );
  fs.copyFileSync(
    path.join(projectRoot, "test", "root-surface", "golden.ts"),
    path.join(consumerRoot, "root-golden.ts"),
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
        files: ["types-smoke.ts", "root-migration-types.ts", "root-golden.ts"],
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
    `packedSdk=ok package=${packageJson.name}@${packageJson.version} runtimeImports=${entrypoints.length} typeImports=${entrypoints.length} geocoding=runtime pmtilesConnect=bounded-range rootMigration=runtime+types reviewedRoot=true peerFixtures=${peerFixtureCount} bin=honua doctor=emit+validate+replay-refusal registryInstall=true\n`,
  );
} catch (error) {
  process.stderr.write(
    `Packed-SDK verification FAILED:\n  - ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
