import { beforeEach, describe, expect, it, vi } from "vitest";

// Single-owner reconciliation of the two Cesium mounts (#1050 / epic #395
// REQ-003), proven against a fake-Cesium seam: the primitive half runs on a
// stubbed peer whose objects record their own destruction, and the entity half
// runs on an injected runtime module, so "one dispose released both, in this
// order, exactly once" is an assertion rather than a claim. The same
// composition is proven against a real `Viewer` in
// `test/playwright/cesium-scene-adapter-fixtures.spec.mjs`.

/** Every renderer mutation either mount makes, in the order it happened. */
const teardownLog: string[] = [];

const tilesets: { url: string; destroy: ReturnType<typeof vi.fn>; isDestroyed(): boolean; show: boolean }[] = [];

const tilesetFromUrl = vi.fn(async (url: string) => {
  let destroyed = false;
  const tileset = {
    url,
    show: true,
    destroy: vi.fn(() => {
      destroyed = true;
      teardownLog.push("tileset:destroy");
    }),
    isDestroyed: () => destroyed,
  };
  tilesets.push(tileset);
  return tileset;
});

vi.mock("cesium", () => ({
  Cartesian3: {
    fromDegrees: (longitude: number, latitude: number, height?: number) => ({ longitude, latitude, height }),
  },
  HeadingPitchRoll: class {},
  Transforms: { headingPitchRollToFixedFrame: () => ({}) },
  Matrix4: { multiplyByUniformScale: (matrix: unknown) => matrix, clone: (matrix: unknown) => matrix },
  Cesium3DTileset: { fromUrl: (url: string) => tilesetFromUrl(url) },
  Cesium3DTileStyle: class {},
  Color: { WHITE: { withAlpha: (alpha: number) => ({ kind: "color", alpha }) } },
  UrlTemplateImageryProvider: class {
    constructor(readonly options: Record<string, unknown>) {}
    destroy() {
      /* providers are destroyed through their layer */
    }
    isDestroyed() {
      return false;
    }
  },
}));

