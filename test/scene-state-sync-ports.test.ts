import { describe, expect, it, vi } from "vitest";

import {
  type CesiumStateSyncModule,
  type CesiumStateSyncTarget,
  DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
  type MapLibreStateSyncTarget,
  SCENE_STATE_SYNC_SLICES,
  SCENE_STATE_SYNC_SLICE_WORKSPACE_CROSSWALK,
  SCENE_WORKSPACE_SLICES,
  type SceneStateSyncIdentity,
  compileMapLibreFilterSet,
  compileMapLibreFilters,
  createCesiumStateSyncPort,
  createMapLibreStateSyncPort,
  createSceneStateSynchronizer,
  mapLibreCameraHeightToZoom,
  mapLibreGroundResolutionMeters,
  mapLibreViewToSceneCamera,
  mapLibreZoomToCameraHeight,
  sceneAttributionId,
  sceneAttributionValue,
  sceneCameraToMapLibreView,
} from "../src/scene-workspace/index.js";

const IDENTITY: SceneStateSyncIdentity = Object.freeze({
  sourceId: "live-incidents",
  schemaVersion: "v1",
  planId: "shared-operations-view",
});

const DEG2RAD = Math.PI / 180;

// ── Fakes ───────────────────────────────────────────────────────────────────

interface FakeMap extends MapLibreStateSyncTarget {
  readonly featureState: Map<string, Record<string, unknown>>;
  readonly filters: Map<string, unknown>;
  readonly listenerCount: () => number;
  pan(center: [number, number], zoom?: number): void;
}

function fakeMap(options: { readonly maxPitch?: number; readonly maxZoom?: number } = {}): FakeMap {
  const listeners = new Map<string, Set<() => void>>();
  const featureState = new Map<string, Record<string, unknown>>();
  const filters = new Map<string, unknown>([["incidents", ["!=", "archived", true]]]);
  const view = { lng: -157.858, lat: 21.307, zoom: 10, bearing: 0, pitch: 0 };

  const fire = (type: string): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener();
  };
  const key = (target: { source: string; id: string | number; sourceLayer?: string }): string =>
    `${target.source}/${target.sourceLayer ?? ""}/${target.id}`;

  return {
    featureState,
    filters,
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    pan(center, zoom) {
      view.lng = center[0];
      view.lat = center[1];
      if (zoom !== undefined) view.zoom = zoom;
      fire("moveend");
    },
    getCenter: () => ({ lng: view.lng, lat: view.lat }),
    getZoom: () => view.zoom,
    getBearing: () => view.bearing,
    getPitch: () => view.pitch,
    jumpTo(next) {
      if (next.center) {
        view.lng = next.center[0];
        view.lat = next.center[1];
      }
      if (next.zoom !== undefined) view.zoom = next.zoom;
      // Real 2D maps normalize the bearing into (-180, 180]; mirroring that here
      // is what proves the port's heading wrap survives a renderer round trip.
      if (next.bearing !== undefined) view.bearing = ((((next.bearing + 180) % 360) + 360) % 360) - 180;
      if (next.pitch !== undefined) view.pitch = next.pitch;
      fire("moveend");
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as unknown as () => void);
      listeners.set(type, set);
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener as unknown as () => void);
    },
    getMinZoom: () => 0,
    getMaxZoom: () => options.maxZoom ?? 22,
    getMaxPitch: () => options.maxPitch ?? 60,
    getCanvas: () => ({ clientHeight: 600 }),
    getStyle: () => ({
      layers: [
        { id: "basemap", type: "raster", source: "tiles" },
        { id: "incidents", type: "circle", source: "live-incidents" },
      ],
    }),
    getFilter: (id) => filters.get(id),
    setFilter: (id, filter) => {
      filters.set(id, filter);
    },
    getSource: (id) => (id === "live-incidents" ? {} : undefined),
    setFeatureState: (target, state) => {
      featureState.set(key(target), { ...featureState.get(key(target)), ...state });
    },
    removeFeatureState: (target, stateKey) => {
      if (stateKey === undefined) featureState.delete(key(target));
      else {
        const current = { ...featureState.get(key(target)) };
        delete current[stateKey];
        featureState.set(key(target), current);
      }
    },
  };
}

