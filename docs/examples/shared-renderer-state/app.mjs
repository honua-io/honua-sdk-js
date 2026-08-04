/**
 * One Honua application state across a real 2D map and a real 3D globe.
 *
 * Nothing here hand-rolls a port. The two renderer bindings are the SDK's own
 * `createMapLibreStateSyncPort` / `createCesiumStateSyncPort`, and every
 * assertion this fixture reports is read back out of the *renderer* —
 * `map.getCenter()`, `map.getZoom()`, `map.getFilter()`, `map.getFeatureState()`,
 * `viewer.camera.positionCartographic`, `viewer.selectedEntity`,
 * `viewer.entities.get(...).show`, `viewer.clock` — never out of a dictionary the
 * fixture kept for itself.
 *
 * CesiumJS is reached through the bare `cesium` specifier resolved by the page's
 * import map, which is the same lazy peer path `createCesiumStateSyncPort` uses
 * internally.
 */

import {
  createCesiumStateSyncPort,
  createMapLibreStateSyncPort,
  createSceneStateSynchronizer,
  sceneAttributionValue,
} from "/dist/src/scene-workspace/index.js";
import * as maplibregl from "/node_modules/maplibre-gl/dist/maplibre-gl.mjs";

const IDENTITY = Object.freeze({
  sourceId: "live-incidents",
  schemaVersion: "v1",
  sourceVersion: "2026-07-11",
  planId: "shared-operations-view",
  planFingerprint: `sha256:${"b".repeat(64)}`,
});

const ANCHOR = { longitude: -157.858, latitude: 21.307 };
const OBSERVED_EARLY = Date.parse("2026-07-11T11:00:00.000Z");
const OBSERVED_LATE = Date.parse("2026-07-11T13:00:00.000Z");
/** Attribution the plan declares for the globe's terrain binding. */
const TERRAIN_ATTRIBUTION = "Cesium World Ellipsoid";
const STYLE_ATTRIBUTION = "County orthophotography";

globalThis.__sharedRendererStateDone = false;
globalThis.__sharedRendererStateError = null;
globalThis.__sharedRendererStateResult = null;

void run().catch((error) => {
  globalThis.__sharedRendererStateError = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  globalThis.__sharedRendererStateDone = true;
});

