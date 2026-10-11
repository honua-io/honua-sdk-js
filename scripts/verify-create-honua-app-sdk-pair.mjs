#!/usr/bin/env node

// Compile starter projects from the packed scaffold beside the packed SDK.
// The explicit version is a local review override, never a shipped pin change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import { runNpmSync } from "./lib/npm-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "honua-starter-sdk-pair-"));
const sdk = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const scaffoldRoot = path.join(root, "packages/create-honua-app");
const scaffold = JSON.parse(fs.readFileSync(path.join(scaffoldRoot, "package.json"), "utf8"));
const baselineRef = process.env.HONUA_BASEMAP_BUNDLE_BASELINE_REF;
const baselineCommit = baselineRef ? execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`], { cwd: root, encoding: "utf8" }).trim() : undefined;
const report = { observedAt: new Date().toISOString(), sdkVersion: sdk.version, scaffoldVersion: scaffold.version, bundleBaselineCommit: baselineCommit, defaultPeerResolution: true, templates: [] };

function npm(args, cwd, extraEnv = {}) {
  const result = runNpmSync(args, { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`npm ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}

function pack(directory) {
  const result = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", workspace], directory));
  const tarball = path.join(workspace, result[0].filename);
  return { tarball, integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}` };
}

function bundleBytes(directory) {
  let javascriptBytes = 0;
  let javascriptGzipBytes = 0;
  let chunks = 0;
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".js")) {
        const bytes = fs.readFileSync(file);
        javascriptBytes += bytes.length;
        javascriptGzipBytes += gzipSync(bytes).length;
        chunks++;
        files.push({ path: path.relative(path.join(directory, "dist"), file), bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
      }
    }
  };
  walk(path.join(directory, "dist"));
  return { javascriptBytes, javascriptGzipBytes, chunks, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

function compareLiveStarter(template, destination) {
  const sourceName = template === "react-ts" ? "App.tsx" : "main.ts";
  const sourcePath = path.join(destination, "src", sourceName);
  const currentSource = fs.readFileSync(sourcePath, "utf8");
  const baselineSource = execFileSync("git", ["show", `${baselineCommit}:packages/create-honua-app/templates/${template}/src/${sourceName}`], { cwd: root, encoding: "utf8" });
  // Exercise the live branch; default fixture builds may eliminate its imports.
  const liveEnv = { VITE_HONUA_ENDPOINT: "https://example.test/FeatureServer/0" };
  npm(["run", "build"], destination, liveEnv);
  const current = bundleBytes(destination);
  try {
    fs.writeFileSync(sourcePath, baselineSource);
    npm(["run", "build"], destination, liveEnv);
    const baseline = bundleBytes(destination);
    return { baselineCommit, sameInstalledSdk: true, allJavaScriptChunks: true, baseline, current, delta: { javascriptBytes: current.javascriptBytes - baseline.javascriptBytes, javascriptGzipBytes: current.javascriptGzipBytes - baseline.javascriptGzipBytes } };
  } finally {
    fs.writeFileSync(sourcePath, currentSource);
  }
}

try {
  const packedSdk = pack(root);
  const packedScaffold = pack(scaffoldRoot);
  report.sdkIntegrity = packedSdk.integrity;
  report.scaffoldIntegrity = packedScaffold.integrity;
  const consumer = path.join(workspace, "scaffold-consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "honua-scaffold-pair-review", private: true, type: "module" }));
  npm(["install", "--no-audit", "--no-fund", packedScaffold.tarball], consumer);
  const cli = path.join(consumer, "node_modules", scaffold.name, "bin/create-honua-app.mjs");
  const candidates = [{ name: "packed", version: sdk.version, artifact: packedSdk.tarball }];
  if (process.env.HONUA_CREATE_APP_REGISTRY_COMPAT_ENABLED === "true") {
    candidates.push({ name: "registry-compat", version: "0.1.14", artifact: "@honua/sdk-js@0.1.14" });
  }
  for (const candidate of candidates) {
    for (const template of ["vanilla-ts", "react-ts"]) {
      const destination = path.join(workspace, `${candidate.name}-${template}`);
      execFileSync(process.execPath, [cli, destination, "--template", template, "--sdk-version", candidate.version], { cwd: consumer, encoding: "utf8" });
      npm(["install", "--no-audit", "--no-fund", candidate.artifact], destination);
      const installedSdk = JSON.parse(fs.readFileSync(path.join(destination, "node_modules/@honua/sdk-js/package.json"), "utf8"));
      if (installedSdk.version !== candidate.version) throw new Error(`${template}: expected SDK ${candidate.version}, installed ${installedSdk.version}`);
      const installedLock = JSON.parse(fs.readFileSync(path.join(destination, "package-lock.json"), "utf8"));
      const installedIntegrity = installedLock.packages["node_modules/@honua/sdk-js"]?.integrity;
      if (!installedIntegrity) throw new Error(`${template}: installed SDK integrity missing from consumer lockfile`);
      npm(["run", "typecheck"], destination);
      npm(["run", "build"], destination);
      const fixtureBundleBytes = bundleBytes(destination);
      const liveBundleComparison = candidate.name === "packed" && baselineCommit ? compareLiveStarter(template, destination) : undefined;
      if (candidate.name === "packed") {
        const resolvedStyle = execFileSync(process.execPath, ["--input-type=module", "--eval", 'import { resolveHonuaOnlineBasemapStyle } from "@honua/sdk-js/runtime"; process.stdout.write(resolveHonuaOnlineBasemapStyle());'], { cwd: destination, encoding: "utf8" });
        if (resolvedStyle !== "https://tiles.openfreemap.org/styles/positron") throw new Error(`${template}: installed runtime basemap export did not resolve its shared default`);
      } else {
        // Execute the shipped adapter against actual registry bytes, without
        // mocking runtime exports. The missing helper must produce useful UI.
        const helper = fs.readFileSync(path.join(destination, "src/online-basemap.ts"), "utf8");
        fs.writeFileSync(path.join(destination, "basemap-compat-review.mjs"), ts.transpileModule(helper, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
        execFileSync(process.execPath, ["--input-type=module", "--eval", `
          import assert from "node:assert/strict";
          import * as runtime from "@honua/sdk-js/runtime";
          import { mountSampleOnlineBasemap } from "./basemap-compat-review.mjs";
          assert.equal(Reflect.get(runtime, "HonuaOnlineBasemapBinding"), undefined);
          const notice = { style: {}, dataset: {}, setAttribute() {}, remove() {} };
          globalThis.document = { createElement: () => notice };
          const dispose = mountSampleOnlineBasemap({ getContainer: () => ({ append() {} }) });
          assert.ok(notice.textContent.includes("Upgrade @honua/sdk-js"));
          assert.equal(notice.dataset.basemapStatus, "error");
          dispose();
        `], { cwd: destination, encoding: "utf8" });
      }
      report.templates.push({ template, candidate: candidate.name, sdkVersion: installedSdk.version, sdkIntegrity: installedIntegrity, fixtureBundleBytes, liveBundleComparison, typecheck: "pass", build: "pass", installedRuntimeExport: candidate.name === "packed" ? "pass" : "actionable-upgrade-pass" });
      fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
      fs.writeFileSync(path.join(root, "test-results/create-app-sdk-pair.json"), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${candidate.name}/${template} bundle=${JSON.stringify({ fixtureBundleBytes, liveBundleComparison })}\n`);
    }
  }
  fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(root, "test-results/create-app-sdk-pair.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`createHonuaAppSdkPair=ok sdk=${sdk.version} scaffold=${scaffold.version} templates=${report.templates.length}\n`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
