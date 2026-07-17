#!/usr/bin/env node

/**
 * Time-to-first-map benchmark (issue #499, REQ-002 / NFR-001).
 *
 * Measures, end to end and reproducibly from a clean checkout:
 *
 *   Phase 1 — cold install: `npm install @honua/sdk-js` (the published
 *   package, latest dist-tag) into a fresh temp project using an EMPTY npm
 *   cache, so registry download + extraction cost is included.
 *
 *   Phase 2 — first map: build the deterministic `maplibre-quickstart`
 *   fixture-lane example against the temp-installed published package (the
 *   bundle resolves `@honua/sdk-js` from the phase-1 install via
 *   the shared sample kit's packed-SDK mode, not repo source), serve it with the mock
 *   GeoServices server (NO live endpoints), and drive headless Chromium until
 *   the example reports rendered-map-ready (all five journey stages complete
 *   AND a MapLibre canvas is mounted). This is the same signal the CI
 *   quickstart timing lane gates on (`scripts/quickstart-time-to-map.mjs`).
 *
 *   Fallback (`--lane node-query`, or automatic ONLY when Playwright/Chromium
 *   is unavailable) — instead of a browser measurement, phase 2 measures
 *   "fixture server ready + first successful feature query against the mock"
 *   executed with the temp-installed published package in Node. The lane is
 *   recorded in the evidence so the published figure always says exactly
 *   what was measured.
 *
 * Run with: `npm run bench:ttfm`
 *   --lane auto|browser|node-query   lane selection (default auto)
 *   --output <path>                  evidence JSON (default test-results/time-to-first-map.json)
 *   --write-reference                also refresh the committed reference figures in
 *                                    docs/data/time-to-first-map.json (then run
 *                                    `npm run docs:comparison` to project them into docs/comparison.md)
 *
 * Numbers are machine- and network-dependent; they are reference figures,
 * not guarantees. The comparison page prints the caveats alongside them.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = "test-results/time-to-first-map.json";
const REFERENCE_FILE = path.join(ROOT, "docs", "data", "time-to-first-map.json");
const PACKAGE_UNDER_TEST = "@honua/sdk-js";
const PHASE_TIMEOUT_MS = 600_000;

export const TTFM_FORMAT = "honua.sdk.time-to-first-map.v1";
export const TTFM_LANES = Object.freeze({
  browser: "browser-first-map",
  nodeQuery: "node-first-query",
});

/**
 * Thrown when the browser lane cannot run because Playwright/Chromium is
 * missing — the ONLY condition under which `--lane auto` may fall back to the
 * node-query lane. Every other browser-lane failure (build error, rendered-map
 * timeout) is a real regression and fails the benchmark.
 */
export class ChromiumUnavailableError extends Error {}

export function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, lane: "auto", writeReference: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--output" && argv[index + 1]) {
      options.output = argv[index + 1];
      index += 1;
      continue;
    }
    if (flag === "--lane" && argv[index + 1]) {
      const lane = argv[index + 1];
      if (!["auto", "browser", "node-query"].includes(lane)) {
        throw new Error(`--lane must be auto, browser, or node-query (got ${lane})`);
      }
      options.lane = lane;
      index += 1;
      continue;
    }
    if (flag === "--write-reference") {
      options.writeReference = true;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  return options;
}

export function validateTtfmEvidence(evidence) {
  const failures = [];
  if (evidence.format !== TTFM_FORMAT) failures.push("format is invalid");
  if (evidence.status !== "passed") failures.push("status must be passed");
  if (!Object.values(TTFM_LANES).includes(evidence.lane)) failures.push("lane is invalid");
  for (const field of ["installMs", "firstMapMs", "totalMs"]) {
    if (!Number.isFinite(evidence.phases?.[field]) || evidence.phases[field] < 0) {
      failures.push(`phases.${field} must be a non-negative finite number`);
    }
  }
  if (
    Number.isFinite(evidence.phases?.totalMs) &&
    evidence.phases.totalMs !== evidence.phases.installMs + evidence.phases.firstMapMs
  ) {
    failures.push("phases.totalMs must equal installMs + firstMapMs");
  }
  if (evidence.install?.package !== PACKAGE_UNDER_TEST) failures.push(`install.package must be ${PACKAGE_UNDER_TEST}`);
  if (typeof evidence.install?.version !== "string" || evidence.install.version.length === 0) {
    failures.push("install.version is required");
  }
  if (evidence.install?.cache !== "cold") failures.push("install.cache must be cold");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence.measuredAt ?? "")) failures.push("measuredAt must be a YYYY-MM-DD date");
  for (const field of ["node", "platform", "arch"]) {
    if (typeof evidence.environment?.[field] !== "string" || evidence.environment[field].length === 0) {
      failures.push(`environment.${field} is required`);
    }
  }
  if (typeof evidence.definition !== "string" || evidence.definition.length === 0) {
    failures.push("definition is required");
  }
  if (failures.length > 0) throw new Error(`time-to-first-map evidence validation failed: ${failures.join("; ")}`);
  return evidence;
}

