#!/usr/bin/env node

// Scriptable "clean machine to running map" check for `create-honua-app` (#958 AC-002).
//
// Scaffolds the starter into a temporary directory, installs its pinned
// dependencies from the registry, builds it, serves the production build, and
// drives the served page in Chromium until a MapLibre canvas has rendered
// features. The whole path is measured against a two-minute budget and written
// as an evidence document.
//
// The install step reaches the npm registry, so the lane is explicitly gated:
// without HONUA_CREATE_APP_LIVE_ENABLED=true it records a skip instead of
// pretending to measure.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { probeFirstMap } from "./lib/create-honua-app-browser.mjs";

import { scaffoldProject } from "../packages/create-honua-app/lib/scaffold.mjs";
import { resolveSdkVersion } from "../packages/create-honua-app/lib/sdk-version.mjs";
import { defaultTemplate, loadTemplateManifest } from "../packages/create-honua-app/lib/templates.mjs";
import {
  CREATE_HONUA_APP_BUDGET_MS,
  CREATE_HONUA_APP_EVIDENCE_FORMAT,
  liveLaneEnabled,
  parseArgs,
  validateCreateHonuaAppEvidence,
  verifyRegistryInstall,
} from "./lib/create-honua-app-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = path.join(ROOT, "packages/create-honua-app");
const SERVER_READY_TIMEOUT_MS = 60_000;
const BROWSER_TIMEOUT_MS = 45_000;

function repositoryRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

function writeEvidence(outputPath, evidence) {
  validateCreateHonuaAppEvidence(evidence);
  const target = path.resolve(ROOT, outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`createHonuaAppTimeToMap=${evidence.status} evidence=${path.relative(ROOT, target)}\n`);
}

function runCommand(command, argumentList, cwd) {
  execFileSync(command, argumentList, { cwd, stdio: "inherit", env: { ...process.env, CI: "1" } });
}

const ANSI_ESCAPE = String.fromCharCode(27);

/** Drop SGR colour sequences so a colourized server URL still parses. */
function stripAnsi(value) {
  return value
    .split(ANSI_ESCAPE)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
    .join("");
}

async function startPreview(projectDirectory) {
  // Detached so the whole process group can be torn down: killing the npm
  // wrapper alone would leave the Vite server holding its port.
  const child = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4173"], {
    cwd: projectDirectory,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The preview server did not report a URL in time.")), SERVER_READY_TIMEOUT_MS);
    let buffered = "";
    const inspect = (chunk) => {
      // Vite colorizes the port, so strip ANSI escapes before reading the URL.
      buffered += stripAnsi(String(chunk));
      const match = buffered.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?/);
      if (!match) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${match[1]}/`);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The preview server exited early with code ${code}.`));
    });
  });
  return {
    url,
    close: () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
}


