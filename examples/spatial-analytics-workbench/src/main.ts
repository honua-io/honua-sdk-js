import { createSpatialAnalyticsWorkbenchSession, selectAnalyticsUiModels } from "./model.js";
import type { AnalyticsFeature, AnalyticsPlanId, AnalyticsRisk, SpatialAnalyticsWorkbenchSession } from "./types.js";

import "./styles.css";

interface SpatialAnalyticsWorkbenchRuntime {
  readonly ready: boolean;
  readonly visibleResultCount: number;
  runAnalysis(): string;
  advanceJob(): string;
  selectAoi(aoiId: string): void;
  exportWorkspace(): string;
}

declare global {
  interface Window {
    __HONUA_SPATIAL_ANALYTICS_WORKBENCH__?: SpatialAnalyticsWorkbenchRuntime;
  }
}

const session = createSpatialAnalyticsWorkbenchSession();
let workspaceExport = "";

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
  renderSelectors();
  renderStatus();
  renderLayers();
  renderCapabilities();
  renderMap();
  renderTable();
  renderChart();
  renderMetrics();
  renderDetail();
  renderJobs();
  renderReport();
}

function renderSelectors(): void {
  const aoiSelect = getElement<HTMLSelectElement>("#aoi-select");
  const planSelect = getElement<HTMLSelectElement>("#plan-select");
  const riskFilter = getElement<HTMLSelectElement>("#risk-filter");

  aoiSelect.innerHTML = session.dataset.aois
    .map(
      (aoi) =>
        `<option value="${escapeHtml(aoi.id)}" ${aoi.id === session.activeAoi.id ? "selected" : ""}>${escapeHtml(aoi.title)}</option>`,
    )
    .join("");
  planSelect.innerHTML = session.dataset.plans
    .map(
      (plan) =>
        `<option value="${escapeHtml(plan.id)}" ${plan.id === session.activePlan.id ? "selected" : ""}>${escapeHtml(plan.title)}</option>`,
    )
    .join("");
  const risk = session.currentProjection().filters.risk?.value;
  riskFilter.value = typeof risk === "string" ? risk : "all";

  setText("#aoi-area", `${session.activeAoi.areaSqKm.toFixed(1)} sq km`);
  setText("#aoi-geometry", session.activeAoi.geometryLabel);
  setText("#plan-cost", session.activePlan.estimatedCost);
  setText("#plan-duration", session.activePlan.estimatedDuration);
}

function renderStatus(): void {
  const models = selectAnalyticsUiModels(session);
  const cacheReady = models.cache.ready.length;
  const cacheStale = models.cache.stale.length;
  const activeJob = session.activeJobId ? models.jobs.entries[session.activeJobId] : undefined;
  const latestStatus = activeJob?.snapshot.status ?? "idle";
  const gapCount = session.dataset.capabilityGaps.length;

  setText("#cache-state", `${cacheReady} ready / ${cacheStale} stale`);
  setText("#job-state", titleCase(latestStatus));
  setText("#capability-state", gapCount === 0 ? "Ready" : `${gapCount} gap(s)`);
  getElement<HTMLElement>("#job-state").dataset.status = latestStatus;

  const runButton = getElement<HTMLButtonElement>("#run-analysis");
  const advanceButton = getElement<HTMLButtonElement>("#advance-job");
  runButton.disabled = latestStatus === "accepted" || latestStatus === "running";
  advanceButton.disabled = latestStatus !== "accepted" && latestStatus !== "running";
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
  const visible = session.visibleFeatures();
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
          style="left:${position.x}%; top:${position.y}%"
          aria-label="Open ${escapeHtml(feature.title)}"
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
    button.addEventListener("click", () => {
      const featureId = button.dataset.featureId;
      if (!featureId) return;
      session.selectFeature(featureId);
      render();
    });
  }
  setText("#result-count", String(visible.length));
}

