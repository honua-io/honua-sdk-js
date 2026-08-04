/**
 * Runtime wiring for persisted offline regions: `offline-region://` protocol
 * auto-registration (idempotent, evidence-driven, injectable), lossless and
 * reversible style tile-template rewriting, and `loadMapPackage` failing closed
 * when a style addresses a region it has no handler for.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type MaplibreMap,
  type MaplibreProtocolRegistrar,
  OFFLINE_REGION_PROTOCOL_SCHEME,
  type OfflineRegionTileHandler,
  ensureOfflineRegionProtocol,
  isOfflineRegionProtocolRegistered,
  isPmtilesProtocolRegistered,
  loadMapPackage,
  resetOfflineRegionProtocol,
  resetPmtilesProtocol,
  revertOfflineRegionStyleRewrite,
  rewriteStyleTilesForOfflineRegion,
  styleUsesOfflineRegion,
} from "../src/runtime/index.js";
import { makeMockClient } from "./contract/shared.js";

const TILE_HANDLER: OfflineRegionTileHandler = async () => ({ data: new ArrayBuffer(4) });

function fakeRegistrar(): { registrar: MaplibreProtocolRegistrar; added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  return {
    registrar: {
      addProtocol(scheme) {
        added.push(scheme);
      },
      removeProtocol(scheme) {
        removed.push(scheme);
      },
    },
    added,
    removed,
  };
}

function tileStyle(overrides: Record<string, unknown> = {}) {
  return {
    version: 8,
    sources: {
      incidents: { type: "vector", tiles: ["https://tiles.example.test/incidents/{z}/{x}/{y}.pbf"], maxzoom: 14 },
      basemap: { type: "raster", tiles: ["https://tiles.example.test/base/{z}/{x}/{y}.png"], tileSize: 256 },
      places: { type: "geojson", data: "https://example.test/places.geojson" },
      catalog: { type: "vector", url: "https://tiles.example.test/incidents.json" },
      ...overrides,
    },
    layers: [],
    sprite: "https://example.test/sprite",
    glyphs: "https://example.test/{fontstack}/{range}.pbf",
  };
}

afterEach(() => {
  resetOfflineRegionProtocol();
  resetPmtilesProtocol();
});

describe("offline region protocol registration", () => {
  it("registers once and stays registered across concurrent callers", async () => {
    const { registrar, added } = fakeRegistrar();
    expect(isOfflineRegionProtocolRegistered()).toBe(false);
    await Promise.all([
      ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar }),
      ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar }),
    ]);
    await ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar });
    expect(added).toEqual([OFFLINE_REGION_PROTOCOL_SCHEME]);
    expect(isOfflineRegionProtocolRegistered()).toBe(true);
  });

  it("registers the caller's handler rather than building one", async () => {
    const handlers: unknown[] = [];
    const registrar: MaplibreProtocolRegistrar = {
      addProtocol: (_scheme, handler) => {
        handlers.push(handler);
      },
    };
    await ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar });
    expect(handlers).toEqual([TILE_HANDLER]);
  });

  it("keys registration by scheme so releasing one leaves the other alone", async () => {
    const { registrar, added, removed } = fakeRegistrar();
    await ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar });
    await ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar, scheme: "offline-archive" });
    expect(added).toEqual([OFFLINE_REGION_PROTOCOL_SCHEME, "offline-archive"]);
    expect(isOfflineRegionProtocolRegistered("offline-archive")).toBe(true);

    resetOfflineRegionProtocol("offline-archive");
    expect(removed).toEqual(["offline-archive"]);
    expect(isOfflineRegionProtocolRegistered("offline-archive")).toBe(false);
    // The shared registry is per-scheme: PMTiles and the default region scheme
    // are untouched by releasing a third one.
    expect(isOfflineRegionProtocolRegistered()).toBe(true);
    expect(isPmtilesProtocolRegistered()).toBe(false);
  });

  it("refuses to register without a handler instead of registering nothing", async () => {
    const { registrar, added } = fakeRegistrar();
    await expect(
      ensureOfflineRegionProtocol({ maplibre: registrar } as unknown as { tileHandler: OfflineRegionTileHandler }),
    ).rejects.toThrowError(/tile handler is required/);
    expect(added).toEqual([]);
  });

  it("does not remember a failed registration", async () => {
    let attempts = 0;
    const registrar: MaplibreProtocolRegistrar = {
      addProtocol: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("registrar unavailable");
      },
    };
    await expect(ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar })).rejects.toThrowError(
      /registrar unavailable/,
    );
    expect(isOfflineRegionProtocolRegistered()).toBe(false);
    await ensureOfflineRegionProtocol({ tileHandler: TILE_HANDLER, maplibre: registrar });
    expect(isOfflineRegionProtocolRegistered()).toBe(true);
  });

  it("detects the scheme in either a url or a tiles array", () => {
    expect(styleUsesOfflineRegion(tileStyle())).toBe(false);
    expect(
      styleUsesOfflineRegion({ sources: { a: { type: "vector", tiles: ["offline-region://default/1/0/0"] } } }),
    ).toBe(true);
    expect(styleUsesOfflineRegion({ sources: { a: { type: "vector", url: "offline-region://default/x" } } })).toBe(
      true,
    );
    expect(styleUsesOfflineRegion(undefined)).toBe(false);
    expect(styleUsesOfflineRegion({ sources: {} })).toBe(false);
  });
});

describe("offline region style rewriting", () => {
  it("rewrites only the named tile templates and nothing else", () => {
    const style = tileStyle();
    const before = structuredClone(style);
    const rewrite = rewriteStyleTilesForOfflineRegion(style, { sourceIds: ["incidents", "basemap"] });

    expect(rewrite.refusals).toEqual([]);
    expect(rewrite.rewrites).toEqual([
      {
        sourceId: "incidents",
        member: "tiles",
        index: 0,
        from: "https://tiles.example.test/incidents/{z}/{x}/{y}.pbf",
        to: "offline-region://default/{z}/{x}/{y}",
      },
      {
        sourceId: "basemap",
        member: "tiles",
        index: 0,
        from: "https://tiles.example.test/base/{z}/{x}/{y}.png",
        to: "offline-region://default/{z}/{x}/{y}",
      },
    ]);
    const sources = (rewrite.style as ReturnType<typeof tileStyle>).sources as Record<string, Record<string, unknown>>;
    expect(sources.incidents?.tiles).toEqual(["offline-region://default/{z}/{x}/{y}"]);
    expect(sources.incidents?.maxzoom).toBe(14);
    expect(sources.basemap?.tileSize).toBe(256);
    // Non-tile members are never touched.
    expect(sources.places).toEqual(before.sources.places);
    expect(sources.catalog).toEqual(before.sources.catalog);
    expect((rewrite.style as Record<string, unknown>).sprite).toBe("https://example.test/sprite");
    expect((rewrite.style as Record<string, unknown>).glyphs).toBe("https://example.test/{fontstack}/{range}.pbf");
    // The input style is never mutated.
    expect(style).toEqual(before);
  });

  it("round-trips back to the original style exactly", () => {
    const style = tileStyle();
    const before = structuredClone(style);
    const rewrite = rewriteStyleTilesForOfflineRegion(style, { sourceIds: ["incidents", "basemap"] });
    expect(revertOfflineRegionStyleRewrite(rewrite.style, rewrite)).toEqual(before);
  });

  it("honours a tile-matrix-set segment", () => {
    const rewrite = rewriteStyleTilesForOfflineRegion(tileStyle(), {
      sourceIds: ["incidents"],
      tileMatrixSetId: "WebMercatorQuad",
    });
    const sources = (rewrite.style as ReturnType<typeof tileStyle>).sources as Record<string, Record<string, unknown>>;
    expect(sources.incidents?.tiles).toEqual(["offline-region://WebMercatorQuad/{z}/{x}/{y}"]);
  });

  it("refuses every shape it cannot rewrite exactly", () => {
    const style = tileStyle({
      both: { type: "vector", url: "https://x.test/t.json", tiles: ["https://x.test/{z}/{x}/{y}"] },
      many: { type: "raster", tiles: ["https://a.test/{z}/{x}/{y}", "https://b.test/{z}/{x}/{y}"] },
      quadkey: { type: "raster", tiles: ["https://x.test/{quadkey}"] },
      ratio: { type: "raster", tiles: ["https://x.test/{z}/{x}/{y}{ratio}.png"] },
      partial: { type: "raster", tiles: ["https://x.test/{z}/{x}.png"] },
      already: { type: "vector", tiles: ["offline-region://default/{z}/{x}/{y}"] },
    });
    const rewrite = rewriteStyleTilesForOfflineRegion(style, {
      sourceIds: ["places", "catalog", "both", "many", "quadkey", "ratio", "partial", "already", "absent"],
    });
    expect(rewrite.rewrites).toEqual([]);
    expect(rewrite.style).toBe(style);
    expect(rewrite.refusals.map((refusal) => [refusal.sourceId, refusal.reason])).toEqual([
      ["places", "not-a-tile-source"],
      ["catalog", "tilejson-url-only"],
      ["both", "ambiguous-tile-source"],
      ["many", "multiple-tile-templates"],
      ["quadkey", "unsupported-tile-template"],
      ["ratio", "unsupported-tile-template"],
      ["partial", "unsupported-tile-template"],
      ["already", "already-rewritten"],
      ["absent", "unknown-source"],
    ]);
    for (const refusal of rewrite.refusals) expect(refusal.detail.length).toBeGreaterThan(0);
  });

  it("rewrites the sources it can even when another is refused", () => {
    const rewrite = rewriteStyleTilesForOfflineRegion(tileStyle(), { sourceIds: ["incidents", "places"] });
    expect(rewrite.rewrites).toHaveLength(1);
    expect(rewrite.refusals.map((refusal) => refusal.reason)).toEqual(["not-a-tile-source"]);
  });

  it("refuses a partial revert rather than corrupting a style", () => {
    const rewrite = rewriteStyleTilesForOfflineRegion(tileStyle(), { sourceIds: ["incidents"] });
    const tampered = structuredClone(rewrite.style) as ReturnType<typeof tileStyle>;
    (tampered.sources.incidents as Record<string, unknown>).tiles = ["https://elsewhere.test/{z}/{x}/{y}"];
    expect(() => revertOfflineRegionStyleRewrite(tampered, rewrite)).toThrowError(/refusing a partial revert/);
  });

  it("requires at least one source id and a usable matrix-set segment", () => {
    expect(() => rewriteStyleTilesForOfflineRegion(tileStyle(), { sourceIds: [] })).toThrowError(
      /at least one style source id/,
    );
    expect(() =>
      rewriteStyleTilesForOfflineRegion(tileStyle(), { sourceIds: ["incidents"], tileMatrixSetId: "a/b" }),
    ).toThrowError(/path segment/);
  });
});

describe("loadMapPackage offline-region binding", () => {
  const pkg = {
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    mapPackageId: "offline-region-package",
    sourceBindings: [],
    mapSpec: {
      version: 8 as const,
      sources: {
        incidents: { type: "vector" as const, tiles: ["https://tiles.example.test/incidents/{z}/{x}/{y}.pbf"] },
      },
      layers: [],
    },
  };

  function fakeMap(): MaplibreMap & { style?: unknown } {
    const map: Record<string, unknown> = {
      setStyle(style: unknown) {
        map.style = style;
      },
      addSource() {},
      removeSource() {},
      getSource: () => undefined,
      addLayer() {},
      removeLayer() {},
      getLayer: () => undefined,
      setPaintProperty() {},
      setLayoutProperty() {},
      setFilter() {},
      jumpTo() {},
      fitBounds() {},
      on() {},
      off() {},
    };
    return map as unknown as MaplibreMap & { style?: unknown };
  }

  it("rewrites the named sources and registers the protocol before setStyle", async () => {
    const { registrar, added } = fakeRegistrar();
    const map = fakeMap();
    const runtime = await loadMapPackage(pkg, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      offlineRegion: { tileHandler: TILE_HANDLER, sourceIds: ["incidents"], maplibre: registrar },
    });
    const style = map.style as { sources: Record<string, { tiles?: readonly string[] }> };
    expect(style.sources.incidents?.tiles).toEqual(["offline-region://default/{z}/{x}/{y}"]);
    expect(added).toEqual([OFFLINE_REGION_PROTOCOL_SCHEME]);
    runtime.dispose();
  });

  it("fails the load when a named source cannot be rewritten exactly", async () => {
    const map = fakeMap();
    await expect(
      loadMapPackage(pkg, map, {
        client: makeMockClient({ routes: [] }),
        skipCompatibilityCheck: true,
        offlineRegion: { tileHandler: TILE_HANDLER, sourceIds: ["incidents", "missing"] },
      }),
    ).rejects.toMatchObject({ stage: "style-compose" });
    // Nothing was handed to the map: the failure is before setStyle.
    expect(map.style).toBeUndefined();
  });

  it("fails closed when a style addresses a region with no handler supplied", async () => {
    const map = fakeMap();
    const authored = {
      ...pkg,
      mapSpec: {
        ...pkg.mapSpec,
        sources: { incidents: { type: "vector" as const, tiles: ["offline-region://default/{z}/{x}/{y}"] } },
      },
    };
    await expect(
      loadMapPackage(authored, map, { client: makeMockClient({ routes: [] }), skipCompatibilityCheck: true }),
    ).rejects.toMatchObject({ stage: "style-compose" });
    expect(map.style).toBeUndefined();
    expect(isOfflineRegionProtocolRegistered()).toBe(false);
  });

  it("registers an already-rewritten style without touching its sources", async () => {
    const { registrar, added } = fakeRegistrar();
    const map = fakeMap();
    const authored = {
      ...pkg,
      mapSpec: {
        ...pkg.mapSpec,
        sources: { incidents: { type: "vector" as const, tiles: ["offline-region://default/{z}/{x}/{y}"] } },
      },
    };
    const runtime = await loadMapPackage(authored, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      offlineRegion: { tileHandler: TILE_HANDLER, maplibre: registrar },
    });
    expect(added).toEqual([OFFLINE_REGION_PROTOCOL_SCHEME]);
    const style = map.style as { sources: Record<string, { tiles?: readonly string[] }> };
    expect(style.sources.incidents?.tiles).toEqual(["offline-region://default/{z}/{x}/{y}"]);
    runtime.dispose();
  });

  it("leaves a package that never mentions a region completely alone", async () => {
    const map = fakeMap();
    const runtime = await loadMapPackage(pkg, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
    });
    const style = map.style as { sources: Record<string, { tiles?: readonly string[] }> };
    expect(style.sources.incidents?.tiles).toEqual(["https://tiles.example.test/incidents/{z}/{x}/{y}.pbf"]);
    expect(isOfflineRegionProtocolRegistered()).toBe(false);
    runtime.dispose();
  });
});
