import "maplibre-gl/dist/maplibre-gl.css";

import maplibregl, { type GeoJSONSource } from "maplibre-gl";

import {
  createExplorationContext,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "@honua/sdk-js/exploration";
import type { FeatureSelectionTarget } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";
import {
  bindDetailToSelection,
  bindFilterControlsToExploration,
  bindMapExtentToExploration,
  bindMapSelectionToExploration,
  bindQueryProjectionToExploration,
  bindTableSelectionToExploration,
  syncFeatureStateSelection,
  syncMapLayerFilterToExploration,
} from "@honua/sdk-js/interactions";
import type { FeatureStateMap, InteractiveMap, LinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import {
  type RealtimeFeatureEvent,
  type RealtimeFeatureState,
  createRealtimeFeatureStore,
  reconcileRealtimeSelection,
} from "@honua/sdk-js/realtime";

import { HONOLULU_CENTER, INCIDENT_LAYER_ID, INCIDENT_SOURCE_ID, INITIAL_INCIDENTS } from "./fixtures.js";
import {
  applyIncidentProjection,
  createIncidentLayerFilter,
  formatIncidentExtent,
  formatTimestamp,
  incidentFeatureCollection,
  incidentRecords,
  statusLabel,
} from "./projection.js";
import { createFixtureIncidentTransport } from "./realtime-fixture.js";
import type { IncidentFeature, IncidentSummary } from "./types.js";

import "./styles.css";

interface IncidentRuntime {
  ready: boolean;
  mapReady: boolean;
  status: string;
  cursor: string | null;
  visibleIncidentCount: number;
  selectedIncidentId: string | null;
  lastStep: string | null;
  step(): string | null;
  reconnect(): void;
  resume(): void;
  markStale(): void;
  refresh(): void;
}

declare global {
  interface Window {
    __HONUA_INCIDENT_RUNTIME__?: IncidentRuntime;
  }
}

interface MapHandle {
  readonly map: maplibregl.Map;
  readonly layerIds: readonly string[];
}

interface EventLogEntry {
  readonly title: string;
  readonly detail: string;
  readonly timestamp: string;
}

const DEFAULT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#e8edf0",
      },
    },
  ],
};

const eventLog: EventLogEntry[] = [];

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function mapBoundsToHonuaExtent(bounds: maplibregl.LngLatBounds): HonuaExtent {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  return {
    xmin: Math.min(west, east),
    ymin: Math.min(south, north),
    xmax: Math.max(west, east),
    ymax: Math.max(south, north),
    spatialReference: { wkid: 4326 },
  };
}

function createMapExtentSource(map: maplibregl.Map) {
  return {
    current(): HonuaExtent | undefined {
      return mapBoundsToHonuaExtent(map.getBounds());
    },
    subscribe(listener: (extent: HonuaExtent | undefined) => void) {
      const emit = () => listener(mapBoundsToHonuaExtent(map.getBounds()));
      map.on("moveend", emit);
      return {
        remove() {
          map.off("moveend", emit);
        },
      };
    },
  };
}

function incidentBounds(incidents: readonly IncidentFeature[]): maplibregl.LngLatBoundsLike {
  const bounds = new maplibregl.LngLatBounds();
  for (const incident of incidents) bounds.extend([...incident.coordinate] as [number, number]);
  const fallback = [...HONOLULU_CENTER] as [number, number];
  return bounds.isEmpty() ? [fallback, fallback] : bounds;
}

