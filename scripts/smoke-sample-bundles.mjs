#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  PUBLISHED_LIVE_SAMPLE_POLICY,
  SAMPLE_BUNDLE_STATIC_SMOKE_JOURNEYS,
} from "./build-sample-bundles.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = path.join(projectRoot, ".artifacts", "sample-bundles");
const manifestPath = path.join(bundleRoot, "sample-bundles.v2.json");
const evidenceDir = path.join(projectRoot, ".artifacts", "sample-bundle-smoke");
const evidencePath = path.join(evidenceDir, "browser-smoke.v1.json");

const hostedSmokeHostname = "samples.honua.test";

const mediaTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pmtiles", "application/vnd.pmtiles"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
]);

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const samples = manifest.samples.filter((sample) =>
    ["standalone", "requires-live-endpoint"].includes(sample.runnability),
  );
  if (samples.length === 0) throw new Error("sample bundle smoke found no directly runnable samples");
  for (const [id] of PUBLISHED_LIVE_SAMPLE_POLICY) {
    const sample = samples.find((candidate) => candidate.id === id);
    if (!sample || sample.runtimeHosting !== "external-live-endpoint" || sample.runnability !== "requires-live-endpoint") {
      throw new Error(`${id}: live publication policy is missing from the built manifest`);
    }
  }

  await mkdir(evidenceDir, { recursive: true });
  const server = createStaticServer(new Set(samples.map((sample) => sample.id)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sample bundle smoke server has no TCP address");
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const hostedOrigin = `http://${hostedSmokeHostname}:${address.port}`;

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${hostedSmokeHostname} 127.0.0.1`],
  });
  const results = [];
  try {
    for (const sample of samples) {
      const origin = sample.id === "service-explorer" ? hostedOrigin : localOrigin;
      results.push(await smokeSample(browser, origin, sample));
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  const receipt = {
    format: "honua.sdk.sample-bundle-browser-smoke.v1",
    generatedAt: new Date().toISOString(),
    manifest: {
      format: manifest.format,
      schemaVersion: manifest.schemaVersion,
      commit: samples[0]?.builtFrom?.commit ?? null,
    },
    summary: {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
    },
    results,
  };
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(receipt.summary)}\n`);
  for (const result of results) {
    process.stdout.write(`${result.passed ? "PASS" : "FAIL"} ${result.id} ${result.title}\n`);
    for (const failure of result.failures) process.stdout.write(`  ${failure}\n`);
  }
  if (receipt.summary.failed > 0) process.exitCode = 1;
}