interface FakeViewer extends CesiumStateSyncTarget {
  readonly listenerCount: () => number;
  readonly raiseCameraChanged: () => void;
  readonly setSelectedEntity: (id: string | undefined) => void;
}

function fakeCesiumEvent(): {
  readonly event: { addEventListener(listener: () => void): () => void };
  readonly raise: () => void;
  readonly size: () => number;
} {
  const listeners = new Set<() => void>();
  return {
    event: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    raise: () => {
      for (const listener of [...listeners]) listener();
    },
    size: () => listeners.size,
  };
}

function fakeViewer(): FakeViewer {
  let position = { longitude: -157.858 * DEG2RAD, latitude: 21.307 * DEG2RAD, height: 12_000 };
  let orientation = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
  const changed = fakeCesiumEvent();
  const moveEnd = fakeCesiumEvent();
  const selectedEntityChanged = fakeCesiumEvent();
  const entities = [
    { id: "incident-17", show: true, properties: { severity: 4, status: "open" } },
    { id: "incident-18", show: true, properties: { severity: 1, status: "closed" } },
  ];
  const viewer: FakeViewer = {
    camera: {
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
      setView(next) {
        const destination = next.destination as { longitude: number; latitude: number; height: number };
        position = {
          longitude: destination.longitude * DEG2RAD,
          latitude: destination.latitude * DEG2RAD,
          height: destination.height,
        };
        const requested = (next.orientation ?? {}) as { heading?: number; pitch?: number; roll?: number };
        orientation = {
          heading: requested.heading ?? 0,
          pitch: requested.pitch ?? -Math.PI / 2,
          roll: requested.roll ?? 0,
        };
        // Deliberately synchronous: a renderer that notifies inside `setView` is
        // the worst case for echo suppression, so that is what the fake does.
        changed.raise();
      },
      changed: changed.event,
      moveEnd: moveEnd.event,
    },
    entities: {
      values: entities,
      getById: (id) => entities.find((entity) => entity.id === id),
    },
    clock: {
      currentTime: undefined,
      startTime: undefined,
      stopTime: undefined,
      multiplier: undefined,
      shouldAnimate: false,
    },
    selectedEntity: undefined,
    selectedEntityChanged: selectedEntityChanged.event,
    scene: { requestRender: () => undefined },
    listenerCount: () => changed.size() + moveEnd.size() + selectedEntityChanged.size(),
    raiseCameraChanged: () => changed.raise(),
    setSelectedEntity: (id) => {
      viewer.selectedEntity = id === undefined ? undefined : entities.find((entity) => entity.id === id);
      selectedEntityChanged.raise();
    },
  };
  return viewer;
}

function fakeCesiumModule(): CesiumStateSyncModule {
  return {
    Cartesian3: { fromDegrees: (longitude, latitude, height) => ({ longitude, latitude, height: height ?? 0 }) },
    JulianDate: {
      fromIso8601: (iso) => ({ iso }),
      toIso8601: (date) => (date as { iso?: string } | undefined)?.iso ?? "",
    },
  };
}

// ── Camera correspondence ───────────────────────────────────────────────────