function runNpm(args, options) {
  // Prefer invoking npm-cli.js with the current Node binary (available as
  // npm_execpath whenever this script runs via `npm run bench:ttfm`) — no
  // shell, fully cross-platform. Fall back to the npm shim otherwise; on
  // Windows the .cmd shim requires a shell.
  const execpath = process.env.npm_execpath;
  const viaNode = execpath && /\.[cm]?js$/.test(execpath);
  const command = viaNode ? process.execPath : "npm";
  const commandArgs = viaNode ? [execpath, ...args] : args;
  // stdio "inherit" (no pipes): build tooling such as Vite leaves esbuild
  // service processes alive that would otherwise hold the piped stdout open
  // and hang spawnSync after the command itself has exited.
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    timeout: PHASE_TIMEOUT_MS,
    // All arguments here are fixed tokens plus a mkdtemp cache path.
    shell: viaNode ? false : process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed (exit ${result.status}${result.error ? `, ${result.error}` : ""})`);
  }
  return result;
}

function measureColdInstall(workRoot) {
  const projectDir = path.join(workRoot, "project");
  const cacheDir = path.join(workRoot, "npm-cache");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ name: "honua-ttfm-probe", private: true, type: "module" }, null, 2)}\n`,
  );

  const startedAt = performance.now();
  runNpm(
    ["install", PACKAGE_UNDER_TEST, "--no-audit", "--no-fund", "--no-progress", "--loglevel=error", `--cache=${cacheDir}`],
    { cwd: projectDir },
  );
  const installMs = Math.round(performance.now() - startedAt);

  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(projectDir, "node_modules", "@honua", "sdk-js", "package.json"), "utf8"),
  );
  return { projectDir, installMs, version: installedManifest.version };
}

