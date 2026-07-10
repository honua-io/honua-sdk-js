import { resolveSpatialAggregationWidgetSummary } from "@honua/sdk-js/contract";
import type {
  SpatialAggregationCell,
  SpatialAggregationHistogramValue,
  SpatialAggregationRangeValue,
  SpatialAggregationSummaryValue,
} from "@honua/sdk-js/contract";
import { createAnalysisExecutionCoordinator } from "./execution-coordinator.js";
import { createLinkedAnalysisController, linkedAnalysisConfigFromLocation } from "./linked-analysis.js";
import { createSpatialAnalyticsWorkbenchSession, selectAnalyticsUiModels } from "./model.js";
import type {
  AnalyticsFeature,
  AnalyticsRisk,
  LinkedAnalysisContext,
  LinkedAnalysisLane,
  SpatialAnalyticsWorkbenchSession,
} from "./types.js";

import "./styles.css";

interface SpatialAnalyticsWorkbenchRuntime {
  readonly ready: boolean;
  readonly disposed: boolean;
  readonly visibleResultCount: number;
  readonly linkedAnalysisState: string;
  explain(lane?: LinkedAnalysisLane): string;
  accept(): string;
  execute(): Promise<string>;
  selectAoi(aoiId: string): void;
  exportWorkspace(): string;
  dispose(): void;
}

declare global {
  interface Window {
    __HONUA_SPATIAL_ANALYTICS_WORKBENCH__?: SpatialAnalyticsWorkbenchRuntime;
  }
}

const session = createSpatialAnalyticsWorkbenchSession();
const linkedConfig = linkedAnalysisConfigFromLocation(window.location, {
  VITE_HONUA_SPATIAL_ANALYTICS_BASE_URL: import.meta.env.VITE_HONUA_SPATIAL_ANALYTICS_BASE_URL,
  VITE_HONUA_SPATIAL_ANALYTICS_SERVICE_ID: import.meta.env.VITE_HONUA_SPATIAL_ANALYTICS_SERVICE_ID,
  VITE_HONUA_SPATIAL_ANALYTICS_LAYER_ID: import.meta.env.VITE_HONUA_SPATIAL_ANALYTICS_LAYER_ID,
  VITE_HONUA_SPATIAL_ANALYTICS_SOURCE_VERSION: import.meta.env.VITE_HONUA_SPATIAL_ANALYTICS_SOURCE_VERSION,
  VITE_HONUA_SPATIAL_ANALYTICS_SCHEMA_VERSION: import.meta.env.VITE_HONUA_SPATIAL_ANALYTICS_SCHEMA_VERSION,
});
const linkedController = createLinkedAnalysisController(session.dataset, linkedConfig);
let selectedLane: LinkedAnalysisLane = "remote-pushdown";
let linkedContext = linkedController.explain(selectedLane, session.activeAoi, session.currentProjection());
session.setLinkedAnalysisContext(linkedContext);
let workspaceExport = "";
let executing = false;
let disposed = false;
let executionError: string | undefined;
let retryContext: LinkedAnalysisContext | undefined;
const executionCoordinator = createAnalysisExecutionCoordinator<LinkedAnalysisContext>();
const uiEvents = new AbortController();
const uiEventOptions = { signal: uiEvents.signal };

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

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function render(): void {
  if (disposed) return;
  renderSelectors();
  renderStatus();
  renderLayers();
  renderCapabilities();
  renderMap();
  renderTable();
  renderChart();
  renderAggregationWidgets();
  renderMetrics();
  renderDetail();
  renderJobs();
  renderPlan();
  renderEvidence();
  renderReport();
}

