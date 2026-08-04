/**
 * Browser-side harness for the real-Cesium scene-adapter fixture matrix (#928).
 *
 * This module runs in a real Chromium page against the real `cesium` package —
 * no `vi.mock("cesium")` seam anywhere. It mounts one accepted plan through the
 * SDK's *public* `createCesiumSceneAdapter` surface onto a live Cesium `Viewer`,
 * reports each primitive's rendered/degraded outcome with the diagnostics behind
 * it, then tears the whole thing down while the page-level probe (installed by
 * the fixture HTML before Cesium ever loads) watches what is actually released.
 *
 * The spec drives it with `runCycles(...)`; running the same plan repeatedly on
 * fresh viewers is what turns single-shot teardown numbers into a leak budget.
 *
 * @module
 */

const probe = globalThis.__honuaSceneProbe;

/** Fixture anchor, mirrored from `cesium-scene-fixture-assets.mjs`. */
const ORIGIN = { longitude: -157.858, latitude: 21.307, height: 400 };

/**
 * The fixture matrix.
 *
 * One dimension is primitive kind: every kind the Cesium adapter materializes
 * (camera, terrain, imagery, 3D-Tiles, glTF/GLB) appears at least once. The
 * other is expected outcome: `supported` rows must reach a live Cesium object,
 * the `degraded` row must reach one *and* carry its fidelity diagnostic, and the
 * `unsupported` row must fail closed before any Cesium factory is touched.
 */
const FIXTURE_MATRIX = [
  {
    id: "fixture-camera",
    expect: "supported",
    // The camera is applied straight to the live `Camera`; it is the one row
    // that legitimately yields no layer handle.
    materializes: false,
    primitive: {
      kind: "camera",
      id: "fixture-camera",
      title: "Fixture camera",
      // Straight down over the fixture anchor: the tileset and the model both sit
      // within the nadir frustum, so "was it selected and drawn" is a property of
      // the adapter's placement rather than of a lucky oblique viewpoint.
      camera: { ...ORIGIN, height: 900, heading: 0, pitch: -90, roll: 0 },
    },
  },
  {
    id: "fixture-terrain",
    expect: "supported",
    materializes: true,
    primitive: {
      kind: "elevation-source",
      id: "fixture-terrain",
      sourceId: "fixture-terrain",
      title: "Fixture quantized-mesh terrain",
      protocol: "quantized-mesh",
      url: "/fixtures/terrain",
      exaggeration: 1.5,
      crs: "OGC:CRS84",
      verticalDatum: "EPSG:4979",
    },
  },
  {
    id: "fixture-imagery",
    expect: "supported",
    materializes: true,
    primitive: {
      kind: "imagery-layer",
      id: "fixture-imagery",
      sourceId: "fixture-imagery",
      title: "Fixture imagery",
      protocol: "url-template",
      url: "/fixtures/imagery/{z}/{x}/{y}.png",
      opacity: 0.85,
      maximumLevel: 2,
      crs: "OGC:CRS84",
    },
  },
  {
    // Deliberately degraded: Cesium honors Web Mercator through its own
    // reprojection onto the WGS84 globe, so the binding renders but not as
    // authored. It must still produce a live imagery layer.
    id: "fixture-imagery-mercator",
    expect: "degraded",
    materializes: true,
    expectedDiagnostics: ["scene-primitive-crs-equivalent"],
    primitive: {
      kind: "imagery-layer",
      id: "fixture-imagery-mercator",
      sourceId: "fixture-imagery-mercator",
      title: "Fixture imagery (Web Mercator)",
      protocol: "url-template",
      url: "/fixtures/imagery/{z}/{x}/{y}.png",
      opacity: 0.35,
      maximumLevel: 2,
      crs: "EPSG:3857",
    },
  },
  {
    id: "fixture-tileset",
    expect: "supported",
    materializes: true,
    primitive: {
      kind: "model-layer",
      id: "fixture-tileset",
      sourceId: "fixture-tileset",
      title: "Fixture 3D-Tiles tileset",
      uri: "/fixtures/tileset/tileset.json",
      format: "3d-tiles",
      position: [ORIGIN.longitude, ORIGIN.latitude, 60],
      crs: "EPSG:4326",
    },
  },
  {
    id: "fixture-model",
    expect: "supported",
    materializes: true,
    primitive: {
      kind: "model-layer",
      id: "fixture-model",
      sourceId: "fixture-model",
      title: "Fixture glTF model",
      uri: "/fixtures/model.glb",
      format: "glb",
      position: [ORIGIN.longitude + 0.0015, ORIGIN.latitude, 90],
      rotation: [45, 0, 0],
      scale: 2,
      crs: "EPSG:4326",
    },
  },
  {
    // Declared-capable but unmaterialized by this adapter. It must fail closed
    // with a stable code and must never reach a Cesium factory.
    id: "fixture-i3s",
    expect: "unsupported",
    materializes: false,
    expectedDiagnostics: ["scene-primitive-model-format-not-materialized"],
    primitive: {
      kind: "model-layer",
      id: "fixture-i3s",
      sourceId: "fixture-i3s",
      title: "Fixture I3S scene layer",
      uri: "/fixtures/i3s/SceneServer/layers/0",
      format: "i3s",
      crs: "EPSG:4326",
    },
  },
];

