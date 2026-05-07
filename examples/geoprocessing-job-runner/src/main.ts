import type { GeospatialGrpcProcessClient } from "@honua/sdk-js/honua";
import { createGeoprocessingJobRunnerSession, selectGeoprocessingRunnerUiModels } from "./model.js";
import type { RunnerFeature } from "./types.js";

import "./styles.css";

interface GeoprocessingJobRunnerRuntime {
  readonly ready: boolean;
  readonly visibleResultCount: number;
  runJob(): Promise<string>;
  pollJob(): Promise<string>;
  cancelJob(): Promise<string>;
  exportWorkspace(): string;
}

declare global {
  interface Window {
    __HONUA_GEOPROCESSING_JOB_RUNNER__?: GeoprocessingJobRunnerRuntime;
  }
}

const configuredProcessServiceUrl = readViteEnv("VITE_HONUA_PROCESS_SERVICE_URL");
const configuredProcessServiceToken = readViteEnv("VITE_HONUA_PROCESS_SERVICE_TOKEN");
const session = createGeoprocessingJobRunnerSession({
  processClientFactory: configuredProcessServiceUrl
    ? () => createConnectJsonProcessClient(configuredProcessServiceUrl, configuredProcessServiceToken)
    : undefined,
});
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

function readViteEnv(name: string): string | undefined {
  const env = (import.meta as ImportMeta & { readonly env?: Record<string, string | undefined> }).env;
  const value = env?.[name]?.trim();
  return value ? value : undefined;
}

