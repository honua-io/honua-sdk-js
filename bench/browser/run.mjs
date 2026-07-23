import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";
import { createServer } from "vite";

import { startQuickstartFixtureServer } from "../../examples/maplibre-quickstart/mock-server.mjs";
import { DECK_GL_CAPABILITY_POLICY } from "./capability-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_BUDGETS = path.join(HERE, "budgets.json");
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const WARMUP_RUNS = 1;
const MEASUREMENT_RUNS = 3;
const SCENARIO_TIMEOUT_MS = 20_000;

// The 1M-row tier is deliberately opt-in (issue #562, REQ-002): it is
// feasible in CI (bounded timeout, deterministic fixture, same headless
// swiftshader path as every other scenario here) but adds real wall-clock
// cost that every routine PR run should not pay. Set
// HONUA_BROWSER_BENCH_SCALE=full (see `npm run bench:browser:full-scale`) to
// include it, e.g. for a scheduled evidence run or before promoting the
// adapter's status out of experimental.
const SCALE_TIERS = Object.freeze([
  Object.freeze({ id: "deckgl.scale-render-100k", rows: 100_000, steadyFrames: 15, timeoutMs: 45_000 }),
  Object.freeze({ id: "deckgl.scale-render-1m", rows: 1_000_000, steadyFrames: 5, timeoutMs: 120_000, optIn: true }),
]);
const INCLUDE_OPT_IN_SCALE_TIERS = process.env.HONUA_BROWSER_BENCH_SCALE === "full";
const LEAK_CYCLES = 25;
const LEAK_WARMUP_CYCLES = 5;
const LEAK_TIMEOUT_MS = 60_000;
const CONTEXT_LOSS_TIMEOUT_MS = 20_000;

// Reviewed scenario producers only. SDK implementation sources and third-party
// packages are intentionally identified by gitCommit and the environment block
// instead: changing the implementation under test must not silently define a
// new benchmark corpus.
export const BROWSER_CORPUS_SOURCE_FILES = Object.freeze([
  "bench/browser/capability-main.ts",
  "bench/browser/capability-policy.mjs",
  "bench/browser/capability.html",
  "bench/browser/fixture.ts",
  "bench/browser/index.html",
  "bench/browser/lifecycle-main.ts",
  "bench/browser/lifecycle.html",
  "bench/browser/main.ts",
  "bench/browser/run.mjs",
  "bench/browser/scale-main.ts",
  "bench/browser/scale.html",
  "src/deckgl/adapter.ts",
  "src/deckgl/index.ts",
  "src/deckgl/lifecycle.ts",
  "src/deckgl/types.ts",
  "examples/maplibre-quickstart/index.html",
  "examples/maplibre-quickstart/mock-server.mjs",
  "examples/maplibre-quickstart/src/first-map-config.ts",
  "examples/maplibre-quickstart/src/first-map-model.ts",
  "examples/maplibre-quickstart/src/first-map-presentation.ts",
  "examples/maplibre-quickstart/src/main.ts",
  "examples/maplibre-quickstart/src/styles.css",
  "examples/maplibre-quickstart/src/telemetry.ts",
  "examples/maplibre-quickstart/src/workflow.ts",
  "examples/maplibre-quickstart/tsconfig.json",
  "examples/maplibre-quickstart/vite.config.ts",
  "samples/scenarios/catalog.mjs",
  "samples/scenarios/determinism.mjs",
  "samples/scenarios/fixture-pack.mjs",
  "samples/scenarios/fixture-validation.mjs",
  "samples/scenarios/handlers/first-map.mjs",
  "samples/scenarios/handlers/incident-operations.mjs",
  "samples/scenarios/http.mjs",
  "samples/scenarios/identifiers.mjs",
  "samples/scenarios/index.mjs",
  "samples/scenarios/run-registry.mjs",
  "samples/scenarios/server.mjs",
  "samples/scenarios/sse.mjs",
  "scripts/lib/fixture-build-environment.mjs",
]);

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function browserCorpusFingerprint({
  repoRoot = REPO_ROOT,
  fixtureRoot = path.join(repoRoot, "samples/fixtures/first-map/v1"),
} = {}) {
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const fixtureFiles = [...new Set(Object.values(manifest.schema?.files ?? {}))].sort();
  if (
    fixtureFiles.length === 0 ||
    fixtureFiles.some(
      (file) => typeof file !== "string" || path.basename(file) !== file || file === "manifest.json",
    )
  ) {
    throw new Error("Browser benchmark fixture manifest has an invalid schema.files inventory");
  }
  const entries = [
    ...BROWSER_CORPUS_SOURCE_FILES.map((logicalPath) => ({
      logicalPath,
      absolutePath: path.join(repoRoot, logicalPath),
    })),
    {
      logicalPath: "samples/fixtures/first-map/v1/manifest.json",
      absolutePath: manifestPath,
    },
    ...fixtureFiles.map((file) => ({
      logicalPath: `samples/fixtures/first-map/v1/${file}`,
      absolutePath: path.join(fixtureRoot, file),
    })),
  ];
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.logicalPath);
    hash.update("\0");
    hash.update(await readFile(entry.absolutePath));
    hash.update("\0");
  }
  return { files: entries.map((entry) => entry.logicalPath), sha256: hash.digest("hex") };
}

