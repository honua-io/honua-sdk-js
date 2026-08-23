import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";

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
import { uniqueValueRenderer } from "@honua/sdk-js/style";

import {
  type IncidentRealtimeDiagnostics,
  initialIncidentRealtimeDiagnostics,
  reconcileIncidentDiagnostics,
  reconcileIncidentReceiptDiagnostics,
} from "./diagnostics.js";
import { HONOLULU_CENTER, INCIDENT_LAYER_ID, INCIDENT_SOURCE_ID, INITIAL_INCIDENTS } from "./fixtures.js";
import { setControlDisabled } from "./focus-safe-controls.js";
import { type IncidentMapLoadTarget, createIncidentLifecycle, initializeIncidentMap } from "./lifecycle.js";
import {
  INCIDENT_METADATA_CACHE_STATE,
  type IncidentLiveStateAuthority,
  evaluateIncidentLiveStateAuthority,
  formatIncidentAuthorityLabel,
  formatIncidentFeatureProvenance,
  formatIncidentMetadataCacheState,
} from "./live-state.js";
import { formatIncidentAccessibleName, presentIncidentConnection } from "./presentation.js";
import {
  applyIncidentProjection,
  createIncidentLayerFilter,
  formatIncidentExtent,
  formatTimestamp,
  incidentFeatureCollection,
  incidentRecords,
  statusLabel,
} from "./projection.js";
import {
  createIncidentRealtimeResumeContext,
  createIncidentRealtimeSession,
  waitForIncidentRealtimeStatus,
} from "./realtime-session.js";
import {
  createIncidentDashboardTransport,
  readIncidentTransportConfig,
  resolveIncidentTransportConfig,
} from "./realtime-transport.js";
import { SAFE_DEMO_INCIDENT_ID, evaluateIncidentMutationGuard } from "./safe-edit.js";
import type { IncidentMutationGuard } from "./safe-edit.js";
import type { IncidentEditReceipt, IncidentEditRequest, IncidentFeature, IncidentSummary } from "./types.js";

import "../../_kit/design/index.css";
import "./styles.css";

interface IncidentRuntime {
  ready: boolean;
  mapReady: boolean;
  disposed: boolean;
  status: string;
  cursor: string | null;
  visibleIncidentCount: number;
  selectedIncidentId: string | null;
  lastStep: string | null;
  step(): Promise<string | null>;
  reconnect(): Promise<void>;
  resume(): Promise<void>;
  markStale(): void;
  refresh(): Promise<void>;
  authoritative: boolean;
  featureProvenance: string;
  metadataCacheStatus: string;
  lane: "live" | "replay" | "fixture-edit" | "pending";
  ignoredEventCount: number;
  reconciliationOutcome: string;
  reconnectOutcome: string;
  lastEditOutcome: string | null;
  stageEdit(): string | null;
  submitEdit(): Promise<string | null>;
  repeatEdit(): Promise<string | null>;
  simulateConflict(): Promise<void>;
  resetEdit(): Promise<string | null>;
  duplicateLast(): Promise<void>;
  reorderLast(): Promise<void>;
  staleCursor(): Promise<void>;
  dispose(): void;
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

const BACKGROUND_LAYER_ID = "background";

/* The basemap is the stage, the incidents are the actors: every canvas color is
 * read from the shared design language's cartography tokens so the map re-keys
 * with the active theme instead of staying a light plate under dark chrome. */
function designToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

const DEFAULT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: BACKGROUND_LAYER_ID,
      type: "background",
      paint: {
        "background-color": designToken("--hn-basemap-land", "#f4f5f1"),
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
  const element = getElement<HTMLElement>(selector);
  if (element.textContent !== value) element.textContent = value;
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

/* Incident severity styling as a first-class renderer object (issue #497).
 * Severity is a status scale, so it paints from the design language's fixed
 * status marks — the same tokens the queue's severity dots and the map legend
 * swatches use, which is what keeps the three in sync. Severity is also spelled
 * out in the queue row, the popup, and the detail rail, so nothing is carried
 * by hue alone. */
function severityRenderer() {
  return uniqueValueRenderer({
    field: "severity",
    values: [
      { value: "critical", color: designToken("--hn-status-critical", "#d03b3b"), label: "Critical" },
      { value: "high", color: designToken("--hn-status-serious", "#ec835a"), label: "High" },
      { value: "medium", color: designToken("--hn-status-warn", "#fab219"), label: "Medium" },
    ],
    defaultColor: designToken("--hn-status-ok", "#0ca30c"),
    defaultLabel: "Low / other",
  });
}

async function createMap(): Promise<MapHandle> {
  const map = new maplibregl.Map({
    container: "map",
    style: DEFAULT_STYLE,
    center: [...HONOLULU_CENTER] as [number, number],
    zoom: 11,
  });

  return await initializeIncidentMap(map as unknown as IncidentMapLoadTarget, () => {
    map.addSource(INCIDENT_SOURCE_ID, {
      type: "geojson",
      data: incidentFeatureCollection(INITIAL_INCIDENTS) as never,
    });
    // The severity match expression compiles from the renderer object
    // instead of being hand-written (issue #497).
    const [severityFragment] = severityRenderer().toMapLibre("point");
    map.addLayer({
      id: INCIDENT_LAYER_ID,
      source: INCIDENT_SOURCE_ID,
      type: "circle",
      filter: ["==", "$type", "Point"],
      paint: {
        ...severityFragment.paint,
        "circle-radius": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          12,
          ["interpolate", ["linear"], ["get", "affectedAssets"], 0, 7, 18, 13],
        ],
        "circle-opacity": ["case", ["==", ["get", "status"], "resolved"], 0.45, 0.92],
        "circle-stroke-color": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          designToken("--hn-accent", "#0b6b4d"),
          designToken("--hn-halo", "#f4f5f1"),
        ],
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
        "text-color": designToken("--hn-basemap-label", "#46554d"),
        "text-halo-color": designToken("--hn-halo", "#f4f5f1"),
        "text-halo-width": 1.2,
      },
    });
    map.fitBounds(incidentBounds(INITIAL_INCIDENTS), {
      padding: 92,
      duration: 0,
      maxZoom: 12,
    });
    return { map, layerIds: [INCIDENT_LAYER_ID, `${INCIDENT_LAYER_ID}-labels`] };
  });
}

