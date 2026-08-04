import { beforeEach, describe, expect, it, vi } from "vitest";

// The mount lifecycle is proven against an honest fake-Cesium seam: every symbol
// the adapter reads off the lazily-imported peer is stubbed, and every stub
// tracks construction + destruction so "released exactly once" is an assertion
// rather than a claim. Real-Cesium browser fixtures are issue #928; this suite
// deliberately stays in jsdom/vitest so the lifecycle math is deterministic.

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

interface DestroyableStub {
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
}

function destroyable(onDestroy?: () => void): DestroyableStub {
  let destroyed = false;
  return {
    destroy: vi.fn(() => {
      onDestroy?.();
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
  };
}

const tilesets: Array<{ url: string } & DestroyableStub & { show: boolean; modelMatrix?: unknown }> = [];
const models: Array<{ url: unknown } & DestroyableStub & { show: boolean; color?: unknown }> = [];
const terrainProviders: Array<{ url: string } & DestroyableStub> = [];
const imageryProviders: Array<{ kind: string } & DestroyableStub> = [];

let tilesetGate: Deferred<void> | undefined;
let modelGate: Deferred<void> | undefined;
let failNextTerrainDestroy = false;

const tilesetFromUrl = vi.fn(async (url: string, options?: Record<string, unknown>) => {
  if (tilesetGate) await tilesetGate.promise;
  const tileset = { url, options, show: true, modelMatrix: undefined as unknown, ...destroyable() };
  tilesets.push(tileset);
  return tileset;
});

const modelFromGltfAsync = vi.fn(async (options: Record<string, unknown>) => {
  if (modelGate) await modelGate.promise;
  const model = {
    url: options.url,
    modelMatrix: options.modelMatrix,
    show: true,
    color: undefined as unknown,
    ...destroyable(),
  };
  models.push(model);
  return model;
});

const terrainFromUrl = vi.fn(async (url: string) => {
  const provider = {
    url,
    ...destroyable(() => {
      if (failNextTerrainDestroy) {
        failNextTerrainDestroy = false;
        throw new Error("terrain cleanup failed");
      }
    }),
  };
  terrainProviders.push(provider);
  return provider;
});

class MockImageryProvider {
  readonly destroy: ReturnType<typeof vi.fn>;
  #destroyed = false;

  constructor(
    readonly kind: string,
    readonly options: Record<string, unknown>,
  ) {
    this.destroy = vi.fn(() => {
      this.#destroyed = true;
    });
    imageryProviders.push(this as unknown as { kind: string } & DestroyableStub);
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }
}

class MockUrlTemplateImageryProvider extends MockImageryProvider {
  constructor(options: Record<string, unknown>) {
    super("url-template", options);
  }
}

const singleTileImageryFromUrl = vi.fn(
  async (url: string, options: Record<string, unknown> = {}) =>
    new MockImageryProvider("single-tile", { url, ...options }),
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
  Cesium3DTileStyle: class {},
  Color: { WHITE: { withAlpha: (alpha: number) => ({ kind: "color", alpha }) } },
  Model: { fromGltfAsync: (options: Record<string, unknown>) => modelFromGltfAsync(options) },
  CesiumTerrainProvider: { fromUrl: (url: string) => terrainFromUrl(url) },
  UrlTemplateImageryProvider: MockUrlTemplateImageryProvider,
  WebMapServiceImageryProvider: MockImageryProvider,
  WebMapTileServiceImageryProvider: MockImageryProvider,
  SingleTileImageryProvider: {
    fromUrl: (url: string, options?: Record<string, unknown>) => singleTileImageryFromUrl(url, options),
  },
  ArcGisMapServerImageryProvider: {
    fromUrl: (url: string, options?: Record<string, unknown>) => singleTileImageryFromUrl(url, options),
  },
}));

import {
  type CesiumCameraLike,
  type CesiumSceneLike,
  DEFAULT_SCENE_MOUNT_LAYER_LIMIT,
  HonuaCesiumSceneMountError,
  type SceneCameraPrimitive,
  type SceneElevationSourcePrimitive,
  type SceneImageryLayerPrimitive,
  type SceneModelLayerPrimitive,
  type SceneRuntimePrimitive,
  applyCesiumScenePrimitives,
  mountScenePrimitivesToCesium,
} from "../src/scene-workspace/index.js";

