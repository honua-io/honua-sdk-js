#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = "test-results/quickstart-time-to-map.json";
export const QUICKSTART_BUDGET_MS = 300_000;
export const QUICKSTART_STAGES = ["connect", "discover", "explain", "query", "mount"];

function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

export function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, startedAtMonotonicMs: undefined, mode: "run", failureStage: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--output" && value) {
      options.output = value;
      index += 1;
      continue;
    }
    if (flag === "--started-at-monotonic-ms" && value) {
      options.startedAtMonotonicMs = positiveNumber(value, flag);
      index += 1;
      continue;
    }
    if (flag === "--initialize") {
      options.mode = "initialize";
      continue;
    }
    if (flag === "--finalize-failure" && value) {
      options.mode = "finalize-failure";
      options.failureStage = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  return options;
}

export function validateQuickstartEvidence(evidence) {
  const failures = [];
  if (evidence.format !== "honua.sdk.quickstart-time-to-map.v1") failures.push("format is invalid");
  if (evidence.measurement?.budgetMs !== QUICKSTART_BUDGET_MS) failures.push("budget must be 300000ms");
  if (!Number.isFinite(evidence.measurement?.elapsedMs) || evidence.measurement.elapsedMs < 0) {
    failures.push("elapsedMs must be a non-negative finite number");
  }
  const expectedWithinBudget =
    Number.isFinite(evidence.measurement?.elapsedMs) && evidence.measurement.elapsedMs <= QUICKSTART_BUDGET_MS;
  if (evidence.measurement?.withinBudget !== expectedWithinBudget) {
    failures.push("withinBudget must be derived from elapsedMs and budgetMs");
  }
  if (typeof evidence.measurement?.cleanInstallIncluded !== "boolean") {
    failures.push("cleanInstallIncluded must be boolean");
  }
  const expectedScope = evidence.measurement?.cleanInstallIncluded ? "clean-install-to-first-map" : "script-to-first-map";
  if (evidence.measurement?.scope !== expectedScope) failures.push(`scope must be ${expectedScope}`);
  for (const field of ["node", "sdkPackage", "sdkVersion", "revision", "ciRevision"]) {
    if (typeof evidence.environment?.[field] !== "string" || evidence.environment[field].length === 0) {
      failures.push(`environment.${field} is required`);
    }
  }
  if (evidence.status === "passed") {
    if (!expectedWithinBudget) failures.push("passed evidence must be within budget");
    if (evidence.journey?.mode !== "fixture") failures.push("passed evidence must use fixture mode");
    if (evidence.journey?.journeyComplete !== true) failures.push("journey must be complete");
    if (evidence.journey?.mountedCanvas !== true) failures.push("MapLibre canvas must be mounted");
    if (!(evidence.journey?.renderableFeatureCount > 0)) failures.push("a renderable feature is required");
    if (JSON.stringify(evidence.journey?.completedStages) !== JSON.stringify(QUICKSTART_STAGES)) {
      failures.push("all five journey stages must complete in order");
    }
  } else if (evidence.status === "failed") {
    if (typeof evidence.failure?.message !== "string" || evidence.failure.message.length === 0) {
      failures.push("failed evidence must include a failure message");
    }
  } else {
    failures.push("status must be passed or failed");
  }
  if (failures.length > 0) throw new Error(`quickstart evidence validation failed: ${failures.join("; ")}`);
  return evidence;
}