function parseArgs(argv) {
  const options = {
    output: "test-results/browser-benchmark/report.json",
    budgets: DEFAULT_BUDGETS,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = argv[++index] ?? "";
    else if (argument === "--budgets") options.budgets = argv[++index] ?? "";
    else if (argument === "--check") options.check = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.output || !options.budgets) throw new Error("--output and --budgets require paths");
  return options;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarize(values) {
  if (values.length === 0) throw new Error("Cannot summarize an empty browser benchmark sample");
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    max: sorted.at(-1),
    mean,
    median: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    p95: percentile(sorted, 0.95),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / Math.abs(mean),
  };
}

function levelForUpperBound(value, budget) {
  if (value > budget.failure) return "failure";
  if (value > budget.warning) return "warning";
  return "pass";
}

/** For metrics where smaller is worse, e.g. steady-state frames per second. */
function levelForLowerBound(value, budget) {
  if (value < budget.failure) return "failure";
  if (value < budget.warning) return "warning";
  return "pass";
}

/**
 * Evaluate the optional per-stage budgets (issue #562, REQ-003) attached to a
 * scale scenario. Additive and opt-in: a scenario without `stagesSummary`, or
 * a budget without a `stages` block, produces no items — every scenario
 * evaluated before this existed keeps its exact prior item count/shape.
 */
function evaluateStageBudgets(scenario, scenarioBudget) {
  if (!scenario.stagesSummary || !scenarioBudget.stages) return [];
  const items = [];
  for (const [metric, summary] of Object.entries(scenario.stagesSummary)) {
    const stageBudget = scenarioBudget.stages[metric];
    if (!stageBudget) continue;
    const level =
      stageBudget.direction === "at-least"
        ? levelForLowerBound(summary.median, stageBudget)
        : levelForUpperBound(summary.median, stageBudget);
    items.push({
      scenarioId: scenario.id,
      metric: `stages.${metric}.median`,
      level,
      actual: summary.median,
      warning: stageBudget.warning,
      failure: stageBudget.failure,
      message: `${metric} median ${summary.median.toFixed(2)}${metric.toLowerCase().includes("fps") ? " fps" : " ms"}`,
    });
  }
  return items;
}

export function evaluateScenarios(scenarios, budgets) {
  const items = [];
  for (const scenario of scenarios) {
    items.push({
      scenarioId: scenario.id,
      metric: "journey-invariants",
      level: scenario.invariants.passed ? "pass" : "failure",
      message: scenario.invariants.passed
        ? "Every measured run rendered, interacted, and remained free of browser errors"
        : "At least one measured run failed rendering, interaction, visual, or error invariants",
    });
    const scenarioBudget = budgets.scenarios[scenario.id];
    if (!scenarioBudget) {
      items.push({
        scenarioId: scenario.id,
        metric: "budget-definition",
        level: "failure",
        message: "No reviewed budget is committed for this browser scenario",
      });
      continue;
    }
    for (const metric of ["firstVisibleMs", "interactionLatencyMs"]) {
      const summary = scenario.summary[metric];
      const absoluteLevel = levelForUpperBound(summary.median, scenarioBudget[metric]);
      items.push({
        scenarioId: scenario.id,
        metric: `${metric}.median`,
        level: absoluteLevel,
        actual: summary.median,
        warning: scenarioBudget[metric].warning,
        failure: scenarioBudget[metric].failure,
        message: `${metric} median ${summary.median.toFixed(2)} ms`,
      });
      const coefficient = summary.coefficientOfVariation;
      const variationLevel =
        coefficient > budgets.variability.failureCoefficientOfVariation
          ? "failure"
          : coefficient > budgets.variability.warningCoefficientOfVariation
            ? "warning"
            : "pass";
      items.push({
        scenarioId: scenario.id,
        metric: `${metric}.coefficientOfVariation`,
        level: variationLevel,
        actual: coefficient,
        warning: budgets.variability.warningCoefficientOfVariation,
        failure: budgets.variability.failureCoefficientOfVariation,
        message: `${metric} repeated-run variation ${(coefficient * 100).toFixed(2)}%`,
      });
    }
    items.push(...evaluateStageBudgets(scenario, scenarioBudget));
  }
  return {
    level: items.some((item) => item.level === "failure")
      ? "failure"
      : items.some((item) => item.level === "warning")
        ? "warning"
        : "pass",
    items,
  };
}