async function smokeSample(browser, origin, sample) {
  const page = await browser.newPage();
  const failures = [];
  const observedRequests = new Set();
  const requestedUrls = new Set();
  const requestCounts = new Map();
  const offOriginRequests = new Set();
  const clientErrorResponses = new Set();
  const livePolicy = PUBLISHED_LIVE_SAMPLE_POLICY.get(sample.id);
  const allowedOrigins = new Set(livePolicy?.allowedOrigins ?? []);
  const liveProbe = await runSemanticLiveProbe(sample.id, livePolicy);
  if (liveProbe && !liveProbe.passed) failures.push(`live probe: ${liveProbe.failure}`);
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    requestedUrls.add(request.url());
    requestCounts.set(request.url(), (requestCounts.get(request.url()) ?? 0) + 1);
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin && !allowedOrigins.has(url.origin)) {
      offOriginRequests.add(`${request.method()} ${request.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "";
    // Chromium reports the DuckDB-WASM feature-selection cancellation as an
    // aborted request after the usable worker variant has already loaded.
    if (
      sample.id === "overture-geoparquet" &&
      errorText === "net::ERR_ABORTED" &&
      /duckdb|eh\.wasm|mvp\.wasm/u.test(request.url())
    ) {
      return;
    }
    failures.push(`requestfailed: ${request.method()} ${request.url()} ${errorText}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin && !allowedOrigins.has(url.origin)) {
      failures.push(`off-origin response: ${response.status()} ${response.request().method()} ${response.url()}`);
    }
    if (response.status() >= 400 && url.pathname !== "/favicon.ico") {
      failures.push(`response: ${response.status()} ${response.request().method()} ${response.url()}`);
    }
    if (response.status() >= 400 && response.status() < 500) {
      clientErrorResponses.add(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
    observedRequests.add(url.pathname);
  });

  let title = "";
  let screenshot = null;
  let staticJourney = null;
  try {
    const response = await page.goto(`${origin}/sdk/${sample.id}/app/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!response || response.status() !== 200) failures.push(`navigation status: ${response?.status() ?? "none"}`);
    // Large self-contained apps (notably DuckDB-WASM) continue fetching
    // declared bundle assets after DOMContentLoaded. Wait for that bounded
    // startup traffic to settle before treating an aborted request as a
    // failure or closing the page.
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await page.waitForTimeout(500);
    title = await page.title();
    if (!title.trim()) failures.push("document title is empty");
    const body = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
    if (!body.trim()) failures.push("document body is empty");
    for (const signal of ["Demo error:", "Unable to load /", "no runnable build published yet"]) {
      if (body.includes(signal)) failures.push(`visible failure signal: ${signal}`);
    }
    if (sample.id === "imagery-cog-quickstart") {
      const proof = await page.evaluate(async () => {
        const runtime = window.__HONUA_IMAGERY_TERRAIN_RUNTIME__;
        if (!runtime?.ready) throw new Error("Imagery COG runtime did not become ready.");
        const degraded = [];
        for (const key of [
          "credential-cog",
          "userinfo-cog",
          "cors-cog",
          "no-range-cog",
          "oversized-cog",
          "chunked-oversized-cog",
          "unsupported-crs",
          "unsupported-format",
          "missing-nodata",
        ]) {
          degraded.push({ key, outcome: await runtime.selectAsset(key), directCog: runtime.directCog });
        }
        await runtime.selectAsset("cog");
        runtime.setComparison(43);
        runtime.setTerrainEnabled(true);
        const elevation = await runtime.lookupAt(-157.9, 21.35);
        const profile = await runtime.runFixtureProfile();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          ready: runtime.ready,
          activeLayerCount: runtime.activeLayerCount,
          terrainEnabled: runtime.terrainEnabled,
          elevation,
          profile,
          directCog: runtime.directCog,
          fixtureTransport: runtime.fixtureTransport,
          fixtureImageSources: runtime.fixtureImageSources,
          degraded,
        };
      });
      if (!proof.ready || !proof.terrainEnabled || proof.activeLayerCount !== 4)
        failures.push(
          `imagery COG journey did not retain WMS, ImageServer, direct COG, and terrain layers: ${JSON.stringify({ ready: proof.ready, terrainEnabled: proof.terrainEnabled, activeLayerCount: proof.activeLayerCount })}`,
        );
      if (proof.elevation?.status !== "ready" || proof.elevation.elevationMeters !== 900)
        failures.push("imagery COG point elevation fixture did not return the exact 900 m receipt");
      if (proof.profile?.status !== "ready" || proof.profile.profile.samples.length !== 4)
        failures.push("imagery COG profile fixture did not return four samples");
      const expectedDegraded = new Map([
        ["credential-cog", "credentials"],
        ["userinfo-cog", "credentials"],
        ["cors-cog", "cors"],
        ["no-range-cog", "range"],
        ["oversized-cog", "range"],
        ["chunked-oversized-cog", "range"],
        ["unsupported-crs", "crs"],
        ["unsupported-format", "format"],
        ["missing-nodata", "nodata"],
      ]);
      for (const result of proof.degraded) {
        if (result.outcome?.status !== "unsupported" || result.outcome.code !== expectedDegraded.get(result.key)) {
          failures.push(`imagery COG degraded fixture did not fail closed: ${JSON.stringify(result)}`);
        }
      }
      if (
        proof.directCog.phase !== "ready" ||
        proof.directCog.transfer.requests !== 3 ||
        proof.directCog.transfer.bytesFetched !== 28_672 ||
        proof.directCog.transfer.ranges.some((range) => range.length > 64 * 1024)
      )
        failures.push("imagery COG bounded range receipt is incomplete or exceeds the 64 KiB ceiling");
      for (const identity of [
        "stac-search",
        "wms-capabilities",
        "image-server-metadata",
        "image-server-legend",
        "image-server-export",
        "elevation-value",
      ]) {
        if (!proof.fixtureTransport.serviceRequests.includes(identity))
          failures.push(`imagery COG fixture identity was not exercised: ${identity}`);
      }
      const expectedImageCoordinates = [
        [-158.22, 21.64],
        [-157.66, 21.64],
        [-157.66, 21.21],
        [-158.22, 21.21],
      ];
      if (
        proof.fixtureImageSources.length !== 2 ||
        proof.fixtureImageSources.some(
          (source) => JSON.stringify(source.coordinates) !== JSON.stringify(expectedImageCoordinates),
        )
      )
        failures.push("imagery COG image sources are not bound to the exact Oahu bbox");
      const requiredMapFixtures = [
        "wms-natural-color.png",
        "image-server-natural-color.png",
        "terrain-rgb.png",
      ];
      for (const fixture of requiredMapFixtures) {
        if (![...observedRequests].some((pathname) => pathname.endsWith(`/fixtures/cog/tiles/${fixture}`)))
          failures.push(`imagery COG map fixture was not loaded: ${fixture}`);
      }
    for (const fixture of ["wms-natural-color.png", "image-server-natural-color.png"]) {
      const href = [...requestedUrls].find((candidate) =>
        new URL(candidate).pathname.endsWith(`/fixtures/cog/tiles/${fixture}`),
      );
      if (!href || requestCounts.get(href) !== 1)
        failures.push(`imagery COG image fixture was not loaded exactly once: ${fixture}`);
    }
      const evidence = await page.locator("#direct-cog-render").innerText();
      if (
        !/Natural-color legend/u.test(evidence) ||
        !/RGB 22 \/ 91 \/ 164/u.test(evidence) ||
        !/28672 bytes across 3 exact range request/u.test(evidence)
      )
        failures.push(`imagery COG visible legend, pixel, or range evidence is incomplete: ${evidence}`);
      if ((await page.locator("#comparison-value").innerText()) !== "43% direct COG over published imagery")
        failures.push("imagery COG comparison control did not retain the exact 43% public receipt");
      const appPrefix = `/sdk/${sample.id}/app/`;
      for (const href of requestedUrls) {
        const url = new URL(href);
        if (url.origin !== origin || (!url.pathname.startsWith(appPrefix) && url.pathname !== "/favicon.ico"))
          failures.push(`imagery COG request escaped the published app root: ${href}`);
      }
    }
    staticJourney = await assertStaticJourney(page, sample, failures);
  } catch (error) {
    failures.push(`navigation: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (offOriginRequests.size > 0) {
    failures.push(`off-origin requests: ${[...offOriginRequests].join(", ")}`);
  }
  if (clientErrorResponses.size > 0) {
    failures.push(`4xx responses: ${[...clientErrorResponses].join(", ")}`);
  }

  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length > 0) {
    screenshot = `${sample.id}.png`;
    await page.screenshot({ path: path.join(evidenceDir, screenshot), fullPage: true });
  }
  await page.close();
  return {
    id: sample.id,
    title,
    passed: uniqueFailures.length === 0,
    requestCount: observedRequests.size,
    network: {
      offOriginRequestCount: offOriginRequests.size,
      clientErrorResponseCount: clientErrorResponses.size,
    },
    staticJourney,
    liveProbe,
    failures: uniqueFailures,
    screenshot,
  };
}

async function assertStaticJourney(page, sample, failures) {
  const journey = SAMPLE_BUNDLE_STATIC_SMOKE_JOURNEYS.get(sample.id);
  if (!journey) return null;
  await page.waitForFunction(
    ({ state, readyField }) => Boolean(window[state]?.[readyField]),
    { state: journey.state, readyField: journey.readyField },
    { timeout: 10_000 },
  );
  const runtimeReady = await page.evaluate(
    ({ state, readyField }) => Boolean(window[state]?.[readyField]),
    { state: journey.state, readyField: journey.readyField },
  );
  const resultState = await page.locator(journey.resultSelector).getAttribute(journey.resultAttribute);
  const canvasCount = await page.locator(journey.canvasSelector).count();
  const markerCount = await page.locator(journey.markerSelector).count();
  const sourceFeatureCount = await page.evaluate(
    ({ state, method }) => {
      const runtime = window[state];
      return typeof runtime?.[method] === "function" ? runtime[method]() : 0;
    },
    { state: journey.state, method: journey.sourceFeatureCountMethod },
  );
  const resultReady = runtimeReady && resultState === journey.resultValue;
  if (!resultReady) failures.push(`${sample.id}: result did not reach ${journey.resultValue}`);
  if (canvasCount < 1) failures.push(`${sample.id}: MapLibre canvas is missing`);
  if (sourceFeatureCount < 1) failures.push(`${sample.id}: MapLibre source has no rendered feature`);
  if (markerCount < 1) failures.push(`${sample.id}: result marker is missing`);
  return { resultReady, canvasCount, sourceFeatureCount, markerCount };
}

async function runSemanticLiveProbe(sampleId, policy) {
  if (!policy) return null;
  const expectedOrigins = new Set(policy.allowedOrigins);
  try {
    const response = await fetch(policy.semanticProbe.url, {
      headers: { accept: "application/geo+json, application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const responseOrigin = new URL(response.url).origin;
    if (!expectedOrigins.has(responseOrigin)) {
      throw new Error(`redirected to undeclared origin ${responseOrigin}`);
    }
    if (!response.ok) throw new Error(`returned HTTP ${response.status}`);
    const payload = await response.json();
    if (policy.semanticProbe.kind !== "geojson-feature-collection") {
      throw new Error(`unsupported semantic probe ${policy.semanticProbe.kind}`);
    }
    if (payload?.type !== "FeatureCollection" || !Array.isArray(payload.features)) {
      throw new Error("did not return a GeoJSON FeatureCollection");
    }
    if (payload.features.length < policy.semanticProbe.minimumFeatures) {
      throw new Error(`returned ${payload.features.length} features`);
    }
    return {
      passed: true,
      origin: responseOrigin,
      status: response.status,
      semantic: policy.semanticProbe.kind,
      featureCount: payload.features.length,
    };
  } catch (error) {
    return {
      passed: false,
      origin: policy.allowedOrigins[0],
      status: null,
      semantic: policy.semanticProbe.kind,
      featureCount: 0,
      failure: `${sampleId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function createStaticServer(sampleIds) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/sdk\/([^/]+)\/app\/(.*)$/u.exec(url.pathname);
      if (!match || !sampleIds.has(match[1])) return sendStatus(response, 404, "Not found");
      const sampleRoot = path.resolve(bundleRoot, match[1]);
      const relativePath = decodeURIComponent(match[2] || "index.html");
      let filePath = path.resolve(sampleRoot, relativePath);
      if (filePath !== sampleRoot && !filePath.startsWith(`${sampleRoot}${path.sep}`)) {
        return sendStatus(response, 400, "Invalid path");
      }
      const metadata = await stat(filePath);
      if (metadata.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      await sendFile(request, response, filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return sendStatus(response, 404, "Not found");
      process.stderr.write(`sample bundle server error: ${error instanceof Error ? error.message : String(error)}\n`);
      sendStatus(response, 500, "Internal server error");
    }
  });
}

async function sendFile(request, response, filePath) {
  const metadata = await stat(filePath);
  const range = parseRange(request.headers.range, metadata.size);
  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": mediaTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
  };
  if (range) {
    const length = range.end - range.start + 1;
    response.writeHead(206, {
      ...headers,
      "content-length": length,
      "content-range": `bytes ${range.start}-${range.end}/${metadata.size}`,
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "content-length": metadata.size });
  if (request.method === "HEAD") return response.end();
  createReadStream(filePath).pipe(response);
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function sendStatus(response, status, message) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
