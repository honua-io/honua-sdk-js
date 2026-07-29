#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { startSampleFixtureHarness } from "../samples/scenarios/index.mjs";
import { runNpmSync } from "./lib/npm-cli.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-first-map-pack-"));
let bundleRoot;

function run(label, command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  };
  const result =
    command === "npm" ? runNpmSync(args, spawnOptions) : spawnSync(command, args, spawnOptions);
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`${label} failed${result.status === null ? "" : ` (exit ${result.status})`}: ${detail}`);
  }
  return result.stdout;
}

function exportTarget(packageRoot, key) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const declaration = manifest.exports?.[key];
  const target = typeof declaration === "string" ? declaration : declaration?.default;
  if (typeof target !== "string" || !target.startsWith("./dist/") || !target.endsWith(".js")) {
    throw new Error(`packed SDK has no safe ${key} runtime export`);
  }
  const resolved = path.resolve(packageRoot, target);
  const metadata = fs.lstatSync(resolved);
  const canonical = fs.realpathSync(resolved);
  if (
    !resolved.startsWith(`${path.resolve(packageRoot)}${path.sep}`) ||
    !canonical.startsWith(`${fs.realpathSync(packageRoot)}${path.sep}`) ||
    metadata.isSymbolicLink() ||
    !metadata.isFile()
  ) {
    throw new Error(`packed SDK ${key} runtime export escapes its package`);
  }
  return resolved;
}

async function bundle(mode, rootTarget, runtimeTarget) {
  const outDir = path.join(bundleRoot, mode);
  await build({
    configFile: false,
    logLevel: "error",
    resolve: {
      alias: [
        { find: "@honua/sdk-js/runtime", replacement: runtimeTarget },
        { find: "@honua/sdk-js", replacement: rootTarget },
      ],
    },
    build: {
      ssr: path.join(projectRoot, "test/helpers/first-map-parity-entry.ts"),
      outDir,
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: "first-map.mjs" } },
    },
  });
  return import(`${pathToFileURL(path.join(outDir, "first-map.mjs")).href}?mode=${mode}`);
}

try {
  const packedOutput = run("npm pack", "npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packRoot,
    projectRoot,
  ]);
  const packed = JSON.parse(packedOutput);
  const tarballName = packed.find(({ name }) => name === "@honua/sdk-js")?.filename;
  if (typeof tarballName !== "string") throw new Error("npm pack did not report the @honua/sdk-js tarball");
  bundleRoot = fs.mkdtempSync(path.join(projectRoot, ".first-map-parity-"));
  run("extract packed SDK", "tar", ["-xzf", path.join(packRoot, tarballName), "-C", bundleRoot]);
  const packedSdk = path.join(bundleRoot, "package");
  const source = await bundle(
    "source",
    path.join(projectRoot, "src/index.ts"),
    path.join(projectRoot, "src/runtime/index.ts"),
  );
  const installed = await bundle("packed", exportTarget(packedSdk, "."), exportTarget(packedSdk, "./runtime"));
  const harness = await startSampleFixtureHarness({ sampleId: "first-map" });
  try {
    const cases = [
      {
        args: [`${harness.origin}/rest/services/natural-earth/FeatureServer/0`, "auto"],
        compiler: "geoservices-rest-query-v1",
      },
      {
        args: [`${harness.origin}/ogc/features`, "ogc-features", "operations-areas"],
        compiler: "ogc-api-features-query-v1",
      },
    ];
    for (const { args, compiler } of cases) {
      const sourceEvidence = await source.captureFirstMapSemantics(...args);
      const packedEvidence = await installed.captureFirstMapSemantics(...args);
      assert.equal(sourceEvidence.plan.compiled?.compiler, compiler, `${args[1]} source plan compiler differs`);
      assert.match(sourceEvidence.plan.fingerprint, /^sha256:[a-f0-9]{64}$/);
      assert.equal(sourceEvidence.query.receipt.plan.fingerprint, sourceEvidence.plan.fingerprint);
      assert.equal(sourceEvidence.query.receipt.terminal.exceededTransferLimit, false);
      assert.ok(sourceEvidence.mount.some(({ code }) => code === "selected"), `${args[1]} did not mount`);
      assert.deepEqual(packedEvidence, sourceEvidence, `${args[1]} source/packed First Map semantics differ`);
    }
  } finally {
    await harness.close();
  }
  process.stdout.write("firstMapSemanticParity=ok modes=source,packed protocols=geoservices,ogc-features\n");
} finally {
  if (bundleRoot) fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.rmSync(packRoot, { recursive: true, force: true });
}