describe("2D/3D camera correspondence", () => {
  it("round-trips zoom through camera height at every latitude within tolerance", () => {
    for (const zoom of [0, 3.5, 10, 14.25, 22]) {
      for (const latitude of [0, 21.307, -45, 66.5, 85]) {
        for (const pitch of [0, 30, 60]) {
          const height = mapLibreZoomToCameraHeight(zoom, latitude, pitch);
          expect(mapLibreCameraHeightToZoom(height, latitude, pitch)).toBeCloseTo(zoom, 9);
        }
      }
    }
  });

  it("keeps the zoom-to-height relation latitude and viewport dependent", () => {
    const equator = mapLibreZoomToCameraHeight(12, 0);
    const polar = mapLibreZoomToCameraHeight(12, 60);
    // cos(60°) = 0.5, so the same zoom is half the ground width — and therefore
    // half the camera distance — at 60° as at the equator.
    expect(polar / equator).toBeCloseTo(Math.cos(60 * DEG2RAD), 9);

    const tall = mapLibreZoomToCameraHeight(12, 0, 0, {
      ...DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
      viewportHeightPixels: 1200,
    });
    expect(tall / equator).toBeCloseTo(2, 9);

    expect(mapLibreGroundResolutionMeters(0, 0)).toBeCloseTo(40_075_016.685_578_49 / 512, 6);
  });

  it("round-trips a full 2D view through the globe pose", () => {
    const view = { center: [-157.858, 21.307] as const, zoom: 11.5, bearing: 42, pitch: 35, roll: 0 };
    const camera = mapLibreViewToSceneCamera(view);
    expect(camera.pitch).toBeCloseTo(-55, 9);
    expect(camera.heading).toBeCloseTo(42, 9);

    const projection = sceneCameraToMapLibreView(camera);
    expect(projection.fidelity).toBe("exact");
    expect(projection.degradations).toEqual([]);
    expect(projection.view.center[0]).toBeCloseTo(view.center[0], 9);
    expect(projection.view.center[1]).toBeCloseTo(view.center[1], 9);
    expect(projection.view.zoom).toBeCloseTo(view.zoom, 9);
    expect(projection.view.bearing).toBeCloseTo(view.bearing, 9);
    expect(projection.view.pitch).toBeCloseTo(view.pitch, 9);
  });

  it("wraps a negative renderer bearing back onto the shared heading range", () => {
    expect(mapLibreViewToSceneCamera({ center: [0, 0], zoom: 5, bearing: -160, pitch: 0, roll: 0 }).heading).toBe(200);
  });

  it("degrades explicitly for every globe pose a 2D plane cannot hold", () => {
    const polar = sceneCameraToMapLibreView({ longitude: 12, latitude: 89.5, height: 5_000 });
    expect(polar.fidelity).toBe("equivalent");
    expect(polar.degradations.map((entry) => entry.code)).toEqual(["camera-latitude-clamped"]);
    expect(polar.view.center[1]).toBeCloseTo(85.051_128_779_806_59, 9);

    const horizon = sceneCameraToMapLibreView({ longitude: 0, latitude: 0, height: 5_000, pitch: -5 });
    expect(horizon.degradations.map((entry) => entry.code)).toEqual(["camera-pitch-clamped"]);
    expect(horizon.view.pitch).toBe(60);
    expect(horizon.degradations[0]?.requested).toBeCloseTo(85, 9);

    const orbital = sceneCameraToMapLibreView({ longitude: 0, latitude: 0, height: 300_000_000 });
    expect(orbital.degradations.map((entry) => entry.code)).toEqual(["camera-zoom-clamped"]);
    expect(orbital.view.zoom).toBe(0);

    const groundLevel = sceneCameraToMapLibreView({ longitude: 0, latitude: 0, height: 1 });
    expect(groundLevel.degradations.map((entry) => entry.code)).toEqual(["camera-zoom-clamped"]);
    expect(groundLevel.view.zoom).toBe(22);

    const rolled = sceneCameraToMapLibreView({ longitude: 0, latitude: 0, height: 5_000, roll: 30 });
    expect(rolled.degradations.map((entry) => entry.code)).toEqual(["camera-roll-dropped"]);
    expect(rolled.view.roll).toBe(0);
    expect(
      sceneCameraToMapLibreView(
        { longitude: 0, latitude: 0, height: 5_000, roll: 30 },
        {
          limits: { minZoom: 0, maxZoom: 22, maxPitch: 60, rollSupported: true },
        },
      ).view.roll,
    ).toBe(30);
  });
});

// ── Attribution derivation ──────────────────────────────────────────────────