async function createMap(): Promise<MapHandle> {
  const map = new maplibregl.Map({
    container: "map",
    style: DEFAULT_STYLE,
    center: [...HONOLULU_CENTER] as [number, number],
    zoom: 11,
  });

  return await new Promise((resolve, reject) => {
    const onLoad = () => {
      try {
        map.addSource(INCIDENT_SOURCE_ID, {
          type: "geojson",
          data: incidentFeatureCollection(INITIAL_INCIDENTS) as never,
        });
        map.addLayer({
          id: INCIDENT_LAYER_ID,
          source: INCIDENT_SOURCE_ID,
          type: "circle",
          filter: ["==", "$type", "Point"],
          paint: {
            "circle-radius": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              12,
              ["interpolate", ["linear"], ["get", "affectedAssets"], 0, 7, 18, 13],
            ],
            "circle-color": [
              "match",
              ["get", "severity"],
              "critical",
              "#b91c1c",
              "high",
              "#d97706",
              "medium",
              "#2563eb",
              "#0f766e",
            ],
            "circle-opacity": ["case", ["==", ["get", "status"], "resolved"], 0.45, 0.92],
            "circle-stroke-color": ["case", ["boolean", ["feature-state", "selected"], false], "#0f172a", "#ffffff"],
            "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 4, 2],
          },
        });
        map.addLayer({
          id: `${INCIDENT_LAYER_ID}-labels`,
          source: INCIDENT_SOURCE_ID,
          type: "symbol",
          filter: ["==", "$type", "Point"],
          layout: {
            "text-field": ["get", "id"],
            "text-size": 11,
            "text-offset": [0, 1.5],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#0f172a",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.2,
          },
        });
        map.fitBounds(incidentBounds(INITIAL_INCIDENTS), {
          padding: 92,
          duration: 0,
          maxZoom: 12,
        });
        cleanup();
        resolve({ map, layerIds: [INCIDENT_LAYER_ID, `${INCIDENT_LAYER_ID}-labels`] });
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (event: { error?: { message?: string } }) => {
      cleanup();
      reject(new Error(event.error?.message ?? "Map failed to load"));
    };
    const cleanup = () => {
      map.off("load", onLoad);
      map.off("error", onError);
    };
    map.on("load", onLoad);
    map.on("error", onError);
  });
}

function updateMapSource(map: maplibregl.Map, state: RealtimeFeatureState<IncidentFeature>): void {
  const source = map.getSource(INCIDENT_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(incidentFeatureCollection(incidentRecords(state)) as never);
}

function renderConnection(state: RealtimeFeatureState<IncidentFeature>): void {
  const badge = getElement<HTMLElement>("#connection-status");
  badge.dataset.status = state.status;
  badge.textContent = statusLabel(state.status);
  setText("#stream-cursor", state.cursor ?? "-");
  setText("#stream-ignored", String(state.ignoredEventCount));
  setText("#stream-records", String(Object.keys(state.records).length));
  setText("#stream-tombstones", String(Object.keys(state.tombstones).length));
  setText(
    "#stream-watermark",
    state.watermark ?? formatTimestamp(new Date(state.lastEventAt ?? Date.now()).toISOString()),
  );
  setText("#stream-stale-since", state.staleSince ? formatTimestamp(new Date(state.staleSince).toISOString()) : "-");
}

function renderSummary(summary: IncidentSummary, visibleCount: number): void {
  setText("#summary-active", String(summary.active));
  setText("#summary-critical", String(summary.critical));
  setText("#summary-visible", String(visibleCount));
  setText("#summary-eta", `${summary.etaAverage} min`);
}

function renderProjectionState(projection: LinkedViewQueryProjection, visibleCount: number): void {
  setText("#projection-visible-count", String(visibleCount));
  setText("#projection-filter-count", String(Object.keys(projection.filters).length));
  setText("#projection-selection-count", String(projection.selection.length));
  setText("#projection-extent", formatIncidentExtent(projection.extent));
  getElement<HTMLElement>("#query-projection").textContent = JSON.stringify(
    {
      filters: projection.filters,
      extent: projection.extent,
      spatialFilter: projection.spatialFilter,
      selection: projection.selection,
      cursor: window.__HONUA_INCIDENT_RUNTIME__?.cursor,
    },
    null,
    2,
  );
}

function readSelectedIncidentId(selection: ReadonlyArray<FeatureSelectionTarget>): string | undefined {
  const [target] = selection;
  if (!target) return undefined;
  if (isSourceQualifiedSelectionTarget(target)) {
    return target.sourceId === INCIDENT_SOURCE_ID ? String(target.id) : undefined;
  }
  return String(target);
}

function renderIncidentList(
  incidents: readonly IncidentFeature[],
  selectedIncidentId: string | undefined,
  onSelect: (incident: IncidentFeature) => void,
): void {
  const list = getElement<HTMLElement>("#incident-list");
  list.innerHTML = "";

  if (incidents.length === 0) {
    list.innerHTML = '<div class="empty-state">No incidents match the linked context.</div>';
    return;
  }

  for (const incident of incidents) {
    const row = document.createElement("article");
    row.className = "incident-row";
    row.dataset.severity = incident.severity;
    row.dataset.status = incident.status;
    row.dataset.selected = incident.id === selectedIncidentId ? "true" : "false";
    row.innerHTML = `
      <div class="incident-main">
        <span class="severity-dot" data-severity="${escapeHtml(incident.severity)}"></span>
        <div>
          <h3>${escapeHtml(incident.title)}</h3>
          <p>${escapeHtml(incident.id)} / ${escapeHtml(incident.type)} / ${escapeHtml(incident.assignedTo)}</p>
        </div>
      </div>
      <dl class="incident-metrics">
        <div><dt>Status</dt><dd>${escapeHtml(statusLabel(incident.status))}</dd></div>
        <div><dt>ETA</dt><dd>${incident.etaMinutes}m</dd></div>
        <div><dt>Assets</dt><dd>${incident.affectedAssets}</dd></div>
      </dl>
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row-select-button";
    button.textContent = "Open";
    button.dataset.testid = `select-${incident.id}`;
    button.setAttribute("aria-label", `Open ${incident.title}`);
    button.addEventListener("click", () => onSelect(incident));
    row.append(button);
    list.append(row);
  }
}

function setListSelection(incidentId: string | undefined): void {
  document.querySelectorAll<HTMLElement>(".incident-row").forEach((row) => {
    row.dataset.selected =
      row.querySelector<HTMLButtonElement>(".row-select-button")?.dataset.testid === `select-${incidentId}`
        ? "true"
        : "false";
  });
}

function createPopupHtml(incident: IncidentFeature): string {
  return `
    <article class="popup-card">
      <p>${escapeHtml(incident.id)} / ${escapeHtml(statusLabel(incident.severity))}</p>
      <h3>${escapeHtml(incident.title)}</h3>
      <dl>
        <div><dt>Status</dt><dd>${escapeHtml(statusLabel(incident.status))}</dd></div>
        <div><dt>Assigned</dt><dd>${escapeHtml(incident.assignedTo)}</dd></div>
        <div><dt>Updated</dt><dd>${escapeHtml(formatTimestamp(incident.updatedAt))}</dd></div>
      </dl>
    </article>
  `;
}

function renderDetail(incident: IncidentFeature | undefined): void {
  if (!incident) {
    setText("#detail-title", "No selected incident");
    setText("#detail-subtitle", "Selection is empty.");
    setText("#detail-id", "-");
    setText("#detail-status", "-");
    setText("#detail-severity", "-");
    setText("#detail-updated", "-");
    getElement<HTMLElement>("#detail-summary").textContent = "";
    getElement<HTMLElement>("#related-records").innerHTML = '<div class="empty-state">No related records.</div>';
    getElement<HTMLElement>("#attachments").innerHTML = '<div class="empty-state">No attachments.</div>';
    return;
  }

  setText("#detail-title", incident.title);
  setText("#detail-subtitle", `${incident.type} / ${incident.assignedTo}`);
  setText("#detail-id", incident.id);
  setText("#detail-status", statusLabel(incident.status));
  setText("#detail-severity", statusLabel(incident.severity));
  setText("#detail-updated", formatTimestamp(incident.updatedAt));
  getElement<HTMLElement>("#detail-summary").textContent = incident.summary;
  getElement<HTMLElement>("#related-records").innerHTML = incident.relatedRecords
    .map(
      (record) => `
        <div class="linked-record">
          <strong>${escapeHtml(record.label)}</strong>
          <span>${escapeHtml(record.id)} / ${escapeHtml(record.status)}</span>
        </div>
      `,
    )
    .join("");
  getElement<HTMLElement>("#attachments").innerHTML = incident.attachments
    .map(
      (attachment) => `
        <div class="linked-record">
          <strong>${escapeHtml(attachment.name)}</strong>
          <span>${escapeHtml(attachment.id)} / ${escapeHtml(attachment.kind)}</span>
        </div>
      `,
    )
    .join("");
}

function pushEventLog(event: RealtimeFeatureEvent<IncidentFeature> | undefined): void {
  if (!event) return;
  const timestamp = formatTimestamp(new Date(event.receivedAt ?? Date.now()).toISOString());
  eventLog.unshift({
    title: eventTitle(event),
    detail: eventDetail(event),
    timestamp,
  });
  eventLog.splice(12);
}

function renderEventLog(): void {
  const log = getElement<HTMLElement>("#event-log");
  log.innerHTML = eventLog
    .map(
      (entry) => `
        <li>
          <span>${escapeHtml(entry.timestamp)}</span>
          <strong>${escapeHtml(entry.title)}</strong>
          <p>${escapeHtml(entry.detail)}</p>
        </li>
      `,
    )
    .join("");
}

function eventTitle(event: RealtimeFeatureEvent<IncidentFeature>): string {
  switch (event.type) {
    case "snapshot":
      return "Snapshot";
    case "upsert":
      return "Live upsert";
    case "delete":
      return "Archive";
    case "delta":
      return "Delta";
    case "heartbeat":
      return "Heartbeat";
    case "status":
      return `Status: ${statusLabel(event.status)}`;
    case "error":
      return "Stream error";
  }
}

function eventDetail(event: RealtimeFeatureEvent<IncidentFeature>): string {
  switch (event.type) {
    case "snapshot":
      return `${event.features.length} feature(s), replace=${event.replace ?? true}`;
    case "upsert":
      return `${event.feature.feature.id} ${statusLabel(event.feature.feature.status)}`;
    case "delete":
      return String(event.id);
    case "delta":
      return `${event.upserts?.length ?? 0} upsert(s), ${event.deletes?.length ?? 0} delete(s)`;
    case "heartbeat":
      return event.cursor ?? "No cursor";
    case "status":
      return event.cursor ?? "Connection state changed";
    case "error":
      return event.error instanceof Error ? event.error.message : String(event.error);
  }
}

function setFieldFilter(
  controls: ReturnType<typeof bindFilterControlsToExploration>,
  id: string,
  field: keyof Pick<IncidentFeature, "severity" | "status" | "type">,
  value: string,
): void {
  if (!value) {
    controls.clearFilter(id);
    return;
  }
  controls.setFilter(id, {
    field,
    operator: "=",
    value,
    appliesTo: [INCIDENT_SOURCE_ID],
  });
}

async function bootstrap(): Promise<void> {
  const overlay = getElement<HTMLElement>("#map-overlay");
  const severityFilter = getElement<HTMLSelectElement>("#severity-filter");
  const statusFilter = getElement<HTMLSelectElement>("#status-filter");
  const typeFilter = getElement<HTMLSelectElement>("#type-filter");
  const stepButton = getElement<HTMLButtonElement>("#step-event");
  const reconnectButton = getElement<HTMLButtonElement>("#reconnect-stream");
  const resumeButton = getElement<HTMLButtonElement>("#resume-stream");
  const staleButton = getElement<HTMLButtonElement>("#mark-stale");
  const refreshButton = getElement<HTMLButtonElement>("#manual-refresh");

  const runtime: IncidentRuntime = {
    ready: false,
    mapReady: false,
    status: "idle",
    cursor: null,
    visibleIncidentCount: 0,
    selectedIncidentId: null,
    lastStep: null,
    step: () => null,
    reconnect: () => undefined,
    resume: () => undefined,
    markStale: () => undefined,
    refresh: () => undefined,
  };
  window.__HONUA_INCIDENT_RUNTIME__ = runtime;

  try {
    const { map, layerIds } = await createMap();
    const store = createRealtimeFeatureStore<IncidentFeature>();
    const transport = createFixtureIncidentTransport();
    const context = createExplorationContext({
      datasetId: "honua-cloud-incident-operations",
      sourceIds: [INCIDENT_SOURCE_ID],
      preset: "globalLinked",
    });
    const mapView = context.connectView({ id: "incident-map", role: "map" });
    const tableView = context.connectView({ id: "incident-table", role: "grid" });
    const filterView = context.connectView({ id: "incident-filters", role: "filter" });
    const detailView = context.connectView({ id: "incident-detail", role: "detail" });
    const filterControls = bindFilterControlsToExploration(filterView);
    const tableSelection = bindTableSelectionToExploration(tableView);
    const removableHandles = [
      syncFeatureStateSelection(map as unknown as FeatureStateMap, mapView, { source: INCIDENT_SOURCE_ID }),
      bindMapSelectionToExploration(map as unknown as InteractiveMap, mapView, {
        source: INCIDENT_SOURCE_ID,
        layer: INCIDENT_LAYER_ID,
      }),
      bindMapExtentToExploration(mapView, createMapExtentSource(map), {
        publishSpatialFilter: true,
      }),
      syncMapLayerFilterToExploration(
        {
          setFilter(layerId, filter) {
            map.setFilter(layerId, filter as never);
          },
        },
        mapView,
        {
          layerId: INCIDENT_LAYER_ID,
          translate: createIncidentLayerFilter,
        },
      ),
      syncMapLayerFilterToExploration(
        {
          setFilter(layerId, filter) {
            map.setFilter(layerId, filter as never);
          },
        },
        mapView,
        {
          layerId: `${INCIDENT_LAYER_ID}-labels`,
          translate: createIncidentLayerFilter,
        },
      ),
    ];
    const unsubscribeHandles: Array<() => void> = [];
    let latestProjection: LinkedViewQueryProjection | undefined;
    let selectedIncidentId: string | undefined;
    let activePopup: maplibregl.Popup | undefined;

    function currentIncidentById(id: string | undefined): IncidentFeature | undefined {
      if (!id) return undefined;
      return incidentRecords(store.state).find((incident) => incident.id === id);
    }

    function renderProjectedIncidents(projection: LinkedViewQueryProjection): void {
      latestProjection = projection;
      const projected = applyIncidentProjection(store.state, projection);
      renderSummary(projected.summary, projected.incidents.length);
      renderProjectionState(projection, projected.incidents.length);
      renderIncidentList(projected.incidents, selectedIncidentId, (incident) => {
        tableSelection.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, incident.id)], { replace: true });
      });
      runtime.visibleIncidentCount = projected.incidents.length;
    }

    function renderSelectedIncident(incidentId: string | undefined): void {
      selectedIncidentId = incidentId;
      runtime.selectedIncidentId = incidentId ?? null;
      setListSelection(incidentId);
      const incident = currentIncidentById(incidentId);
      renderDetail(incident);
      activePopup?.remove();
      activePopup = undefined;
      if (incident) {
        activePopup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          maxWidth: "320px",
        })
          .setLngLat([...incident.coordinate] as [number, number])
          .setHTML(createPopupHtml(incident))
          .addTo(map);
      }
    }

    store.subscribe(
      (state, event) => {
        renderConnection(state);
        updateMapSource(map, state);
        pushEventLog(event);
        renderEventLog();
        reconcileRealtimeSelection(tableView, state, { requireLiveRecord: false });
        runtime.status = state.status;
        runtime.cursor = state.cursor ?? null;
        if (latestProjection) renderProjectedIncidents(latestProjection);
        renderSelectedIncident(selectedIncidentId);
      },
      { fireImmediately: true },
    );

    unsubscribeHandles.push(
      bindDetailToSelection(detailView, (selection) => {
        renderSelectedIncident(readSelectedIncidentId(selection));
      }),
      bindQueryProjectionToExploration(tableView, renderProjectedIncidents, {
        includeSelf: true,
        sourceId: INCIDENT_SOURCE_ID,
      }),
    );

    severityFilter.addEventListener("change", () => {
      setFieldFilter(filterControls, "severity", "severity", severityFilter.value);
    });
    statusFilter.addEventListener("change", () => {
      setFieldFilter(filterControls, "status", "status", statusFilter.value);
    });
    typeFilter.addEventListener("change", () => {
      setFieldFilter(filterControls, "type", "type", typeFilter.value);
    });
    stepButton.addEventListener("click", () => {
      const step = transport.step();
      runtime.lastStep = step?.label ?? null;
      setText("#last-scenario-step", step ? step.label : "No live step");
    });
    reconnectButton.addEventListener("click", () => transport.reconnect());
    resumeButton.addEventListener("click", () => transport.resume());
    staleButton.addEventListener("click", () => {
      const lastLiveAt = store.state.lastHeartbeatAt ?? store.state.lastEventAt ?? Date.now();
      store.checkStale({ staleAfterMs: 1_000, now: lastLiveAt + 1_500 });
    });
    refreshButton.addEventListener("click", () => transport.refresh());

    runtime.step = () => {
      const step = transport.step();
      runtime.lastStep = step?.label ?? null;
      setText("#last-scenario-step", step ? step.label : "No live step");
      return runtime.lastStep;
    };
    runtime.reconnect = () => transport.reconnect();
    runtime.resume = () => transport.resume();
    runtime.markStale = () => {
      const lastLiveAt = store.state.lastHeartbeatAt ?? store.state.lastEventAt ?? Date.now();
      store.checkStale({ staleAfterMs: 1_000, now: lastLiveAt + 1_500 });
    };
    runtime.refresh = () => transport.refresh();

    for (const layerId of layerIds) {
      map.on("mouseenter", layerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
      });
    }

    store.connect(transport, {
      sourceId: INCIDENT_SOURCE_ID,
      layerId: INCIDENT_LAYER_ID,
      metadata: {
        demo: "realtime-incident-dashboard",
        channel: "fixture-backed-honua-cloud",
      },
    });

    tableSelection.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, INITIAL_INCIDENTS[0].id)], {
      replace: true,
    });
    overlay.dataset.state = "ready";
    overlay.textContent = "Live incident stream connected";
    runtime.ready = true;
    runtime.mapReady = true;

    window.addEventListener("beforeunload", () => {
      for (const unsubscribe of unsubscribeHandles) unsubscribe();
      for (const handle of removableHandles) handle.remove();
      context.dispose();
      store.close();
      activePopup?.remove();
      map.remove();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    overlay.dataset.state = "error";
    overlay.textContent = message;
    setText("#connection-status", "Error");
    window.__HONUA_INCIDENT_RUNTIME__ = {
      ...runtime,
      ready: false,
      status: "error",
    };
  }
}

void bootstrap();
