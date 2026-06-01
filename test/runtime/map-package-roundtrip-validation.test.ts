/**
 * MapPackage round-trip validation: an incompatible basemap + layer combo
 * must surface a clear, typed diagnostic (through `validateMapPackage`'s
 * result envelope) *and* a typed `HonuaMapPackageError` when the same
 * package is driven through the runtime loader (`loadMapPackage`).
 *
 * The combo modelled here is a valid raster basemap plus an overlay layer
 * that references a vector source which the package never binds (and never
 * declares inline). That is the canonical "the basemap is fine but this
 * layer cannot be composed against the available sources" failure: the
 * server-shape validator reports it as a `missing-source` error, and the
 * runtime — which materializes the style through `HonuaMap` — refuses to
 * compose it rather than handing MapLibre a dangling source reference.
 *
 * Uses the same call-recording mock map as `runtime.test.ts` so the bridge
 * behaviour is asserted without pulling `maplibre-gl` in as a runtime dep.
 */

import { describe, expect, test } from "vitest";

import { HonuaClient } from "../../src/core/client.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  HonuaMapPackageError,
  type MaplibreMap,
  hasMapPackageDiagnosticErrors,
  loadMapPackage,
  validateMapPackage,
} from "../../src/runtime/index.js";

// ── Mock map ─────────────────────────────────────────────────

interface MockCall {
  method: string;
  args: unknown[];
}

interface MockMap extends MaplibreMap {
  _calls: MockCall[];
}

function makeMockMap(): MockMap {
  const calls: MockCall[] = [];
  let style: unknown = {};
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };

  const map: MockMap = {
    _calls: calls,
    setStyle(next) {
      record("setStyle", [next]);
      style = next;
      return undefined;
    },
    getStyle() {
      return style;
    },
    addSource(id, source) {
      record("addSource", [id, source]);
    },
    removeSource(id) {
      record("removeSource", [id]);
    },
    addLayer(layer, beforeId) {
      record("addLayer", [layer, beforeId]);
    },
    removeLayer(id) {
      record("removeLayer", [id]);
    },
    getLayer(id) {
      record("getLayer", [id]);
      return undefined;
    },
    setLayoutProperty(layerId, name, value) {
      record("setLayoutProperty", [layerId, name, value]);
    },
    setPaintProperty(layerId, name, value) {
      record("setPaintProperty", [layerId, name, value]);
    },
    setFilter(layerId, filter) {
      record("setFilter", [layerId, filter]);
    },
    getSource(id) {
      record("getSource", [id]);
      return undefined;
    },
    fitBounds(bounds, options) {
      record("fitBounds", [bounds, options]);
    },
    jumpTo(options) {
      record("jumpTo", [options]);
    },
    easeTo(options) {
      record("easeTo", [options]);
    },
    flyTo(options) {
      record("flyTo", [options]);
    },
    setFeatureState() {},
    getFeatureState() {
      return {};
    },
    removeFeatureState() {},
    on() {},
    off() {},
  };

  return map;
}

function makeClient(): HonuaClient {
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async () => new Response("not used in tests", { status: 200 }),
  });
}

/**
 * A package with a working raster basemap whose only overlay layer points
 * at `roads` — a vector source the package neither binds nor declares
 * inline. The basemap is compatible; the overlay layer is not.
 */
function makeIncompatibleBasemapLayerPackage(): HonuaMapPackage {
  return {
    mapPackageId: "pkg-incompatible-overlay",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    status: "Ready",
    sourceBindings: [],
    mapSpec: {
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
          tileSize: 256,
        },
      },
      layers: [
        { id: "basemap", type: "raster", source: "basemap" },
        // Overlay references a vector source that is never bound or declared.
        { id: "roads", type: "line", source: "roads", paint: { "line-color": "#ff8800" } },
      ],
    },
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("MapPackage round-trip validation (incompatible basemap + layer)", () => {
  test("validateMapPackage surfaces a typed missing-source diagnostic envelope", () => {
    const pkg = makeIncompatibleBasemapLayerPackage();

    const result = validateMapPackage(pkg);

    // The validator returns a typed result envelope rather than throwing.
    expect(result.valid).toBe(false);
    expect(hasMapPackageDiagnosticErrors(result.diagnostics)).toBe(true);

    const missingSource = result.diagnostics.find((d) => d.code === "missing-source");
    expect(missingSource).toBeDefined();
    expect(missingSource).toMatchObject({
      code: "missing-source",
      severity: "error",
      packageId: "pkg-incompatible-overlay",
      path: "mapSpec.layers[1].source",
      detail: { layerId: "roads", sourceId: "roads" },
    });
    // The compatible basemap layer must NOT be flagged.
    expect(result.diagnostics.some((d) => d.detail && (d.detail as { layerId?: string }).layerId === "basemap")).toBe(
      false,
    );
  });

  test("loadMapPackage rejects the same combo with a typed HonuaMapPackageError", async () => {
    const pkg = makeIncompatibleBasemapLayerPackage();
    const map = makeMockMap();

    const error = await loadMapPackage(pkg, map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    }).then(
      () => {
        throw new Error("expected loadMapPackage to reject for an incompatible basemap + layer combo");
      },
      (caught: unknown) => caught,
    );

    // Clear, typed runtime error — not a raw MapLibre/HonuaMap string throw.
    expect(error).toBeInstanceOf(HonuaMapPackageError);
    const typed = error as HonuaMapPackageError;
    expect(typed.name).toBe("HonuaMapPackageError");
    expect(typed.stage).toBe("load");
    expect(typed.packageId).toBe("pkg-incompatible-overlay");
    // The wrapped cause must name the offending source so hosts can act on it.
    expect(String((typed.cause as Error | undefined)?.message ?? "")).toContain("roads");

    // The dangling overlay never reached the renderer's style.
    expect(map._calls.some((call) => call.method === "setStyle")).toBe(false);
  });

  test("a compatible basemap + bound overlay round-trips cleanly", async () => {
    const pkg: HonuaMapPackage = {
      ...makeIncompatibleBasemapLayerPackage(),
      mapPackageId: "pkg-compatible-overlay",
      mapSpec: {
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
            tileSize: 256,
          },
          roads: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        },
        layers: [
          { id: "basemap", type: "raster", source: "basemap" },
          { id: "roads", type: "line", source: "roads", paint: { "line-color": "#ff8800" } },
        ],
      },
    };

    // Control: the same shape with a declared overlay source validates and
    // loads, proving the failures above are about the incompatible combo and
    // not about the basemap/overlay structure itself.
    expect(validateMapPackage(pkg).valid).toBe(true);

    const map = makeMockMap();
    const runtime = await loadMapPackage(pkg, map, {
      client: makeClient(),
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });

    expect(runtime.composedStyle.layers.map((layer) => layer.id)).toEqual(["basemap", "roads"]);
    expect(map._calls.some((call) => call.method === "setStyle")).toBe(true);
  });
});
