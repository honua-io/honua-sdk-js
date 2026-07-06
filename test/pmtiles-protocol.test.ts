/**
 * PMTiles runtime tests: `pmtiles://` protocol auto-registration (lazy,
 * idempotent across maps), MapPackage source-type projection, and
 * `loadMapPackage` wiring the protocol before `map.setStyle`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { HONUA_MAP_PACKAGE_FORMAT_V1, type MaplibreMap, loadMapPackage } from "../src/runtime/index.js";
import {
  type EnsurePmtilesProtocolDeps,
  ensurePmtilesProtocol,
  isPmtilesProtocolRegistered,
  projectSourceBindings,
  resetPmtilesProtocol,
  styleUsesPmtiles,
} from "../src/runtime/index.js";
import { makeMockClient } from "./contract/shared.js";

interface MockCall {
  method: string;
  args: unknown[];
}

function fakeDeps(): {
  deps: EnsurePmtilesProtocolDeps;
  addCalls: string[];
  removeCalls: string[];
  built: number;
} {
  const addCalls: string[] = [];
  const removeCalls: string[] = [];
  let built = 0;
  const deps: EnsurePmtilesProtocolDeps = {
    maplibre: {
      addProtocol(scheme) {
        addCalls.push(scheme);
      },
      removeProtocol(scheme) {
        removeCalls.push(scheme);
      },
    },
    pmtilesModule: {
      Protocol: class {
        tile = () => undefined;
        constructor() {
          built += 1;
        }
      },
    },
  };
  return {
    deps,
    addCalls,
    removeCalls,
    get built() {
      return built;
    },
  };
}

afterEach(() => {
  resetPmtilesProtocol();
});

describe("runtime / ensurePmtilesProtocol", () => {
  it("registers the pmtiles protocol exactly once across repeated calls", async () => {
    const f = fakeDeps();
    expect(isPmtilesProtocolRegistered()).toBe(false);
    await ensurePmtilesProtocol(f.deps);
    await ensurePmtilesProtocol(f.deps);
    await ensurePmtilesProtocol(f.deps);
    expect(f.addCalls).toEqual(["pmtiles"]);
    expect(f.built).toBe(1);
    expect(isPmtilesProtocolRegistered()).toBe(true);
  });

  it("dedupes concurrent registrations (idempotent across multiple maps)", async () => {
    const f = fakeDeps();
    await Promise.all([ensurePmtilesProtocol(f.deps), ensurePmtilesProtocol(f.deps), ensurePmtilesProtocol(f.deps)]);
    expect(f.addCalls).toEqual(["pmtiles"]);
    expect(f.built).toBe(1);
  });

  it("resetPmtilesProtocol tears the registration down and allows re-registration", async () => {
    const f = fakeDeps();
    await ensurePmtilesProtocol(f.deps);
    resetPmtilesProtocol();
    expect(f.removeCalls).toEqual(["pmtiles"]);
    expect(isPmtilesProtocolRegistered()).toBe(false);
    await ensurePmtilesProtocol(f.deps);
    expect(f.addCalls).toEqual(["pmtiles", "pmtiles"]);
  });
});

describe("runtime / styleUsesPmtiles", () => {
  it("detects a pmtiles:// source url", () => {
    expect(styleUsesPmtiles({ sources: { a: { type: "vector", url: "pmtiles://https://x/y.pmtiles" } } })).toBe(true);
  });

  it("detects a pmtiles:// entry in a tiles array", () => {
    expect(styleUsesPmtiles({ sources: { a: { type: "raster", tiles: ["pmtiles://https://x/y.pmtiles"] } } })).toBe(
      true,
    );
  });

  it("returns false for non-pmtiles styles and empty styles", () => {
    expect(styleUsesPmtiles({ sources: { a: { type: "vector", url: "https://x/tiles.json" } } })).toBe(false);
    expect(styleUsesPmtiles({ sources: {} })).toBe(false);
    expect(styleUsesPmtiles(undefined)).toBe(false);
  });
});

describe("runtime / PMTiles MapPackage source-type", () => {
  it("projects a pmtiles binding to a MapLibre-native source with a pmtiles:// url (vector default)", () => {
    const projection = projectSourceBindings("pkg", [
      { sourceId: "basemap", protocol: "pmtiles", locator: { url: "https://cdn.example/base.pmtiles" } },
    ]);
    expect(projection.descriptors).toHaveLength(0);
    expect(projection.nativeSources).toEqual([
      {
        sourceId: "basemap",
        attribution: undefined,
        spec: { type: "vector", url: "pmtiles://https://cdn.example/base.pmtiles" },
      },
    ]);
  });

  it("honours a raster sourceType hint and preserves an existing pmtiles:// scheme", () => {
    const projection = projectSourceBindings("pkg", [
      {
        sourceId: "imagery",
        protocol: "pmtiles",
        locator: { url: "pmtiles://https://cdn.example/imagery.pmtiles", sourceType: "raster" },
        attribution: "© Honua",
      },
    ]);
    expect(projection.nativeSources[0]).toEqual({
      sourceId: "imagery",
      attribution: "© Honua",
      spec: {
        type: "raster",
        url: "pmtiles://https://cdn.example/imagery.pmtiles",
        attribution: "© Honua",
      },
    });
  });
});

function makeMockMap(): MaplibreMap & { _calls: MockCall[]; _style: unknown } {
  const calls: MockCall[] = [];
  const map = {
    _calls: calls,
    _style: {} as unknown,
    setStyle(next: unknown) {
      calls.push({ method: "setStyle", args: [next] });
      map._style = next;
    },
    getStyle() {
      return map._style;
    },
    addSource(id: string, source: unknown) {
      calls.push({ method: "addSource", args: [id, source] });
    },
    addLayer(layer: unknown) {
      calls.push({ method: "addLayer", args: [layer] });
    },
    setFeatureState() {},
    getFeatureState() {
      return {};
    },
    removeFeatureState() {},
    on() {},
    off() {},
  } as unknown as MaplibreMap & { _calls: MockCall[]; _style: unknown };
  return map;
}

describe("runtime / loadMapPackage registers pmtiles before setStyle", () => {
  it("renders a PMTiles source with no manual addProtocol wiring", async () => {
    // Pre-register with fakes so loadMapPackage's lazy ensurePmtilesProtocol()
    // resolves without importing the real maplibre-gl / pmtiles packages.
    const f = fakeDeps();
    await ensurePmtilesProtocol(f.deps);
    expect(isPmtilesProtocolRegistered()).toBe(true);

    const map = makeMockMap();
    const pkg = {
      format: HONUA_MAP_PACKAGE_FORMAT_V1,
      mapPackageId: "pm-static",
      sourceBindings: [
        { sourceId: "basemap", protocol: "pmtiles" as const, locator: { url: "https://cdn.example/base.pmtiles" } },
      ],
      mapSpec: {
        version: 8 as const,
        sources: {},
        layers: [{ id: "backdrop", type: "background" as const, paint: { "background-color": "#eef" } }],
      },
    };

    const runtime = await loadMapPackage(pkg, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
    });

    const setStyleCall = map._calls.find((call) => call.method === "setStyle");
    expect(setStyleCall).toBeDefined();
    const composed = setStyleCall?.args[0] as { sources: Record<string, unknown> };
    expect(composed.sources.basemap).toEqual({
      type: "vector",
      url: "pmtiles://https://cdn.example/base.pmtiles",
    });
    expect(styleUsesPmtiles(composed)).toBe(true);
    // A single registration served the whole load (idempotent).
    expect(f.addCalls).toEqual(["pmtiles"]);

    runtime.dispose?.();
  });
});
