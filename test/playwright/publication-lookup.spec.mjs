import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { startPublicationHarness } from "./publication-lookup-harness.mjs";

const fixture = fileURLToPath(new URL("../fixtures/publication/maui-parcels/", import.meta.url));
const serverExportFixture = fileURLToPath(new URL("../fixtures/export/honua-server-v1/", import.meta.url));
const SERVER_EXPORT_ID = "scol2636-x2636-6c79f78d";
const SERVER_EXPORT_PREFIX = `/exports/${SERVER_EXPORT_ID}/20261123T141255Z-d24e032d`;
const serverExportArtifacts = {
  [`${SERVER_EXPORT_PREFIX}/collection.json`]: path.join(serverExportFixture, "collection.json"),
  [`${SERVER_EXPORT_PREFIX}/${SERVER_EXPORT_ID}.parquet`]: path.join(serverExportFixture, `${SERVER_EXPORT_ID}.parquet`),
  [`${SERVER_EXPORT_PREFIX}/${SERVER_EXPORT_ID}.pmtiles`]: path.join(serverExportFixture, `${SERVER_EXPORT_ID}.pmtiles`),
};
const artifacts = {
  "/maui/descriptor.json": path.join(fixture, "descriptor.json"),
  "/maui/parcels.parquet": path.join(fixture, "parcels.parquet"),
  "/maui/parcels.pmtiles": path.join(fixture, "parcels.pmtiles"),
};
const parcel = "234030888";
const fixtureParquetBytes = statSync(path.join(fixture, "parcels.parquet")).size;

test.setTimeout(120_000);

let workDirectory;
test.beforeEach(() => {
  workDirectory = mkdtempSync(path.join(tmpdir(), "honua-publication-browser-"));
});
test.afterEach(() => rmSync(workDirectory, { recursive: true, force: true }));

async function openHarness(page, options = {}) {
  const harness = await startPublicationHarness({ artifacts, workDirectory, ...options });
  await page.goto(`${harness.app.origin}/`);
  return harness;
}

const parquetReads = (harness) =>
  harness.data.requests.filter((entry) => entry.path === "/maui/parcels.parquet" && entry.method === "GET");

test("looks up a parcel across origins with partial range reads and keeps its values", async ({ page }) => {
  const harness = await openHarness(page);
  try {
    const freshness = await page.evaluate((url) => window.publicationHarness.open(url), `${harness.data.origin}/maui/descriptor.json`);
    expect(freshness.captureId).toMatch(/^sha256:/);
    const found = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
    expect(found).toMatchObject({ ok: true, answeredBy: "geoparquet", geometryType: "MultiPolygon", parts: 2 });
    expect(found.attributes).toMatchObject({ tmk_txt: parcel, plat: "030", parcel: "888", nhoodcode: null });
    expect(Object.keys(found.attributes)).not.toContain("landvalue");
    const reads = parquetReads(harness);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((entry) => entry.status === 206 && /^bytes=\d+-\d*$/.test(entry.range ?? ""))).toBe(true);
    await expect(page.getByRole("status")).toHaveText(`Found ${parcel}`);
    await page.evaluate(() => window.publicationHarness.dispose());
  } finally {
    await harness.close();
  }
});

test("a publication host without CORS fails the browser lookup instead of answering", async ({ page }) => {
  const harness = await openHarness(page, { artifactCors: false });
  try {
    const opened = await page.evaluate(async (url) => {
      try {
        await window.publicationHarness.open(url);
        return "opened";
      } catch (error) {
        return error.name;
      }
    }, `${harness.data.origin}/maui/descriptor.json`);
    expect(opened).toBe("TypeError");
  } finally {
    await harness.close();
  }
});

