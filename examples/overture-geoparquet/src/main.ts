import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "@honua/sdk-js/contract";
import { GeoparquetRuntime, createBrowserDuckDbDriver, geoparquetResolver } from "@honua/sdk-js/geoparquet";

import {
  type CloudNativeAnalysisPlanReceipt,
  cloudNativeAnalysisQuery,
  explainCloudNativeAnalysis,
} from "./cloud-native-analysis.js";
import { OverturePlanRejectedError, parseAoi, planOvertureQuery } from "./planner.js";
import { fixtureRangeEvidence, probeAwsRanges } from "./range-evidence.js";
import { FIXTURE_MANIFEST, OVERTURE_POLICY, SOURCE_MANIFESTS } from "./source-manifests.js";
import type {
  Bbox,
  OvertureExecutionEvidence,
  OvertureLane,
  OverturePlaceRow,
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

interface ExplorerApi {
  ready: boolean;
  running: boolean;
  status: string;
  lastCount: number;
  engineStartCount: number;
  parquetRuntime?: ParquetRuntimeProof;
  lastEvidence?: OvertureExecutionEvidence;
  runQuery(lane?: OvertureLane, aoi?: Bbox): Promise<void>;
  cancel(): void;
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
  readonly rows: readonly OverturePlaceRow[];
  readonly range: OvertureRangeEvidence;
  readonly estimatedResultBytes: number;
  readonly queryPlan: CloudNativeAnalysisPlanReceipt;
}

const resultCache = new Map<string, CachedResult>();
let fixtureBytesPromise: Promise<Uint8Array> | undefined;
let activeAbort: AbortController | undefined;
let activeRuntime: GeoparquetRuntime | undefined;
let executionGeneration = 0;

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
      : "Required CI uses a 1.9 KB committed fixture, self-hosted DuckDB-WASM, bbox predicates, and no cross-origin requests.",
  );
}

function renderPlan(plan: OvertureQueryPlan): void {
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
  text("#metric-cache-key", abbreviatedKey(plan.cacheKey));
  text("#metric-range-plan", plan.rangeReadPlan.replaceAll("-", " "));
  text("#plan-warning", plan.warning);
  text("#plan-json", JSON.stringify(plan, null, 2));
}

function renderEvidence(evidence: OvertureExecutionEvidence): void {
  const manifest = SOURCE_MANIFESTS[evidence.plan.lane];
  const object = evidence.plan.selectedObjects[0];
  text("#evidence-release", `${manifest.release} / ${manifest.schemaVersion}`);
  text("#evidence-object", object?.objectKey ?? "-");
  text("#evidence-stac", manifest.stacUrl ?? "Repository fixture manifest");
  text(
    "#evidence-version",
    `${evidence.range.etag ?? object?.etag ?? "-"} · ${evidence.range.lastModified ?? object?.lastModified ?? "-"}`,
  );
  text("#evidence-observed", new Date(evidence.range.observedAt).toLocaleString());
  text("#evidence-ranges", `${number(evidence.range.bytes)} bytes / ${evidence.range.ranges} range(s)`);
  text("#evidence-rows", `${number(evidence.rowsScanned)} / ${number(evidence.rowsReturned)}`);
  text("#evidence-pruning", number(evidence.rowGroupsPruned));
  text(
    "#evidence-memory",
    `${number(evidence.estimatedResultBytes)} / ${number(evidence.plan.maxResultBytes)} JS result bytes · ${evidence.plan.memoryLimitMiB} MiB DuckDB ceiling`,
  );
  text("#timing-sdk", milliseconds(evidence.timing.sdkPlanMs));
  text("#timing-network", milliseconds(evidence.timing.sourceProbeMs));
  text("#timing-engine", milliseconds(evidence.timing.engineExecutionMs));
  text("#timing-render", milliseconds(evidence.timing.renderMs));
  text("#range-limitation", evidence.range.limitation);
  text("#attribution", manifest.attribution);
  text("#cache-badge", evidence.cacheStatus === "hit" ? "Result cache hit" : evidence.range.cacheStatus);
}

function clearResults(): void {
  element<HTMLTableSectionElement>("#result-body").replaceChildren();
  element<SVGGElement>("#result-points").replaceChildren();
  text("#result-summary", "0 rows");
  text("#render-progress", "0 rendered");
}

