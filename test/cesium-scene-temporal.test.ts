import { beforeEach, describe, expect, it, vi } from "vitest";

// Application time and rebuild boundaries on the Cesium scene adapter (#1048),
// proven against the same honest fake-Cesium seam the mount lifecycle uses: the
// clock is a plain object, `JulianDate.fromIso8601` is a tagging stub, and every
// materialization is observable, so "the clock moved and nothing was rebuilt" is
// an assertion rather than a claim. Real-Cesium evidence for the same contract
// lives in `test/playwright/cesium-scene-adapter-fixtures.spec.mjs`.

interface DestroyableStub {
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
}

function destroyable(): DestroyableStub {
  let destroyed = false;
  return {
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
  };
}

const tilesets: Array<{ url: string } & DestroyableStub> = [];
const models: Array<{ url: unknown } & DestroyableStub> = [];
let failNextModel = false;

const tilesetFromUrl = vi.fn(async (url: string) => {
  const tileset = { url, show: true, modelMatrix: undefined as unknown, ...destroyable() };
  tilesets.push(tileset);
  return tileset;
});

const modelFromGltfAsync = vi.fn(async (options: Record<string, unknown>) => {
  if (failNextModel) {
    failNextModel = false;
    throw new Error("model materialization failed");
  }
  const model = { url: options.url, show: true, color: undefined as unknown, ...destroyable() };
  models.push(model);
  return model;
});

class MockImageryProvider {
  readonly destroy = vi.fn();
  constructor(readonly options: Record<string, unknown>) {}
  isDestroyed(): boolean {
    return false;
  }
}

/** A tagged stand-in for `JulianDate`: the ISO string travels with the value. */
interface JulianStub {
  readonly iso: string;
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
  Transforms: { headingPitchRollToFixedFrame: (origin: unknown, hpr: unknown) => ({ origin, hpr }) },
  Matrix4: {
    multiplyByUniformScale: (matrix: unknown, scale: number) => ({ matrix, scale }),
    clone: (matrix: unknown) => matrix,
  },
  JulianDate: { fromIso8601: (iso: string): JulianStub => ({ iso }) },
  Cesium3DTileset: { fromUrl: (url: string) => tilesetFromUrl(url) },
  Cesium3DTileStyle: class {},
  Color: { WHITE: { withAlpha: (alpha: number) => ({ alpha }) } },
  Model: { fromGltfAsync: (options: Record<string, unknown>) => modelFromGltfAsync(options) },
  CesiumTerrainProvider: { fromUrl: async (url: string) => ({ url, ...destroyable() }) },
  UrlTemplateImageryProvider: MockImageryProvider,
  WebMapServiceImageryProvider: MockImageryProvider,
  WebMapTileServiceImageryProvider: MockImageryProvider,
  SingleTileImageryProvider: { fromUrl: async (url: string) => new MockImageryProvider({ url }) },
  ArcGisMapServerImageryProvider: { fromUrl: async (url: string) => new MockImageryProvider({ url }) },
}));

import { type TemporalPlayback, createTemporalPlayback } from "../src/map/temporal-playback.js";
import {
  type CesiumCameraLike,
  type CesiumClockLike,
  type CesiumSceneLike,
  type CesiumSceneRuntimeTarget,
  type CesiumTemporalPlayback,
  type SceneImageryLayerPrimitive,
  type SceneModelLayerPrimitive,
  type SceneRuntimePrimitive,
  type SceneTimelineState,
  type SceneWorkspaceState,
  applyCesiumScenePrimitives,
  applyCesiumSceneTime,
  bindTemporalPlaybackToCesium,
  emptySceneWorkspaceState,
  mountScenePrimitivesToCesium,
  sceneTimelineToCesiumClockPlan,
} from "../src/scene-workspace/index.js";

const T0 = "2026-03-01T00:00:00.000Z";
const T1 = "2026-03-01T06:00:00.000Z";
const EXTENT_START = "2026-02-28T00:00:00.000Z";
const EXTENT_END = "2026-03-02T00:00:00.000Z";

function createCamera(): CesiumCameraLike {
  return {
    positionCartographic: { longitude: 0, latitude: 0, height: 0 },
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
    setView: vi.fn(),
  };
}

