import "maplibre-gl/dist/maplibre-gl.css";

import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "@honua/sdk-js/contract";
import { GeoparquetRuntime, createBrowserDuckDbDriver, geoparquetResolver } from "@honua/sdk-js/geoparquet";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";

import {
  type CloudNativeEngineIdentity,
  cloudNativeAnalysisCacheIdentity,
  runCloudNativeAnalysis,
} from "./cloud-native-analysis.js";
import {
  type CloudNativeLinkedAnalysisArtifactV1,
  type CloudNativeLinkedPresentationReceiptV1,
  type LinkedAnalysisSelectionController,
  createCloudNativeLinkedArtifact,
  createCloudNativePresentationReceipt,
  createLinkedAnalysisSelection,
  linkedAnalysisViewportBounds,
} from "./linked-analysis-workflow.js";
import { OverturePlanRejectedError, parseAoi, planOvertureQuery } from "./planner.js";
import { fixtureRangeEvidence, probeAwsRanges } from "./range-evidence.js";
import { FIXTURE_MANIFEST, OVERTURE_POLICY, SOURCE_MANIFESTS } from "./source-manifests.js";
import type {
  Bbox,
  OvertureExecutionEvidence,
  OvertureLane,
  OvertureQueryPlan,
  OvertureRangeEvidence,
  OvertureTimingEvidence,
} from "./types.js";

import "./styles.css";

const MODULE_URL = import.meta.url;

function distributionUrl(path: string): string {
  return new URL(`../${path}`, MODULE_URL).href;
}

const FIXTURE_URL = distributionUrl("overture-places.parquet");
const FIXTURE_NAME = "overture-places.parquet";
const DUCKDB_BUNDLE = {
  mainModule: distributionUrl("duckdb/duckdb-eh.wasm"),
  mainWorker: distributionUrl("duckdb/duckdb-browser-eh.worker.js"),
};
const DUCKDB_ENGINE_IDENTITY: CloudNativeEngineIdentity = Object.freeze({
  name: "duckdb-wasm",
  version: "v1.4.3",
  verification: "caller-declared",
  cacheScope: "execution-only",
});
const MAP_SOURCE_ID = "linked-analysis-result";
const MAP_LAYER_ID = "linked-analysis-points";
const EMPTY_MAP_DATA = { type: "FeatureCollection" as const, features: [] };

type WorkflowState = "idle" | "loading" | "ready" | "empty" | "degraded" | "error" | "cancelled";

interface ExplorerApi {
  ready: boolean;
  running: boolean;
  status: string;
  workflowState: WorkflowState;
  readonly rendererState: "degraded";
  readonly selectedId: string | null;
  readonly mapReady: boolean;
  readonly mapViewport: [[number, number], [number, number]] | undefined;
  lastCount: number;
  engineStartCount: number;
  parquetRuntime?: ParquetRuntimeProof;
  lastEvidence?: OvertureExecutionEvidence;
  lastArtifact?: CloudNativeLinkedAnalysisArtifactV1;
  lastPresentation?: CloudNativeLinkedPresentationReceiptV1;
  runQuery(lane?: OvertureLane, aoi?: Bbox, category?: string, limit?: number): Promise<void>;
  cancel(): void;
  tightenPolicy(): Promise<void>;
  selectFeature(featureId: string): void;
}

interface ParquetRuntimeProof {
  readonly duckDbVersion: string;
  readonly parquetScanRows: number;
  readonly readParquetRows: number;
}

declare global {
  interface Window {
    __HONUA_OVERTURE__?: ExplorerApi;
  }
}

interface CachedResult {
  readonly artifact: CloudNativeLinkedAnalysisArtifactV1;
  readonly range: OvertureRangeEvidence;
  readonly parquetRuntime?: ParquetRuntimeProof;
}

const resultCache = new Map<string, CachedResult>();
let fixtureBytesPromise: Promise<Uint8Array> | undefined;
let activeAbort: AbortController | undefined;
let activeRuntime: GeoparquetRuntime | undefined;
let executionGeneration = 0;
let workflowState: WorkflowState = "idle";
let resultMap: MapLibreMap | undefined;
let mapReady = false;
let mapSelectedId: string | null = null;
let currentArtifact: CloudNativeLinkedAnalysisArtifactV1 | undefined;
let selection: LinkedAnalysisSelectionController | undefined;
let unsubscribeSelection: (() => void) | undefined;

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

function text(selector: string, value: string): void {
  element<HTMLElement>(selector).textContent = value;
}

function number(value: number | null): string {
  return value === null ? "not exposed" : new Intl.NumberFormat("en-US").format(value);
}

