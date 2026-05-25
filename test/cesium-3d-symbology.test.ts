import { beforeEach, describe, expect, it, vi } from "vitest";

// As with `cesium-scene-adapter.test.ts`, Cesium needs a WebGL context that is
// unavailable headless, so we mock only the surface the styling path touches:
// `Cesium3DTileset.fromUrl` (to feed `extras` into the auto-apply flow) and a
// `Cesium3DTileStyle` stub that records the options it was constructed with so
// we can assert which blocks were forwarded. The 2D bundle never loads this
// module — the static-import guard in `cesium-scene-adapter.test.ts` covers it.
const tilesetFromUrl = vi.fn(async (url: string) => ({
  kind: "tileset",
  url,
  show: true,
  modelMatrix: undefined,
  extras: undefined as unknown,
  style: undefined as unknown,
}));

class Cesium3DTileStyleStub {
  constructor(public readonly options: Record<string, unknown> = {}) {}
}

vi.mock("cesium", () => ({
  Cartesian3: {
    fromDegrees: (longitude: number, latitude: number, height?: number) => ({ longitude, latitude, height }),
  },
  HeadingPitchRoll: class {
    constructor(
      public heading = 0,
      public pitch = 0,
      public roll = 0,
    ) {}
  },
  Transforms: {
    headingPitchRollToFixedFrame: (origin: unknown, hpr: unknown) => ({ kind: "frame", origin, hpr }),
  },
  Matrix4: {
    multiplyByUniformScale: (matrix: unknown, scale: number) => ({ kind: "scaled", matrix, scale }),
    clone: (matrix: unknown) => matrix,
  },
  Cesium3DTileset: {
    fromUrl: (url: string) => tilesetFromUrl(url),
  },
  Cesium3DTileStyle: Cesium3DTileStyleStub,
  Model: {
    fromGltfAsync: vi.fn(async (options: Record<string, unknown>) => ({ ...options, kind: "model", show: true })),
  },
  CesiumTerrainProvider: {
    fromUrl: vi.fn(async (url: string) => ({ kind: "terrain-provider", url })),
  },
}));

import {
  type CesiumSceneLike,
  type CesiumTilesetLike,
  type Honua3DStyleSpec,
  addCesium3DTileset,
  applyHonua3DStyle,
  applyTilesetServerStyle,
  fetchHonua3DStyleSpec,
  honua3DStyleToCesiumStyleOptions,
  loadHonua3DStyle,
  readHonua3DStyleDescriptor,
  resolveHonua3DStyleUri,
  setTilesetStyle,
} from "../src/scene-workspace/index.js";

const COLOR_AND_SHOW: Honua3DStyleSpec = {
  encoding: "3d-tiles-styling",
  version: "1.0",
  defaultMaterial: { color: "#ffffff", opacity: 0.5 },
  style: {
    color: {
      conditions: [
        ["${height} > 30", "color('#ff0000', 1)"],
        ["true", "color('#ffffff', 0.5)"],
      ],
    },
    show: {
      conditions: [
        ["${demolished} === 'true'", "false"],
        ["true", "true"],
      ],
    },
  },
};

function styleSidecarResponse(spec: Honua3DStyleSpec): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => spec,
  } as unknown as Response;
}

function createMockScene(): CesiumSceneLike & { added: unknown[] } {
  const added: unknown[] = [];
  return {
    added,
    verticalExaggeration: 1,
    terrainProvider: undefined,
    primitives: {
      add(primitive: unknown) {
        added.push(primitive);
        return primitive;
      },
      remove() {
        return true;
      },
      contains(primitive?: unknown) {
        return added.includes(primitive);
      },
    },
  };
}

/** A loaded tileset stub that exposes `extras` + a settable `style`. */
function createTileset(extras?: unknown): CesiumTilesetLike & { style: unknown } {
  return { show: true, extras, style: undefined };
}