import type { Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { explainQuery } from "../src/query-planner/index.js";
import type { QueryExecutionPlanV1 } from "../src/query-planner/types.js";
import {
  type CesiumEntityCollectionTarget,
  type CesiumEntityRuntimeModule,
  type CesiumSceneOwnerTarget,
  DEFAULT_CESIUM_SCENE_SOURCE_LIMIT,
  HonuaCesiumSceneOwnerError,
  type SceneImageryLayerPrimitive,
  type SceneModelLayerPrimitive,
  type SceneRuntimePrimitive,
  mountCesiumScene,
} from "../src/scene-workspace/index.js";

const IMAGERY: SceneImageryLayerPrimitive = {
  kind: "imagery-layer",
  id: "orthophoto",
  sourceId: "orthophoto",
  protocol: "url-template",
  url: "https://tiles.example.test/{z}/{x}/{y}.png",
};
const TILESET: SceneModelLayerPrimitive = {
  kind: "model-layer",
  id: "city-tiles",
  uri: "https://assets.example.test/tileset.json",
  format: "3d-tiles",
};
const PLAN: readonly SceneRuntimePrimitive[] = Object.freeze([IMAGERY, TILESET]);

const descriptor: SourceDescriptor = {
  id: "Response Units",
  protocol: "geoservices-feature-service",
  locator: { url: "https://demo.honua.io/FeatureServer", serviceId: "units", layerId: 0 },
  capabilities: capabilities(["query"]),
  schema: { primaryKey: "unit_id" },
};
const otherDescriptor: SourceDescriptor = { ...descriptor, id: "Hydrants" };
const context = { sourceVersion: "snapshot-7", schemaVersion: "schema-3", authorizationScope: ["units:read"] } as const;
const queryPlan = explainQuery({
  descriptor,
  query: { pagination: { limit: 100 }, returnGeometry: true, outSr: 4326 },
  ...context,
});
const otherPlan = explainQuery({
  descriptor: otherDescriptor,
  query: { pagination: { limit: 100 }, returnGeometry: true, outSr: 4326 },
  ...context,
});

const features: Result<Record<string, unknown>> = {
  exceededTransferLimit: false,
  features: [
    { attributes: { unit_id: "medic" }, geometry: { x: -157.85, y: 21.3 } },
    { attributes: { unit_id: "engine" }, geometry: { x: -157.84, y: 21.31 } },
  ],
};
const noFeatures: Result<Record<string, unknown>> = { exceededTransferLimit: false, features: [] };

const cesiumModule: CesiumEntityRuntimeModule = {
  Cartesian3: { fromDegrees: (longitude, latitude, height) => ({ longitude, latitude, height }) },
  JulianDate: { fromIso8601: (value) => ({ iso: value }) },
  TimeInterval: class {},
  TimeIntervalCollection: class {},
  PolygonHierarchy: class {},
};

beforeEach(() => {
  teardownLog.length = 0;
  tilesets.length = 0;
  vi.clearAllMocks();
});

describe("mountCesiumScene", () => {
  it("owns a primitive plan and an entity mount behind one handle", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);

    expect(owner.renderer).toBe("cesium");
    expect(owner.state).toBe("ready");
    expect(owner.sourceLimit).toBe(DEFAULT_CESIUM_SCENE_SOURCE_LIMIT);
    expect(owner.primitives.state).toBe("ready");
    expect([...owner.primitives.layers.keys()]).toEqual(["orthophoto", "city-tiles"]);
    expect(owner.sources.size).toBe(0);

    const mounted = await owner.mountSource(fakeSource([features]), queryPlan, {
      ...context,
      cesium: cesiumModule,
    });

    expect(owner.sources.get("honua-response-units")).toBe(mounted);
    expect(mounted.entityIds).toEqual(["honua-response-units:s:medic", "honua-response-units:s:engine"]);
    expect(target.scene.addedImagery).toHaveLength(1);
    expect(tilesets).toHaveLength(1);
    owner.dispose();
  });

  it("releases entity mounts before the primitive plan, and only once", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);
    const mounted = await owner.mountSource(fakeSource([features]), queryPlan, { ...context, cesium: cesiumModule });

    owner.dispose();
    owner.dispose();

    expect(owner.state).toBe("disposed");
    expect(mounted.state).toBe("disposed");
    expect(owner.primitives.state).toBe("disposed");
    expect(owner.sources.size).toBe(0);
    expect(target.entities.entities.size).toBe(0);
    expect(target.scene.addedImagery).toHaveLength(0);
    expect(tilesets[0]?.isDestroyed()).toBe(true);
    // The entity collection is emptied while the scene beneath it is still
    // attached — the ordering the browser lane measures.
    expect(teardownLog).toEqual([
      "entity:remove:honua-response-units:s:medic",
      "entity:remove:honua-response-units:s:engine",
      "tileset:destroy",
      "imagery:remove",
    ]);
    expect(tilesets[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it("refuses new work once disposed", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);
    owner.dispose();

    await expect(
      owner.mountSource(fakeSource([features]), queryPlan, { ...context, cesium: cesiumModule }),
    ).rejects.toMatchObject({ name: "HonuaCesiumSceneOwnerError", code: "disposed" });
    await expect(owner.applyPrimitives(PLAN)).rejects.toMatchObject({ code: "disposed" });
    expect(owner.releaseSource("honua-response-units")).toBe(false);
  });

  it("refuses a source mount when the target carries no entity collection", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene({ camera: target.camera, scene: target.scene }, PLAN);

    await expect(
      owner.mountSource(fakeSource([features]), queryPlan, { ...context, cesium: cesiumModule }),
    ).rejects.toMatchObject({ code: "entities-unavailable" });
    expect(owner.state).toBe("ready");
    owner.dispose();
  });

  it("fails closed on the source ceiling without disturbing the live scene", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN, { maxSources: 1 });
    const first = await owner.mountSource(fakeSource([features]), queryPlan, { ...context, cesium: cesiumModule });

    await expect(
      owner.mountSource(fakeSource([noFeatures]), otherPlan, { ...context, cesium: cesiumModule }),
    ).rejects.toMatchObject({ code: "source-limit-exceeded", detail: { sourceCount: 1, sourceLimit: 1 } });

    expect(owner.sources.size).toBe(1);
    expect(first.state).toBe("ready");
    expect(target.entities.entities.size).toBe(2);
    expect(target.scene.addedImagery).toHaveLength(1);
    owner.dispose();
  });

  it("refuses a duplicate source and releases the redundant mount", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);
    // An empty projection is the only way two mounts of one source can both
    // materialize: with features, the second collides on entity ids first.
    await owner.mountSource(fakeSource([noFeatures]), queryPlan, { ...context, cesium: cesiumModule });

    await expect(
      owner.mountSource(fakeSource([noFeatures]), queryPlan, { ...context, cesium: cesiumModule }),
    ).rejects.toMatchObject({ code: "source-conflict", detail: { sourceId: "honua-response-units" } });

    expect(owner.sources.size).toBe(1);
    expect(target.entities.entities.size).toBe(0);
    owner.dispose();
  });

  it("aborts a source mount that disposal overtakes and attaches nothing", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);
    const gate = deferred<Result<Record<string, unknown>>>();
    const source = fakeSource([features]);
    source.query.mockImplementationOnce(() => gate.promise);

    const mounting = owner.mountSource(source, queryPlan, { ...context, cesium: cesiumModule });
    await vi.waitFor(() => expect(source.query).toHaveBeenCalledOnce());
    owner.dispose();
    gate.resolve(features);

    await expect(mounting).rejects.toMatchObject({ name: "AbortError" });
    expect(target.entities.entities.size).toBe(0);
    expect(owner.sources.size).toBe(0);
    expect(owner.state).toBe("disposed");
  });

  it("releases one source without touching the rest of the scene", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);
    const mounted = await owner.mountSource(fakeSource([features]), queryPlan, { ...context, cesium: cesiumModule });

    expect(owner.releaseSource("honua-response-units")).toBe(true);

    expect(mounted.state).toBe("disposed");
    expect(owner.sources.size).toBe(0);
    expect(owner.state).toBe("ready");
    expect(owner.primitives.state).toBe("ready");
    expect(target.scene.addedImagery).toHaveLength(1);
    expect(tilesets[0]?.isDestroyed()).toBe(false);
    owner.dispose();
  });

  it("stays retryable when an entity mount refuses to release", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);
    await owner.mountSource(fakeSource([features]), queryPlan, { ...context, cesium: cesiumModule });
    target.entities.failRemoveId = "honua-response-units:s:engine";

    expect(() => owner.dispose()).toThrowError(AggregateError);
    expect(owner.state).toBe("disposing");
    // The refusing mount stays owned; everything that *could* be released was,
    // so a refusing entity does not pin the scene's GPU resources indefinitely.
    expect(owner.sources.size).toBe(1);
    expect(owner.primitives.state).toBe("disposed");
    expect(target.scene.addedImagery).toHaveLength(0);
    expect(target.entities.entities.has("honua-response-units:s:engine")).toBe(true);

    target.entities.failRemoveId = undefined;
    owner.dispose();
    expect(owner.state).toBe("disposed");
    expect(owner.sources.size).toBe(0);
    expect(target.entities.entities.size).toBe(0);
  });

  it("delegates a primitive revision to the mount's own diff", async () => {
    const target = createTarget();
    const owner = await mountCesiumScene(target, PLAN);
    const imageryHandle = owner.primitives.layers.get("orthophoto");

    const applied = await owner.applyPrimitives([IMAGERY]);

    expect(applied.reused).toEqual(["orthophoto"]);
    expect(applied.disposed).toEqual(["city-tiles"]);
    expect(owner.primitives.layers.get("orthophoto")).toBe(imageryHandle);
    expect(tilesets[0]?.isDestroyed()).toBe(true);
    owner.dispose();
  });

  it("rejects a non-positive source ceiling before mounting anything", async () => {
    const target = createTarget();
    await expect(mountCesiumScene(target, PLAN, { maxSources: 0 })).rejects.toThrowError(HonuaCesiumSceneOwnerError);
    expect(target.scene.addedImagery).toHaveLength(0);
  });
});

