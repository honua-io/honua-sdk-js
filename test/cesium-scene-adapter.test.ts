import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Cesium needs a WebGL context that is unavailable headless, and a real
// `Cartesian3` / model matrix is opaque ECEF geometry. Mock only the surface the
// adapter touches lazily (`Cartesian3.fromDegrees`, the model-matrix helpers,
// and the async layer factories) so `apply()` stays a fast, pure wiring test.
// The 2D bundle never loads this module — see the static-import guard test.
const tilesetFromUrl = vi.fn(async (url: string, options?: Record<string, unknown>) => ({
  kind: "tileset",
  url,
  options,
  show: true,
  modelMatrix: undefined,
}));
const modelFromGltfAsync = vi.fn(async (options: Record<string, unknown>) => ({
  kind: "model",
  url: options.url,
  modelMatrix: options.modelMatrix,
  scale: options.scale,
  show: true,
  color: undefined as unknown,
}));
const terrainFromUrl = vi.fn(async (url: string) => ({ kind: "terrain-provider", url, destroy: vi.fn() }));
const imageryProviders: MockImageryProvider[] = [];
let failNextImageryDestroy = false;

class MockImageryProvider {
  readonly destroy = vi.fn(() => {
    if (failNextImageryDestroy) {
      failNextImageryDestroy = false;
      throw new Error("imagery cleanup failed");
    }
    this.destroyed = true;
  });
  private destroyed = false;

  constructor(
    readonly kind: string,
    readonly options: Record<string, unknown>,
  ) {
    imageryProviders.push(this);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class MockUrlTemplateImageryProvider extends MockImageryProvider {
  constructor(options: Record<string, unknown>) {
    super("url-template", options);
  }
}

class MockWebMapServiceImageryProvider extends MockImageryProvider {
  constructor(options: Record<string, unknown>) {
    super("wms", options);
  }
}

class MockWebMapTileServiceImageryProvider extends MockImageryProvider {
  constructor(options: Record<string, unknown>) {
    super("wmts", options);
  }
}

const singleTileImageryFromUrl = vi.fn(
  async (url: string, options: Record<string, unknown> = {}) =>
    new MockImageryProvider("single-tile", { url, ...options }),
);
const arcGisImageryFromUrl = vi.fn(
  async (url: string, options: Record<string, unknown> = {}) =>
    new MockImageryProvider("arcgis-imagery", { url, ...options }),
);

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
    fromUrl: (url: string, options?: Record<string, unknown>) =>
      options === undefined ? tilesetFromUrl(url) : tilesetFromUrl(url, options),
  },
  Color: {
    WHITE: { withAlpha: (alpha: number) => ({ kind: "color", alpha }) },
  },
  Model: {
    fromGltfAsync: (options: Record<string, unknown>) => modelFromGltfAsync(options),
  },
  CesiumTerrainProvider: {
    fromUrl: (url: string) => terrainFromUrl(url),
  },
  UrlTemplateImageryProvider: MockUrlTemplateImageryProvider,
  WebMapServiceImageryProvider: MockWebMapServiceImageryProvider,
  WebMapTileServiceImageryProvider: MockWebMapTileServiceImageryProvider,
  SingleTileImageryProvider: {
    fromUrl: (url: string, options?: Record<string, unknown>) => singleTileImageryFromUrl(url, options),
  },
  ArcGisMapServerImageryProvider: {
    fromUrl: (url: string, options?: Record<string, unknown>) => arcGisImageryFromUrl(url, options),
  },
}));

import {
  CESIUM_SCENE_CAPABILITIES,
  type CesiumCameraLike,
  type CesiumSceneLike,
  type SceneCameraState,
  type SceneModelLayerPrimitive,
  type SceneRuntimePrimitive,
  addCesium3DTileset,
  addCesiumImageryLayer,
  addCesiumModel,
  applyCameraStateToCesiumCamera,
  applyCesiumScenePrimitives,
  applyCesiumTerrain,
  cameraStateToCesiumView,
  cesiumCameraToSceneState,
  createCesiumSceneAdapter,
  createSceneWorkspace,
  diagnoseScenePrimitives,
  modelLayerToCesiumPlacement,
  pickCesiumFeatureAttributes,
  resolveCesiumModelScale,
  resolvePickedFeatureAttributes,
} from "../src/scene-workspace/index.js";

const DEG2RAD = Math.PI / 180;

/**
 * A pure-JS stand-in for Cesium's `Camera`. It mirrors the real getter contract
 * (`positionCartographic` + heading/pitch/roll in radians) so the adapter's
 * camera math can be exercised without a WebGL `Viewer`, which is unavailable
 * headless. `setView` mutates internal radian state exactly as Cesium would.
 */
function createMockCesiumCamera(): CesiumCameraLike & {
  setView: ReturnType<typeof vi.fn>;
} {
  const position = { longitude: 0, latitude: 0, height: 0 };
  const orientation = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
  const setView = vi.fn(
    (options: {
      destination?: { longitude: number; latitude: number; height: number };
      orientation?: { heading?: number; pitch?: number; roll?: number };
    }) => {
      if (options.destination) {
        position.longitude = options.destination.longitude * DEG2RAD;
        position.latitude = options.destination.latitude * DEG2RAD;
        position.height = options.destination.height;
      }
      if (options.orientation) {
        if (options.orientation.heading !== undefined) orientation.heading = options.orientation.heading;
        if (options.orientation.pitch !== undefined) orientation.pitch = options.orientation.pitch;
        if (options.orientation.roll !== undefined) orientation.roll = options.orientation.roll;
      }
    },
  );
  return {
    get positionCartographic() {
      return { ...position };
    },
    get heading() {
      return orientation.heading;
    },
    get pitch() {
      return orientation.pitch;
    },
    get roll() {
      return orientation.roll;
    },
    setView,
  };
}

/**
 * A pure-JS stand-in for the slice of Cesium's `Scene` the adapter mutates: a
 * primitive collection (tracking adds/removes), a settable `terrainProvider`,
 * `verticalExaggeration`, and an injectable `pick`. No WebGL required.
 */