describe("attribution derivation", () => {
  it("reduces free-form credits to the slice's safe identifier charset", () => {
    expect(sceneAttributionId("County orthophotography")).toBe("county-orthophotography");
    expect(sceneAttributionId('<a href="https://example.test">OpenStreetMap</a> contributors')).toBe(
      "openstreetmap-contributors",
    );
    expect(sceneAttributionId("   ")).toBeUndefined();
    expect(sceneAttributionId(42)).toBeUndefined();
    expect(sceneAttributionId("...")).toBeUndefined();
    // `.`, `_`, and `:` stay inside an identifier but never lead or trail it.
    expect(sceneAttributionId("  .USGS 3DEP.v2.  ")).toBe("usgs-3dep.v2");
    expect(sceneAttributionId("well--known   source")).toBe("well-known-source");
  });

  it("refuses credit text carrying a credential-bearing URL", () => {
    expect(sceneAttributionId("Imagery via https://operator:s3cret@tiles.example.test/wmts")).toBeUndefined();
    // The same host without userinfo is reducible.
    expect(sceneAttributionId("Imagery via https://tiles.example.test/wmts")).toBe(
      "imagery-via-https:-tiles.example.test-wmts",
    );
  });

  it("reduces markup without a backtracking pattern", () => {
    expect(sceneAttributionId("<<<<<<<<<<".repeat(64))).toBeUndefined();
    expect(sceneAttributionId("<b>USGS</b><i>3DEP</i>")).toBe("usgs-3dep");
  });

  it("builds a sorted, de-duplicated attribution value the envelope accepts", () => {
    const value = sceneAttributionValue(["County orthophotography", "county orthophotography", "USGS 3DEP", undefined]);
    expect(value.ids).toEqual(["county-orthophotography", "usgs-3dep"]);
    const synchronizer = createSceneStateSynchronizer({ applicationId: "attribution-check", coalesceMs: 0 });
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY });
    synchronizer.attach(port);
    port.publish("attribution", value);
    expect(synchronizer.snapshot.values.attribution?.value).toEqual(value);
    synchronizer.dispose();
  });
});

// ── Slice vocabulary reconciliation ─────────────────────────────────────────

describe("slice vocabularies", () => {
  it("crosswalks every wire slice onto the workspace store vocabulary", () => {
    expect(Object.keys(SCENE_STATE_SYNC_SLICE_WORKSPACE_CROSSWALK).sort()).toEqual([...SCENE_STATE_SYNC_SLICES].sort());
    for (const [slice, workspaceSlice] of Object.entries(SCENE_STATE_SYNC_SLICE_WORKSPACE_CROSSWALK)) {
      if (workspaceSlice === null) {
        expect(slice).toBe("attribution");
        continue;
      }
      expect(SCENE_WORKSPACE_SLICES).toContain(workspaceSlice);
    }
    expect(SCENE_STATE_SYNC_SLICE_WORKSPACE_CROSSWALK.time).toBe("timeline");
  });
});

// ── MapLibre port ───────────────────────────────────────────────────────────