type MockScene = ReturnType<typeof createMockScene>;

function createTarget(): CesiumSceneOwnerTarget & {
  scene: MockScene;
  entities: ReturnType<typeof fakeCollection>;
  camera: { positionCartographic: unknown; heading: number; pitch: number; roll: number; setView(): void };
} {
  const scene = createMockScene();
  const entities = fakeCollection();
  const camera = {
    positionCartographic: { longitude: 0, latitude: 0, height: 0 },
    heading: 0,
    pitch: 0,
    roll: 0,
    setView() {
      /* the owner never drives the camera itself */
    },
  };
  return { camera, scene, entities } as unknown as CesiumSceneOwnerTarget & {
    scene: MockScene;
    entities: ReturnType<typeof fakeCollection>;
    camera: typeof camera;
  };
}

function createMockScene() {
  const added: unknown[] = [];
  const addedImagery: { imageryProvider: unknown; show: boolean; alpha: number }[] = [];
  return {
    added,
    addedImagery,
    verticalExaggeration: 1,
    terrainProvider: undefined as unknown,
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
      addImageryProvider(imageryProvider: unknown) {
        const layer = { imageryProvider, show: true, alpha: 1 };
        addedImagery.push(layer);
        return layer;
      },
      remove(layer: unknown) {
        const index = addedImagery.indexOf(layer as (typeof addedImagery)[number]);
        if (index === -1) return false;
        addedImagery.splice(index, 1);
        teardownLog.push("imagery:remove");
        return true;
      },
      contains(layer: unknown) {
        return addedImagery.includes(layer as (typeof addedImagery)[number]);
      },
    },
  };
}

