/**
 * Browser fixture for issue #390 AC#4 / Validation.
 *
 * Drives the golden automatic Source → MapLibre workflow across source
 * strategies against a real MapLibre GL renderer, then exercises the
 * incremental integration surface (selection, filter, popup, realtime
 * feature-state) on the client-materialized geojson-query strategy.
 *
 * Everything is deterministic and network-free for feature data: geojson
 * features are served in-memory, and native tile strategies point at the local
 * fixture origin so any tile fetch resolves locally and fast.
 */

import { PROTOCOL_DEFAULT_CAPABILITIES, capabilities } from "/dist/src/contract/index.js";
import { createFilterRegistry } from "/dist/src/filter-registry/index.js";
import {
  attachAutomaticMapLibreInteractions,
  explainAutomaticSourceToMapLibre,
  mountAutomaticSourceToMapLibre,
} from "/dist/src/map/index.js";
import { explainQuery } from "/dist/src/query-planner/index.js";

const maplibregl = globalThis.maplibregl;

globalThis.__automaticSourceWorkflowDone = false;
globalThis.__automaticSourceWorkflowError = null;
globalThis.__automaticSourceWorkflowResult = null;

void run().catch((error) => {
  globalThis.__automaticSourceWorkflowError =
    error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  globalThis.__automaticSourceWorkflowDone = true;
});

function localUrl(pathname) {
  // Concatenate directly so `{z}/{x}/{y}` tile placeholders survive verbatim
  // (new URL() would percent-encode the braces and break template validation).
  return `${globalThis.location.origin}${pathname}`;
}

async function run() {
  if (!maplibregl) throw new Error("MapLibre GL did not load");
  const map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [] },
    center: [-157.85, 21.3],
    zoom: 10,
    attributionControl: false,
  });
  const mapErrors = [];
  map.on("error", (event) => mapErrors.push(event?.error?.message ?? "map error"));
  await new Promise((resolve, reject) => {
    map.once("load", resolve);
    map.once("error", (event) => reject(event.error));
  });

  const result = {
    ok: false,
    strategies: {},
    interactive: {},
    diagnostics: [],
    mapErrorSample: [],
  };
  // Expose the live reference so partial progress is inspectable on failure.
  globalThis.__automaticSourceWorkflowResult = result;

  // ── Strategy coverage: explain the correct strategy per source shape ────────
  const explainCases = buildExplainCases();
  for (const { name, source, options, expected } of explainCases) {
    const plan = explainAutomaticSourceToMapLibre(source, options);
    result.strategies[name] = {
      selected: plan.selected?.strategy,
      expected,
      match: plan.selected?.strategy === expected,
      cache: plan.cache,
      tileTemplate: plan.source?.tiles?.[0] ?? null,
      diagnosticCodes: plan.diagnostics.map((entry) => entry.code),
    };
  }

  // ── Native cross-strategy mounts on the real renderer ───────────────────────
  for (const { name, source, options } of buildNativeMountCases()) {
    const plan = explainAutomaticSourceToMapLibre(source, options);
    result.strategies[name] = {
      ...result.strategies[name],
      mountSelected: plan.selected?.strategy ?? null,
      mountDiagnostics: plan.candidates.map((entry) => `${entry.strategy}:${entry.eligible}:${entry.reason}`),
    };
    const mounted = await mountAutomaticSourceToMapLibre(map, source, plan, options);
    const mountedSourcePresent = mounted.layerIds.every((layerId) => map.getLayer(layerId) !== undefined);
    const sourcePresent = map.getSource(mounted.sourceId) !== undefined;
    if (name === "wms-raster") await waitForLocalWmsRequest();
    mounted.dispose();
    const cleaned =
      map.getSource(mounted.sourceId) === undefined &&
      mounted.layerIds.every((layerId) => map.getLayer(layerId) === undefined);
    result.strategies[name] = {
      ...result.strategies[name],
      mounted: mountedSourcePresent && sourcePresent,
      disposedClean: cleaned,
    };
  }

  // ── Golden interactive workflow on the geojson-query strategy ────────────────
  const interactive = await drainGeojsonWorkflow(map);
  result.interactive = interactive;

  result.mapErrorSample = mapErrors.slice(0, 5);
  result.ok =
    Object.values(result.strategies).every((entry) => entry.match !== false) &&
    interactive.selectionApplied &&
    interactive.filterApplied &&
    interactive.popupApplied &&
    interactive.realtimeApplied &&
    interactive.disposedLeakFree;

  map.remove();
  globalThis.__automaticSourceWorkflowResult = result;
  globalThis.__automaticSourceWorkflowDone = true;
}

