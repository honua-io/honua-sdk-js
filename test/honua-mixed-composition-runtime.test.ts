/**
 * End-to-end coverage for the `#22` mixed-protocol composition surface:
 * a 4-protocol `MapPackage` (GeoServices Feature + OGC Features + WMS
 * basemap + MapLibre-native vector tiles) is loaded through the
 * canonical runtime pipeline against mock adapters, and we assert that
 *
 *   - every source binds and emits `source-ready`,
 *   - the composed style includes one layer per binding plus the
 *     background,
 *   - `intersectCapabilities` reports the honest weakest set across
 *     the live `Source` instances,
 *   - per-source canonical queries succeed in isolation against the
 *     mock fetch routes,
 *   - tolerant binding suppresses one bad source while the rest of
 *     the composition keeps rendering and the runtime emits exactly
 *     one `source-error` event for the failed source.
 *
 * This test uses an in-process mock `MaplibreMap` and the
 * `HonuaClient` `fetchFn` injection seam so it stays hermetic — no
 * network, no MapLibre binding, no built dist — while exercising the
 * same `loadMapPackage` path operator components will consume in
 * production.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, intersectCapabilities } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaMap } from "../src/map/honua-map.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  type HonuaRuntimeEvent,
  type MaplibreMap,
  loadMapPackage,
} from "../src/runtime/index.js";

interface MockCall {
  method: string;
  args: unknown[];
}

function makeMockMap(): MaplibreMap & { _calls: MockCall[]; _style: unknown } {
  const calls: MockCall[] = [];
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };
  let style: unknown = {};
  const map = {
    _calls: calls,
    _style: style,
    setStyle(next: unknown) {
      record("setStyle", [next]);
      style = next;
      map._style = next;
    },
    getStyle() {
      return map._style;
    },
    addSource(id: string, source: unknown) {
      record("addSource", [id, source]);
    },
    removeSource(id: string) {
      record("removeSource", [id]);
    },
    addLayer(layer: unknown, beforeId?: string) {
      record("addLayer", [layer, beforeId]);
    },
    removeLayer(id: string) {
      record("removeLayer", [id]);
    },
    setLayoutProperty(layerId: string, name: string, value: unknown) {
      record("setLayoutProperty", [layerId, name, value]);
    },
    setPaintProperty(layerId: string, name: string, value: unknown) {
      record("setPaintProperty", [layerId, name, value]);
    },
    setFilter(layerId: string, filter: unknown) {
      record("setFilter", [layerId, filter]);
    },
    fitBounds(bounds: unknown, options?: unknown) {
      record("fitBounds", [bounds, options]);
    },
    jumpTo(options: unknown) {
      record("jumpTo", [options]);
    },
    setFeatureState() {
      // unused
    },
    getFeatureState() {
      return {};
    },
    removeFeatureState() {
      // unused
    },
    on() {
      // unused
    },
    off() {
      // unused
    },
  } as MaplibreMap & { _calls: MockCall[]; _style: unknown };
  return map;
}

function makeMockFetch(): {
  fetchFn: typeof fetch;
  recorded: Array<{ method: string; url: string }>;
} {
  const recorded: Array<{ method: string; url: string }> = [];
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = String(init?.method ?? "GET").toUpperCase();
    recorded.push({ method, url: href });

    // GeoServices FeatureServer query path.
    if (url.pathname.endsWith("/FeatureServer/0/query")) {
      return new Response(
        JSON.stringify({
          features: [
            { attributes: { OBJECTID: 1, NAME: "Lot A" }, geometry: { x: -121, y: 38 } },
            { attributes: { OBJECTID: 2, NAME: "Lot B" }, geometry: { x: -120.5, y: 38.5 } },
          ],
          fields: [
            { name: "OBJECTID", type: "esriFieldTypeOID" },
            { name: "NAME", type: "esriFieldTypeString" },
          ],
          exceededTransferLimit: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // OGC Features collection items.
    if (url.pathname.endsWith("/ogc/features/collections/parcels/items")) {
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "p-1",
              properties: { status: "active" },
              geometry: { type: "Point", coordinates: [-121, 38] },
            },
            {
              type: "Feature",
              id: "p-2",
              properties: { status: "review" },
              geometry: { type: "Point", coordinates: [-120, 38.5] },
            },
            {
              type: "Feature",
              id: "p-3",
              properties: { status: "active" },
              geometry: { type: "Point", coordinates: [-122, 39] },
            },
          ],
          numberMatched: 3,
          numberReturned: 3,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.pathname.endsWith("/ogc/features/collections/parcels")) {
      return new Response(
        JSON.stringify({
          id: "parcels",
          extent: { spatial: { bbox: [[-123, 37, -120, 45]] } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // No other endpoints are exercised — render-only sources (WMS,
    // vector_tile) don't fan-out to fetch in this composition flow.
    return new Response(JSON.stringify({ message: `unhandled ${method} ${url.pathname}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn: handler as typeof fetch, recorded };
}

function makeMixedPackage(overrides: { ogcLocatorUrl?: string } = {}): HonuaMapPackage {
  return {
    mapPackageId: "mixed-composition-pkg",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://mock.honua.test/rest/services/Parcels/FeatureServer/0" },
      },
      {
        sourceId: "imagery",
        protocol: "wms",
        locator: {
          url: "https://mock.honua.test/ogc/services/imagery/wms",
          serviceId: "imagery",
          typeName: "imagery:base",
        },
      },
      {
        sourceId: "ogc-overlay",
        protocol: "ogc_features",
        locator: {
          url: overrides.ogcLocatorUrl ?? "https://mock.honua.test/ogc/features/collections/parcels",
        },
      },
      {
        sourceId: "basemap-tiles",
        protocol: "vector_tile",
        locator: { url: "https://mock.honua.test/tiles/{z}/{x}/{y}.pbf" },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#ffffff" } },
        { id: "imagery-raster", type: "raster", source: "imagery" },
        { id: "basemap-line", type: "line", source: "basemap-tiles", paint: { "line-color": "#000000" } },
        { id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } },
        { id: "ogc-circle", type: "circle", source: "ogc-overlay", paint: { "circle-radius": 4 } },
      ],
    },
  };
}

describe("honua mixed composition runtime (E2E, 4 protocols)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "binds GeoServices + OGC Features + WMS basemap + vector tiles through one loadMapPackage call",
    { timeout: 30_000 },
    async () => {
      const map = makeMockMap();
      const { fetchFn, recorded } = makeMockFetch();
      const client = new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });
      const events: HonuaRuntimeEvent[] = [];

      const runtime = await loadMapPackage(makeMixedPackage(), map, {
        client,
        skipCompatibilityCheck: true,
        applyInitialView: false,
        onEvent: (event) => events.push(event),
      });

      // All 4 sources land in the composed style — three protocol-backed
      // and one MapLibre-native vector tile basemap.
      const sourceIds = Object.keys(runtime.composedStyle.sources).sort();
      expect(sourceIds).toEqual(["basemap-tiles", "imagery", "ogc-overlay", "parcels"]);

      // The composed style retains every layer the package shipped.
      const layerIds = runtime.composedStyle.layers.map((l) => l.id).sort();
      expect(layerIds).toEqual(["background", "basemap-line", "imagery-raster", "ogc-circle", "parcels-fill"]);

      // source-ready events for the 3 dataset-tracked sources (vector
      // tiles bypass `Dataset` and flow directly into the style).
      const ready = events
        .filter((e) => e.type === "source-ready")
        .map((e) => (e as { sourceId: string }).sourceId)
        .sort();
      expect(ready).toEqual(["imagery", "ogc-overlay", "parcels"]);

      // No source-error events on the success path.
      expect(events.some((e) => e.type === "source-error")).toBe(false);
      expect(events.some((e) => e.type === "package-loaded")).toBe(true);

      // intersectCapabilities reports the weakest set across the
      // dataset descriptors. WMS contributes only `render`/`tiles`/
      // `query` so the tri-source intersection collapses to `query`
      // (FS/OGC/WMS all expose query).
      const weakest = intersectCapabilities(runtime.dataset.sourceDescriptors);
      expect([...weakest]).toEqual(["query"]);
      expect(weakest.has("applyEdits")).toBe(false);

      // Per-source query against the FS adapter exercises the canonical
      // `Source.query` envelope — proving the mixed composition didn't
      // break per-protocol query semantics.
      const fs = runtime.dataset.source("parcels")!;
      const fsResult = await fs.query({ where: "1=1" });
      expect(fsResult.features.map((f) => f.attributes)).toEqual([
        { OBJECTID: 1, NAME: "Lot A" },
        { OBJECTID: 2, NAME: "Lot B" },
      ]);

      const ogc = runtime.dataset.source("ogc-overlay")!;
      const ogcResult = await ogc.query({ where: "1=1" });
      expect(ogcResult.features).toHaveLength(3);

      // The mock fetch handled the FS query and the OGC items request —
      // proves both adapters reach their respective wire endpoints from
      // a single composed dataset.
      expect(recorded.some((r) => r.url.includes("/FeatureServer/0/query"))).toBe(true);
      expect(recorded.some((r) => r.url.includes("/ogc/features/collections/parcels/items"))).toBe(true);
    },
  );

  it(
    "tolerant policy: one source failing keeps the rest of the composition rendering",
    { timeout: 30_000 },
    async () => {
      const map = makeMockMap();
      const { fetchFn } = makeMockFetch();
      const client = new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });
      const events: HonuaRuntimeEvent[] = [];

      // OGC binding URL omits the `/collections/<id>` segment, so the
      // built-in OGC resolver throws at materialization time —
      // exercising the per-source tolerant path.
      const pkg = makeMixedPackage({ ogcLocatorUrl: "https://mock.honua.test/ogc/features" });

      const runtime = await loadMapPackage(pkg, map, {
        client,
        skipCompatibilityCheck: true,
        applyInitialView: false,
        onEvent: (event) => events.push(event),
      });

      // Composed style drops the layer whose source failed, but keeps
      // every other layer including the background and the
      // MapLibre-native tile basemap.
      const layerIds = runtime.composedStyle.layers.map((l) => l.id).sort();
      expect(layerIds).not.toContain("ogc-circle");
      expect(layerIds).toEqual(["background", "basemap-line", "imagery-raster", "parcels-fill"]);

      // Exactly one source-error event for the failed source.
      const sourceErrors = events.filter((e) => e.type === "source-error");
      expect(sourceErrors).toHaveLength(1);
      expect((sourceErrors[0] as { sourceId: string }).sourceId).toBe("ogc-overlay");

      // The remaining sources are still queryable end-to-end.
      const fsResult = await runtime.dataset.source("parcels")!.query({ where: "1=1" });
      expect(fsResult.features).toHaveLength(2);
    },
  );

  it(
    "tolerant policy: a thrown honuaMap.addSource still drops the source from composedStyle.sources",
    { timeout: 30_000 },
    async () => {
      // Regression: previously the loader assigned styleSources[id] before
      // calling honuaMap.addSource, so a thrown addSource left the failed
      // source in composedStyle.sources even though the catch recorded
      // the failure. The fix swaps the order so addSource commits before
      // styleSources is touched.
      const map = makeMockMap();
      const { fetchFn } = makeMockFetch();
      const client = new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });
      const events: HonuaRuntimeEvent[] = [];

      const realAddSource = HonuaMap.prototype.addSource;
      vi.spyOn(HonuaMap.prototype, "addSource").mockImplementation(function (
        this: HonuaMap,
        name: string,
        spec: Parameters<HonuaMap["addSource"]>[1],
      ): void {
        if (name === "parcels") {
          throw new Error("honuaMap.addSource refused 'parcels'");
        }
        realAddSource.call(this, name, spec);
      });

      const runtime = await loadMapPackage(makeMixedPackage(), map, {
        client,
        skipCompatibilityCheck: true,
        applyInitialView: false,
        onEvent: (event) => events.push(event),
      });

      // Failed source absent from composedStyle.sources and from
      // composedStyle.layers; the rest of the composition keeps rendering.
      expect(Object.keys(runtime.composedStyle.sources).sort()).toEqual([
        "basemap-tiles",
        "imagery",
        "ogc-overlay",
      ]);
      const layerIds = runtime.composedStyle.layers.map((l) => l.id).sort();
      expect(layerIds).not.toContain("parcels-fill");
      expect(layerIds).toEqual(["background", "basemap-line", "imagery-raster", "ogc-circle"]);

      // Exactly one source-error for the failed source.
      const sourceErrors = events.filter((e) => e.type === "source-error");
      expect(sourceErrors).toHaveLength(1);
      expect((sourceErrors[0] as { sourceId: string }).sourceId).toBe("parcels");
    },
  );

  it(
    "tolerant policy: a predeclared inline mapSpec.sources entry is dropped when its binding fails",
    { timeout: 30_000 },
    async () => {
      // Regression: previously the loader pre-populated styleSources from
      // mapSpec.sources and only filtered failed-source LAYERS — so an
      // inline `mapSpec.sources["foo"]` colliding with a failing binding
      // for the same id stayed in composedStyle.sources, contradicting
      // the documented tolerant contract. The fix deletes the predeclared
      // entry from styleSources when the binding fails tolerantly.
      const map = makeMockMap();
      const { fetchFn } = makeMockFetch();
      const client = new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });
      const events: HonuaRuntimeEvent[] = [];

      // OGC binding URL omits `/collections/<id>`, so the resolver throws
      // at materialization — the same trigger used by the existing
      // tolerant-policy test, but now with a colliding inline source.
      const pkg = makeMixedPackage({ ogcLocatorUrl: "https://mock.honua.test/ogc/features" });
      const pkgWithInline: HonuaMapPackage = {
        ...pkg,
        mapSpec: {
          ...pkg.mapSpec,
          sources: {
            ...pkg.mapSpec.sources,
            // Predeclared inline source colliding with the failing binding.
            "ogc-overlay": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          },
        },
      };

      const runtime = await loadMapPackage(pkgWithInline, map, {
        client,
        skipCompatibilityCheck: true,
        applyInitialView: false,
        onEvent: (event) => events.push(event),
      });

      // The predeclared inline `ogc-overlay` source must be dropped along
      // with the binding-derived spec.
      expect(runtime.composedStyle.sources).not.toHaveProperty("ogc-overlay");
      const layerIds = runtime.composedStyle.layers.map((l) => l.id).sort();
      expect(layerIds).not.toContain("ogc-circle");

      // Exactly one source-error for the failed binding.
      const sourceErrors = events.filter((e) => e.type === "source-error");
      expect(sourceErrors).toHaveLength(1);
      expect((sourceErrors[0] as { sourceId: string }).sourceId).toBe("ogc-overlay");
    },
  );

  it(
    "tolerant reload: failure / recovery between updatePackage calls forces structural setStyle",
    { timeout: 30_000 },
    async () => {
      // Regression: previously detectUnpatchableLayerChange only compared
      // shapes for layer ids that existed in both composed styles, so a
      // tolerant source failure (or recovery) on reload could leave the
      // raw package diff incremental and #applyIncremental would skip
      // the removed layer / source — leaving stale MapLibre state. The
      // fix forces structural fallback whenever the composed layer or
      // source set differs across reloads.
      //
      // The trigger: hand the runtime two identical packages back to
      // back; flip a spy between calls so the second reload's
      // honuaMap.addSource throws only for one source. The raw package
      // diff is then empty (would be incremental), but the composed
      // style now drops one source/layer — the runtime must detect that
      // composed-shape divergence and fall back to setStyle.
      const map = makeMockMap();
      const { fetchFn } = makeMockFetch();
      const client = new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });

      // First load: spy is a pass-through, every source binds successfully.
      const realAddSource = HonuaMap.prototype.addSource;
      let failOgcOnReload = false;
      vi.spyOn(HonuaMap.prototype, "addSource").mockImplementation(function (
        this: HonuaMap,
        name: string,
        spec: Parameters<HonuaMap["addSource"]>[1],
      ): void {
        if (failOgcOnReload && name === "ogc-overlay") {
          throw new Error("simulated ogc-overlay bind failure on reload");
        }
        realAddSource.call(this, name, spec);
      });

      const pkg = makeMixedPackage();
      const runtime = await loadMapPackage(pkg, map, {
        client,
        skipCompatibilityCheck: true,
        applyInitialView: false,
      });

      expect(runtime.composedStyle.layers.map((l) => l.id)).toContain("ogc-circle");
      expect(runtime.composedStyle.sources).toHaveProperty("ogc-overlay");

      // Drop the load-time setStyle so the assertion below isolates the
      // structural fallback driven by tolerant failure on reload.
      map._calls.length = 0;
      failOgcOnReload = true;

      // Same package object → raw diff is empty (incremental). With the
      // spy now refusing ogc-overlay at bind time, the reload's composed
      // style drops the layer + source. The runtime must detect the
      // composed-shape change and fall back to setStyle.
      await runtime.updatePackage(pkg);

      expect(map._calls.some((c) => c.method === "setStyle")).toBe(true);
      expect(runtime.composedStyle.sources).not.toHaveProperty("ogc-overlay");
      expect(runtime.composedStyle.layers.map((l) => l.id)).not.toContain("ogc-circle");

      // Recovery path: flip the spy back, re-update with the same
      // package. Raw diff again empty, composed style now re-introduces
      // the source/layer — must again force structural fallback.
      map._calls.length = 0;
      failOgcOnReload = false;
      await runtime.updatePackage(pkg);

      expect(map._calls.some((c) => c.method === "setStyle")).toBe(true);
      expect(runtime.composedStyle.sources).toHaveProperty("ogc-overlay");
      expect(runtime.composedStyle.layers.map((l) => l.id)).toContain("ogc-circle");
    },
  );

  it("intersectCapabilities reports honest weakest sets for every protocol pair (registry sweep)", () => {
    // Defensive sweep: any descriptor we hand to intersectCapabilities
    // (descriptor or live source) must never advertise a capability the
    // weakest source lacks. This is the single load-bearing invariant
    // for `#22`.
    const protocols = Object.keys(PROTOCOL_DEFAULT_CAPABILITIES) as Array<keyof typeof PROTOCOL_DEFAULT_CAPABILITIES>;
    for (const a of protocols) {
      for (const b of protocols) {
        const descriptors: SourceDescriptor[] = [
          {
            id: `${a}-x`,
            protocol: a,
            locator: { url: "https://mock/" },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[a],
          },
          {
            id: `${b}-y`,
            protocol: b,
            locator: { url: "https://mock/" },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES[b],
          },
        ];
        const weakest = intersectCapabilities(descriptors);
        for (const cap of weakest) {
          expect(PROTOCOL_DEFAULT_CAPABILITIES[a].has(cap)).toBe(true);
          expect(PROTOCOL_DEFAULT_CAPABILITIES[b].has(cap)).toBe(true);
        }
      }
    }
  });
});