function renderSelectors(): void {
  const aoiSelect = getElement<HTMLSelectElement>("#aoi-select");
  const riskFilter = getElement<HTMLSelectElement>("#risk-filter");
  const executionLane = getElement<HTMLSelectElement>("#execution-lane");

  aoiSelect.innerHTML = session.dataset.aois
    .map(
      (aoi) =>
        `<option value="${escapeHtml(aoi.id)}" ${aoi.id === session.activeAoi.id ? "selected" : ""}>${escapeHtml(aoi.title)}</option>`,
    )
    .join("");
  const risk = session.currentProjection().filters.risk?.value;
  riskFilter.value = typeof risk === "string" ? risk : "all";
  executionLane.value = selectedLane;

  setText("#aoi-area", `${session.activeAoi.areaSqKm.toFixed(1)} sq km`);
  setText("#aoi-geometry", session.activeAoi.geometryLabel);
}

function renderStatus(): void {
  const models = selectAnalyticsUiModels(session);
  const cacheReady = models.cache.ready.length;
  const cacheStale = models.cache.stale.length;
  const activeJob = session.activeJobId ? models.jobs.entries[session.activeJobId] : undefined;
  const latestStatus = activeJob?.snapshot.status ?? "idle";
  const missingCount = session.dataset.processes.filter((process) => process.capabilityState === "missing").length;
  const degradedCount = session.dataset.processes.filter((process) => process.capabilityState === "degraded").length;

  setText("#cache-state", `${cacheReady} ready / ${cacheStale} stale`);
  setText("#data-mode", linkedController.dataMode === "fixture" ? "Fixture replay" : "Configured live");
  setText("#plan-state", titleCase(linkedContext.state));
  setText("#job-state", titleCase(latestStatus));
  setText(
    "#capability-state",
    missingCount > 0 ? `${missingCount} missing` : degradedCount > 0 ? `${degradedCount} degraded` : "Ready",
  );
  getElement<HTMLElement>("#job-state").dataset.status = latestStatus;

  const runButton = getElement<HTMLButtonElement>("#run-analysis");
  const acceptButton = getElement<HTMLButtonElement>("#accept-plan");
  const retryButton = getElement<HTMLButtonElement>("#retry-analysis");
  runButton.disabled = linkedContext.state !== "accepted" || executing;
  acceptButton.disabled = linkedContext.state !== "estimate" || !linkedContext.plan;
  retryButton.disabled = !retryContext || retryContext !== linkedContext || executing;
  runButton.textContent = executing ? "Executing…" : "Execute accepted plan";
  const errorPanel = getElement<HTMLElement>("#execution-error");
  errorPanel.hidden = !executionError;
  setText("#execution-error-message", executionError ?? "");
}