async function waitForLocalWmsRequest() {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const observed = performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.startsWith(`${globalThis.location.origin}/wms?`));
    if (observed) return;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error("MapLibre did not issue the deterministic WMS tile request");
}

async function drainGeojsonWorkflow(map) {
  const descriptor = {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://demo.honua.test/FeatureServer", serviceId: "parcels", layerId: 0 },
    capabilities: capabilities(["query"]),
    attribution: "Honua fixture",
    schema: { primaryKey: "id" },
  };
  const features = [
    feature(1, "active", "Engine 5", [-157.85, 21.3]),
    feature(2, "inactive", "Ladder 2", [-157.86, 21.31]),
    feature(3, "active", "Rescue 9", [-157.84, 21.29]),
  ];
  const source = {
    descriptor,
    capabilities: descriptor.capabilities,
    query: async () => ({ features, exceededTransferLimit: false }),
    queryAll: async () => ({ features, exceededTransferLimit: false }),
  };

  const queryPlan = explainQuery({
    descriptor,
    query: { pagination: { limit: 500 }, returnGeometry: true },
  });
  const plan = explainAutomaticSourceToMapLibre(source, { queryPlan });
  if (plan.selected?.strategy !== "geojson-query")
    throw new Error(`expected geojson-query, got ${plan.selected?.strategy}`);
  const mounted = await mountAutomaticSourceToMapLibre(map, source, plan, { queryPlan });

  const selectionEvents = [];
  const integration = attachAutomaticMapLibreInteractions(map, mounted, {
    onSelectionChange: (ids) => selectionEvents.push([...ids]),
  });

  // Selection → feature-state.
  integration.select(1);
  const selectedState = map.getFeatureState({ source: mounted.sourceId, id: 1 });
  const selectionApplied = selectedState.selected === true && integration.selectedIds.has(1);

  // Popup driven off the current selection.
  const selectedFeature = features.find((entry) => entry.attributes.id === 1);
  const popup = new maplibregl.Popup({ closeButton: false })
    .setLngLat(selectedFeature.geometry.coordinates)
    .setText(`${selectedFeature.attributes.label} — ${selectedFeature.attributes.status}`)
    .addTo(map);
  const popupText = popup.getElement()?.textContent ?? "";
  const popupApplied = popupText.includes("Engine 5");

  // Filter via a bound filter registry (incremental setFilter, no reload).
  const registry = createFilterRegistry();
  integration.bindFilterRegistry(registry, { sourceId: descriptor.id });
  registry.upsert({
    id: "status",
    owner: { kind: "control", id: "status-picker" },
    field: "status",
    operator: "=",
    value: "active",
  });
  const pointLayerId = mounted.layerIds.find((id) => id.endsWith("point")) ?? mounted.layerIds[0];
  const layerFilter = map.getFilter(pointLayerId);
  const filterApplied = integration.appliedFilter !== undefined && JSON.stringify(layerFilter).includes("status");

  // Realtime feature-state delta (incremental).
  integration.applyRealtimeFeatureState([{ id: 2, state: { status: "responding" } }]);
  const realtimeState = map.getFeatureState({ source: mounted.sourceId, id: 2 });
  const realtimeApplied = realtimeState.status === "responding";

  // Hit-test wiring resolves without throwing.
  const hit = await integration.hitTest({ point: [200, 200] });
  const hitTestRan = Array.isArray(hit.features);

  // Refresh flows edits through setData incrementally.
  await integration.refresh();

  // Lifecycle cleanup: no leaked feature-state, listeners, or map objects.
  popup.remove();
  integration.dispose();
  // Feature-state is cleared while the source still exists (before the mount is
  // torn down), so read it here rather than after the source is removed.
  const stateAfterDispose = map.getFeatureState({ source: mounted.sourceId, id: 1 }) ?? {};
  mounted.dispose();
  const disposedLeakFree =
    map.getSource(mounted.sourceId) === undefined &&
    mounted.layerIds.every((layerId) => map.getLayer(layerId) === undefined) &&
    stateAfterDispose.selected !== true;

  return {
    layerCount: mounted.layerIds.length,
    layerIds: mounted.layerIds,
    selectionApplied,
    selectionEvents,
    popupApplied,
    popupText,
    filterApplied,
    appliedFilter: integration.appliedFilter ?? null,
    layerFilter,
    realtimeApplied,
    realtimeState,
    hitTestRan,
    disposedLeakFree,
    diagnosticCodes: integration.diagnostics.map((entry) => entry.code),
  };
}