/** The plan handed to the adapter, in declaration order. */
const PLAN = FIXTURE_MATRIX.map((entry) => entry.primitive);

const PRIMITIVE_BY_ID = new Map(FIXTURE_MATRIX.map((entry) => [entry.id, entry.primitive]));

/**
 * The temporal cycle's plan (#1048).
 *
 * Deliberately smaller than the full matrix: this cycle is about time and the
 * rebuild diff, not about coverage, and the three rows it keeps are exactly the
 * ones needed to prove the property — a camera (no handle), an imagery layer
 * (the binding a delta revises), and a tileset (the binding that must survive
 * that delta untouched).
 */
const TEMPORAL_PLAN = ["fixture-camera", "fixture-imagery", "fixture-tileset"].map((id) => PRIMITIVE_BY_ID.get(id));

/**
 * The temporal fixture's clock stops.
 *
 * `AVAILABLE_FROM`..`AVAILABLE_UNTIL` is the availability window of a probe
 * entity added straight to `viewer.entities`. `BEFORE_WINDOW` sits outside it and
 * `INSIDE_WINDOW` inside it, so Cesium's own availability predicate — evaluated
 * against whatever instant the SDK wrote to `viewer.clock` — has to change
 * answer when application time advances. That is the AC's "temporal-entity
 * availability honours the bound time", asserted through Cesium's semantics
 * rather than through the SDK's own bookkeeping.
 */
const TEMPORAL_TIMES = {
  extentStart: "2026-03-01T00:00:00Z",
  extentEnd: "2026-03-02T00:00:00Z",
  beforeWindow: "2026-03-01T00:00:00Z",
  availableFrom: "2026-03-01T06:00:00Z",
  insideWindow: "2026-03-01T12:00:00Z",
  availableUntil: "2026-03-01T18:00:00Z",
};

function temporalState(adapter, currentTime, realtime) {
  const base = adapter.emptySceneWorkspaceState();
  return {
    ...base,
    timeline: {
      currentTime,
      startTime: TEMPORAL_TIMES.extentStart,
      endTime: TEMPORAL_TIMES.extentEnd,
      playing: false,
    },
    ...(realtime ? { realtime } : {}),
  };
}

function clockIso(Cesium, clock) {
  return clock.currentTime ? Cesium.JulianDate.toIso8601(clock.currentTime) : null;
}

function boundarySummary(reports) {
  return reports.map((report) => `${report.id}:${report.boundary}:${report.incremental ? "in-place" : "rebuilt"}`).sort();
}

let adapterModule;
let cesiumModule;

async function loadModules() {
  adapterModule ??= await import("/dist/src/scene-workspace/index.js");
  cesiumModule ??= await import("cesium");
  return { adapter: adapterModule, Cesium: cesiumModule };
}