function screenshotEvidence(buffer, relativePath) {
  return {
    path: relativePath,
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

async function instrumentedPage(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const isNetworkRequest = url.protocol === "http:" || url.protocol === "https:";
    const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    if (isNetworkRequest && !isLoopback) {
      externalRequests.push(`${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__HONUA_BROWSER_BENCH_STARTED__ = performance.now();
  });
  return { context, page, pageErrors, consoleErrors, externalRequests };
}

async function runMapLibreSample(browser, url, screenshotPath) {
  const { context, page, pageErrors, consoleErrors, externalRequests } = await instrumentedPage(browser);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true, undefined, {
      timeout: 20_000,
    });
    const firstVisibleMs = await page.evaluate(
      () => performance.now() - (window.__HONUA_BROWSER_BENCH_STARTED__ ?? 0),
    );
    const interaction = await page.evaluate(async () => {
      const button = document.querySelector('[aria-label="Inspect Harbor response district"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error("MapLibre interaction target is missing");
      const startedAt = performance.now();
      const deadline = startedAt + 5_000;
      button.click();
      while (window.__HONUA_QUICKSTART_RUNTIME__?.selectedFeatureId !== "2") {
        if (performance.now() > deadline) throw new Error("MapLibre selection did not complete within 5000 ms");
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        interactionLatencyMs: performance.now() - startedAt,
        selectedFeatureId: window.__HONUA_QUICKSTART_RUNTIME__?.selectedFeatureId,
        popupOpen: window.__HONUA_QUICKSTART_RUNTIME__?.popupOpen === true,
      };
    });
    const visual = await page.screenshot({ path: screenshotPath });
    const screenshot = screenshotEvidence(visual, path.relative(REPO_ROOT, screenshotPath));
    const visible = await page.locator(".maplibregl-canvas").isVisible();
    const layerCount = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__?.layerIds?.length ?? 0);
    return {
      firstVisibleMs,
      interactionLatencyMs: interaction.interactionLatencyMs,
      evidence: { screenshot, layerCount, selectedFeatureId: interaction.selectedFeatureId, popupOpen: interaction.popupOpen },
      errors: { page: pageErrors, console: consoleErrors, externalRequests },
      passed:
        visible &&
        layerCount > 0 &&
        interaction.selectedFeatureId === "2" &&
        interaction.popupOpen &&
        screenshot.bytes > 5_000 &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0 &&
        externalRequests.length === 0,
    };
  } finally {
    await context.close();
  }
}

async function runDeckGlSample(browser, url, screenshotPath) {
  const { context, page, pageErrors, consoleErrors, externalRequests } = await instrumentedPage(browser);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__HONUA_BROWSER_BENCHMARK__), undefined, { timeout: 20_000 });
    const ready = await page.evaluate(async (timeoutMs) => {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`deck.gl render did not complete within ${timeoutMs} ms`)), timeoutMs);
      });
      return Promise.race([window.__HONUA_BROWSER_BENCHMARK__?.ready, timeout]);
    }, SCENARIO_TIMEOUT_MS);
    if (!ready) throw new Error("deck.gl benchmark did not expose ready evidence");
    const interaction = await page.evaluate(async (timeoutMs) => {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`deck.gl interaction did not complete within ${timeoutMs} ms`)), timeoutMs);
      });
      return Promise.race([window.__HONUA_BROWSER_BENCHMARK__?.runInteraction(), timeout]);
    }, SCENARIO_TIMEOUT_MS);
    if (!interaction) throw new Error("deck.gl benchmark did not expose interaction evidence");
    const visual = await page.screenshot({ path: screenshotPath });
    const screenshot = screenshotEvidence(visual, path.relative(REPO_ROOT, screenshotPath));
    const visible = await page.locator("#deck-canvas").isVisible();
    return {
      firstVisibleMs: ready.firstVisibleMs,
      interactionLatencyMs: interaction.interactionLatencyMs,
      evidence: {
        screenshot,
        rows: ready.rows,
        copiedBytes: ready.copiedBytes,
        pickableAtCenter: ready.pickableAtCenter,
        selectedFeatureId: interaction.selectedFeatureId,
        visibleOutcome: interaction.visibleOutcome,
        webglRenderer: ready.webglRenderer,
      },
      errors: { page: pageErrors, console: consoleErrors, externalRequests },
      passed:
        visible &&
        ready.rows === 10_000 &&
        ready.copiedBytes === 0 &&
        ready.pickableAtCenter &&
        interaction.selectedFeatureId === 104_949 &&
        interaction.visibleOutcome === "Selected feature 104949" &&
        screenshot.bytes > 5_000 &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0 &&
        externalRequests.length === 0,
    };
  } finally {
    await context.close();
  }
}

/**
 * Scale-tier deck.gl sample (issue #562, REQ-002/REQ-003): the same binary
 * scatterplot journey as `runDeckGlSample`, at a caller-supplied row count,
 * with SDK conversion, mount/transfer, GPU upload + first frame, steady
 * frame rate, picking, and disposal measured as separate stages instead of
 * one combined number.
 */
async function runDeckGlScaleSample(browser, baseUrl, tier, screenshotPath) {
  const { context, page, pageErrors, consoleErrors, externalRequests } = await instrumentedPage(browser);
  try {
    const url = new URL(`scale.html?rows=${tier.rows}`, baseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__HONUA_DECKGL_SCALE_BENCHMARK__), undefined, {
      timeout: tier.timeoutMs,
    });
    const ready = await page.evaluate(async (timeoutMs) => {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`deck.gl scale render did not complete within ${timeoutMs} ms`)), timeoutMs);
      });
      return Promise.race([window.__HONUA_DECKGL_SCALE_BENCHMARK__?.ready, timeout]);
    }, tier.timeoutMs);
    if (!ready) throw new Error("deck.gl scale benchmark did not expose ready evidence");
    const steady = await page.evaluate(
      async ({ frames, timeoutMs }) => {
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`deck.gl steady frame rate did not complete within ${timeoutMs} ms`)), timeoutMs);
        });
        return Promise.race([window.__HONUA_DECKGL_SCALE_BENCHMARK__?.runSteadyFrameRate(frames), timeout]);
      },
      { frames: tier.steadyFrames, timeoutMs: tier.timeoutMs },
    );
    const picking = await page.evaluate(async (timeoutMs) => {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`deck.gl scale picking did not complete within ${timeoutMs} ms`)), timeoutMs);
      });
      return Promise.race([window.__HONUA_DECKGL_SCALE_BENCHMARK__?.runPicking(), timeout]);
    }, tier.timeoutMs);
    const visual = await page.screenshot({ path: screenshotPath });
    const screenshot = screenshotEvidence(visual, path.relative(REPO_ROOT, screenshotPath));
    const visible = await page.locator("#deck-canvas").isVisible();
    const disposal = await page.evaluate(() => window.__HONUA_DECKGL_SCALE_BENCHMARK__?.dispose());
    return {
      firstVisibleMs: ready.firstFrameMs,
      interactionLatencyMs: picking.pickingMs,
      stages: {
        conversionMs: ready.conversionMs,
        transferMs: ready.transferMs,
        gpuUploadMs: ready.gpuUploadMs,
        steadyFrameRateFps: steady.steadyFrameRateFps,
        pickingMs: picking.pickingMs,
        disposalMs: disposal.disposalMs,
      },
      evidence: {
        screenshot,
        rows: ready.rows,
        copiedBytes: ready.copiedBytes,
        pickableAtCenter: ready.pickableAtCenter,
        selectedFeatureId: picking.selectedFeatureId,
        webglRenderer: ready.webglRenderer,
        memoryApiAvailable: ready.memoryApiAvailable,
        heapBytesAfterFirstFrame: ready.heapBytesAfterFirstFrame,
        heapBytesAfterSteadyFrames: steady.heapBytesAfterSteadyFrames,
        heapBytesAfterDisposal: disposal.heapBytesAfterDisposal,
        steadyFrames: steady.frames,
      },
      errors: { page: pageErrors, console: consoleErrors, externalRequests },
      passed:
        visible &&
        ready.rows === tier.rows &&
        ready.copiedBytes === 0 &&
        ready.pickableAtCenter &&
        picking.selectedFeatureId === 100_000 + 4_949 &&
        screenshot.bytes > 5_000 &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0 &&
        externalRequests.length === 0,
    };
  } finally {
    await context.close();
  }
}

function hasStageSamples(samples) {
  return samples.some((sample) => sample.stages && typeof sample.stages === "object");
}

/**
 * Summarize per-run stage metrics (issue #562, REQ-003: conversion, transfer,
 * GPU upload, steady frame rate, picking, disposal measured separately).
 * Union the stage-key set across every sample so one failed/errored run
 * (which lacks `.stages`) does not silently drop keys the other runs report;
 * a missing value for a given run is treated as `0` rather than excluded, so
 * a failure that skipped a stage still shows up in that stage's summary.
 */
function summarizeStages(samples) {
  const keys = new Set();
  for (const sample of samples) {
    if (!sample.stages) continue;
    for (const key of Object.keys(sample.stages)) keys.add(key);
  }
  const stagesSummary = {};
  for (const key of keys) {
    stagesSummary[key] = summarize(samples.map((sample) => sample.stages?.[key] ?? 0));
  }
  return stagesSummary;
}

export async function runRepeatedScenario(id, runSample, outputDirectory) {
  const warmupFailures = [];
  for (let run = 0; run < WARMUP_RUNS; run += 1) {
    try {
      await runSample(path.join(outputDirectory, `${id}.warmup-${run + 1}.png`));
    } catch (error) {
      warmupFailures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const samples = [];
  for (let run = 0; run < MEASUREMENT_RUNS; run += 1) {
    try {
      samples.push(await runSample(path.join(outputDirectory, `${id}.sample-${run + 1}.png`)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      samples.push({
        firstVisibleMs: 0,
        interactionLatencyMs: 0,
        evidence: { failure: message },
        errors: { page: [], console: [], runner: [message] },
        passed: false,
      });
    }
  }
  return {
    id,
    warmupRuns: WARMUP_RUNS,
    measurementRuns: MEASUREMENT_RUNS,
    warmupFailures,
    samples,
    summary: {
      firstVisibleMs: summarize(samples.map((sample) => sample.firstVisibleMs)),
      interactionLatencyMs: summarize(samples.map((sample) => sample.interactionLatencyMs)),
    },
    ...(hasStageSamples(samples) ? { stagesSummary: summarizeStages(samples) } : {}),
    invariants: { passed: warmupFailures.length === 0 && samples.every((sample) => sample.passed) },
  };
}

/**
 * Browser/device capability + fallback matrix scenario (issue #562,
 * REQ-001). `disableWebGl` monkey-patches `HTMLCanvasElement.getContext` in
 * the page before any script runs, deterministically and portably (not a
 * Chromium-only launch flag) simulating a device with no WebGL at all, so the
 * harness's "unsupported" decision path is exercised the same way it would
 * be on Firefox or WebKit.
 */
async function runCapabilityScenario(browser, baseUrl, { disableWebGl = false } = {}) {
  const { context, page, pageErrors, consoleErrors, externalRequests } = await instrumentedPage(browser);
  try {
    if (disableWebGl) {
      await page.addInitScript(() => {
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function honuaDisabledGetContext(type, ...rest) {
          if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") return null;
          return originalGetContext.call(this, type, ...rest);
        };
      });
    }
    const url = new URL("capability.html", baseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__HONUA_DECKGL_CAPABILITY_HARNESS__), undefined, {
      timeout: SCENARIO_TIMEOUT_MS,
    });
    const evidence = await page.evaluate(async (timeoutMs) => {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`capability probe did not complete within ${timeoutMs} ms`)), timeoutMs);
      });
      return Promise.race([window.__HONUA_DECKGL_CAPABILITY_HARNESS__?.ready, timeout]);
    }, SCENARIO_TIMEOUT_MS);
    await page.evaluate(() => window.__HONUA_DECKGL_CAPABILITY_HARNESS__?.dispose());
    const validTier = ["supported", "fallback-maplibre", "unsupported"].includes(evidence?.decision?.tier);
    const renderedMatchesTier = evidence?.decision?.tier === "supported" ? evidence.rendered === true : evidence?.rendered === false;
    const explicitOutcome =
      evidence?.decision?.tier === "supported" ? evidence.pickableAtCenter === true : (evidence?.decision?.reasons?.length ?? 0) > 0;
    const expectedTierOk = !disableWebGl || evidence?.decision?.tier === "unsupported";
    return {
      evidence,
      errors: { page: pageErrors, console: consoleErrors, externalRequests },
      passed:
        validTier &&
        renderedMatchesTier &&
        explicitOutcome &&
        expectedTierOk &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0 &&
        externalRequests.length === 0,
    };
  } finally {
    await context.close();
  }
}

/**
 * Repeated mount/unmount leak scenario (issue #562, REQ-004). Cycles are
 * driven inside the page (not per-cycle Playwright round-trips) so JS
 * scheduling/IPC overhead never contaminates the heap-growth signal.
 */
async function runLifecycleLeakScenario(browser, baseUrl, { cycles, warmupCycles, timeoutMs }) {
  const { context, page, pageErrors, consoleErrors, externalRequests } = await instrumentedPage(browser);
  try {
    const url = new URL("lifecycle.html", baseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__HONUA_DECKGL_LIFECYCLE_HARNESS__), undefined, {
      timeout: SCENARIO_TIMEOUT_MS,
    });
    const evidence = await page.evaluate(
      async ({ cycles, warmupCycles, timeoutMs }) => {
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`lifecycle leak run did not complete within ${timeoutMs} ms`)), timeoutMs);
        });
        return Promise.race([window.__HONUA_DECKGL_LIFECYCLE_HARNESS__?.runLeakCycles(cycles, warmupCycles), timeout]);
      },
      { cycles, warmupCycles, timeoutMs },
    );
    return {
      evidence,
      errors: { page: pageErrors, console: consoleErrors, externalRequests },
      passed:
        Boolean(evidence?.allLayersClearedAfterEachDispose) &&
        Boolean(evidence?.addRemoveBalanced) &&
        evidence?.samples?.length === cycles &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0 &&
        externalRequests.length === 0,
    };
  } finally {
    await context.close();
  }
}

/**
 * WebGL context-loss recovery scenario (issue #562, REQ-004). Uses the
 * standard `WEBGL_lose_context` extension to force a deterministic,
 * synchronous loss/restore cycle rather than relying on a real GPU/driver
 * event, which real browsers honor the same way in headless and interactive
 * sessions.
 */
async function runContextLossScenario(browser, baseUrl, { timeoutMs }) {
  const { context, page, pageErrors, consoleErrors, externalRequests } = await instrumentedPage(browser);
  try {
    const url = new URL("lifecycle.html", baseUrl).toString();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__HONUA_DECKGL_LIFECYCLE_HARNESS__), undefined, {
      timeout: SCENARIO_TIMEOUT_MS,
    });
    const evidence = await page.evaluate(async (timeoutMs) => {
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`context-loss recovery did not complete within ${timeoutMs} ms`)), timeoutMs);
      });
      return Promise.race([window.__HONUA_DECKGL_LIFECYCLE_HARNESS__?.runContextLossRecovery(), timeout]);
    }, timeoutMs);
    const recovered = !evidence?.loseContextExtensionAvailable
      ? true // An explicitly reported "cannot exercise this on this device" is itself a pass: bounded, not silent.
      : Boolean(evidence.contextLostFired) &&
        Boolean(evidence.recoveryCompleted) &&
        Boolean(evidence.recoveredRenderOk) &&
        evidence.layerCountAfterRecovery === 1;
    return {
      evidence,
      errors: { page: pageErrors, console: consoleErrors, externalRequests },
      // Console-error is not gated here: Chromium's synthetic WEBGL_lose_context
      // path can legitimately emit a benign GL warning while the context is in
      // its lost state. Page (uncaught) errors and network isolation still gate.
      passed: recovered && pageErrors.length === 0 && externalRequests.length === 0,
    };
  } finally {
    await context.close();
  }
}

/**
 * Turn capability/lifecycle results into report items. These scenarios are
 * boolean invariants over a single deterministic run, not repeated-sample
 * timing distributions, so they bypass `evaluateScenarios`'s percentile/
 * variance machinery entirely.
 */
export function evaluateOperationalScenarios(results, budgets) {
  const items = [];
  for (const result of results) {
    items.push({
      scenarioId: result.id,
      metric: "invariants",
      level: result.passed ? "pass" : "failure",
      message:
        result.evidence?.message ??
        (result.passed
          ? "Every deterministic invariant held for this scenario."
          : "At least one deterministic invariant failed; see the scenario's evidence."),
    });
  }
  const leak = results.find((result) => result.id === "deckgl.lifecycle-repeated-mount-unmount");
  const leakBudget = budgets.lifecycle?.repeatedMountUnmount?.maxHeapGrowthBytes;
  if (leak && leakBudget) {
    const growth = leak.evidence?.heapGrowthBytes;
    items.push(
      growth === null || growth === undefined
        ? {
            scenarioId: leak.id,
            metric: "heapGrowthBytes",
            level: "not-measured",
            message: "performance.memory is unavailable in this browser; heap growth was not measured.",
          }
        : {
            scenarioId: leak.id,
            metric: "heapGrowthBytes",
            level: levelForUpperBound(growth, leakBudget),
            actual: growth,
            warning: leakBudget.warning,
            failure: leakBudget.failure,
            message: `Heap grew ${growth.toLocaleString()} bytes across ${leak.evidence.cycles - leak.evidence.warmupCycles} post-warmup mount/unmount cycles`,
          },
    );
  }
  const contextLoss = results.find((result) => result.id === "deckgl.context-loss-recovery");
  const recoveryBudget = budgets.lifecycle?.contextLossRecovery?.maxRecoveryMs;
  if (contextLoss?.evidence?.loseContextExtensionAvailable && recoveryBudget) {
    items.push({
      scenarioId: contextLoss.id,
      metric: "recoveryMs",
      level: levelForUpperBound(contextLoss.evidence.recoveryMs, recoveryBudget),
      actual: contextLoss.evidence.recoveryMs,
      warning: recoveryBudget.warning,
      failure: recoveryBudget.failure,
      message: `Context-loss recovery took ${contextLoss.evidence.recoveryMs.toFixed(2)} ms`,
    });
  }
  return {
    level: items.some((item) => item.level === "failure")
      ? "failure"
      : items.some((item) => item.level === "warning")
        ? "warning"
        : "pass",
    items,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(REPO_ROOT, options.output);
  const outputDirectory = path.dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const budgetsBytes = await readFile(path.resolve(REPO_ROOT, options.budgets));
  const budgets = JSON.parse(budgetsBytes.toString("utf8"));
  if (budgets.schemaVersion !== 2) throw new Error("Unsupported browser benchmark budget schema");
  const fingerprint = await browserCorpusFingerprint();
  const activeScaleTiers = SCALE_TIERS.filter((tier) => !tier.optIn || INCLUDE_OPT_IN_SCALE_TIERS);

  // The fixture server owns the build so its local basemap/service env is
  // guaranteed to be present; a bare Vite build would silently reach the
  // public demo style and invalidate the offline corpus.
  const quickstart = await startQuickstartFixtureServer({ build: true });
  const vite = await createServer({
    configFile: false,
    root: HERE,
    server: { host: "127.0.0.1", fs: { allow: [REPO_ROOT] } },
    logLevel: "error",
  });
  await vite.listen();
  const deckUrl = vite.resolvedUrls?.local?.[0];
  if (!deckUrl) throw new Error("Could not resolve the local deck.gl benchmark URL");
  const browser = await chromium.launch({
    headless: true,
    // --js-flags=--expose-gc lets the lifecycle harness force a collection
    // between mount/unmount cycles so heap-growth samples are less noisy;
    // it degrades to a no-op check (memoryApiAvailable: false handling) on
    // any engine where it is unavailable.
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl", "--js-flags=--expose-gc"],
  });

  try {
    const [userAgent, timingScenarios, operationalResults] = await Promise.all([
      browser.newPage().then(async (page) => {
        try {
          return await page.evaluate(() => navigator.userAgent);
        } finally {
          await page.close();
        }
      }),
      (async () => [
        await runRepeatedScenario(
          "maplibre.flagship-render-interact",
          (screenshotPath) => runMapLibreSample(browser, quickstart.url, screenshotPath),
          outputDirectory,
        ),
        await runRepeatedScenario(
          "deckgl.binary-render-interact",
          (screenshotPath) => runDeckGlSample(browser, deckUrl, screenshotPath),
          outputDirectory,
        ),
        ...(await (async () => {
          const results = [];
          for (const tier of activeScaleTiers) {
            results.push(
              await runRepeatedScenario(
                tier.id,
                (screenshotPath) => runDeckGlScaleSample(browser, deckUrl, tier, screenshotPath),
                outputDirectory,
              ),
            );
          }
          return results;
        })()),
      ])(),
      (async () => {
        const capabilitySupported = {
          id: "deckgl.capability-supported",
          ...(await runCapabilityScenario(browser, deckUrl, { disableWebGl: false })),
        };
        const capabilityFallback = {
          id: "deckgl.capability-fallback",
          ...(await runCapabilityScenario(browser, deckUrl, { disableWebGl: true })),
        };
        const leak = {
          id: "deckgl.lifecycle-repeated-mount-unmount",
          ...(await runLifecycleLeakScenario(browser, deckUrl, {
            cycles: LEAK_CYCLES,
            warmupCycles: LEAK_WARMUP_CYCLES,
            timeoutMs: LEAK_TIMEOUT_MS,
          })),
        };
        const contextLoss = {
          id: "deckgl.context-loss-recovery",
          ...(await runContextLossScenario(browser, deckUrl, { timeoutMs: CONTEXT_LOSS_TIMEOUT_MS })),
        };
        return { capabilitySupported, capabilityFallback, leak, contextLoss };
      })(),
    ]);
    const { capabilitySupported, capabilityFallback, leak, contextLoss } = operationalResults;
    const operationalScenarioList = [capabilitySupported, capabilityFallback, leak, contextLoss];
    const timingEvaluation = evaluateScenarios(timingScenarios, budgets);
    const operationalEvaluation = evaluateOperationalScenarios(operationalScenarioList, budgets);
    const evaluation = {
      level:
        timingEvaluation.level === "failure" || operationalEvaluation.level === "failure"
          ? "failure"
          : timingEvaluation.level === "warning" || operationalEvaluation.level === "warning"
            ? "warning"
            : "pass",
      items: [...timingEvaluation.items, ...operationalEvaluation.items],
    };
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      methodology: {
        scope: "honua-supported-browser-rendering",
        transport: "deterministic-local-fixtures",
        crossSdkComparable: false,
        note: "These results detect Honua regressions only. They are not evidence for competitor rankings or claims.",
      },
      corpus: {
        id: "honua-browser-render-interact-v2",
        fixtureFiles: fingerprint.files,
        sha256: fingerprint.sha256,
        budgetsSha256: createHash("sha256").update(budgetsBytes).digest("hex"),
        warmupRuns: WARMUP_RUNS,
        measurementRuns: MEASUREMENT_RUNS,
        includesOptInScaleTiers: INCLUDE_OPT_IN_SCALE_TIERS,
        activeScaleTierIds: activeScaleTiers.map((tier) => tier.id),
      },
      environment: {
        implementation: "honua-sdk-js",
        node: process.version,
        browser: "chromium",
        browserVersion: browser.version(),
        userAgent,
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        ci: process.env.CI === "true",
        githubRunnerImage: process.env.ImageOS ?? null,
      },
      // Published for consumption by the #547 analytics golden journey
      // (issue #562, REQ-005): a machine-readable capability/fallback
      // matrix decision for this run, next to the reviewed policy that
      // produced it.
      capabilityMatrix: {
        policy: DECK_GL_CAPABILITY_POLICY,
        decisions: [capabilitySupported, capabilityFallback].map((result) => ({
          scenarioId: result.id,
          tier: result.evidence?.decision?.tier ?? null,
          reasons: result.evidence?.decision?.reasons ?? [],
          facts: result.evidence?.facts ?? null,
        })),
      },
      lifecycle: {
        repeatedMountUnmount: leak.evidence ?? null,
        contextLossRecovery: contextLoss.evidence ?? null,
      },
      scenarios: timingScenarios,
      operational: operationalScenarioList,
      evaluation,
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`Browser benchmark: ${report.evaluation.level}; report ${options.output}\n`);
    for (const scenario of timingScenarios) {
      const stageNote = scenario.stagesSummary
        ? `, gpuUpload ${scenario.stagesSummary.gpuUploadMs.median.toFixed(2)} ms, steadyFps ${scenario.stagesSummary.steadyFrameRateFps.median.toFixed(1)}`
        : "";
      process.stdout.write(
        `  ${scenario.id}: render ${scenario.summary.firstVisibleMs.median.toFixed(2)} ms, interaction ${scenario.summary.interactionLatencyMs.median.toFixed(2)} ms${stageNote}\n`,
      );
    }
    for (const result of operationalScenarioList) {
      process.stdout.write(`  ${result.id}: ${result.passed ? "pass" : "FAILURE"}\n`);
    }
    if (options.check && report.evaluation.level === "failure") process.exitCode = 1;
  } finally {
    await browser.close();
    await vite.close();
    await quickstart.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`browser-benchmark failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
