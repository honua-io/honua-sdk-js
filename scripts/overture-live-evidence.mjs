#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

import { startOvertureFixtureServer } from "../examples/overture-geoparquet/mock-server.mjs";
import { validateEvidenceEnvelope } from "./sample-contract.mjs";

function parseArgs(argv) {
  const options = { output: "test-results/overture-live-evidence.json", strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") options.output = argv[++index] ?? "";
    else if (arg === "--strict") options.strict = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.output) throw new Error("--output must not be empty");
  return options;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function emptyEnvelope(packageJson, observedAt, reason) {
  return {
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "overture-geoparquet",
    lane: "live",
    status: "failed",
    reason,
    observedAt,
    authMode: "anonymous",
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: gitCommit() },
    source: {
      provider: "overture-aws-open-data",
      identity: "2026-06-17.0:places:place:00000",
      endpoint: "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/",
      deploymentVersion: "2026-06-17.0",
      dataVersion: "v1.17.0",
    },
    provenance: null,
    semantics: { operation: "bounded-aoi-columnar-query", outcome: null, itemCount: null, assertions: [] },
    timing: { totalMs: null, firstSuccessfulInteractionMs: null },
    degradation: { state: "unexpected", reasons: [reason] },
    artifacts: [],
  };
}

export async function collectOvertureLiveEvidence() {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const observedAt = new Date().toISOString();
  if (process.env.HONUA_OVERTURE_LIVE_ENABLED !== "true") {
    const skipped = emptyEnvelope(
      packageJson,
      observedAt,
      "HONUA_OVERTURE_LIVE_ENABLED is not true; AWS execution is opt-in.",
    );
    return validateEvidenceEnvelope({
      ...skipped,
      status: "skipped",
      degradation: { state: "unavailable", reasons: [skipped.reason] },
    });
  }

  const server = await startOvertureFixtureServer({ build: false });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(`${server.url}/?lane=live`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => ["completed", "failed", "rejected", "cancelled"].includes(window.__HONUA_OVERTURE__?.status ?? ""),
      undefined,
      { timeout: 180_000 },
    );
    const runtime = await page.evaluate(() => window.__HONUA_OVERTURE__);
    if (runtime?.status !== "completed" || !runtime.lastEvidence) {
      const message = await page.locator("#query-message").textContent();
      const reason = message || `Browser workflow ended in ${runtime?.status ?? "unknown"}.`;
      if (runtime?.lastEvidence) {
        const failed = runtime.lastEvidence;
        const object = failed.plan.selectedObjects[0];
        return validateEvidenceEnvelope({
          ...emptyEnvelope(packageJson, failed.range.observedAt, reason),
          source: {
            provider: "overture-aws-open-data",
            identity: object.objectKey,
            endpoint: object.url,
            deploymentVersion: "2026-06-17.0",
            dataVersion: "v1.17.0",
          },
          provenance: {
            sourceId: "overture:2026-06-17.0:places:place:00000",
            observedAt: failed.range.observedAt,
            validAt: failed.range.lastModified,
            state: "live",
            attribution: "Overture Maps Foundation Open Map Data, accessed from the Registry of Open Data on AWS.",
          },
          semantics: {
            operation: "bounded-aoi-columnar-query",
            outcome: null,
            itemCount: null,
            assertions: [
              `files-selected=${failed.plan.filesSelected}/${failed.plan.filesAvailable}`,
              `verified-probe-bytes=${failed.range.bytes}`,
              `verified-probe-ranges=${failed.range.ranges}`,
              "engine-budget=exceeded",
              "application-full-download-fallback=absent",
              "engine-transport=opaque",
            ],
          },
          timing: {
            totalMs: failed.timing.totalMs,
            firstSuccessfulInteractionMs: failed.timing.sdkPlanMs + failed.timing.sourceProbeMs,
          },
        });
      }
      throw new Error(reason);
    }
    if (consoleErrors.length > 0) throw new Error(`Browser console errors: ${consoleErrors.join(" | ")}`);
    const evidence = runtime.lastEvidence;
    if (evidence.range.status !== "verified" || !evidence.range.acceptRanges) {
      throw new Error("AWS object did not prove HTTP range support.");
    }
    if (evidence.rowsReturned > evidence.plan.limit) throw new Error("Live result exceeded the planned row limit.");
    const object = evidence.plan.selectedObjects[0];
    return validateEvidenceEnvelope({
      format: "honua.sdk.sample-evidence.v1",
      schemaVersion: 1,
      sampleId: "overture-geoparquet",
      lane: "live",
      status: "executed",
      reason: null,
      observedAt: evidence.range.observedAt,
      authMode: "anonymous",
      sdk: { package: packageJson.name, version: packageJson.version, gitCommit: gitCommit() },
      source: {
        provider: "overture-aws-open-data",
        identity: object.objectKey,
        endpoint: object.url,
        deploymentVersion: "2026-06-17.0",
        dataVersion: "v1.17.0",
      },
      provenance: {
        sourceId: "overture:2026-06-17.0:places:place:00000",
        observedAt: evidence.range.observedAt,
        validAt: evidence.range.lastModified,
        state: "live",
        attribution: "Overture Maps Foundation Open Map Data, accessed from the Registry of Open Data on AWS.",
      },
      semantics: {
        operation: "bounded-aoi-columnar-query",
        outcome: "bounded-result-engine-transport-opaque",
        itemCount: evidence.rowsReturned,
        assertions: [
          `files-selected=${evidence.plan.filesSelected}/${evidence.plan.filesAvailable}`,
          `verified-probe-bytes=${evidence.range.bytes}`,
          `verified-probe-ranges=${evidence.range.ranges}`,
          `candidate-row-groups=${evidence.plan.candidateRowGroups}`,
          "engine-ranges=not-exposed",
          "rows-scanned=not-exposed",
          "row-groups-pruned=not-exposed",
        ],
      },
      timing: {
        totalMs: evidence.timing.totalMs,
        firstSuccessfulInteractionMs: evidence.timing.sdkPlanMs + evidence.timing.sourceProbeMs,
      },
      degradation: { state: "expected", reasons: [evidence.range.limitation] },
      artifacts: [],
    });
  } catch (error) {
    return validateEvidenceEnvelope(
      emptyEnvelope(packageJson, new Date().toISOString(), error instanceof Error ? error.message : String(error)),
    );
  } finally {
    await browser.close();
    await server.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await collectOvertureLiveEvidence();
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`Overture live evidence: ${evidence.status}; ${options.output}\n`);
  if (options.strict && evidence.status !== "executed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