function createViewer(Cesium, container) {
  return new Cesium.Viewer(container, {
    animation: false,
    baseLayer: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    // `preserveDrawingBuffer` keeps the colour buffer readable after a render so
    // the fixture can prove pixels were actually rasterized, not just that a
    // canvas element exists.
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  });
}

/** Pump the render loop until `predicate` holds or the deadline passes. */
async function renderUntil(viewer, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    viewer.scene.render();
    if (predicate()) return true;
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }
}

function findScenePrimitive(Cesium, scene, constructorName) {
  for (let index = 0; index < scene.primitives.length; index += 1) {
    const primitive = scene.primitives.get(index);
    if (primitive instanceof Cesium[constructorName]) return primitive;
  }
  return undefined;
}

/** Non-black pixels prove the GPU actually rasterized something. */
function countLitPixels(canvas) {
  const context = document.createElement("canvas").getContext("2d");
  const width = Math.min(canvas.width, 160);
  const height = Math.min(canvas.height, 160);
  if (width === 0 || height === 0) return 0;
  context.canvas.width = width;
  context.canvas.height = height;
  context.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  let lit = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset] + data[offset + 1] + data[offset + 2] > 12) lit += 1;
  }
  return lit;
}

/**
 * Publish the per-binding outcome into the page itself.
 *
 * The issue's workflow asks the page to report which primitives rendered, which
 * degraded, and the diagnostics behind each outcome — so the fixture renders it
 * rather than leaving it only in the spec's return value. It also makes a
 * `--headed` run readable, and the spec asserts against the rendered rows.
 */
