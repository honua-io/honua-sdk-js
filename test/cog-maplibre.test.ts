import fs from "node:fs";

import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type CogDecodedMetadata,
  type CogDecoder,
  type CogWindowRequest,
  type StacCogAssetToMapLibreMap,
  mountStacCogAssetToMapLibre,
  openStacCogAsset,
} from "../src/cog/index.js";
import type { StacAssetCandidate } from "../src/connect-stac-static.js";

const scenarios = JSON.parse(
  fs.readFileSync(new URL("./fixtures/cog/rendering-scenarios.json", import.meta.url), "utf8"),
) as { wgs84: CogDecodedMetadata; webMercator: CogDecodedMetadata };
const assetBytes = new Uint8Array(512).map((_, index) => index % 256);

interface MutableBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

class FakeImageSource {
  readonly updates: Array<{ url: string; coordinates?: unknown }> = [];

  updateImage(options: { url: string; coordinates?: unknown }): void {
    this.updates.push(options);
  }
}

class FakeMap implements StacCogAssetToMapLibreMap {
  readonly sources = new Map<string, unknown>();
  readonly sourceSpecs = new Map<string, unknown>();
  readonly layers = new Map<string, unknown>();
  readonly calls: string[] = [];
  readonly listeners = new Map<"moveend" | "resize", Set<() => void>>();
  bounds: MutableBounds = { west: -158, south: 21, east: -157.84, north: 21.16 };
  zoom = 12;
  canvas = { width: 4, height: 4 };
  addSourceFailure?: "before" | "after";
  addLayerFailure?: "before" | "after";
  replaceSourceBeforeLayer = false;

  getSource(id: string): unknown {
    return this.sources.get(id);
  }

  addSource(id: string, source: unknown): void {
    this.calls.push(`addSource:${id}`);
    if (this.addSourceFailure === "before") throw new Error("addSource before mutation");
    this.sourceSpecs.set(id, source);
    this.sources.set(id, new FakeImageSource());
    if (this.addSourceFailure === "after") throw new Error("addSource after mutation");
  }

  removeSource(id: string): void {
    this.calls.push(`removeSource:${id}`);
    this.sources.delete(id);
    this.sourceSpecs.delete(id);
  }

  getLayer(id: string): unknown {
    if (this.replaceSourceBeforeLayer && this.sources.has("honua-cog")) {
      this.replaceSourceBeforeLayer = false;
      this.sources.set("honua-cog", new FakeImageSource());
    }
    return this.layers.get(id);
  }

  addLayer(layer: unknown, beforeId?: string): void {
    const id = (layer as { id: string }).id;
    this.calls.push(`addLayer:${id}:${beforeId ?? ""}`);
    if (this.addLayerFailure === "before") throw new Error("addLayer before mutation");
    this.layers.set(id, layer);
    if (this.addLayerFailure === "after") throw new Error("addLayer after mutation");
  }

  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    this.layers.delete(id);
  }

  getBounds() {
    const bounds = this.bounds;
    return {
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    };
  }

  getZoom(): number {
    return this.zoom;
  }

  getCanvas(): { width: number; height: number } {
    return this.canvas;
  }

  on(event: "moveend" | "resize", listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: "moveend" | "resize", listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "moveend" | "resize"): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

interface CanvasHarness {
  readonly createElement: ReturnType<typeof vi.fn>;
  readonly encoded: Uint8ClampedArray[];
  dataUrl: string;
  onEncode?: () => void;
}

interface SessionHarness {
  readonly session: ReturnType<typeof openStacCogAsset>;
  readonly requests: CogWindowRequest[];
  readonly inspect: ReturnType<typeof vi.fn>;
  readonly readWindow: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  holdReads: boolean;
}

let canvasHarness: CanvasHarness;

beforeEach(() => {
  const encoded: Uint8ClampedArray[] = [];
  const harness: CanvasHarness = {
    dataUrl: "data:image/png;base64,AAAA",
    encoded,
    createElement: vi.fn(() => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => ({
          createImageData: (width: number, height: number) => ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: (image: { data: Uint8ClampedArray }) => encoded.push(image.data.slice()),
        })),
        toDataURL: vi.fn(() => {
          harness.onEncode?.();
          return harness.dataUrl;
        }),
      };
      return canvas;
    }),
  };
  canvasHarness = harness;
  vi.stubGlobal("document", { createElement: harness.createElement });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(): StacAssetCandidate {
  return {
    id: "render-item:visual",
    state: "classified",
    kind: "cog",
    confidence: "high",
    documentUrl: "https://catalog.example/items/render.json",
    objectType: "item",
    objectId: "render-item",
    collectionId: "rendering",
    itemId: "render-item",
    assetKey: "visual",
    href: "https://assets.example/render-cog",
    mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
    roles: ["data", "visual"],
    metadata: {},
    evidence: [
      {
        kind: "media-type",
        value: "image/tiff; application=geotiff; profile=cloud-optimized",
        supports: ["cog"],
      },
    ],
    provenance: [{ source: "https://catalog.example/items/render.json", validator: '"item-v1"' }],
  };
}