// DuckDB-WASM cannot interrupt a statement already running in its worker, so
// the footer read in flight at cancellation may finish; no later statement and
// no row-group read may start.
test("cancelling a lookup stops further range requests", async ({ page }) => {
  const harness = await openHarness(page, { artifactDelayMs: 300 });
  try {
    await page.evaluate((url) => window.publicationHarness.open(url), `${harness.data.origin}/maui/descriptor.json`);
    const pending = page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
    await expect.poll(() => harness.data.requests.filter((entry) => entry.path === "/maui/parcels.parquet").length).toBeGreaterThan(0);
    await page.evaluate(() => window.publicationHarness.cancel());
    const result = await pending;
    expect(result).toMatchObject({ ok: false });
    expect(result.name).toMatch(/Abort/);
    await page.waitForTimeout(1_000);
    const settled = harness.data.requests.length;
    await page.waitForTimeout(2_000);
    expect(harness.data.requests.length).toBe(settled);
    const footerStart = fixtureParquetBytes - 64 * 1024;
    const dataReads = parquetReads(harness).filter((entry) => Number(/^bytes=(\d+)-/.exec(entry.range ?? "")?.[1] ?? 0) < footerStart && entry.range !== "bytes=0-");
    expect(dataReads).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("an over-budget lookup falls back to the live service and says why in plain words", async ({ page }) => {
  const harness = await openHarness(page);
  try {
    await page.evaluate(
      ({ url, liveFeature }) =>
        window.publicationHarness.open(url, { budget: { maxBytes: 4_096, maxTimeToFirstResultMs: 30_000 }, liveFeature }),
      {
        url: `${harness.data.origin}/maui/descriptor.json`,
        liveFeature: { attributes: { tmk_txt: parcel, plat: "030", landvalue: 1 }, geometry: null },
      },
    );
    const found = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
    expect(found).toMatchObject({ ok: true, answeredBy: "server", limit: { kind: "bytes", budget: 4_096 } });
    expect(found.attributes).toEqual({ tmk_txt: parcel, plat: "030" });
    await expect(page.getByRole("status")).toHaveText(
      /^Looking up 234030888 in the browser would download about 0\.1 MB, more than the 0\.0 MB limit, so the live service answered instead\.$/,
    );
  } finally {
    await harness.close();
  }
});

test("opens a pair from a host whose HEAD ignores the Range header, for lookups and engine queries", async ({ page }) => {
  const harness = await openHarness(page, { artifactRangeSupport: "get-only" });
  try {
    await page.evaluate((url) => window.publicationHarness.open(url), `${harness.data.origin}/maui/descriptor.json`);
    const found = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
    expect(found).toMatchObject({ ok: true, answeredBy: "geoparquet", attributes: { tmk_txt: parcel, plat: "030" } });
    const filtered = await page.evaluate(() => window.publicationHarness.filter("parcel", "888"));
    expect(filtered).toMatchObject({ ok: true });
    expect(filtered.returnedFeatures).toBeGreaterThan(0);
    const fullReads = parquetReads(harness).filter((entry) => entry.status !== 206);
    expect(fullReads).toEqual([]);
    await page.evaluate(() => window.publicationHarness.dispose());
  } finally {
    await harness.close();
  }
});

test("a host without byte ranges is refused before the engine reads the file", async ({ page }) => {
  const harness = await openHarness(page, { artifactRangeSupport: "none" });
  try {
    await page.evaluate((url) => window.publicationHarness.open(url), `${harness.data.origin}/maui/descriptor.json`);
    const found = await page.evaluate((id) => window.publicationHarness.lookup(id), parcel);
    expect(found).toMatchObject({ ok: false, code: "query-budget-exceeded" });
    expect(found.message).toMatch(/^Looking up 234030888 in the browser would download the whole 0\.1 MB file, because its host does not serve byte ranges\./);
    const filtered = await page.evaluate(() => window.publicationHarness.filter("parcel", "888"));
    expect(filtered).toMatchObject({ ok: false, code: "query-budget-exceeded" });
    expect(harness.engineRequests()).toEqual([]);
    const refusedOperations = 2;
    expect(parquetReads(harness)).toHaveLength(refusedOperations);
  } finally {
    await harness.close();
  }
});

const SERVER_EXPORT_PUBLIC_FIELDS = [
  ["objectid", "integer"],
  ["id", "integer"],
  ["parcel_id", "string"],
  ["zone", "string"],
  ["acres", "number"],
  ["owner_note", "string"],
];

function bytesSince(requests, mark) {
  return requests.slice(mark).reduce((total, entry) => total + entry.bytes, 0);
}

async function openAndRenderExport(page, harness, collectionUrl) {
  await page.goto(`${harness.app.origin}/`);
  const mark = harness.data.requests.length;
  const started = performance.now();
  const opened = await page.evaluate((url) => window.publicationHarness.openExport(url), collectionUrl);
  const map = await page.evaluate((display) => window.publicationHarness.renderExportMap(display), opened.display);
  return {
    opened,
    map,
    firstMapMs: Math.round(performance.now() - started),
    mapRenderMs: Math.round(map.ms),
    mapBytes: bytesSince(harness.data.requests, mark),
  };
}

async function selectExportFeature(page, harness, feature) {
  const mark = harness.data.requests.length;
  const selected = await page.evaluate((candidate) => window.publicationHarness.select(candidate), feature);
  return {
    selected,
    ms: Math.round(selected.ms * 10) / 10,
    bytes: bytesSince(harness.data.requests, mark),
  };
}

test("opens a server-generated Export across origins without HEAD, renders PMTiles, and resolves click-to-attributes cold and warm", async ({
  page,
}, testInfo) => {
  const harness = await startPublicationHarness({
    artifacts: serverExportArtifacts,
    workDirectory,
    artifactHead: false,
    artifactCacheControl: "public, max-age=3600, immutable",
  });
  try {
    const collectionUrl = `${harness.data.origin}${SERVER_EXPORT_PREFIX}/collection.json`;

    const cold = await openAndRenderExport(page, harness, collectionUrl);
    expect(cold.opened.renderPath).toBe("visual");
    expect(cold.opened.display).toMatchObject({ sourceLayer: "layer", promoteId: "parcel_id" });
    expect(cold.opened.publicFields).toEqual(SERVER_EXPORT_PUBLIC_FIELDS);
    expect(cold.map.distinctCount).toBeGreaterThanOrEqual(2);

    const [firstFeature, secondFeature] = cold.map.features;
    const coldSelect = await selectExportFeature(page, harness, firstFeature);
    expect(coldSelect.selected).toMatchObject({ ok: true, answeredBy: "geoparquet", geometryType: "MultiPolygon" });
    expect(typeof coldSelect.selected.attributes.objectid).toBe("number");
    expect(typeof coldSelect.selected.attributes.id).toBe("number");
    expect(typeof coldSelect.selected.attributes.acres).toBe("number");
    expect(coldSelect.selected.attributes.parcel_id).toBe(firstFeature.properties.parcel_id);

    const warmSelect = await selectExportFeature(page, harness, secondFeature);
    expect(warmSelect.selected).toMatchObject({ ok: true, answeredBy: "geoparquet", geometryType: "MultiPolygon" });
    expect(typeof warmSelect.selected.attributes.acres).toBe("number");
    expect(warmSelect.selected.attributes.parcel_id).toBe(secondFeature.properties.parcel_id);

    const bboxMark = harness.data.requests.length;
    const bboxResult = await page.evaluate((bounds) => window.publicationHarness.queryBbox(bounds), cold.opened.display.bounds);
    const bboxBytes = bytesSince(harness.data.requests, bboxMark);
    expect(bboxResult).toMatchObject({ ok: true, answeredBy: "geoparquet" });
    expect(bboxResult.featureCount).toBeGreaterThan(0);
    await page.evaluate(() => window.publicationHarness.dispose());

    const warm = await openAndRenderExport(page, harness, collectionUrl);
    expect(warm.map.distinctCount).toBeGreaterThanOrEqual(2);
    const warmReloadSelect = await selectExportFeature(page, harness, firstFeature);
    expect(warmReloadSelect.selected).toMatchObject({ ok: true, answeredBy: "geoparquet" });
    await page.evaluate(() => window.publicationHarness.dispose());

    const headRequests = harness.data.requests.filter((entry) => entry.method === "HEAD");
    const errorResponses = harness.data.requests.filter((entry) => entry.status >= 400);
    expect(headRequests).toEqual([]);
    expect(errorResponses).toEqual([]);
    expect(harness.engineRequests()).toEqual([]);

    await testInfo.attach("export-browser-metrics", {
      contentType: "application/json",
      body: JSON.stringify(
        {
          exportId: SERVER_EXPORT_ID,
          headRequests: headRequests.length,
          cold: {
            firstMapMs: cold.firstMapMs,
            mapRenderMs: cold.mapRenderMs,
            mapBytes: cold.mapBytes,
            clickToAttributesMs: coldSelect.ms,
            lookupBytes: coldSelect.bytes,
            bboxQueryMs: Math.round(bboxResult.ms * 10) / 10,
            bboxQueryBytes: bboxBytes,
            bboxFeatureCount: bboxResult.featureCount,
          },
          warm: {
            firstMapMs: warm.firstMapMs,
            mapRenderMs: warm.mapRenderMs,
            mapBytes: warm.mapBytes,
            inSessionClickToAttributesMs: warmSelect.ms,
            inSessionLookupBytes: warmSelect.bytes,
            cachedReloadClickToAttributesMs: warmReloadSelect.ms,
            cachedReloadLookupBytes: warmReloadSelect.bytes,
          },
        },
        null,
        2,
      ),
    });
  } finally {
    await harness.close();
  }
});