function renderTable(): void {
  const rows = session.visibleFeatures();
  const body = getElement<HTMLElement>("#result-table");
  body.innerHTML =
    rows.length === 0
      ? `<tr><td colspan="5">No materialized results</td></tr>`
      : rows
          .map(
            (feature) => `
              <tr>
                <td><button type="button" data-feature-id="${escapeHtml(feature.id)}">Open ${escapeHtml(feature.title)}</button></td>
                <td>${escapeHtml(titleCase(feature.risk))}</td>
                <td>${escapeHtml(feature.category)}</td>
                <td>${escapeHtml(feature.zone)}</td>
                <td>${escapeHtml(feature.score)}</td>
              </tr>
            `,
          )
          .join("");

  for (const button of Array.from(body.querySelectorAll<HTMLButtonElement>("button[data-feature-id]"))) {
    button.addEventListener("click", () => {
      const featureId = button.dataset.featureId;
      if (!featureId) return;
      session.selectFeature(featureId);
      render();
    });
  }
}

function renderChart(): void {
  const chart = getElement<HTMLElement>("#risk-chart");
  const buckets = session.chartBuckets();
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  chart.innerHTML = buckets
    .map(
      (bucket) => `
        <button type="button" data-risk="${escapeHtml(bucket.risk)}">
          <span>${escapeHtml(titleCase(bucket.risk))}</span>
          <strong>${escapeHtml(bucket.count)}</strong>
          <i style="width:${Math.max(8, (bucket.count / maxCount) * 100)}%"></i>
          <small>avg ${escapeHtml(bucket.score)}</small>
        </button>
      `,
    )
    .join("");

  for (const button of Array.from(chart.querySelectorAll<HTMLButtonElement>("button[data-risk]"))) {
    button.addEventListener("click", () => {
      session.selectChartBucket(button.dataset.risk as AnalyticsRisk);
      render();
    });
  }
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
  getElement<HTMLSelectElement>("#aoi-select").addEventListener("change", (event) => {
    activeSession.selectAoi((event.currentTarget as HTMLSelectElement).value);
    render();
  });
  getElement<HTMLSelectElement>("#plan-select").addEventListener("change", (event) => {
    activeSession.selectPlan((event.currentTarget as HTMLSelectElement).value as AnalyticsPlanId);
    render();
  });
  getElement<HTMLSelectElement>("#risk-filter").addEventListener("change", (event) => {
    activeSession.setRiskFilter((event.currentTarget as HTMLSelectElement).value as AnalyticsRisk | "all");
    render();
  });
  getElement<HTMLButtonElement>("#run-analysis").addEventListener("click", () => {
    activeSession.startAnalysis();
    render();
  });
  getElement<HTMLButtonElement>("#advance-job").addEventListener("click", () => {
    activeSession.advanceJob();
    render();
  });
  getElement<HTMLButtonElement>("#simulate-gap").addEventListener("click", () => {
    activeSession.selectPlan("indexed-aggregation");
    activeSession.startAnalysis();
    activeSession.advanceJob();
    activeSession.advanceJob();
    render();
  });
  getElement<HTMLButtonElement>("#retry-job").addEventListener("click", () => {
    try {
      activeSession.retryJob();
      render();
    } catch {
      return;
    }
  });
  getElement<HTMLButtonElement>("#export-workspace").addEventListener("click", () => {
    workspaceExport = activeSession.exportWorkspace();
    render();
  });
}

wireEvents(session);
render();

window.__HONUA_SPATIAL_ANALYTICS_WORKBENCH__ = {
  ready: true,
  get visibleResultCount() {
    return session.visibleFeatures().length;
  },
  runAnalysis(): string {
    const jobId = session.startAnalysis();
    render();
    return jobId;
  },
  advanceJob(): string {
    const snapshot = session.advanceJob();
    render();
    return snapshot.status;
  },
  selectAoi(aoiId: string): void {
    session.selectAoi(aoiId);
    render();
  },
  exportWorkspace(): string {
    workspaceExport = session.exportWorkspace();
    render();
    return workspaceExport;
  },
};