function createClock(): CesiumClockLike {
  return { currentTime: undefined, startTime: undefined, stopTime: undefined, multiplier: 1, shouldAnimate: false };
}

type MockImageryLayer = { imageryProvider: unknown; show: boolean; alpha: number; destroy: ReturnType<typeof vi.fn> };

function createScene(): CesiumSceneLike & { added: unknown[]; addedImagery: MockImageryLayer[] } {
  const added: unknown[] = [];
  const addedImagery: MockImageryLayer[] = [];
  return {
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

function createTarget(options: { clock?: CesiumClockLike; clockOwnership?: "adapter" | "host" } = {}): {
  target: CesiumSceneRuntimeTarget;
  scene: ReturnType<typeof createScene>;
} {
  const scene = createScene();
  return {
    scene,
    target: {
      camera: createCamera(),
      scene,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.clockOwnership ? { clockOwnership: options.clockOwnership } : {}),
    },
  };
}

function stateWith(timeline: SceneTimelineState, realtime?: SceneWorkspaceState["realtime"]): SceneWorkspaceState {
  const base = emptySceneWorkspaceState();
  return { ...base, timeline, ...(realtime ? { realtime } : {}) };
}

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

function isoOf(value: unknown): string | undefined {
  return (value as JulianStub | undefined)?.iso;
}

beforeEach(() => {
  tilesets.length = 0;
  models.length = 0;
  failNextModel = false;
  vi.clearAllMocks();
});

describe("sceneTimelineToCesiumClockPlan", () => {
  it("returns undefined for a timeline that declares nothing", () => {
    expect(sceneTimelineToCesiumClockPlan(undefined)).toBeUndefined();
    expect(sceneTimelineToCesiumClockPlan({})).toBeUndefined();
    expect(sceneTimelineToCesiumClockPlan({ progress: 0.5 })).toBeUndefined();
  });

  it("maps every declared field onto its Cesium clock counterpart", () => {
    expect(
      sceneTimelineToCesiumClockPlan({
        currentTime: T0,
        startTime: EXTENT_START,
        endTime: EXTENT_END,
        playing: true,
        speed: 4,
      }),
    ).toEqual({
      currentTime: T0,
      startTime: EXTENT_START,
      stopTime: EXTENT_END,
      shouldAnimate: true,
      multiplier: 4,
      rejected: [],
    });
  });

  it("names uninterpretable fields instead of handing them to Cesium", () => {
    const plan = sceneTimelineToCesiumClockPlan({
      currentTime: "not-a-time",
      startTime: EXTENT_END,
      endTime: EXTENT_START,
      speed: Number.POSITIVE_INFINITY,
    });
    expect(plan?.currentTime).toBeUndefined();
    expect(plan?.startTime).toBeUndefined();
    expect(plan?.multiplier).toBeUndefined();
    expect(plan?.rejected).toEqual(["currentTime", "extent", "speed"]);
  });

  it("reports a runtime without JulianDate rather than throwing", () => {
    const clock = createClock();
    const outcome = applyCesiumSceneTime({ clock }, { currentTime: T0 }, {});
    expect(outcome.applied).toBe(false);
    expect(clock.currentTime).toBeUndefined();
    expect(outcome.diagnostics.map((entry) => entry.code)).toEqual(["scene-time-runtime-unavailable"]);
    expect(outcome.diagnostics[0]?.status).toBe("degraded");
  });
});

describe("cesium scene adapter — application time binding", () => {
  it("binds the workspace timeline to the clock the host opted into", async () => {
    const clock = createClock();
    const { target } = createTarget({ clock });

    const result = await applyCesiumScenePrimitives(
      target,
      [IMAGERY, TILESET],
      stateWith({ currentTime: T0, startTime: EXTENT_START, endTime: EXTENT_END, playing: true, speed: 2 }),
    );

    expect(isoOf(clock.currentTime)).toBe(T0);
    expect(isoOf(clock.startTime)).toBe(EXTENT_START);
    expect(isoOf(clock.stopTime)).toBe(EXTENT_END);
    expect(clock.shouldAnimate).toBe(true);
    expect(clock.multiplier).toBe(2);
    expect(result.status).toBe("supported");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "scene-time-applied",
        renderer: "cesium",
        status: "supported",
        context: expect.objectContaining({ currentTime: T0, ownership: "adapter", rebuildBoundary: "none" }),
      }),
    );
  });

  it("stands down without writing when the host declares it owns the clock", async () => {
    const clock = createClock();
    const { target } = createTarget({ clock, clockOwnership: "host" });

    const result = await applyCesiumScenePrimitives(target, [IMAGERY], stateWith({ currentTime: T0, playing: true }));

    expect(clock.currentTime).toBeUndefined();
    expect(clock.shouldAnimate).toBe(false);
    expect(result.status).toBe("supported");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "scene-time-host-owned",
        status: "supported",
        context: expect.objectContaining({ ownership: "host", currentTime: T0 }),
      }),
    );
  });

  it("reports a declared application time that has no clock to reach", async () => {
    const { target } = createTarget();

    const result = await applyCesiumScenePrimitives(target, [IMAGERY], stateWith({ currentTime: T0 }));

    expect(result.status).toBe("degraded");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "scene-time-clock-unbound", severity: "warning", status: "degraded" }),
    );
  });

  it("stays silent when the timeline slice declares no time at all", async () => {
    const clock = createClock();
    const { target } = createTarget({ clock });

    const result = await applyCesiumScenePrimitives(target, [IMAGERY], emptySceneWorkspaceState());

    expect(clock.currentTime).toBeUndefined();
    expect(result.diagnostics.filter((entry) => entry.code.startsWith("scene-time-"))).toEqual([]);
  });

  it("refuses an uninterpretable time and leaves the clock untouched", async () => {
    const clock = createClock();
    clock.currentTime = { iso: T0 } satisfies JulianStub;
    const { target } = createTarget({ clock });

    const result = await applyCesiumScenePrimitives(target, [IMAGERY], stateWith({ currentTime: "yesterday" }));

    expect(isoOf(clock.currentTime)).toBe(T0);
    expect(result.status).toBe("degraded");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "scene-time-invalid",
        context: expect.objectContaining({ rejected: ["currentTime"] }),
      }),
    );
  });

  it("rolls the clock back when the application fails", async () => {
    const clock = createClock();
    clock.currentTime = { iso: EXTENT_START } satisfies JulianStub;
    const { target } = createTarget({ clock });
    failNextModel = true;

    await expect(
      applyCesiumScenePrimitives(target, [IMAGERY, MODEL], stateWith({ currentTime: T0, playing: true })),
    ).rejects.toThrow(/model materialization failed/);

    expect(isoOf(clock.currentTime)).toBe(EXTENT_START);
    expect(clock.shouldAnimate).toBe(false);
  });
});

