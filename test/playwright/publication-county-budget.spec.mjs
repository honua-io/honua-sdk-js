import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { startPublicationHarness } from "./publication-lookup-harness.mjs";

// County-scale qualification of the parcel-ID lookup budget. Measures either
// the full Maui County pair built by
// test/fixtures/publication/maui-parcels/build-pair.mjs (never committed) on
// a local artifact server, or a hosted pair when
// HONUA_PUBLICATION_DESCRIPTOR_URL names its descriptor. Writes the
// measurement under the ignored .artifacts/; HONUA_PUBLICATION_BASELINE (a
// path or URL of an earlier measurement) adds the change from that baseline.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pairDirectory = process.env.HONUA_PUBLICATION_PAIR_DIR ?? path.join(repoRoot, ".artifacts/maui-parcels/full-build");
const hostedDescriptorUrl = process.env.HONUA_PUBLICATION_DESCRIPTOR_URL;
const baselineLocation = process.env.HONUA_PUBLICATION_BASELINE;
const measurementDirectory = path.join(repoRoot, ".artifacts/maui-parcels/measurements");
const ATTRIBUTE_FILTER = { field: "nhoodcode", value: "1423-5" };
const PARCELS = ["211001001", "223044073", "228004065", "235025027", "239002089", "246006024", "261001006"];
const LOCAL_PROFILES = [
  { name: "loopback", artifactDelayMs: 0 },
  { name: "loopback + 40 ms per artifact response", artifactDelayMs: 40 },
];
const HOSTED_PROFILES = [{ name: "hosted pair over this machine's network" }];

test.skip(
  !hostedDescriptorUrl && !existsSync(path.join(pairDirectory, "descriptor.json")),
  `no county pair at ${pairDirectory} and no HONUA_PUBLICATION_DESCRIPTOR_URL`,
);
test.setTimeout(600_000);

function artifactsIn(directory) {
  return {
    "/maui/descriptor.json": path.join(directory, "descriptor.json"),
    "/maui/parcels.parquet": path.join(directory, "parcels.parquet"),
    "/maui/parcels.pmtiles": path.join(directory, "parcels.pmtiles"),
  };
}

function servedArtifacts(harness) {
  return {
    descriptorUrl: `${harness.data.origin}/maui/descriptor.json`,
    requests: () => harness.data.requests,
    settled: async () => {},
  };
}

function hostedArtifacts(context, artifactOrigins) {
  const requests = [];
  const sizes = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (!artifactOrigins.has(url.origin)) return;
    const entry = { path: url.pathname, range: request.headers().range, bytes: 0 };
    requests.push(entry);
    sizes.push(
      request
        .sizes()
        .then((measured) => (entry.bytes = measured.responseBodySize))
        .catch(() => (entry.failed = true)),
    );
  });
  return { descriptorUrl: hostedDescriptorUrl, requests: () => requests, settled: () => Promise.all(sizes) };
}

function artifactOriginsOf(descriptor) {
  return new Set(
    Object.values(descriptor.artifacts).map((artifact) => new URL(artifact.href, hostedDescriptorUrl).origin),
  );
}

function keepsIdentity(parcel, attributes) {
  return attributes?.tmk_txt === parcel && attributes.plat === parcel.slice(3, 6) && attributes.parcel === parcel.slice(6);
}

function bytesSince(requests, mark) {
  return requests.slice(mark).reduce((total, entry) => total + entry.bytes, 0);
}

async function startHarness(profile, workDirectory) {
  return startPublicationHarness({
    artifacts: hostedDescriptorUrl ? {} : artifactsIn(pairDirectory),
    workDirectory,
    artifactDelayMs: profile.artifactDelayMs ?? 0,
    artifactCacheControl: "public, max-age=3600, immutable",
  });
}

async function measureParcel({ browser, harness, parcel, artifactOrigins }) {
  const context = await browser.newContext();
  const artifacts = hostedDescriptorUrl ? hostedArtifacts(context, artifactOrigins) : servedArtifacts(harness);
  try {
    const page = await context.newPage();
    await page.goto(`${harness.app.origin}/`);
    await page.evaluate((url) => window.publicationHarness.open(url), artifacts.descriptorUrl);
    const budget = await page.evaluate(() => window.publicationHarness.budget);
    const engineMark = harness.app.requests.length;
    const coldMark = artifacts.requests().length;
    const cold = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
    const coldRequests = artifacts.requests().length - coldMark;
    const engineBytes = bytesSince(harness.app.requests, engineMark);
    const warmParcel = PARCELS[(PARCELS.indexOf(parcel) + 3) % PARCELS.length];
    const warmMark = artifacts.requests().length;
    const warm = await page.evaluate((id) => window.publicationHarness.lookup(id), warmParcel);
    const repeatMark = artifacts.requests().length;
    const repeat = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
    const filterMark = artifacts.requests().length;
    const filtered = await page.evaluate(
      ({ field, value }) => window.publicationHarness.filter(field, value),
      ATTRIBUTE_FILTER,
    );
    await page.evaluate(() => window.publicationHarness.dispose());
    await page.close();
    await artifacts.settled();
    const requests = artifacts.requests();
    return {
      budget,
      run: {
        parcel,
        cold: {
          ok: cold.ok,
          answeredBy: cold.answeredBy,
          keepsIdentity: keepsIdentity(parcel, cold.attributes),
          ms: cold.ms,
          artifactBytes: bytesSince(requests.slice(0, warmMark), coldMark),
          artifactRequests: coldRequests,
          engineBytes,
          plannedBytes: cold.plan?.plannedBytes,
        },
        warm: {
          parcel: warmParcel,
          ok: warm.ok,
          keepsIdentity: keepsIdentity(warmParcel, warm.attributes),
          ms: warm.ms,
          artifactBytes: bytesSince(requests.slice(0, repeatMark), warmMark),
          plannedBytes: warm.plan?.plannedBytes,
        },
        repeat: { ok: repeat.ok, ms: repeat.ms, artifactBytes: bytesSince(requests.slice(0, filterMark), repeatMark) },
        attributeFilter: { ...filtered, artifactBytes: bytesSince(requests, filterMark) },
        jsHeapBytes: repeat.jsHeapBytes,
        error: cold.ok ? undefined : cold.message,
      },
    };
  } finally {
    await context.close();
  }
}