function updateMapSource(map: maplibregl.Map, state: RealtimeFeatureState<IncidentFeature>): void {
  const source = map.getSource(INCIDENT_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(incidentFeatureCollection(incidentRecords(state)) as never);
}

function renderConnection(
  state: RealtimeFeatureState<IncidentFeature>,
  authority: IncidentLiveStateAuthority,
  diagnostics: IncidentRealtimeDiagnostics,
  lane: "live" | "replay" | "fixture-edit",
  fallbackReason: string | undefined,
): void {
  renderExecutionState(lane, state.status, authority.authoritative, fallbackReason);
  const badge = getElement<HTMLElement>("#connection-status");
  badge.dataset.status = state.status;
  badge.textContent = statusLabel(state.status);
  const authorityBadge = getElement<HTMLElement>("#live-authority");
  authorityBadge.dataset.authoritative = String(authority.authoritative);
  authorityBadge.textContent = formatIncidentAuthorityLabel(authority);
  setText("#stream-cursor", state.cursor ?? "-");
  setText("#stream-sequence", state.lastSequence === undefined ? "-" : String(state.lastSequence));
  setText("#stream-ignored", String(diagnostics.ignoredEventCount));
  setText("#stream-records", String(Object.keys(state.records).length));
  setText("#stream-tombstones", String(Object.keys(state.tombstones).length));
  setText(
    "#stream-watermark",
    state.watermark ?? formatTimestamp(new Date(state.lastEventAt ?? Date.now()).toISOString()),
  );
  setText("#stream-snapshot-at", formatObservedTime(diagnostics.snapshotAt));
  setText("#stream-observed-at", formatObservedTime(diagnostics.observationAt));
  setText("#stream-event-time", diagnostics.eventTime ? formatTimestamp(diagnostics.eventTime) : "-");
  setText("#stream-lag", diagnostics.lagMs === undefined ? "-" : formatLag(diagnostics.lagMs));
  setText(
    "#stream-reconnect",
    diagnostics.reconnectAttempt > 0
      ? `${statusLabel(diagnostics.reconnectOutcome)} / attempt ${diagnostics.reconnectAttempt}`
      : statusLabel(diagnostics.reconnectOutcome),
  );
  setText("#stream-backoff", diagnostics.retryAfterMs === undefined ? "-" : `${diagnostics.retryAfterMs} ms`);
  setText("#stream-reconciliation", statusLabel(diagnostics.reconciliationOutcome));
  setText("#stream-stale-since", state.staleSince ? formatTimestamp(new Date(state.staleSince).toISOString()) : "-");
  setText("#feature-provenance", formatIncidentFeatureProvenance(authority.featureProvenance));
  setText("#metadata-cache", formatIncidentMetadataCacheState(authority.metadataCache));
}

function formatObservedTime(value: number | undefined): string {
  return value === undefined ? "-" : formatTimestamp(new Date(value).toISOString());
}

function formatLag(value: number): string {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
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
      authoritative: window.__HONUA_INCIDENT_RUNTIME__?.authoritative,
      featureProvenance: window.__HONUA_INCIDENT_RUNTIME__?.featureProvenance,
      metadataCache: window.__HONUA_INCIDENT_RUNTIME__?.metadataCacheStatus,
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
  authority: IncidentLiveStateAuthority,
  onSelect: (incident: IncidentFeature) => void,
): void {
  const list = getElement<HTMLElement>("#incident-list");
  list.innerHTML = "";

  if (incidents.length === 0) {
    list.innerHTML =
      '<div class="empty-state">No incidents match the linked context. Clear a filter or pan the map to widen the extent.</div>';
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
          <span class="severity-label">${escapeHtml(statusLabel(incident.severity))} severity</span>
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
    button.setAttribute("aria-label", formatIncidentAccessibleName(incident));
    button.title = authority.actionsEnabled ? `Open ${incident.title}` : `Open read-only detail. ${authority.reason}`;
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
    setText(
      "#detail-subtitle",
      "Open an incident from the queue or the map to read its status, assignment, and evidence here.",
    );
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
      return [
        event.reason ?? event.cursor ?? "Connection state changed",
        event.reconnectAttempt ? `attempt ${event.reconnectAttempt}` : undefined,
        event.retryAfterMs ? `retry in ${event.retryAfterMs} ms` : undefined,
      ]
        .filter(Boolean)
        .join(" / ");
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

function renderExecutionState(
  lane: "live" | "replay" | "fixture-edit",
  status: RealtimeFeatureState<IncidentFeature>["status"],
  authoritative: boolean,
  fallbackReason: string | undefined,
): void {
  const presentation = presentIncidentConnection(lane, status, authoritative, fallbackReason);
  const badge = getElement<HTMLElement>("#data-lane");
  badge.dataset.lane = lane;
  badge.textContent = presentation.laneLabel;
  setText("#execution-disclosure", presentation.disclosure);
  setText("#fallback-reason", fallbackReason ?? "");
  const overlay = getElement<HTMLElement>("#map-overlay");
  overlay.dataset.state = presentation.overlayState;
  overlay.textContent = presentation.overlay;
}

function authorityForLane(
  state: RealtimeFeatureState<IncidentFeature>,
  lane: "live" | "replay" | "fixture-edit",
): IncidentLiveStateAuthority {
  const authority = evaluateIncidentLiveStateAuthority(state, {
    metadataCache: INCIDENT_METADATA_CACHE_STATE,
  });
  if (lane !== "replay") return authority;
  return {
    ...authority,
    authoritative: false,
    actionsEnabled: false,
    reason: "Scripted replay is read-only and is not authoritative live incident state.",
    featureProvenance: state.checkpoint
      ? { source: "cursor-watermark-replay", checkpoint: state.checkpoint }
      : { source: "unknown", reason: "Replay has not received a checkpoint." },
  };
}

function renderEditReceipt(receipt: IncidentEditReceipt): string {
  const revision = receipt.actualRevision === undefined ? "" : ` Revision ${receipt.actualRevision}.`;
  return `${statusLabel(receipt.outcome)}: ${receipt.reason}${revision}`;
}

function neutralizeRuntimeActions(runtime: IncidentRuntime): void {
  runtime.step = async () => null;
  runtime.reconnect = async () => undefined;
  runtime.resume = async () => undefined;
  runtime.markStale = () => undefined;
  runtime.refresh = async () => undefined;
  runtime.stageEdit = () => null;
  runtime.submitEdit = async () => null;
  runtime.repeatEdit = async () => null;
  runtime.simulateConflict = async () => undefined;
  runtime.resetEdit = async () => null;
  runtime.duplicateLast = async () => undefined;
  runtime.reorderLast = async () => undefined;
  runtime.staleCursor = async () => undefined;
}

/* The design language follows the OS theme; the toggle stamps an explicit
 * override on <html>. Dark mode is a redesign rather than dark chrome over a
 * light canvas, so the map's basemap, halo, selection stroke, and label colors
 * are re-read from the tokens whenever the active theme changes. */
type ThemePreference = "auto" | "light" | "dark";
const THEME_SEQUENCE: readonly ThemePreference[] = ["auto", "light", "dark"];

function setupThemeToggle(
  lifecycle: ReturnType<typeof createIncidentLifecycle>,
  map: maplibregl.Map,
  layerIds: readonly string[],
): void {
  const toggle = getElement<HTMLButtonElement>("#theme-toggle");
  const [circleLayerId, labelLayerId] = layerIds;
  let preference: ThemePreference = "auto";

  const retint = (): void => {
    if (map.getLayer(BACKGROUND_LAYER_ID)) {
      map.setPaintProperty(BACKGROUND_LAYER_ID, "background-color", designToken("--hn-basemap-land", "#f4f5f1"));
    }
    if (circleLayerId && map.getLayer(circleLayerId)) {
      map.setPaintProperty(circleLayerId, "circle-stroke-color", [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        designToken("--hn-accent", "#0b6b4d"),
        designToken("--hn-halo", "#f4f5f1"),
      ]);
    }
    if (labelLayerId && map.getLayer(labelLayerId)) {
      map.setPaintProperty(labelLayerId, "text-color", designToken("--hn-basemap-label", "#46554d"));
      map.setPaintProperty(labelLayerId, "text-halo-color", designToken("--hn-halo", "#f4f5f1"));
    }
  };

  const apply = (): void => {
    if (preference === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = preference;
    toggle.textContent = `Theme: ${preference}`;
    retint();
  };

  const onClick = (): void => {
    preference = THEME_SEQUENCE[(THEME_SEQUENCE.indexOf(preference) + 1) % THEME_SEQUENCE.length] ?? "auto";
    apply();
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = (): void => retint();
  toggle.addEventListener("click", onClick);
  scheme.addEventListener("change", onScheme);
  lifecycle.own(() => {
    toggle.removeEventListener("click", onClick);
    scheme.removeEventListener("change", onScheme);
    delete document.documentElement.dataset.theme;
  });
  apply();
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
  const duplicateButton = getElement<HTMLButtonElement>("#duplicate-event");
  const reorderButton = getElement<HTMLButtonElement>("#reorder-event");
  const staleCursorButton = getElement<HTMLButtonElement>("#stale-cursor");
  const stageEditButton = getElement<HTMLButtonElement>("#stage-edit");
  const submitEditButton = getElement<HTMLButtonElement>("#submit-edit");
  const repeatEditButton = getElement<HTMLButtonElement>("#repeat-edit");
  const simulateConflictButton = getElement<HTMLButtonElement>("#simulate-conflict");
  const resetEditButton = getElement<HTMLButtonElement>("#reset-edit");

  const editStatus = getElement<HTMLSelectElement>("#edit-status");
  const editAssigned = getElement<HTMLInputElement>("#edit-assigned");

  const runtime: IncidentRuntime = {
    ready: false,
    mapReady: false,
    disposed: false,
    status: "idle",
    cursor: null,
    visibleIncidentCount: 0,
    selectedIncidentId: null,
    lastStep: null,
    step: async () => null,
    reconnect: async () => undefined,
    resume: async () => undefined,
    markStale: () => undefined,
    refresh: async () => undefined,
    authoritative: false,
    featureProvenance: "Unknown feature provenance",
    metadataCacheStatus: "Metadata cache not used",
    lane: "pending",
    ignoredEventCount: 0,
    reconciliationOutcome: "waiting-for-snapshot",
    reconnectOutcome: "not-attempted",
    lastEditOutcome: null,
    stageEdit: () => null,
    submitEdit: async () => null,
    repeatEdit: async () => null,
    simulateConflict: async () => undefined,
    resetEdit: async () => null,
    duplicateLast: async () => undefined,
    reorderLast: async () => undefined,
    staleCursor: async () => undefined,
    dispose: () => undefined,
  };
  window.__HONUA_INCIDENT_RUNTIME__ = runtime;
  const lifecycle = createIncidentLifecycle();
  const dispose = () => {
    lifecycle.dispose();
    neutralizeRuntimeActions(runtime);
    runtime.ready = false;
    runtime.mapReady = false;
    runtime.disposed = true;
  };
  const onBeforeUnload = () => dispose();
  runtime.dispose = dispose;
  window.addEventListener("beforeunload", onBeforeUnload, { once: true });
  lifecycle.own(() => window.removeEventListener("beforeunload", onBeforeUnload));

  try {
    const resolvedTransportConfig = await resolveIncidentTransportConfig(readIncidentTransportConfig());
    const { map, layerIds } = await createMap();
    lifecycle.own(() => map.remove());
    setupThemeToggle(lifecycle, map, layerIds);
    const store = createRealtimeFeatureStore<IncidentFeature>();
    lifecycle.own(() => store.close());
    const incidentTransport = createIncidentDashboardTransport(resolvedTransportConfig);
    lifecycle.own(() => incidentTransport.controls.dispose());
    const lane = incidentTransport.controls.mode;
    let diagnostics = initialIncidentRealtimeDiagnostics(lane);
    runtime.lane = lane;
    const context = createExplorationContext({
      datasetId: "honua-cloud-incident-operations",
      sourceIds: [INCIDENT_SOURCE_ID],
      preset: "globalLinked",
    });
    lifecycle.own(() => context.dispose());
    const mapView = context.connectView({ id: "incident-map", role: "map" });
    const tableView = context.connectView({ id: "incident-table", role: "grid" });
    const filterView = context.connectView({ id: "incident-filters", role: "filter" });
    const detailView = context.connectView({ id: "incident-detail", role: "detail" });
    const filterControls = bindFilterControlsToExploration(filterView);
    const tableSelection = bindTableSelectionToExploration(tableView);
    const ownRemovable = <T extends { remove(): void }>(handle: T): T => {
      lifecycle.own(() => handle.remove());
      return handle;
    };
    ownRemovable(syncFeatureStateSelection(map as unknown as FeatureStateMap, mapView, { source: INCIDENT_SOURCE_ID }));
    ownRemovable(
      bindMapSelectionToExploration(map as unknown as InteractiveMap, mapView, {
        source: INCIDENT_SOURCE_ID,
        layer: INCIDENT_LAYER_ID,
      }),
    );
    ownRemovable(
      bindMapExtentToExploration(mapView, createMapExtentSource(map), {
        publishSpatialFilter: true,
      }),
    );
    ownRemovable(
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
    );
    ownRemovable(
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
    );
    let latestProjection: LinkedViewQueryProjection | undefined;
    let selectedIncidentId: string | undefined;
    let activePopup: maplibregl.Popup | undefined;
    lifecycle.own(() => activePopup?.remove());
    let latestAuthority = authorityForLane(store.state, lane);
    let latestMutationGuard: IncidentMutationGuard = {
      enabled: false,
      reason: "Select the isolated demo record to stage an edit.",
    };
    let stagedEdit: IncidentEditRequest | undefined;
    let lastSubmittedEdit: IncidentEditRequest | undefined;
    let idempotencySequence = 0;
    let controlQueue: Promise<void> = Promise.resolve();
    const controlStatusObservation = new AbortController();
    lifecycle.own(() => controlStatusObservation.abort());

    function enqueueControl<T>(operation: () => Promise<T>, disposedValue: T): Promise<T> {
      const result = controlQueue.then(() => (lifecycle.disposed ? disposedValue : operation()));
      controlQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    function reportControlFailure(error: unknown): void {
      if (lifecycle.disposed || (error instanceof Error && error.name === "AbortError")) return;
      setText("#edit-outcome", error instanceof Error ? error.message : "Fixture control action failed.");
    }

    function startControl(operation: Promise<unknown>): void {
      void operation.catch(reportControlFailure);
    }

    function currentIncidentById(id: string | undefined): IncidentFeature | undefined {
      if (!id) return undefined;
      return incidentRecords(store.state).find((incident) => incident.id === id);
    }

    function currentMutationGuard(): IncidentMutationGuard {
      const incident = currentIncidentById(selectedIncidentId);
      return evaluateIncidentMutationGuard({
        lane,
        live: authorityForLane(store.state, lane).authoritative,
        authorized: incidentTransport.controls.authorized,
        safeEditProfile: incidentTransport.controls.safeDemoEditing,
        sourceIdentity: incidentTransport.controls.sourceIdentity,
        incident,
      });
    }

    function admitMutation(): boolean {
      latestMutationGuard = currentMutationGuard();
      if (latestMutationGuard.enabled) return true;
      setText("#edit-outcome", latestMutationGuard.reason);
      return false;
    }

    function updateEditPanel(): void {
      const incident = currentIncidentById(selectedIncidentId);
      latestMutationGuard = currentMutationGuard();
      setText(
        "#edit-profile",
        !incidentTransport.controls.safeDemoEditing
          ? "Unavailable"
          : incidentTransport.controls.authorized
            ? "Isolated + resettable"
            : "Unauthorized",
      );
      setText("#edit-guard-reason", latestMutationGuard.reason);
      setText("#edit-revision", incident?.revision === undefined ? "-" : String(incident.revision));
      setControlDisabled(editStatus, !latestMutationGuard.enabled);
      setControlDisabled(editAssigned, !latestMutationGuard.enabled);
      setControlDisabled(stageEditButton, !latestMutationGuard.enabled);
      setControlDisabled(submitEditButton, !latestMutationGuard.enabled || !stagedEdit);
      setControlDisabled(repeatEditButton, !latestMutationGuard.enabled || !lastSubmittedEdit);
      setControlDisabled(simulateConflictButton, !latestMutationGuard.enabled || !stagedEdit);
      setControlDisabled(resetEditButton, !latestMutationGuard.enabled);
    }

    function stageEdit(): string | null {
      const incident = currentIncidentById(selectedIncidentId);
      if (!admitMutation() || !incident) return null;
      idempotencySequence += 1;
      stagedEdit = {
        incidentId: incident.id,
        expectedRevision: incident.revision ?? 0,
        idempotencyKey: `fixture-edit-${idempotencySequence}`,
        patch: {
          status: editStatus.value as IncidentFeature["status"],
          assignedTo: editAssigned.value.trim() || "Demo Operations",
        },
      };
      setText("#edit-revision", String(stagedEdit.expectedRevision));
      setText("#edit-idempotency", stagedEdit.idempotencyKey);
      setText("#edit-outcome", `Staged against revision ${stagedEdit.expectedRevision}.`);
      setControlDisabled(submitEditButton, false);
      setControlDisabled(simulateConflictButton, false);
      return stagedEdit.idempotencyKey;
    }

    function submitEdit(request = stagedEdit): Promise<string | null> {
      return enqueueControl(async () => {
        if (!request || !admitMutation()) return null;
        const receipt = await incidentTransport.controls.edit(request);
        if (lifecycle.disposed) return null;
        lastSubmittedEdit = request;
        if (stagedEdit === request) stagedEdit = undefined;
        runtime.lastEditOutcome = receipt.outcome;
        setText("#edit-outcome", renderEditReceipt(receipt));
        updateEditPanel();
        return receipt.outcome;
      }, null);
    }

    function repeatEdit(): Promise<string | null> {
      return enqueueControl(async () => {
        if (!lastSubmittedEdit || !admitMutation()) return null;
        const receipt = await incidentTransport.controls.edit(lastSubmittedEdit);
        if (lifecycle.disposed) return null;
        runtime.lastEditOutcome = receipt.outcome;
        setText("#edit-outcome", renderEditReceipt(receipt));
        return receipt.outcome;
      }, null);
    }

    function resetEdit(): Promise<string | null> {
      return enqueueControl(async () => {
        const incident = currentIncidentById(selectedIncidentId);
        if (!incident || !admitMutation()) return null;
        idempotencySequence += 1;
        const receipt = await incidentTransport.controls.reset({
          incidentId: incident.id,
          idempotencyKey: `fixture-reset-${idempotencySequence}`,
        });
        if (lifecycle.disposed) return null;
        runtime.lastEditOutcome = receipt.outcome;
        setText("#edit-idempotency", receipt.idempotencyKey);
        setText("#edit-outcome", renderEditReceipt(receipt));
        updateEditPanel();
        return receipt.outcome;
      }, null);
    }

    function stepScenario(): Promise<string | null> {
      return enqueueControl(async () => {
        const step = await incidentTransport.controls.step();
        if (lifecycle.disposed) return null;
        runtime.lastStep = step?.label ?? null;
        setText("#last-scenario-step", step ? step.label : "No live step");
        return runtime.lastStep;
      }, null);
    }

    function runScenarioAction(action: () => Promise<void>): Promise<void> {
      return enqueueControl(async () => {
        await action();
      }, undefined);
    }

    function runScenarioStatusAction(
      action: () => Promise<void>,
      expectedStatus: RealtimeFeatureState["status"],
    ): Promise<void> {
      return enqueueControl(async () => {
        await action();
        await waitForIncidentRealtimeStatus(store, expectedStatus, {
          signal: controlStatusObservation.signal,
        });
      }, undefined);
    }

    function simulateConflict(): Promise<void> {
      return enqueueControl(async () => {
        if (!admitMutation()) return;
        await incidentTransport.controls.simulateConcurrentUpdate();
        if (lifecycle.disposed) return;
        setText("#edit-outcome", "Concurrent update published. Submit the staged edit to observe a revision conflict.");
      }, undefined);
    }

    function renderProjectedIncidents(projection: LinkedViewQueryProjection): void {
      latestProjection = projection;
      const projected = applyIncidentProjection(store.state, projection);
      renderSummary(projected.summary, projected.incidents.length);
      renderProjectionState(projection, projected.incidents.length);
      renderIncidentList(projected.incidents, selectedIncidentId, latestAuthority, (incident) => {
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
      if (incident?.safeDemoRecord && !stagedEdit) {
        editStatus.value = incident.status;
        editAssigned.value = incident.assignedTo;
      }
      updateEditPanel();
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

    lifecycle.own(
      store.subscribe(
        (state, event) => {
          diagnostics = reconcileIncidentDiagnostics(diagnostics, state, event);
          latestAuthority = authorityForLane(state, lane);
          renderConnection(state, latestAuthority, diagnostics, lane, incidentTransport.controls.fallbackReason);
          updateMapSource(map, state);
          pushEventLog(event);
          renderEventLog();
          reconcileRealtimeSelection(tableView, state, { requireLiveRecord: false });
          runtime.status = state.status;
          runtime.cursor = state.cursor ?? null;
          runtime.authoritative = latestAuthority.authoritative;
          runtime.featureProvenance = formatIncidentFeatureProvenance(latestAuthority.featureProvenance);
          runtime.metadataCacheStatus = formatIncidentMetadataCacheState(latestAuthority.metadataCache);
          runtime.ignoredEventCount = diagnostics.ignoredEventCount;
          runtime.reconciliationOutcome = diagnostics.reconciliationOutcome;
          runtime.reconnectOutcome = diagnostics.reconnectOutcome;
          if (latestProjection) renderProjectedIncidents(latestProjection);
          renderSelectedIncident(selectedIncidentId);
        },
        { fireImmediately: true },
      ),
    );

    lifecycle.own(
      bindDetailToSelection(detailView, (selection) => {
        renderSelectedIncident(readSelectedIncidentId(selection));
      }),
    );
    lifecycle.own(
      bindQueryProjectionToExploration(tableView, renderProjectedIncidents, {
        includeSelf: true,
        sourceId: INCIDENT_SOURCE_ID,
      }),
    );

    const controlListeners = new AbortController();
    lifecycle.own(() => controlListeners.abort());
    const controlListenerOptions = { signal: controlListeners.signal };
    severityFilter.addEventListener(
      "change",
      () => {
        setFieldFilter(filterControls, "severity", "severity", severityFilter.value);
      },
      controlListenerOptions,
    );
    statusFilter.addEventListener(
      "change",
      () => {
        setFieldFilter(filterControls, "status", "status", statusFilter.value);
      },
      controlListenerOptions,
    );
    typeFilter.addEventListener(
      "change",
      () => {
        setFieldFilter(filterControls, "type", "type", typeFilter.value);
      },
      controlListenerOptions,
    );
    stepButton.addEventListener(
      "click",
      () => {
        startControl(stepScenario());
      },
      controlListenerOptions,
    );
    reconnectButton.addEventListener(
      "click",
      () => startControl(runScenarioStatusAction(() => incidentTransport.controls.reconnect(), "reconnecting")),
      controlListenerOptions,
    );
    resumeButton.addEventListener(
      "click",
      () => startControl(runScenarioStatusAction(() => incidentTransport.controls.resume(), "live")),
      controlListenerOptions,
    );
    staleButton.addEventListener(
      "click",
      () => {
        const lastLiveAt = store.state.lastHeartbeatAt ?? store.state.lastEventAt ?? Date.now();
        store.checkStale({ staleAfterMs: 1_000, now: lastLiveAt + 1_500 });
      },
      controlListenerOptions,
    );
    refreshButton.addEventListener(
      "click",
      () => startControl(runScenarioAction(() => incidentTransport.controls.refresh())),
      controlListenerOptions,
    );
    duplicateButton.addEventListener(
      "click",
      () => startControl(runScenarioAction(() => incidentTransport.controls.duplicateLast())),
      controlListenerOptions,
    );
    reorderButton.addEventListener(
      "click",
      () => startControl(runScenarioAction(() => incidentTransport.controls.reorderLast())),
      controlListenerOptions,
    );
    staleCursorButton.addEventListener(
      "click",
      () => startControl(runScenarioAction(() => incidentTransport.controls.staleCursor())),
      controlListenerOptions,
    );
    stageEditButton.addEventListener("click", () => stageEdit(), controlListenerOptions);
    submitEditButton.addEventListener("click", () => startControl(submitEdit()), controlListenerOptions);
    repeatEditButton.addEventListener("click", () => startControl(repeatEdit()), controlListenerOptions);
    simulateConflictButton.addEventListener(
      "click",
      () => {
        startControl(simulateConflict());
      },
      controlListenerOptions,
    );
    resetEditButton.addEventListener("click", () => startControl(resetEdit()), controlListenerOptions);

    const scenarioControlsEnabled = lane !== "live";
    for (const button of [
      stepButton,
      reconnectButton,
      resumeButton,
      staleButton,
      refreshButton,
      duplicateButton,
      reorderButton,
      staleCursorButton,
    ]) {
      button.disabled = !scenarioControlsEnabled;
      if (!scenarioControlsEnabled) button.title = "Scenario controls are available only in deterministic lanes.";
    }

    runtime.step = stepScenario;
    runtime.reconnect = () => runScenarioStatusAction(() => incidentTransport.controls.reconnect(), "reconnecting");
    runtime.resume = () => runScenarioStatusAction(() => incidentTransport.controls.resume(), "live");
    runtime.markStale = () => {
      const lastLiveAt = store.state.lastHeartbeatAt ?? store.state.lastEventAt ?? Date.now();
      store.checkStale({ staleAfterMs: 1_000, now: lastLiveAt + 1_500 });
    };
    runtime.refresh = () => runScenarioAction(() => incidentTransport.controls.refresh());
    runtime.duplicateLast = () => runScenarioAction(() => incidentTransport.controls.duplicateLast());
    runtime.reorderLast = () => runScenarioAction(() => incidentTransport.controls.reorderLast());
    runtime.staleCursor = () => runScenarioAction(() => incidentTransport.controls.staleCursor());
    runtime.stageEdit = stageEdit;
    runtime.submitEdit = () => submitEdit();
    runtime.repeatEdit = repeatEdit;
    runtime.simulateConflict = simulateConflict;
    runtime.resetEdit = resetEdit;

    for (const layerId of layerIds) {
      map.on("mouseenter", layerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
      });
    }

    const realtimeSession = await createIncidentRealtimeSession({
      store,
      transport: incidentTransport.transport,
      request: incidentTransport.request,
      context: createIncidentRealtimeResumeContext(incidentTransport.request, {
        sourceVersion:
          lane === "fixture-edit" ? "incident-operations-fixture/v1" : `${resolvedTransportConfig.sourceIdentity}/v1`,
        schemaVersion: "honua.incident-feature/v1",
        authorizationScopeFingerprint:
          lane === "fixture-edit"
            ? incidentTransport.controls.authorized
              ? "isolated-fixture-edit"
              : "isolated-fixture-read-only"
            : "anonymous-read",
      }),
      onReceipt(receipt) {
        if (lifecycle.disposed || receipt.outcome === "applied") return;
        diagnostics = reconcileIncidentReceiptDiagnostics(diagnostics, store.state, receipt);
        latestAuthority = authorityForLane(store.state, lane);
        renderConnection(store.state, latestAuthority, diagnostics, lane, incidentTransport.controls.fallbackReason);
        runtime.ignoredEventCount = diagnostics.ignoredEventCount;
        runtime.reconciliationOutcome = diagnostics.reconciliationOutcome;
      },
    });
    lifecycle.own(() => realtimeSession.close());
    realtimeSession.connect();

    tableSelection.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, SAFE_DEMO_INCIDENT_ID)], {
      replace: true,
    });
    runtime.ready = true;
    runtime.mapReady = true;
  } catch (error) {
    dispose();
    const message = error instanceof Error ? error.message : String(error);
    overlay.dataset.state = "error";
    overlay.textContent = message;
    setText("#connection-status", "Error");
    runtime.status = "error";
  }
}

void bootstrap();
