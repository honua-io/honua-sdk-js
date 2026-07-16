import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_FIRST_MAP_FEATURES, resolveFirstMapConfig } from "../examples/maplibre-quickstart/src/first-map-config.js";
import { runFirstMapWorkflow } from "../examples/maplibre-quickstart/src/workflow.js";
import { type SampleFixtureHarness, loadFixturePack, startSampleFixtureHarness } from "../samples/scenarios/index.mjs";

const fixturePack = loadFixturePack("first-map");
const fixtureFiles = fixturePack.manifest.schema.files as Record<string, string>;

function fixture<T>(role: string): T {
  return structuredClone(fixturePack.data[fixtureFiles[role]!]) as T;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function multiCollectionFetch(): typeof fetch {
  const collection = fixture<Record<string, unknown>>("ogcCollection");
  const second = structuredClone(collection);
  second.id = "response-zones";
  second.title = "Response zones";
  return async (input, init) => {
    const { pathname } = new URL(new Request(input, init).url);
    if (pathname === "/ogc/features") return json(fixture("ogcLanding"));
    if (pathname === "/ogc/features/conformance") return json(fixture("ogcConformance"));
    if (pathname === "/ogc/features/collections") return json({ collections: [collection, second] });
    return new Response("Not found", { status: 404 });
  };
}

describe("First Map workflow core", () => {
  let harness: SampleFixtureHarness;

  beforeAll(async () => {
    harness = await startSampleFixtureHarness({ sampleId: "first-map" });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("connects the deterministic GeoServices projection and returns a bounded strategy handoff", async () => {
    const result = await runFirstMapWorkflow(
      resolveFirstMapConfig({
        endpoint: `${harness.origin}/rest/services/natural-earth/FeatureServer/0`,
        mode: "fixture",
        maxFeatures: 2,
      }),
    );

    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.view).toMatchObject({
      mode: "fixture",
      connection: { protocol: "geoservices-feature-service", cacheStatus: "miss" },
      source: {
        id: "0",
        protocol: "geoservices-feature-service",
        capabilities: expect.arrayContaining(["query"]),
      },
      strategy: "geojson",
      maxFeatures: 2,
    });
    expect(result.mount.options).toMatchObject({
      strategy: "geojson",
      maxGeoJsonFeatures: 2,
      query: { pagination: { limit: 2 }, returnGeometry: true },
    });
    expect(result.mount.source.descriptor.id).toBe("0");
    const requests = (await (await fetch(`${harness.origin}/__fixture__/runs/default/requests`)).json()) as {
      requests: Array<{ routeId: string }>;
    };
    expect(requests.requests.some(({ routeId }) => routeId === "first-map-query")).toBe(false);
    await result.dispose();
    await expect(result.dispose()).resolves.toBeUndefined();
  });

  it("connects the same fixture through OGC API Features with an explicit protocol and source", async () => {
    const result = await runFirstMapWorkflow(
      resolveFirstMapConfig({
        endpoint: `${harness.origin}/ogc/features`,
        mode: "fixture",
        protocol: "ogc-features",
        sourceId: "operations-areas",
      }),
    );

    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.view.connection.protocol).toBe("ogc-features");
    expect(result.view.source).toMatchObject({
      id: "operations-areas",
      capabilities: expect.arrayContaining(["query"]),
    });
    expect(result.view.strategyReasons[0]?.code).toBe("query-capability");
    await result.dispose();
  });

  it("never chooses the first advertised source under ambiguity", async () => {
    const base = { endpoint: "https://fixture.example/ogc/features", protocol: "ogc-features" as const };
    const ambiguous = await runFirstMapWorkflow(resolveFirstMapConfig(base), { fetchFn: multiCollectionFetch() });

    expect(ambiguous).toMatchObject({
      state: "source-selection-required",
      reason: "ambiguous",
      sources: [{ id: "operations-areas" }, { id: "response-zones" }],
    });

    const invalid = await runFirstMapWorkflow(resolveFirstMapConfig({ ...base, sourceId: "missing" }), {
      fetchFn: multiCollectionFetch(),
    });
    expect(invalid).toMatchObject({ state: "source-selection-required", reason: "invalid-selection" });

    const selected = await runFirstMapWorkflow(resolveFirstMapConfig({ ...base, sourceId: "response-zones" }), {
      fetchFn: multiCollectionFetch(),
    });
    expect(selected).toMatchObject({ state: "ready", view: { source: { id: "response-zones" } } });
    if (selected.state === "ready") await selected.dispose();
  });

  it("preserves unsupported, authentication, and malformed-response states", async () => {
    const unsupportedHarness = await startSampleFixtureHarness({
      sampleId: "first-map",
      defaultRunId: "unsupported",
      defaultScenario: "unsupported",
    });
    try {
      const unsupported = await runFirstMapWorkflow(
        resolveFirstMapConfig({
          endpoint: `${unsupportedHarness.origin}/rest/services/natural-earth/FeatureServer/0`,
          mode: "fixture",
        }),
      );
      expect(unsupported).toMatchObject({
        state: "unsupported",
        error: { code: "core.capability-not-supported", retryable: false },
      });
    } finally {
      await unsupportedHarness.close();
    }

    const endpoint = "https://fixture.example/rest/services/public/FeatureServer/0";
    const authentication = await runFirstMapWorkflow(resolveFirstMapConfig({ endpoint }), {
      fetchFn: async () => json({ error: { message: "Authentication required" } }, 401),
    });
    expect(authentication).toMatchObject({
      state: "authentication-required",
      error: { code: "core.http.rejected", retryable: false },
    });
    const expired = await runFirstMapWorkflow(resolveFirstMapConfig({ endpoint }), {
      fetchFn: async () => json({ error: { code: 498, message: "Token expired" } }),
    });
    expect(expired.state).toBe("authentication-required");

    const malformed = await runFirstMapWorkflow(resolveFirstMapConfig({ endpoint }), {
      fetchFn: async () => new Response("not-json", { status: 200 }),
    });
    expect(malformed.state).toBe("error");
  });

  it("validates the public URL and materialization bound before network work", () => {
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
    expect(
      resolveFirstMapConfig({
        endpoint: "https://fixture.example/data",
        maxFeatures: 10,
        query: { pagination: { limit: 100 } },
      }).query.pagination?.limit,
    ).toBe(10);
  });

  it("keeps the copyable workflow within the 120-line non-comment budget", () => {
    const source = readFileSync(new URL("../examples/maplibre-quickstart/src/workflow.ts", import.meta.url), "utf8");
    const codeLines = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("//"));
    expect(codeLines.length).toBeLessThanOrEqual(120);
  });
});