async function measureProfile({ browser, profile, workDirectory, artifactOrigins }) {
  const harness = await startHarness(profile, workDirectory);
  const runs = [];
  let budget;
  try {
    for (const parcel of PARCELS) {
      const measured = await measureParcel({ browser, harness, parcel, artifactOrigins });
      budget = measured.budget;
      runs.push(measured.run);
    }
  } finally {
    await harness.close();
  }
  return { profile: profile.name, runs, budget };
}

async function readJson(location) {
  if (!/^https?:/.test(location)) return JSON.parse(readFileSync(location, "utf8"));
  const response = await fetch(location);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${location}`);
  return response.json();
}

async function readDescriptor() {
  return readJson(hostedDescriptorUrl ?? path.join(pairDirectory, "descriptor.json"));
}

const COMPARED_MEASURES = [
  ["coldMs", "median"],
  ["coldMs", "max"],
  ["coldArtifactBytes", "max"],
  ["warmMs", "median"],
  ["warmArtifactBytes", "max"],
];

function comparedWith(baseline, profiles) {
  return profiles.map((profile) => {
    const before = baseline.profiles.find((candidate) => candidate.profile === profile.profile);
    if (!before) return { profile: profile.profile, baseline: "no profile with this name in the baseline" };
    return {
      profile: profile.profile,
      changes: COMPARED_MEASURES.map(([measure, statistic]) => ({
        measure: `${measure}.${statistic}`,
        baseline: before[measure][statistic],
        current: profile[measure][statistic],
        change: profile[measure][statistic] - before[measure][statistic],
      })),
    };
  });
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
}

test("parcel-ID lookups on the full Maui County pair stay within the lookup budget", async ({ browser }) => {
  const workDirectory = mkdtempSync(path.join(os.tmpdir(), "honua-county-budget-"));
  try {
    const descriptor = await readDescriptor();
    const artifactOrigins = hostedDescriptorUrl ? artifactOriginsOf(descriptor) : undefined;
    const profiles = [];
    for (const profile of hostedDescriptorUrl ? HOSTED_PROFILES : LOCAL_PROFILES) {
      profiles.push(await measureProfile({ browser, profile, workDirectory, artifactOrigins }));
    }
    const record = {
      measuredAt: new Date().toISOString(),
      environment: {
        machine: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.release()}`,
        node: process.version,
        browser: `${browser.browserType().name()} ${browser.version()} (headless)`,
        engine: "DuckDB-WASM eh bundle, parquet extension only (no spatial), self-hosted",
        server: hostedDescriptorUrl
          ? `page and engine on a Node static server on 127.0.0.1; artifacts from ${hostedDescriptorUrl}`
          : "Node static range server on 127.0.0.1, one origin for the page and engine, another for the artifacts",
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
        attributeFilter: {
          ...ATTRIBUTE_FILTER,
          ms: summary(runs.map((run) => run.attributeFilter.ms)),
          artifactBytes: summary(runs.map((run) => run.attributeFilter.artifactBytes)),
          returnedFeatures: runs[0]?.attributeFilter.returnedFeatures,
        },
        runs,
      })),
    };
    if (baselineLocation) {
      const baseline = await readJson(baselineLocation);
      record.comparison = { baseline: baselineLocation, measuredAt: baseline.measuredAt, profiles: comparedWith(baseline, record.profiles) };
      console.log(JSON.stringify(record.comparison, null, 2));
    }
    mkdirSync(measurementDirectory, { recursive: true });
    writeFileSync(path.join(measurementDirectory, `${record.measuredAt.replaceAll(":", "")}.json`), `${JSON.stringify(record, null, 2)}\n`);
    for (const { runs, budget } of profiles) {
      for (const run of runs) {
        expect(run.error, run.parcel).toBeUndefined();
        expect(run.cold.answeredBy).toBe("geoparquet");
        expect(run.cold.artifactBytes, `cold ${run.parcel} read no artifact bytes`).toBeGreaterThan(0);
        expect(run.cold.keepsIdentity, `cold ${run.parcel}`).toBe(true);
        expect(run.attributeFilter.ok, run.attributeFilter.message).toBe(true);
        expect(run.warm.keepsIdentity, `warm ${run.warm.parcel}`).toBe(true);
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