function milliseconds(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function abbreviatedKey(value: string): string {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function fixtureBytes(signal?: AbortSignal): Promise<Uint8Array> {
  fixtureBytesPromise ??= fetch(FIXTURE_URL).then(async (response) => {
    if (!response.ok) throw new Error(`Fixture request failed with HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  });
  if (!signal) return fixtureBytesPromise;
  if (signal.aborted) throw signal.reason ?? new DOMException("Fixture load aborted.", "AbortError");
  return new Promise<Uint8Array>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Fixture load aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void fixtureBytesPromise?.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function renderLane(lane: OvertureLane): void {
  const badge = element<HTMLElement>("#lane-badge");
  badge.dataset.lane = lane;
  badge.textContent = lane === "live" ? "Approved AWS live lane" : "Deterministic fixture";
  text(
    "#execution-disclosure",
    lane === "live"
      ? "Opt-in live execution uses a pinned Overture STAC item in the public AWS us-west-2 bucket. Range support is verified and full-HTTP fallback is disabled; scheduled evidence observes browser range traffic while engine pruning metrics remain opaque."
      : "Required CI uses a 2.1 KB committed fixture, self-hosted DuckDB-WASM, bbox predicates, and no cross-origin requests.",
  );
}

function renderPlan(plan: OvertureQueryPlan, workflowCacheIdentity: string): void {
  text("#metric-projection", plan.projection.join(", "));
  text("#metric-aoi", plan.aoi.join(", "));
  text(
    "#metric-files",
    `${plan.filesSelected} / ${plan.filesAvailable} via ${
      plan.filePruning === "pinned-stac-manifest-bbox" ? "pinned STAC manifest bbox" : "fixture manifest bbox"
    }`,
  );
  text("#metric-candidate-rows", number(plan.selectedObjectRows));
  text("#metric-row-groups", `${number(plan.selectedObjectRowGroups)} in selected object · pruning unverified`);
  text("#metric-memory-policy", `${plan.memoryLimitMiB} MiB`);
  text(
    "#metric-cache-key",
    `workflow ${abbreviatedKey(workflowCacheIdentity)} · plan ${abbreviatedKey(plan.cacheKey)}`,
  );
  text("#metric-range-plan", plan.rangeReadPlan.replaceAll("-", " "));
  text("#plan-warning", plan.warning);
  text("#plan-json", JSON.stringify(plan, null, 2));
}

function renderEvidence(
  evidence: OvertureExecutionEvidence,
  artifact: CloudNativeLinkedAnalysisArtifactV1,
  presentation: CloudNativeLinkedPresentationReceiptV1,
): void {
  const manifest = SOURCE_MANIFESTS[evidence.plan.lane];
  const object = evidence.plan.selectedObjects[0];
  const originBytes = artifact.execution.io.rangeBytes.value ?? 0;
  const originRanges = artifact.execution.io.rangeRequests.value ?? 0;
  text("#evidence-release", `${manifest.release} / ${manifest.schemaVersion}`);
  text("#evidence-object", object?.objectKey ?? "-");
  text("#evidence-stac", manifest.stacUrl ?? "Repository fixture manifest");
  text(
    "#evidence-version",
    `${evidence.range.etag ?? object?.etag ?? "-"} · ${evidence.range.lastModified ?? object?.lastModified ?? "-"}`,
  );
  text("#evidence-observed", new Date(evidence.range.observedAt).toLocaleString());
  text(
    "#evidence-ranges",
    evidence.cacheStatus === "hit"
      ? `0 bytes / 0 ranges this delivery · origin ${number(originBytes)} bytes / ${originRanges} range(s)`
      : `${number(evidence.range.bytes)} bytes / ${evidence.range.ranges} range(s)`,
  );
  text(
    "#evidence-rows",
    `${metricValue(artifact.execution.rows.scanned)} / ${metricValue(artifact.execution.rows.returned)}`,
  );
  text("#evidence-pruning", metricValue(artifact.execution.pruning.rowGroupsPruned));
  text(
    "#evidence-memory",
    `${number(artifact.materialization.materializedBytes)} / ${number(
      artifact.materialization.policy.maxMaterializedBytes,
    )} linked-view bytes · ${evidence.plan.memoryLimitMiB} MiB DuckDB ceiling`,
  );
  text("#timing-sdk", milliseconds(presentation.timing.delivery.sdkPlanMs));
  text("#timing-network", milliseconds(presentation.timing.delivery.sourceProbeMs));
  text("#timing-engine", milliseconds(presentation.timing.delivery.engineExecutionMs));
  text("#timing-render", milliseconds(presentation.timing.delivery.rendererMs));
  text("#evidence-fidelity", artifact.execution.resultFidelity.fidelity);
  text("#evidence-engine-cache", `${artifact.execution.cache.policy} · ${artifact.execution.cache.scope}`);
  text("#evidence-artifact", artifact.id);
  text("#range-limitation", evidence.range.limitation);
  text("#attribution", manifest.attribution);
  text("#cache-badge", `UI result cache ${evidence.cacheStatus} · engine cache bypass`);
  text("#artifact-json", JSON.stringify(artifact, null, 2));
  text("#presentation-json", JSON.stringify(presentation, null, 2));
}

function metricValue(metric: { readonly fidelity: string; readonly value: unknown }): string {
  return metric.fidelity === "unsupported" || metric.value === null ? "not exposed" : number(Number(metric.value));
}

function renderFailureEvidence(evidence: OvertureExecutionEvidence): void {
  const manifest = SOURCE_MANIFESTS[evidence.plan.lane];
  const object = evidence.plan.selectedObjects[0];
  text("#evidence-release", `${manifest.release} / ${manifest.schemaVersion}`);
  text("#evidence-object", object?.objectKey ?? "-");
  text("#evidence-stac", manifest.stacUrl ?? "Repository fixture manifest");
  text("#evidence-version", evidence.range.objectVersion);
  text("#evidence-observed", evidence.range.observedAt);
  text("#evidence-ranges", `${number(evidence.range.bytes)} bytes / ${evidence.range.ranges} range(s) before stop`);
  text("#evidence-rows", "not materialized");
  text("#evidence-pruning", "not exposed");
  text("#evidence-memory", "no linked artifact accepted");
  text("#timing-sdk", milliseconds(evidence.timing.sdkPlanMs));
  text("#timing-network", milliseconds(evidence.timing.sourceProbeMs));
  text("#timing-engine", milliseconds(evidence.timing.engineExecutionMs));
  text("#timing-render", "0.0 ms");
  text("#evidence-fidelity", "no accepted result");
  text("#evidence-engine-cache", "bypass · execution-only");
  text("#evidence-artifact", "none");
  text("#range-limitation", evidence.reason ?? evidence.range.limitation);
  text("#attribution", manifest.attribution);
  text("#cache-badge", "No artifact cached");
}

function setWorkflowState(state: WorkflowState): void {
  workflowState = state;
  const badge = element<HTMLElement>("#analysis-state");
  badge.dataset.state = state;
  badge.textContent = state === "degraded" ? "Degraded data" : `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
  for (const region of document.querySelectorAll<HTMLElement>("[data-analysis-region]")) {
    region.setAttribute("aria-busy", String(state === "loading"));
  }
  const error = element<HTMLElement>("#query-error");
  error.hidden = state !== "error";
}

function clearResults(): void {
  unsubscribeSelection?.();
  unsubscribeSelection = undefined;
  selection?.dispose();
  selection = undefined;
  currentArtifact = undefined;
  mapSelectedId = null;
  element<HTMLTableSectionElement>("#result-body").replaceChildren();
  element<HTMLElement>("#result-chart").replaceChildren();
  element<HTMLElement>("#map-feature-list").replaceChildren();
  text("#selection-title", "No linked selection");
  text("#selection-detail", "Choose a map result, table row, or chart bucket after execution.");
  text("#result-summary", "0 rows");
  text("#render-progress", "0 rendered");
  text("#chart-summary", "0 buckets");
  text("#artifact-json", "No accepted linked artifact.");
  text("#presentation-json", "No presentation receipt.");
  const source = resultMap?.getSource(MAP_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(EMPTY_MAP_DATA);
}

function resetReceiptViews(): void {
  for (const selector of [
    "#metric-projection",
    "#metric-aoi",
    "#metric-files",
    "#metric-candidate-rows",
    "#metric-row-groups",
    "#metric-memory-policy",
    "#metric-cache-key",
    "#metric-range-plan",
  ]) {
    text(selector, "pending");
  }
  text("#plan-warning", "No plan has been accepted for this delivery.");
  text("#plan-json", "No accepted plan.");
  for (const selector of [
    "#evidence-release",
    "#evidence-object",
    "#evidence-stac",
    "#evidence-version",
    "#evidence-observed",
    "#evidence-ranges",
    "#evidence-rows",
    "#evidence-pruning",
    "#evidence-memory",
    "#timing-sdk",
    "#timing-network",
    "#timing-engine",
    "#timing-render",
    "#evidence-fidelity",
  ]) {
    text(selector, "not available");
  }
  text("#evidence-engine-cache", "No accepted execution");
  text("#evidence-artifact", "none");
  text("#range-limitation", "Awaiting bounded source evidence.");
  text("#attribution", "Attribution appears with accepted source evidence.");
  text("#cache-badge", "No UI result-cache delivery");
}

async function initializeMap(): Promise<void> {
  const map = new maplibregl.Map({
    container: "result-map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#081b20" } }],
    },
    center: [-157.95, 21.4],
    zoom: 8,
    attributionControl: false,
  });
  resultMap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  await new Promise<void>((resolve, reject) => {
    const onLoad = () => {
      map.off("error", onError);
      resolve();
    };
    const onError = (event: { readonly error?: Error }) => {
      map.off("load", onLoad);
      reject(event.error ?? new Error("MapLibre failed to initialize."));
    };
    map.once("load", onLoad);
    map.once("error", onError);
  });
  map.addSource(MAP_SOURCE_ID, { type: "geojson", data: EMPTY_MAP_DATA });
  map.addLayer({
    id: MAP_LAYER_ID,
    type: "circle",
    source: MAP_SOURCE_ID,
    paint: {
      "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 10, 7],
      "circle-color": ["case", ["boolean", ["feature-state", "selected"], false], "#ffffff", "#f4d35e"],
      "circle-stroke-color": "#07110f",
      "circle-stroke-width": 2,
    },
  });
  map.on("click", MAP_LAYER_ID, (event) => {
    const id = event.features?.[0]?.id;
    if (typeof id === "string" || typeof id === "number") selectLinkedFeature(String(id));
  });
  map.on("mouseenter", MAP_LAYER_ID, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", MAP_LAYER_ID, () => {
    map.getCanvas().style.cursor = "";
  });
  map.getCanvas().setAttribute("aria-label", "Interactive MapLibre view of the bounded linked result");
  mapReady = true;
}

async function renderArtifact(
  artifact: CloudNativeLinkedAnalysisArtifactV1,
  generation: number,
  signal: AbortSignal,
): Promise<number> {
  assertCurrent(generation, signal);
  const started = performance.now();
  currentArtifact = artifact;
  selection = createLinkedAnalysisSelection(artifact);
  unsubscribeSelection = selection.subscribe((featureId) => renderSelection(featureId));

  const body = element<HTMLTableSectionElement>("#result-body");
  const mapFeatureList = element<HTMLElement>("#map-feature-list");
  const chart = element<HTMLElement>("#result-chart");
  const source = resultMap?.getSource(MAP_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source || !resultMap) throw new Error("MapLibre fallback is not ready.");
  const mapIdle = waitForMapIdle(resultMap, signal);
  source.setData(artifact.map);
  resultMap.fitBounds(linkedAnalysisViewportBounds(artifact), { padding: 32, duration: 0 });

  if (artifact.rows.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-state";
    cell.textContent = "The accepted bounded query returned no rows.";
    row.append(cell);
    body.append(row);
    mapFeatureList.textContent = "No map features in this accepted artifact.";
    chart.textContent = "No chart buckets in this accepted artifact.";
  } else {
    for (let offset = 0; offset < artifact.rows.length; offset += OVERTURE_POLICY.renderBatchSize) {
      assertCurrent(generation, signal);
      const batch = artifact.rows.slice(offset, offset + OVERTURE_POLICY.renderBatchSize);
      const tableFragment = document.createDocumentFragment();
      const mapFragment = document.createDocumentFragment();
      for (const row of batch) {
        const tr = document.createElement("tr");
        tr.dataset.featureId = row.id;
        tr.setAttribute("aria-selected", "false");
        const nameCell = document.createElement("td");
        const rowButton = document.createElement("button");
        rowButton.type = "button";
        rowButton.className = "row-selection";
        rowButton.dataset.featureId = row.id;
        rowButton.setAttribute("aria-pressed", "false");
        rowButton.textContent = row.name;
        rowButton.addEventListener("click", () => selectLinkedFeature(row.id));
        nameCell.append(rowButton);
        tr.append(nameCell);
        for (const value of [
          row.category,
          row.confidence.toFixed(2),
          `${row.longitude.toFixed(4)}`,
          `${row.latitude.toFixed(4)}`,
        ]) {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        tableFragment.append(tr);

        const mapButton = document.createElement("button");
        mapButton.type = "button";
        mapButton.className = "map-result-button";
        mapButton.dataset.featureId = row.id;
        mapButton.setAttribute("aria-pressed", "false");
        mapButton.textContent = row.name;
        mapButton.addEventListener("click", () => selectLinkedFeature(row.id));
        mapFragment.append(mapButton);
      }
      body.append(tableFragment);
      mapFeatureList.append(mapFragment);
      const rendered = Math.min(offset + batch.length, artifact.rows.length);
      text("#render-progress", `${rendered} rendered`);
      text("#result-summary", `${rendered} / ${artifact.rows.length} rows · one artifact`);
      await nextFrame();
    }

    const maximum = Math.max(...artifact.chart.map((bucket) => bucket.count));
    for (const bucket of artifact.chart) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chart-bucket";
      button.dataset.category = bucket.category;
      button.dataset.featureId = bucket.featureIds[0];
      button.setAttribute("aria-pressed", "false");
      button.setAttribute(
        "aria-label",
        `${bucket.category}: ${bucket.count} place${bucket.count === 1 ? "" : "s"}, average confidence ${bucket.averageConfidence.toFixed(2)}`,
      );
      button.innerHTML = `<span>${escapeHtml(bucket.category)}</span><strong>${bucket.count}</strong><i style="--bucket-width:${Math.max(
        8,
        (bucket.count / maximum) * 100,
      )}%"></i><small>avg ${bucket.averageConfidence.toFixed(2)}</small>`;
      button.addEventListener("click", () => {
        const featureId = button.dataset.featureId;
        if (featureId) selectLinkedFeature(featureId);
      });
      chart.append(button);
    }
  }
  text("#chart-summary", `${artifact.chart.length} bucket${artifact.chart.length === 1 ? "" : "s"}`);
  await mapIdle;
  assertCurrent(generation, signal);
  renderSelection(null);
  return performance.now() - started;
}

function selectLinkedFeature(featureId: string): void {
  selection?.select(featureId);
}

function renderSelection(featureId: string | null): void {
  const artifact = currentArtifact;
  if (!artifact) return;
  const row = featureId ? artifact.rows.find((candidate) => candidate.id === featureId) : undefined;
  for (const item of document.querySelectorAll<HTMLElement>("[data-feature-id]")) {
    const selected = featureId !== null && item.dataset.featureId === featureId;
    if (item.matches("tr")) item.setAttribute("aria-selected", String(selected));
    if (item.matches("button")) item.setAttribute("aria-pressed", String(selected));
  }
  for (const bucket of document.querySelectorAll<HTMLButtonElement>(".chart-bucket")) {
    bucket.setAttribute("aria-pressed", String(Boolean(row && bucket.dataset.category === row.category)));
  }
  if (resultMap) {
    if (mapSelectedId) resultMap.setFeatureState({ source: MAP_SOURCE_ID, id: mapSelectedId }, { selected: false });
    if (featureId) resultMap.setFeatureState({ source: MAP_SOURCE_ID, id: featureId }, { selected: true });
  }
  mapSelectedId = featureId;
  text("#selection-title", row?.name ?? "No linked selection");
  text(
    "#selection-detail",
    row
      ? `${row.id} · ${row.category} · confidence ${row.confidence.toFixed(2)} · ${row.longitude.toFixed(4)}, ${row.latitude.toFixed(4)}`
      : "Choose a map result, table row, or chart bucket after execution.",
  );
}

function assertCurrent(generation: number, signal: AbortSignal): void {
  if (generation !== executionGeneration || signal.aborted) {
    throw signal.reason ?? new DOMException("Linked rendering was superseded.", "AbortError");
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitForMapIdle(map: MapLibreMap, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Map rendering was aborted.", "AbortError"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timeout);
      map.off("idle", idle);
      signal.removeEventListener("abort", abort);
    };
    const idle = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Map rendering was aborted.", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("MapLibre did not reach an idle state within the bounded renderer deadline."));
    }, 5_000);
    map.once("idle", idle);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requiredRowCount(rows: readonly Record<string, unknown>[], tableFunction: string): number {
  const value = rows[0]?.row_count;
  const count = typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(count)) {
    throw new Error(`DuckDB ${tableFunction} capability probe did not return a safe row count.`);
  }
  return count;
}

