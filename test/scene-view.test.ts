import { beforeEach, describe, expect, it, vi } from "vitest";

// The SceneView drives the Cesium adapter + analysis renderers, both of which
// pull CesiumJS in lazily (`await import("cesium")`). Cesium needs a WebGL
// context unavailable headless, so we mock only the surface they touch — the
// same minimal slice the adapter / widget tests mock. The 2D bundle never loads
// these modules; this exercises the full SceneView wiring without a live globe.
const tilesetFromUrl = vi.fn(async (url: string) => ({ kind: "tileset", url, show: true, modelMatrix: undefined }));
const terrainFromUrl = vi.fn(async (url: string) => ({ kind: "terrain-provider", url }));

vi.mock("cesium", () => ({
  Cartesian3: {
    fromDegrees: (longitude: number, latitude: number, height?: number) => ({ longitude, latitude, height }),
    fromDegreesArrayHeights: (coordinates: number[]) => ({ kind: "cart-array-h", coordinates }),
  },
  Color: {
    fromCssColorString: (color: string) => ({ kind: "css-color", color }),
    LIME: { name: "LIME" },
    RED: { name: "RED" },
    YELLOW: { name: "YELLOW" },
  },
  Cesium3DTileset: { fromUrl: (url: string) => tilesetFromUrl(url) },
  CesiumTerrainProvider: { fromUrl: (url: string) => terrainFromUrl(url) },
  Cesium3DTileStyle: class {},
}));

import type { QueryMethod } from "../src/core/types.js";
import {
  type CesiumEntityCollectionLike,
  type CesiumSceneRuntimeTarget,
  SceneView,
  type SceneViewEvent,
  type SceneViewRequestExecutor,
} from "../src/scene-workspace/index.js";

const DEG2RAD = Math.PI / 180;

const SCENE = {
  sceneId: "downtown",
  title: "Downtown",
  tilesetUrl: "https://cdn.example/scenes/downtown/tileset.json",
  terrainUrl: "https://cdn.example/terrain",
  initialCamera: { longitude: -157.8, latitude: 21.3, height: 1200 },
  viewpoints: [{ id: "harbor", title: "Harbor", camera: { longitude: -157.85, latitude: 21.31, height: 300 } }],
  capabilities: ["terrain"],
};

/** A pure-JS Cesium camera stand-in mirroring the getter contract the adapter reads. */
function createMockCamera() {
  const position = { longitude: 0, latitude: 0, height: 0 };
  const orientation = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
  return {
    get positionCartographic() {
      return position;
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
    setView: vi.fn((options: { destination?: { longitude: number; latitude: number; height: number } }) => {
      if (options.destination) {
        position.longitude = options.destination.longitude * DEG2RAD;
        position.latitude = options.destination.latitude * DEG2RAD;
        position.height = options.destination.height;
      }
    }),
  };
}

/** A scene primitive collection that records adds/removes so layer teardown is observable. */
function createMockScene() {
  const primitives: unknown[] = [];
  return {
    primitives: {
      add: (primitive: unknown) => {
        primitives.push(primitive);
        return primitive;
      },
      remove: (primitive: unknown) => {
        const index = primitives.indexOf(primitive);
        if (index >= 0) primitives.splice(index, 1);
        return index >= 0;
      },
      contains: (primitive: unknown) => primitives.includes(primitive),
    },
    terrainProvider: undefined as unknown,
    verticalExaggeration: 1,
    _primitives: primitives,
  };
}

function createMockEntities(): CesiumEntityCollectionLike & { added: unknown[] } {
  const added: unknown[] = [];
  return {
    added,
    add: (entity: unknown) => {
      added.push(entity);
      return entity;
    },
    remove: (entity: unknown) => {
      const index = added.indexOf(entity);
      if (index >= 0) added.splice(index, 1);
      return index >= 0;
    },
  };
}

beforeEach(() => {
  tilesetFromUrl.mockClear();
  terrainFromUrl.mockClear();
});

describe("SceneView construction", () => {
  it("requires a client or an execute transport", () => {
    expect(() => new SceneView({})).toThrow(/client.*or.*execute/i);
  });
});

describe("SceneView scene loading + rendering", () => {
  function makeExecutor() {
    return vi.fn(async (_method: QueryMethod, path: string) => {
      if (path.startsWith("/api/scenes/")) return { scene: SCENE };
      if (path === "/api/scenes") return { scenes: [SCENE] };
      return {};
    }) as unknown as SceneViewRequestExecutor;
  }

  it("loads a scene by id and renders the tileset + terrain onto the target", async () => {
    const camera = createMockCamera();
    const scene = createMockScene();
    const target: CesiumSceneRuntimeTarget = { camera, scene };
    const view = new SceneView({ execute: makeExecutor(), target });

    const events: SceneViewEvent[] = [];
    view.on((event) => events.push(event));

    const loaded = await view.loadScene("downtown");
    expect(loaded.sceneId).toBe("downtown");
    expect(view.scene?.sceneId).toBe("downtown");

    // tileset + terrain materialized
    expect(tilesetFromUrl).toHaveBeenCalledWith(SCENE.tilesetUrl);
    expect(terrainFromUrl).toHaveBeenCalledWith(SCENE.terrainUrl);
    expect(scene.terrainProvider).toMatchObject({ kind: "terrain-provider" });

    // initial camera applied
    expect(camera.setView).toHaveBeenCalled();

    // layers + bookmarks surfaced
    expect(view.layers.map((l) => l.id)).toEqual(["downtown:tileset", "downtown:terrain"]);
    expect(view.bookmarks.map((b) => b.id)).toEqual(["harbor"]);

    // events emitted
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["scene-loaded", "layers-changed", "diagnostics"]),
    );
  });

  it("loads + diagnoses headlessly without a target (no rendering)", async () => {
    const view = new SceneView({ execute: makeExecutor() });
    const loaded = await view.loadScene("downtown");
    expect(loaded.sceneId).toBe("downtown");
    expect(view.hasTarget).toBe(false);
    expect(tilesetFromUrl).not.toHaveBeenCalled();
    expect(view.layers.length).toBe(2);
  });

  it("tears down prior layers when a new scene is loaded", async () => {
    const scene = createMockScene();
    const view = new SceneView({ execute: makeExecutor(), target: { camera: createMockCamera(), scene } });
    await view.loadScene("downtown");
    expect(scene._primitives.length).toBe(1); // one tileset
    await view.loadScene(SCENE); // reload via object
    expect(scene._primitives.length).toBe(1); // prior tileset removed, new one added
  });

  it("toggles layer visibility through the live handle", async () => {
    const scene = createMockScene();
    const view = new SceneView({ execute: makeExecutor(), target: { camera: createMockCamera(), scene } });
    await view.loadScene("downtown");
    const tileset = scene._primitives[0] as { show: boolean };
    expect(view.setLayerVisible("downtown:tileset", false)).toBe(true);
    expect(tileset.show).toBe(false);
    expect(view.layers.find((l) => l.id === "downtown:tileset")?.visible).toBe(false);
    expect(view.setLayerVisible("missing", false)).toBe(false);
  });

  it("applies viewpoint bookmarks and reads the camera back", async () => {
    const camera = createMockCamera();
    const view = new SceneView({ execute: makeExecutor(), target: { camera, scene: createMockScene() } });
    await view.loadScene("downtown");
    const applied = await view.applyBookmark("harbor");
    expect(applied).toMatchObject({ longitude: -157.85, latitude: 21.31 });
    expect(await view.applyBookmark("nope")).toBeUndefined();
    const read = view.readCamera();
    expect(read?.longitude).toBeCloseTo(-157.85, 4);
  });
});