async function run() {
  const Cesium = await import("cesium");
  if (!maplibregl) throw new Error("the 2D renderer did not load");

  const map = new maplibregl.Map({
    container: "maplibre",
    style: incidentStyle(),
    center: [ANCHOR.longitude, ANCHOR.latitude],
    zoom: 10,
    attributionControl: false,
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error));
  });
  // Net renderer-listener accounting for the 2D side. The port owns whatever it
  // registers here, so "did dispose release it" is answerable without reaching
  // into renderer internals.
  const mapListeners = probeMapListeners(map);

  const viewer = new Cesium.Viewer("cesium", {
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
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    requestRenderMode: true,
  });
  for (const incident of [
    { id: 17, severity: 4, observedAt: OBSERVED_EARLY, offset: 0 },
    { id: 18, severity: 1, observedAt: OBSERVED_LATE, offset: 0.004 },
  ]) {
    viewer.entities.add({
      id: `incident-${incident.id}`,
      position: Cesium.Cartesian3.fromDegrees(ANCHOR.longitude + incident.offset, ANCHOR.latitude),
      point: { pixelSize: 12, color: Cesium.Color.CYAN },
      properties: { severity: incident.severity, observed_at: incident.observedAt },
    });
  }
  const cesiumListenerBaseline = cesiumListeners(viewer);

  const mapPort = createMapLibreStateSyncPort(map, {
    id: "map-2d",
    identity: IDENTITY,
    timeField: "observed_at",
  });
  const globePort = createCesiumStateSyncPort(viewer, {
    id: "globe-3d",
    identity: IDENTITY,
    entityIdForTarget: (target) => `incident-${typeof target === "object" ? target.id : target}`,
    targetForEntityId: (entityId) => ({ sourceId: "live-incidents", id: Number(entityId.slice("incident-".length)) }),
  });
  const sync = createSceneStateSynchronizer({
    applicationId: "dual-renderer-demo",
    ports: [mapPort, globePort],
    coalesceMs: 0,
  });
  const cesiumListenersWhileAttached = cesiumListeners(viewer);

  // ── 1. A camera move on the 2D map lands on the live globe ────────────────
  map.jumpTo({ center: [-157.86, 21.31], zoom: 11, bearing: 8, pitch: 25 });
  await sync.flush();
  const globeCamera = readGlobeCamera(Cesium, viewer);

  // ── 2. A camera move on the live globe lands on the 2D map ────────────────
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-157.84, 21.29, 8_000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-60),
      roll: 0,
    },
  });
  globePort.readFromRenderer("camera");
  await sync.flush();
  const mapCamera = {
    center: [map.getCenter().lng, map.getCenter().lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    // Reported, not asserted here: the spec recomputes the expected zoom from the
    // SDK's own exported correspondence and checks it against the live map.
    viewportHeightPixels: map.getCanvas().clientHeight,
  };

  // ── 3. Selection, 2D → 3D ─────────────────────────────────────────────────
  mapPort.publish("selection", [{ sourceId: "live-incidents", id: 17 }]);
  await sync.flush();
  // The origin renderer is deliberately not echoed back to: a port applies only
  // what it receives from *another* renderer, which is half of what keeps the
  // loop closed. So the evidence here is the destination globe.
  const selectionFrom2D = {
    cesiumSelectedEntityId: viewer.selectedEntity?.id ?? null,
    sharedSelection: sync.snapshot.values.selection?.value ?? null,
  };

  // ── 4. Selection, 3D → 2D (driven by the viewer's own property) ───────────
  viewer.selectedEntity = viewer.entities.getById("incident-18");
  await sync.flush();
  const selectionFrom3D = {
    mapFeatureState17: map.getFeatureState({ source: "live-incidents", id: 17 }),
    mapFeatureState18: map.getFeatureState({ source: "live-incidents", id: 18 }),
    sharedSelection: sync.snapshot.values.selection?.value ?? null,
  };

  // ── 5. Filters reach both renderers ───────────────────────────────────────
  // A port never re-applies what it originated, so each direction is exercised
  // from the side that is *not* being asserted.
  globePort.publish("filters", { severity: { field: "severity", operator: ">=", value: 3 } });
  await sync.flush();
  const mapLayerFilterAfterFilters = map.getFilter("incidents");

  mapPort.publish("filters", { severity: { field: "severity", operator: ">=", value: 2 } });
  await sync.flush();
  const filters = {
    mapLayerFilter: mapLayerFilterAfterFilters,
    cesiumEntityShow: {
      "incident-17": viewer.entities.getById("incident-17").show,
      "incident-18": viewer.entities.getById("incident-18").show,
    },
  };

  // ── 6. Time: advanced on the live clock, read back through the port ───────
  viewer.clock.startTime = Cesium.JulianDate.fromIso8601("2026-07-11T00:00:00.000Z");
  viewer.clock.stopTime = Cesium.JulianDate.fromIso8601("2026-07-12T00:00:00.000Z");
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601("2026-07-11T12:00:02.000Z");
  viewer.clock.shouldAnimate = true;
  globePort.readFromRenderer("time");
  await sync.flush();
  const time = {
    mapLayerFilter: map.getFilter("incidents"),
    cesiumClockCurrentTime: Cesium.JulianDate.toIso8601(viewer.clock.currentTime, 3),
    cesiumClockAnimating: viewer.clock.shouldAnimate,
  };

  // ── 7. Detail: applied on the 2D map, honestly refused by the globe ───────
  globePort.publish("detail", {
    target: { sourceId: "live-incidents", id: 17 },
    title: "Incident 17",
    status: "ready",
  });
  await sync.flush();
  const detailOnMap = map.getFeatureState({ source: "live-incidents", id: 17 });
  // The reverse direction is refused rather than hijacking `selectedEntity`.
  mapPort.publish("detail", { target: { sourceId: "live-incidents", id: 18 }, status: "ready" });
  await sync.flush();
  const detail = {
    mapFeatureState17: detailOnMap,
    cesiumDetailMapping: globePort.mappings.detail,
  };

  // ── 8. Attribution derived from live provider credit + primitive attribution
  const styleAttributions = Object.values(map.getStyle().sources).map((source) => source.attribution);
  const attributionValue = sceneAttributionValue([
    ...styleAttributions,
    TERRAIN_ATTRIBUTION,
    viewer.scene.terrainProvider?.credit?.html,
  ]);
  mapPort.publish("attribution", attributionValue);
  globePort.publish("realtime", { status: "connected", freshness: "fresh", cursorPresent: true, lagMs: 120 });
  await sync.flush();

  // ── 9. A globe pose the plane cannot hold degrades explicitly ─────────────
  globePort.publish("camera", { longitude: 10, latitude: 88, height: 2_500, heading: 200, pitch: -10, roll: 15 });
  await sync.flush();
  const degraded = {
    codes: mapPort.degradations.map((entry) => entry.code).sort(),
    mapCenterLatitude: map.getCenter().lat,
    mapPitch: map.getPitch(),
    // Roll is feature-detected: this renderer major supports it, so it survives
    // rather than being reported as dropped.
    mapRoll: typeof map.getRoll === "function" ? map.getRoll() : null,
    cameraMappingCode: mapPort.mappings.camera.code,
    latitudeDegradation: mapPort.degradations.find((entry) => entry.code === "camera-latitude-clamped") ?? null,
    sharedCameraLatitude: sync.snapshot.values.camera?.value?.latitude ?? null,
  };

  const result = {
    canvasEvidence: {
      maplibre: document.querySelector("#maplibre canvas") instanceof HTMLCanvasElement,
      cesium: document.querySelector("#cesium canvas") instanceof HTMLCanvasElement,
    },
    cesiumVersion: Cesium.VERSION,
    slices: Object.keys(sync.snapshot.values).sort(),
    revision: sync.snapshot.revision,
    globeCamera,
    mapCamera,
    selectionFrom2D,
    selectionFrom3D,
    filters,
    time,
    detail,
    attribution: sync.snapshot.values.attribution?.value ?? null,
    realtime: sync.snapshot.values.realtime?.value ?? null,
    degraded,
    diagnostics: [...new Set(sync.snapshot.diagnostics.map(({ code }) => code))].sort(),
    listeners: {
      mapWhileAttached: mapListeners.net(),
      cesiumBaseline: cesiumListenerBaseline,
      cesiumWhileAttached: cesiumListenersWhileAttached,
    },
  };

  sync.dispose();
  mapPort.dispose();
  globePort.dispose();
  result.afterDispose = {
    mapNetListeners: mapListeners.net(),
    cesiumListeners: cesiumListeners(viewer),
    mapLayerFilter: map.getFilter("incidents"),
    mapFeatureState17: map.getFeatureState({ source: "live-incidents", id: 17 }),
    cesiumEntityShow: {
      "incident-17": viewer.entities.getById("incident-17").show,
      "incident-18": viewer.entities.getById("incident-18").show,
    },
  };

  map.remove();
  viewer.destroy();
  globalThis.__sharedRendererStateResult = result;
  globalThis.__sharedRendererStateDone = true;
}