function renderLayers(): void {
  const list = getElement<HTMLElement>("#layer-list");
  list.innerHTML = session.dataset.layers
    .map(
      (layer) => `
        <article class="layer-row">
          <span data-kind="${escapeHtml(layer.kind)}"></span>
          <div>
            <strong>${escapeHtml(layer.title)}</strong>
            <small>${escapeHtml(layer.featureCount.toLocaleString())} features - ${escapeHtml(layer.cache.status)} cache</small>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderCapabilities(): void {
  const list = getElement<HTMLElement>("#capability-list");
  list.innerHTML = session.dataset.processes
    .map(
      (process) => `
        <article class="capability-row" data-state="${escapeHtml(process.capabilityState)}">
          <div>
            <strong>${escapeHtml(process.title)}</strong>
            <small>${escapeHtml(process.operation)} - ${escapeHtml(process.cache.status)} metadata</small>
          </div>
          <span>${escapeHtml(process.requiresTicket ?? process.capabilityState)}</span>
        </article>
      `,
    )
    .join("");
}

function renderMap(): void {
  setText(
    "#map-context",
    linkedContext.plan ? `${linkedContext.id} · ${titleCase(linkedContext.state)}` : titleCase(linkedContext.state),
  );
  const aggregation = session.latestAggregation();
  if (aggregation && session.activePlan.id === "indexed-aggregation") {
    renderAggregationMap(aggregation.cells);
    return;
  }

  const visible = session.visibleFeatures();
  const selectedId = selectAnalyticsUiModels(session).detail.selectedRecords[0]?.feature.id;
  const map = getElement<HTMLElement>("#map-surface");
  const markers = visible
    .map((feature) => {
      const position = featurePosition(feature);
      return `
        <button
          type="button"
          class="map-marker"
          data-risk="${escapeHtml(feature.risk)}"
          data-feature-id="${escapeHtml(feature.id)}"
          data-selected="${feature.id === selectedId}"
          style="left:${position.x}%; top:${position.y}%"
          aria-label="Open ${escapeHtml(feature.title)}"
          aria-pressed="${feature.id === selectedId}"
        >
          <span>${escapeHtml(feature.score)}</span>
        </button>
      `;
    })
    .join("");
  map.innerHTML = `
    <div class="aoi-frame"></div>
    <div class="grid-lines"></div>
    ${markers}
    <div class="map-caption">
      <strong>${escapeHtml(session.activeAoi.title)}</strong>
      <span>${escapeHtml(String(visible.length))} linked result(s)</span>
    </div>
  `;

  for (const button of Array.from(map.querySelectorAll<HTMLButtonElement>(".map-marker"))) {
    button.addEventListener(
      "click",
      () => {
        const featureId = button.dataset.featureId;
        if (!featureId) return;
        session.selectFeature(featureId);
        render();
      },
      uiEventOptions,
    );
  }
  setText("#result-count", String(visible.length));
}

function renderAggregationMap(cells: readonly SpatialAggregationCell[]): void {
  const map = getElement<HTMLElement>("#map-surface");
  const maxCount = Math.max(1, ...cells.map((cell) => countValue(cell.summaries.totalIncidents)));
  map.innerHTML = `
    <div class="aoi-frame"></div>
    <div class="grid-lines"></div>
    ${cells.map((cell) => renderAggregationCell(cell, maxCount)).join("")}
    <div class="map-caption">
      <strong>${escapeHtml(session.activeAoi.title)}</strong>
      <span>${escapeHtml(String(cells.length))} indexed cell(s) loaded; ${escapeHtml(String(session.latestAggregation()?.page?.totalCellCount ?? cells.length))} available</span>
    </div>
  `;
  setText("#result-count", String(cells.length));
}

function renderAggregationCell(cell: SpatialAggregationCell, maxCount: number): string {
  const extent = cell.extent;
  const aoi = session.activeAoi.extent;
  const count = countValue(cell.summaries.totalIncidents);
  const opacity = 0.28 + Math.min(0.62, count / maxCount / 1.6);
  if (!extent) return "";
  const left = ((extent.xmin - aoi.xmin) / (aoi.xmax - aoi.xmin)) * 100;
  const top = (1 - (extent.ymax - aoi.ymin) / (aoi.ymax - aoi.ymin)) * 100;
  const width = ((extent.xmax - extent.xmin) / (aoi.xmax - aoi.xmin)) * 100;
  const height = ((extent.ymax - extent.ymin) / (aoi.ymax - aoi.ymin)) * 100;
  return `
    <article
      class="aggregation-cell"
      style="left:${clamp(left, 0, 100)}%; top:${clamp(top, 0, 100)}%; width:${clamp(width, 4, 100)}%; height:${clamp(height, 4, 100)}%; --cell-opacity:${opacity}"
    >
      <strong>${escapeHtml(count)}</strong>
      <span>${escapeHtml(cell.id)}</span>
    </article>
  `;
}

function renderTable(): void {
  const rows = session.visibleFeatures();
  const selectedId = selectAnalyticsUiModels(session).detail.selectedRecords[0]?.feature.id;
  const body = getElement<HTMLElement>("#result-table");
  body.innerHTML =
    rows.length === 0
      ? `<tr><td colspan="5">No materialized results</td></tr>`
      : rows
          .map(
            (feature) => `
              <tr data-selected="${feature.id === selectedId}">
                <td><button type="button" data-feature-id="${escapeHtml(feature.id)}" aria-pressed="${feature.id === selectedId}">Open ${escapeHtml(feature.title)}</button></td>
                <td>${escapeHtml(titleCase(feature.risk))}</td>
                <td>${escapeHtml(feature.category)}</td>
                <td>${escapeHtml(feature.zone)}</td>
                <td>${escapeHtml(feature.score)}</td>
              </tr>
            `,
          )
          .join("");

  for (const button of Array.from(body.querySelectorAll<HTMLButtonElement>("button[data-feature-id]"))) {
    button.addEventListener(
      "click",
      () => {
        const featureId = button.dataset.featureId;
        if (!featureId) return;
        session.selectFeature(featureId);
        render();
      },
      uiEventOptions,
    );
  }
}

function renderChart(): void {
  const chart = getElement<HTMLElement>("#risk-chart");
  const buckets = linkedChartBuckets();
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const selectedRisk = session.currentProjection().filters.risk?.value;
  chart.innerHTML = buckets
    .map(
      (bucket) => `
        <button type="button" data-risk="${escapeHtml(bucket.risk)}" aria-pressed="${selectedRisk === bucket.risk}">
          <span>${escapeHtml(titleCase(bucket.risk))}</span>
          <strong>${escapeHtml(bucket.count)}</strong>
          <i style="width:${Math.max(8, (bucket.count / maxCount) * 100)}%"></i>
          <small>avg ${escapeHtml(bucket.score)}</small>
        </button>
      `,
    )
    .join("");

  for (const button of Array.from(chart.querySelectorAll<HTMLButtonElement>("button[data-risk]"))) {
    button.addEventListener(
      "click",
      () => {
        session.selectChartBucket(button.dataset.risk as AnalyticsRisk);
        explainCurrent();
        render();
      },
      uiEventOptions,
    );
  }
}

function linkedChartBuckets(): ReadonlyArray<{
  readonly risk: AnalyticsRisk;
  readonly count: number;
  readonly score: number;
}> {
  const rows = linkedContext.aggregateRows;
  if (!rows || rows.length === 0) return session.chartBuckets();
  const byRisk = new Map(rows.map((row) => [String(row.risk), row]));
  return (["critical", "high", "moderate", "low"] as const).map((risk) => {
    const row = byRisk.get(risk);
    return {
      risk,
      count: Number(row?.feature_count ?? 0),
      score: Math.round(Number(row?.average_score ?? 0)),
    };
  });
}

function renderAggregationWidgets(): void {
  const panel = getElement<HTMLElement>("#aggregation-widgets");
  const aggregation = session.latestAggregation();
  if (!aggregation) {
    panel.innerHTML = `<article class="empty-state">Run indexed aggregation to render SDK widget metadata.</article>`;
    return;
  }

  const widgets = session.aggregationWidgets();
  panel.innerHTML = widgets
    .map((widget) => {
      const summary = resolveSpatialAggregationWidgetSummary(aggregation, widget)?.summary;
      if (widget.kind === "category-list" && summary?.kind === "category") {
        return `
          <article class="aggregation-widget" data-kind="category">
            <h3>${escapeHtml(widget.title ?? "Category")}</h3>
            ${summary.buckets
              .map(
                (bucket) => `
                  <div class="widget-row">
                    <span><i style="background:${escapeHtml(bucket.color ?? "#5a7d9a")}"></i>${escapeHtml(bucket.label ?? bucket.value ?? "null")}</span>
                    <strong>${escapeHtml(bucket.count)}</strong>
                  </div>
                `,
              )
              .join("")}
          </article>
        `;
      }
      if (widget.kind === "histogram" && summary?.kind === "histogram") {
        return renderHistogramWidget(widget.title ?? "Histogram", summary);
      }
      if (widget.kind === "range-list" && summary?.kind === "range") {
        return renderRangeWidget(widget.title ?? "Range", summary);
      }
      if (widget.kind === "grouped-table") {
        return `
          <article class="aggregation-widget" data-kind="grouped">
            <h3>${escapeHtml(widget.title ?? "Grouped summaries")}</h3>
            ${
              aggregation.groups
                ?.map(
                  (group) => `
                  <div class="widget-row">
                    <span>${escapeHtml(group.label ?? Object.values(group.key).join(" / "))}</span>
                    <strong>${escapeHtml(formatNumber(countValue(group.summaries.totalIncidents)))}</strong>
                  </div>
                `,
                )
                .join("") ?? ""
            }
          </article>
        `;
      }
      return `
        <article class="aggregation-widget" data-kind="stat">
          <h3>${escapeHtml(widget.title ?? "Statistic")}</h3>
          <strong>${escapeHtml(formatSummaryValue(summary))}</strong>
          <small>${escapeHtml(widget.id)}</small>
        </article>
      `;
    })
    .join("");
}

function renderHistogramWidget(title: string, summary: SpatialAggregationHistogramValue): string {
  const maxCount = Math.max(1, ...summary.buckets.map((bucket) => bucket.count));
  return `
    <article class="aggregation-widget" data-kind="histogram">
      <h3>${escapeHtml(title)}</h3>
      ${summary.buckets
        .map(
          (bucket) => `
            <div class="histogram-row">
              <span>${escapeHtml(bucket.min)}-${escapeHtml(bucket.max)}</span>
              <i style="width:${Math.max(8, (bucket.count / maxCount) * 100)}%"></i>
              <strong>${escapeHtml(bucket.count)}</strong>
            </div>
          `,
        )
        .join("")}
    </article>
  `;
}

function renderRangeWidget(title: string, summary: SpatialAggregationRangeValue): string {
  const maxCount = Math.max(1, ...summary.buckets.map((bucket) => bucket.count));
  return `
    <article class="aggregation-widget" data-kind="range">
      <h3>${escapeHtml(title)}</h3>
      ${summary.buckets
        .map(
          (bucket) => `
            <div class="range-row">
              <span>${escapeHtml(bucket.label ?? bucket.id)}</span>
              <i style="width:${Math.max(8, (bucket.count / maxCount) * 100)}%"></i>
              <strong>${escapeHtml(bucket.count)}</strong>
            </div>
          `,
        )
        .join("")}
    </article>
  `;
}

function renderMetrics(): void {
  const metrics = session.latestOutput()?.metrics ?? session.createReport().metrics;
  const list = getElement<HTMLElement>("#metric-list");
  list.innerHTML = metrics
    .map(
      (metric) => `
        <article data-tone="${escapeHtml(metric.tone ?? "neutral")}">
          <span>${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(metric.value)}</strong>
        </article>
      `,
    )
    .join("");
}

function renderDetail(): void {
  const detail = getElement<HTMLElement>("#feature-detail");
  const models = selectAnalyticsUiModels(session);
  const selected = models.detail.selectedRecords[0]?.feature;
  if (!selected) {
    detail.innerHTML = `
      <h2>No selected result</h2>
      <p>Select a row, chart bucket, or map marker after a job materializes.</p>
    `;
    return;
  }
  detail.innerHTML = `
    <h2>${escapeHtml(selected.title)}</h2>
    <dl>
      <div><dt>Risk</dt><dd>${escapeHtml(titleCase(selected.risk))}</dd></div>
      <div><dt>Zone</dt><dd>${escapeHtml(selected.zone)}</dd></div>
      <div><dt>Score</dt><dd>${escapeHtml(selected.score)}</dd></div>
      <div><dt>Distance</dt><dd>${escapeHtml(selected.distanceMeters)} m</dd></div>
      <div><dt>Action</dt><dd>${escapeHtml(selected.attributes.action)}</dd></div>
    </dl>
  `;
}

function renderJobs(): void {
  const models = selectAnalyticsUiModels(session);
  const jobs = Object.values(models.jobs.entries);
  const list = getElement<HTMLElement>("#job-list");
  list.innerHTML =
    jobs.length === 0
      ? `<article class="job-row"><strong>No jobs yet</strong><span>idle</span></article>`
      : jobs
          .map(
            (job) => `
              <article class="job-row" data-status="${escapeHtml(job.snapshot.status)}">
                <div>
                  <strong>${escapeHtml(job.id)}</strong>
                  <small>${escapeHtml(job.snapshot.progress?.message ?? "No progress message")}</small>
                </div>
                <span>${escapeHtml(titleCase(job.snapshot.status))}</span>
              </article>
            `,
          )
          .join("");

  const activeJob = session.activeJobId ? models.jobs.entries[session.activeJobId] : undefined;
  const error = activeJob?.snapshot.error;
  const diagnostics = getElement<HTMLElement>("#job-diagnostics");
  diagnostics.textContent = error ? `${error.code}: ${error.message}` : "No failed-job diagnostics";
}

function renderPlan(): void {
  const plan = linkedContext.plan;
  const badge = getElement<HTMLElement>("#plan-badge");
  badge.textContent = titleCase(linkedContext.state);
  badge.dataset.state = linkedContext.state;
  const summary = getElement<HTMLElement>("#plan-summary");
  summary.innerHTML = [
    ["Policy", titleCase(linkedContext.lane)],
    ["Context", linkedContext.id],
    ["Fingerprint", plan?.fingerprint ?? "rejected before plan creation"],
    ["Estimate", `${linkedContext.estimatedRows} rows · ${linkedContext.estimatedBytes.toLocaleString()} bytes`],
    ["Pushdown", plan?.pushdown ?? "none"],
    ["Cache", plan?.cache ?? linkedContext.provenance.cacheDecision],
  ]
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");

  const steps = getElement<HTMLOListElement>("#plan-steps");
  steps.innerHTML = plan
    ? plan.steps
        .map(
          (step) => `
            <li data-engine="${escapeHtml(step.engine)}">
              <strong>${escapeHtml(step.engine)} · ${escapeHtml(step.operation)}</strong>
              <span>${escapeHtml(step.reason)}</span>
            </li>
          `,
        )
        .join("")
    : `<li data-engine="rejected"><strong>${escapeHtml(linkedContext.rejection?.code ?? "unavailable")}</strong><span>${escapeHtml(linkedContext.rejection?.reason ?? "No plan is available")}</span></li>`;
  getElement<HTMLPreElement>("#plan-json").textContent = JSON.stringify(
    plan
      ? { ir: plan.ir, compiled: plan.steps[0]?.engine === "remote" ? plan.steps[0].compiled : undefined }
      : linkedContext.rejection,
    null,
    2,
  );
}

function renderEvidence(): void {
  const badge = getElement<HTMLElement>("#evidence-state");
  badge.textContent = titleCase(linkedContext.state);
  badge.dataset.state = linkedContext.state;
  setText("#execution-truth", executionTruth(linkedContext));
  const provenance = linkedContext.provenance;
  getElement<HTMLElement>("#evidence-provenance").innerHTML = [
    ["Observation", provenance.observationState],
    ["Observed", provenance.observedAt ?? "not observed"],
    ["Source version", provenance.sourceVersion],
    ["Schema", provenance.schemaVersion],
    ["Attribution", provenance.attribution],
    ["Cache", provenance.cacheDecision],
    [
      "Execution",
      linkedContext.executionMs === undefined ? "not executed" : `${linkedContext.executionMs.toFixed(2)} ms`,
    ],
  ]
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  getElement<HTMLPreElement>("#artifact-json").textContent = linkedContext.outputArtifact
    ? JSON.stringify(linkedContext.outputArtifact, null, 2)
    : "No output artifact until an accepted plan executes.";
}

function executionTruth(context: LinkedAnalysisContext): string {
  switch (context.state) {
    case "estimate":
      return context.dataMode === "live"
        ? "Estimate only. The configured live source has not been requested or observed; no result rows or output exist."
        : "Estimate only. No result rows were read and no renderer or output was mutated.";
    case "accepted":
      return context.dataMode === "live"
        ? "Accepted plan. The configured live source remains unobserved until execution succeeds; changing intent invalidates this acceptance."
        : "Accepted plan. Execution has not started; changing intent invalidates this acceptance.";
    case "fixture-replay":
      return "GeoServices pushdown was compiled and executed against a committed response fixture. This is replay evidence, not a live remote claim.";
    case "executed-remote":
      return "Executed remotely against the configured public GeoServices source with live observation evidence.";
    case "executed-local":
      return "Executed bounded local metrics/groupBy after the remote query enforced row and byte ceilings.";
    case "rejected":
      return `Rejected before execution: ${context.rejection?.reason ?? "unsafe or unsupported fallback"}`;
    case "skipped":
      return `Structured live skip with no source observation: ${context.rejection?.reason ?? "live configuration unavailable"}`;
  }
}

function renderReport(): void {
  const output = session.latestOutput();
  setText("#materialized-layer", output?.resultLayer.id ?? "none");
  setText("#lineage", output?.resultLayer.lineage.join(" -> ") ?? "no materialized lineage yet");
  getElement<HTMLPreElement>("#workspace-export").textContent =
    workspaceExport || JSON.stringify(session.createReport(), null, 2);
}

function featurePosition(feature: AnalyticsFeature): { x: number; y: number } {
  const extent = session.activeAoi.extent;
  const width = Math.max(0.0001, extent.xmax - extent.xmin);
  const height = Math.max(0.0001, extent.ymax - extent.ymin);
  return {
    x: clamp(((feature.x - extent.xmin) / width) * 100, 4, 96),
    y: clamp(100 - ((feature.y - extent.ymin) / height) * 100, 4, 96),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function wireEvents(activeSession: SpatialAnalyticsWorkbenchSession): void {
  getElement<HTMLSelectElement>("#aoi-select").addEventListener(
    "change",
    (event) => {
      activeSession.selectAoi((event.currentTarget as HTMLSelectElement).value);
      explainCurrent();
      render();
    },
    uiEventOptions,
  );
  getElement<HTMLSelectElement>("#execution-lane").addEventListener(
    "change",
    (event) => {
      selectedLane = (event.currentTarget as HTMLSelectElement).value as LinkedAnalysisLane;
      explainCurrent();
      render();
    },
    uiEventOptions,
  );
  getElement<HTMLSelectElement>("#risk-filter").addEventListener(
    "change",
    (event) => {
      activeSession.setRiskFilter((event.currentTarget as HTMLSelectElement).value as AnalyticsRisk | "all");
      explainCurrent();
      render();
    },
    uiEventOptions,
  );
  getElement<HTMLButtonElement>("#explain-analysis").addEventListener(
    "click",
    () => {
      explainCurrent();
      render();
    },
    uiEventOptions,
  );
  getElement<HTMLButtonElement>("#accept-plan").addEventListener(
    "click",
    () => {
      acceptCurrent();
    },
    uiEventOptions,
  );
  getElement<HTMLButtonElement>("#run-analysis").addEventListener(
    "click",
    () => void executeAcceptedPlan().catch(() => undefined),
    uiEventOptions,
  );
  getElement<HTMLButtonElement>("#retry-analysis").addEventListener(
    "click",
    () => void executeAcceptedPlan().catch(() => undefined),
    uiEventOptions,
  );
  getElement<HTMLButtonElement>("#simulate-gap").addEventListener(
    "click",
    () => {
      loadIndexedFixture(activeSession);
    },
    uiEventOptions,
  );
  getElement<HTMLButtonElement>("#export-workspace").addEventListener(
    "click",
    () => {
      workspaceExport = activeSession.exportWorkspace();
      render();
    },
    uiEventOptions,
  );
}

function loadIndexedFixture(activeSession: SpatialAnalyticsWorkbenchSession): void {
  invalidateExecution();
  activeSession.clearOutput();
  linkedContext = linkedController.explain(selectedLane, activeSession.activeAoi, activeSession.currentProjection());
  workspaceExport = "";
  activeSession.setLinkedAnalysisContext(undefined);
  activeSession.selectPlan("indexed-aggregation");
  activeSession.startAnalysis();
  activeSession.advanceJob();
  activeSession.advanceJob();
  activeSession.setLinkedAnalysisContext(linkedContext);
  render();
}

function explainCurrent(): void {
  invalidateExecution();
  session.clearOutput();
  linkedContext = linkedController.explain(selectedLane, session.activeAoi, session.currentProjection());
  session.setLinkedAnalysisContext(linkedContext);
  workspaceExport = "";
}

function acceptCurrent(): string {
  invalidateExecution();
  session.clearOutput();
  linkedContext = linkedController.accept(linkedContext);
  session.setLinkedAnalysisContext(linkedContext);
  render();
  return linkedContext.state;
}

function invalidateExecution(): void {
  executionCoordinator.invalidate();
  executing = false;
  executionError = undefined;
  retryContext = undefined;
}

async function executeAcceptedPlan(): Promise<string> {
  if (disposed) return "disposed";
  if (executing) return linkedContext.state;
  const acceptedContext = linkedContext;
  const ticket = executionCoordinator.begin(acceptedContext);
  executing = true;
  executionError = undefined;
  retryContext = undefined;
  render();
  try {
    const executedContext = await linkedController.execute(acceptedContext, ticket.signal);
    if (disposed) return "disposed";
    if (!executionCoordinator.isCurrent(ticket, linkedContext)) return linkedContext.state;
    linkedContext = executedContext;
    session.setLinkedAnalysisContext(linkedContext);
    if (linkedController.dataMode === "fixture") {
      session.selectPlan("linked-risk-summary");
      const jobId = session.startAnalysis();
      session.advanceJob(jobId);
      session.advanceJob(jobId);
    }
    setText("#analysis-announcer", executionTruth(linkedContext));
    return linkedContext.state;
  } catch (error) {
    if (disposed) return "disposed";
    if (!executionCoordinator.isCurrent(ticket, linkedContext)) return linkedContext.state;
    executionError = error instanceof Error ? error.message : String(error);
    retryContext = acceptedContext;
    setText("#analysis-announcer", executionError);
    throw error;
  } finally {
    if (executionCoordinator.finish(ticket)) {
      executing = false;
      render();
    }
  }
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  executionCoordinator.invalidate();
  uiEvents.abort();
  session.dispose();
}

wireEvents(session);
render();

window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__ = {
  get ready() {
    return !disposed;
  },
  get disposed() {
    return disposed;
  },
  get visibleResultCount() {
    return disposed ? 0 : session.visibleFeatures().length;
  },
  get linkedAnalysisState() {
    return disposed ? "disposed" : linkedContext.state;
  },
  explain(lane = selectedLane): string {
    if (disposed) return "disposed";
    selectedLane = lane;
    explainCurrent();
    render();
    return linkedContext.state;
  },
  accept(): string {
    if (disposed) return "disposed";
    return acceptCurrent();
  },
  execute(): Promise<string> {
    return executeAcceptedPlan();
  },
  selectAoi(aoiId: string): void {
    if (disposed) return;
    session.selectAoi(aoiId);
    explainCurrent();
    render();
  },
  exportWorkspace(): string {
    if (disposed) return "";
    workspaceExport = session.exportWorkspace();
    render();
    return workspaceExport;
  },
  dispose,
};

window.addEventListener("beforeunload", dispose, { once: true, signal: uiEvents.signal });

function countValue(summary: SpatialAggregationSummaryValue | undefined): number {
  return summary && "value" in summary && typeof summary.value === "number" ? summary.value : 0;
}

function formatSummaryValue(summary: SpatialAggregationSummaryValue | undefined): string {
  if (!summary) return "0";
  if ("value" in summary) return formatNumber(Number(summary.value ?? 0));
  if (summary.kind === "category") return `${summary.buckets.length} bucket(s)`;
  if (summary.kind === "histogram" || summary.kind === "range") return `${summary.buckets.length} bucket(s)`;
  return "0";
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}
