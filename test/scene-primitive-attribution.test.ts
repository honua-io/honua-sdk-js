/**
 * Attribution reaches every materialized Cesium asset, not just imagery
 * (honua-sdk-js#1049 REQ-005). Before this, `ScenePrimitiveBase.attribution`
 * became a `credit` on imagery providers only, so a terrain provider, a
 * tileset, or a model was drawn with no attribution at all and the shared
 * `attribution` slice had nothing honest to derive from on the 3D side.
 */

import { describe, expect, it, vi } from "vitest";

const tilesetFromUrl = vi.fn(async (url: string, options?: Record<string, unknown>) => ({
  kind: "tileset",
  url,
  options,
  show: true,
  modelMatrix: undefined as unknown,
}));
const modelFromGltfAsync = vi.fn(async (options: Record<string, unknown>) => ({
  kind: "model",
  options,
  show: true,
}));
const terrainFromUrl = vi.fn(async (url: string, options?: Record<string, unknown>) => ({
  kind: "terrain",
  url,
  options,
}));
const urlTemplateOptions: Record<string, unknown>[] = [];

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
  Transforms: { headingPitchRollToFixedFrame: (origin: unknown, hpr: unknown) => ({ origin, hpr }) },
  Matrix4: {
    multiplyByUniformScale: (matrix: unknown, scale: number) => ({ matrix, scale }),
    clone: (matrix: unknown) => matrix,
  },
  Cesium3DTileset: {
    fromUrl: (url: string, options?: Record<string, unknown>) => tilesetFromUrl(url, options),
  },
  Cesium3DTileStyle: class {},
  Color: { WHITE: { withAlpha: (alpha: number) => ({ alpha }) } },
  Model: { fromGltfAsync: (options: Record<string, unknown>) => modelFromGltfAsync(options) },
  CesiumTerrainProvider: {
    fromUrl: (url: string, options?: Record<string, unknown>) => terrainFromUrl(url, options),
  },
  UrlTemplateImageryProvider: class {
    constructor(options: Record<string, unknown>) {
      urlTemplateOptions.push(options);
    }
  },
  WebMapServiceImageryProvider: class {},
  WebMapTileServiceImageryProvider: class {},
  SingleTileImageryProvider: { fromUrl: async () => ({}) },
  ArcGisMapServerImageryProvider: { fromUrl: async () => ({}) },
}));

import {
  type CesiumSceneLike,
  type SceneElevationSourcePrimitive,
  type SceneImageryLayerPrimitive,
  type SceneModelLayerPrimitive,
  addCesium3DTileset,
  addCesiumImageryLayer,
  addCesiumModel,
  applyCesiumTerrain,
} from "../src/scene-workspace/index.js";

const ATTRIBUTION = "County orthophotography";

function stubScene(): CesiumSceneLike {
  const primitives: unknown[] = [];
  const layers: unknown[] = [];
  return {
    primitives: {
      add: (primitive: unknown) => {
        primitives.push(primitive);
        return primitive;
      },
      remove: (primitive: unknown) => primitives.splice(primitives.indexOf(primitive), 1).length > 0,
      contains: (primitive: unknown) => primitives.includes(primitive),
    },
    imageryLayers: {
      addImageryProvider: (provider: unknown) => {
        const layer = { provider, show: true, alpha: 1 };
        layers.push(layer);
        return layer as never;
      },
      remove: (layer: unknown) => layers.splice(layers.indexOf(layer), 1).length > 0,
      contains: (layer: unknown) => layers.includes(layer),
    },
  } as unknown as CesiumSceneLike;
}

describe("Cesium credit propagation", () => {
  it("passes primitive attribution to a tileset", async () => {
    const primitive: SceneModelLayerPrimitive = {
      kind: "model-layer",
      id: "city-tiles",
      uri: "https://tiles.example.test/tileset.json",
      format: "3d-tiles",
      attribution: ATTRIBUTION,
    };
    await addCesium3DTileset(stubScene(), primitive, undefined, { applyServerStyle: false });
    expect(tilesetFromUrl).toHaveBeenCalledWith(primitive.uri, { credit: ATTRIBUTION });
  });

  it("passes primitive attribution to a glTF model", async () => {
    const primitive: SceneModelLayerPrimitive = {
      kind: "model-layer",
      id: "sensor-mast",
      uri: "https://assets.example.test/mast.glb",
      format: "glb",
      position: [-157.858, 21.307, 12],
      attribution: ATTRIBUTION,
    };
    await addCesiumModel(stubScene(), primitive);
    expect(modelFromGltfAsync.mock.calls[0]?.[0]).toMatchObject({ credit: ATTRIBUTION });
  });

  it("passes primitive attribution to a terrain provider", async () => {
    const primitive: SceneElevationSourcePrimitive = {
      kind: "elevation-source",
      id: "county-terrain",
      sourceId: "county-terrain",
      protocol: "quantized-mesh",
      url: "https://terrain.example.test/tiles",
      attribution: ATTRIBUTION,
    };
    await applyCesiumTerrain(stubScene(), primitive);
    expect(terrainFromUrl).toHaveBeenCalledWith(primitive.url, { credit: ATTRIBUTION });
  });

  it("keeps the existing imagery credit path", async () => {
    const primitive: SceneImageryLayerPrimitive = {
      kind: "imagery-layer",
      id: "ortho",
      sourceId: "ortho",
      protocol: "url-template",
      url: "https://imagery.example.test/{z}/{x}/{y}.png",
      attribution: ATTRIBUTION,
    };
    await addCesiumImageryLayer(stubScene(), primitive);
    expect(urlTemplateOptions[0]).toMatchObject({ credit: ATTRIBUTION });
  });

  it("omits the credit entirely when a primitive declares none", async () => {
    tilesetFromUrl.mockClear();
    const primitive: SceneModelLayerPrimitive = {
      kind: "model-layer",
      id: "unattributed-tiles",
      uri: "https://tiles.example.test/tileset.json",
      format: "3d-tiles",
    };
    await addCesium3DTileset(stubScene(), primitive, undefined, { applyServerStyle: false });
    expect(tilesetFromUrl).toHaveBeenCalledWith(primitive.uri, undefined);
  });
});
