import { afterEach, describe, expect, test, vi } from "vitest";

import { HonuaClient } from "../../src/core/client.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  HonuaMapPackageError,
  type MaplibreMap,
  fetchMapPackage,
  loadMapPackageFromId,
  validateMapPackage,
  watchMapPackage,
} from "../../src/runtime/index.js";

interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
}

interface MockMap extends MaplibreMap {
  readonly calls: Array<{ method: string; args: unknown[] }>;
  style: unknown;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchMapPackage", () => {
  test("fetches a hosted package and revalidates with ETag / Last-Modified", async () => {
    const requests: RecordedRequest[] = [];
    const pkg = makePackage();
    const client = makeClient(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      if (requests.length === 1) {
        return jsonResponse(
          { mapPackage: pkg },
          { etag: '"pkg-v1"', "last-modified": "Mon, 11 May 2026 00:00:00 GMT" },
        );
      }
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"pkg-v1"');
      expect(new Headers(init?.headers).get("if-modified-since")).toBe("Mon, 11 May 2026 00:00:00 GMT");
      return new Response(null, { status: 304 });
    });

    const first = await fetchMapPackage("pkg-001", { client });
    const second = await fetchMapPackage("pkg-001", { client });

    expect(requests[0].url).toBe("https://mock.honua.test/api/v1/map-packages/pkg-001");
    expect(first.mapPackage.mapPackageId).toBe("pkg-001");
    expect(first.cache.status).toBe("miss");
    expect(second.cache.status).toBe("not-modified");
    expect(second.mapPackage).toEqual(first.mapPackage);
  });

  test("throws typed validation diagnostics instead of leaking raw package shape errors", async () => {
    const client = makeClient(async () =>
      jsonResponse({
        mapPackageId: "bad",
        format: "honua_map_package.v999",
        sourceBindings: [],
        mapSpec: { version: 8, sources: {}, layers: [] },
      }),
    );

    await expect(fetchMapPackage("bad", { client })).rejects.toMatchObject({
      name: "HonuaMapPackageError",
      stage: "validate",
      detail: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "unsupported-format", severity: "error" }),
        ]),
      },
    });
  });

  test("returns style-ref resolution diagnostics and inlines resolved bodies", async () => {
    const client = makeClient(async () =>
      jsonResponse(
        makePackage({
          styleRefs: [{ styleId: "style-fill", body: undefined }],
        }),
      ),
    );

    const resolved = await fetchMapPackage("pkg-001", {
      client,
      resolveStyleRef: async () => ({ "parcels-fill": { paint: { "fill-color": "#ff0000" } } }),
    });

    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.mapPackage.styleRefs?.[0].body).toEqual({
      "parcels-fill": { paint: { "fill-color": "#ff0000" } },
    });
  });

  test("defaults to resolving style refs via /ogc/styles when no callback is supplied", async () => {
    const requests: string[] = [];
    const client = makeClient(async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/ogc/styles/style-fill")) {
        return jsonResponse({
          version: 8,
          sources: {},
          layers: [{ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#00ff00" } }],
        });
      }
      return jsonResponse(makePackage({ styleRefs: [{ styleId: "style-fill", body: undefined }] }));
    });

    const resolved = await fetchMapPackage("pkg-001", { client });

    expect(requests.some((url) => url.endsWith("/ogc/styles/style-fill"))).toBe(true);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.mapPackage.styleRefs?.[0].body).toEqual({
      "parcels-fill": { paint: { "fill-color": "#00ff00" } },
    });
  });

  test("disableDefaultStyleRefResolver skips the /ogc/styles default", async () => {
    const requests: string[] = [];
    const client = makeClient(async (url) => {
      requests.push(String(url));
      return jsonResponse(makePackage({ styleRefs: [{ styleId: "style-fill", body: undefined }] }));
    });

    const resolved = await fetchMapPackage("pkg-001", {
      client,
      allowInvalid: true,
      disableDefaultStyleRefResolver: true,
    });

    expect(requests.some((url) => url.includes("/ogc/styles/"))).toBe(false);
    expect(resolved.diagnostics).toEqual([expect.objectContaining({ code: "style-ref-unresolved" })]);
  });

  test("reports style-ref resolver failures as diagnostics", async () => {
    const client = makeClient(async () =>
      jsonResponse(
        makePackage({
          styleRefs: [{ styleId: "missing-style", body: undefined }],
        }),
      ),
    );

    const result = await fetchMapPackage("pkg-001", {
      client,
      allowInvalid: true,
      requireStyleRefResolution: true,
      resolveStyleRef: async () => {
        throw new Error("not found");
      },
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "style-ref-resolution-failed", severity: "error" }),
    ]);
  });
});