describe("MapLibre state-sync port", () => {
  it("applies a shared camera to the live map and reports nothing when it fits", () => {
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });

    port.publish("camera", { longitude: 1, latitude: 2, height: 500, heading: 0, pitch: -90 });
    const height = mapLibreZoomToCameraHeight(9, 21.307, 0);
    port.dispose();
    synchronizer.dispose();
    expect(height).toBeGreaterThan(0);
    expect(map.listenerCount()).toBe(0);
  });

  it("publishes camera changes the user makes and suppresses the echo of what it applied", async () => {
    const map = fakeMap();
    const viewer = fakeViewer();
    const mapPort = createMapLibreStateSyncPort(map, { identity: IDENTITY, id: "map-2d" });
    const globePort = createCesiumStateSyncPort(viewer, {
      identity: IDENTITY,
      id: "globe-3d",
      cesium: fakeCesiumModule(),
    });
    const synchronizer = createSceneStateSynchronizer({
      applicationId: "dual-renderer",
      ports: [mapPort, globePort],
      coalesceMs: 0,
    });

    map.pan([-157.9, 21.4], 12);
    await synchronizer.flush();

    // The globe moved because the map moved: assert the renderer, not a dictionary.
    expect(viewer.camera.positionCartographic.longitude / DEG2RAD).toBeCloseTo(-157.9, 6);
    expect(viewer.camera.positionCartographic.latitude / DEG2RAD).toBeCloseTo(21.4, 6);
    expect(viewer.camera.positionCartographic.height).toBeCloseTo(mapLibreZoomToCameraHeight(12, 21.4, 0), 3);

    const codes = synchronizer.snapshot.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("loop-suppressed");
    // Bounded convergence: one origin commit, no ping-pong.
    expect(synchronizer.snapshot.revision).toBe(1);

    mapPort.dispose();
    globePort.dispose();
    synchronizer.dispose();
  });

  it("moves the map when the globe moves and clamps what the plane cannot hold", async () => {
    const map = fakeMap();
    const viewer = fakeViewer();
    const degradations: string[] = [];
    const mapPort = createMapLibreStateSyncPort(map, {
      identity: IDENTITY,
      id: "map-2d",
      onDegraded: (entry) => degradations.push(entry.code),
    });
    const globePort = createCesiumStateSyncPort(viewer, {
      identity: IDENTITY,
      id: "globe-3d",
      cesium: fakeCesiumModule(),
    });
    const synchronizer = createSceneStateSynchronizer({
      applicationId: "dual-renderer",
      ports: [mapPort, globePort],
      coalesceMs: 0,
    });

    globePort.publish("camera", { longitude: 10, latitude: 88, height: 2_500, heading: 200, pitch: -20, roll: 15 });
    await synchronizer.flush();

    expect(map.getCenter()).toEqual({ lng: 10, lat: 85.051_128_779_806_59 });
    expect(map.getPitch()).toBe(60);
    expect(map.getBearing()).toBe(-160);
    expect(degradations.sort()).toEqual(["camera-latitude-clamped", "camera-pitch-clamped", "camera-roll-dropped"]);
    // The clamped read-back acknowledged rather than publishing itself back, so
    // the shared state still holds the globe's own pose.
    expect(synchronizer.snapshot.values.camera?.value).toMatchObject({ latitude: 88, pitch: -20 });
    expect(synchronizer.snapshot.revision).toBe(1);

    mapPort.dispose();
    globePort.dispose();
    synchronizer.dispose();
  });

  it("composes shared filters and time on top of the style's own filter", async () => {
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY, timeField: "observed_at" });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("filters", { severity: { field: "severity", operator: ">=", value: 3 } });
    peer.emit("time", { currentTime: "2026-07-11T12:00:02.000Z", startTime: "2026-07-11T00:00:00.000Z" });
    await synchronizer.flush();

    expect(map.filters.get("incidents")).toEqual([
      "all",
      ["!=", "archived", true],
      [">=", "severity", 3],
      [">=", "observed_at", Date.parse("2026-07-11T00:00:00.000Z")],
      ["<=", "observed_at", Date.parse("2026-07-11T12:00:02.000Z")],
    ]);
    // Untargeted layers are never touched.
    expect(map.filters.has("basemap")).toBe(false);

    port.dispose();
    expect(map.filters.get("incidents")).toEqual(["!=", "archived", true]);
    synchronizer.dispose();
  });

  it("reports a clause the 2D filter language cannot express instead of claiming it landed", async () => {
    // #1304: `like` is part of the public clause vocabulary and the Cesium port
    // evaluates it, but the MapLibre compiler has no expression for it. It used
    // to vanish while the slice still declared `exact`, so a filter published
    // from the globe hid entities in 3D and changed nothing in 2D with no
    // report anywhere.
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("filters", {
      severity: { field: "severity", operator: ">=", value: 3 },
      label: { field: "label", operator: "like", value: "flood%" },
    });
    await synchronizer.flush();

    // The expressible clause still lands on top of the style's own filter.
    expect(map.filters.get("incidents")).toEqual(["all", ["!=", "archived", true], [">=", "severity", 3]]);

    // The inexpressible one is reported, naming the clause, operator and field.
    expect(port.degradations.map((entry) => entry.code)).toEqual(["filters-clause-not-expressible"]);
    expect(port.degradations[0]?.message).toContain("label");
    expect(port.degradations[0]?.message).toContain("like");

    // The slice does not claim exactness it cannot honour.
    expect(port.mappings.filters).toMatchObject({ outbound: "equivalent", code: "maplibre-layer-filter" });
    expect(port.mappings.filters.message).toContain("like");

    port.dispose();
    synchronizer.dispose();
  });

  it("does not report a clause scoped away from the layer's source as inexpressible", async () => {
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    // `appliesTo` excludes the only filterable layer's source, so the clause was
    // never addressed here and its inexpressibility is not this port's shortfall.
    peer.emit("filters", {
      label: { field: "label", operator: "like", value: "flood%", appliesTo: ["other-source"] },
    });
    await synchronizer.flush();

    expect(port.degradations).toEqual([]);

    port.dispose();
    synchronizer.dispose();
  });

  it("reports a comparison clause whose published value has the wrong shape", async () => {
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    // `>=` against a non-numeric value compiles to nothing for the same reason
    // `like` does, and was silently dropped by the same path.
    peer.emit("filters", { severity: { field: "severity", operator: ">=", value: "high" } });
    await synchronizer.flush();

    expect(map.filters.get("incidents")).toEqual(["all", ["!=", "archived", true]]);
    expect(port.degradations.map((entry) => entry.code)).toEqual(["filters-clause-not-expressible"]);
    expect(port.degradations[0]?.message).toContain("severity");

    port.dispose();
    synchronizer.dispose();
  });

  it("declares time outbound-unsupported when no temporal field is configured", async () => {
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY });
    expect(port.mappings.time.outbound).toBe("unsupported");
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);
    peer.emit("time", { currentTime: "2026-07-11T12:00:02.000Z" });
    await synchronizer.flush();
    expect(synchronizer.snapshot.diagnostics.map((entry) => entry.code)).toContain("unsupported-target");
    port.dispose();
    synchronizer.dispose();
  });

  it("writes selection and detail as feature state and releases both on dispose", async () => {
    const map = fakeMap();
    const port = createMapLibreStateSyncPort(map, { identity: IDENTITY });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("selection", [
      { sourceId: "live-incidents", id: 17 },
      { sourceId: "absent-source", id: 9 },
    ]);
    peer.emit("detail", { target: { sourceId: "live-incidents", id: 17 }, status: "ready" });
    await synchronizer.flush();

    expect(map.featureState.get("live-incidents//17")).toEqual({ selected: true, detail: true });
    expect(port.degradations.map((entry) => entry.code)).toEqual(["selection-source-missing"]);

    port.dispose();
    expect(map.featureState.get("live-incidents//17")).toEqual({});
    synchronizer.dispose();
  });

  it("refuses a map that cannot be driven", () => {
    expect(() => createMapLibreStateSyncPort({} as MapLibreStateSyncTarget, { identity: IDENTITY })).toThrow(
      /must be a function/,
    );
  });
});