async function measureBrowserFirstMap(projectDir) {
  const startedAt = performance.now();

  // Only a missing Playwright/Chromium environment may divert `--lane auto`
  // to the node-query lane; build errors and render timeouts must fail the
  // benchmark (see runBenchmark). Import the launcher up front so "not
  // installed" is classified before any build work happens.
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (error) {
    throw new ChromiumUnavailableError(
      `@playwright/test is not installed: ${error instanceof Error ? error.message : error}`,
    );
  }

  // Build the fixture-lane example exactly the way the mock server would
  // (same env contract), then serve the prebuilt output so the build is
  // spawned once and under our Windows-safe spawn options. The bundle
  // resolves @honua/sdk-js from the phase-1 temp install (published dist),
  // not the repo source, so the evidence measures what consumers get.
  const { FIXTURE_BUILD_ENV, startQuickstartFixtureServer } = await import(
    "../examples/maplibre-quickstart/mock-server.mjs"
  );
  runNpm(["run", "demo:quickstart:build", "--silent"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...FIXTURE_BUILD_ENV,
      HONUA_SAMPLE_SDK_MODE: "packed",
      HONUA_SAMPLE_SDK_DIR: path.join(projectDir, "node_modules", "@honua", "sdk-js"),
    },
  });

  const fixtureServer = await startQuickstartFixtureServer({ build: false });
  let browser;
  try {
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
    } catch (error) {
      throw new ChromiumUnavailableError(
        `Chromium launch failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
      );
    }
    const page = await browser.newPage();
    await page.goto(fixtureServer.url, { timeout: PHASE_TIMEOUT_MS });
    await page.waitForFunction(
      () =>
        window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true &&
        document.querySelector(".maplibregl-canvas") !== null,
      undefined,
      { timeout: PHASE_TIMEOUT_MS },
    );
    return { lane: TTFM_LANES.browser, firstMapMs: Math.round(performance.now() - startedAt) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fixtureServer.close().catch(() => {});
  }
}

async function measureNodeFirstQuery(projectDir) {
  const startedAt = performance.now();
  const { startQuickstartFixtureServer } = await import("../examples/maplibre-quickstart/mock-server.mjs");
  const fixtureServer = await startQuickstartFixtureServer({ build: false });
  try {
    const probePath = path.join(projectDir, "first-query.mjs");
    fs.writeFileSync(
      probePath,
      [
        'import { HonuaClient } from "@honua/sdk-js";',
        "const client = new HonuaClient({ baseUrl: process.argv[2] });",
        "const result = await client.queryFeatures({",
        '  serviceId: "natural-earth",',
        "  layerId: 0,",
        '  where: "1=1",',
        '  outFields: ["*"],',
        "  returnGeometry: true,",
        "  resultRecordCount: 25,",
        "});",
        'if (!result.features?.length) throw new Error("first query returned no features");',
        "console.log(JSON.stringify({ features: result.features.length }));",
        "",
      ].join("\n"),
    );
    // The fixture server runs in THIS process, so the probe must be awaited
    // asynchronously — a spawnSync here would block the event loop and
    // deadlock the probe's HTTP requests.
    await new Promise((resolve, reject) => {
      const probe = spawn(process.execPath, [probePath, fixtureServer.url], {
        cwd: projectDir,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PHASE_TIMEOUT_MS,
      });
      let output = "";
      probe.stdout.on("data", (chunk) => {
        output += chunk;
      });
      probe.stderr.on("data", (chunk) => {
        output += chunk;
      });
      probe.on("error", reject);
      probe.on("close", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`first-query probe failed (exit ${code}):\n${output}`));
      });
    });
    return { lane: TTFM_LANES.nodeQuery, firstMapMs: Math.round(performance.now() - startedAt) };
  } finally {
    await fixtureServer.close().catch(() => {});
  }
}

function laneDefinition(lane) {
  return lane === TTFM_LANES.browser
    ? "Cold `npm install @honua/sdk-js` (empty npm cache) in a fresh temp project, plus: build the deterministic maplibre-quickstart fixture-lane example against the temp-installed published package (the bundle resolves @honua/sdk-js from the phase-1 install, not repo source), serve it with the mock GeoServices server, and wait in headless Chromium for the rendered-map-ready signal (all five journey stages complete and a MapLibre canvas mounted). No live endpoints."
    : "Cold `npm install @honua/sdk-js` (empty npm cache) in a fresh temp project, plus: start the deterministic maplibre-quickstart mock GeoServices server and run the first successful feature query against it in Node using the temp-installed published package. This lane measures dev-server-ready + first successful query against the mock, not a rendered browser map. No live endpoints.";
}

export async function runBenchmark(options) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-ttfm-"));
  try {
    process.stdout.write(`phase 1/2: cold npm install ${PACKAGE_UNDER_TEST} (empty cache) in ${workRoot}\n`);
    const install = measureColdInstall(workRoot);
    process.stdout.write(`  installed ${PACKAGE_UNDER_TEST}@${install.version} in ${install.installMs}ms\n`);

    process.stdout.write(`phase 2/2: first map against the deterministic fixture lane (lane=${options.lane})\n`);
    let phase2;
    if (options.lane === "node-query") {
      phase2 = await measureNodeFirstQuery(install.projectDir);
    } else {
      try {
        phase2 = await measureBrowserFirstMap(install.projectDir);
      } catch (error) {
        // Auto-lane falls back ONLY when the browser environment itself is
        // unavailable. A Vite build error or a rendered-map timeout with
        // Chromium present is a real first-map regression and must fail
        // rather than silently publish node-query evidence.
        if (options.lane === "browser" || !(error instanceof ChromiumUnavailableError)) throw error;
        process.stdout.write(
          `  browser lane unavailable (${error instanceof Error ? error.message.split("\n")[0] : error}); falling back to node-query lane\n`,
        );
        phase2 = await measureNodeFirstQuery(install.projectDir);
      }
    }
    process.stdout.write(`  ${phase2.lane} completed in ${phase2.firstMapMs}ms\n`);

    const evidence = validateTtfmEvidence({
      format: TTFM_FORMAT,
      status: "passed",
      lane: phase2.lane,
      measuredAt: new Date().toISOString().slice(0, 10),
      phases: {
        installMs: install.installMs,
        firstMapMs: phase2.firstMapMs,
        totalMs: install.installMs + phase2.firstMapMs,
      },
      install: { package: PACKAGE_UNDER_TEST, version: install.version, cache: "cold" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
      },
      definition: laneDefinition(phase2.lane),
    });

    const outputPath = path.resolve(ROOT, options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(ROOT, outputPath)}\n`);

    if (options.writeReference) {
      fs.mkdirSync(path.dirname(REFERENCE_FILE), { recursive: true });
      fs.writeFileSync(REFERENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
      process.stdout.write(
        `wrote ${path.relative(ROOT, REFERENCE_FILE)} — run \`npm run docs:comparison\` to project it into docs/comparison.md\n`,
      );
    }

    process.stdout.write(
      `time-to-first-map: ${(evidence.phases.totalMs / 1000).toFixed(1)}s total ` +
        `(install ${(evidence.phases.installMs / 1000).toFixed(1)}s + ${phase2.lane} ${(evidence.phases.firstMapMs / 1000).toFixed(1)}s)\n`,
    );
    return evidence;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    await runBenchmark(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
