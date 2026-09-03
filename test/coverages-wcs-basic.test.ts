import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COVERAGE_FIXTURE_CONTRACT,
  ELEVATION_LEGEND,
  FIXTURE_IMAGE_BYTE_LENGTH,
  FIXTURE_IMAGE_SHA256,
  FIXTURE_ORIGIN,
  createPinnedCoveragePng,
  createPinnedFixtureFetch,
  fixtureRequestLog,
} from "../examples/coverages-wcs-basic/src/pinned-fixtures.js";

const sampleRoot = path.resolve("examples/coverages-wcs-basic");
const styles = readFileSync(path.join(sampleRoot, "src/styles.css"), "utf8");
const main = readFileSync(path.join(sampleRoot, "src/main.ts"), "utf8");
const fixtures = readFileSync(path.join(sampleRoot, "src/pinned-fixtures.ts"), "utf8");
const markup = readFileSync(path.join(sampleRoot, "index.html"), "utf8");
const readme = readFileSync(path.join(sampleRoot, "README.md"), "utf8");

function imageRequest(pathname: string, pairs: readonly (readonly [string, string])[]): Request {
  const url = new URL(pathname, FIXTURE_ORIGIN);
  for (const [key, value] of pairs) url.searchParams.append(key, value);
  return new Request(url, { headers: { accept: COVERAGE_FIXTURE_CONTRACT.format } });
}

const ogcPairs = [
  ["bbox", COVERAGE_FIXTURE_CONTRACT.bbox.join(",")],
  ["bbox-crs", COVERAGE_FIXTURE_CONTRACT.bboxCrs],
  ["crs", COVERAGE_FIXTURE_CONTRACT.bboxCrs],
  ["properties", COVERAGE_FIXTURE_CONTRACT.band],
  ["scale-size", `x(${COVERAGE_FIXTURE_CONTRACT.width}),y(${COVERAGE_FIXTURE_CONTRACT.height})`],
  ["f", "png"],
] as const;

const wcsPairs = [
  ["SERVICE", "WCS"],
  ["VERSION", "2.0.1"],
  ["REQUEST", "GetCoverage"],
  ["COVERAGEID", COVERAGE_FIXTURE_CONTRACT.coverageId],
  ["SUBSET", "Lat(21.3,21.5)"],
  ["SUBSET", "Long(-158.1,-157.9)"],
  ["SUBSETTINGCRS", COVERAGE_FIXTURE_CONTRACT.wcsCrs],
  ["OUTPUTCRS", COVERAGE_FIXTURE_CONTRACT.wcsCrs],
  ["RANGESUBSET", COVERAGE_FIXTURE_CONTRACT.band],
  ["SCALESIZE", "Lat(220),Long(320)"],
  ["FORMAT", COVERAGE_FIXTURE_CONTRACT.format],
] as const;

function mutate(
  pairs: readonly (readonly [string, string])[],
  key: string,
  value: string,
  occurrence = 0,
): [string, string][] {
  let seen = 0;
  return pairs.map(([candidate, current]) => {
    if (candidate === key && seen++ === occurrence) return [candidate, value];
    return [candidate, current];
  });
}