// ── Cesium port ─────────────────────────────────────────────────────────────

describe("Cesium state-sync port", () => {
  it("applies shared time to the live clock and reads it back", async () => {
    const viewer = fakeViewer();
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("time", { currentTime: "2026-07-11T12:00:02.000Z", playing: true });
    await synchronizer.flush();

    expect(viewer.clock?.currentTime).toEqual({ iso: "2026-07-11T12:00:02.000Z" });
    expect(viewer.clock?.shouldAnimate).toBe(true);
    // The first read-back after an apply is the acknowledgement of that apply;
    // the second sees nothing new.
    expect(port.readFromRenderer("time")).toBe("acknowledged");
    expect(port.readFromRenderer("time")).toBe("duplicate");

    port.dispose();
    synchronizer.dispose();
  });

  it("carries the clock rate across the wire and onto the live clock", async () => {
    const viewer = fakeViewer();
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("time", { currentTime: "2026-07-11T12:00:02.000Z", speed: -4 });
    await synchronizer.flush();

    // `speed` is part of the timeline contract, so the envelope has to carry it
    // rather than silently dropping it on the way to the renderer.
    expect(synchronizer.snapshot.values.time?.value).toMatchObject({ speed: -4 });
    expect(viewer.clock?.multiplier).toBe(-4);

    port.dispose();
    synchronizer.dispose();
  });

  it("stands down from a host-owned clock instead of fighting it", async () => {
    const viewer = { ...fakeViewer(), clockOwnership: "host" as const };
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    expect(port.mappings.time).toMatchObject({ outbound: "unsupported", code: "cesium-clock-unbound" });
    // The declaration is what the synchronizer acts on, so a delivery never
    // reaches `applyTime`; call it directly to prove the guard is real code and
    // not only a mapping string.
    const synchronizer = createSceneStateSynchronizer({
      applicationId: "app",
      ports: [{ ...port, mappings: { ...port.mappings, time: { ...port.mappings.time, outbound: "exact" } } }],
      coalesceMs: 0,
    });
    const peer = attachProbePort(synchronizer);
    peer.emit("time", { currentTime: "2026-07-11T12:00:02.000Z" });
    await synchronizer.flush();
    expect(viewer.clock?.currentTime).toBeUndefined();
    expect(port.degradations.map((entry) => entry.code)).toEqual(["time-clock-host-owned"]);
    port.dispose();
    synchronizer.dispose();
  });

  it("restores the clock it displaced on dispose", async () => {
    const viewer = fakeViewer();
    const baseline = { iso: "2026-01-01T00:00:00.000Z" };
    if (viewer.clock) viewer.clock.currentTime = baseline;
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("time", { currentTime: "2026-07-11T12:00:02.000Z", playing: true });
    await synchronizer.flush();
    expect(viewer.clock?.currentTime).toEqual({ iso: "2026-07-11T12:00:02.000Z" });

    port.dispose();
    expect(viewer.clock?.currentTime).toBe(baseline);
    expect(viewer.clock?.shouldAnimate).toBe(false);
    synchronizer.dispose();
  });

  it("focuses the first resolvable selection target and reports what a globe cannot show", async () => {
    const viewer = fakeViewer();
    const port = createCesiumStateSyncPort(viewer, {
      identity: IDENTITY,
      cesium: fakeCesiumModule(),
      entityIdForTarget: (target) =>
        typeof target === "object" ? `incident-${(target as { id: number }).id}` : undefined,
      targetForEntityId: (entityId) => ({ sourceId: "live-incidents", id: Number(entityId.replace("incident-", "")) }),
    });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("selection", [
      { sourceId: "live-incidents", id: 17 },
      { sourceId: "live-incidents", id: 18 },
      { sourceId: "live-incidents", id: 99 },
    ]);
    await synchronizer.flush();

    expect((viewer.selectedEntity as { id: string }).id).toBe("incident-17");
    expect(port.degradations.map((entry) => entry.code)).toEqual([
      "selection-target-unresolved",
      "selection-not-fully-expressible",
    ]);

    port.dispose();
    synchronizer.dispose();
  });

  it("publishes a viewer-driven selection back to the shared state", async () => {
    const viewer = fakeViewer();
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });

    viewer.setSelectedEntity("incident-18");
    await synchronizer.flush();

    expect(synchronizer.snapshot.values.selection?.value).toEqual([{ sourceId: "live-incidents", id: "incident-18" }]);
    port.dispose();
    synchronizer.dispose();
  });

  it("applies shared filters as entity visibility and restores it on dispose", async () => {
    const viewer = fakeViewer();
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("filters", { severity: { field: "severity", operator: ">=", value: 3 } });
    await synchronizer.flush();

    expect(viewer.entities?.values.map((entity) => entity.show)).toEqual([true, false]);

    peer.emit("filters", { status: { field: "status", operator: "in", value: ["closed"] } });
    await synchronizer.flush();
    expect(viewer.entities?.values.map((entity) => entity.show)).toEqual([false, true]);

    port.dispose();
    expect(viewer.entities?.values.map((entity) => entity.show)).toEqual([true, true]);
    synchronizer.dispose();
  });

  it("refuses the detail slice rather than double-driving the focused entity", async () => {
    const viewer = fakeViewer();
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    expect(port.mappings.detail).toMatchObject({
      inbound: "exact",
      outbound: "unsupported",
      code: "cesium-detail-focus-owned-by-selection",
    });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);
    peer.emit("detail", { target: { sourceId: "live-incidents", id: 17 }, status: "ready" });
    await synchronizer.flush();
    expect(synchronizer.snapshot.diagnostics.map((entry) => entry.code)).toContain("unsupported-target");
    port.dispose();
    synchronizer.dispose();
  });

  it("loads the Cesium peer lazily and only when a constructor is needed", async () => {
    const viewer = fakeViewer();
    const loader = vi.fn(async () => fakeCesiumModule());
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: loader });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    const peer = attachProbePort(synchronizer);

    peer.emit("filters", {});
    await synchronizer.flush();
    expect(loader).not.toHaveBeenCalled();

    peer.emit("camera", { longitude: 4, latitude: 5, height: 900 });
    await synchronizer.flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(viewer.camera.positionCartographic.longitude / DEG2RAD).toBeCloseTo(4, 9);

    port.dispose();
    synchronizer.dispose();
  });

  it("releases every viewer listener on dispose", () => {
    const viewer = fakeViewer();
    const port = createCesiumStateSyncPort(viewer, { identity: IDENTITY, cesium: fakeCesiumModule() });
    const synchronizer = createSceneStateSynchronizer({ applicationId: "app", ports: [port], coalesceMs: 0 });
    expect(viewer.listenerCount()).toBe(3);
    synchronizer.dispose();
    port.dispose();
    expect(viewer.listenerCount()).toBe(0);
    expect(port.disposed).toBe(true);
    expect(port.publish("camera", { longitude: 0, latitude: 0, height: 1 })).toBe("disposed");
  });
});

