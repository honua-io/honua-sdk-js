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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_BUDGETS = path.join(HERE, "budgets.json");
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const WARMUP_RUNS = 1;
const MEASUREMENT_RUNS = 3;

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function corpusFingerprint() {
  const files = [
    "bench/browser/main.ts",
    "examples/maplibre-quickstart/src/main.ts",
    "test/fixtures/honua-quickstart-demo/capabilities.json",
    "test/fixtures/honua-quickstart-demo/layer-metadata.json",
    "test/fixtures/honua-quickstart-demo/query-features.json",
  ];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(REPO_ROOT, file)));
    hash.update("\0");
  }
  return { files, sha256: hash.digest("hex") };
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
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__HONUA_BROWSER_BENCH_STARTED__ = performance.now();
  });
  return { context, page, pageErrors, consoleErrors };
}

async function runMapLibreSample(browser, url, screenshotPath) {
  const { context, page, pageErrors, consoleErrors } = await instrumentedPage(browser);
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
      button.click();
      while (window.__HONUA_QUICKSTART_RUNTIME__?.selectedFeatureId !== "2") {
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
      errors: { page: pageErrors, console: consoleErrors },
      passed:
        visible &&
        layerCount > 0 &&
        interaction.selectedFeatureId === "2" &&
        interaction.popupOpen &&
        screenshot.bytes > 5_000 &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0,
    };
  } finally {
    await context.close();
  }
}

async function runDeckGlSample(browser, url, screenshotPath) {
  const { context, page, pageErrors, consoleErrors } = await instrumentedPage(browser);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__HONUA_BROWSER_BENCHMARK__), undefined, { timeout: 20_000 });
    const ready = await page.evaluate(() => window.__HONUA_BROWSER_BENCHMARK__?.ready);
    if (!ready) throw new Error("deck.gl benchmark did not expose ready evidence");
    const interaction = await page.evaluate(() => window.__HONUA_BROWSER_BENCHMARK__?.runInteraction());
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
      errors: { page: pageErrors, console: consoleErrors },
      passed:
        visible &&
        ready.rows === 10_000 &&
        ready.copiedBytes === 0 &&
        ready.pickableAtCenter &&
        interaction.selectedFeatureId === 104_949 &&
        interaction.visibleOutcome === "Selected feature 104949" &&
        screenshot.bytes > 5_000 &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0,
    };
  } finally {
    await context.close();
  }
}

async function runRepeatedScenario(id, runSample, outputDirectory) {
  for (let run = 0; run < WARMUP_RUNS; run += 1) {
    await runSample(path.join(outputDirectory, `${id}.warmup-${run + 1}.png`));
  }
  const samples = [];
  for (let run = 0; run < MEASUREMENT_RUNS; run += 1) {
    samples.push(await runSample(path.join(outputDirectory, `${id}.sample-${run + 1}.png`)));
  }
  return {
    id,
    warmupRuns: WARMUP_RUNS,
    measurementRuns: MEASUREMENT_RUNS,
    samples,
    summary: {
      firstVisibleMs: summarize(samples.map((sample) => sample.firstVisibleMs)),
      interactionLatencyMs: summarize(samples.map((sample) => sample.interactionLatencyMs)),
    },
    invariants: { passed: samples.every((sample) => sample.passed) },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(REPO_ROOT, options.output);
  const outputDirectory = path.dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const budgetsBytes = await readFile(path.resolve(REPO_ROOT, options.budgets));
  const budgets = JSON.parse(budgetsBytes.toString("utf8"));
  if (budgets.schemaVersion !== 1) throw new Error("Unsupported browser benchmark budget schema");
  const fingerprint = await corpusFingerprint();

  const quickstart = await startQuickstartFixtureServer({ build: false });
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
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"],
  });

  try {
    const [userAgent, scenarios] = await Promise.all([
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
      ])(),
    ]);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      methodology: {
        scope: "honua-supported-browser-rendering",
        transport: "deterministic-local-fixtures",
        crossSdkComparable: false,
        note: "These results detect Honua regressions only. They are not evidence for competitor rankings or claims.",
      },
      corpus: {
        id: "honua-browser-render-interact-v1",
        fixtureFiles: fingerprint.files,
        sha256: fingerprint.sha256,
        budgetsSha256: createHash("sha256").update(budgetsBytes).digest("hex"),
        warmupRuns: WARMUP_RUNS,
        measurementRuns: MEASUREMENT_RUNS,
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
      scenarios,
      evaluation: evaluateScenarios(scenarios, budgets),
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`Browser benchmark: ${report.evaluation.level}; report ${options.output}\n`);
    for (const scenario of scenarios) {
      process.stdout.write(
        `  ${scenario.id}: render ${scenario.summary.firstVisibleMs.median.toFixed(2)} ms, interaction ${scenario.summary.interactionLatencyMs.median.toFixed(2)} ms\n`,
      );
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