async function renderRows(rows: readonly OverturePlaceRow[], aoi: Bbox, generation: number): Promise<number> {
  if (generation !== executionGeneration) throw new DOMException("Rendering was cancelled.", "AbortError");
  const started = performance.now();
  clearResults();
  const body = element<HTMLTableSectionElement>("#result-body");
  const points = element<SVGGElement>("#result-points");
  for (let offset = 0; offset < rows.length; offset += OVERTURE_POLICY.renderBatchSize) {
    if (generation !== executionGeneration) throw new DOMException("Rendering was cancelled.", "AbortError");
    const batch = rows.slice(offset, offset + OVERTURE_POLICY.renderBatchSize);
    const tableFragment = document.createDocumentFragment();
    const pointFragment = document.createDocumentFragment();
    for (const row of batch) {
      const tr = document.createElement("tr");
      for (const value of [
        row.id,
        row.name,
        row.category,
        row.confidence.toFixed(2),
        `${row.longitude.toFixed(4)}, ${row.latitude.toFixed(4)}`,
      ]) {
        const td = document.createElement("td");
        td.textContent = String(value);
        tr.append(td);
      }
      tableFragment.append(tr);
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("class", "place-point");
      circle.setAttribute("cx", String(((row.longitude - aoi[0]) / (aoi[2] - aoi[0])) * 800));
      circle.setAttribute("cy", String(400 - ((row.latitude - aoi[1]) / (aoi[3] - aoi[1])) * 400));
      circle.setAttribute("r", "6");
      circle.setAttribute("aria-label", `${row.name}, ${row.category}`);
      pointFragment.append(circle);
    }
    body.append(tableFragment);
    points.append(pointFragment);
    const rendered = Math.min(offset + batch.length, rows.length);
    text("#render-progress", `${rendered} rendered`);
    text("#result-summary", `${rendered} / ${rows.length} rows · GERS ids preserved`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (generation !== executionGeneration) throw new DOMException("Rendering was cancelled.", "AbortError");
  return performance.now() - started;
}

function normalizeFeature(attributes: Record<string, unknown>): OverturePlaceRow {
  const bbox = asRecord(attributes.bbox);
  const names = asRecord(attributes.names);
  const categories = asRecord(attributes.categories);
  const longitude = midpoint(bbox?.xmin, bbox?.xmax);
  const latitude = midpoint(bbox?.ymin, bbox?.ymax);
  return {
    id: String(attributes.id ?? "unknown"),
    name: String(attributes.name ?? names?.primary ?? "Unnamed place"),
    category: String(attributes.category ?? categories?.primary ?? "uncategorized"),
    confidence: typeof attributes.confidence === "number" ? attributes.confidence : 0,
    longitude,
    latitude,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function midpoint(min: unknown, max: unknown): number {
  return typeof min === "number" && typeof max === "number" ? (min + max) / 2 : 0;
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
): Promise<{
  rows: OverturePlaceRow[];
  engineMs: number;
  estimatedResultBytes: number;
  parquetRuntime?: ParquetRuntimeProof;
  queryPlan: CloudNativeAnalysisPlanReceipt;
}> {
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
  const engineStarted = performance.now();
  try {
    if (plan.lane === "fixture") await runtime.registerFileBuffer(FIXTURE_NAME, (await fixtureBytes(signal)).slice());
    await runtime.query(
      `SET memory_limit='${plan.memoryLimitMiB}MB'; SET threads=1; SET preserve_insertion_order=false;`,
      {
        signal,
      },
    );
    const parquetRuntime = plan.lane === "fixture" ? await probeParquetFunctions(runtime, signal) : undefined;
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
    const queryPlan = explainCloudNativeAnalysis(plan, SOURCE_MANIFESTS[plan.lane], source.descriptor);
    const rows: OverturePlaceRow[] = [];
    const encoder = new TextEncoder();
    let estimatedResultBytes = 2;
    for await (const page of source.stream(cloudNativeAnalysisQuery(plan, signal))) {
      for (const feature of page.features) {
        if (rows.length >= plan.limit) throw new Error("Engine exceeded the declared row limit.");
        const row = normalizeFeature(feature.attributes);
        const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (rows.length === 0 ? 0 : 1);
        if (estimatedResultBytes + rowBytes > plan.maxResultBytes) {
          throw new Error(`Result exceeded the declared ${plan.maxResultBytes}-byte JavaScript output ceiling.`);
        }
        rows.push(row);
        estimatedResultBytes += rowBytes;
      }
    }
    return { rows, engineMs: performance.now() - engineStarted, estimatedResultBytes, parquetRuntime, queryPlan };
  } finally {
    await runtime.dispose();
    if (activeRuntime === runtime) activeRuntime = undefined;
    void range;
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
  const initialLane = new URLSearchParams(location.search).get("lane") === "live" ? "live" : "fixture";
  laneSelect.value = initialLane;
  renderLane(initialLane);

  const api: ExplorerApi = {
    ready: false,
    running: false,
    status: "ready",
    lastCount: 0,
    engineStartCount: 0,
    async runQuery(laneOverride, aoiOverride) {
      executionGeneration += 1;
      const generation = executionGeneration;
      activeAbort?.abort();
      const abort = new AbortController();
      activeAbort = abort;
      const supersededRuntime = activeRuntime;
      await supersededRuntime?.dispose().catch(() => undefined);
      if (generation !== executionGeneration || abort.signal.aborted) return;
      const lane = laneOverride ?? (laneSelect.value as OvertureLane);
      renderLane(lane);
      api.running = true;
      api.status = "planning";
      runButton.disabled = true;
      cancelButton.disabled = false;
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
            category: categorySelect.value,
            limit: Number.parseInt(limitInput.value, 10),
          },
          OVERTURE_POLICY,
        );
        const sdkPlanMs = performance.now() - planStarted;
        planned = plan;
        observedSdkPlanMs = sdkPlanMs;
        renderPlan(plan);
        const cached = resultCache.get(plan.cacheKey);
        let rows: readonly OverturePlaceRow[];
        let range: OvertureRangeEvidence;
        let engineExecutionMs = 0;
        let estimatedResultBytes = 0;
        let queryPlan: CloudNativeAnalysisPlanReceipt;
        const cacheStatus = cached ? "hit" : "miss";
        if (cached) {
          rows = cached.rows;
          range = { ...cached.range, durationMs: 0, cacheStatus: "result cache hit" };
          estimatedResultBytes = cached.estimatedResultBytes;
          queryPlan = cached.queryPlan;
        } else {
          api.status = "probing-source";
          text("#engine-state", lane === "live" ? "Verifying AWS range support" : "Loading bounded fixture");
          const bytes = lane === "fixture" ? await fixtureBytes(abort.signal) : undefined;
          range =
            lane === "fixture"
              ? fixtureRangeEvidence(bytes?.byteLength ?? 0)
              : await probeAwsRanges(plan.selectedObjects[0]!, {
                  signal: abort.signal,
                  timeoutMs: OVERTURE_POLICY.maxSourceProbeMs,
                });
          if (generation !== executionGeneration || abort.signal.aborted) {
            throw new DOMException("Source preparation was superseded.", "AbortError");
          }
          observedRange = range;
          if (range.status === "unsupported") throw new Error(range.limitation);
          api.status = "executing";
          api.engineStartCount += 1;
          text("#engine-state", "DuckDB worker executing bounded columnar query");
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
          if (generation !== executionGeneration || abort.signal.aborted) {
            throw new DOMException("Execution was superseded.", "AbortError");
          }
          rows = executed.rows;
          engineExecutionMs = executed.engineMs;
          estimatedResultBytes = executed.estimatedResultBytes;
          queryPlan = executed.queryPlan;
          if (executed.parquetRuntime) api.parquetRuntime = executed.parquetRuntime;
          resultCache.set(plan.cacheKey, { rows, range, estimatedResultBytes, queryPlan });
          while (resultCache.size > 3) resultCache.delete(resultCache.keys().next().value!);
        }
        api.status = "rendering";
        text("#engine-state", "Progressively painting bounded result");
        const renderMs = await renderRows(rows, plan.aoi, generation);
        const timing: OvertureTimingEvidence = {
          sdkPlanMs,
          sourceProbeMs: range.durationMs,
          engineExecutionMs,
          renderMs,
          totalMs: performance.now() - totalStarted,
        };
        const evidence: OvertureExecutionEvidence = {
          plan,
          queryPlan,
          range,
          rowsReturned: rows.length,
          rowsScanned: null,
          rowGroupsPruned: null,
          estimatedResultBytes,
          cacheStatus,
          timing,
          status: "completed",
          reason: null,
        };
        api.lastCount = rows.length;
        api.lastEvidence = evidence;
        api.status = "completed";
        renderEvidence(evidence);
        text("#engine-state", "Bounded query complete");
        text("#query-message", `${rows.length} rows returned in ${milliseconds(timing.totalMs)}.`);
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
            estimatedResultBytes: 0,
            cacheStatus: "miss",
            timing,
            status: api.status === "cancelled" ? "cancelled" : "failed",
            reason: message,
          };
          api.lastEvidence = evidence;
          renderEvidence(evidence);
        }
      } finally {
        if (generation === executionGeneration) {
          api.running = false;
          runButton.disabled = false;
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
      runButton.disabled = false;
      cancelButton.disabled = true;
      text("#engine-state", "Cancellation requested");
      text("#query-message", "Cancellation requested; the worker is being terminated and stale batches are ignored.");
    },
  };
  window.__HONUA_OVERTURE__ = api;

  laneSelect.addEventListener("change", () => renderLane(laneSelect.value as OvertureLane));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void api.runQuery();
  });
  cancelButton.addEventListener("click", () => api.cancel());
  await api.runQuery();
  api.ready = true;
}

void bootstrap();
