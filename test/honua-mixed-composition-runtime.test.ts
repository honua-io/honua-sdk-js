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

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, intersectCapabilities } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
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
