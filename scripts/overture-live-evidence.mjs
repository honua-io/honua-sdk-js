#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

import { startOvertureFixtureServer } from "../examples/overture-geoparquet/mock-server.mjs";
import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const MAX_OBSERVED_RANGE_BYTES = 32 * 1024 * 1024;
const OVERTURE_OBJECT_ORIGIN = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com";

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

function parseRequestRange(value) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? { start, end } : null;
}

function parseResponseRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total ? { start, end, total } : null;
}

/**
 * @typedef {object} OvertureTrafficEntry
 * @property {string} method
 * @property {string | null} range
 * @property {number | null} status
 * @property {string | null} contentRange
 * @property {string | null} contentLength
 * @property {boolean} [hasCredentials]
 * @property {boolean} [hasCredentialQuery]
 */

/**
 * @param {readonly OvertureTrafficEntry[]} entries
 * @param {number} objectBytes
 * @param {number} [maxObservedBytes]
 */
export function summarizeOvertureRangeTraffic(entries, objectBytes, maxObservedBytes = MAX_OBSERVED_RANGE_BYTES) {
  const gets = entries.filter((entry) => entry.method === "GET");
  const credentialed = entries.filter((entry) => entry.hasCredentials || entry.hasCredentialQuery);
  if (credentialed.length > 0) {
    throw new Error(`Observed ${credentialed.length} credential-bearing Overture request(s); live evidence is rejected.`);
  }
  const unboundedGets = gets.filter((entry) => !entry.range);
  if (unboundedGets.length > 0) {
    throw new Error(`Observed ${unboundedGets.length} unbounded Overture GET request(s); live evidence is rejected.`);
  }
  let observedBytes = 0;
  for (const entry of gets) {
    const requested = parseRequestRange(entry.range);
    const returned = parseResponseRange(entry.contentRange);
    const responseBytes = Number(entry.contentLength);
    if (
      !requested ||
      !returned ||
      entry.status !== 206 ||
      !Number.isSafeInteger(responseBytes) ||
      returned.total !== objectBytes ||
      returned.start < requested.start ||
      returned.end > requested.end ||
      responseBytes !== returned.end - returned.start + 1
    ) {
      throw new Error(`Invalid Overture range response for ${entry.range ?? "missing range"}.`);
    }
    observedBytes += responseBytes;
  }
  if (observedBytes >= objectBytes) {
    throw new Error(`Observed ${observedBytes} ranged bytes, which does not prove bounded I/O below the object size.`);
  }
  if (observedBytes > maxObservedBytes) {
    throw new Error(`Observed ${observedBytes} ranged bytes, exceeding the ${maxObservedBytes}-byte evidence budget.`);
  }
  const preflightRemaining = new Map([
    ["bytes=0-0", 1],
    [`bytes=${Math.max(0, objectBytes - 65_536)}-${objectBytes - 1}`, 1],
  ]);
  const engine = gets.filter((entry) => {
    const remaining = preflightRemaining.get(entry.range) ?? 0;
    if (remaining === 0) return true;
    preflightRemaining.set(entry.range, remaining - 1);
    return false;
  });
  return {
    observedRequests: gets.length,
    observedBytes,
    engineRequests: engine.length,
    engineBytes: engine.reduce((total, entry) => total + Number(entry.contentLength), 0),
    byteBudget: maxObservedBytes,
    unboundedGets: 0,
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
    const traffic = [];
    const trafficByRequest = new Map();
    const trafficTasks = [];
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.origin !== OVERTURE_OBJECT_ORIGIN) return;
      const entry = {
        url: requestUrl.href,
        method: request.method(),
        range: null,
        hasCredentials: false,
        hasCredentialQuery: requestUrl.username !== "" || requestUrl.password !== "" || requestUrl.search !== "",
        status: null,
        contentRange: null,
        contentLength: null,
      };
      traffic.push(entry);
      trafficByRequest.set(request, entry);
      trafficTasks.push(
        request.allHeaders().then((headers) => {
          entry.range = headers.range ?? null;
          entry.hasCredentials = Boolean(headers.authorization || headers.cookie);
        }),
      );
    });
    page.on("response", (response) => {
      const entry = trafficByRequest.get(response.request());
      if (!entry) return;
      trafficTasks.push(
        response.allHeaders().then((headers) => {
          entry.status = response.status();
          entry.contentRange = headers["content-range"] ?? null;
          entry.contentLength = headers["content-length"] ?? null;
        }),
      );
    });
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
    await Promise.all(trafficTasks);
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
              "engine-row-group-metrics=opaque",
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
    const rangeTraffic = summarizeOvertureRangeTraffic(traffic, object.bytes);
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
        outcome: "bounded-range-result-engine-pruning-unverified",
        itemCount: evidence.rowsReturned,
        assertions: [
          `files-selected=${evidence.plan.filesSelected}/${evidence.plan.filesAvailable}`,
          `verified-probe-bytes=${evidence.range.bytes}`,
          `verified-probe-ranges=${evidence.range.ranges}`,
          `object-row-groups=${evidence.plan.selectedObjectRowGroups}`,
          `observed-http-range-requests=${rangeTraffic.observedRequests}`,
          `observed-http-range-bytes=${rangeTraffic.observedBytes}`,
          `observed-engine-range-requests=${rangeTraffic.engineRequests}`,
          `observed-engine-range-bytes=${rangeTraffic.engineBytes}`,
          `observed-http-range-byte-budget=${rangeTraffic.byteBudget}`,
          "unbounded-http-gets=0",
          "duckdb-full-http-fallback=disabled",
          "rows-scanned=not-exposed",
          "row-groups-pruned=not-exposed",
        ],
      },
      timing: {
        totalMs: evidence.timing.totalMs,
        firstSuccessfulInteractionMs: evidence.timing.sdkPlanMs + evidence.timing.sourceProbeMs,
      },
      degradation: {
        state: "expected",
        reasons: [
          "Playwright observed exact HTTP range requests and response bytes; DuckDB does not expose rows scanned or a row-group-pruned counter.",
        ],
      },
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