describe("validateMapPackage", () => {
  test("reports stale, expired, missing-source, and unsupported-protocol diagnostics", () => {
    const diagnostics = validateMapPackage(
      makePackage({
        status: "Expired",
        updatedAt: "2026-05-10T00:00:00.000Z",
        sourceBindings: [
          {
            sourceId: "draft",
            protocol: "workspace_artifact",
            locator: { url: "honua://workspace/artifact/1" },
          },
        ],
        mapSpec: {
          version: 8,
          sources: {},
          layers: [{ id: "missing", type: "fill", source: "not-bound" }],
        },
      }),
      { now: Date.parse("2026-05-11T00:00:00.000Z"), maxAgeMs: 60_000 },
    ).diagnostics;

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "expired-package", severity: "error" }),
        expect.objectContaining({ code: "stale-package", severity: "warning" }),
        expect.objectContaining({ code: "missing-source", severity: "error" }),
        expect.objectContaining({ code: "unsupported-protocol", severity: "error" }),
      ]),
    );
  });
});

describe("loadMapPackageFromId", () => {
  test("fetches by package id and delegates to loadMapPackage", async () => {
    const client = makeClient(async () => jsonResponse(makePackage({ sourceBindings: [], mapSpec: emptyStyle() })));
    const map = makeMockMap();

    const result = await loadMapPackageFromId("pkg-001", map, {
      client,
      skipCompatibilityCheck: true,
      applyInitialView: false,
    });

    expect(result.runtime.mapPackage.mapPackageId).toBe("pkg-001");
    expect(map.calls.some((call) => call.method === "setStyle")).toBe(true);
  });
});

describe("watchMapPackage", () => {
  test("does not poll after disposal", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(makePackage()));
    const client = makeClient(fetchFn);
    const events: string[] = [];

    const handle = watchMapPackage("pkg-001", {
      client,
      immediate: false,
      intervalMs: 25,
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    handle.dispose();

    await vi.advanceTimersByTimeAsync(100);

    expect(handle.disposed).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(events).toEqual(["disposed"]);
  });
});

function makePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-001",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    status: "Ready",
    updatedAt: "2026-05-11T00:00:00.000Z",
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://server.example.com/rest/services/Parcels/FeatureServer/0" },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [{ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } }],
    },
    ...overrides,
  };
}

function emptyStyle(): HonuaMapPackage["mapSpec"] {
  return { version: 8, sources: {}, layers: [] };
}

function makeClient(fetchFn: typeof fetch): HonuaClient {
  return new HonuaClient({ baseUrl: "https://mock.honua.test", fetchFn });
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeMockMap(): MockMap {
  const calls: MockMap["calls"] = [];
  const map: MockMap = {
    calls,
    style: undefined,
    setStyle(style) {
      calls.push({ method: "setStyle", args: [style] });
      map.style = style;
    },
    getStyle() {
      return map.style;
    },
    addSource(id, source) {
      calls.push({ method: "addSource", args: [id, source] });
    },
    removeSource(id) {
      calls.push({ method: "removeSource", args: [id] });
    },
    addLayer(layer, beforeId) {
      calls.push({ method: "addLayer", args: [layer, beforeId] });
    },
    removeLayer(id) {
      calls.push({ method: "removeLayer", args: [id] });
    },
    getLayer() {
      return undefined;
    },
    setLayoutProperty(layerId, name, value) {
      calls.push({ method: "setLayoutProperty", args: [layerId, name, value] });
    },
    setPaintProperty(layerId, name, value) {
      calls.push({ method: "setPaintProperty", args: [layerId, name, value] });
    },
    setFilter(layerId, filter) {
      calls.push({ method: "setFilter", args: [layerId, filter] });
    },
    getSource() {
      return undefined;
    },
    fitBounds(bounds, options) {
      calls.push({ method: "fitBounds", args: [bounds, options] });
    },
    jumpTo(options) {
      calls.push({ method: "jumpTo", args: [options] });
    },
    easeTo(options) {
      calls.push({ method: "easeTo", args: [options] });
    },
    flyTo(options) {
      calls.push({ method: "flyTo", args: [options] });
    },
    on() {},
    off() {},
    setFeatureState() {},
    getFeatureState() {
      return {};
    },
    removeFeatureState() {},
  };
  return map;
}
