import { describe, expect, it, vi } from "vitest";

import {
  HonuaSceneStateSyncError,
  SCENE_STATE_SYNC_KIND,
  SCENE_STATE_SYNC_VERSION,
  type SceneStateSyncDelivery,
  type SceneStateSyncInput,
  type SceneStateSyncMappings,
  type SceneStateSyncPort,
  type SceneStateSyncSlice,
  type SceneStateSyncValueMap,
  createSceneStateSynchronizer,
  defaultSceneStateSyncMappings,
} from "../src/scene-workspace/index.js";

const AT = "2026-07-11T12:00:00.000Z";
const IDENTITY = Object.freeze({
  sourceId: "incidents",
  schemaVersion: "v3",
  sourceVersion: "2026-07-11",
  planId: "ops-view",
  planFingerprint: `sha256:${"a".repeat(64)}` as const,
});

interface TestPort {
  readonly port: SceneStateSyncPort;
  readonly applied: SceneStateSyncDelivery[];
  readonly listenerCount: () => number;
  emit<Slice extends SceneStateSyncSlice>(
    slice: Slice,
    value: SceneStateSyncValueMap[Slice],
    options?: {
      readonly sequence?: number;
      readonly causeRevision?: number;
    },
  ): void;
}

function testPort(
  id: string,
  renderer: "maplibre" | "cesium" | "custom",
  options: {
    readonly mappings?: SceneStateSyncMappings;
    readonly apply?: (delivery: SceneStateSyncDelivery) => void | Promise<void>;
    readonly subscribeError?: Error;
    readonly unsubscribe?: () => void;
  } = {},
): TestPort {
  const listeners = new Set<(event: SceneStateSyncInput) => void>();
  const applied: SceneStateSyncDelivery[] = [];
  let sequence = 0;
  const port: SceneStateSyncPort = {
    id,
    renderer,
    mappings: options.mappings ?? defaultSceneStateSyncMappings(renderer),
    subscribe(listener) {
      if (options.subscribeError) throw options.subscribeError;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        options.unsubscribe?.();
      };
    },
    async apply(delivery) {
      applied.push(delivery);
      await options.apply?.(delivery);
    },
  };
  return {
    port,
    applied,
    listenerCount: () => listeners.size,
    emit(slice, value, emitOptions = {}) {
      sequence = emitOptions.sequence ?? sequence + 1;
      const event = {
        kind: SCENE_STATE_SYNC_KIND,
        version: SCENE_STATE_SYNC_VERSION,
        sequence,
        emittedAt: AT,
        slice,
        value,
        identity: IDENTITY,
        ...(emitOptions.causeRevision === undefined ? {} : { causeRevision: emitOptions.causeRevision }),
      } as SceneStateSyncInput;
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function unsupported(base: SceneStateSyncMappings, slice: SceneStateSyncSlice): SceneStateSyncMappings {
  return Object.freeze({
    ...base,
    [slice]: Object.freeze({
      inbound: "unsupported",
      outbound: "unsupported",
      code: "unsupported-slice",
      message: "This renderer does not support the slice.",
    }),
  });
}

describe("scene renderer state synchronization", () => {
  it("constructs transactionally around clocks, initial ports, and outer cancellation", () => {
    const subscribe = vi.fn(() => () => undefined);
    expect(() =>
      createSceneStateSynchronizer({
        applicationId: "bad-clock",
        ports: [
          {
            id: "map",
            renderer: "maplibre",
            mappings: defaultSceneStateSyncMappings("maplibre"),
            subscribe,
            apply() {},
          },
        ],
        now: () => {
          throw new Error("clock failed");
        },
      }),
    ).toThrowError(HonuaSceneStateSyncError);
    expect(subscribe).not.toHaveBeenCalled();

    const abortListeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: () => void) {
        abortListeners.add(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        abortListeners.delete(listener);
      },
    } as unknown as AbortSignal;
    const first = testPort("first", "maplibre");
    const broken = testPort("broken", "cesium", { subscribeError: new Error("broken") });
    expect(() =>
      createSceneStateSynchronizer({
        applicationId: "rollback",
        ports: [first.port, broken.port],
        signal,
        now: () => AT,
      }),
    ).toThrowError(HonuaSceneStateSyncError);
    expect(first.listenerCount()).toBe(0);
    expect(abortListeners.size).toBe(0);

    let clockCalls = 0;
    const source = testPort("source", "maplibre");
    const changing = createSceneStateSynchronizer({
      applicationId: "changing-clock",
      ports: [source.port],
      now: () => {
        clockCalls += 1;
        if (clockCalls > 1) throw new Error("changed");
        return AT;
      },
    });
    source.emit("selection", [1]);
    expect(changing.snapshot).toMatchObject({ revision: 1, values: { selection: { acceptedAt: AT } } });
    changing.dispose();
  });

  it("replays bounded synchronous subscription state only after attachment commits", () => {
    const event = {
      kind: SCENE_STATE_SYNC_KIND,
      version: SCENE_STATE_SYNC_VERSION,
      sequence: 1,
      emittedAt: AT,
      slice: "selection",
      value: [101],
      identity: IDENTITY,
    } as const;
    const sync = createSceneStateSynchronizer({ applicationId: "sync-state", now: () => AT });
    sync.attach({
      id: "map",
      renderer: "maplibre",
      mappings: defaultSceneStateSyncMappings("maplibre"),
      subscribe(listener) {
        listener(event);
        return () => undefined;
      },
      apply() {},
    });
    expect(sync.snapshot).toMatchObject({ revision: 1, values: { selection: { value: [101] } } });

    const unsubscribe = vi.fn();
    expect(() =>
      sync.attach({
        id: "hostile",
        renderer: "cesium",
        mappings: defaultSceneStateSyncMappings("cesium"),
        subscribe(listener) {
          for (let sequence = 1; sequence <= 33; sequence += 1) listener({ ...event, sequence });
          return unsubscribe;
        },
        apply() {},
      }),
    ).toThrowError(HonuaSceneStateSyncError);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(sync.portIds).toEqual(["map"]);
    expect(sync.snapshot.revision).toBe(1);
    sync.dispose();
  });

  it("rejects accessor, proxy, sparse, and oversized foreign envelopes without delivery", async () => {
    let publish: ((event: SceneStateSyncInput) => void) | undefined;
    const source = testPort("source", "maplibre");
    const foreignPort: SceneStateSyncPort = {
      ...source.port,
      id: "foreign",
      subscribe(listener) {
        publish = listener;
        return () => undefined;
      },
    };
    const target = testPort("target", "cesium");
    const sync = createSceneStateSynchronizer({
      applicationId: "foreign",
      ports: [foreignPort, target.port],
      now: () => AT,
    });
    const base = {
      kind: SCENE_STATE_SYNC_KIND,
      version: SCENE_STATE_SYNC_VERSION,
      emittedAt: AT,
      slice: "selection",
      identity: IDENTITY,
    };
    const accessor = { ...base, sequence: 1, value: [1] };
    Object.defineProperty(accessor, "value", { get: () => [1], enumerable: true });
    const sparse = { ...base, sequence: 2, value: Array(2) };
    const oversized = { ...base, sequence: 3, value: [{ sourceId: "x".repeat(1_048_577), id: 1 }] };
    const proxy = new Proxy(
      { ...base, sequence: 4, value: [1] },
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    for (const value of [accessor, sparse, oversized, proxy])
      expect(() => publish?.(value as SceneStateSyncInput)).not.toThrow();
    await sync.flush();
    expect(sync.snapshot.revision).toBe(0);
    expect(target.applied).toEqual([]);
    expect(sync.snapshot.diagnostics.filter(({ code }) => code === "stale-update")).toHaveLength(4);
    sync.dispose();
  });

  it("rejects nonfinite identifiers/progress and gives custom ports unsupported defaults", () => {
    const source = testPort("source", "maplibre");
    const sync = createSceneStateSynchronizer({ applicationId: "finite", ports: [source.port], now: () => AT });
    source.emit("selection", [Number.NaN]);
    source.emit("selection", [{ sourceId: "incidents", id: Number.POSITIVE_INFINITY }]);
    source.emit("detail", { sourceId: "incidents", featureId: Number.NEGATIVE_INFINITY });
    source.emit("time", { progress: Number.NaN });
    expect(sync.snapshot.revision).toBe(0);
    expect(Object.values(defaultSceneStateSyncMappings("custom"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ inbound: "unsupported", outbound: "unsupported" })]),
    );
    expect(Object.values(defaultSceneStateSyncMappings("custom"))).toHaveLength(7);
    sync.dispose();
  });

  it("enforces hard lifecycle configuration ceilings", () => {
    expect(() => createSceneStateSynchronizer({ applicationId: "ports", maxPorts: 65 })).toThrowError(
      HonuaSceneStateSyncError,
    );
    expect(() => createSceneStateSynchronizer({ applicationId: "diagnostics", maxDiagnostics: 2_049 })).toThrowError(
      HonuaSceneStateSyncError,
    );
  });

  it("moves renderer-neutral state bidirectionally with identity, origin, revision, and fidelity", async () => {
    const map = testPort("map", "maplibre");
    const globe = testPort("globe", "cesium");
    const sync = createSceneStateSynchronizer({
      applicationId: "ops",
      ports: [map.port, globe.port],
      coalesceMs: 0,
      now: () => AT,
    });

    map.emit("selection", [{ sourceId: "incidents", id: 17 }]);
    globe.emit("filters", { severity: { field: "severity", operator: ">=", value: 3 } });
    map.emit("camera", { longitude: -157.858, latitude: 21.307, height: 2_000, pitch: 35 });
    globe.emit("time", { currentTime: AT, playing: true });
    await sync.flush();

    expect(sync.snapshot.revision).toBe(4);
    expect(sync.snapshot.values.camera).toMatchObject({
      revision: 3,
      identity: IDENTITY,
      origin: { applicationId: "ops", portId: "map", renderer: "maplibre" },
      fidelity: { inbound: "equivalent", code: "maplibre-2d-camera" },
    });
    expect(globe.applied.map(({ envelope }) => envelope.slice)).toEqual(["selection", "camera"]);
    expect(map.applied.map(({ envelope }) => envelope.slice)).toEqual(["filters", "time"]);
    expect(map.applied.at(-1)?.fidelity).toMatchObject({ outbound: "equivalent", code: "maplibre-time" });
    sync.dispose();
  });

  it("suppresses acknowledged loops, duplicate state, stale sequences, and unsupported mappings", async () => {
    const globeRef: { current?: TestPort } = {};
    const globe = testPort("globe", "cesium", {
      apply(delivery) {
        globeRef.current?.emit(delivery.envelope.slice, delivery.envelope.value, {
          causeRevision: delivery.envelope.revision,
        });
      },
    });
    globeRef.current = globe;
    const map = testPort("map", "maplibre");
    const limited = testPort("limited", "custom", {
      mappings: unsupported(defaultSceneStateSyncMappings("custom"), "selection"),
    });
    const sync = createSceneStateSynchronizer({
      applicationId: "ops",
      ports: [map.port, globe.port, limited.port],
      now: () => AT,
    });

    map.emit("selection", [1], { sequence: 3 });
    await sync.flush();
    map.emit("selection", [2], { sequence: 2 });
    map.emit("selection", [1], { sequence: 4 });
    limited.emit("selection", [9]);
    await sync.flush();

    expect(sync.snapshot.revision).toBe(1);
    expect(sync.snapshot.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "loop-suppressed",
        "stale-update",
        "duplicate-suppressed",
        "unsupported-origin",
        "unsupported-target",
      ]),
    );
    sync.dispose();
  });

  it("coalesces high-frequency camera and time updates to their final states", async () => {
    const map = testPort("map", "maplibre");
    const globe = testPort("globe", "cesium");
    const sync = createSceneStateSynchronizer({
      applicationId: "ops",
      ports: [map.port, globe.port],
      coalesceMs: 0,
      now: () => AT,
    });

    map.emit("camera", { longitude: 1, latitude: 1, height: 100 });
    map.emit("camera", { longitude: 2, latitude: 2, height: 200 });
    map.emit("camera", { longitude: 3, latitude: 3, height: 300 });
    map.emit("time", { currentTime: "2026-07-11T12:00:01.000Z" });
    map.emit("time", { currentTime: "2026-07-11T12:00:02.000Z" });
    await sync.flush();

    expect(sync.snapshot.revision).toBe(2);
    expect(sync.snapshot.values.camera?.value).toMatchObject({ longitude: 3, height: 300 });
    expect(sync.snapshot.values.time?.value).toEqual({ currentTime: "2026-07-11T12:00:02.000Z" });
    expect(globe.applied).toHaveLength(2);
    expect(sync.snapshot.diagnostics.filter(({ code }) => code === "coalesced")).toHaveLength(3);
    sync.dispose();
  });

  it("serializes async deliveries and continues after an apply rejection", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const target = testPort("target", "cesium", {
      async apply(delivery) {
        calls += 1;
        order.push(`start:${delivery.envelope.slice}`);
        if (calls === 1) await gate;
        if (calls === 2) throw new Error("renderer failed");
        order.push(`end:${delivery.envelope.slice}`);
      },
    });
    const source = testPort("source", "maplibre");
    const sync = createSceneStateSynchronizer({
      applicationId: "ops",
      ports: [source.port, target.port],
      now: () => AT,
    });
    source.emit("selection", [1]);
    source.emit("filters", { open: { field: "open", operator: "=", value: true } });
    source.emit("detail", { sourceId: "incidents", featureId: 1, status: "ready" });
    await Promise.resolve();
    expect(order).toEqual(["start:selection"]);
    release?.();
    await sync.flush();

    expect(order).toEqual(["start:selection", "end:selection", "start:filters", "start:detail", "end:detail"]);
    expect(sync.snapshot.diagnostics.some(({ code }) => code === "apply-failed")).toBe(true);
    sync.dispose();
  });

  it("rolls back group attachment, supports detach/reattach replay, and isolates concurrent instances", async () => {
    const cleanup = vi.fn();
    const first = testPort("first", "maplibre", { unsubscribe: cleanup });
    const broken = testPort("broken", "cesium", { subscribeError: new Error("no renderer") });
    const failed = createSceneStateSynchronizer({ applicationId: "failed", now: () => AT });
    expect(() => failed.attachAll([first.port, broken.port])).toThrowError(HonuaSceneStateSyncError);
    expect(first.listenerCount()).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(failed.portIds).toEqual([]);
    failed.dispose();

    const sourceA = testPort("source", "maplibre");
    const sourceB = testPort("source", "maplibre");
    const syncA = createSceneStateSynchronizer({ applicationId: "a", ports: [sourceA.port], now: () => AT });
    const syncB = createSceneStateSynchronizer({ applicationId: "b", ports: [sourceB.port], now: () => AT });
    sourceA.emit("selection", [7]);
    expect(syncA.snapshot.revision).toBe(1);
    expect(syncB.snapshot.revision).toBe(0);

    syncA.detach("source");
    sourceA.emit("selection", [8]);
    const reattached = testPort("source", "maplibre");
    syncA.attach(reattached.port);
    await syncA.flush();
    expect(reattached.applied[0]?.envelope.value).toEqual([7]);
    syncA.dispose();
    syncB.dispose();
  });

  it("cancels deterministically and snapshots foreign methods and input values", () => {
    const controller = new AbortController();
    const source = testPort("source", "maplibre");
    const apply = source.port.apply;
    const sync = createSceneStateSynchronizer({
      applicationId: "ops",
      ports: [source.port],
      signal: controller.signal,
      now: () => AT,
    });
    Object.defineProperty(source.port, "apply", { value: () => Promise.reject(new Error("mutated")) });
    expect(source.port.apply).not.toBe(apply);

    const selection = [{ sourceId: "incidents", id: 5 }];
    source.emit("selection", selection);
    selection[0]!.id = 99;
    expect(sync.snapshot.values.selection?.value).toEqual([{ sourceId: "incidents", id: 5 }]);

    controller.abort();
    expect(sync.disposed).toBe(true);
    expect(source.listenerCount()).toBe(0);
    expect(() => sync.snapshot).toThrowError(HonuaSceneStateSyncError);
    sync.dispose();
  });
});