function fakeCollection(): CesiumEntityCollectionTarget & {
  entities: Map<string, Record<string, unknown>>;
  failRemoveId?: string;
} {
  const entities = new Map<string, Record<string, unknown>>();
  const collection = {
    entities,
    failRemoveId: undefined as string | undefined,
    getById: (id: string) => entities.get(id),
    add: (entity: Readonly<Record<string, unknown>>) => {
      const id = String(entity.id);
      if (entities.has(id)) throw new Error(`duplicate ${id}`);
      const live: Record<string, unknown> = { ...entity };
      entities.set(id, live);
      return live;
    },
    removeById: (id: string) => {
      if (collection.failRemoveId === id) throw new Error(`cannot remove ${id}`);
      const removed = entities.delete(id);
      if (removed) teardownLog.push(`entity:remove:${id}`);
      return removed;
    },
  };
  return collection;
}

function fakeSource(
  results: readonly Result<Record<string, unknown>>[],
  sourceDescriptor: SourceDescriptor = descriptor,
): Source<Record<string, unknown>> & { query: ReturnType<typeof vi.fn> } {
  let index = 0;
  const query = vi.fn(
    async (_request?: Query<Record<string, unknown>>) => results[Math.min(index++, results.length - 1)],
  );
  return {
    descriptor: sourceDescriptor,
    capabilities: sourceDescriptor.capabilities,
    query,
    queryAll: query,
    queryAggregate: vi.fn(),
  } as unknown as Source<Record<string, unknown>> & { query: ReturnType<typeof vi.fn> };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

// Silences an unused-plan lint on the alternate descriptor when the ceiling case
// is the only consumer; keeping the binding named makes the intent readable.
void (otherPlan satisfies QueryExecutionPlanV1);