function revision() {
  if (process.env.HONUA_SOURCE_REVISION) return process.env.HONUA_SOURCE_REVISION;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function writeEvidence(output, evidence) {
  const absolute = path.resolve(ROOT, output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(evidence, null, 2)}\n`);
  return absolute;
}

function remainingBudgetMs(startedAt) {
  return Math.max(1, QUICKSTART_BUDGET_MS - Math.max(0, os.uptime() * 1000 - startedAt));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${timeoutMs}ms budget.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function withinRemainingBudget(promise, startedAt, label) {
  return withTimeout(promise, remainingBudgetMs(startedAt), label);
}

function createBaseEvidence(startedAt, cleanInstallIncluded) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return {
    format: "honua.sdk.quickstart-time-to-map.v1",
    status: "failed",
    measurement: {
      scope: cleanInstallIncluded ? "clean-install-to-first-map" : "script-to-first-map",
      cleanInstallIncluded,
      budgetMs: QUICKSTART_BUDGET_MS,
      elapsedMs: 0,
      withinBudget: true,
    },
    journey: {
      mode: "fixture",
      journeyComplete: false,
      completedStages: [],
      mountedCanvas: false,
      renderableFeatureCount: 0,
    },
    environment: {
      node: process.version,
      sdkPackage: packageJson.name,
      sdkVersion: packageJson.version,
      revision: revision(),
      ciRevision: process.env.GITHUB_SHA ?? revision(),
    },
    failure: { stage: "initialized", message: "Timing lane did not reach the first-map runner." },
  };
}

export function initializeEvidence(options) {
  if (options.startedAtMonotonicMs === undefined) throw new Error("initialization requires a monotonic start");
  return writeEvidence(options.output, createBaseEvidence(options.startedAtMonotonicMs, true));
}

export function finalizeFailureEvidence(options) {
  if (options.startedAtMonotonicMs === undefined) throw new Error("failure finalization requires a monotonic start");
  const elapsedMs = Math.max(0, Math.round(os.uptime() * 1000 - options.startedAtMonotonicMs));
  const evidence = createBaseEvidence(options.startedAtMonotonicMs, true);
  evidence.measurement.elapsedMs = elapsedMs;
  evidence.measurement.withinBudget = elapsedMs <= QUICKSTART_BUDGET_MS;
  evidence.failure = {
    stage: options.failureStage ?? "unknown",
    message: `Quickstart timing lane failed during ${options.failureStage ?? "an unknown stage"}.`,
  };
  validateQuickstartEvidence(evidence);
  return writeEvidence(options.output, evidence);
}

export async function runQuickstartTiming(options) {
  const now = os.uptime() * 1000;
  const startedAt = options.startedAtMonotonicMs ?? now;
  if (startedAt > now + 2_000) throw new Error("--started-at-monotonic-ms cannot be in the future");

  const cleanInstallIncluded = options.startedAtMonotonicMs !== undefined;
  const base = createBaseEvidence(startedAt, cleanInstallIncluded);

  let fixtureServer;
  let browser;
  let evidence = base;
  writeEvidence(options.output, evidence);
  try {
    const [{ chromium }, { startQuickstartFixtureServer }] = await withinRemainingBudget(
      Promise.all([import("@playwright/test"), import("../examples/maplibre-quickstart/mock-server.mjs")]),
      startedAt,
      "Quickstart runtime import",
    );
    fixtureServer = await withinRemainingBudget(
      startQuickstartFixtureServer({ buildTimeoutMs: remainingBudgetMs(startedAt) }),
      startedAt,
      "Quickstart fixture server",
    );
    browser = await chromium.launch({
      headless: true,
      timeout: remainingBudgetMs(startedAt),
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const page = await withinRemainingBudget(browser.newPage(), startedAt, "Quickstart browser page");
    await page.goto(fixtureServer.url, { timeout: remainingBudgetMs(startedAt) });
    await page.waitForFunction(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true, undefined, {
      timeout: remainingBudgetMs(startedAt),
    });

    const journey = await withinRemainingBudget(
      page.evaluate((stages) => {
        const runtime = window.__HONUA_QUICKSTART_RUNTIME__;
        return {
          mode: document.querySelector("#mode-badge")?.getAttribute("data-mode") ?? "unknown",
          journeyComplete: runtime?.journeyComplete === true,
          completedStages: stages.filter(
            (stage) => document.querySelector(`#journey-${stage}`)?.getAttribute("data-state") === "complete",
          ),
          mountedCanvas: document.querySelector(".maplibregl-canvas") !== null,
          renderableFeatureCount: Number(document.querySelector("#linked-visible-count")?.textContent ?? 0),
        };
      }, QUICKSTART_STAGES),
      startedAt,
      "Quickstart evidence capture",
    );
    const elapsedMs = Math.max(0, Math.round(os.uptime() * 1000 - startedAt));
    evidence = {
      ...base,
      status: elapsedMs <= QUICKSTART_BUDGET_MS ? "passed" : "failed",
      measurement: {
        ...base.measurement,
        elapsedMs,
        withinBudget: elapsedMs <= QUICKSTART_BUDGET_MS,
      },
      journey,
    };
    delete evidence.failure;
    validateQuickstartEvidence(evidence);
  } catch (error) {
    const elapsedMs = Math.max(0, Math.round(os.uptime() * 1000 - startedAt));
    evidence = {
      ...evidence,
      status: "failed",
      measurement: {
        ...evidence.measurement,
        elapsedMs,
        withinBudget: elapsedMs <= QUICKSTART_BUDGET_MS,
      },
      failure: { message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    await Promise.allSettled([
      browser ? withTimeout(browser.close(), 2_000, "Browser cleanup") : Promise.resolve(),
      fixtureServer ? withTimeout(fixtureServer.close(), 2_000, "Fixture cleanup") : Promise.resolve(),
    ]);
  }

  const output = writeEvidence(options.output, evidence);
  process.stdout.write(`${JSON.stringify({ output, status: evidence.status, elapsedMs: evidence.measurement.elapsedMs })}\n`);
  if (evidence.status !== "passed") throw new Error(evidence.failure?.message ?? "Quickstart exceeded its time budget");
  return evidence;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === "initialize") {
      process.stdout.write(`${JSON.stringify({ output: initializeEvidence(options), status: "initialized" })}\n`);
    } else if (options.mode === "finalize-failure") {
      process.stdout.write(`${JSON.stringify({ output: finalizeFailureEvidence(options), status: "failed" })}\n`);
    } else {
      await runQuickstartTiming(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