function partialRangeFetch(): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : undefined;
    if (!match) throw new Error("missing exact Range");
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = assetBytes.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${assetBytes.byteLength}`,
        "Content-Length": String(body.byteLength),
        ETag: '"render-v1"',
      },
    });
  }) as typeof fetch;
}

function sessionHarness(metadata: CogDecodedMetadata): SessionHarness {
  const requests: CogWindowRequest[] = [];
  const harness = {} as SessionHarness;
  const inspect = vi.fn(async () => metadata);
  const readWindow = vi.fn(async (request: CogWindowRequest, context: Parameters<CogDecoder["readWindow"]>[1]) => {
    requests.push(request);
    if (harness.holdReads) await new Promise<never>(() => undefined);
    await context.readRange({ offset: 64 + (request.x % 32), length: 1 });
    const width = request.sampling?.width ?? request.width;
    const height = request.sampling?.height ?? request.height;
    const pixels = width * height;
    return {
      width,
      height,
      bands: (request.bands ?? metadata.bands.map((band) => band.index)).map((band) => {
        const values = new Uint8Array(pixels).fill(band * 30);
        values[0] = 0;
        return { band, values };
      }),
    };
  });
  const dispose = vi.fn();
  const session = openStacCogAsset(candidate(), {
    decoderFactory: async () => ({ inspect, readWindow, dispose }),
    fetchFn: partialRangeFetch(),
  });
  Object.assign(harness, { session, requests, inspect, readWindow, dispose, holdReads: false });
  return harness;
}

describe("direct COG-to-MapLibre S2 renderer", () => {
  it("renders a bounded WGS84 RGB window with advertised overview sampling and deterministic evidence", async () => {
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session, { beforeId: "labels" });

    const ready = await mounted.ready;

    expect(ready).toMatchObject({ state: "ready", generation: 1, mounted: true });
    expect(harness.requests).toEqual([
      {
        x: 0,
        y: 0,
        width: 16,
        height: 16,
        bands: [1, 2, 3],
        sampling: { width: 4, height: 4, resampling: "bilinear", overviewDecimation: 4 },
      },
    ]);
    expect(map.sourceSpecs.get("honua-cog")).toMatchObject({
      type: "image",
      url: "data:image/png;base64,AAAA",
      coordinates: [
        [-158, 21.16],
        [-157.84, 21.16],
        [-157.84, 21],
        [-158, 21],
      ],
    });
    expect(map.layers.get("honua-cog-raster")).toMatchObject({
      type: "raster",
      source: "honua-cog",
      paint: { "raster-fade-duration": 0 },
    });
    expect(canvasHarness.encoded[0]?.slice(0, 8)).toEqual(new Uint8ClampedArray([0, 0, 0, 0, 30, 60, 90, 255]));
    expect(ready.lastRender).toMatchObject({
      encodedBytes: 3,
      estimatedSourcePixels: 16,
      transfer: { windowRequests: 1, windowBytes: 1 },
    });
    expect(ready.diagnostics.map((entry) => entry.code)).toEqual(["refresh-started", "window-rendered"]);

    await mounted.dispose();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect([...map.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(mounted.snapshot().diagnostics.at(-1)?.code).toBe("cleanup-complete");
  });

  it("projects a bounded EPSG:3857 grayscale window into WGS84 image coordinates", async () => {
    const map = new FakeMap();
    map.bounds = { west: -0.01, south: -0.01, east: 0.16, north: 0.16 };
    const harness = sessionHarness(scenarios.webMercator);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);

    await expect(mounted.ready).resolves.toMatchObject({ state: "ready" });
    const source = map.sourceSpecs.get("honua-cog") as { coordinates: number[][] };
    expect(source.coordinates[0]).toEqual([0, expect.closeTo(0.1437303, 5)]);
    expect(source.coordinates[2]).toEqual([expect.closeTo(0.1437304, 5), 0]);
    expect(harness.requests[0]).toMatchObject({ bands: [1], sampling: { overviewDecimation: 4 } });
    await mounted.dispose();
  });

  it("refreshes from moveend using the new zoom and viewport", async () => {
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);
    await mounted.ready;
    const source = map.sources.get("honua-cog") as FakeImageSource;

    map.zoom = 14;
    map.bounds = { west: -157.92, south: 21, east: -157.84, north: 21.16 };
    map.emit("moveend");

    await vi.waitFor(() => expect(source.updates).toHaveLength(1));
    expect(mounted.snapshot().lastRender).toMatchObject({
      viewport: { zoom: 14 },
      window: { x: 8, width: 8 },
    });
    await mounted.dispose();
  });

  it("never mutates MapLibre when a completed encode becomes stale", async () => {
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);
    await mounted.ready;
    const source = map.sources.get("honua-cog") as FakeImageSource;
    let newest: Promise<unknown> | undefined;

    map.bounds = { west: -158, south: 21, east: -157.92, north: 21.16 };
    canvasHarness.onEncode = () => {
      canvasHarness.onEncode = undefined;
      map.bounds = { west: -157.92, south: 21, east: -157.84, north: 21.16 };
      newest = mounted.refresh();
    };
    const stale = mounted.refresh();

    await expect(stale).rejects.toMatchObject({ code: "obsolete-read" });
    await expect(newest).resolves.toMatchObject({ state: "ready" });
    expect(source.updates).toHaveLength(1);
    expect(mounted.snapshot().lastRender?.window).toMatchObject({ x: 8, width: 8 });
    expect(mounted.snapshot().diagnostics).toContainEqual(expect.objectContaining({ code: "refresh-obsolete" }));
    await mounted.dispose();
  });

  it("rejects source identity drift immediately before update and preserves the replacement on cleanup", async () => {
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);
    await mounted.ready;
    const replacement = new FakeImageSource();
    map.sources.set("honua-cog", replacement);

    await expect(mounted.refresh()).rejects.toMatchObject({ code: "source-drift" });
    expect(replacement.updates).toHaveLength(0);
    await mounted.dispose();
    expect(map.sources.get("honua-cog")).toBe(replacement);
    expect(mounted.snapshot().diagnostics.at(-1)).toMatchObject({ code: "cleanup-failed" });
  });

  it("rechecks source identity immediately before the first layer mutation", async () => {
    const map = new FakeMap();
    map.replaceSourceBeforeLayer = true;
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);

    await expect(mounted.ready).rejects.toMatchObject({ code: "source-drift" });
    expect(map.calls.filter((call) => call.startsWith("addLayer:"))).toEqual([]);
    expect(map.sources.get("honua-cog")).toBeInstanceOf(FakeImageSource);
    await mounted.dispose();
  });

  it("settles a pending initial ready promise when disposed even if the decoder ignores abort", async () => {
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    harness.holdReads = true;
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);
    await vi.waitFor(() => expect(harness.readWindow).toHaveBeenCalledTimes(1));

    const disposal = mounted.dispose();
    await expect(mounted.ready).rejects.toMatchObject({ code: "disposed" });
    await expect(disposal).resolves.toBeUndefined();
  });

  it("settles a pending refresh on dispose and does not leave renderer promises hanging", async () => {
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);
    await mounted.ready;
    harness.holdReads = true;
    const refresh = mounted.refresh();
    await vi.waitFor(() => expect(harness.readWindow).toHaveBeenCalledTimes(2));

    const disposal = mounted.dispose();
    await expect(refresh).rejects.toMatchObject({ code: "disposed" });
    await expect(disposal).resolves.toBeUndefined();
  });

  it.each([
    [
      "unsupported CRS",
      { ...scenarios.wgs84, crs: { kind: "known", authority: "EPSG", code: "32604" } },
      "unsupported-crs",
    ],
    [
      "rotated extent",
      {
        ...scenarios.wgs84,
        footprint: {
          type: "Polygon",
          coordinates: [
            [
              [-158, 21.16],
              [-157.83, 21.15],
              [-157.84, 21],
              [-158.01, 21.01],
              [-158, 21.16],
            ],
          ],
        },
      },
      "unsupported-extent",
    ],
    [
      "multipart extent",
      {
        ...scenarios.wgs84,
        footprint: {
          type: "MultiPolygon",
          coordinates: [scenarios.wgs84.footprint.type === "Polygon" ? scenarios.wgs84.footprint.coordinates : []],
        },
      },
      "unsupported-extent",
    ],
    [
      "string nodata",
      { ...scenarios.wgs84, bands: scenarios.wgs84.bands.map((band) => ({ ...band, nodata: "none" })) },
      "unsupported-nodata",
    ],
    [
      "partial nodata",
      {
        ...scenarios.wgs84,
        bands: scenarios.wgs84.bands.map((band, index) => (index === 0 ? band : { ...band, nodata: undefined })),
      },
      "unsupported-nodata",
    ],
    [
      "non-uint8 samples",
      { ...scenarios.wgs84, bands: scenarios.wgs84.bands.map((band) => ({ ...band, dataType: "uint16" })) },
      "unsupported-sample-type",
    ],
  ] as const)("fails closed for %s before a window read or map mutation", async (_label, metadata, code) => {
    const map = new FakeMap();
    const harness = sessionHarness(metadata as CogDecodedMetadata);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);

    await expect(mounted.ready).rejects.toMatchObject({ code });
    expect(harness.readWindow).not.toHaveBeenCalled();
    expect(map.calls).toEqual([]);
    await mounted.dispose();
  });

  it("returns outside-extent without allocating a canvas, reading pixels, or mutating the map", async () => {
    const map = new FakeMap();
    map.bounds = { west: -120, south: 35, east: -119, north: 36 };
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);

    await expect(mounted.ready).resolves.toMatchObject({ state: "outside-extent", mounted: false });
    expect(harness.readWindow).not.toHaveBeenCalled();
    expect(canvasHarness.createElement).not.toHaveBeenCalled();
    expect(map.calls).toEqual([]);
    await mounted.dispose();
  });

  it("refuses overview source-pixel overflow before decoder work or canvas allocation", async () => {
    const huge: CogDecodedMetadata = {
      ...scenarios.wgs84,
      width: 16_384,
      height: 16_384,
      resolution: { x: 0.00001, y: 0.00001 },
      footprint: {
        type: "Polygon",
        coordinates: [
          [
            [-158, 21.16384],
            [-157.83616, 21.16384],
            [-157.83616, 21],
            [-158, 21],
            [-158, 21.16384],
          ],
        ],
      },
      overviewDecimations: [],
    };
    const map = new FakeMap();
    map.bounds = { west: -158, south: 21, east: -157.83616, north: 21.16384 };
    const harness = sessionHarness(huge);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session, { limits: { maxSourcePixels: 64 } });

    await expect(mounted.ready).resolves.toMatchObject({ state: "refused", mounted: false });
    expect(harness.readWindow).not.toHaveBeenCalled();
    expect(canvasHarness.createElement).not.toHaveBeenCalled();
    expect(map.calls).toEqual([]);
    await mounted.dispose();
  });

  it("rejects empty canvas encodings without mutating MapLibre", async () => {
    canvasHarness.dataUrl = "data:,";
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);

    await expect(mounted.ready).rejects.toMatchObject({ code: "encoding-failed" });
    expect(map.calls).toEqual([]);
    await mounted.dispose();
  });

  it("refuses encoded image overflow without mutating MapLibre", async () => {
    canvasHarness.dataUrl = "data:image/png;base64,AAAA";
    const map = new FakeMap();
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session, { limits: { maxEncodedBytes: 1 } });

    await expect(mounted.ready).resolves.toMatchObject({ state: "refused", mounted: false });
    expect(mounted.snapshot().diagnostics).toContainEqual(expect.objectContaining({ code: "window-refused" }));
    expect(map.calls).toEqual([]);
    await mounted.dispose();
  });

  it("rolls back a renderer mutation that adds a layer and then throws", async () => {
    const map = new FakeMap();
    map.addLayerFailure = "after";
    const harness = sessionHarness(scenarios.wgs84);
    const mounted = mountStacCogAssetToMapLibre(map, harness.session);

    await expect(mounted.ready).rejects.toMatchObject({ code: "map-mutation-failed" });
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.calls).toContain("removeLayer:honua-cog-raster");
    expect(map.calls).toContain("removeSource:honua-cog");
    await mounted.dispose();
  });

  it("validates sampled overview requests at the S1 session boundary", async () => {
    const harness = sessionHarness(scenarios.wgs84);
    await harness.session.inspect();

    await expect(
      harness.session.readWindow({
        x: 0,
        y: 0,
        width: 16,
        height: 16,
        bands: [1],
        sampling: { width: 2, height: 2, resampling: "nearest", overviewDecimation: 3 },
      }),
    ).rejects.toMatchObject({ code: "invalid-window" });
    expect(harness.readWindow).not.toHaveBeenCalled();
    await harness.session.dispose();
  });

  it("keeps MapLibre and DOM peers out of import-time and stable static graphs", () => {
    expectTypeOf<MapLibreMap>().toMatchTypeOf<StacCogAssetToMapLibreMap>();
    const renderer = fs.readFileSync(new URL("../src/cog/maplibre.ts", import.meta.url), "utf8");
    const root = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const honua = fs.readFileSync(new URL("../src/honua.ts", import.meta.url), "utf8");
    expect(renderer).not.toMatch(/from ["']maplibre-gl/);
    expect(renderer).not.toMatch(/^const .*document/m);
    expect(root).not.toMatch(/from ["']\.\/cog\//);
    expect(honua).not.toMatch(/from ["']\.\/cog\//);
  });
});