function createMockCesiumScene(pickResult: unknown = undefined): CesiumSceneLike & {
  added: unknown[];
  addedImagery: Array<{
    imageryProvider: unknown;
    show: boolean;
    alpha: number;
    destroy: ReturnType<typeof vi.fn>;
  }>;
  pick: ReturnType<typeof vi.fn>;
} {
  const added: unknown[] = [];
  const addedImagery: Array<{
    imageryProvider: unknown;
    show: boolean;
    alpha: number;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const pick = vi.fn(() => pickResult);
  const scene: CesiumSceneLike & {
    added: unknown[];
    addedImagery: typeof addedImagery;
    pick: ReturnType<typeof vi.fn>;
  } = {
    added,
    addedImagery,
    verticalExaggeration: 1,
    terrainProvider: undefined,
    primitives: {
      add(primitive: unknown) {
        added.push(primitive);
        return primitive;
      },
      remove(primitive?: unknown) {
        const index = added.indexOf(primitive);
        if (index === -1) return false;
        added.splice(index, 1);
        return true;
      },
      contains(primitive?: unknown) {
        return added.includes(primitive);
      },
    },
    imageryLayers: {
      addImageryProvider(imageryProvider) {
        const layer = { imageryProvider, show: true, alpha: 1, destroy: vi.fn() };
        addedImagery.push(layer);
        return layer;
      },
      remove(layer, destroy = true) {
        const index = addedImagery.indexOf(layer as (typeof addedImagery)[number]);
        if (index === -1) return false;
        addedImagery.splice(index, 1);
        if (destroy) layer.destroy?.();
        return true;
      },
      contains(layer) {
        return addedImagery.includes(layer as (typeof addedImagery)[number]);
      },
    },
    pick,
  };
  return scene;
}

describe("cesium scene adapter", () => {
  it("declares true-3D capabilities distinct from the MapLibre 2.5D adapter", () => {
    expect(CESIUM_SCENE_CAPABILITIES.renderer).toBe("cesium");
    expect(CESIUM_SCENE_CAPABILITIES.camera).toBe(true);
    expect(CESIUM_SCENE_CAPABILITIES.terrain?.protocols).toContain("quantized-mesh");
    expect(CESIUM_SCENE_CAPABILITIES.terrain?.supportsExaggeration).toBe(true);
    expect(CESIUM_SCENE_CAPABILITIES.imagery?.protocols).toEqual([
      "url-template",
      "wms",
      "wmts",
      "single-tile",
      "arcgis-imagery",
    ]);
    expect(CESIUM_SCENE_CAPABILITIES.modelLayer?.formats).toEqual(
      expect.arrayContaining(["gltf", "glb", "3d-tiles", "i3s"]),
    );
    expect(CESIUM_SCENE_CAPABILITIES.sceneLayerMetadata).toBe(true);

    const adapter = createCesiumSceneAdapter();
    expect(adapter.id).toBe("cesium-scene");
    expect(adapter.capabilities).toBe(CESIUM_SCENE_CAPABILITIES);
  });

  it("maps a scene camera state to a Cesium setView description in radians", () => {
    const view = cameraStateToCesiumView({
      longitude: -157.8583,
      latitude: 21.3069,
      height: 700,
      heading: 45,
      pitch: -35,
      roll: 10,
    });

    expect(view.destination).toEqual({ longitude: -157.8583, latitude: 21.3069, height: 700 });
    expect(view.orientation.heading).toBeCloseTo(45 * DEG2RAD, 12);
    expect(view.orientation.pitch).toBeCloseTo(-35 * DEG2RAD, 12);
    expect(view.orientation.roll).toBeCloseTo(10 * DEG2RAD, 12);
  });

  it("defaults heading/pitch/roll to Cesium's top-down defaults when omitted", () => {
    const view = cameraStateToCesiumView({ longitude: 10, latitude: 20, height: 1000 });
    expect(view.orientation.heading).toBe(0);
    expect(view.orientation.pitch).toBeCloseTo(-90 * DEG2RAD, 12);
    expect(view.orientation.roll).toBe(0);
  });

  it("round-trips camera state set -> read back through a Cesium camera", () => {
    const camera = createMockCesiumCamera();
    const original: SceneCameraState = {
      longitude: -157.8583,
      latitude: 21.3069,
      height: 1234.5,
      heading: 312,
      pitch: -42.5,
      roll: 7.25,
    };

    applyCameraStateToCesiumCamera(camera, original);
    const readBack = cesiumCameraToSceneState(camera);

    expect(readBack.longitude).toBeCloseTo(-157.8583, 9);
    expect(readBack.latitude).toBeCloseTo(21.3069, 9);
    expect(readBack.height).toBeCloseTo(1234.5, 6);
    expect(readBack.heading).toBeCloseTo(312, 9);
    expect(readBack.pitch).toBeCloseTo(-42.5, 9);
    expect(readBack.roll).toBeCloseTo(7.25, 9);
  });

  it("normalizes a negative heading into the [0, 360) range on read back", () => {
    const camera = createMockCesiumCamera();
    camera.setView({ orientation: { heading: -90 * DEG2RAD, pitch: 0, roll: 0 } });
    expect(cesiumCameraToSceneState(camera).heading).toBeCloseTo(270, 9);
  });

  it("diagnoses 3D primitives (terrain, 3D-tiles model layer) as supported", () => {
    const adapter = createCesiumSceneAdapter();
    const primitives: SceneRuntimePrimitive[] = [
      {
        kind: "elevation-source",
        id: "world-terrain",
        sourceId: "world-terrain",
        protocol: "quantized-mesh",
        url: "https://example.test/terrain",
        exaggeration: 1.5,
      },
      {
        kind: "model-layer",
        id: "city-tiles",
        uri: "https://example.test/tileset.json",
        format: "3d-tiles",
      },
    ];

    const diagnostics = adapter.diagnose(primitives);
    expect(diagnostics.map((diagnostic) => diagnostic.status)).toEqual(["supported", "supported"]);
    expect(diagnostics.every((diagnostic) => diagnostic.renderer === "cesium")).toBe(true);
  });

  it("drives the adapter from a workspace camera dispatch via apply()", async () => {
    const camera = createMockCesiumCamera();
    const adapter = createCesiumSceneAdapter({ target: { camera } });
    const workspace = createSceneWorkspace();

    const cameraState: SceneCameraState = {
      longitude: 12.4924,
      latitude: 41.8902,
      height: 850,
      heading: 90,
      pitch: -25,
      roll: 0,
    };
    workspace.dispatch({ kind: "set-camera", camera: cameraState });

    expect(adapter.apply).toBeTypeOf("function");
    const result = await adapter.apply?.(
      [{ kind: "camera", id: "primary", camera: workspace.state.camera as SceneCameraState }],
      workspace.state,
    );

    expect(result?.status).toBe("supported");
    expect(camera.setView).toHaveBeenCalledTimes(1);
    // After apply, reading the live camera back reproduces the workspace state.
    const readBack = cesiumCameraToSceneState(camera);
    expect(readBack.longitude).toBeCloseTo(12.4924, 9);
    expect(readBack.heading).toBeCloseTo(90, 9);
    expect(readBack.pitch).toBeCloseTo(-25, 9);
  });

  it("omits apply() when no live Cesium target is provided", () => {
    const adapter = createCesiumSceneAdapter();
    expect(adapter.apply).toBeUndefined();
  });

  describe("3D layer rendering (#1197)", () => {
    beforeEach(() => {
      tilesetFromUrl.mockClear();
      modelFromGltfAsync.mockClear();
      terrainFromUrl.mockClear();
      imageryProviders.length = 0;
      failNextImageryDestroy = false;
      singleTileImageryFromUrl.mockClear();
      arcGisImageryFromUrl.mockClear();
    });

    it("loads a 3D-Tiles tileset, adds it to the scene, and toggles visibility", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        {
          kind: "model-layer",
          id: "city-tiles",
          uri: "https://example.test/tileset.json",
          format: "3d-tiles",
        },
      ]);

      expect(tilesetFromUrl).toHaveBeenCalledWith("https://example.test/tileset.json");
      expect(scene.added).toHaveLength(1);
      expect(result.status).toBe("supported");

      const handle = result.layers.get("city-tiles");
      expect(handle?.kind).toBe("model-layer");
      expect(handle?.format).toBe("3d-tiles");

      const tileset = scene.added[0] as { show: boolean };
      handle?.setVisible(false);
      expect(tileset.show).toBe(false);
      handle?.setVisible(true);
      expect(tileset.show).toBe(true);
    });

    it("removes a tileset from the scene via its handle", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        { kind: "model-layer", id: "city-tiles", uri: "https://example.test/tileset.json", format: "3d-tiles" },
      ]);

      expect(scene.added).toHaveLength(1);
      result.layers.get("city-tiles")?.remove();
      expect(scene.added).toHaveLength(0);
    });

    it("wires a quantized-mesh terrain provider and honors exaggeration", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        {
          kind: "elevation-source",
          id: "world-terrain",
          sourceId: "world-terrain",
          protocol: "quantized-mesh",
          url: "https://example.test/terrain",
          exaggeration: 2.5,
        },
      ]);

      expect(terrainFromUrl).toHaveBeenCalledWith("https://example.test/terrain");
      expect(scene.terrainProvider).toMatchObject({ kind: "terrain-provider" });
      expect(scene.verticalExaggeration).toBe(2.5);
      expect(result.layers.has("world-terrain")).toBe(true);

      // Removing the terrain handle resets the globe back to a flat ellipsoid.
      result.layers.get("world-terrain")?.remove();
      expect(scene.terrainProvider).toBeUndefined();
      expect(scene.verticalExaggeration).toBe(1);
    });

    it("ignores a stale terrain handle's remove() once a newer provider replaced it", async () => {
      const scene = createMockCesiumScene();
      // Each `CesiumTerrainProvider.fromUrl` call returns a distinct provider.
      const cesium = (await import("cesium")) as never;

      const first = await applyCesiumTerrain(
        scene,
        {
          kind: "elevation-source",
          id: "terrain-a",
          sourceId: "terrain-a",
          protocol: "quantized-mesh",
          url: "https://example.test/terrain-a",
          exaggeration: 2,
        },
        cesium,
      );
      const firstProvider = scene.terrainProvider;

      // A newer elevation source replaces the active provider + exaggeration.
      await applyCesiumTerrain(
        scene,
        {
          kind: "elevation-source",
          id: "terrain-b",
          sourceId: "terrain-b",
          protocol: "quantized-mesh",
          url: "https://example.test/terrain-b",
          exaggeration: 3,
        },
        cesium,
      );
      const secondProvider = scene.terrainProvider;
      expect(secondProvider).not.toBe(firstProvider);
      expect(scene.verticalExaggeration).toBe(3);
      expect((firstProvider as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledTimes(1);

      // Removing the now-stale first handle must be a no-op: the newer provider
      // and its exaggeration stay active.
      first?.remove();
      expect(scene.terrainProvider).toBe(secondProvider);
      expect(scene.verticalExaggeration).toBe(3);
      expect((firstProvider as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledTimes(1);
    });

    it("destroys the active terrain provider exactly once when its handle is removed", async () => {
      const scene = createMockCesiumScene();
      const cesium = (await import("cesium")) as never;
      const handle = await applyCesiumTerrain(
        scene,
        {
          kind: "elevation-source",
          id: "terrain-a",
          sourceId: "terrain-a",
          protocol: "quantized-mesh",
          url: "https://example.test/terrain-a",
        },
        cesium,
      );
      const provider = scene.terrainProvider as { destroy: ReturnType<typeof vi.fn> };

      handle?.remove();
      handle?.remove();

      expect(provider.destroy).toHaveBeenCalledTimes(1);
      expect(scene.terrainProvider).toBeUndefined();
    });

    it("does not destroy a caller-owned provider when replacing terrain", async () => {
      const scene = createMockCesiumScene();
      const callerProvider = { destroy: vi.fn() };
      scene.terrainProvider = callerProvider;
      const cesium = (await import("cesium")) as never;

      await applyCesiumTerrain(
        scene,
        {
          kind: "elevation-source",
          id: "terrain-a",
          sourceId: "terrain-a",
          protocol: "quantized-mesh",
          url: "https://example.test/terrain-a",
        },
        cesium,
      );

      expect(callerProvider.destroy).not.toHaveBeenCalled();
    });

    it("sets exaggeration but skips the provider when terrain url is absent", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        {
          kind: "elevation-source",
          id: "terrain-no-url",
          sourceId: "terrain-no-url",
          protocol: "quantized-mesh",
          exaggeration: 1.5,
        },
      ]);

      expect(terrainFromUrl).not.toHaveBeenCalled();
      expect(scene.terrainProvider).toBeUndefined();
      expect(scene.verticalExaggeration).toBe(1.5);
      expect(result.layers.has("terrain-no-url")).toBe(false);
    });

    it("materializes every supported imagery protocol with explicit provider configuration", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        {
          kind: "imagery-layer",
          id: "osm",
          sourceId: "osm",
          protocol: "url-template",
          url: "https://{s}.tiles.example.test/{z}/{x}/{y}.png?LANGUAGE=en&cache=public#tiles",
          parameters: { language: "fr", scale: 2 },
          subdomains: ["a", "b"],
          minimumLevel: 1,
          maximumLevel: 18,
          attribution: "Example tiles",
          opacity: 0.75,
        },
        {
          kind: "imagery-layer",
          id: "weather",
          sourceId: "weather",
          protocol: "wms",
          url: "https://{s}.maps.example.test/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0&LAYERS=stale&STYLES=stale&FORMAT=image/jpeg&TIME=old&BBOX=stale&cache=public",
          layer: "precipitation",
          style: "radar",
          format: "image/png",
          parameters: {
            transparent: true,
            Time: "2026-08-01T12:00:00Z",
            LAYERS: "older",
            Styles: "older",
            FORMAT: "image/jpeg",
          },
          subdomains: ["maps-a", "maps-b"],
          minimumLevel: 2,
          maximumLevel: 12,
          attribution: "Example WMS",
          opacity: 0.6,
        },
        {
          kind: "imagery-layer",
          id: "basemap",
          sourceId: "basemap",
          protocol: "wmts",
          url: "https://{s}.maps.example.test/wmts?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0&LAYER=old&TileMatrixSet=old&TileMatrix=old&TileRow=1&TileCol=2&FORMAT=image/jpeg&TIME=old&cache=public#wmts",
          layer: "world",
          style: "default",
          tileMatrixSetId: "WebMercatorQuad",
          parameters: { Time: "2026-08-01T12:00:00Z", elevation: 250 },
          subdomains: ["tiles-1"],
          minimumLevel: 1,
          maximumLevel: 14,
          attribution: "Example WMTS",
        },
        {
          kind: "imagery-layer",
          id: "snapshot",
          sourceId: "snapshot",
          protocol: "single-tile",
          url: "https://{s}.images.example.test/snapshot.png?VERSION=old#snapshot",
          subdomains: ["snapshot-a", "snapshot-b"],
          parameters: { version: "new" },
          attribution: "Example snapshot",
        },
        {
          kind: "imagery-layer",
          id: "arcgis-image",
          sourceId: "arcgis-image",
          protocol: "arcgis-imagery",
          url: "https://{s}.services.example.test/arcgis/rest/services/imagery/ImageServer///?cacheKey=public&mosaicrule=stale&MosaicRule=older&f=pjson&bbox=stale&size=1%2C1&format=jpg&transparent=false",
          parameters: { mosaicRule: "public-rule" },
          subdomains: ["imagery-a", "imagery-b"],
          minimumLevel: 3,
          maximumLevel: 15,
          attribution: "Example ImageServer",
        },
        {
          kind: "imagery-layer",
          id: "arcgis-map",
          sourceId: "arcgis-map",
          protocol: "arcgis-imagery",
          url: "https://{s}.services.example.test/arcgis/rest/services/reference/MapServer?LAYERS=show%3A2&enablePickFeatures=true&F=pjson&BBOX=stale&BBOX_SR=4326&IMAGE-SR=4326&SIZE=1%2C1&FORMAT=jpg&TRANSPARENT=false&cache=public#map",
          subdomains: ["maps-primary", "maps-secondary"],
          parameters: {
            layers: "show:1, 3",
            enable_pick_features: false,
            usePreCachedTilesIfAvailable: false,
            tileWidth: 512,
          },
          maximumLevel: 16,
          attribution: "Example MapServer",
        },
      ]);

      expect(result.status).toBe("supported");
      expect(result.layers.size).toBe(6);
      expect(scene.addedImagery).toHaveLength(6);
      expect(imageryProviders.map((provider) => provider.kind)).toEqual([
        "url-template",
        "wms",
        "wmts",
        "single-tile",
        "url-template",
        "arcgis-imagery",
      ]);
      expect(imageryProviders[0]?.options).toMatchObject({
        url: "https://{s}.tiles.example.test/{z}/{x}/{y}.png?cache=public&language=fr&scale=2#tiles",
        credit: "Example tiles",
        subdomains: ["a", "b"],
        minimumLevel: 1,
        maximumLevel: 18,
      });
      expect(imageryProviders[1]?.options).toMatchObject({
        url: "https://{s}.maps.example.test/wms?cache=public",
        layers: "precipitation",
        parameters: {
          transparent: true,
          Time: "2026-08-01T12:00:00Z",
          format: "image/png",
          styles: "radar",
        },
        subdomains: ["maps-a", "maps-b"],
        minimumLevel: 2,
        maximumLevel: 12,
        credit: "Example WMS",
      });
      expect(imageryProviders[1]?.options.parameters).toEqual({
        transparent: true,
        Time: "2026-08-01T12:00:00Z",
        format: "image/png",
        styles: "radar",
      });
      expect(imageryProviders[2]?.options).toMatchObject({
        url: "https://{s}.maps.example.test/wmts?cache=public#wmts",
        layer: "world",
        style: "default",
        tileMatrixSetID: "WebMercatorQuad",
        format: "image/png",
        subdomains: ["tiles-1"],
        dimensions: { Time: "2026-08-01T12:00:00Z", elevation: 250 },
        minimumLevel: 1,
        maximumLevel: 14,
        credit: "Example WMTS",
      });
      expect(singleTileImageryFromUrl).toHaveBeenCalledWith(
        "https://snapshot-a.images.example.test/snapshot.png?version=new#snapshot",
        { credit: "Example snapshot" },
      );
      expect(imageryProviders[4]?.options).toMatchObject({
        url: expect.stringMatching(
          /^https:\/\/\{s\}\.services\.example\.test\/arcgis\/rest\/services\/imagery\/ImageServer\/exportImage\?/,
        ),
        subdomains: ["imagery-a", "imagery-b"],
        minimumLevel: 3,
        maximumLevel: 15,
        credit: "Example ImageServer",
      });
      const imageServerUrl = new URL(String(imageryProviders[4]?.options.url));
      expect(Object.fromEntries(imageServerUrl.searchParams)).toMatchObject({
        cacheKey: "public",
        mosaicRule: "public-rule",
        f: "image",
        bbox: "{westProjected},{southProjected},{eastProjected},{northProjected}",
        bboxSR: "3857",
        imageSR: "3857",
        size: "{width},{height}",
        format: "png32",
        transparent: "true",
      });
      for (const reservedKey of ["f", "bbox", "bboxsr", "imagesr", "size", "format", "transparent"]) {
        expect([...imageServerUrl.searchParams.keys()].filter((key) => key.toLowerCase() === reservedKey)).toHaveLength(
          1,
        );
      }
      expect([...imageServerUrl.searchParams.keys()].filter((key) => key.toLowerCase() === "mosaicrule")).toEqual([
        "mosaicRule",
      ]);
      expect(arcGisImageryFromUrl).toHaveBeenCalledWith(
        "https://maps-primary.services.example.test/arcgis/rest/services/reference/MapServer?cache=public#map",
        {
          layers: "1,3",
          enablePickFeatures: false,
          usePreCachedTilesIfAvailable: false,
          tileWidth: 512,
          maximumLevel: 16,
          credit: "Example MapServer",
        },
      );
      expect(scene.addedImagery[0]?.alpha).toBe(0.75);
      expect(scene.addedImagery[1]?.alpha).toBe(0.6);
    });

    it("fails closed for provider-specific fields that a protocol cannot apply", async () => {
      const cases: readonly {
        readonly primitive: SceneRuntimePrimitive;
        readonly invalidFields: readonly string[];
      }[] = [
        {
          primitive: {
            kind: "imagery-layer",
            id: "url-template-service-fields",
            sourceId: "url-template-service-fields",
            protocol: "url-template",
            url: "https://tiles.example.test/{z}/{x}/{y}.png",
            layer: "ignored",
            style: "ignored",
            format: "image/png",
            tileMatrixSetId: "ignored",
          },
          invalidFields: ["layer", "style", "format", "tileMatrixSetId"],
        },
        {
          primitive: {
            kind: "imagery-layer",
            id: "single-tile-service-fields",
            sourceId: "single-tile-service-fields",
            protocol: "single-tile",
            url: "https://images.example.test/snapshot.png",
            layer: "ignored",
            style: "ignored",
            format: "image/png",
            tileMatrixSetId: "ignored",
            minimumLevel: 1,
            maximumLevel: 2,
          },
          invalidFields: ["layer", "style", "format", "tileMatrixSetId", "minimumLevel", "maximumLevel"],
        },
        {
          primitive: {
            kind: "imagery-layer",
            id: "wms-service-fields",
            sourceId: "wms-service-fields",
            protocol: "wms",
            url: "https://maps.example.test/wms",
            layer: "world",
            style: 42,
            tileMatrixSetId: "ignored",
          } as unknown as SceneRuntimePrimitive,
          invalidFields: ["style", "tileMatrixSetId"],
        },
        {
          primitive: {
            kind: "imagery-layer",
            id: "mapserver-service-fields",
            sourceId: "mapserver-service-fields",
            protocol: "arcgis-imagery",
            url: "https://services.example.test/arcgis/rest/services/base/MapServer",
            layer: "ignored",
            style: "ignored",
            format: "image/png",
            tileMatrixSetId: "ignored",
            minimumLevel: 1,
          },
          invalidFields: ["layer", "style", "format", "tileMatrixSetId", "minimumLevel"],
        },
        {
          primitive: {
            kind: "imagery-layer",
            id: "imageserver-service-fields",
            sourceId: "imageserver-service-fields",
            protocol: "arcgis-imagery",
            url: "https://services.example.test/arcgis/rest/services/base/ImageServer",
            layer: "ignored",
            style: "ignored",
            format: "image/png",
            tileMatrixSetId: "ignored",
            minimumLevel: 1,
          },
          invalidFields: ["layer", "style", "format", "tileMatrixSetId"],
        },
      ];

      for (const { primitive, invalidFields } of cases) {
        const scene = createMockCesiumScene();
        const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [primitive]);
        expect(result.status).toBe("unsupported");
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "scene-primitive-imagery-service-config-invalid",
            primitiveId: primitive.id,
            context: { invalidFields },
          }),
        );
        expect(scene.addedImagery).toHaveLength(0);
      }

      const scene = createMockCesiumScene();
      const unusedSubdomains = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
        {
          kind: "imagery-layer",
          id: "wmts-unused-subdomains",
          sourceId: "wmts-unused-subdomains",
          protocol: "wmts",
          url: "https://maps.example.test/wmts",
          layer: "world",
          style: "default",
          tileMatrixSetId: "WebMercatorQuad",
          subdomains: ["tiles-a"],
        },
      ]);
      expect(unusedSubdomains.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-subdomains-invalid",
          primitiveId: "wmts-unused-subdomains",
        }),
      );
      expect(scene.addedImagery).toHaveLength(0);
      expect(imageryProviders).toHaveLength(0);
    });

    it("rejects ArcGIS imagery URLs that are not service roots", async () => {
      for (const [id, url] of [
        ["feature-server", "https://services.example.test/arcgis/rest/services/base/FeatureServer"],
        ["map-layer", "https://services.example.test/arcgis/rest/services/base/MapServer/0"],
        ["arbitrary", "https://services.example.test/tiles"],
      ] as const) {
        const scene = createMockCesiumScene();
        const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
          { kind: "imagery-layer", id, sourceId: id, protocol: "arcgis-imagery", url },
        ]);
        expect(result.status).toBe("unsupported");
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "scene-primitive-imagery-service-config-invalid",
            primitiveId: id,
            context: { invalidFields: ["url"] },
          }),
        );
        expect(scene.addedImagery).toHaveLength(0);
      }
      expect(imageryProviders).toHaveLength(0);
      expect(arcGisImageryFromUrl).not.toHaveBeenCalled();
    });

    it("removes a displaced imagery handle before replacing a duplicate primitive ID", async () => {
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
        {
          kind: "imagery-layer",
          id: "duplicate-imagery",
          sourceId: "first",
          protocol: "url-template",
          url: "https://tiles.example.test/first/{z}/{x}/{y}.png",
        },
        {
          kind: "imagery-layer",
          id: "duplicate-imagery",
          sourceId: "second",
          protocol: "url-template",
          url: "https://tiles.example.test/second/{z}/{x}/{y}.png",
        },
      ]);

      expect(result.status).toBe("supported");
      expect(result.layers.size).toBe(1);
      expect(scene.addedImagery).toHaveLength(1);
      expect(imageryProviders).toHaveLength(2);
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(scene.addedImagery[0]?.imageryProvider).toBe(imageryProviders[1]);

      result.layers.get("duplicate-imagery")?.remove();
      expect(scene.addedImagery).toHaveLength(0);
      expect(imageryProviders[1]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("applies a valid replacement after an unsupported primitive with the same ID", async () => {
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
        {
          kind: "imagery-layer",
          id: "mixed-imagery",
          sourceId: "invalid",
          protocol: "arcgis-imagery",
          url: "https://services.example.test/arcgis/rest/services/base/FeatureServer",
        },
        {
          kind: "imagery-layer",
          id: "mixed-imagery",
          sourceId: "valid",
          protocol: "url-template",
          url: "https://tiles.example.test/valid/{z}/{x}/{y}.png",
        },
      ]);

      expect(result.status).toBe("unsupported");
      expect(result.layers.size).toBe(1);
      expect(scene.addedImagery).toHaveLength(1);
      expect(imageryProviders).toHaveLength(1);
      expect(imageryProviders[0]?.options.url).toContain("/valid/");
    });

    it("rolls back a replacement when displaced-handle cleanup throws", async () => {
      const scene = createMockCesiumScene();
      failNextImageryDestroy = true;

      await expect(
        applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
          {
            kind: "imagery-layer",
            id: "cleanup-failure",
            sourceId: "first",
            protocol: "url-template",
            url: "https://tiles.example.test/first/{z}/{x}/{y}.png",
          },
          {
            kind: "imagery-layer",
            id: "cleanup-failure",
            sourceId: "second",
            protocol: "url-template",
            url: "https://tiles.example.test/second/{z}/{x}/{y}.png",
          },
        ]),
      ).rejects.toThrow("imagery cleanup failed");

      expect(scene.addedImagery).toHaveLength(0);
      expect(imageryProviders).toHaveLength(2);
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(imageryProviders[1]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("fails invalid imagery configuration closed before loading a provider", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        {
          kind: "imagery-layer",
          id: "missing-url",
          sourceId: "missing-url",
          protocol: "url-template",
          url: " ",
        },
        {
          kind: "imagery-layer",
          id: "absent-url",
          sourceId: "absent-url",
          protocol: "url-template",
        } as unknown as SceneRuntimePrimitive,
        {
          kind: "imagery-layer",
          id: "non-string-url",
          sourceId: "non-string-url",
          protocol: "url-template",
          url: 42,
        } as unknown as SceneRuntimePrimitive,
        {
          kind: "imagery-layer",
          id: "malformed-url",
          sourceId: "malformed-url",
          protocol: "single-tile",
          url: "http://[",
        },
        {
          kind: "imagery-layer",
          id: "credential-url",
          sourceId: "credential-url",
          protocol: "wms",
          url: "https://maps.example.test/wms?access_token=secret",
          layer: "world",
        },
        {
          kind: "imagery-layer",
          id: "access-key-url",
          sourceId: "access-key-url",
          protocol: "wms",
          url: "https://maps.example.test/wms?aws_access_key_id=secret",
          layer: "world",
        },
        {
          kind: "imagery-layer",
          id: "subscription-key-url",
          sourceId: "subscription-key-url",
          protocol: "url-template",
          url: "https://tiles.example.test/{z}/{x}/{y}.png?subscription-key=secret",
        },
        {
          kind: "imagery-layer",
          id: "proxy-authorization-url",
          sourceId: "proxy-authorization-url",
          protocol: "url-template",
          url: "https://tiles.example.test/{z}/{x}/{y}.png?Proxy-Authorization=Basic%20c2VjcmV0",
        },
        {
          kind: "imagery-layer",
          id: "cookie-url",
          sourceId: "cookie-url",
          protocol: "url-template",
          url: "https://tiles.example.test/{z}/{x}/{y}.png?Cookie=session%3Dsecret",
        },
        {
          kind: "imagery-layer",
          id: "credential-userinfo",
          sourceId: "credential-userinfo",
          protocol: "single-tile",
          url: "https://user:secret@images.example.test/snapshot.png",
        },
        {
          kind: "imagery-layer",
          id: "credential-fragment",
          sourceId: "credential-fragment",
          protocol: "url-template",
          url: "https://tiles.example.test/{z}/{x}/{y}.png#access_token=secret",
        },
        {
          kind: "imagery-layer",
          id: "malformed-parameters",
          sourceId: "malformed-parameters",
          protocol: "wms",
          url: "https://maps.example.test/wms",
          layer: "world",
          parameters: [{ token: "secret" }],
        } as unknown as SceneRuntimePrimitive,
        {
          kind: "imagery-layer",
          id: "credential-parameters",
          sourceId: "credential-parameters",
          protocol: "arcgis-imagery",
          url: "https://services.example.test/arcgis/rest/services/base/ImageServer",
          parameters: { apiKey: "secret" },
        },
        {
          kind: "imagery-layer",
          id: "access-key-parameters",
          sourceId: "access-key-parameters",
          protocol: "wmts",
          url: "https://maps.example.test/wmts",
          layer: "world",
          style: "default",
          tileMatrixSetId: "WebMercatorQuad",
          parameters: { access_key: "secret" },
        },
        {
          kind: "imagery-layer",
          id: "subscription-key-parameters",
          sourceId: "subscription-key-parameters",
          protocol: "wmts",
          url: "https://maps.example.test/wmts",
          layer: "world",
          style: "default",
          tileMatrixSetId: "WebMercatorQuad",
          parameters: { "ocp-apim-subscription-key": "secret" },
        },
        {
          kind: "imagery-layer",
          id: "proxy-authorization-parameters",
          sourceId: "proxy-authorization-parameters",
          protocol: "wms",
          url: "https://maps.example.test/wms",
          layer: "world",
          parameters: { "Proxy-Authorization": "Basic c2VjcmV0" },
        },
        {
          kind: "imagery-layer",
          id: "set-cookie-parameters",
          sourceId: "set-cookie-parameters",
          protocol: "wms",
          url: "https://maps.example.test/wms",
          layer: "world",
          parameters: { "Set-Cookie": "session=secret" },
        },
        {
          kind: "imagery-layer",
          id: "empty-subdomains",
          sourceId: "empty-subdomains",
          protocol: "url-template",
          url: "https://{s}.tiles.example.test/{z}/{x}/{y}.png",
          subdomains: [],
        },
        {
          kind: "imagery-layer",
          id: "missing-single-tile-subdomains",
          sourceId: "missing-single-tile-subdomains",
          protocol: "single-tile",
          url: "https://{s}.images.example.test/snapshot.png",
        },
        {
          kind: "imagery-layer",
          id: "unsafe-subdomain",
          sourceId: "unsafe-subdomain",
          protocol: "url-template",
          url: "https://{s}.tiles.example.test/{z}/{x}/{y}.png",
          subdomains: ["evil.test/path"],
        },
        {
          kind: "imagery-layer",
          id: "missing-mapserver-subdomains",
          sourceId: "missing-mapserver-subdomains",
          protocol: "arcgis-imagery",
          url: "https://{s}.services.example.test/arcgis/rest/services/base/MapServer",
        },
        {
          kind: "imagery-layer",
          id: "missing-wms-layer",
          sourceId: "missing-wms-layer",
          protocol: "wms",
          url: "https://maps.example.test/wms",
        },
        {
          kind: "imagery-layer",
          id: "missing-wmts-config",
          sourceId: "missing-wmts-config",
          protocol: "wmts",
          url: "https://maps.example.test/wmts",
          layer: "world",
        },
        {
          kind: "imagery-layer",
          id: "malformed-wmts-config",
          sourceId: "malformed-wmts-config",
          protocol: "wmts",
          url: "https://maps.example.test/wmts",
          layer: 42,
          style: [],
          tileMatrixSetId: {},
          format: 123,
        } as unknown as SceneRuntimePrimitive,
        {
          kind: "imagery-layer",
          id: "reserved-wmts-dimensions",
          sourceId: "reserved-wmts-dimensions",
          protocol: "wmts",
          url: "https://maps.example.test/wmts",
          layer: "world",
          style: "default",
          tileMatrixSetId: "WebMercatorQuad",
          parameters: { LAYER: "stale", TileMatrixSet: "stale", time: "old", TIME: "new" },
        },
        {
          kind: "imagery-layer",
          id: "reserved-wms-parameters",
          sourceId: "reserved-wms-parameters",
          protocol: "wms",
          url: "https://maps.example.test/wms",
          layer: "world",
          parameters: { REQUEST: "GetCapabilities", SERVICE: "WMS", time: "2026-08-01" },
        },
        {
          kind: "imagery-layer",
          id: "duplicate-wms-parameters",
          sourceId: "duplicate-wms-parameters",
          protocol: "wms",
          url: "https://maps.example.test/wms",
          layer: "world",
          parameters: { time: "old", TIME: "new" },
        },
        {
          kind: "imagery-layer",
          id: "invalid-opacity",
          sourceId: "invalid-opacity",
          protocol: "single-tile",
          url: "https://images.example.test/snapshot.png",
          opacity: 1.5,
        },
        {
          kind: "imagery-layer",
          id: "invalid-levels",
          sourceId: "invalid-levels",
          protocol: "arcgis-imagery",
          url: "https://services.example.test/arcgis/rest/services/base/MapServer",
          minimumLevel: 8,
          maximumLevel: 2,
        },
        {
          kind: "imagery-layer",
          id: "single-tile-levels",
          sourceId: "single-tile-levels",
          protocol: "single-tile",
          url: "https://images.example.test/snapshot.png",
          minimumLevel: 2,
          maximumLevel: 4,
        },
        {
          kind: "imagery-layer",
          id: "unsupported-mapserver-parameter",
          sourceId: "unsupported-mapserver-parameter",
          protocol: "arcgis-imagery",
          url: "https://services.example.test/arcgis/rest/services/base/MapServer",
          parameters: { customExportOption: "ignored" },
        },
        {
          kind: "imagery-layer",
          id: "reserved-imageserver-parameters",
          sourceId: "reserved-imageserver-parameters",
          protocol: "arcgis-imagery",
          url: "https://services.example.test/arcgis/rest/services/base/ImageServer",
          parameters: { imageSR: 4326, FORMAT: "jpg", transparent: false },
        },
        {
          kind: "imagery-layer",
          id: "invalid-mapserver-layers",
          sourceId: "invalid-mapserver-layers",
          protocol: "arcgis-imagery",
          url: "https://services.example.test/arcgis/rest/services/base/MapServer",
          parameters: { layers: "hide:1" },
        },
      ]);

      expect(result.status).toBe("unsupported");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
        expect.arrayContaining([
          "scene-primitive-imagery-source-missing-url",
          "scene-primitive-imagery-source-url-invalid",
          "scene-primitive-imagery-credentials-forbidden",
          "scene-primitive-imagery-service-config-missing",
          "scene-primitive-imagery-service-config-invalid",
          "scene-primitive-imagery-opacity-invalid",
          "scene-primitive-imagery-level-range-invalid",
          "scene-primitive-imagery-subdomains-invalid",
        ]),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-missing",
          primitiveId: "malformed-wmts-config",
          context: { missingFields: ["layer", "style", "tileMatrixSetId"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "reserved-wms-parameters",
          context: { invalidFields: ["parameters"], invalidParameterKeys: ["REQUEST", "SERVICE"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "duplicate-wms-parameters",
          context: { invalidFields: ["parameters"], invalidParameterKeys: ["TIME"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "reserved-wmts-dimensions",
          context: { invalidFields: ["parameters"], invalidParameterKeys: ["LAYER", "TileMatrixSet", "TIME"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "single-tile-levels",
          context: { invalidFields: ["minimumLevel", "maximumLevel"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "unsupported-mapserver-parameter",
          context: { invalidFields: ["parameters"], invalidParameterKeys: ["customExportOption"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "reserved-imageserver-parameters",
          context: {
            invalidFields: ["parameters"],
            invalidParameterKeys: ["imageSR", "FORMAT", "transparent"],
          },
        }),
      );
      expect(
        result.diagnostics
          .filter((diagnostic) => diagnostic.code === "scene-primitive-imagery-credentials-forbidden")
          .map((diagnostic) => diagnostic.primitiveId),
      ).toEqual(
        expect.arrayContaining([
          "subscription-key-url",
          "subscription-key-parameters",
          "proxy-authorization-url",
          "cookie-url",
          "proxy-authorization-parameters",
          "set-cookie-parameters",
        ]),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "invalid-mapserver-layers",
          context: { invalidFields: ["parameters"], invalidParameterKeys: ["layers"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-invalid",
          primitiveId: "malformed-wmts-config",
          context: { invalidFields: ["format"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-subdomains-invalid",
          primitiveId: "empty-subdomains",
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-missing",
          primitiveId: "missing-single-tile-subdomains",
          context: { missingFields: ["subdomains"] },
        }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-service-config-missing",
          primitiveId: "missing-mapserver-subdomains",
          context: { missingFields: ["subdomains"] },
        }),
      );
      expect(imageryProviders).toHaveLength(0);
      expect(scene.addedImagery).toHaveLength(0);
    });

    it("rolls back earlier imagery layers when a later provider fails", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      singleTileImageryFromUrl.mockRejectedValueOnce(new Error("single tile unavailable"));

      await expect(
        applyCesiumScenePrimitives({ camera, scene }, [
          {
            kind: "imagery-layer",
            id: "first",
            sourceId: "first",
            protocol: "url-template",
            url: "https://tiles.example.test/{z}/{x}/{y}.png",
          },
          {
            kind: "imagery-layer",
            id: "failing",
            sourceId: "failing",
            protocol: "single-tile",
            url: "https://images.example.test/unavailable.png",
          },
        ]),
      ).rejects.toThrow("single tile unavailable");

      expect(scene.addedImagery).toHaveLength(0);
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("restores displaced terrain when a later provider fails", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const cesium = (await import("cesium")) as never;
      await applyCesiumTerrain(
        scene,
        {
          kind: "elevation-source",
          id: "existing-terrain",
          sourceId: "existing-terrain",
          protocol: "quantized-mesh",
          url: "https://example.test/existing-terrain",
          exaggeration: 1.75,
        },
        cesium,
      );
      const existingProvider = scene.terrainProvider as { destroy: ReturnType<typeof vi.fn> };
      singleTileImageryFromUrl.mockRejectedValueOnce(new Error("single tile unavailable"));

      await expect(
        applyCesiumScenePrimitives({ camera, scene }, [
          {
            kind: "elevation-source",
            id: "replacement-terrain",
            sourceId: "replacement-terrain",
            protocol: "quantized-mesh",
            url: "https://example.test/replacement-terrain",
            exaggeration: 3,
          },
          {
            kind: "imagery-layer",
            id: "failing",
            sourceId: "failing",
            protocol: "single-tile",
            url: "https://images.example.test/unavailable.png",
          },
        ]),
      ).rejects.toThrow("single tile unavailable");

      const replacementProvider = await terrainFromUrl.mock.results[1]?.value;
      expect(scene.terrainProvider).toBe(existingProvider);
      expect(scene.verticalExaggeration).toBe(1.75);
      expect(existingProvider.destroy).not.toHaveBeenCalled();
      expect(replacementProvider.destroy).toHaveBeenCalledTimes(1);
    });

    it("rolls back applied layers when displaced terrain disposal fails", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const cesium = (await import("cesium")) as never;
      await applyCesiumTerrain(
        scene,
        {
          kind: "elevation-source",
          id: "existing-terrain",
          sourceId: "existing-terrain",
          protocol: "quantized-mesh",
          url: "https://example.test/existing-terrain",
          exaggeration: 1.5,
        },
        cesium,
      );
      const existingProvider = scene.terrainProvider as { destroy: ReturnType<typeof vi.fn> };
      existingProvider.destroy.mockImplementationOnce(() => {
        throw new Error("terrain cleanup failed");
      });

      await expect(
        applyCesiumScenePrimitives({ camera, scene }, [
          {
            kind: "elevation-source",
            id: "replacement-terrain",
            sourceId: "replacement-terrain",
            protocol: "quantized-mesh",
            url: "https://example.test/replacement-terrain",
            exaggeration: 2,
          },
          {
            kind: "imagery-layer",
            id: "basemap",
            sourceId: "basemap",
            protocol: "url-template",
            url: "https://tiles.example.test/{z}/{x}/{y}.png",
          },
        ]),
      ).rejects.toThrow("terrain cleanup failed");

      const replacementProvider = await terrainFromUrl.mock.results[1]?.value;
      expect(scene.terrainProvider).toBe(existingProvider);
      expect(scene.verticalExaggeration).toBe(1.5);
      expect(scene.addedImagery).toHaveLength(0);
      expect(existingProvider.destroy).toHaveBeenCalledTimes(1);
      expect(replacementProvider.destroy).toHaveBeenCalledTimes(1);
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("preserves the original terrain when intermediate cleanup fails", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const cesium = (await import("cesium")) as never;
      await applyCesiumTerrain(
        scene,
        {
          kind: "elevation-source",
          id: "original-terrain",
          sourceId: "original-terrain",
          protocol: "quantized-mesh",
          url: "https://example.test/original-terrain",
          exaggeration: 1.25,
        },
        cesium,
      );
      const originalProvider = scene.terrainProvider as { destroy: ReturnType<typeof vi.fn> };
      const intermediateDestroy = vi.fn().mockImplementationOnce(() => {
        throw new Error("intermediate terrain cleanup failed");
      });
      terrainFromUrl.mockImplementationOnce(async (url: string) => ({
        kind: "terrain-provider",
        url,
        destroy: intermediateDestroy,
      }));

      await expect(
        applyCesiumScenePrimitives({ camera, scene }, [
          {
            kind: "elevation-source",
            id: "intermediate-terrain",
            sourceId: "intermediate-terrain",
            protocol: "quantized-mesh",
            url: "https://example.test/intermediate-terrain",
            exaggeration: 2,
          },
          {
            kind: "elevation-source",
            id: "final-terrain",
            sourceId: "final-terrain",
            protocol: "quantized-mesh",
            url: "https://example.test/final-terrain",
            exaggeration: 3,
          },
        ]),
      ).rejects.toThrow("intermediate terrain cleanup failed");

      const finalProvider = await terrainFromUrl.mock.results[2]?.value;
      expect(scene.terrainProvider).toBe(originalProvider);
      expect(scene.verticalExaggeration).toBe(1.25);
      expect(originalProvider.destroy).not.toHaveBeenCalled();
      expect(intermediateDestroy).toHaveBeenCalledTimes(2);
      expect(finalProvider.destroy).toHaveBeenCalledTimes(1);
    });

    it("controls and disposes an owned imagery layer exactly once", async () => {
      const scene = createMockCesiumScene();
      const handle = await addCesiumImageryLayer(scene, {
        kind: "imagery-layer",
        id: "orthophoto",
        sourceId: "orthophoto",
        protocol: "url-template",
        url: "https://tiles.example.test/{z}/{x}/{y}.jpg",
        opacity: 0.4,
      });
      const layer = scene.addedImagery[0];
      const provider = imageryProviders[0];

      expect(handle.kind).toBe("imagery-layer");
      expect(handle.protocol).toBe("url-template");
      expect(layer?.alpha).toBe(0.4);
      handle.setVisible(false);
      expect(layer?.show).toBe(false);
      handle.setOpacity?.(0.8);
      expect(layer?.alpha).toBe(0.8);
      expect(() => handle.setOpacity?.(2)).toThrow(RangeError);

      handle.remove();
      handle.remove();
      expect(scene.addedImagery).toHaveLength(0);
      expect(layer?.destroy).toHaveBeenCalledTimes(1);
      expect(provider?.destroy).toHaveBeenCalledTimes(1);
    });

    it("disposes a provider when the imagery collection rejects its layer", async () => {
      const scene = createMockCesiumScene();
      vi.spyOn(
        scene.imageryLayers as NonNullable<CesiumSceneLike["imageryLayers"]>,
        "addImageryProvider",
      ).mockImplementation(() => {
        throw new Error("imagery layer rejected");
      });

      await expect(
        addCesiumImageryLayer(scene, {
          kind: "imagery-layer",
          id: "rejected",
          sourceId: "rejected",
          protocol: "url-template",
          url: "https://tiles.example.test/{z}/{x}/{y}.jpg",
        }),
      ).rejects.toThrow("imagery layer rejected");
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(scene.addedImagery).toHaveLength(0);
    });

    it("reports a stable diagnostic when the Cesium target lacks imagery layers", async () => {
      const camera = createMockCesiumCamera();
      const sceneWithImagery = createMockCesiumScene();
      const scene: CesiumSceneLike = { primitives: sceneWithImagery.primitives };
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        {
          kind: "imagery-layer",
          id: "no-target",
          sourceId: "no-target",
          protocol: "url-template",
          url: "https://tiles.example.test/{z}/{x}/{y}.png",
        },
      ]);

      expect(result.status).toBe("unsupported");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-primitive-imagery-target-missing",
          primitiveId: "no-target",
          status: "unsupported",
        }),
      );
      expect(imageryProviders).toHaveLength(0);
    });

    it("places a glTF model at its position/rotation/scale", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera, scene }, [
        {
          kind: "model-layer",
          id: "turbine",
          uri: "https://example.test/turbine.glb",
          format: "glb",
          position: [-122.4, 37.8, 50],
          rotation: [90, 0, 0],
          scale: 3,
        },
      ]);

      expect(modelFromGltfAsync).toHaveBeenCalledTimes(1);
      const call = modelFromGltfAsync.mock.calls[0]?.[0] as { url: string; scale?: number; modelMatrix: unknown };
      expect(call.url).toBe("https://example.test/turbine.glb");
      // Scale must be applied EXACTLY once. Cesium multiplies `Model.scale` on
      // top of `modelMatrix`, so the scale lives in the matrix only and the
      // `scale` option must be absent (otherwise a requested 3 renders as 9).
      expect(call.scale).toBeUndefined();
      // A non-unit scale folds a uniform-scale matrix into the fixed frame.
      expect(call.modelMatrix).toMatchObject({ kind: "scaled", scale: 3 });
      expect(scene.added).toHaveLength(1);
      expect(result.layers.get("turbine")?.kind).toBe("model-layer");
    });

    it("maps a model-layer primitive to a placement with radian orientation", () => {
      const placement = modelLayerToCesiumPlacement({
        kind: "model-layer",
        id: "m",
        uri: "x",
        format: "gltf",
        position: [10, 20, 5],
        rotation: [180, -90, 45],
        scale: [2, 2, 2],
      });
      expect(placement.position).toEqual({ longitude: 10, latitude: 20, height: 5 });
      expect(placement.orientation.heading).toBeCloseTo(Math.PI, 12);
      expect(placement.orientation.pitch).toBeCloseTo(-Math.PI / 2, 12);
      expect(placement.scale).toBe(2);
    });

    it("collapses scale variants to a positive uniform factor (default 1)", () => {
      expect(resolveCesiumModelScale(4)).toBe(4);
      expect(resolveCesiumModelScale([5, 1, 1])).toBe(5);
      expect(resolveCesiumModelScale(undefined)).toBe(1);
      expect(resolveCesiumModelScale(0)).toBe(1);
      expect(resolveCesiumModelScale(Number.NaN)).toBe(1);
    });

    it("skips layer rendering when the target has no scene (camera-only)", async () => {
      const camera = createMockCesiumCamera();
      const result = await applyCesiumScenePrimitives({ camera }, [
        { kind: "model-layer", id: "city-tiles", uri: "https://example.test/tileset.json", format: "3d-tiles" },
      ]);
      expect(tilesetFromUrl).not.toHaveBeenCalled();
      expect(result.layers.size).toBe(0);
    });

    it("resolves a picked 3D-Tiles feature's batch/structural-metadata attributes", () => {
      const feature = {
        getPropertyIds: () => ["name", "height"],
        getProperty: (name: string) => (name === "name" ? "Town Hall" : 42),
      };
      const scene = createMockCesiumScene(feature);
      const attributes = pickCesiumFeatureAttributes(scene, { x: 100, y: 200 });
      expect(attributes).toEqual({ name: "Town Hall", height: 42 });
      expect(scene.pick).toHaveBeenCalledWith({ x: 100, y: 200 });
    });

    it("returns undefined for picks that are not 3D-Tiles features", () => {
      expect(resolvePickedFeatureAttributes(undefined)).toBeUndefined();
      expect(resolvePickedFeatureAttributes(null)).toBeUndefined();
      // A glTF model `Model` pick has no batch-property accessors.
      expect(resolvePickedFeatureAttributes({ primitive: {} })).toBeUndefined();
      const scene = createMockCesiumScene(undefined);
      expect(pickCesiumFeatureAttributes(scene, { x: 0, y: 0 })).toBeUndefined();
    });
  });

  describe("model-layer contract (#927)", () => {
    beforeEach(() => {
      tilesetFromUrl.mockClear();
      modelFromGltfAsync.mockClear();
    });

    const modelPrimitive = (
      overrides: Partial<SceneModelLayerPrimitive> & Pick<SceneModelLayerPrimitive, "format">,
    ): SceneModelLayerPrimitive => ({
      kind: "model-layer",
      id: "asset",
      uri: "https://example.test/tileset.json",
      ...overrides,
    });

    it.each([
      ["", "scene-primitive-model-source-missing-uri"],
      ["   ", "scene-primitive-model-source-missing-uri"],
      ["javascript:alert(1)", "scene-primitive-model-source-uri-invalid"],
      ["data:model/gltf+json,{}", "scene-primitive-model-source-uri-invalid"],
      ["https://user:secret@example.test/tileset.json", "scene-primitive-model-credentials-forbidden"],
      ["https://example.test/tileset.json?access_token=abc", "scene-primitive-model-credentials-forbidden"],
      ["https://example.test/tileset.json#api_key=abc", "scene-primitive-model-credentials-forbidden"],
    ])("fails a model URI %j closed with %s", async (uri, code) => {
      const primitive = modelPrimitive({ format: "3d-tiles", uri });
      const diagnostics = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES);
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
      expect(diagnostics.every((diagnostic) => diagnostic.status === "unsupported")).toBe(true);

      // Nothing reaches the renderer: neither via apply() nor via the direct
      // exported factory.
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [primitive]);
      expect(result.status).toBe("unsupported");
      expect(scene.added).toHaveLength(0);
      expect(tilesetFromUrl).not.toHaveBeenCalled();
      await expect(addCesium3DTileset(scene, primitive)).rejects.toThrow(code);
      expect(tilesetFromUrl).not.toHaveBeenCalled();
    });

    it("accepts a relative, credential-free asset URI", () => {
      const diagnostics = diagnoseScenePrimitives(
        [modelPrimitive({ format: "3d-tiles", uri: "/assets/city/tileset.json" })],
        CESIUM_SCENE_CAPABILITIES,
      );
      expect(diagnostics.map((diagnostic) => diagnostic.status)).toEqual(["supported"]);
    });

    it.each([
      ["position", { position: [Number.NaN, 10, 0] as const }],
      ["position", { position: [200, 10, 0] as const }],
      ["position", { position: [10, 95, 0] as const }],
      ["position", { position: [10, 20, Number.POSITIVE_INFINITY] as const }],
      ["rotation", { rotation: [Number.NaN, 0, 0] as const }],
      ["scale", { scale: 0 }],
      ["scale", { scale: -2 }],
      ["scale", { scale: [1, 0, 1] as const }],
    ])("fails invalid placement (%s) closed before loading the peer", async (field, overrides) => {
      const primitive = modelPrimitive({ format: "glb", uri: "https://example.test/turbine.glb", ...overrides });
      const diagnostics = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES);
      const placement = diagnostics.find((diagnostic) => diagnostic.code === "scene-primitive-model-placement-invalid");
      expect(placement?.status).toBe("unsupported");
      expect(placement?.context).toEqual({ invalidFields: [field] });

      const scene = createMockCesiumScene();
      await expect(addCesiumModel(scene, primitive)).rejects.toThrow("scene-primitive-model-placement-invalid");
      expect(modelFromGltfAsync).not.toHaveBeenCalled();
    });

    it("keeps a valid placement supported", () => {
      const diagnostics = diagnoseScenePrimitives(
        [
          modelPrimitive({
            format: "glb",
            uri: "https://example.test/turbine.glb",
            position: [-180, -90, -12.5],
            rotation: [0, -90, 359],
            scale: [2, 2, 2],
          }),
        ],
        CESIUM_SCENE_CAPABILITIES,
      );
      expect(diagnostics.map((diagnostic) => diagnostic.status)).toEqual(["supported"]);
    });

    it("passes validated point-cloud shading through to the tileset factory", async () => {
      const scene = createMockCesiumScene();
      const primitive = modelPrimitive({
        id: "lidar",
        format: "3d-tiles",
        uri: "https://example.test/lidar/tileset.json",
        pointCloudShading: {
          attenuation: true,
          maximumAttenuation: 4,
          geometricErrorScale: 0.75,
          eyeDomeLighting: true,
          eyeDomeLightingStrength: 1.5,
          eyeDomeLightingRadius: 2,
        },
      });

      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [primitive]);

      expect(result.status).toBe("supported");
      expect(tilesetFromUrl).toHaveBeenCalledWith("https://example.test/lidar/tileset.json", {
        pointCloudShading: {
          attenuation: true,
          maximumAttenuation: 4,
          geometricErrorScale: 0.75,
          eyeDomeLighting: true,
          eyeDomeLightingStrength: 1.5,
          eyeDomeLightingRadius: 2,
        },
      });
    });

    it("omits the options bag entirely when no shading is configured", async () => {
      const scene = createMockCesiumScene();
      await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
        modelPrimitive({ format: "3d-tiles" }),
      ]);
      expect(tilesetFromUrl).toHaveBeenCalledWith("https://example.test/tileset.json");
    });

    it.each([
      ["attenuation", { attenuation: "yes" }],
      ["maximumAttenuation", { maximumAttenuation: 0 }],
      ["geometricErrorScale", { geometricErrorScale: Number.NaN }],
      ["eyeDomeLighting", { eyeDomeLighting: 1 }],
      ["eyeDomeLightingStrength", { eyeDomeLightingStrength: -1 }],
      ["eyeDomeLightingRadius", { eyeDomeLightingRadius: Number.POSITIVE_INFINITY }],
    ])("fails invalid point-cloud shading (%s) closed", async (field, shading) => {
      const primitive = modelPrimitive({
        format: "3d-tiles",
        pointCloudShading: shading as SceneModelLayerPrimitive["pointCloudShading"],
      });
      const diagnostic = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES).find(
        (entry) => entry.code === "scene-primitive-model-point-cloud-shading-invalid",
      );
      expect(diagnostic?.status).toBe("unsupported");
      expect(diagnostic?.context).toEqual({ invalidFields: [field] });

      await expect(addCesium3DTileset(createMockCesiumScene(), primitive)).rejects.toThrow(
        "scene-primitive-model-point-cloud-shading-invalid",
      );
      expect(tilesetFromUrl).not.toHaveBeenCalled();
    });

    it.each([
      ["unknown key", { maximumAttenutation: 4 }, ["maximumAttenutation"]],
      ["extra key alongside a valid one", { attenuation: true, sizeInMeters: true }, ["sizeInMeters"]],
      ["array", [] as unknown, ["pointCloudShading"]],
      ["class instance", new (class {})() as unknown, ["pointCloudShading"]],
      ["null-ish", null as unknown, ["pointCloudShading"]],
    ])("treats point-cloud shading as a closed record and rejects %s", (_label, shading, invalidFields) => {
      const primitive = modelPrimitive({
        format: "3d-tiles",
        pointCloudShading: shading as SceneModelLayerPrimitive["pointCloudShading"],
      });
      const diagnostic = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES).find(
        (entry) => entry.code === "scene-primitive-model-point-cloud-shading-invalid",
      );
      // An unknown key would otherwise be dropped on the way to Cesium, so the
      // layer would render with engine defaults while reporting `supported`.
      expect(diagnostic?.status).toBe("unsupported");
      expect(diagnostic?.context).toEqual({ invalidFields });
    });

    it("rejects a shading record carrying an accessor instead of plain data", () => {
      const shading = Object.defineProperty({}, "attenuation", { get: () => true, enumerable: true });
      const diagnostic = diagnoseScenePrimitives(
        [
          modelPrimitive({
            format: "3d-tiles",
            pointCloudShading: shading as SceneModelLayerPrimitive["pointCloudShading"],
          }),
        ],
        CESIUM_SCENE_CAPABILITIES,
      ).find((entry) => entry.code === "scene-primitive-model-point-cloud-shading-invalid");
      expect(diagnostic?.context).toEqual({ invalidFields: ["pointCloudShading"] });
    });

    it("rejects point-cloud shading on a non-tiled model format", () => {
      const diagnostic = diagnoseScenePrimitives(
        [
          modelPrimitive({
            format: "glb",
            uri: "https://example.test/turbine.glb",
            pointCloudShading: { attenuation: true },
          }),
        ],
        CESIUM_SCENE_CAPABILITIES,
      ).find((entry) => entry.code === "scene-primitive-model-point-cloud-shading-invalid");
      expect(diagnostic?.status).toBe("unsupported");
      expect(diagnostic?.context).toEqual({ invalidFields: ["pointCloudShading"] });
    });

    it("fails a declared-but-unmaterialized format closed instead of silently rendering nothing", async () => {
      const primitive = modelPrimitive({
        id: "i3s-city",
        format: "i3s",
        uri: "https://example.test/SceneServer/layers/0",
      });
      // Cesium the engine can consume I3S, so the format stays declared...
      expect(CESIUM_SCENE_CAPABILITIES.modelLayer?.formats).toContain("i3s");
      // ...but this adapter does not materialize it, and says so.
      expect(CESIUM_SCENE_CAPABILITIES.modelLayer?.materializedFormats).toEqual(["gltf", "glb", "3d-tiles"]);

      const diagnostics = diagnoseScenePrimitives([primitive], CESIUM_SCENE_CAPABILITIES);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "scene-primitive-model-format-not-materialized",
        status: "unsupported",
        severity: "error",
        primitiveId: "i3s-city",
        renderer: "cesium",
        context: { format: "i3s", materializedFormats: ["gltf", "glb", "3d-tiles"] },
      });

      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [primitive]);
      expect(result.status).toBe("unsupported");
      expect(result.layers.size).toBe(0);
      expect(scene.added).toHaveLength(0);
      expect(tilesetFromUrl).not.toHaveBeenCalled();
      expect(modelFromGltfAsync).not.toHaveBeenCalled();
    });

    it("keeps an entirely unsupported format on the existing capability diagnostic", () => {
      const diagnostics = diagnoseScenePrimitives(
        [modelPrimitive({ id: "obj-asset", format: "obj", uri: "https://example.test/model.obj" })],
        CESIUM_SCENE_CAPABILITIES,
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.code).toBe("scene-primitive-unsupported");
      expect(diagnostics[0]?.message).toContain("'obj' is not supported by cesium");
    });

    it("controls model opacity through the handle and refuses out-of-range values", async () => {
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
        modelPrimitive({ id: "turbine", format: "glb", uri: "https://example.test/turbine.glb" }),
      ]);
      const handle = result.layers.get("turbine");
      const model = scene.added[0] as { color?: unknown };

      expect(handle?.setOpacity).toBeTypeOf("function");
      handle?.setOpacity?.(0.25);
      expect(model.color).toEqual({ kind: "color", alpha: 0.25 });
      expect(() => handle?.setOpacity?.(1.5)).toThrow(RangeError);
      expect(() => handle?.setOpacity?.(Number.NaN)).toThrow(RangeError);
    });

    it("omits setOpacity for tilesets, whose translucency is a style concern", async () => {
      const scene = createMockCesiumScene();
      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
        modelPrimitive({ id: "city-tiles", format: "3d-tiles" }),
      ]);
      expect(result.layers.get("city-tiles")?.setOpacity).toBeUndefined();
    });

    it("removes an owned tileset exactly once and no-ops afterwards", async () => {
      const scene = createMockCesiumScene();
      const destroy = vi.fn();
      let destroyed = false;
      tilesetFromUrl.mockImplementationOnce(async (url: string) => ({
        kind: "tileset",
        url,
        options: undefined,
        show: true,
        modelMatrix: undefined,
        // A collection with `destroyPrimitives = false` would otherwise leak the
        // tileset, so the handle asserts the destroy behind `isDestroyed()`.
        destroy: () => {
          destroyed = true;
          destroy();
        },
        isDestroyed: () => destroyed,
      }));

      const result = await applyCesiumScenePrimitives({ camera: createMockCesiumCamera(), scene }, [
        modelPrimitive({ id: "city-tiles", format: "3d-tiles" }),
      ]);
      const handle = result.layers.get("city-tiles");
      const tileset = scene.added[0] as { show: boolean };

      handle?.remove();
      expect(scene.added).toHaveLength(0);
      expect(destroy).toHaveBeenCalledTimes(1);

      handle?.remove();
      expect(destroy).toHaveBeenCalledTimes(1);

      // Post-removal control calls must not mutate a destroyed object.
      handle?.setVisible(false);
      expect(tileset.show).toBe(true);
    });

    it("destroys an owned tileset when the style sidecar fails after load", async () => {
      const scene = createMockCesiumScene();
      const destroy = vi.fn();
      let destroyed = false;
      tilesetFromUrl.mockImplementationOnce(async (url: string) => ({
        kind: "tileset",
        url,
        options: undefined,
        show: true,
        modelMatrix: undefined,
        extras: { honua_style: { encoding: "3d-tiles-styling", version: "1.0", uri: "style.json" } },
        destroy: () => {
          destroyed = true;
          destroy();
        },
        isDestroyed: () => destroyed,
      }));
      const fetchImpl = vi.fn(async () => {
        throw new Error("style sidecar unreachable");
      });

      await expect(
        addCesium3DTileset(scene, modelPrimitive({ id: "city-tiles", format: "3d-tiles" }), undefined, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toThrow("style sidecar unreachable");

      expect(scene.added).toHaveLength(0);
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it("destroys an owned model when the primitive collection rejects it", async () => {
      const scene = createMockCesiumScene();
      scene.primitives.add = () => {
        throw new Error("collection rejected the model");
      };
      const destroy = vi.fn();
      let destroyed = false;
      modelFromGltfAsync.mockImplementationOnce(async (options: Record<string, unknown>) => ({
        kind: "model",
        url: options.url,
        modelMatrix: options.modelMatrix,
        scale: undefined,
        show: true,
        color: undefined,
        destroy: () => {
          destroyed = true;
          destroy();
        },
        isDestroyed: () => destroyed,
      }));

      await expect(
        addCesiumModel(scene, modelPrimitive({ id: "turbine", format: "glb", uri: "https://example.test/t.glb" })),
      ).rejects.toThrow("collection rejected the model");
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it("refuses to serialize a credential-bearing model binding into workspace state", () => {
      const workspace = createSceneWorkspace();
      const dispatchPrimitive = (primitive: SceneModelLayerPrimitive) => () => {
        workspace.dispatch({ kind: "set-primitives", primitives: [primitive] });
      };

      expect(
        dispatchPrimitive(
          modelPrimitive({
            id: "signed",
            format: "3d-tiles",
            uri: "https://example.test/tileset.json?api_key=secret",
          }),
        ),
      ).toThrow(/credential-free/);
      expect(dispatchPrimitive(modelPrimitive({ id: "bad", format: "3d-tiles", uri: "javascript:alert(1)" }))).toThrow(
        /invalid asset URI/,
      );
      expect(workspace.state.primitives).toEqual({});

      expect(dispatchPrimitive(modelPrimitive({ id: "ok", format: "3d-tiles" }))).not.toThrow();
      expect(Object.keys(workspace.state.primitives)).toEqual(["ok"]);
    });
  });

  it("does not statically import Cesium from the scene-workspace sources", () => {
    const sceneWorkspaceRoot = path.resolve(process.cwd(), "src", "scene-workspace");
    const files = fs.readdirSync(sceneWorkspaceRoot).filter((file) => file.endsWith(".ts"));
    const source = files.map((file) => fs.readFileSync(path.join(sceneWorkspaceRoot, file), "utf8")).join("\n");

    // Static `import ... from "cesium"` would eagerly pull Cesium into the 2D
    // bundle. Only the lazy dynamic `import("cesium")` is allowed.
    expect(source).not.toMatch(/from\s+["']cesium["']/);
    expect(source).toMatch(/import\(["']cesium["']\)/);
  });
});