async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadTemplateManifest(PACKAGE_ROOT);
  const templateId = options.template ?? defaultTemplate(manifest).id;
  const environment = {
    node: process.version,
    createHonuaAppVersion: packageVersion(),
    revision: repositoryRevision(),
  };
  const app = { template: templateId, sdkPackage: manifest.sdk.package, sdkVersion: manifest.sdk.version };
  const selection = options.sdkVersion === undefined ? {} : { requestedSdkVersion: options.sdkVersion };

  if (!liveLaneEnabled(process.env)) {
    writeEvidence(options.output, {
      format: CREATE_HONUA_APP_EVIDENCE_FORMAT,
      status: "skipped",
      ...selection,
      skip: { reason: "HONUA_CREATE_APP_LIVE_ENABLED is not set; the registry install lane stayed disabled." },
      app,
      environment,
    });
    return;
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "create-honua-app-"));
  const projectDirectory = path.join(workspace, "honua-first-map");
  const stages = [];
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  const finishStage = (name) => {
    const now = performance.now();
    stages.push({ name, elapsedMs: Math.round(now - stageStartedAt) });
    stageStartedAt = now;
  };
  let preview;
  let registryInstall;
  const journey = { mapMounted: false, canvasPresent: false, renderedFeatureCount: 0, dataLane: "fixture", consoleErrors: [], externalRequests: [] };
  try {
    // Resolve the SDK the way a user's scaffold does, so the lane measures the
    // promoted channel rather than the fallback pin.
    const sdk = await resolveSdkVersion({ manifest, override: options.sdkVersion });
    app.sdkVersion = sdk.version;
    // An explicit certification cannot use the CLI's offline override fallback.
    // Query the public registry separately, then require npm's installed lock to
    // match these bytes. npm verifies the SRI during the default-resolution install.
    const metadata = options.sdkVersion === undefined ? undefined : JSON.parse(execFileSync("npm", [
      "view", `${sdk.package}@${sdk.version}`, "--json", "--registry=https://registry.npmjs.org/",
      "--@honua:registry=https://registry.npmjs.org/",
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
    scaffoldProject({ templateId, directory: projectDirectory, cwd: workspace, packageRoot: PACKAGE_ROOT, sdk });
    finishStage("scaffold");
    runCommand("npm", ["install", "--no-audit", "--no-fund", ...(options.sdkVersion === undefined ? [] : [
      "--legacy-peer-deps=false", "--force=false", "--@honua:registry=https://registry.npmjs.org/",
    ])], projectDirectory);
    if (options.sdkVersion !== undefined) {
      registryInstall = verifyRegistryInstall({ metadata, packageName: sdk.package, version: sdk.version,
        installed: JSON.parse(fs.readFileSync(path.join(projectDirectory, "node_modules", sdk.package, "package.json"), "utf8")),
        lock: JSON.parse(fs.readFileSync(path.join(projectDirectory, "package-lock.json"), "utf8")),
      });
    }
    finishStage("install");
    runCommand("npm", ["run", "build"], projectDirectory);
    finishStage("build");
    preview = await startPreview(projectDirectory);
    finishStage("serve");
    await probeFirstMap(preview.url, journey, { timeoutMs: BROWSER_TIMEOUT_MS });
    finishStage("map");
    const elapsedMs = Math.round(performance.now() - startedAt);
    writeEvidence(options.output, {
      format: CREATE_HONUA_APP_EVIDENCE_FORMAT,
      status: journey.consoleErrors.length === 0 && journey.externalRequests.length === 0 ? "passed" : "failed",
      ...selection,
      ...(registryInstall ? { registryInstall } : {}),
      measurement: {
        budgetMs: CREATE_HONUA_APP_BUDGET_MS,
        elapsedMs,
        withinBudget: elapsedMs <= CREATE_HONUA_APP_BUDGET_MS,
        scope: "scaffold-to-first-map",
        stages,
      },
      app,
      environment,
      journey,
      ...(journey.consoleErrors.length > 0 || journey.externalRequests.length > 0
        ? { failure: { message: "The scaffolded app reported console errors or off-origin requests." } }
        : {}),
    });
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    for (const name of ["scaffold", "install", "build", "serve", "map"]) {
      if (!stages.some((stage) => stage.name === name)) stages.push({ name, elapsedMs: 0 });
    }
    writeEvidence(options.output, {
      format: CREATE_HONUA_APP_EVIDENCE_FORMAT,
      status: "failed",
      ...selection,
      ...(registryInstall ? { registryInstall } : {}),
      measurement: {
        budgetMs: CREATE_HONUA_APP_BUDGET_MS,
        elapsedMs,
        withinBudget: elapsedMs <= CREATE_HONUA_APP_BUDGET_MS,
        scope: "scaffold-to-first-map",
        stages,
      },
      app,
      environment,
      journey,
      failure: { message: error instanceof Error ? error.message : String(error) },
    });
    process.exitCode = 1;
  } finally {
    preview?.close();
    if (!options.keepWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
