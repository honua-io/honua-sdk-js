import {
  SCENE_STATE_SYNC_KIND,
  SCENE_STATE_SYNC_VERSION,
  createSceneStateSynchronizer,
  defaultSceneStateSyncMappings,
} from "/dist/src/scene-workspace/index.js";
import * as maplibregl from "/node_modules/maplibre-gl/dist/maplibre-gl.mjs";

const Cesium = globalThis.Cesium;
const AT = "2026-07-11T12:00:00.000Z";
const identity = Object.freeze({
  sourceId: "live-incidents",
  schemaVersion: "v1",
  sourceVersion: "2026-07-11",
  planId: "shared-operations-view",
  planFingerprint: `sha256:${"b".repeat(64)}`,
});

globalThis.__sharedRendererStateDone = false;
globalThis.__sharedRendererStateError = null;
globalThis.__sharedRendererStateResult = null;

void run().catch((error) => {
  globalThis.__sharedRendererStateError = error instanceof Error ? error.message : String(error);
  globalThis.__sharedRendererStateDone = true;
});

async function run() {
  if (!Cesium || !maplibregl) throw new Error("MapLibre or Cesium did not load");
  const map = new maplibregl.Map({
    container: "maplibre",
    style: { version: 8, sources: {}, layers: [] },
    center: [-157.858, 21.307],
    zoom: 10,
    attributionControl: false,
  });
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error));
  });
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
  viewer.entities.add({
    id: "incident-17",
    position: Cesium.Cartesian3.fromDegrees(-157.858, 21.307),
    point: { pixelSize: 12, color: Cesium.Color.CYAN },
  });

  const mapPort = createPort("map-2d", "maplibre", (delivery) => {
    applyApplicationState(mapPort.state, delivery);
    if (delivery.envelope.slice === "camera") {
      const camera = delivery.envelope.value;
      map.jumpTo({
        center: [camera.longitude, camera.latitude],
        zoom: heightToZoom(camera.height),
        pitch: camera.pitch ?? 0,
        bearing: camera.heading ?? 0,
      });
    }
    mapPort.emit(delivery.envelope.slice, delivery.envelope.value, delivery.envelope.revision);
  });
  const globePort = createPort("globe-3d", "cesium", (delivery) => {
    applyApplicationState(globePort.state, delivery);
    if (delivery.envelope.slice === "camera") {
      const camera = delivery.envelope.value;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(camera.longitude, camera.latitude, camera.height),
        orientation: {
          heading: Cesium.Math.toRadians(camera.heading ?? 0),
          pitch: Cesium.Math.toRadians(camera.pitch ?? -45),
          roll: Cesium.Math.toRadians(camera.roll ?? 0),
        },
      });
      viewer.scene.requestRender();
    }
    globePort.emit(delivery.envelope.slice, delivery.envelope.value, delivery.envelope.revision);
  });

  const sync = createSceneStateSynchronizer({
    applicationId: "dual-renderer-demo",
    ports: [mapPort.port, globePort.port],
    coalesceMs: 0,
    now: () => AT,
  });
  map.jumpTo({ center: [-157.86, 21.31], zoom: 11, pitch: 25, bearing: 8 });
  mapPort.emit("camera", { longitude: -157.86, latitude: 21.31, height: zoomToHeight(11), heading: 8, pitch: 25 });
  mapPort.emit("selection", [{ sourceId: "live-incidents", id: 17 }]);
  globePort.emit("filters", { severity: { field: "severity", operator: ">=", value: 3 } });
  globePort.emit("time", { currentTime: "2026-07-11T12:00:01.000Z", playing: true });
  globePort.emit("time", { currentTime: "2026-07-11T12:00:02.000Z", playing: true });
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-157.84, 21.29, 8_000) });
  globePort.emit("camera", { longitude: -157.84, latitude: 21.29, height: 8_000, heading: 0, pitch: -90, roll: 0 });
  await sync.flush();

  const canvasEvidence = {
    maplibre: document.querySelector("#maplibre canvas") instanceof HTMLCanvasElement,
    cesium: document.querySelector("#cesium canvas") instanceof HTMLCanvasElement,
  };
  const result = {
    canvasEvidence,
    revision: sync.snapshot.revision,
    slices: Object.keys(sync.snapshot.values).sort(),
    mapState: mapPort.state,
    globeState: globePort.state,
    diagnostics: sync.snapshot.diagnostics.map(({ code }) => code),
  };
  sync.dispose();
  result.listenerCountsAfterDispose = { maplibre: mapPort.listenerCount(), cesium: globePort.listenerCount() };
  map.remove();
  viewer.destroy();
  globalThis.__sharedRendererStateResult = result;
  globalThis.__sharedRendererStateDone = true;
}

function createPort(id, renderer, apply) {
  const listeners = new Set();
  let sequence = 0;
  const state = {};
  const api = {
    state,
    listenerCount: () => listeners.size,
    emit(slice, value, causeRevision) {
      sequence += 1;
      const event = {
        kind: SCENE_STATE_SYNC_KIND,
        version: SCENE_STATE_SYNC_VERSION,
        sequence,
        emittedAt: AT,
        slice,
        value,
        identity,
        ...(causeRevision === undefined ? {} : { causeRevision }),
      };
      for (const listener of [...listeners]) listener(event);
    },
    port: {
      id,
      renderer,
      mappings: defaultSceneStateSyncMappings(renderer),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      apply,
    },
  };
  return api;
}

function applyApplicationState(state, delivery) {
  state[delivery.envelope.slice] = delivery.envelope.value;
}

function zoomToHeight(zoom) {
  return 40_000_000 / 2 ** zoom;
}
function heightToZoom(height) {
  return Math.max(0, Math.min(22, Math.log2(40_000_000 / Math.max(1, height))));
}