async function probeParquetFunctions(runtime: GeoparquetRuntime, signal: AbortSignal): Promise<ParquetRuntimeProof> {
  const versionRows = await runtime.query('SELECT version() AS "duckdb_version"', { signal });
  const scanRows = await runtime.query(`SELECT count(*)::INTEGER AS "row_count" FROM parquet_scan('${FIXTURE_NAME}')`, {
    signal,
  });
  const readRows = await runtime.query(`SELECT count(*)::INTEGER AS "row_count" FROM read_parquet('${FIXTURE_NAME}')`, {
    signal,
  });
  const duckDbVersion = versionRows[0]?.duckdb_version;
  if (typeof duckDbVersion !== "string" || duckDbVersion.length === 0) {
    throw new Error("DuckDB capability probe did not return an engine version.");
  }
  const parquetScanRows = requiredRowCount(scanRows, "parquet_scan");
  const readParquetRows = requiredRowCount(readRows, "read_parquet");
  if (parquetScanRows !== FIXTURE_MANIFEST.totalRows || readParquetRows !== FIXTURE_MANIFEST.totalRows) {
    throw new Error(
      `Parquet capability probe expected ${FIXTURE_MANIFEST.totalRows} fixture rows; ` +
        `parquet_scan returned ${parquetScanRows} and read_parquet returned ${readParquetRows}.`,
    );
  }
  return { duckDbVersion, parquetScanRows, readParquetRows };
}