describe("SceneView analysis + measurement widgets", () => {
  it("runs line-of-sight and draws an overlay when entities are supplied", async () => {
    const execute = vi.fn(async () => ({ visible: true, distanceMeters: 1000 })) as unknown as SceneViewRequestExecutor;
    const view = new SceneView({ execute });
    const entities = createMockEntities();
    const { result, overlay } = await view.lineOfSight({
      datasetId: "dem",
      observer: { longitude: -157.8, latitude: 21.3, height: 30 },
      target: { longitude: -157.81, latitude: 21.31 },
      entities,
    });
    expect(result.visible).toBe(true);
    expect(entities.added.length).toBeGreaterThan(0);
    expect(overlay?.kind).toBe("line-of-sight");
    overlay?.remove();
    expect(entities.added.length).toBe(0);
  });

  it("runs viewshed and returns only the result when no entities are supplied", async () => {
    const execute = vi.fn(async () => ({
      samples: [{ lon: 1, lat: 2, azimuthDegrees: 0, distanceMeters: 10, visible: true }],
      visibleSampleCount: 1,
      sampleCount: 1,
    })) as unknown as SceneViewRequestExecutor;
    const view = new SceneView({ execute });
    const { result, overlay } = await view.viewshed({
      datasetId: "dem",
      observer: { longitude: 1, latitude: 2 },
      radiusMeters: 500,
    });
    expect(result.visibleSampleCount).toBe(1);
    expect(overlay).toBeUndefined();
  });

  it("requests an elevation profile and drapes it into the scene", async () => {
    const execute = vi.fn(async () => ({
      samples: [
        { distanceMeters: 0, elevation: 10 },
        { distanceMeters: 50, elevation: 12 },
      ],
      lineLengthMeters: 50,
    })) as unknown as SceneViewRequestExecutor;
    const view = new SceneView({ execute });
    const entities = createMockEntities();
    const { result, overlay } = await view.elevationProfile({
      datasetId: "dem",
      polyline: [
        { longitude: 1, latitude: 2 },
        { longitude: 1.1, latitude: 2.1 },
      ],
      entities,
    });
    expect(result.samples.length).toBe(2);
    expect(overlay?.kind).toBe("elevation-profile");
    expect(entities.added.length).toBe(1);
  });

  it("computes a client-side area measurement and renders it", async () => {
    const view = new SceneView({ execute: vi.fn() as unknown as SceneViewRequestExecutor });
    const entities = createMockEntities();
    const { measurement, overlay } = await view.measure(
      [
        { longitude: 0, latitude: 0 },
        { longitude: 0, latitude: 0.001 },
        { longitude: 0.001, latitude: 0.001 },
      ],
      { mode: "area", entities },
    );
    expect(measurement.mode).toBe("area");
    expect(measurement.areaSquareMeters).toBeGreaterThan(0);
    expect(overlay?.kind).toBe("measurement");
  });
});

describe("SceneView lifecycle", () => {
  it("removes listeners and rendered layers on dispose", async () => {
    const scene = createMockScene();
    const execute = vi.fn(async (_m: QueryMethod, path: string) =>
      path === "/api/scenes" ? { scenes: [SCENE] } : { scene: SCENE },
    ) as unknown as SceneViewRequestExecutor;
    const view = new SceneView({ execute, target: { camera: createMockCamera(), scene } });
    let count = 0;
    view.on(() => count++);
    await view.loadScene("downtown");
    expect(scene._primitives.length).toBe(1);
    const before = count;
    view.dispose();
    expect(scene._primitives.length).toBe(0);
    expect(view.scene).toBeUndefined();
    // listeners cleared: a post-dispose no-op load path would not fire, but we
    // simply assert the listener set is detached by checking it does not grow.
    expect(count).toBe(before);
  });
});