describe("honua 3d symbology — descriptor discovery", () => {
  it("reads a well-formed honua_style descriptor off extras", () => {
    const descriptor = readHonua3DStyleDescriptor({
      honua_style: { encoding: "3d-tiles-styling", version: "1.0", uri: "style.json" },
    });
    expect(descriptor).toEqual({ encoding: "3d-tiles-styling", version: "1.0", uri: "style.json" });
  });

  it("defaults version to 1.0 when the descriptor omits it", () => {
    const descriptor = readHonua3DStyleDescriptor({
      honua_style: { encoding: "3d-tiles-styling", uri: "style.json" },
    });
    expect(descriptor?.version).toBe("1.0");
  });

  it("returns undefined when no honua_style is present or the shape is wrong", () => {
    expect(readHonua3DStyleDescriptor(undefined)).toBeUndefined();
    expect(readHonua3DStyleDescriptor(null)).toBeUndefined();
    expect(readHonua3DStyleDescriptor({})).toBeUndefined();
    // Wrong encoding.
    expect(readHonua3DStyleDescriptor({ honua_style: { encoding: "other", uri: "style.json" } })).toBeUndefined();
    // Missing / empty uri.
    expect(readHonua3DStyleDescriptor({ honua_style: { encoding: "3d-tiles-styling" } })).toBeUndefined();
    expect(readHonua3DStyleDescriptor({ honua_style: { encoding: "3d-tiles-styling", uri: "  " } })).toBeUndefined();
  });
});

describe("honua 3d symbology — relative-uri resolution", () => {
  it("resolves a relative sidecar uri against the tileset.json url", () => {
    expect(resolveHonua3DStyleUri("style.json", "https://example.test/tiles/city/tileset.json")).toBe(
      "https://example.test/tiles/city/style.json",
    );
    expect(resolveHonua3DStyleUri("./styles/style.json", "https://example.test/tiles/city/tileset.json")).toBe(
      "https://example.test/tiles/city/styles/style.json",
    );
  });

  it("falls back to the raw uri when the tileset url is not absolute", () => {
    expect(resolveHonua3DStyleUri("style.json", "tileset.json")).toBe("style.json");
  });
});