describe("shared filter compilation", () => {
  it("scopes clauses by source and keeps everything when there is nothing to filter", () => {
    expect(compileMapLibreFilters({}, "live-incidents")).toEqual(["all"]);
    expect(
      compileMapLibreFilters(
        {
          severity: { field: "severity", operator: ">=", value: 3 },
          other: { field: "kind", operator: "=", value: "fire", appliesTo: ["another-source"] },
        },
        "live-incidents",
      ),
    ).toEqual(["all", [">=", "severity", 3]]);
  });

  it("separates clauses it could not express from clauses scoped to another source", () => {
    const compilation = compileMapLibreFilterSet(
      {
        severity: { field: "severity", operator: ">=", value: 3 },
        label: { field: "label", operator: "like", value: "flood%" },
        members: { field: "crew", operator: "in", value: "not-an-array" },
        elsewhere: { field: "kind", operator: "like", value: "fire%", appliesTo: ["another-source"] },
      },
      "live-incidents",
    );

    expect(compilation.filter).toEqual(["all", [">=", "severity", 3]]);
    expect(compilation.omitted).toEqual([
      { key: "label", operator: "like", field: "label" },
      { key: "members", operator: "in", field: "crew" },
    ]);
    // The legacy signature is the same compiler with the report discarded.
    expect(
      compileMapLibreFilters({ label: { field: "label", operator: "like", value: "x%" } }, "live-incidents"),
    ).toEqual(["all"]);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A minimal second port so a test can put state on the wire from "the other
 * renderer" without standing up a second fake renderer.
 */
function attachProbePort(synchronizer: ReturnType<typeof createSceneStateSynchronizer>): {
  emit(slice: string, value: unknown): void;
} {
  const listeners = new Set<(event: unknown) => void>();
  let sequence = 0;
  synchronizer.attach({
    id: "probe",
    renderer: "custom",
    mappings: Object.fromEntries(
      SCENE_STATE_SYNC_SLICES.map((slice) => [
        slice,
        { inbound: "exact", outbound: "unsupported", code: `probe-${slice}`, message: "Probe port." },
      ]),
    ) as never,
    subscribe(listener) {
      listeners.add(listener as (event: unknown) => void);
      return () => listeners.delete(listener as (event: unknown) => void);
    },
    apply() {
      return undefined;
    },
  });
  return {
    emit(slice, value) {
      sequence += 1;
      for (const listener of [...listeners]) {
        listener({
          kind: "honua.scene-state-sync",
          version: "1.0",
          sequence,
          emittedAt: new Date().toISOString(),
          slice,
          value,
          identity: IDENTITY,
        });
      }
    },
  };
}
