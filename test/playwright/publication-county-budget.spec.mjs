import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { startPublicationHarness } from "./publication-lookup-harness.mjs";

// County-scale qualification of the parcel-ID lookup budget. Needs the full
// Maui County pair built by test/fixtures/publication/maui-parcels/build-pair.mjs
// (never committed); writes its measurement under the ignored .artifacts/.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pairDirectory = process.env.HONUA_PUBLICATION_PAIR_DIR ?? path.join(repoRoot, ".artifacts/maui-parcels/full-build");
const measurementDirectory = path.join(repoRoot, ".artifacts/maui-parcels/measurements");
const PARCELS = ["211001001", "223044073", "228004065", "235025027", "239002089", "246006024", "261001006"];
const NETWORK_PROFILES = [
  { name: "loopback", artifactDelayMs: 0 },
  { name: "loopback + 40 ms per artifact response", artifactDelayMs: 40 },
];

test.skip(!existsSync(path.join(pairDirectory, "descriptor.json")), `no county pair at ${pairDirectory}`);
test.setTimeout(600_000);

function artifactsIn(directory) {
  return {
    "/maui/descriptor.json": path.join(directory, "descriptor.json"),
    "/maui/parcels.parquet": path.join(directory, "parcels.parquet"),
    "/maui/parcels.pmtiles": path.join(directory, "parcels.pmtiles"),
  };
}

function bytesSince(server, mark) {
  return server.requests.slice(mark).reduce((total, entry) => total + entry.bytes, 0);
}

async function measureProfile(browser, profile, workDirectory) {
  const harness = await startPublicationHarness({
    artifacts: artifactsIn(pairDirectory),
    workDirectory,
    artifactDelayMs: profile.artifactDelayMs,
    artifactCacheControl: "public, max-age=3600, immutable",
  });
  const runs = [];
  let budget;
  try {
    for (const parcel of PARCELS) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${harness.app.origin}/`);
      await page.evaluate((url) => window.publicationHarness.open(url), `${harness.data.origin}/maui/descriptor.json`);
      budget = await page.evaluate(() => window.publicationHarness.budget);
      const engineMark = harness.app.requests.length;
      const coldMark = harness.data.requests.length;
      const cold = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
      const coldBytes = bytesSince(harness.data, coldMark);
      const coldRequests = harness.data.requests.length - coldMark;
      const engineBytes = bytesSince(harness.app, engineMark);
      const warmParcel = PARCELS[(PARCELS.indexOf(parcel) + 3) % PARCELS.length];
      const warmMark = harness.data.requests.length;
      const warm = await page.evaluate((id) => window.publicationHarness.lookup(id), warmParcel);
      const warmBytes = bytesSince(harness.data, warmMark);
      const repeatMark = harness.data.requests.length;
      const repeat = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
      runs.push({
        parcel,
        cold: { ok: cold.ok, answeredBy: cold.answeredBy, ms: cold.ms, artifactBytes: coldBytes, artifactRequests: coldRequests, engineBytes, plannedBytes: cold.plan?.plannedBytes },
        warm: { parcel: warmParcel, ok: warm.ok, ms: warm.ms, artifactBytes: warmBytes, plannedBytes: warm.plan?.plannedBytes },
        repeat: { ok: repeat.ok, ms: repeat.ms, artifactBytes: bytesSince(harness.data, repeatMark) },
        jsHeapBytes: repeat.jsHeapBytes,
        error: cold.ok ? undefined : cold.message,
      });
      await page.evaluate(() => window.publicationHarness.dispose());
      await context.close();
    }
  } finally {
    await harness.close();
  }
  return { profile: profile.name, runs, budget };
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
}

test("parcel-ID lookups on the full Maui County pair stay within the lookup budget", async ({ browser }) => {
  const workDirectory = mkdtempSync(path.join(os.tmpdir(), "honua-county-budget-"));
  try {
    const profiles = [];
    for (const profile of NETWORK_PROFILES) profiles.push(await measureProfile(browser, profile, workDirectory));
    const descriptor = JSON.parse(readFileSync(path.join(pairDirectory, "descriptor.json"), "utf8"));
    const record = {
      measuredAt: new Date().toISOString(),
      environment: {
        machine: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.release()}`,
        node: process.version,
        browser: `${browser.browserType().name()} ${browser.version()} (headless)`,
        engine: "DuckDB-WASM eh bundle, parquet extension only (no spatial), self-hosted",
        server: "Node static range server on 127.0.0.1, one origin for the page and engine, another for the artifacts",
      },
      publication: {
        publicationId: descriptor.publicationId,
        version: descriptor.version,
        captureId: descriptor.capture.captureId,
        featureCount: descriptor.capture.featureCount,
        geoparquetBytes: descriptor.artifacts.geoparquet.bytes,
        rowGroups: descriptor.artifacts.geoparquet.rowGroups,
        pmtilesBytes: descriptor.artifacts.pmtiles.bytes,
      },
      budget: profiles[0]?.budget,
      profiles: profiles.map(({ profile, runs }) => ({
        profile,
        coldMs: summary(runs.map((run) => run.cold.ms)),
        coldArtifactBytes: summary(runs.map((run) => run.cold.artifactBytes)),
        coldEngineBytes: summary(runs.map((run) => run.cold.engineBytes)),
        warmMs: summary(runs.map((run) => run.warm.ms)),
        warmArtifactBytes: summary(runs.map((run) => run.warm.artifactBytes)),
        repeatMs: summary(runs.map((run) => run.repeat.ms)),
        runs,
      })),
    };
    mkdirSync(measurementDirectory, { recursive: true });
    writeFileSync(path.join(measurementDirectory, `${record.measuredAt.replaceAll(":", "")}.json`), `${JSON.stringify(record, null, 2)}\n`);
    for (const { runs, budget } of profiles) {
      for (const run of runs) {
        expect(run.error, run.parcel).toBeUndefined();
        expect(run.cold.answeredBy).toBe("geoparquet");
        expect(run.cold.artifactBytes, `cold ${run.parcel}`).toBeLessThanOrEqual(budget.maxBytes);
        expect(run.warm.artifactBytes, `warm ${run.warm.parcel}`).toBeLessThanOrEqual(budget.maxBytes);
        expect(run.cold.ms, `cold ${run.parcel}`).toBeLessThanOrEqual(budget.maxTimeToFirstResultMs);
        expect(run.warm.ms, `warm ${run.warm.parcel}`).toBeLessThanOrEqual(budget.maxTimeToFirstResultMs);
      }
    }
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
});