describe("cesium scene mount — rebuild boundaries", () => {
  it("advances application time without rebuilding a single primitive", async () => {
    const clock = createClock();
    const { target, scene } = createTarget({ clock });
    const plan: SceneRuntimePrimitive[] = [IMAGERY, TILESET];

    const mount = await mountScenePrimitivesToCesium(target, plan, { state: stateWith({ currentTime: T0 }) });
    const before = new Map(mount.layers);
    const tilesetInstance = scene.added[0];

    expect(mount.rebuildBoundaries).toEqual([]);
    expect(isoOf(clock.currentTime)).toBe(T0);

    const revision = await mount.apply(plan, { state: stateWith({ currentTime: T1 }) });

    expect(revision.revision).toBe(2);
    expect(revision.created).toEqual([]);
    expect(revision.disposed).toEqual([]);
    expect([...revision.reused].sort()).toEqual(["city-tiles", "orthophoto"]);
    // Handle identity, not just count: the live Cesium objects survived.
    for (const [id, handle] of before) expect(mount.layers.get(id)).toBe(handle);
    expect(scene.added[0]).toBe(tilesetInstance);
    expect(tilesetFromUrl).toHaveBeenCalledTimes(1);

    expect(isoOf(clock.currentTime)).toBe(T1);
    expect(revision.rebuildBoundaries.map((entry) => `${entry.id}:${entry.boundary}`).sort()).toEqual([
      "city-tiles:none",
      "orthophoto:none",
    ]);
    expect(revision.rebuildBoundaries.every((entry) => entry.incremental)).toBe(true);
    expect(revision.diagnostics.some((entry) => entry.code === "scene-mount-rebuild-boundary")).toBe(false);
    expect(mount.rebuildBoundaries).toEqual(revision.rebuildBoundaries);
    // A revision that rebuilt nothing still says what it did do.
    expect(revision.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "scene-mount-applied",
        context: expect.objectContaining({ revision: 2, timeApplied: true }),
      }),
    );

    mount.dispose();
  });

  it("rebuilds only the binding a realtime delta changed, and names the boundary", async () => {
    const clock = createClock();
    const { target } = createTarget({ clock });

    const mount = await mountScenePrimitivesToCesium(target, [IMAGERY, TILESET], {
      state: stateWith({ currentTime: T0 }),
    });
    const tilesetHandle = mount.layers.get("city-tiles");
    const imageryHandle = mount.layers.get("orthophoto");

    const delta = await mount.apply([{ ...IMAGERY, opacity: 0.25 }, TILESET], {
      state: stateWith({ currentTime: T1 }, { status: "live", cursor: "seq-42", staleSince: 1_700_000_000_000 }),
    });

    expect(delta.created).toEqual(["orthophoto"]);
    expect(delta.disposed).toEqual(["orthophoto"]);
    expect(delta.reused).toEqual(["city-tiles"]);
    expect(mount.layers.get("city-tiles")).toBe(tilesetHandle);
    expect(mount.layers.get("orthophoto")).not.toBe(imageryHandle);
    expect(tilesetFromUrl).toHaveBeenCalledTimes(1);

    expect(delta.rebuildBoundaries).toContainEqual(
      expect.objectContaining({ id: "orthophoto", boundary: "primitive-configuration", incremental: false }),
    );
    expect(delta.rebuildBoundaries).toContainEqual(
      expect.objectContaining({ id: "city-tiles", boundary: "none", incremental: true }),
    );
    expect(delta.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "scene-mount-rebuild-boundary",
        primitiveId: "orthophoto",
        primitiveKind: "imagery-layer",
        context: expect.objectContaining({ revision: 2, rebuildBoundary: "primitive-configuration" }),
      }),
    );
    // The delta's provenance travels with the application it caused.
    expect(delta.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "scene-mount-applied",
        context: expect.objectContaining({
          realtime: { status: "live", cursor: "seq-42", staleSince: 1_700_000_000_000 },
        }),
      }),
    );

    mount.dispose();
  });

  it("names plan-membership and identity crossings", async () => {
    const { target } = createTarget({ clock: createClock() });

    const mount = await mountScenePrimitivesToCesium(target, [IMAGERY, TILESET]);
    const revision = await mount.apply([IMAGERY, MODEL]);

    expect(revision.rebuildBoundaries).toContainEqual(
      expect.objectContaining({ id: "turbine", boundary: "primitive-identity", incremental: false }),
    );
    expect(revision.rebuildBoundaries).toContainEqual(
      expect.objectContaining({ id: "city-tiles", boundary: "plan-membership", incremental: false }),
    );
    expect(
      revision.diagnostics
        .filter((entry) => entry.code === "scene-mount-rebuild-boundary")
        .map((entry) => entry.context?.rebuildBoundary)
        .sort(),
    ).toEqual(["plan-membership", "primitive-identity"]);

    mount.dispose();
  });

  it("rebuilds an unfingerprintable primitive rather than assuming it is unchanged", async () => {
    const { target } = createTarget({ clock: createClock() });
    const unfingerprintable: SceneRuntimePrimitive = {
      ...IMAGERY,
      metadata: { onTile: () => undefined },
    } as SceneRuntimePrimitive;

    const mount = await mountScenePrimitivesToCesium(target, [unfingerprintable]);
    const revision = await mount.apply([unfingerprintable]);

    expect(revision.created).toEqual(["orthophoto"]);
    expect(revision.rebuildBoundaries).toEqual([
      expect.objectContaining({ id: "orthophoto", boundary: "unfingerprintable", incremental: false }),
    ]);

    mount.dispose();
  });
});

