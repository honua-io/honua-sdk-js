import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Cesium needs a WebGL context that is unavailable headless, and a real
// `Cartesian3` / model matrix is opaque ECEF geometry. Mock only the surface the
// adapter touches lazily (`Cartesian3.fromDegrees`, the model-matrix helpers,
// and the async layer factories) so `apply()` stays a fast, pure wiring test.
// The 2D bundle never loads this module — see the static-import guard test.
const tilesetFromUrl = vi.fn(async (url: string) => ({ kind: "tileset", url, show: true, modelMatrix: undefined }));
const modelFromGltfAsync = vi.fn(async (options: Record<string, unknown>) => ({
  kind: "model",
  url: options.url,
  modelMatrix: options.modelMatrix,
  scale: options.scale,
  show: true,
}));
const terrainFromUrl = vi.fn(async (url: string) => ({ kind: "terrain-provider", url }));

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
  Model: {
    fromGltfAsync: (options: Record<string, unknown>) => modelFromGltfAsync(options),
  },
  CesiumTerrainProvider: {
    fromUrl: (url: string) => terrainFromUrl(url),
  },
}));

import {
  CESIUM_SCENE_CAPABILITIES,
  type CesiumCameraLike,
  type CesiumSceneLike,
  type SceneCameraState,
  type SceneRuntimePrimitive,
  applyCameraStateToCesiumCamera,
  applyCesiumScenePrimitives,
  cameraStateToCesiumView,
  cesiumCameraToSceneState,
  createCesiumSceneAdapter,
  createSceneWorkspace,
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
  pick: ReturnType<typeof vi.fn>;
} {
  const added: unknown[] = [];
  const pick = vi.fn(() => pickResult);
  const scene: CesiumSceneLike & { added: unknown[]; pick: ReturnType<typeof vi.fn> } = {
    added,
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
      const call = modelFromGltfAsync.mock.calls[0]?.[0] as { url: string; scale: number; modelMatrix: unknown };
      expect(call.url).toBe("https://example.test/turbine.glb");
      expect(call.scale).toBe(3);
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