describe("honua 3d symbology — fetch + load", () => {
  it("fetches and parses the style.json sidecar", async () => {
    const fetchImpl = vi.fn(async () => styleSidecarResponse(COLOR_AND_SHOW));
    const spec = await fetchHonua3DStyleSpec("https://example.test/tiles/city/style.json", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/tiles/city/style.json");
    expect(spec.encoding).toBe("3d-tiles-styling");
    expect(spec.style.color?.conditions).toHaveLength(2);
  });

  it("throws on a non-ok sidecar response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" }) as unknown as Response);
    await expect(fetchHonua3DStyleSpec("https://example.test/style.json", fetchImpl)).rejects.toThrow(/404/);
  });

  it("discovers + loads via extras, resolving the relative sidecar uri", async () => {
    const fetchImpl = vi.fn(async () => styleSidecarResponse(COLOR_AND_SHOW));
    const spec = await loadHonua3DStyle(
      { honua_style: { encoding: "3d-tiles-styling", version: "1.0", uri: "style.json" } },
      "https://example.test/tiles/city/tileset.json",
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/tiles/city/style.json");
    expect(spec).toEqual(COLOR_AND_SHOW);
  });

  it("returns undefined (no fetch) when extras carry no honua_style", async () => {
    const fetchImpl = vi.fn();
    const spec = await loadHonua3DStyle({}, "https://example.test/tileset.json", fetchImpl);
    expect(spec).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("honua 3d symbology — option building + apply", () => {
  it("includes only the blocks present in the spec", () => {
    expect(honua3DStyleToCesiumStyleOptions(COLOR_AND_SHOW)).toEqual({
      color: COLOR_AND_SHOW.style.color,
      show: COLOR_AND_SHOW.style.show,
    });
    expect(
      honua3DStyleToCesiumStyleOptions({
        encoding: "3d-tiles-styling",
        version: "1.0",
        style: { color: COLOR_AND_SHOW.style.color },
      }),
    ).toEqual({ color: COLOR_AND_SHOW.style.color });
    expect(
      honua3DStyleToCesiumStyleOptions({
        encoding: "3d-tiles-styling",
        version: "1.0",
        style: { show: COLOR_AND_SHOW.style.show },
      }),
    ).toEqual({ show: COLOR_AND_SHOW.style.show });
  });

  it("applies a color+show spec, building a Cesium3DTileStyle with both blocks", async () => {
    const tileset = createTileset();
    await applyHonua3DStyle(tileset, COLOR_AND_SHOW);
    const style = tileset.style as Cesium3DTileStyleStub;
    expect(style).toBeInstanceOf(Cesium3DTileStyleStub);
    expect(style.options).toEqual({
      color: COLOR_AND_SHOW.style.color,
      show: COLOR_AND_SHOW.style.show,
    });
  });

  it("applies a color-only spec (no show key in the style options)", async () => {
    const tileset = createTileset();
    await applyHonua3DStyle(tileset, {
      encoding: "3d-tiles-styling",
      version: "1.0",
      style: { color: COLOR_AND_SHOW.style.color },
    });
    const style = tileset.style as Cesium3DTileStyleStub;
    expect(Object.keys(style.options)).toEqual(["color"]);
  });

  it("applies a show-only spec (no color key in the style options)", async () => {
    const tileset = createTileset();
    await applyHonua3DStyle(tileset, {
      encoding: "3d-tiles-styling",
      version: "1.0",
      style: { show: COLOR_AND_SHOW.style.show },
    });
    const style = tileset.style as Cesium3DTileStyleStub;
    expect(Object.keys(style.options)).toEqual(["show"]);
  });

  it("leaves tileset.style untouched when neither block is present", async () => {
    const tileset = createTileset();
    await applyHonua3DStyle(tileset, { encoding: "3d-tiles-styling", version: "1.0", style: {} });
    expect(tileset.style).toBeUndefined();
  });

  it("setTilesetStyle applies a spec as a programmatic override", async () => {
    const tileset = createTileset();
    await setTilesetStyle(tileset, COLOR_AND_SHOW);
    expect(tileset.style).toBeInstanceOf(Cesium3DTileStyleStub);
  });

  it("applyTilesetServerStyle discovers, fetches, and applies; returns the spec", async () => {
    const fetchImpl = vi.fn(async () => styleSidecarResponse(COLOR_AND_SHOW));
    const tileset = createTileset({
      honua_style: { encoding: "3d-tiles-styling", version: "1.0", uri: "style.json" },
    });
    const spec = await applyTilesetServerStyle(
      tileset,
      "https://example.test/tiles/city/tileset.json",
      undefined,
      fetchImpl,
    );
    expect(spec).toEqual(COLOR_AND_SHOW);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/tiles/city/style.json");
    expect(tileset.style).toBeInstanceOf(Cesium3DTileStyleStub);
  });

  it("applyTilesetServerStyle no-ops (no fetch, undefined) for an unstyled tileset", async () => {
    const fetchImpl = vi.fn();
    const tileset = createTileset();
    const spec = await applyTilesetServerStyle(tileset, "https://example.test/tileset.json", undefined, fetchImpl);
    expect(spec).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tileset.style).toBeUndefined();
  });
});

describe("honua 3d symbology — auto-apply on tileset add", () => {
  beforeEach(() => {
    tilesetFromUrl.mockClear();
  });

  it("auto-applies server style when the added tileset advertises honua_style", async () => {
    tilesetFromUrl.mockImplementationOnce(async (url: string) => ({
      kind: "tileset",
      url,
      show: true,
      modelMatrix: undefined,
      extras: { honua_style: { encoding: "3d-tiles-styling", version: "1.0", uri: "style.json" } },
      style: undefined,
    }));
    const fetchImpl = vi.fn(async () => styleSidecarResponse(COLOR_AND_SHOW));
    const scene = createMockScene();

    const handle = await addCesium3DTileset(
      scene,
      {
        kind: "model-layer",
        id: "city-tiles",
        uri: "https://example.test/tiles/city/tileset.json",
        format: "3d-tiles",
      },
      undefined,
      { fetchImpl },
    );

    expect(handle.id).toBe("city-tiles");
    expect(scene.added).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/tiles/city/style.json");
    const tileset = scene.added[0] as { style: unknown };
    expect(tileset.style).toBeInstanceOf(Cesium3DTileStyleStub);
  });

  it("skips the server style when applyServerStyle is false", async () => {
    tilesetFromUrl.mockImplementationOnce(async (url: string) => ({
      kind: "tileset",
      url,
      show: true,
      modelMatrix: undefined,
      extras: { honua_style: { encoding: "3d-tiles-styling", version: "1.0", uri: "style.json" } },
      style: undefined,
    }));
    const fetchImpl = vi.fn(async () => styleSidecarResponse(COLOR_AND_SHOW));
    const scene = createMockScene();

    await addCesium3DTileset(
      scene,
      {
        kind: "model-layer",
        id: "city-tiles",
        uri: "https://example.test/tiles/city/tileset.json",
        format: "3d-tiles",
      },
      undefined,
      { applyServerStyle: false, fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    const tileset = scene.added[0] as { style: unknown };
    expect(tileset.style).toBeUndefined();
  });

  it("adds an unstyled tileset (no fetch) when it carries no honua_style", async () => {
    const fetchImpl = vi.fn();
    const scene = createMockScene();

    await addCesium3DTileset(
      scene,
      { kind: "model-layer", id: "plain", uri: "https://example.test/tiles/plain/tileset.json", format: "3d-tiles" },
      undefined,
      { fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(scene.added).toHaveLength(1);
  });
});