async function executePlan(
  plan: OvertureQueryPlan,
  range: OvertureRangeEvidence,
  signal: AbortSignal,
): Promise<{ readonly artifact: CloudNativeLinkedAnalysisArtifactV1; readonly parquetRuntime?: ParquetRuntimeProof }> {
  const runtime = new GeoparquetRuntime({
    driverFactory: ({ signal: initializationSignal } = { signal }) =>
      createBrowserDuckDbDriver({
        signal: initializationSignal,
        bundle: DUCKDB_BUNDLE,
        extensionRepository: distributionUrl("duckdb/extensions"),
        preloadExtensions: ["parquet"],
        loadSpatial: false,
        logLevel: "ERROR",
        filesystem: { reliableHeadRequests: true, allowFullHttpReads: OVERTURE_POLICY.allowFullHttpReads },
      }),
  });
  activeRuntime = runtime;
  try {
    if (plan.lane === "fixture") await runtime.registerFileBuffer(FIXTURE_NAME, (await fixtureBytes(signal)).slice());
    await runtime.query(
      `SET memory_limit='${plan.memoryLimitMiB}MB'; SET threads=1; SET preserve_insertion_order=false;`,
      { signal },
    );
    const parquetRuntime = plan.lane === "fixture" ? await probeParquetFunctions(runtime, signal) : undefined;
    if (parquetRuntime && parquetRuntime.duckDbVersion !== DUCKDB_ENGINE_IDENTITY.version) {
      throw new Error(
        `DuckDB runtime ${parquetRuntime.duckDbVersion} does not match the ${DUCKDB_ENGINE_IDENTITY.version} cache identity.`,
      );
    }
    const resolver = geoparquetResolver({ runtime });
    const dataset = createDataset({
      id: `overture-${plan.lane}`,
      client: {} as never,
      skipCompatibilityCheck: true,
      capabilityPolicy: "degraded",
      resolveSource: resolver,
      sources: [
        {
          id: "places",
          protocol: "geoparquet",
          locator: {
            url: plan.lane === "fixture" ? FIXTURE_NAME : (plan.selectedObjects[0]?.url ?? ""),
            geoparquet: {
              geometryColumn: "geometry",
              geometryEncoding: plan.lane === "fixture" ? "native" : "wkb",
              bboxColumn: "bbox",
            },
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
        },
      ],
    });
    const source = dataset.source<Record<string, unknown>>("places");
    if (!source) throw new Error("GeoParquet source resolution failed.");
    const run = await runCloudNativeAnalysis({
      workflowPlan: plan,
      manifest: SOURCE_MANIFESTS[plan.lane],
      range,
      source,
      runtime,
      engineIdentity: DUCKDB_ENGINE_IDENTITY,
      signal,
    });
    return { artifact: createCloudNativeLinkedArtifact(run), parquetRuntime };
  } finally {
    await runtime.dispose();
    if (activeRuntime === runtime) activeRuntime = undefined;
  }
}

async function bootstrap(): Promise<void> {
  const form = element<HTMLFormElement>("#query-form");
  const laneSelect = element<HTMLSelectElement>("#lane");
  const categorySelect = element<HTMLSelectElement>("#category");
  const aoiInput = element<HTMLInputElement>("#aoi");
  const limitInput = element<HTMLInputElement>("#row-limit");
  const runButton = element<HTMLButtonElement>("#run-query");
  const cancelButton = element<HTMLButtonElement>("#cancel-query");
  const tightenButton = element<HTMLButtonElement>("#tighten-policy");
  const initialLane = new URLSearchParams(location.search).get("lane") === "live" ? "live" : "fixture";
  laneSelect.value = initialLane;
  renderLane(initialLane);
  setWorkflowState("loading");
  await initializeMap();

  const api: ExplorerApi = {
    ready: false,
    running: false,
    status: "ready",
    workflowState: "idle",
    get rendererState() {
      return "degraded" as const;
    },
    get selectedId() {
      return selection?.selectedId ?? null;
    },
    get mapReady() {
      return mapReady;
    },
    get mapViewport() {
      const bounds = resultMap?.getBounds();
      return bounds
        ? ([
            [bounds.getWest(), bounds.getSouth()],
            [bounds.getEast(), bounds.getNorth()],
          ] as [[number, number], [number, number]])
        : undefined;
    },
    lastCount: 0,
    engineStartCount: 0,
    async runQuery(laneOverride, aoiOverride, categoryOverride, limitOverride) {
      executionGeneration += 1;
      const generation = executionGeneration;
      activeAbort?.abort();
      const abort = new AbortController();
      activeAbort = abort;
      const supersededRuntime = activeRuntime;
      await supersededRuntime?.dispose().catch(() => undefined);
      if (generation !== executionGeneration || abort.signal.aborted) return;
      const lane = laneOverride ?? (laneSelect.value as OvertureLane);
      const category = categoryOverride ?? categorySelect.value;
      const limit = limitOverride ?? Number.parseInt(limitInput.value, 10);
      renderLane(lane);
      api.running = true;
      api.status = "planning";
      api.lastCount = 0;
      api.lastEvidence = undefined;
      api.lastArtifact = undefined;
      api.lastPresentation = undefined;
      api.parquetRuntime = undefined;
      runButton.disabled = true;
      tightenButton.disabled = true;
      cancelButton.disabled = false;
      clearResults();
      resetReceiptViews();
      setWorkflowState("loading");
      api.workflowState = workflowState;
      text("#engine-state", "Planning bounded query");
      text("#query-message", "Validating AOI, projection, object selection, and execution budgets.");
      const totalStarted = performance.now();
      const planStarted = performance.now();
      let planned: OvertureQueryPlan | undefined;
      let observedRange: OvertureRangeEvidence | undefined;
      let observedSdkPlanMs = 0;
      let engineStartedAt: number | undefined;
      let engineBudgetExceeded = false;
      try {
        const plan = planOvertureQuery(
          {
            lane,
            aoi: aoiOverride ?? parseAoi(aoiInput.value),
            category,
            limit,
          },
          OVERTURE_POLICY,
        );
        const sdkPlanMs = performance.now() - planStarted;
        planned = plan;
        observedSdkPlanMs = sdkPlanMs;
        const artifactCacheIdentity = cloudNativeAnalysisCacheIdentity(
          plan,
          SOURCE_MANIFESTS[lane],
          DUCKDB_ENGINE_IDENTITY,
        );
        renderPlan(plan, artifactCacheIdentity);
        const cached = resultCache.get(artifactCacheIdentity);
        let artifact: CloudNativeLinkedAnalysisArtifactV1;
        let range: OvertureRangeEvidence;
        let parquetRuntime: ParquetRuntimeProof | undefined;
        const cacheStatus = cached ? "hit" : "miss";
        if (cached) {
          artifact = cached.artifact;
          range = cached.range;
          parquetRuntime = cached.parquetRuntime;
        } else {
          api.status = "probing-source";
          text("#engine-state", lane === "live" ? "Verifying AWS range support" : "Loading bounded fixture");
          const bytes = lane === "fixture" ? await fixtureBytes(abort.signal) : undefined;
          range =
            lane === "fixture"
              ? fixtureRangeEvidence(plan.selectedObjects[0]!, bytes?.byteLength ?? 0)
              : await probeAwsRanges(plan.selectedObjects[0]!, {
                  signal: abort.signal,
                  timeoutMs: OVERTURE_POLICY.maxSourceProbeMs,
                });
          assertCurrent(generation, abort.signal);
          observedRange = range;
          if (range.status === "unsupported") throw new Error(range.limitation);
          api.status = "executing";
          api.engineStartCount += 1;
          text("#engine-state", "DuckDB worker executing the accepted S1 plan");
          engineStartedAt = performance.now();
          let engineTimer: ReturnType<typeof setTimeout> | undefined;
          const budgetExceeded = new Promise<never>((_resolve, reject) => {
            engineTimer = setTimeout(() => {
              engineBudgetExceeded = true;
              abort.abort();
              void activeRuntime?.dispose();
              reject(new DOMException("DuckDB execution budget exceeded.", "AbortError"));
            }, plan.maxEngineMs);
          });
          const executed = await Promise.race([executePlan(plan, range, abort.signal), budgetExceeded]).finally(() => {
            if (engineTimer) clearTimeout(engineTimer);
          });
          assertCurrent(generation, abort.signal);
          artifact = executed.artifact;
          parquetRuntime = executed.parquetRuntime;
        }
        if (artifact.execution.cache.identity !== artifactCacheIdentity) {
          throw new Error("The accepted artifact cache identity drifted from the reviewed workflow identity.");
        }
        if (!cached) {
          resultCache.set(artifactCacheIdentity, { artifact, range, parquetRuntime });
          while (resultCache.size > 3) resultCache.delete(resultCache.keys().next().value!);
        }
        if (parquetRuntime) api.parquetRuntime = parquetRuntime;
        api.status = "rendering";
        text("#engine-state", "Linking one artifact to MapLibre, table, and chart");
        const renderMs = await renderArtifact(artifact, generation, abort.signal);
        const deliveryWallMs = performance.now() - totalStarted;
        const presentation = createCloudNativePresentationReceipt(artifact, {
          resultCache: cacheStatus,
          rendererMs: renderMs,
          deliveryWallMs,
          renderedRows: artifact.rows.length,
          renderedGeometries: artifact.map.features.length,
          renderedChartBuckets: artifact.chart.length,
        });
        const timing: OvertureTimingEvidence = {
          sdkPlanMs: cacheStatus === "hit" ? 0 : artifact.execution.timing.sdkPlanMs,
          sourceProbeMs: cacheStatus === "hit" ? 0 : artifact.execution.timing.sourceProbeMs,
          engineExecutionMs: cacheStatus === "hit" ? 0 : artifact.execution.timing.engineExecutionMs,
          renderMs,
          totalMs: deliveryWallMs,
        };
        const evidence: OvertureExecutionEvidence = {
          plan,
          queryPlan: artifact.execution.query.plan,
          range,
          rowsReturned: artifact.rows.length,
          rowsScanned: null,
          rowGroupsPruned: null,
          materializedResultBytes: artifact.materialization.sdkResultBytes,
          cacheStatus,
          timing,
          status: "completed",
          reason: null,
        };
        api.lastCount = artifact.rows.length;
        api.lastEvidence = evidence;
        api.lastArtifact = artifact;
        api.lastPresentation = presentation;
        api.status = "completed";
        const acceptedState: WorkflowState = artifact.state;
        setWorkflowState(acceptedState);
        api.workflowState = workflowState;
        renderEvidence(evidence, artifact, presentation);
        text(
          "#engine-state",
          artifact.rows.length === 0 ? "Bounded query complete · empty result" : "Linked analysis ready",
        );
        text(
          "#query-message",
          `${artifact.rows.length} rows linked in ${milliseconds(timing.totalMs)}; renderer fallback is explicit.`,
        );
      } catch (error) {
        if (generation !== executionGeneration) return;
        const aborted = abort.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        api.status = engineBudgetExceeded
          ? "failed"
          : aborted
            ? "cancelled"
            : error instanceof OverturePlanRejectedError
              ? "rejected"
              : "failed";
        const message = engineBudgetExceeded
          ? `Engine exceeded the ${planned?.maxEngineMs ?? OVERTURE_POLICY.maxEngineMs} ms execution budget; the worker was terminated without an application-level full-object retry. Engine transport remained opaque.`
          : error instanceof Error
            ? error.message
            : String(error);
        clearResults();
        setWorkflowState(aborted && !engineBudgetExceeded ? "cancelled" : "error");
        api.workflowState = workflowState;
        text("#query-error-message", message);
        text("#engine-state", aborted && !engineBudgetExceeded ? "Worker query cancelled" : "Execution stopped safely");
        text(
          "#query-message",
          aborted && !engineBudgetExceeded ? "Cancellation acknowledged; stale results were not rendered." : message,
        );
        if (planned && observedRange) {
          const timing: OvertureTimingEvidence = {
            sdkPlanMs: observedSdkPlanMs,
            sourceProbeMs: observedRange.durationMs,
            engineExecutionMs: engineStartedAt ? performance.now() - engineStartedAt : 0,
            renderMs: 0,
            totalMs: performance.now() - totalStarted,
          };
          const evidence: OvertureExecutionEvidence = {
            plan: planned,
            queryPlan: null,
            range: observedRange,
            rowsReturned: 0,
            rowsScanned: null,
            rowGroupsPruned: null,
            materializedResultBytes: 0,
            cacheStatus: "miss",
            timing,
            status: api.status === "cancelled" ? "cancelled" : "failed",
            reason: message,
          };
          api.lastEvidence = evidence;
          renderFailureEvidence(evidence);
        }
      } finally {
        if (generation === executionGeneration) {
          api.running = false;
          runButton.disabled = false;
          tightenButton.disabled = false;
          cancelButton.disabled = true;
          activeAbort = undefined;
        }
      }
    },
    cancel() {
      executionGeneration += 1;
      activeAbort?.abort();
      void activeRuntime?.dispose();
      api.running = false;
      api.status = "cancelled";
      api.lastCount = 0;
      api.lastEvidence = undefined;
      api.lastArtifact = undefined;
      api.lastPresentation = undefined;
      api.parquetRuntime = undefined;
      runButton.disabled = false;
      tightenButton.disabled = false;
      cancelButton.disabled = true;
      clearResults();
      resetReceiptViews();
      setWorkflowState("cancelled");
      api.workflowState = workflowState;
      text("#engine-state", "Cancellation requested");
      text("#query-message", "Cancellation requested; the worker is being terminated and stale batches are ignored.");
    },
    async tightenPolicy() {
      const current = Number.parseInt(limitInput.value, 10);
      limitInput.value = String(current > 25 ? 25 : Math.max(1, Math.floor(current / 2)));
      await api.runQuery();
    },
    selectFeature(featureId) {
      selectLinkedFeature(featureId);
    },
  };
  window.__HONUA_OVERTURE__ = api;

  laneSelect.addEventListener("change", () => renderLane(laneSelect.value as OvertureLane));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void api.runQuery();
  });
  cancelButton.addEventListener("click", () => api.cancel());
  tightenButton.addEventListener("click", () => void api.tightenPolicy());
  window.addEventListener(
    "beforeunload",
    () => {
      executionGeneration += 1;
      activeAbort?.abort();
      selection?.dispose();
      void activeRuntime?.dispose();
      resultMap?.remove();
    },
    { once: true },
  );
  await api.runQuery();
  api.ready = true;
}

void bootstrap();
