import { HonuaClient } from "/dist/src/honua.js";

import { createExampleConfig, loadRouteSource, normalizeRoutePlaybackSource } from "./data-path.mjs";

const Cesium = globalThis.Cesium;
const PLAYBACK_CLOCK_MULTIPLIER = 8;

const elements = {
  resultBanner: document.querySelector("#result-banner"),
  statusLine: document.querySelector("#status-line"),
  sourceChip: document.querySelector("#source-chip"),
  terrainChip: document.querySelector("#terrain-chip"),
  diagnosticsList: document.querySelector("#diagnostics-list"),
  dataPath: document.querySelector("#data-path"),
  warningsList: document.querySelector("#warnings-list"),
  progressValue: document.querySelector("#progress-value"),
  progressBar: document.querySelector("#progress-bar"),
  playButton: document.querySelector("#play-button"),
  pauseButton: document.querySelector("#pause-button"),
  replayButton: document.querySelector("#replay-button"),
};

const controller = {
  viewer: null,
  playbackWindow: null,
  tickHandle: null,
};

globalThis.__cesiumRoutePlaybackDone = false;
globalThis.__cesiumRoutePlaybackError = null;
globalThis.__cesiumRoutePlaybackResult = null;

void main();

async function main() {
  if (!Cesium) {
    failExample(new Error("Cesium failed to load from the local Build/Cesium bundle."));
    return;
  }

  try {
    const config = createExampleConfig(window.location.search);
    setBanner("Loading fixture and viewer state...");

    const source = await loadRouteSource(config, { HonuaClient });
    const route = normalizeRoutePlaybackSource(source, config);
    const terrainState = await createTerrainState(config);
    const displayRoute = await applyDisplayHeights(route, terrainState);
    const warnings = [...terrainState.warnings, ...displayRoute.warnings];

    const viewer = createViewer(terrainState.terrainProvider);
    controller.viewer = viewer;
    controller.playbackWindow = addRouteEntities(viewer, route, displayRoute);
    bindPlaybackControls(viewer, controller.playbackWindow);
    renderDiagnostics(route, source, displayRoute, terrainState, warnings);
    updatePlaybackStatus(viewer, route);

    const result = buildResultSummary(route, source, displayRoute, terrainState, warnings, viewer);
    globalThis.__cesiumRoutePlaybackResult = result;
    globalThis.__cesiumRoutePlaybackDone = true;
    setBanner(`Ready: ${route.routeName}`);
  } catch (error) {
    failExample(error);
  }
}

function createViewer(terrainProvider) {
  const viewer = new Cesium.Viewer("map", {
    animation: false,
    baseLayer: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    projectionPicker: false,
    sceneModePicker: false,
    selectionIndicator: false,
    terrainProvider,
    timeline: false,
    requestRenderMode: true,
    shouldAnimate: false,
  });

  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#030b15");
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0f2238");
  viewer.scene.globe.enableLighting = terrainProvider instanceof Cesium.EllipsoidTerrainProvider === false;
  viewer.scene.globe.depthTestAgainstTerrain = terrainProvider instanceof Cesium.EllipsoidTerrainProvider === false;
  viewer.scene.requestRender();

  return viewer;
}

async function createTerrainState(config) {
  const warnings = [];

  if (config.terrainUrl) {
    try {
      const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(config.terrainUrl);
      return {
        terrainEnabled: true,
        terrainMode: "terrain-url",
        terrainProvider,
        warnings,
      };
    } catch (error) {
      warnings.push(`Terrain URL fallback: ${describeError(error)}`);
    }
  }

  if (config.ionToken) {
    try {
      Cesium.Ion.defaultAccessToken = config.ionToken;
      const terrainProvider = await Cesium.createWorldTerrainAsync();
      return {
        terrainEnabled: true,
        terrainMode: "ion-world-terrain",
        terrainProvider,
        warnings,
      };
    } catch (error) {
      warnings.push(`Cesium ion terrain fallback: ${describeError(error)}`);
    }
  }

  return {
    terrainEnabled: false,
    terrainMode: "ellipsoid",
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    warnings,
  };
}