const DEG2RAD = Math.PI / 180;

function createMockCesiumCamera(): CesiumCameraLike & { setView: ReturnType<typeof vi.fn> } {
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
      if (options.orientation?.heading !== undefined) orientation.heading = options.orientation.heading;
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

type MockImageryLayer = { imageryProvider: unknown; show: boolean; alpha: number; destroy: ReturnType<typeof vi.fn> };

function createMockCesiumScene(): CesiumSceneLike & {
  added: unknown[];
  addedImagery: MockImageryLayer[];
  addPrimitive: ReturnType<typeof vi.fn>;
} {
  const added: unknown[] = [];
  const addedImagery: MockImageryLayer[] = [];
  const addPrimitive = vi.fn((primitive: unknown) => {
    added.push(primitive);
    return primitive;
  });
  return {
    added,
    addedImagery,
    addPrimitive,
    verticalExaggeration: 1,
    terrainProvider: undefined,
    primitives: {
      add: addPrimitive,
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
        const index = addedImagery.indexOf(layer as MockImageryLayer);
        if (index === -1) return false;
        addedImagery.splice(index, 1);
        if (destroy) layer.destroy?.();
        return true;
      },
      contains(layer) {
        return addedImagery.includes(layer as MockImageryLayer);
      },
    },
  };
}

const TERRAIN: SceneElevationSourcePrimitive = {
  kind: "elevation-source",
  id: "site-terrain",
  sourceId: "site-terrain",
  protocol: "quantized-mesh",
  url: "https://terrain.example.test/tiles",
  exaggeration: 1.5,
};
const IMAGERY: SceneImageryLayerPrimitive = {
  kind: "imagery-layer",
  id: "orthophoto",
  sourceId: "orthophoto",
  protocol: "url-template",
  url: "https://tiles.example.test/{z}/{x}/{y}.png",
  opacity: 0.8,
};
const TILESET: SceneModelLayerPrimitive = {
  kind: "model-layer",
  id: "city-tiles",
  uri: "https://assets.example.test/tileset.json",
  format: "3d-tiles",
};
const MODEL: SceneModelLayerPrimitive = {
  kind: "model-layer",
  id: "turbine",
  uri: "https://assets.example.test/turbine.glb",
  format: "glb",
  position: [-122.4, 37.8, 50],
};
const CAMERA: SceneCameraPrimitive = {
  kind: "camera",
  id: "initial-view",
  camera: { longitude: -122.4, latitude: 37.8, height: 900, heading: 30 },
};

function fullPlan(): SceneRuntimePrimitive[] {
  return [CAMERA, TERRAIN, IMAGERY, TILESET, MODEL];
}

beforeEach(() => {
  tilesets.length = 0;
  models.length = 0;
  terrainProviders.length = 0;
  imageryProviders.length = 0;
  tilesetGate = undefined;
  modelGate = undefined;
  failNextTerrainDestroy = false;
  vi.clearAllMocks();
});