function buildExplainCases() {
  return [
    {
      name: "vector-tiles",
      expected: "vector-tiles",
      source: nativeSource("maplibre-vector", { url: localUrl("/tiles/{z}/{x}/{y}.pbf") }),
      options: { sourceLayer: "parcels" },
    },
    {
      name: "native-raster-tiles",
      expected: "native-raster-tiles",
      source: nativeSource("maplibre-raster", { url: localUrl("/tiles/{z}/{x}/{y}.png") }),
      options: {},
    },
    {
      name: "wms-raster",
      expected: "wms-raster",
      source: nativeSource("wms", { url: localUrl("/wms"), typeName: "parcels" }),
      options: {},
    },
    {
      name: "wmts-raster",
      expected: "wmts-raster",
      source: nativeSource("wmts", { url: localUrl("/wmts"), typeName: "imagery", tileMatrixSetId: "WebMercatorQuad" }),
      options: {},
    },
    {
      name: "pmtiles-vector",
      expected: "pmtiles-vector",
      source: nativeSource("pmtiles", { url: "https://cdn.honua.test/basemap.pmtiles" }),
      options: { pmtilesType: "vector", sourceLayer: "land" },
    },
    {
      name: "pmtiles-raster",
      expected: "pmtiles-raster",
      source: nativeSource("pmtiles", { url: "https://cdn.honua.test/imagery.pmtiles" }),
      options: { pmtilesType: "raster" },
    },
    {
      name: "dynamic-query-tiles",
      expected: "dynamic-query-tiles",
      source: nativeSource("maplibre-vector", { url: localUrl("/static/{z}/{x}/{y}.pbf") }),
      options: {
        sourceLayer: "parcels",
        queryTileSource: {
          type: "vector",
          tiles: [localUrl("/query-tiles/{z}/{x}/{y}.mvt")],
          bounds: [-158, 21, -157, 22],
        },
      },
    },
  ];
}

function buildNativeMountCases() {
  // Strategies MapLibre understands natively (no extra protocol registration).
  return [
    {
      name: "vector-tiles",
      source: nativeSource("maplibre-vector", { url: localUrl("/tiles/{z}/{x}/{y}.pbf") }),
      options: { sourceLayer: "parcels", sourceId: "mount-vector", layerId: "mount-vector-features" },
    },
    {
      name: "native-raster-tiles",
      source: nativeSource("maplibre-raster", { url: localUrl("/tiles/{z}/{x}/{y}.png") }),
      options: { sourceId: "mount-raster", layerId: "mount-raster-raster" },
    },
    {
      name: "wms-raster",
      source: nativeSource("wms", { url: localUrl("/wms"), typeName: "parcels" }),
      options: { sourceId: "mount-wms", layerId: "mount-wms-raster" },
    },
    {
      name: "dynamic-query-tiles",
      source: nativeSource("maplibre-vector", { url: localUrl("/static/{z}/{x}/{y}.pbf") }),
      options: {
        sourceLayer: "parcels",
        sourceId: "mount-dynamic",
        layerId: "mount-dynamic-features",
        queryTileSource: {
          type: "vector",
          tiles: [localUrl("/query-tiles/{z}/{x}/{y}.mvt")],
          bounds: [-158, 21, -157, 22],
        },
      },
    },
  ];
}

function nativeSource(protocol, locator) {
  const descriptor = {
    id: `${protocol}-source`,
    protocol,
    locator,
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES[protocol],
    attribution: "Honua fixture",
  };
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    query: async () => ({ features: [], exceededTransferLimit: false }),
    queryAll: async () => ({ features: [], exceededTransferLimit: false }),
  };
}

function feature(id, status, label, coordinates) {
  return { attributes: { id, status, label }, geometry: { type: "Point", coordinates } };
}
