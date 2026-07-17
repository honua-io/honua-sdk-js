import { describe, expect, it, vi } from "vitest";

import type { Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES, capabilities } from "../src/contract/types.js";
import {
  AUTOMATIC_MAPLIBRE_PLAN_KIND,
  HonuaAutomaticMapLibreStrategyError,
  type SourceToMapLibreMap,
  explainAutomaticSourceToMapLibre,
  mountAutomaticSourceToMapLibre,
} from "../src/map/index.js";
import { explainQuery } from "../src/query-planner/index.js";

class FakeMap implements SourceToMapLibreMap {
  readonly sources = new Map<string, unknown>();
  readonly layers = new Map<string, unknown>();
  readonly calls: string[] = [];
  failLayerAfterMutation = false;

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, source: unknown): void {
    this.calls.push(`addSource:${id}`);
    this.sources.set(id, source);
  }
  removeSource(id: string): void {
    this.calls.push(`removeSource:${id}`);
    this.sources.delete(id);
  }
  getLayer(id: string): unknown {
    return this.layers.get(id);
  }
  addLayer(layer: unknown): void {
    const id = String((layer as { id: unknown }).id);
    this.calls.push(`addLayer:${id}`);
    this.layers.set(id, layer);
    if (this.failLayerAfterMutation) throw new Error("host failure after layer mutation");
  }
  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    this.layers.delete(id);
  }
}