async function applyDisplayHeights(route, terrainState) {
  if (!terrainState.terrainEnabled) {
    return {
      heightMode: route.hasZ ? "source-z-unverified" : "ellipsoid-zero",
      playbackSamples: route.playbackSamples,
      processingStep: route.hasZ
        ? "Rendered source Z values directly. Height units remain unverified."
        : "Rendered the route on the ellipsoid with a 0 meter fallback height.",
      warnings: [],
    };
  }

  try {
    const cartographics = route.positions.map((position) =>
      Cesium.Cartographic.fromDegrees(position.longitude, position.latitude),
    );
    const sampled = await Cesium.sampleTerrainMostDetailed(terrainState.terrainProvider, cartographics);
    const playbackSamples = route.playbackSamples.map((sample, index) => {
      const terrainHeight = Number.isFinite(sampled[index]?.height) ? sampled[index].height : 0;
      return {
        ...sample,
        terrainHeight,
        heightMeters: terrainHeight,
      };
    });

    return {
      heightMode: "terrain",
      playbackSamples,
      processingStep: route.hasZ
        ? "Sampled external terrain for display heights and kept source Z values for diagnostics only."
        : "Sampled external terrain for display heights.",
      warnings: [],
    };
  } catch (error) {
    return {
      heightMode: route.hasZ ? "source-z-unverified" : "ellipsoid-zero",
      playbackSamples: route.playbackSamples,
      processingStep: route.hasZ
        ? "Terrain sampling failed; fell back to rendering source Z values directly."
        : "Terrain sampling failed; fell back to an ellipsoid height of 0 meters.",
      warnings: [`Terrain sampling fallback: ${describeError(error)}`],
    };
  }
}

function addRouteEntities(viewer, route, displayRoute) {
  const positions = Cesium.Cartesian3.fromDegreesArrayHeights(
    displayRoute.playbackSamples.flatMap((sample) => [
      sample.longitude,
      sample.latitude,
      sample.heightMeters,
    ]),
  );

  const routeEntity = viewer.entities.add({
    id: "route-line",
    name: route.routeName,
    polyline: {
      positions,
      width: 6,
      clampToGround: false,
      material: Cesium.Color.fromCssColorString("#46d6a7"),
    },
  });

  const startSample = displayRoute.playbackSamples[0];
  const endSample = displayRoute.playbackSamples[displayRoute.playbackSamples.length - 1];
  viewer.entities.add(createMarkerEntity("route-start", "Start", startSample, "#8df7d2"));
  viewer.entities.add(createMarkerEntity("route-end", "Finish", endSample, "#ffbf6f"));

  const sampledPosition = new Cesium.SampledPositionProperty();
  for (const sample of displayRoute.playbackSamples) {
    sampledPosition.addSample(
      Cesium.JulianDate.fromDate(new Date(sample.timestampMs)),
      Cesium.Cartesian3.fromDegrees(sample.longitude, sample.latitude, sample.heightMeters),
    );
  }

  const movingEntity = viewer.entities.add({
    id: "route-asset",
    name: `${route.routeName} asset`,
    position: sampledPosition,
    orientation: new Cesium.VelocityOrientationProperty(sampledPosition),
    point: {
      pixelSize: 15,
      color: Cesium.Color.fromCssColorString("#ff8b3d"),
      outlineColor: Cesium.Color.fromCssColorString("#fff2d8"),
      outlineWidth: 2,
    },
    path: {
      width: 3,
      leadTime: 0,
      trailTime: Math.max(1, route.playbackDurationSeconds),
      material: Cesium.Color.fromCssColorString("#ff8b3d").withAlpha(0.85),
    },
    label: {
      text: "Playback asset",
      font: "600 13px sans-serif",
      pixelOffset: new Cesium.Cartesian2(0, -22),
      fillColor: Cesium.Color.fromCssColorString("#fff2d8"),
      outlineColor: Cesium.Color.fromCssColorString("#030b15"),
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    },
  });

  const startTime = Cesium.JulianDate.fromDate(new Date(displayRoute.playbackSamples[0].timestampMs));
  const stopTime = Cesium.JulianDate.fromDate(
    new Date(displayRoute.playbackSamples[displayRoute.playbackSamples.length - 1].timestampMs),
  );

  viewer.clock.startTime = Cesium.JulianDate.clone(startTime);
  viewer.clock.stopTime = Cesium.JulianDate.clone(stopTime);
  viewer.clock.currentTime = Cesium.JulianDate.clone(startTime);
  viewer.clock.multiplier = PLAYBACK_CLOCK_MULTIPLIER;
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
  viewer.zoomTo(routeEntity).catch(() => undefined);
  viewer.scene.requestRender();

  return {
    movingEntity,
    routeEntity,
    startTime,
    stopTime,
  };
}

function createMarkerEntity(id, label, sample, color) {
  return {
    id,
    name: label,
    position: Cesium.Cartesian3.fromDegrees(sample.longitude, sample.latitude, sample.heightMeters),
    point: {
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString(color),
      outlineColor: Cesium.Color.fromCssColorString("#030b15"),
      outlineWidth: 2,
    },
    label: {
      text: label,
      font: "600 12px sans-serif",
      pixelOffset: new Cesium.Cartesian2(0, 18),
      fillColor: Cesium.Color.fromCssColorString("#f2f8ff"),
      outlineColor: Cesium.Color.fromCssColorString("#030b15"),
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    },
  };
}