function createConnectJsonProcessClient(baseUrl: string, token?: string): GeospatialGrpcProcessClient {
  const serviceUrl = `${baseUrl.replace(/\/+$/, "")}/geospatial.v1.ProcessService`;
  const invoke = async <TResponse>(method: string, body: Record<string, unknown>): Promise<TResponse> => {
    const response = await fetch(`${serviceUrl}/${method}`, {
      method: "POST",
      headers: {
        "connect-protocol-version": "1",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`ProcessService ${method} failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as TResponse;
  };

  return {
    validatePlan: ({ plan }) => invoke("ValidatePlan", { plan }),
    dryRunPlan: ({ plan }) => invoke("DryRunPlan", { plan }),
    submitJob: ({ plan, context }) => invoke("SubmitJob", { plan, context }),
    getJob: ({ jobId }) => invoke("GetJob", { jobId }),
    getJobResult: ({ jobId }) => invoke("GetJobResult", { jobId }),
    cancelJob: ({ jobId }) => invoke("CancelJob", { jobId }),
  };
}

function render(): void {
  renderSelectors();
  renderStatus();
  renderProcesses();
  renderMap();
  renderTable();
  renderChart();
  renderDetail();
  renderExport();
}

function renderSelectors(): void {
  const aoiSelect = getElement<HTMLSelectElement>("#aoi-select");
  const planSelect = getElement<HTMLSelectElement>("#plan-select");
  const categoryFilter = getElement<HTMLSelectElement>("#category-filter");

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

  const category = session.currentProjection().filters.category?.value;
  categoryFilter.value = typeof category === "string" ? category : "all";
  setText("#aoi-area", `${session.activeAoi.areaSqKm.toFixed(1)} sq km`);
  setText("#aoi-geometry", session.activeAoi.geometryLabel);
  setText("#plan-duration", session.activePlan.estimatedDuration);
}

function renderStatus(): void {
  const models = selectGeoprocessingRunnerUiModels(session);
  const activeJob = session.activeJobId ? models.jobs.entries[session.activeJobId] : undefined;
  const status = activeJob?.snapshot.status ?? "idle";
  const cacheReady = models.cache.ready.length;
  const cacheStale = models.cache.stale.length;
  const latestOutput = session.latestOutput();

  setText("#job-state", titleCase(status));
  setText("#cache-state", `${cacheReady} ready / ${cacheStale} stale`);
  setText("#capability-state", session.activePlan.capabilityState);
  setText("#materialized-layer", latestOutput?.resultLayer.id ?? "none");
  setText("#metric-count", String(latestOutput?.metrics.featureCount ?? 0));
  setText("#metric-critical", String(latestOutput?.metrics.criticalCount ?? 0));
  setText("#metric-population", (latestOutput?.metrics.peopleServed ?? 0).toLocaleString());
  getElement<HTMLElement>("#job-state").dataset.status = status;

  getElement<HTMLButtonElement>("#run-job").disabled = status === "accepted" || status === "running";
  getElement<HTMLButtonElement>("#poll-job").disabled = status !== "accepted" && status !== "running";
  getElement<HTMLButtonElement>("#cancel-job").disabled = status !== "accepted" && status !== "running";
}

function renderProcesses(): void {
  const list = getElement<HTMLElement>("#process-list");
  list.innerHTML = session.dataset.processes
    .map(
      (process) => `
        <article class="process-row" data-state="${escapeHtml(process.capabilityState)}">
          <div>
            <strong>${escapeHtml(process.title)}</strong>
            <small>${escapeHtml(process.protocol)} - ${escapeHtml(process.operation)} - ${escapeHtml(process.cache.status)} metadata</small>
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
  map.innerHTML = `
    <div class="aoi-frame"></div>
    <div class="grid-lines"></div>
    ${visible.map((feature) => renderMarker(feature)).join("")}
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

function renderMarker(feature: RunnerFeature): string {
  const x = 12 + (Math.abs(feature.geometry.x * 1000) % 76);
  const y = 16 + (Math.abs(feature.geometry.y * 1000) % 68);
  return `
    <button
      type="button"
      class="map-marker"
      data-risk="${escapeHtml(feature.risk)}"
      data-feature-id="${escapeHtml(feature.id)}"
      style="left:${x}%; top:${y}%"
      aria-label="Open ${escapeHtml(feature.title)}"
    >
      <span>${escapeHtml(feature.score)}</span>
    </button>
  `;
}

function renderTable(): void {
  const rows = session.visibleFeatures();
  const table = getElement<HTMLElement>("#result-table");
  table.innerHTML = rows.length
    ? rows
        .map(
          (feature) => `
            <button type="button" class="table-row" data-feature-id="${escapeHtml(feature.id)}" aria-label="Open ${escapeHtml(feature.title)}">
              <span>${escapeHtml(feature.title)}</span>
              <span>${escapeHtml(feature.risk)}</span>
              <span>${escapeHtml(feature.category)}</span>
              <span>${escapeHtml(String(feature.score))}</span>
            </button>
          `,
        )
        .join("")
    : `<p class="empty">No materialized result rows</p>`;
  for (const button of Array.from(table.querySelectorAll<HTMLButtonElement>(".table-row"))) {
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
  chart.innerHTML = session
    .chartBuckets()
    .map((bucket) => {
      const width = Math.max(4, Math.min(100, bucket.score));
      return `
        <button type="button" class="bar-row" data-risk="${escapeHtml(bucket.risk)}">
          <span>${escapeHtml(bucket.risk)}</span>
          <strong style="width:${width}%"></strong>
          <em>${escapeHtml(String(bucket.count))}</em>
        </button>
      `;
    })
    .join("");
  for (const button of Array.from(chart.querySelectorAll<HTMLButtonElement>(".bar-row"))) {
    button.addEventListener("click", () => {
      const risk = button.dataset.risk;
      if (!risk) return;
      getElement<HTMLSelectElement>("#category-filter").value = "all";
      session.setCategoryFilter("all");
      render();
    });
  }
}

function renderDetail(): void {
  const detail = selectGeoprocessingRunnerUiModels(session).detail;
  const record = detail.selectedRecords[0]?.feature;
  getElement<HTMLElement>("#feature-detail").innerHTML = record
    ? `
      <strong>${escapeHtml(record.title)}</strong>
      <span>${escapeHtml(record.risk)} risk - ${escapeHtml(record.category)} - ${escapeHtml(record.peopleServed.toLocaleString())} people served</span>
    `
    : "<span>No selected feature</span>";

  const activeJob = session.activeJobId
    ? selectGeoprocessingRunnerUiModels(session).jobs.entries[session.activeJobId]
    : undefined;
  const error = activeJob?.snapshot.error;
  getElement<HTMLElement>("#job-diagnostics").textContent = error
    ? `${error.code}: ${error.message}`
    : "No failed-job diagnostics";
}

function renderExport(): void {
  getElement<HTMLTextAreaElement>("#workspace-export").value = workspaceExport;
}

getElement<HTMLSelectElement>("#aoi-select").addEventListener("change", (event) => {
  session.selectAoi((event.currentTarget as HTMLSelectElement).value);
  render();
});
getElement<HTMLSelectElement>("#plan-select").addEventListener("change", (event) => {
  session.selectPlan((event.currentTarget as HTMLSelectElement).value);
  render();
});
getElement<HTMLSelectElement>("#category-filter").addEventListener("change", (event) => {
  session.setCategoryFilter((event.currentTarget as HTMLSelectElement).value as RunnerFeature["category"] | "all");
  render();
});
getElement<HTMLButtonElement>("#run-job").addEventListener("click", async () => {
  await session.startJob();
  render();
});
getElement<HTMLButtonElement>("#poll-job").addEventListener("click", async () => {
  await session.pollJob();
  render();
});
getElement<HTMLButtonElement>("#cancel-job").addEventListener("click", async () => {
  await session.cancelJob();
  render();
});
getElement<HTMLButtonElement>("#export-workspace").addEventListener("click", () => {
  workspaceExport = session.exportWorkspace();
  render();
});

window.__HONUA_GEOPROCESSING_JOB_RUNNER__ = {
  ready: true,
  get visibleResultCount() {
    return session.visibleFeatures().length;
  },
  async runJob() {
    const id = await session.startJob();
    render();
    return id;
  },
  async pollJob() {
    const snapshot = await session.pollJob();
    render();
    return snapshot.status;
  },
  async cancelJob() {
    const snapshot = await session.cancelJob();
    render();
    return snapshot.status;
  },
  exportWorkspace() {
    workspaceExport = session.exportWorkspace();
    render();
    return workspaceExport;
  },
};

render();