function incidentStyle() {
  return {
    version: 8,
    sources: {
      "live-incidents": {
        type: "geojson",
        attribution: STYLE_ATTRIBUTION,
        data: {
          type: "FeatureCollection",
          features: [
            incidentFeature(17, 4, OBSERVED_EARLY, 0),
            incidentFeature(18, 1, OBSERVED_LATE, 0.004),
          ],
        },
      },
    },
    layers: [
      {
        id: "incidents",
        type: "circle",
        source: "live-incidents",
        // A style-authored filter the port must compose on top of, not clobber.
        filter: ["!=", "kind", "exercise"],
        paint: {
          "circle-radius": 7,
          "circle-color": ["case", ["boolean", ["feature-state", "selected"], false], "#ffd166", "#4cc9f0"],
        },
      },
    ],
  };
}

function incidentFeature(id, severity, observedAt, offset) {
  return {
    type: "Feature",
    id,
    properties: { id, severity, observed_at: observedAt, kind: "incident" },
    geometry: { type: "Point", coordinates: [ANCHOR.longitude + offset, ANCHOR.latitude] },
  };
}

function readGlobeCamera(Cesium, viewer) {
  const position = viewer.camera.positionCartographic;
  return {
    longitude: Cesium.Math.toDegrees(position.longitude),
    latitude: Cesium.Math.toDegrees(position.latitude),
    height: position.height,
    heading: Cesium.Math.toDegrees(viewer.camera.heading),
    pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
  };
}

/**
 * Net registrations of the camera events the port binds. Scoped to those three
 * types so an unrelated internal listener cannot make the release look wrong.
 */
function probeMapListeners(map) {
  const tracked = new Set(["moveend", "rotateend", "pitchend"]);
  let net = 0;
  const nativeOn = map.on.bind(map);
  const nativeOff = map.off.bind(map);
  map.on = (type, ...rest) => {
    if (tracked.has(type)) net += 1;
    return nativeOn(type, ...rest);
  };
  map.off = (type, ...rest) => {
    if (tracked.has(type)) net -= 1;
    return nativeOff(type, ...rest);
  };
  return { net: () => net };
}

function cesiumListeners(viewer) {
  return (
    viewer.camera.changed.numberOfListeners +
    viewer.camera.moveEnd.numberOfListeners +
    viewer.selectedEntityChanged.numberOfListeners
  );
}
