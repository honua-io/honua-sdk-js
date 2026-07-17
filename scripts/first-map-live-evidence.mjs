#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { build } from "vite";

import { startQuickstartFixtureServer } from "../examples/maplibre-quickstart/mock-server.mjs";
import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const producerPath = "scripts/first-map-live-evidence.mjs";
const sourceEndpoint =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";
const sourceOrigin = new URL(sourceEndpoint).origin;

function outputPath(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new Error("usage: first-map-live-evidence.mjs --output <repository-relative-path>");
  }
  const configured = process.env.HONUA_SAMPLE_LIVE_OUTPUT ?? argv[1];
  const absolute = path.resolve(projectRoot, configured);
  if (!absolute.startsWith(`${projectRoot}${path.sep}`)) throw new Error("live evidence output must stay in the repository");
  return absolute;
}

function sourceRevision() {
  const injected = process.env.HONUA_SAMPLE_SOURCE_REVISION;
  if (/^[a-f0-9]{40}$/.test(injected ?? "")) return injected;
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

function assertEnabled() {
  const enabled = process.env.HONUA_SAMPLE_LIVE_ENABLED === "true" || process.env.HONUA_FIRST_MAP_LIVE_ENABLED === "true";
  if (!enabled) {
    throw new Error("First Map live evidence is network-gated; set HONUA_FIRST_MAP_LIVE_ENABLED=true explicitly.");
  }
  const requestedSample = process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID;
  if (requestedSample && requestedSample !== "maplibre-quickstart") {
    throw new Error(`First Map live evidence cannot satisfy ${requestedSample}`);
  }
}

function containsCredential(request) {
  const url = new URL(request.url());
  const sensitive = ["access_token", "api_key", "apikey", "key", "sig", "token"];
  const queryCredential = sensitive.some((name) => url.searchParams.has(name));
  const headers = request.headers();
  return queryCredential || Boolean(headers.authorization || headers.cookie || headers["x-api-key"]);
}

async function writeEnvelope(target, values) {
  const producerBytes = await readFile(path.join(projectRoot, producerPath));
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const evidence = validateEvidenceEnvelope({
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "maplibre-quickstart",
    lane: "live",
    status: values.status,
    reason: values.reason,
    observedAt: values.observedAt,
    authMode: "anonymous",
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: sourceRevision() },
    source: {
      provider: "esri-living-atlas",
      identity: values.sourceIdentity,
      endpoint: sourceEndpoint,
      deploymentVersion: null,
      dataVersion: null,
    },
    provenance: values.provenance,
    semantics: values.semantics,
    timing: values.timing,
    degradation: values.degradation,
    artifacts: [
      {
        kind: "producer-generator",
        path: producerPath,
        sha256: createHash("sha256").update(producerBytes).digest("hex"),
      },
      ...(values.screenshot
        ? [{ kind: "live-screenshot", path: values.screenshot.path, sha256: values.screenshot.sha256 }]
        : []),
    ],
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function main() {
  assertEnabled();
  const target = outputPath(process.argv.slice(2));
  const staleScreenshotPath = `${target.slice(0, -path.extname(target).length)}.png`;
  await rm(staleScreenshotPath, { force: true });
  const observedAt = new Date().toISOString();
  process.env.VITE_HONUA_QUICKSTART_ENDPOINT = sourceEndpoint;
  process.env.VITE_HONUA_QUICKSTART_PROTOCOL = "geoservices-feature-service";
  process.env.VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT = "5";
  process.env.VITE_HONUA_QUICKSTART_WHERE = "NAME = 'Hawaii'";
  process.env.VITE_HONUA_QUICKSTART_BASEMAP_STYLE = "/__honua-quickstart__/basemap-style.json";

  let fixture;
  let browser;
  let page;
  const rejectedRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await build({ configFile: path.join(projectRoot, "examples/maplibre-quickstart/vite.config.ts"), logLevel: "warn" });
    fixture = await startQuickstartFixtureServer({ build: false });
    const localOrigin = new URL(fixture.url).origin;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const allowed = !/^https?:$/.test(url.protocol) || [localOrigin, sourceOrigin].includes(url.origin);
      if (!allowed || containsCredential(request)) {
        rejectedRequests.push(request.url());
        await route.abort("blockedbyclient");
        return;
      }
      if (url.origin === localOrigin && request.resourceType() === "document") {
        const response = await route.fetch();
        const headers = response.headers();
        headers["content-security-policy"] = (headers["content-security-policy"] ?? "").replace(
          "connect-src 'self'",
          `connect-src 'self' ${sourceOrigin}`,
        );
        await route.fulfill({ response, headers });
        return;
      }
      await route.continue();
    });

    await page.goto(fixture.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => window.__HONUA_QUICKSTART_RUNTIME__?.journeyComplete === true, undefined, {
      timeout: 60_000,
    });
    const runtime = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    const presentation = await page.evaluate(() => ({
      mode: document.querySelector("#mode-badge")?.textContent?.trim(),
      source: document.querySelector("#evidence-source")?.textContent?.trim(),
      freshness: document.querySelector("#evidence-freshness")?.textContent?.trim(),
      cache: document.querySelector("#evidence-cache")?.textContent?.trim(),
      degradation: document.querySelector("#evidence-degradation")?.textContent?.trim(),
      popup: document.querySelector(".maplibregl-popup")?.textContent?.trim(),
    }));
    if (
      runtime?.mode !== "public-live" ||
      runtime.authorizationMode !== "anonymous" ||
      runtime.sourceProtocol !== "geoservices-feature-service" ||
      runtime.sourceId !== "0" ||
      typeof runtime.sourceAttribution !== "string" ||
      runtime.sourceAttribution.length === 0 ||
      typeof runtime.sourceObservedAt !== "string" ||
      runtime.sourceFreshness !== "observed" ||
      !["bypass", "hit", "miss", "refreshed"].includes(runtime.cacheStatus) ||
      !Array.isArray(runtime.degradation) ||
      runtime.featureCount < 1 ||
      runtime.mapReady !== true ||
      runtime.journeyComplete !== true ||
      !runtime.planFingerprint?.startsWith("sha256:") ||
      !presentation.popup ||
      !presentation.source?.includes(runtime.sourceAttribution) ||
      presentation.freshness !== "SDK observation available" ||
      presentation.cache !== runtime.cacheStatus ||
      !presentation.degradation ||
      rejectedRequests.length > 0 ||
      pageErrors.length > 0 ||
      consoleErrors.length > 0
    ) {
      throw new Error("canonical anonymous-live First Map assertions failed");
    }

    const screenshotPath = staleScreenshotPath;
    await page.screenshot({ path: screenshotPath, animations: "disabled", fullPage: false });
    const screenshotBytes = await readFile(screenshotPath);
    await page.evaluate(async () => await window.__HONUA_QUICKSTART_DISPOSE__?.());
    const cleanup = await page.evaluate(() => window.__HONUA_QUICKSTART_RUNTIME__);
    if (cleanup?.disposed !== true || cleanup.cleanupBudgetMet !== true) throw new Error("First Map cleanup evidence failed");

    const degradationReasons = runtime.degradation ?? [];
    await writeEnvelope(target, {
      status: "executed",
      reason: null,
      observedAt,
      sourceIdentity: `${runtime.sourceProtocol}:${runtime.sourceId}`,
      sourceObservedAt: runtime.sourceObservedAt,
      provenance: {
        sourceId: `${runtime.sourceProtocol}:${runtime.sourceId}`,
        observedAt: runtime.sourceObservedAt ?? observedAt,
        validAt: null,
        state: "live",
        attribution: runtime.sourceAttribution ?? "No attribution was advertised by the endpoint metadata.",
      },
      semantics: {
        operation: "first-map-anonymous-public-endpoint",
        outcome: "map-popup-filter-plan-ready",
        itemCount: runtime.featureCount,
        assertions: [
          `protocol=${JSON.stringify(runtime.sourceProtocol)}`,
          `sourceId=${JSON.stringify(runtime.sourceId)}`,
          `attribution=${JSON.stringify(runtime.sourceAttribution ?? null)}`,
          `freshness=${JSON.stringify(runtime.sourceFreshness)}`,
          `cacheStatus=${JSON.stringify(runtime.cacheStatus)}`,
          `degradationCount=${degradationReasons.length}`,
          `planFingerprint=${JSON.stringify(runtime.planFingerprint)}`,
          `mode=${JSON.stringify(presentation.mode)}`,
          "credentialsSent=false",
          "unexpectedNetworkRequests=0",
          "cleanupBudgetMet=true",
        ],
      },
      timing: {
        totalMs: runtime.firstMapDurationMs,
        firstSuccessfulInteractionMs: runtime.firstMapDurationMs,
      },
      degradation: {
        state: degradationReasons.length === 0 ? "none" : "expected",
        reasons: degradationReasons,
      },
      screenshot: {
        path: path.relative(projectRoot, screenshotPath).replaceAll(path.sep, "/"),
        sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
      },
    });
    process.stdout.write(
      `firstMapLiveEvidence=ok source=${runtime.sourceProtocol}:${runtime.sourceId} features=${runtime.featureCount} cache=${runtime.cacheStatus}\n`,
    );
  } catch (error) {
    const browserState = page && !page.isClosed()
      ? await page.evaluate(() => ({
          runtime: window.__HONUA_QUICKSTART_RUNTIME__,
          status: document.querySelector("#status-error")?.textContent?.trim(),
          overlay: document.querySelector("#map-overlay")?.textContent?.trim(),
        }))
      : null;
    const failureDetail = [
      error instanceof Error ? error.message : String(error),
      browserState ? `browserState=${JSON.stringify(browserState)}` : null,
      pageErrors.length > 0 ? `pageErrors=${JSON.stringify(pageErrors)}` : null,
      rejectedRequests.length > 0 ? `rejectedRequests=${JSON.stringify(rejectedRequests)}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    await writeEnvelope(target, {
      status: "failed",
      reason: failureDetail,
      observedAt,
      sourceIdentity: "geoservices-feature-service:unresolved",
      sourceObservedAt: null,
      provenance: null,
      semantics: {
        operation: "first-map-anonymous-public-endpoint",
        outcome: null,
        itemCount: null,
        assertions: [],
      },
      timing: { totalMs: null, firstSuccessfulInteractionMs: null },
      degradation: { state: "unexpected", reasons: ["anonymous-live-first-map-failed"] },
    });
    throw error;
  } finally {
    if (page && !page.isClosed()) await page.close();
    await browser?.close();
    await fixture?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`First Map live evidence failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
