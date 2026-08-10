import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIRST_MAP_FIXTURE_GEOSERVICES_PATH,
  FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH,
  MAX_FIRST_MAP_FEATURES,
  PUBLIC_FIRST_MAP_ENDPOINT,
  SAME_ORIGIN_FIRST_MAP_FIXTURE,
  endpointForFirstMapProtocol,
  resolveFirstMapConfig,
} from "../examples/maplibre-quickstart/src/first-map-config.js";
import { runFirstMapWorkflow } from "../examples/maplibre-quickstart/src/workflow.js";
import { type SampleFixtureHarness, loadFixturePack, startSampleFixtureHarness } from "../samples/scenarios/index.mjs";
import { FirstMapTestMap } from "./helpers/first-map-test-map.js";

const fixturePack = loadFixturePack("first-map", "v2");
const fixtureFiles = fixturePack.manifest.schema.files as Record<string, string>;
const fixtureFeatureCount = fixturePack.manifest.schema.featureCount;
const fixtureSelectedRecordId = fixturePack.manifest.schema.selectedRecordId;
const fixtureCollectionId = (fixturePack.data[fixtureFiles.ogcCollection!] as { id: string }).id;

function fixture<T>(role: string): T {
  return structuredClone(fixturePack.data[fixtureFiles[role]!]) as T;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function multiCollectionFetch(): typeof fetch {
  const collection = fixture<Record<string, unknown>>("ogcCollection");
  const second = { ...structuredClone(collection), id: "response-zones", title: "Response zones" };
  return async (input, init) => {
    const { pathname } = new URL(new Request(input, init).url);
    if (pathname === "/ogc/features") return json(fixture("ogcLanding"));
    if (pathname === "/ogc/features/conformance") return json(fixture("ogcConformance"));
    if (pathname === "/ogc/features/collections") return json({ collections: [collection, second] });
    if (pathname.endsWith("/items")) return json(fixture("ogcItems"));
    return new Response("Not found", { status: 404 });
  };
}

async function requestRoutes(harness: SampleFixtureHarness): Promise<string[]> {
  const response = await fetch(`${harness.origin}/__fixture__/runs/default/requests`);
  const body = (await response.json()) as { requests: Array<{ routeId: string }> };
  return body.requests.map(({ routeId }) => routeId);
}

describe("First Map copyable workflow core", () => {
  let harness: SampleFixtureHarness;

  beforeAll(async () => {
    harness = await startSampleFixtureHarness({ sampleId: "first-map", fixturePackVersion: "v2" });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("connects, inspects, explains, queries, and mounts the deterministic GeoServices fixture", async () => {
    const map = new FirstMapTestMap();
    const result = await runFirstMapWorkflow(
      resolveFirstMapConfig({
        endpoint: `${harness.origin}/rest/services/natural-earth/FeatureServer/0`,
        mode: "fixture",
        maxFeatures: fixtureFeatureCount,
      }),
      { map },
    );

    expect(result.state, JSON.stringify(result)).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.view).toMatchObject({
      mode: "fixture",
      connection: { protocol: "geoservices-feature-service", cacheStatus: "miss" },
      source: { id: "0", capabilities: expect.arrayContaining(["query"]) },
      maxFeatures: fixtureFeatureCount,
    });
    expect(result.plan.steps[0]).toMatchObject({
      engine: "remote",
      compiled: { compiler: "geoservices-rest-query-v1", resultRecordCount: fixtureFeatureCount },
    });
    expect(result.query.features).toHaveLength(fixtureFeatureCount);
    expect(result.query.features[0]).toMatchObject({
      attributes: { OBJECTID: fixtureSelectedRecordId, GEOID: "15009030100", NAMELSAD: "Census Tract 301" },
      geometry: { rings: expect.any(Array) },
    });
    expect(result.view.source.attribution).toBe("Source: U.S. Census Bureau, 2025 TIGER/Line Shapefiles.");
    expect(result.query.execution.plan.fingerprint).toBe(result.plan.fingerprint);
    expect(result.query.execution.terminal).toEqual({
      state: "completed",
      featureCount: fixtureFeatureCount,
      exceededTransferLimit: false,
    });
    expect(result.mounted.raw("maplibre")).toBe(map);
    expect(result.mounted.diagnostics).toContainEqual(
      expect.objectContaining({ code: "selected", severity: "info", strategy: "geojson-query" }),
    );
    expect(map.sources.size).toBe(1);
    expect(map.layers.size).toBeGreaterThan(0);
    expect((await requestRoutes(harness)).filter((route) => route === "first-map-query")).toHaveLength(2);
    await result.dispose();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.removeCount).toBe(0);
    await expect(result.dispose()).resolves.toBeUndefined();
  });

  it("runs the same semantic workflow through deterministic OGC API Features fixtures", async () => {
    const map = new FirstMapTestMap();
    const result = await runFirstMapWorkflow(
      resolveFirstMapConfig({
        endpoint: `${harness.origin}${FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH}`,
        mode: "fixture",
        protocol: "ogc-features",
        maxFeatures: fixtureFeatureCount,
      }),
      { map },
    );

    expect(result.state, JSON.stringify(result)).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.view).toMatchObject({
      connection: { endpoint: `${harness.origin}/ogc/features`, protocol: "ogc-features" },
      source: { id: fixtureCollectionId, capabilities: expect.arrayContaining(["query"]) },
    });
    expect(result.plan.steps[0]).toMatchObject({
      engine: "remote",
      compiled: {
        compiler: "ogc-api-features-query-v1",
        collectionId: fixtureCollectionId,
        limit: fixtureFeatureCount,
      },
    });
    expect(result.query.features).toHaveLength(fixtureFeatureCount);
    expect(result.query.features[0]).toMatchObject({
      attributes: { OBJECTID: fixtureSelectedRecordId, GEOID: "15009030100", NAMELSAD: "Census Tract 301" },
      geometry: { type: "MultiPolygon" },
    });
    expect(result.query.execution.plan.fingerprint).toBe(result.plan.fingerprint);
    expect(result.mounted.diagnostics).toContainEqual(expect.objectContaining({ strategy: "geojson-query" }));
    await result.dispose();
  });

  it("returns an explicit overflow state before mounting truncated data", async () => {
    const overflow = await startSampleFixtureHarness({
      sampleId: "first-map",
      fixturePackVersion: "v1",
      defaultRunId: "overflow",
      defaultScenario: "overflow",
    });
    const map = new FirstMapTestMap();
    try {
      const result = await runFirstMapWorkflow(
        resolveFirstMapConfig({
          endpoint: `${overflow.origin}/rest/services/natural-earth/FeatureServer/0`,
          mode: "fixture",
          maxFeatures: 3,
        }),
        { map },
      );
      expect(result).toMatchObject({
        state: "overflow",
        error: { code: "first-map.query-overflow", retryable: false },
        query: { exceededTransferLimit: true, features: [{}, {}] },
      });
      expect(map.sources.size).toBe(0);
      expect(map.layers.size).toBe(0);
    } finally {
      await overflow.close();
    }
  });

  it("preserves unsupported capability and explicit source-selection states", async () => {
    const unsupported = await startSampleFixtureHarness({
      sampleId: "first-map",
      fixturePackVersion: "v1",
      defaultRunId: "unsupported",
      defaultScenario: "unsupported",
    });
    try {
      const result = await runFirstMapWorkflow(
        resolveFirstMapConfig({
          endpoint: `${unsupported.origin}/rest/services/natural-earth/FeatureServer/0`,
          mode: "fixture",
        }),
        { map: new FirstMapTestMap() },
      );
      expect(result).toMatchObject({
        state: "unsupported",
        error: { code: "query.planning.capability-not-supported", retryable: false },
      });
    } finally {
      await unsupported.close();
    }

    const base = { endpoint: "https://fixture.example/ogc/features", protocol: "ogc-features" as const };
    const ambiguous = await runFirstMapWorkflow(resolveFirstMapConfig(base), {
      map: new FirstMapTestMap(),
      fetchFn: multiCollectionFetch(),
    });
    expect(ambiguous).toMatchObject({
      state: "source-selection-required",
      reason: "ambiguous",
      sources: [{ id: fixtureCollectionId }, { id: "response-zones" }],
    });
  });

  it("validates public endpoints and materialization bounds before network work", () => {
    expect(PUBLIC_FIRST_MAP_ENDPOINT).toBe("https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1");
    expect(SAME_ORIGIN_FIRST_MAP_FIXTURE).toBe("honua:first-map-fixture");
    const liveProducer = readFileSync(new URL("../scripts/first-map-live-evidence.mjs", import.meta.url), "utf8");
    expect(liveProducer).toContain(`const sourceEndpoint = ${JSON.stringify(PUBLIC_FIRST_MAP_ENDPOINT)}`);
    expect(liveProducer).toContain('runtime.sourceId !== "1"');
    expect(liveProducer).toContain('runtime.sourceAttribution !== "maui-parcels"');
    expect(liveProducer).toContain("!presentation.source?.includes(runtime.sourceAttribution)");
    const fixtureProducer = readFileSync(
      new URL("../examples/maplibre-quickstart/mock-server.mjs", import.meta.url),
      "utf8",
    );
    expect(fixtureProducer).toContain(
      `VITE_HONUA_QUICKSTART_ENDPOINT: ${JSON.stringify(SAME_ORIGIN_FIRST_MAP_FIXTURE)}`,
    );
    expect(() => resolveFirstMapConfig({ endpoint: "ftp://fixture.example/data" })).toThrow("only HTTP(S)");
    expect(() => resolveFirstMapConfig({ endpoint: "https://fixture.example/data?token=secret" })).toThrow(
      "cannot contain credentials",
    );
    expect(resolveFirstMapConfig({ endpoint: "https://fixture.example/data?f=pjson" }).endpoint).toBe(
      "https://fixture.example/data",
    );
    expect(() =>
      resolveFirstMapConfig({ endpoint: "https://fixture.example/data", maxFeatures: MAX_FIRST_MAP_FEATURES + 1 }),
    ).toThrow(`between 1 and ${MAX_FIRST_MAP_FEATURES}`);
    const config = resolveFirstMapConfig({
      endpoint: "https://fixture.example/data",
      maxFeatures: 10,
      query: { pagination: { limit: 100 }, returnGeometry: false },
    });
    expect(config.query).toMatchObject({ pagination: { limit: 10 }, returnGeometry: true });
  });

  it("switches only canonical same-origin fixture endpoints with the protocol control", () => {
    const origin = "https://samples.example.test";
    const geoservices = `${origin}${FIRST_MAP_FIXTURE_GEOSERVICES_PATH}`;
    const ogcCollection = `${origin}${FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH}`;
    const publishedBase = `${origin}/sdk/maplibre-quickstart/app/`;
    const publishedGeoservices = `${publishedBase}${FIRST_MAP_FIXTURE_GEOSERVICES_PATH.slice(1)}/`;
    const publishedOgcCollection = `${publishedBase}${FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH.slice(1)}`;

    expect(endpointForFirstMapProtocol(geoservices, "ogc-features", origin)).toBe(ogcCollection);
    expect(endpointForFirstMapProtocol(ogcCollection, "geoservices-feature-service", origin)).toBe(geoservices);
    expect(endpointForFirstMapProtocol(publishedGeoservices, "ogc-features", `${publishedBase}index.html`)).toBe(
      publishedOgcCollection,
    );
    expect(
      endpointForFirstMapProtocol(publishedOgcCollection, "geoservices-feature-service", `${publishedBase}index.html`),
    ).toBe(publishedGeoservices.slice(0, -1));
    expect(endpointForFirstMapProtocol(`${origin}/custom/FeatureServer/0`, "ogc-features", origin)).toBe(
      `${origin}/custom/FeatureServer/0`,
    );
    expect(
      endpointForFirstMapProtocol(
        `${publishedBase}custom/FeatureServer/0/`,
        "ogc-features",
        `${publishedBase}index.html`,
      ),
    ).toBe(`${publishedBase}custom/FeatureServer/0/`);
    expect(endpointForFirstMapProtocol(geoservices, "ogc-features", "https://other.example.test")).toBe(geoservices);
  });

  it("mechanically keeps the published-SDK workflow within 120 non-comment lines", () => {
    const source = readFileSync(new URL("../examples/maplibre-quickstart/src/workflow.ts", import.meta.url), "utf8");
    const codeLines = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("//"));
    expect(codeLines.length).toBeLessThanOrEqual(120);
    expect(source).not.toMatch(/(?:\.\.\/){3,}src\//);
    expect(source).toContain('from "@honua/sdk-js"');
    expect(source).toContain('from "@honua/sdk-js/runtime"');
  });
});