function bindPlaybackControls(viewer, playbackWindow) {
  const onTick = () => {
    updatePlaybackStatus(viewer);
    viewer.scene.requestRender();
  };

  viewer.clock.onTick.addEventListener(onTick);
  controller.tickHandle = onTick;

  elements.playButton.disabled = false;
  elements.pauseButton.disabled = false;
  elements.replayButton.disabled = false;

  elements.playButton.addEventListener("click", () => {
    viewer.clock.shouldAnimate = true;
    updatePlaybackStatus(viewer);
    viewer.scene.requestRender();
  });

  elements.pauseButton.addEventListener("click", () => {
    viewer.clock.shouldAnimate = false;
    updatePlaybackStatus(viewer);
    viewer.scene.requestRender();
  });

  elements.replayButton.addEventListener("click", () => {
    viewer.clock.currentTime = Cesium.JulianDate.clone(playbackWindow.startTime);
    viewer.clock.shouldAnimate = true;
    updatePlaybackStatus(viewer);
    viewer.scene.requestRender();
  });
}

function updatePlaybackStatus(viewer) {
  if (!controller.playbackWindow) {
    return;
  }

  const { startTime, stopTime } = controller.playbackWindow;
  const elapsedSeconds = Math.max(0, Cesium.JulianDate.secondsDifference(viewer.clock.currentTime, startTime));
  const totalSeconds = Math.max(1, Cesium.JulianDate.secondsDifference(stopTime, startTime));
  const progress = Math.min(1, elapsedSeconds / totalSeconds);

  elements.progressValue.textContent = `${Math.round(progress * 100)}%`;
  elements.progressBar.style.width = `${Math.round(progress * 100)}%`;
  elements.statusLine.textContent = viewer.clock.shouldAnimate
    ? `Playback running at ${viewer.clock.multiplier}x speed`
    : "Playback paused";
}

function renderDiagnostics(route, source, displayRoute, terrainState, warnings) {
  const diagnostics = [
    ["Scenario", "Route playback with elevation context"],
    ["Source mode", source.sourceMode],
    [
      "Source query",
      source.queryRequest
        ? `${source.queryRequest.serviceId}/${source.queryRequest.layerId} where ${source.queryRequest.where}`
        : "checked-in fixture",
    ],
    ["Geometry type", route.geometryType],
    ["Feature count", String(route.featureCount)],
    ["Vertex count", String(route.vertexCount)],
    ["Has source Z", route.hasZ ? "yes" : "no"],
    ["Height mode", displayRoute.heightMode],
    ["Terrain mode", terrainState.terrainMode],
    ["Request duration", formatDuration(source.requestDurationMs)],
    ["Playback distance", `${route.totalDistanceMeters.toFixed(0)} m`],
    ["Playback duration", `${route.playbackDurationSeconds.toFixed(1)} s`],
  ];

  elements.sourceChip.textContent = source.sourceMode === "live" ? "Live Honua query" : "Fixture replay";
  elements.terrainChip.textContent = terrainState.terrainEnabled ? "Terrain enabled" : "Ellipsoid only";

  elements.diagnosticsList.replaceChildren(...diagnostics.map(([label, value]) => createDetailItem(label, value)));
  elements.dataPath.replaceChildren(
    ...[...route.preprocessingSteps, displayRoute.processingStep].map((step) => createListItem(step)),
  );

  if (warnings.length === 0) {
    elements.warningsList.replaceChildren(createListItem("No warnings."));
  } else {
    elements.warningsList.replaceChildren(...warnings.map((warning) => createListItem(warning)));
  }
}

function buildResultSummary(route, source, displayRoute, terrainState, warnings, viewer) {
  return {
    sourceMode: source.sourceMode,
    routeName: route.routeName,
    routeId: route.routeId,
    featureCount: route.featureCount,
    vertexCount: route.vertexCount,
    hasZ: route.hasZ,
    terrainEnabled: terrainState.terrainEnabled,
    terrainMode: terrainState.terrainMode,
    heightMode: displayRoute.heightMode,
    requestDurationMs: source.requestDurationMs,
    preprocessingSteps: [...route.preprocessingSteps, displayRoute.processingStep],
    compatibilitySupported: source.compatibility?.supported ?? null,
    queryRequest: source.queryRequest,
    warnings,
    entityCount: viewer.entities.values.length,
  };
}

function createDetailItem(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "detail-item";

  const term = document.createElement("dt");
  term.textContent = label;

  const description = document.createElement("dd");
  description.textContent = value;

  wrapper.append(term, description);
  return wrapper;
}

function createListItem(text) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

function formatDuration(value) {
  return typeof value === "number" ? `${value.toFixed(1)} ms` : "n/a";
}

function setBanner(text) {
  elements.resultBanner.textContent = text;
}

function failExample(error) {
  const message = describeError(error);
  setBanner("Load failed");
  elements.statusLine.textContent = message;
  elements.warningsList.replaceChildren(createListItem(message));
  globalThis.__cesiumRoutePlaybackError = message;
  globalThis.__cesiumRoutePlaybackDone = true;
  console.error(error);
}

function describeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