describe("cesium scene mount lifecycle", () => {
  it("returns one handle that owns the plan's diagnostics, layers, and disposal", async () => {
    const camera = createMockCesiumCamera();
    const scene = createMockCesiumScene();

    const mount = await mountScenePrimitivesToCesium({ camera, scene }, fullPlan());

    expect(mount.renderer).toBe("cesium");
    expect(mount.state).toBe("ready");
    expect(mount.revision).toBe(1);
    expect(mount.layerLimit).toBe(DEFAULT_SCENE_MOUNT_LAYER_LIMIT);
    expect([...mount.layers.keys()].sort()).toEqual(["city-tiles", "orthophoto", "site-terrain", "turbine"]);
    expect(mount.status).toBe("supported");
    expect(mount.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "scene-mount-applied",
        severity: "info",
        renderer: "cesium",
        context: expect.objectContaining({ revision: 1, layerLimit: DEFAULT_SCENE_MOUNT_LAYER_LIMIT }),
      }),
    );
    // Plan-scoped findings survive alongside the lifecycle finding.
    expect(mount.diagnostics.some((diagnostic) => diagnostic.code.startsWith("scene-primitive-"))).toBe(true);
    expect(scene.added).toHaveLength(2);
    expect(scene.addedImagery).toHaveLength(1);
    expect(scene.terrainProvider).toBe(terrainProviders[0]);
    expect(camera.setView).toHaveBeenCalledTimes(1);
  });

  it("releases every adapter-owned resource exactly once and is idempotent", async () => {
    const camera = createMockCesiumCamera();
    const scene = createMockCesiumScene();
    const mount = await mountScenePrimitivesToCesium({ camera, scene }, fullPlan());
    const imageryLayer = scene.addedImagery[0];

    mount.dispose();
    mount.dispose();
    mount.dispose();

    expect(mount.state).toBe("disposed");
    expect(mount.layers.size).toBe(0);
    expect(scene.added).toHaveLength(0);
    expect(scene.addedImagery).toHaveLength(0);
    expect(scene.terrainProvider).toBeUndefined();
    expect(scene.verticalExaggeration).toBe(1);
    expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(models[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(terrainProviders[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(imageryLayer?.destroy).toHaveBeenCalledTimes(1);
  });

  it("refuses to apply a plan through a disposed mount", async () => {
    const mount = await mountScenePrimitivesToCesium(
      { camera: createMockCesiumCamera(), scene: createMockCesiumScene() },
      [TILESET],
    );
    mount.dispose();

    await expect(mount.apply([TILESET])).rejects.toThrow(HonuaCesiumSceneMountError);
    await expect(mount.apply([TILESET])).rejects.toThrow(/disposed/);
    expect(tilesetFromUrl).toHaveBeenCalledTimes(1);
  });

  describe("plan revisions", () => {
    it("reuses every unchanged primitive without reconstructing it", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera, scene }, fullPlan());
      const originalTileset = mount.layers.get("city-tiles");
      const originalImagery = mount.layers.get("orthophoto");

      const revision = await mount.apply(fullPlan());

      expect(revision.revision).toBe(2);
      expect(revision.created).toEqual([]);
      expect(revision.disposed).toEqual([]);
      expect([...revision.reused].sort()).toEqual(["city-tiles", "orthophoto", "site-terrain", "turbine"]);
      // Nothing was rebuilt: the peer factories were never called a second time.
      expect(tilesetFromUrl).toHaveBeenCalledTimes(1);
      expect(modelFromGltfAsync).toHaveBeenCalledTimes(1);
      expect(terrainFromUrl).toHaveBeenCalledTimes(1);
      expect(imageryProviders).toHaveLength(1);
      expect(scene.added).toHaveLength(2);
      expect(scene.addedImagery).toHaveLength(1);
      // The very same handles are carried forward, so host-applied visibility
      // and opacity survive the revision.
      expect(mount.layers.get("city-tiles")).toBe(originalTileset);
      expect(mount.layers.get("orthophoto")).toBe(originalImagery);
      // An unchanged camera primitive does not yank a camera the user has moved.
      expect(camera.setView).toHaveBeenCalledTimes(1);
    });

    it("re-applies a camera whose state changed", async () => {
      const camera = createMockCesiumCamera();
      const mount = await mountScenePrimitivesToCesium({ camera, scene: createMockCesiumScene() }, [CAMERA]);

      await mount.apply([{ ...CAMERA, camera: { longitude: 0, latitude: 0, height: 100 } }]);

      expect(camera.setView).toHaveBeenCalledTimes(2);
    });

    it("disposes exactly the primitives that left the plan", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, fullPlan());
      const droppedTileset = tilesets[0];
      const keptModel = models[0];

      const revision = await mount.apply([CAMERA, TERRAIN, IMAGERY, MODEL]);

      expect(revision.disposed).toEqual(["city-tiles"]);
      expect(revision.created).toEqual([]);
      expect([...revision.reused].sort()).toEqual(["orthophoto", "site-terrain", "turbine"]);
      expect(droppedTileset?.destroy).toHaveBeenCalledTimes(1);
      expect(keptModel?.destroy).not.toHaveBeenCalled();
      expect(scene.added).toEqual([keptModel]);
      expect(mount.layers.has("city-tiles")).toBe(false);
      expect(scene.addedImagery).toHaveLength(1);
    });

    it("rebuilds a primitive whose configuration changed and disposes the superseded one", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [IMAGERY, TILESET]);
      const originalProvider = imageryProviders[0];
      const originalLayer = scene.addedImagery[0];

      const revision = await mount.apply([{ ...IMAGERY, opacity: 0.25 }, TILESET]);

      expect(revision.created).toEqual(["orthophoto"]);
      expect(revision.disposed).toEqual(["orthophoto"]);
      expect(revision.reused).toEqual(["city-tiles"]);
      expect(imageryProviders).toHaveLength(2);
      expect(originalProvider?.destroy).toHaveBeenCalledTimes(1);
      expect(originalLayer?.destroy).toHaveBeenCalledTimes(1);
      expect(scene.addedImagery).toHaveLength(1);
      expect(scene.addedImagery[0]?.alpha).toBe(0.25);
      // The unchanged tileset was neither rebuilt nor detached.
      expect(tilesetFromUrl).toHaveBeenCalledTimes(1);
      expect(tilesets[0]?.destroy).not.toHaveBeenCalled();
    });

    it("treats a key collision across kinds as two distinct bindings", async () => {
      const scene = createMockCesiumScene();
      const sharedId = "site";
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [
        { ...TERRAIN, id: sharedId },
        { ...TILESET, id: sharedId },
      ]);

      const revision = await mount.apply([
        { ...TERRAIN, id: sharedId },
        { ...TILESET, id: sharedId },
      ]);

      expect(revision.created).toEqual([]);
      expect(revision.reused).toEqual([sharedId, sharedId]);
      expect(terrainFromUrl).toHaveBeenCalledTimes(1);
      expect(tilesetFromUrl).toHaveBeenCalledTimes(1);
    });

    it("serializes concurrent applications instead of interleaving scene mutations", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [IMAGERY]);

      const [first, second] = await Promise.all([mount.apply([IMAGERY, TILESET]), mount.apply([IMAGERY])]);

      expect(first.created).toEqual(["city-tiles"]);
      expect(second.disposed).toEqual(["city-tiles"]);
      expect(mount.revision).toBe(3);
      expect(scene.added).toHaveLength(0);
      expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancellation", () => {
    it("attaches nothing when the mount is aborted before materialization", async () => {
      const camera = createMockCesiumCamera();
      const scene = createMockCesiumScene();
      const controller = new AbortController();
      controller.abort();

      await expect(
        mountScenePrimitivesToCesium({ camera, scene }, fullPlan(), { signal: controller.signal }),
      ).rejects.toThrow(/abort/i);

      expect(tilesetFromUrl).not.toHaveBeenCalled();
      expect(terrainFromUrl).not.toHaveBeenCalled();
      expect(scene.addPrimitive).not.toHaveBeenCalled();
      expect(scene.added).toHaveLength(0);
      expect(scene.addedImagery).toHaveLength(0);
      expect(camera.setView).not.toHaveBeenCalled();
    });

    it("never attaches an in-flight load that resolves after an abort, and releases it", async () => {
      const scene = createMockCesiumScene();
      const controller = new AbortController();
      tilesetGate = deferred<void>();

      const mounting = mountScenePrimitivesToCesium(
        { camera: createMockCesiumCamera(), scene },
        [TERRAIN, IMAGERY, TILESET],
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(tilesetFromUrl).toHaveBeenCalledTimes(1));
      controller.abort();
      tilesetGate.resolve();

      await expect(mounting).rejects.toThrow(/abort/i);

      // The tileset that resolved into an abandoned scene was destroyed without
      // ever reaching the primitive collection...
      expect(tilesets).toHaveLength(1);
      expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(scene.addPrimitive).not.toHaveBeenCalled();
      // ...and everything attached before the abort was rolled back.
      expect(scene.added).toHaveLength(0);
      expect(scene.addedImagery).toHaveLength(0);
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(scene.terrainProvider).toBeUndefined();
      expect(scene.verticalExaggeration).toBe(1);
      expect(terrainProviders[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("cancels an in-flight revision when the mount is disposed mid-load", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [IMAGERY]);
      modelGate = deferred<void>();

      const revision = mount.apply([IMAGERY, MODEL]);
      await vi.waitFor(() => expect(modelFromGltfAsync).toHaveBeenCalledTimes(1));
      mount.dispose();
      modelGate.resolve();

      await expect(revision).rejects.toMatchObject({ name: "AbortError", message: /disposed/i });
      expect(mount.state).toBe("disposed");
      expect(mount.layers.size).toBe(0);
      expect(models[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(scene.added).toHaveLength(0);
      expect(scene.addedImagery).toHaveLength(0);
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("keeps the mount usable when a single application's signal aborts", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [IMAGERY]);
      const controller = new AbortController();
      modelGate = deferred<void>();

      const revision = mount.apply([IMAGERY, MODEL], { signal: controller.signal });
      await vi.waitFor(() => expect(modelFromGltfAsync).toHaveBeenCalledTimes(1));
      controller.abort();
      modelGate.resolve();
      await expect(revision).rejects.toThrow(/abort/i);

      // The previously applied plan survived the cancelled revision.
      expect(mount.state).toBe("ready");
      expect([...mount.layers.keys()]).toEqual(["orthophoto"]);
      expect(scene.addedImagery).toHaveLength(1);
      expect(imageryProviders[0]?.destroy).not.toHaveBeenCalled();
      expect(models[0]?.destroy).toHaveBeenCalledTimes(1);

      // ...and the mount still accepts a later revision.
      const applied = await mount.apply([IMAGERY, TILESET]);
      expect(applied.created).toEqual(["city-tiles"]);
      mount.dispose();
      expect(mount.state).toBe("disposed");
    });
  });

  describe("failure and rollback", () => {
    it("leaves the scene untouched when the initial application fails", async () => {
      const scene = createMockCesiumScene();
      singleTileImageryFromUrl.mockRejectedValueOnce(new Error("single tile unavailable"));

      await expect(
        mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [
          TERRAIN,
          IMAGERY,
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
      expect(scene.terrainProvider).toBeUndefined();
      expect(scene.verticalExaggeration).toBe(1);
      expect(imageryProviders[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(terrainProviders[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("rolls a failed revision back to the previously applied plan and stays disposable", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [
        TERRAIN,
        IMAGERY,
        TILESET,
      ]);
      const mountedTerrain = terrainProviders[0];
      singleTileImageryFromUrl.mockRejectedValueOnce(new Error("single tile unavailable"));

      await expect(
        mount.apply([
          TERRAIN,
          IMAGERY,
          TILESET,
          {
            kind: "imagery-layer",
            id: "failing",
            sourceId: "failing",
            protocol: "single-tile",
            url: "https://images.example.test/unavailable.png",
          },
        ]),
      ).rejects.toThrow("single tile unavailable");

      expect(mount.state).toBe("ready");
      expect(mount.revision).toBe(1);
      expect([...mount.layers.keys()].sort()).toEqual(["city-tiles", "orthophoto", "site-terrain"]);
      expect(scene.added).toHaveLength(1);
      expect(scene.addedImagery).toHaveLength(1);
      expect(scene.terrainProvider).toBe(mountedTerrain);
      expect(mountedTerrain?.destroy).not.toHaveBeenCalled();
      expect(tilesets[0]?.destroy).not.toHaveBeenCalled();

      mount.dispose();
      expect(mount.state).toBe("disposed");
      expect(scene.added).toHaveLength(0);
      expect(scene.addedImagery).toHaveLength(0);
      expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(mountedTerrain?.destroy).toHaveBeenCalledTimes(1);
      mount.dispose();
      expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("reports and retries a displaced handle that refused to release", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [TERRAIN, IMAGERY]);
      const terrain = terrainProviders[0];
      failNextTerrainDestroy = true;

      const revision = await mount.apply([IMAGERY]);

      expect(revision.status).toBe("degraded");
      expect(revision.disposed).toEqual([]);
      expect(revision.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "scene-mount-disposal-incomplete",
          status: "degraded",
          context: expect.objectContaining({ retainedHandleCount: 1 }),
        }),
      );
      expect(terrain?.destroy).toHaveBeenCalledTimes(1);

      // The retained handle is still the mount's problem, and dispose() retries it.
      mount.dispose();
      expect(terrain?.destroy).toHaveBeenCalledTimes(2);
      expect(mount.state).toBe("disposed");
      expect(scene.addedImagery).toHaveLength(0);
    });

    it("aggregates disposal failures and stays retryable", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [TERRAIN, TILESET]);
      const terrain = terrainProviders[0];
      failNextTerrainDestroy = true;

      expect(() => mount.dispose()).toThrow(AggregateError);
      expect(mount.state).toBe("disposing");
      expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);

      mount.dispose();
      expect(mount.state).toBe("disposed");
      expect(terrain?.destroy).toHaveBeenCalledTimes(2);
      expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(scene.terrainProvider).toBeUndefined();
    });
  });

  describe("resource ceiling", () => {
    it("refuses an over-budget plan before the peer is loaded", async () => {
      const scene = createMockCesiumScene();
      const plan: SceneRuntimePrimitive[] = Array.from({ length: 4 }, (_unused, index) => ({
        ...TILESET,
        id: `tileset-${index}`,
      }));

      await expect(
        mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, plan, { maxLayers: 3 }),
      ).rejects.toThrow(HonuaCesiumSceneMountError);
      expect(tilesetFromUrl).not.toHaveBeenCalled();
      expect(scene.added).toHaveLength(0);
    });

    it("keeps the mounted plan when a revision would exceed the ceiling", async () => {
      const scene = createMockCesiumScene();
      const mount = await mountScenePrimitivesToCesium({ camera: createMockCesiumCamera(), scene }, [TILESET], {
        maxLayers: 1,
      });

      await expect(mount.apply([TILESET, MODEL])).rejects.toThrow(/exceeding the mount ceiling 1/);
      expect(mount.revision).toBe(1);
      expect([...mount.layers.keys()]).toEqual(["city-tiles"]);
      expect(scene.added).toHaveLength(1);
      expect(modelFromGltfAsync).not.toHaveBeenCalled();
    });

    it("rejects a non-positive ceiling", async () => {
      await expect(
        mountScenePrimitivesToCesium({ camera: createMockCesiumCamera() }, [], { maxLayers: 0 }),
      ).rejects.toThrow(/positive integer/);
      await expect(
        mountScenePrimitivesToCesium({ camera: createMockCesiumCamera() }, [], { maxLayers: 2.5 }),
      ).rejects.toThrow(HonuaCesiumSceneMountError);
    });
  });

  it("leaves the one-shot apply entry point source compatible", async () => {
    const camera = createMockCesiumCamera();
    const scene = createMockCesiumScene();

    const result = await applyCesiumScenePrimitives({ camera, scene }, [CAMERA, TERRAIN, IMAGERY, TILESET]);

    expect(result.status).toBe("supported");
    expect([...result.layers.keys()].sort()).toEqual(["city-tiles", "orthophoto", "site-terrain"]);
    expect(result.diagnostics.every((diagnostic) => !diagnostic.code.startsWith("scene-mount-"))).toBe(true);
    result.layers.get("city-tiles")?.remove();
    expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it("mounts a camera-only target without materializing layers", async () => {
    const camera = createMockCesiumCamera();
    const mount = await mountScenePrimitivesToCesium({ camera }, fullPlan());

    expect(mount.layers.size).toBe(0);
    expect(camera.setView).toHaveBeenCalledTimes(1);
    expect(tilesetFromUrl).not.toHaveBeenCalled();
    mount.dispose();
    expect(mount.state).toBe("disposed");
  });
});