function renderOutcomeTable(rendered) {
  const body = document.querySelector("#outcomes tbody");
  body.replaceChildren();
  for (const [id, outcome] of Object.entries(rendered)) {
    const status = outcome.statuses.includes("unsupported")
      ? "unsupported"
      : outcome.statuses.includes("degraded")
        ? "degraded"
        : "supported";
    const row = document.createElement("tr");
    row.dataset.binding = id;
    row.dataset.outcome = status;
    for (const value of [
      id,
      `${outcome.kind}${outcome.format ? ` (${outcome.format})` : ""}${outcome.protocol ? ` (${outcome.protocol})` : ""}`,
      status,
      outcome.hasHandle ? "live handle" : outcome.kind === "camera" ? "camera applied" : "not materialized",
      outcome.codes.join(", "),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}

/**
 * Mount the fixture plan on a fresh viewer, collect rendered/degraded evidence,
 * then tear it down under instrumentation. Returns one cycle report.
 */
async function runCycle(index, options) {
  const { adapter, Cesium } = await loadModules();
  const container = document.createElement("div");
  container.className = "scene-host";
  document.getElementById("scene-hosts").append(container);

  const before = probe.snapshot();
  const viewer = createViewer(Cesium, container);
  const canvas = viewer.scene.canvas;
  const sceneAdapter = adapter.createCesiumSceneAdapter({
    id: `fixture-cesium-scene-${index}`,
    target: { camera: viewer.camera, scene: viewer.scene },
  });

  const baselinePrimitiveCount = viewer.scene.primitives.length;
  const applyStartedAt = performance.now();
  const result = await sceneAdapter.apply(PLAN);
  const applyMs = performance.now() - applyStartedAt;

  const tileset = findScenePrimitive(Cesium, viewer.scene, "Cesium3DTileset");
  const model = findScenePrimitive(Cesium, viewer.scene, "Model");
  // `tilesLoaded` is vacuously true before the first traversal requests
  // anything, so readiness is keyed on content actually reaching the GPU.
  const readyWithinBudget = await renderUntil(
    viewer,
    () => (tileset ? tileset.statistics.numberOfTilesWithContentReady > 0 : true) && (model?.ready ?? true),
    options.readyTimeoutMs,
  );
  // A few extra frames so imagery/terrain tiles reach the GPU before the pixel
  // read; the globe is not required to be complete, only to have drawn.
  for (let frame = 0; frame < 8; frame += 1) {
    viewer.scene.render();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }

  const layers = result.layers;
  const rendered = {};
  for (const entry of FIXTURE_MATRIX) {
    const handle = layers.get(entry.id);
    rendered[entry.id] = {
      kind: entry.primitive.kind,
      format: entry.primitive.format ?? null,
      protocol: entry.primitive.protocol ?? null,
      expect: entry.expect,
      hasHandle: handle !== undefined,
      handleKind: handle?.kind ?? null,
      handleFormat: handle?.format ?? null,
      handleProtocol: handle?.protocol ?? null,
      codes: result.diagnostics.filter((entry_) => entry_.primitiveId === entry.id).map((entry_) => entry_.code),
      statuses: result.diagnostics.filter((entry_) => entry_.primitiveId === entry.id).map((entry_) => entry_.status),
      fidelity: result.diagnostics.find((entry_) => entry_.primitiveId === entry.id && entry_.fidelity)?.fidelity ?? null,
    };
  }

  renderOutcomeTable(rendered);

  const cameraState = adapter.cesiumCameraToSceneState(viewer.camera);
  const evidence = {
    cesiumVersion: Cesium.VERSION,
    readyWithinBudget,
    scenePrimitiveCount: viewer.scene.primitives.length - baselinePrimitiveCount,
    imageryLayerCount: viewer.scene.imageryLayers.length,
    // Cesium ships minified, so class *names* are meaningless here; identity is
    // asserted with `instanceof` against the real runtime's own constructors.
    terrainProviderIsCesiumTerrain: viewer.scene.terrainProvider instanceof Cesium.CesiumTerrainProvider,
    verticalExaggeration: viewer.scene.verticalExaggeration,
    tilesetLoaded: tileset?.tilesLoaded === true,
    tilesetContentReady: tileset?.statistics?.numberOfTilesWithContentReady ?? 0,
    modelReady: model?.ready === true,
    imageryProvidersAreUrlTemplate: Array.from({ length: viewer.scene.imageryLayers.length }, (_, at) =>
      Boolean(viewer.scene.imageryLayers.get(at).imageryProvider instanceof Cesium.UrlTemplateImageryProvider),
    ),
    imageryAlphas: Array.from({ length: viewer.scene.imageryLayers.length }, (_, at) =>
      Number(viewer.scene.imageryLayers.get(at).alpha.toFixed(3)),
    ),
    litPixels: countLitPixels(canvas),
    canvasSize: { width: canvas.width, height: canvas.height },
    camera: {
      longitude: Number(cameraState.longitude.toFixed(4)),
      latitude: Number(cameraState.latitude.toFixed(4)),
      height: Math.round(cameraState.height),
    },
  };

  // --- teardown -----------------------------------------------------------
  // Layer handles come down first and are measured on their own, so the
  // assertion that the adapter released everything it owns cannot be satisfied
  // merely by destroying the viewer underneath it.
  const canvasRef = new WeakRef(canvas);
  const viewerRef = new WeakRef(viewer);
  const layerTeardownStartedAt = performance.now();
  for (const handle of layers.values()) {
    handle.remove();
    handle.remove(); // idempotence: a second removal must not throw or double-destroy
  }
  const layerTeardownMs = performance.now() - layerTeardownStartedAt;

  const afterLayerRemoval = {
    scenePrimitiveCount: viewer.scene.primitives.length - baselinePrimitiveCount,
    imageryLayerCount: viewer.scene.imageryLayers.length,
    // Reported as a token rather than the provider itself: the value has to
    // survive structured cloning back to the spec.
    terrainProvider: (viewer.scene.terrainProvider ?? null) === null ? null : "retained",
    verticalExaggeration: viewer.scene.verticalExaggeration,
  };

  const viewerDestroyStartedAt = performance.now();
  viewer.destroy();
  const viewerDestroyMs = performance.now() - viewerDestroyStartedAt;
  container.remove();

  // Two frames so any animation callback Cesium had queued has a chance to run
  // (and therefore to be observed as *not* rescheduling itself).
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

  const after = probe.snapshot();
  return {
    index,
    status: result.status,
    applyMs: Number(applyMs.toFixed(2)),
    diagnostics: result.diagnostics.map((entry) => ({
      code: entry.code,
      status: entry.status,
      severity: entry.severity,
      primitiveId: entry.primitiveId ?? null,
      primitiveKind: entry.primitiveKind ?? null,
      renderer: entry.renderer ?? null,
      fidelity: entry.fidelity ?? null,
    })),
    rendered,
    evidence,
    teardown: {
      layerTeardownMs: Number(layerTeardownMs.toFixed(2)),
      viewerDestroyMs: Number(viewerDestroyMs.toFixed(2)),
      totalMs: Number((layerTeardownMs + viewerDestroyMs).toFixed(2)),
      afterLayerRemoval,
      viewerDestroyed: viewer.isDestroyed(),
      canvasesInContainer: container.querySelectorAll("canvas").length,
      pendingAnimationFrames: after.pendingAnimationFrames,
      liveWebglContexts: after.liveWebglContexts,
      liveWorkers: after.liveWorkers,
    },
    resources: {
      canvasContextsCreated: after.contextsCreated - before.contextsCreated,
      workersCreated: after.workersCreated - before.workersCreated,
      workersTerminated: after.workersTerminated - before.workersTerminated,
      netListeners: after.netListeners - before.netListeners,
    },
    // Handed back so the spec can force collection through CDP and then ask
    // whether the GPU-backed canvas actually became unreachable.
    retain: { canvasRef, viewerRef },
  };
}

/**
 * One temporal cycle (#1048): bind application time, advance it, drive a
 * realtime-shaped delta, and report what each step did to the live scene.
 *
 * Everything here goes through the public scene-workspace surface —
 * `mountScenePrimitivesToCesium` with the workspace state the adapter now
 * consumes — against a real `Viewer`. The only direct Cesium use is the probe
 * entity and reading `viewer.clock` back, which is the point: the assertions are
 * about Cesium's state, not the SDK's own report of it.
 */
async function runTemporalCycle(options) {
  const { adapter, Cesium } = await loadModules();
  const container = document.createElement("div");
  container.className = "scene-host";
  document.getElementById("scene-hosts").append(container);

  const viewer = createViewer(Cesium, container);
  // Opting in: the clock is handed to the adapter explicitly. A target without
  // one is never given a clock, which is the other half of the ownership
  // contract and is covered by the vitest suite.
  const target = { camera: viewer.camera, scene: viewer.scene, clock: viewer.clock };

  const clockBeforeMount = clockIso(Cesium, viewer.clock);

  // A plain Cesium entity whose availability brackets part of the extent. The
  // SDK never touches it; Cesium alone decides whether it is available, using
  // the clock the SDK wrote. It is added — and its visualizers realized — before
  // the baseline primitive count is taken, so the count measures only what the
  // adapter owns.
  const probeEntity = viewer.entities.add({
    id: "temporal-availability-probe",
    availability: new Cesium.TimeIntervalCollection([
      new Cesium.TimeInterval({
        start: Cesium.JulianDate.fromIso8601(TEMPORAL_TIMES.availableFrom),
        stop: Cesium.JulianDate.fromIso8601(TEMPORAL_TIMES.availableUntil),
      }),
    ]),
    position: Cesium.Cartesian3.fromDegrees(ORIGIN.longitude, ORIGIN.latitude, 120),
    point: { pixelSize: 12, color: Cesium.Color.CYAN },
  });
  const displayEntities = () => viewer.dataSourceDisplay.update(viewer.clock.currentTime);
  displayEntities();
  const baselinePrimitiveCount = viewer.scene.primitives.length;

  const mount = await adapter.mountScenePrimitivesToCesium(target, TEMPORAL_PLAN, {
    state: temporalState(adapter, TEMPORAL_TIMES.beforeWindow),
  });
  displayEntities();

  const tilesetPrimitive = findScenePrimitive(Cesium, viewer.scene, "Cesium3DTileset");
  await renderUntil(
    viewer,
    () => (tilesetPrimitive ? tilesetPrimitive.statistics.numberOfTilesWithContentReady > 0 : true),
    options.readyTimeoutMs,
  );

  const mountedHandles = new Map(mount.layers);
  const initial = {
    revision: mount.revision,
    clock: clockIso(Cesium, viewer.clock),
    entityAvailable: probeEntity.isAvailable(viewer.clock.currentTime),
    imageryAlpha: Number(viewer.scene.imageryLayers.get(0).alpha.toFixed(3)),
    rebuildBoundaries: boundarySummary(mount.rebuildBoundaries),
    timeCodes: mount.diagnostics.filter((entry) => entry.code.startsWith("scene-time-")).map((entry) => entry.code),
  };

  // --- step 1: advance application time only -------------------------------
  const advanced = await mount.apply(TEMPORAL_PLAN, {
    state: temporalState(adapter, TEMPORAL_TIMES.insideWindow),
  });
  displayEntities();
  const advancedEvidence = {
    revision: advanced.revision,
    created: [...advanced.created],
    reused: [...advanced.reused],
    disposed: [...advanced.disposed],
    clock: clockIso(Cesium, viewer.clock),
    entityAvailable: probeEntity.isAvailable(viewer.clock.currentTime),
    rebuildBoundaries: boundarySummary(advanced.rebuildBoundaries),
    // Handle *identity*, compared in the page: a rebuilt binding would be a
    // different object even though the id is the same.
    handlesReusedByIdentity: [...mountedHandles].every(([id, handle]) => mount.layers.get(id) === handle),
    // The live Cesium object behind the tileset must be the same instance too,
    // not merely a handle wrapping a fresh one.
    tilesetPrimitiveReused: findScenePrimitive(Cesium, viewer.scene, "Cesium3DTileset") === tilesetPrimitive,
    scenePrimitiveCount: viewer.scene.primitives.length - baselinePrimitiveCount,
    imageryLayerCount: viewer.scene.imageryLayers.length,
    rebuildBoundaryDiagnostics: advanced.diagnostics.filter((entry) => entry.code === "scene-mount-rebuild-boundary")
      .length,
    timeCodes: advanced.diagnostics.filter((entry) => entry.code.startsWith("scene-time-")).map((entry) => entry.code),
  };

  // --- step 2: a realtime-shaped data delta --------------------------------
  // One binding's configuration changes; the rest of the plan is byte-identical.
  const deltaPlan = TEMPORAL_PLAN.map((primitive) =>
    primitive.id === "fixture-imagery" ? { ...primitive, opacity: 0.4 } : primitive,
  );
  const delta = await mount.apply(deltaPlan, {
    state: temporalState(adapter, TEMPORAL_TIMES.insideWindow, {
      status: "live",
      cursor: "fixture-seq-2",
    }),
  });
  for (let frame = 0; frame < 4; frame += 1) {
    viewer.scene.render();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }
  const deltaEvidence = {
    revision: delta.revision,
    created: [...delta.created],
    reused: [...delta.reused],
    disposed: [...delta.disposed],
    rebuildBoundaries: boundarySummary(delta.rebuildBoundaries),
    tilesetHandleReused: mount.layers.get("fixture-tileset") === mountedHandles.get("fixture-tileset"),
    tilesetPrimitiveReused: findScenePrimitive(Cesium, viewer.scene, "Cesium3DTileset") === tilesetPrimitive,
    imageryHandleRebuilt: mount.layers.get("fixture-imagery") !== mountedHandles.get("fixture-imagery"),
    // The rebuild reached the renderer: the live layer carries the new opacity.
    imageryAlpha: Number(viewer.scene.imageryLayers.get(0).alpha.toFixed(3)),
    imageryLayerCount: viewer.scene.imageryLayers.length,
    scenePrimitiveCount: viewer.scene.primitives.length - baselinePrimitiveCount,
    boundaryDiagnostics: delta.diagnostics
      .filter((entry) => entry.code === "scene-mount-rebuild-boundary")
      .map((entry) => `${entry.primitiveId}:${entry.context.rebuildBoundary}`),
    appliedContext: delta.diagnostics.find((entry) => entry.code === "scene-mount-applied")?.context.realtime ?? null,
  };

  // --- teardown ------------------------------------------------------------
  // Same measured ceilings as the matrix cycle (#1026): this lane adds coverage,
  // not a second budget vocabulary.
  const disposeStartedAt = performance.now();
  mount.dispose();
  mount.dispose(); // idempotence
  const layerTeardownMs = performance.now() - disposeStartedAt;
  const afterLayerRemoval = {
    imageryLayerCount: viewer.scene.imageryLayers.length,
    scenePrimitiveCount: viewer.scene.primitives.length - baselinePrimitiveCount,
    mountState: mount.state,
  };

  const viewerDestroyStartedAt = performance.now();
  viewer.destroy();
  const viewerDestroyMs = performance.now() - viewerDestroyStartedAt;
  container.remove();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

  return {
    cesiumVersion: Cesium.VERSION,
    clockBeforeMount,
    times: TEMPORAL_TIMES,
    initial,
    advanced: advancedEvidence,
    delta: deltaEvidence,
    teardown: {
      layerTeardownMs: Number(layerTeardownMs.toFixed(2)),
      viewerDestroyMs: Number(viewerDestroyMs.toFixed(2)),
      totalMs: Number((layerTeardownMs + viewerDestroyMs).toFixed(2)),
      afterLayerRemoval,
      viewerDestroyed: viewer.isDestroyed(),
      canvasesInContainer: container.querySelectorAll("canvas").length,
    },
  };
}

globalThis.__honuaCesiumSceneFixture = {
  matrix: FIXTURE_MATRIX.map(({ id, expect, materializes, expectedDiagnostics }) => ({
    id,
    expect,
    materializes,
    expectedDiagnostics: expectedDiagnostics ?? [],
  })),
  probe,
  /**
   * Run `cycles` independent mount → assert → teardown cycles and return every
   * report. `retain` is stripped from the returned structure (a `WeakRef` is not
   * serializable) but held on the harness so the spec can probe collectability
   * after a CDP-forced GC.
   */
  async runCycles(options = {}) {
    const cycles = options.cycles ?? 1;
    const readyTimeoutMs = options.readyTimeoutMs ?? 25_000;
    const reports = [];
    globalThis.__honuaCesiumSceneRetained = [];
    for (let index = 0; index < cycles; index += 1) {
      const report = await runCycle(index, { readyTimeoutMs });
      globalThis.__honuaCesiumSceneRetained.push(report.retain);
      delete report.retain;
      reports.push(report);
    }
    return { cycles: reports, probe: probe.snapshot(), console: probe.consoleErrors, errors: probe.pageErrors };
  },
  /**
   * Run one temporal cycle: bind time, advance it, then drive one realtime-shaped
   * delta, reporting what the live Cesium scene did at each step.
   */
  async runTemporal(options = {}) {
    const report = await runTemporalCycle({ readyTimeoutMs: options.readyTimeoutMs ?? 25_000 });
    return { temporal: report, probe: probe.snapshot(), console: probe.consoleErrors, errors: probe.pageErrors };
  },
  /** How many of the retained per-cycle canvases / viewers are still reachable. */
  liveRetained() {
    const retained = globalThis.__honuaCesiumSceneRetained ?? [];
    return {
      canvases: retained.filter((entry) => entry.canvasRef.deref() !== undefined).length,
      viewers: retained.filter((entry) => entry.viewerRef.deref() !== undefined).length,
      liveCanvasCycles: retained.flatMap((entry, index) => (entry.canvasRef.deref() === undefined ? [] : [index])),
      liveViewerCycles: retained.flatMap((entry, index) => (entry.viewerRef.deref() === undefined ? [] : [index])),
      total: retained.length,
    };
  },
};

globalThis.__honuaCesiumSceneFixtureReady = true;