describe("Coverage and WCS sample", () => {
  it("generates the pinned 320 x 220 image with stable bytes, digest, and legend semantics", () => {
    const bytes = createPinnedCoveragePng();
    expect(bytes.byteLength).toBe(FIXTURE_IMAGE_BYTE_LENGTH);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURE_IMAGE_SHA256);
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(0)).toBe(COVERAGE_FIXTURE_CONTRACT.width);
    expect(new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(4)).toBe(COVERAGE_FIXTURE_CONTRACT.height);
    expect(ELEVATION_LEGEND.map((entry) => entry.value)).toEqual([0, 150, 300, 450, 600]);
  });

  it("accepts only the exact named-band OGC and WCS image requests", async () => {
    const fetchFn = createPinnedFixtureFetch({
      maxResponseBytes: COVERAGE_FIXTURE_CONTRACT.maxResponseBytes,
    });
    const ogc = await fetchFn(
      imageRequest(`/ogc/coverages/collections/${COVERAGE_FIXTURE_CONTRACT.collectionId}/coverage`, ogcPairs),
    );
    const wcs = await fetchFn(imageRequest(`/ogc/services/${COVERAGE_FIXTURE_CONTRACT.collectionId}/wcs`, wcsPairs));
    expect(ogc.status).toBe(200);
    expect(wcs.status).toBe(200);
    expect(ogc.headers.get("x-fixture-sha256")).toBe(FIXTURE_IMAGE_SHA256);
    expect(new Uint8Array(await ogc.arrayBuffer())).toEqual(new Uint8Array(await wcs.arrayBuffer()));
  });

  it("rejects method, route, ID, bbox/subset, band, scale, CRS, format, and ceiling drift", async () => {
    const fetchFn = createPinnedFixtureFetch({
      maxResponseBytes: COVERAGE_FIXTURE_CONTRACT.maxResponseBytes,
    });
    const ogcPath = `/ogc/coverages/collections/${COVERAGE_FIXTURE_CONTRACT.collectionId}/coverage`;
    const wcsPath = `/ogc/services/${COVERAGE_FIXTURE_CONTRACT.collectionId}/wcs`;
    const rejected = [
      new Request(new URL("/unexpected", FIXTURE_ORIGIN), { headers: { accept: "application/json" } }),
      new Request(imageRequest(ogcPath, ogcPairs), { method: "POST" }),
      imageRequest("/ogc/coverages/collections/8/coverage", ogcPairs),
      imageRequest(ogcPath, mutate(ogcPairs, "bbox", "-158,21,-157,22")),
      imageRequest(ogcPath, mutate(ogcPairs, "properties", "other-band")),
      imageRequest(ogcPath, mutate(ogcPairs, "scale-size", "x(64),y(64)")),
      imageRequest(ogcPath, mutate(ogcPairs, "crs", "EPSG:3857")),
      imageRequest(ogcPath, mutate(ogcPairs, "f", "jpeg")),
      imageRequest("/ogc/services/8/wcs", wcsPairs),
      imageRequest(wcsPath, mutate(wcsPairs, "COVERAGEID", "8")),
      imageRequest(wcsPath, mutate(wcsPairs, "SUBSET", "Lat(21.2,21.6)")),
      imageRequest(wcsPath, mutate(wcsPairs, "RANGESUBSET", "other-band")),
      imageRequest(wcsPath, mutate(wcsPairs, "SCALESIZE", "Lat(64),Long(64)")),
      imageRequest(wcsPath, mutate(wcsPairs, "OUTPUTCRS", "EPSG:3857")),
      imageRequest(wcsPath, mutate(wcsPairs, "FORMAT", "image/tiff")),
    ];
    for (const request of rejected) {
      await expect(fetchFn(request)).rejects.toThrow("Pinned coverage fixture rejected");
    }
    expect(() =>
      createPinnedFixtureFetch({ maxResponseBytes: COVERAGE_FIXTURE_CONTRACT.maxResponseBytes - 1 }),
    ).toThrow("rejected response ceiling");
  });

  it("records exact OGC and WCS cancellation attempts before their aborted responses settle", async () => {
    const fetchFn = createPinnedFixtureFetch({
      maxResponseBytes: COVERAGE_FIXTURE_CONTRACT.maxResponseBytes,
    });
    const start = fixtureRequestLog.length;
    const requests = [
      imageRequest(
        `/ogc/coverages/collections/${COVERAGE_FIXTURE_CONTRACT.collectionId}/coverage`,
        mutate(
          mutate(ogcPairs, "properties", COVERAGE_FIXTURE_CONTRACT.cancellationBand),
          "scale-size",
          `x(${COVERAGE_FIXTURE_CONTRACT.cancellationSize}),y(${COVERAGE_FIXTURE_CONTRACT.cancellationSize})`,
        ),
      ),
      imageRequest(
        `/ogc/services/${COVERAGE_FIXTURE_CONTRACT.collectionId}/wcs`,
        mutate(
          mutate(wcsPairs, "RANGESUBSET", COVERAGE_FIXTURE_CONTRACT.cancellationBand),
          "SCALESIZE",
          `Lat(${COVERAGE_FIXTURE_CONTRACT.cancellationSize}),Long(${COVERAGE_FIXTURE_CONTRACT.cancellationSize})`,
        ),
      ),
    ];
    for (const request of requests) {
      const controller = new AbortController();
      const pending = fetchFn(new Request(request, { signal: controller.signal }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fixtureRequestLog.length).toBeGreaterThan(start);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
    const recorded = fixtureRequestLog.slice(start).map((entry) => new URL(entry.url));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.searchParams.get("properties")).toBe(COVERAGE_FIXTURE_CONTRACT.cancellationBand);
    expect(recorded[1]?.searchParams.get("RANGESUBSET")).toBe(COVERAGE_FIXTURE_CONTRACT.cancellationBand);
  });

  it("returns structured degradation responses for the exact unknown band on both protocols", async () => {
    const fetchFn = createPinnedFixtureFetch({
      maxResponseBytes: COVERAGE_FIXTURE_CONTRACT.maxResponseBytes,
    });
    const ogc = await fetchFn(
      imageRequest(
        `/ogc/coverages/collections/${COVERAGE_FIXTURE_CONTRACT.collectionId}/coverage`,
        mutate(
          mutate(ogcPairs, "properties", COVERAGE_FIXTURE_CONTRACT.degradationBand),
          "scale-size",
          `x(${COVERAGE_FIXTURE_CONTRACT.cancellationSize}),y(${COVERAGE_FIXTURE_CONTRACT.cancellationSize})`,
        ),
      ),
    );
    const wcs = await fetchFn(
      imageRequest(
        `/ogc/services/${COVERAGE_FIXTURE_CONTRACT.collectionId}/wcs`,
        mutate(
          mutate(wcsPairs, "RANGESUBSET", COVERAGE_FIXTURE_CONTRACT.degradationBand),
          "SCALESIZE",
          `Lat(${COVERAGE_FIXTURE_CONTRACT.cancellationSize}),Long(${COVERAGE_FIXTURE_CONTRACT.cancellationSize})`,
        ),
      ),
    );
    expect(ogc.status).toBe(400);
    expect(await ogc.json()).toMatchObject({ code: "InvalidParameterValue" });
    expect(wcs.status).toBe(400);
    expect(await wcs.text()).toContain('exceptionCode="InvalidParameterValue"');
  });

  it("exercises both real clients, byte-derived evidence, and the shared MapLibre handoff", () => {
    expect(main).toContain("createCoverageClient(client)");
    expect(main).toContain("createWcsClient(client");
    expect(main).toContain("coverages.collections({ signal })");
    expect(main).toContain("source.collection({ signal })");
    expect(main).toContain("source.domainSet({ signal })");
    expect(main).toContain("source.rangeType({ signal })");
    expect(main).toContain("properties: [selectedBand]");
    expect(main).toContain("rangeSubset: [selectedBand]");
    expect(main).toContain("coverageToMapLibreImage(coverage, bbox");
    expect(main).toContain("inspectCenterPixel(ogcCoverage)");
    expect(main).toContain("ELEVATION_LEGEND.find(");
    expect(main).not.toContain("CENTER_PIXEL");
    expect(markup).toContain('id="map"');
    expect(markup).toContain('id="legend-ramp"');
    expect(markup).toContain('id="pixel-value"');
  });

  it("pins cancellation, degradation, disposal, and a closed transport boundary", () => {
    expect(main).toContain("COVERAGE_FIXTURE_CONTRACT.width");
    expect(main).toContain("COVERAGE_FIXTURE_CONTRACT.maxResponseBytes");
    expect(main).toContain('controller.abort("Superseded fixture request")');
    expect(main).toContain("COVERAGE_FIXTURE_CONTRACT.degradationBand");
    expect(main).toContain("releaseActiveProjection();");
    expect(main).toContain("map.remove();");
    expect(fixtures).toContain("only GET is allowed");
    expect(fixtures).toContain("assertQuery(request, url");
    expect(fixtures).not.toMatch(/\bfetch\s*\(/u);
  });

  it("keeps its classification truthful and its font presentation local", () => {
    expect(styles).not.toMatch(/@import\s/iu);
    expect(styles).not.toMatch(/url\(\s*["']?https?:\/\//iu);
    expect(styles).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/iu);
    expect(styles).toContain('font-family: "Avenir Next", Avenir, Futura, "Century Gothic", sans-serif;');
    expect(readme).toContain("support remain **experimental**");
    expect(readme).toContain("planned but missing");
    expect(readme).toContain("configure or discover");
    expect(readme).toContain("canonical raster source registry");
    expect(readme).not.toMatch(/issues\/(?:1114|1115)/u);
  });
});