describe("automatic Source to MapLibre strategy", () => {
  it.each([
    {
      protocol: "maplibre-vector" as const,
      locator: { url: "https://tiles.test/parcels/{z}/{x}/{y}.pbf" },
      options: { sourceLayer: "parcels" },
      expected: "vector-tiles",
    },
    {
      protocol: "pmtiles" as const,
      locator: { url: "https://cdn.test/basemap.pmtiles" },
      options: { pmtilesType: "vector" as const, sourceLayer: "land" },
      expected: "pmtiles-vector",
    },
    {
      protocol: "pmtiles" as const,
      locator: { url: "https://cdn.test/imagery.pmtiles" },
      options: { pmtilesType: "raster" as const },
      expected: "pmtiles-raster",
    },
    {
      protocol: "maplibre-raster" as const,
      locator: { url: "https://tiles.test/imagery/{z}/{x}/{y}.webp" },
      options: {},
      expected: "native-raster-tiles",
    },
    {
      protocol: "wms" as const,
      locator: { url: "https://maps.test/wms", typeName: "parcels" },
      options: {},
      expected: "wms-raster",
    },
    {
      protocol: "wmts" as const,
      locator: { url: "https://maps.test/wmts", typeName: "imagery", tileMatrixSetId: "WebMercatorQuad" },
      options: {},
      expected: "wmts-raster",
    },
  ])("selects $expected deterministically", ({ protocol, locator, options, expected }) => {
    const plan = explainAutomaticSourceToMapLibre(fakeSource(descriptor(protocol, locator)), options);
    expect(plan.kind).toBe(AUTOMATIC_MAPLIBRE_PLAN_KIND);
    expect(plan.selected?.strategy).toBe(expected);
    expect(plan.candidates).toHaveLength(8);
    expect(plan.candidates.find((candidate) => candidate.strategy === expected)).toMatchObject({
      eligible: true,
      fidelity: "exact",
    });
    expect(plan.provenance.endpoint).not.toContain("?");
    if (expected === "native-raster-tiles" || expected === "wms-raster" || expected === "wmts-raster") {
      expect(plan.source?.type).toBe("raster");
      expect(plan.layers).toHaveLength(1);
    }
  });

  it("selects an accepted dynamic query-tile source ahead of a native tile locator", () => {
    const source = fakeSource(descriptor("maplibre-vector", { url: "https://tiles.test/static/{z}/{x}/{y}.pbf" }));
    const plan = explainAutomaticSourceToMapLibre(source, {
      sourceLayer: "parcels",
      queryTileSource: {
        type: "vector",
        tiles: ["https://demo.test/query-tiles/sources/parcels/{z}/{x}/{y}.mvt?cache=private"],
        volatile: true,
        bounds: [-158, 21, -157, 22],
      },
    });
    expect(plan.selected?.strategy).toBe("dynamic-query-tiles");
    expect(plan.bounds).toEqual([-158, 21, -157, 22]);
    expect(plan.source).toMatchObject({ type: "vector", volatile: true });
    expect(plan.candidates.find((candidate) => candidate.strategy === "vector-tiles")?.eligible).toBe(true);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: "vector-tiles", code: "eligible-not-selected", severity: "warning" }),
    );
  });

  it("projects corrected WMS request templates through the automatic strategy", () => {
    const source = fakeSource(
      descriptor("wms", { url: "https://maps.test/wms?tenant=oahu", typeName: "parcels", styleId: "default" }),
    );
    const plan = explainAutomaticSourceToMapLibre(source, { tileSize: 512 });
    const template = plan.source?.tiles?.[0];

    expect(plan.selected?.strategy).toBe("wms-raster");
    expect(plan.source?.tileSize).toBe(512);
    expect(template).toContain("tenant=oahu");
    expect(template).toContain("BBOX={bbox-epsg-3857}");
    expect(template).toContain("WIDTH=512");
    expect(template).toContain("HEIGHT=512");
    expect(template).not.toMatch(/\{(?:bbox-epsg3857|width|height)\}/u);
  });

  it("selects only a bounded accepted feature-query plan and binds provenance", () => {
    const input = descriptor("geoservices-feature-service", {
      url: "https://demo.test/FeatureServer?display=true",
      serviceId: "parcels",
      layerId: 0,
    });
    input.capabilities = capabilities(["query"]);
    const source = fakeSource(input);
    const queryPlan = explainQuery({
      descriptor: input,
      query: { pagination: { limit: 500 }, returnGeometry: true },
      sourceVersion: "snapshot-4",
      schemaVersion: "schema-2",
      authorizationScope: ["parcels:read"],
    });
    const plan = explainAutomaticSourceToMapLibre(source, { queryPlan });
    expect(plan.selected?.strategy).toBe("geojson-query");
    expect(plan.selected).toMatchObject({ dataPath: "materialized", fidelity: "exact" });
    expect(plan.cache).toBe("query-plan-bypass");
    expect(plan.provenance).toMatchObject({
      endpoint: "https://demo.test/FeatureServer",
      sourceVersion: "snapshot-4",
      authorizationScope: ["parcels:read"],
      queryPlanFingerprint: queryPlan.fingerprint,
    });

    const other = { ...input, id: "other source" };
    const foreignPlan = explainQuery({
      descriptor: other,
      query: { pagination: { limit: 500 }, returnGeometry: true },
    });
    expect(explainAutomaticSourceToMapLibre(source, { queryPlan: foreignPlan }).candidates).toContainEqual(
      expect.objectContaining({ strategy: "geojson-query", reason: "plan-context-mismatch" }),
    );
  });

  it("fails closed for unbounded materialization, unsafe URLs, unsupported CRS, stale evidence, and overrides", () => {
    const queryDescriptor = descriptor("geoservices-feature-service", {
      url: "https://demo.test/FeatureServer",
      serviceId: "parcels",
      layerId: 0,
    });
    queryDescriptor.capabilities = capabilities(["query"]);
    const unbounded = explainQuery({ descriptor: queryDescriptor, query: { returnGeometry: true } });
    expect(
      explainAutomaticSourceToMapLibre(fakeSource(queryDescriptor), { queryPlan: unbounded }).selected,
    ).toBeUndefined();
    expect(
      explainAutomaticSourceToMapLibre(fakeSource(queryDescriptor), { queryPlan: unbounded }).candidates.find(
        (candidate) => candidate.strategy === "geojson-query",
      ),
    ).toMatchObject({ reason: "unbounded-materialization" });

    const unsafe = descriptor("maplibre-vector", { url: "https://tiles.test/{z}/{x}/{y}.pbf?token=secret" });
    expect(explainAutomaticSourceToMapLibre(fakeSource(unsafe), { sourceLayer: "x" }).selected).toBeUndefined();

    const signedWms = descriptor("wms", {
      url: "https://maps.test/wms?X-Amz-Signature=secret",
      typeName: "parcels",
    });
    expect(explainAutomaticSourceToMapLibre(fakeSource(signedWms)).candidates).toContainEqual(
      expect.objectContaining({ strategy: "wms-raster", reason: "unsafe-url" }),
    );

    const oversizedWms = descriptor("wms", { url: "https://maps.test/wms", typeName: "parcels" });
    expect(explainAutomaticSourceToMapLibre(fakeSource(oversizedWms), { tileSize: 4_097 }).candidates).toContainEqual(
      expect.objectContaining({ strategy: "wms-raster", reason: "invalid-option" }),
    );

    const crs = descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.png", srsName: "EPSG:26904" });
    expect(explainAutomaticSourceToMapLibre(fakeSource(crs)).candidates).toContainEqual(
      expect.objectContaining({ strategy: "native-raster-tiles", reason: "unsupported-crs" }),
    );

    const stale = explainAutomaticSourceToMapLibre(
      fakeSource(descriptor("pmtiles", { url: "https://cdn.test/a.pmtiles" })),
      {
        pmtilesType: "raster",
        evidence: { observedAt: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:11Z", maxAgeMs: 10_000 },
      },
    );
    expect(stale.selected).toBeUndefined();
    expect(stale.diagnostics.every((entry) => entry.code === "stale-evidence")).toBe(true);

    const override = explainAutomaticSourceToMapLibre(
      fakeSource(descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.png" })),
      { override: "pmtiles-raster" },
    );
    expect(override.selected).toBeUndefined();
    expect(override.diagnostics).toContainEqual(expect.objectContaining({ code: "override-mismatch" }));
  });

  it("mounts native plans transactionally, refreshes, cancels, and cleans up exactly once", async () => {
    const source = fakeSource(descriptor("pmtiles", { url: "https://cdn.test/a.pmtiles" }));
    const options = { pmtilesType: "vector" as const, sourceLayer: "places" };
    const plan = explainAutomaticSourceToMapLibre(source, options);
    const map = new FakeMap();
    const mounted = await mountAutomaticSourceToMapLibre(map, source, plan, options);
    expect(mounted.state).toBe("ready");
    expect(await mounted.ready).toBe(plan);
    expect(await mounted.refresh()).toBe(plan);
    mounted.cancel("viewport replaced");
    mounted.cancel();
    mounted.dispose();
    expect(mounted.state).toBe("cancelled");
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.calls.filter((call) => call.startsWith("removeSource"))).toHaveLength(1);
    await expect(mounted.refresh()).rejects.toBeInstanceOf(HonuaAutomaticMapLibreStrategyError);
  });

  it("rolls back a partial native host mutation", async () => {
    const source = fakeSource(descriptor("maplibre-vector", { url: "https://tiles.test/{z}/{x}/{y}.pbf" }));
    const options = { sourceLayer: "parcels" };
    const plan = explainAutomaticSourceToMapLibre(source, options);
    const map = new FakeMap();
    map.failLayerAfterMutation = true;
    await expect(mountAutomaticSourceToMapLibre(map, source, plan, options)).rejects.toMatchObject({
      code: "map-mutation-failed",
    });
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });

  it("rejects a plan when source identity changes before mount", async () => {
    const original = fakeSource(descriptor("maplibre-vector", { url: "https://tiles.test/a/{z}/{x}/{y}.pbf" }));
    const options = { sourceLayer: "parcels" };
    const plan = explainAutomaticSourceToMapLibre(original, options);
    const changed = fakeSource(descriptor("maplibre-vector", { url: "https://tiles.test/b/{z}/{x}/{y}.pbf" }));
    await expect(mountAutomaticSourceToMapLibre(new FakeMap(), changed, plan, options)).rejects.toMatchObject({
      code: "stale-plan",
    });

    const tampered = { ...plan, layers: [{ ...plan.layers[0], id: "injected-layer" }] };
    await expect(mountAutomaticSourceToMapLibre(new FakeMap(), original, tampered, options)).rejects.toMatchObject({
      code: "stale-plan",
    });
  });

  it("honors pre-aborted cancellation before renderer mutation", async () => {
    const source = fakeSource(descriptor("maplibre-raster", { url: "https://tiles.test/{z}/{x}/{y}.png" }));
    const plan = explainAutomaticSourceToMapLibre(source);
    const controller = new AbortController();
    controller.abort("superseded");
    const map = new FakeMap();
    await expect(
      mountAutomaticSourceToMapLibre(map, source, plan, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(map.calls).toEqual([]);
  });
});

function descriptor(protocol: SourceDescriptor["protocol"], locator: SourceDescriptor["locator"]): SourceDescriptor {
  return {
    id: "sample source",
    protocol,
    locator,
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES[protocol],
    attribution: "Honua fixture",
  };
}

function fakeSource<T = Record<string, unknown>>(input: SourceDescriptor): Source<T> {
  const empty: Result<T> = { features: [], exceededTransferLimit: false };
  return {
    descriptor: input,
    capabilities: input.capabilities,
    query: vi.fn(async (_query: Query<T>) => empty),
    queryAll: vi.fn(async (_query: Query<T>) => empty),
  } as unknown as Source<T>;
}