describe("bindTemporalPlaybackToCesium", () => {
  const runtime = { JulianDate: { fromIso8601: (iso: string): JulianStub => ({ iso }) } };

  /** The controller emits `tick` only after its sinks settle. */
  const flushTicks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function playbackOver(applied: number[]): TemporalPlayback {
    return createTemporalPlayback({
      extent: [EXTENT_START, EXTENT_END],
      windowMs: 6 * 60 * 60 * 1000,
      apply: (window) => {
        applied.push(window.start);
      },
    });
  }

  it("accepts the /map playback controller structurally, with no import between the two", () => {
    const playback = playbackOver([]);
    // The compile-time half of REQ-003: `scene-workspace` declares the slice it
    // needs and the `/map` controller satisfies it, so neither module imports
    // the other and neither entrypoint gains the other's closure.
    const structural: CesiumTemporalPlayback = playback;
    expect(structural.extent).toEqual({ start: Date.parse(EXTENT_START), end: Date.parse(EXTENT_END) });
    playback.dispose();
  });

  it("drives the clock from the same controller that drives a MapLibre map", async () => {
    const applied: number[] = [];
    const playback = playbackOver(applied);
    const clock = createClock();

    const binding = await bindTemporalPlaybackToCesium({ clock }, playback, { cesium: runtime });

    expect(binding.bound).toBe(true);
    expect(isoOf(clock.currentTime)).toBe(EXTENT_START);
    expect(isoOf(clock.startTime)).toBe(EXTENT_START);
    expect(isoOf(clock.stopTime)).toBe(EXTENT_END);
    // The controller is the transport, so Cesium's own animation stays off.
    expect(clock.shouldAnimate).toBe(false);

    playback.scrub(T0);
    await flushTicks();

    expect(isoOf(clock.currentTime)).toBe(T0);
    expect(binding.applications).toBeGreaterThan(1);
    expect(applied.length).toBeGreaterThan(0);

    binding.dispose();
    playback.scrub(T1);
    await flushTicks();

    // Disposal restores the clock and stops following the controller.
    expect(clock.currentTime).toBeUndefined();
    expect(clock.multiplier).toBe(1);
    playback.dispose();
  });

  it("binds the window's leading edge when the host asks for it", async () => {
    const playback = playbackOver([]);
    const clock = createClock();

    const binding = await bindTemporalPlaybackToCesium({ clock }, playback, {
      cesium: runtime,
      instant: "window-end",
    });

    expect(isoOf(clock.currentTime)).toBe(new Date(playback.window.end).toISOString());
    binding.dispose();
    playback.dispose();
  });

  it("mirrors transport and rate onto the clock when asked, scaled by the host's multiplier", async () => {
    const playback = playbackOver([]);
    const clock = createClock();
    clock.multiplier = 60;

    const binding = await bindTemporalPlaybackToCesium({ clock }, playback, {
      cesium: runtime,
      transport: "mirror",
    });
    playback.setSpeed(2);
    playback.play();
    await flushTicks();

    expect(clock.shouldAnimate).toBe(true);
    expect(clock.multiplier).toBe(120);

    playback.pause();
    binding.dispose();
    expect(clock.multiplier).toBe(60);
    playback.dispose();
  });

  it("stands down, without throwing, when there is no clock or the host owns it", async () => {
    const playback = playbackOver([]);
    const clock = createClock();

    const unbound = await bindTemporalPlaybackToCesium({}, playback, { cesium: runtime });
    expect(unbound.bound).toBe(false);
    expect(unbound.refusal).toBe("clock-unbound");
    expect(unbound.plan?.currentTime).toBe(EXTENT_START);
    unbound.dispose();

    const hostOwned = await bindTemporalPlaybackToCesium({ clock, clockOwnership: "host" }, playback, {
      cesium: runtime,
    });
    expect(hostOwned.bound).toBe(false);
    expect(hostOwned.refusal).toBe("host-owned");
    expect(clock.currentTime).toBeUndefined();
    hostOwned.dispose();

    const noRuntime = await bindTemporalPlaybackToCesium({ clock }, playback, { cesium: async () => ({}) as never });
    expect(noRuntime.bound).toBe(false);
    expect(noRuntime.refusal).toBe("runtime-unavailable");
    expect(clock.currentTime).toBeUndefined();
    noRuntime.dispose();

    playback.dispose();
  });
});
