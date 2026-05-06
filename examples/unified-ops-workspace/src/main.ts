import { selectLinkedViewQueryProjection, sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import {
  type LinkedViewQueryProjection,
  bindDetailToSelection,
  bindQueryProjectionToExploration,
} from "@honua/sdk-js/interactions";

import { MAP_PRESETS } from "./fixtures.js";
import {
  activeSourceIds,
  applyUnifiedOpsDraft,
  applyUnifiedOpsProjection,
  createUnifiedOpsSnapshotDiagnostics,
  createUnifiedOpsWorkspace,
  formatExtent,
  moveUnifiedOpsMap,
  restoreUnifiedOpsSnapshot,
  saveUnifiedOpsSnapshot,
  selectedFeatureId,
  setUnifiedOpsActiveModule,
  setUnifiedOpsActiveSource,
  stageUnifiedOpsAiDraft,
} from "./model.js";
import { CREW_SOURCE_ID, INCIDENT_SOURCE_ID, OPS_LAYER_ID } from "./types.js";
import type {
  UnifiedOpsFeature,
  UnifiedOpsModuleId,
  UnifiedOpsProjectionResult,
  UnifiedOpsSavedSnapshot,
  UnifiedOpsSeverity,
} from "./types.js";

import "./styles.css";

interface UnifiedOpsRuntime {
  ready: boolean;
  activeModule: string | undefined;
  visibleCount: number;
  selectedId: string | null;
  filterCount: number;
  stagedDraftCount: number;
  appliedDraftCount: number;
  realtimeStatus: string;
  snapshotId: string | null;
  lastStep: string | null;
  step(): string | null;
  saveSnapshot(): string;
  restoreSnapshot(): boolean;
  switchModule(moduleId: UnifiedOpsModuleId): void;
  stageDraft(source?: "ai" | "mcp"): string;
  applyDraft(): void;
}

declare global {
  interface Window {
    __HONUA_UNIFIED_OPS_RUNTIME__?: UnifiedOpsRuntime;
  }
}

const shell = createUnifiedOpsWorkspace();
let latestProjection: LinkedViewQueryProjection = selectLinkedViewQueryProjection(shell.exploration.state);
let latestProjectionResult: UnifiedOpsProjectionResult = applyUnifiedOpsProjection(
  shell.workspace.state,
  latestProjection,
  {
    sourceId: INCIDENT_SOURCE_ID,
  },
);
let renderQueued = false;
let lastStep: string | null = null;
let lastSavedDocument: unknown;
let lastSnapshot: UnifiedOpsSavedSnapshot | undefined;
let appliedDraftCount = 0;

const runtime: UnifiedOpsRuntime = {
  ready: false,
  activeModule: shell.workspace.state.layout.activeViewId,
  visibleCount: 0,
  selectedId: null,
  filterCount: 0,
  stagedDraftCount: 0,
  appliedDraftCount: 0,
  realtimeStatus: "idle",
  snapshotId: null,
  lastStep: null,
  step() {
    lastStep = shell.stepRealtimeScenario() ?? null;
    scheduleRender();
    return lastStep;
  },
  saveSnapshot() {
    const saved = saveCurrentSnapshot();
    return saved.id;
  },
  restoreSnapshot() {
    return restoreCurrentSnapshot();
  },
  switchModule(moduleId) {
    setUnifiedOpsActiveModule(shell, moduleId);
    scheduleRender();
  },
  stageDraft(source = "ai") {
    const draftId = stageUnifiedOpsAiDraft(shell, { source });
    scheduleRender();
    return draftId;
  },
  applyDraft() {
    applyActiveDraft();
  },
};
window.__HONUA_UNIFIED_OPS_RUNTIME__ = runtime;

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

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    renderAll();
  });
}

function renderAll(): void {
  const state = shell.workspace.state;
  const incidentResult = applyUnifiedOpsProjection(state, latestProjection, { sourceId: INCIDENT_SOURCE_ID });
  const mapResult = applyUnifiedOpsProjection(state, latestProjection);
  latestProjectionResult = incidentResult;

  renderModules();
  renderSourceToggles();
  renderFilters();
  renderMetrics(incidentResult);
  renderMap(mapResult);
  renderIncidentTable(incidentResult);
  renderChart(incidentResult);
  renderDetail();
  renderDrafts();
  renderJobs();
  renderSnapshotDiagnostics();
  renderContext();
  updateRuntime(incidentResult);
}

function renderModules(): void {
  const activeModule = (shell.workspace.state.layout.activeViewId ?? "incident-command") as UnifiedOpsModuleId;
  document.querySelectorAll<HTMLButtonElement>("[data-module]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.module === activeModule));
  });
  getElement<HTMLElement>("#incident-command-module").dataset.active = String(activeModule === "incident-command");
  getElement<HTMLElement>("#analysis-review-module").dataset.active = String(activeModule === "analysis-review");
  setText("#context-active-view", activeModule);
}

function renderSourceToggles(): void {
  const state = shell.workspace.state;
  const active = activeSourceIds(state);
  setText("#active-source-count", `${active.length} active`);
  const incidentEntry = state.sources.entries[INCIDENT_SOURCE_ID];
  const crewEntry = state.sources.entries[CREW_SOURCE_ID];
  getElement<HTMLInputElement>("#source-incident-ops").checked = incidentEntry?.metadata?.active !== false;
  getElement<HTMLInputElement>("#source-response-crews").checked = crewEntry?.metadata?.active !== false;
  setText("#incident-source-status", incidentEntry?.status ?? "missing");
  setText("#crew-source-status", crewEntry?.status ?? "missing");
}

function renderFilters(): void {
  const filters = shell.exploration.state.filters;
  setText("#filter-count", String(Object.keys(filters).length));
  getElement<HTMLSelectElement>("#status-filter").value = String(filters.status?.value ?? "");
  getElement<HTMLSelectElement>("#severity-filter").value = String(
    filters.severity?.value ?? filters.aiCritical?.value ?? "",
  );
}

function renderMetrics(result: UnifiedOpsProjectionResult): void {
  setText("#visible-count", String(result.incidentRows.length));
  setText("#critical-count", String(result.summary.criticalIncidents));
  setText("#eta-average", `${result.summary.averageEtaMinutes}m`);
  setText("#selection-count", `${latestProjection.selection.length} selected`);
  setText("#extent-readout", formatExtent(latestProjection.extent));
  setText("#realtime-record-count", String(Object.keys(shell.workspace.state.realtime.features.records).length));
  setText("#realtime-status", titleCase(shell.workspace.state.realtime.features.status));
  setText("#realtime-cursor", shell.workspace.state.realtime.features.cursor ?? "-");
  setText("#last-step", lastStep ?? "-");
}

function renderMap(result: UnifiedOpsProjectionResult): void {
  const map = getElement<HTMLElement>("#ops-map");
  const extent = latestProjection.extent;
  map.innerHTML = `
    <div class="map-grid"></div>
    <div class="map-label top">North Shore Feed</div>
    <div class="map-label bottom">Harbor / Urban Core / Airport</div>
    ${result.rows.map((feature) => renderMapPin(feature, extent)).join("")}
  `;
  map.querySelectorAll<HTMLButtonElement>(".map-pin").forEach((pin) => {
    pin.addEventListener("click", () => {
      const sourceId = pin.dataset.sourceId === CREW_SOURCE_ID ? CREW_SOURCE_ID : INCIDENT_SOURCE_ID;
      const id = pin.dataset.id ?? "";
      shell.controllers.table.select([sourceFeatureSelectionTarget(sourceId, id)], { replace: true });
      scheduleRender();
    });
  });
}

function renderMapPin(feature: UnifiedOpsFeature, extent = latestProjection.extent): string {
  const bounds = extent ?? MAP_PRESETS[0].extent;
  const x = clamp(((feature.coordinate[0] - bounds.xmin) / (bounds.xmax - bounds.xmin)) * 100, 5, 95);
  const y = clamp(100 - ((feature.coordinate[1] - bounds.ymin) / (bounds.ymax - bounds.ymin)) * 100, 5, 95);
  const selected = selectedFeatureId(latestProjection.selection) === feature.id;
  return `
    <button
      type="button"
      class="map-pin"
      data-kind="${escapeHtml(feature.kind)}"
      data-severity="${escapeHtml(feature.severity)}"
      data-selected="${String(selected)}"
      data-source-id="${escapeHtml(feature.sourceId)}"
      data-id="${escapeHtml(feature.id)}"
      style="left: ${x.toFixed(2)}%; top: ${y.toFixed(2)}%;"
      aria-label="Open ${escapeHtml(feature.title)}"
      title="${escapeHtml(feature.title)}"
    >
      <span>${feature.kind === "crew" ? "C" : "I"}</span>
    </button>
  `;
}

function renderIncidentTable(result: UnifiedOpsProjectionResult): void {
  const body = getElement<HTMLElement>("#incident-table-body");
  if (result.incidentRows.length === 0) {
    body.innerHTML = '<tr><td colspan="4">No incidents match the linked context.</td></tr>';
    return;
  }
  body.innerHTML = result.incidentRows
    .map(
      (feature) => `
        <tr data-selected="${String(selectedFeatureId(latestProjection.selection) === feature.id)}">
          <td>${escapeHtml(feature.id)}</td>
          <td>
            <strong>${escapeHtml(feature.title)}</strong>
            <span>${escapeHtml(feature.district)} / ${escapeHtml(titleCase(feature.severity))}</span>
          </td>
          <td>${escapeHtml(titleCase(feature.status))}</td>
          <td>
            <button type="button" data-open-incident="${escapeHtml(feature.id)}" aria-label="Open ${escapeHtml(feature.title)}">
              Open
            </button>
          </td>
        </tr>
      `,
    )
    .join("");
  body.querySelectorAll<HTMLButtonElement>("[data-open-incident]").forEach((button) => {
    button.addEventListener("click", () => {
      shell.controllers.table.select(
        [sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, button.dataset.openIncident ?? "")],
        {
          replace: true,
        },
      );
      scheduleRender();
    });
  });
}

function renderChart(result: UnifiedOpsProjectionResult): void {
  const chart = getElement<HTMLElement>("#severity-chart");
  const max = Math.max(1, ...result.buckets.map((bucket) => bucket.count));
  chart.innerHTML = result.buckets
    .map(
      (bucket) => `
        <button
          type="button"
          class="bucket"
          data-severity="${escapeHtml(bucket.id)}"
          style="--bucket-size: ${Math.max(8, Math.round((bucket.count / max) * 100))}%"
        >
          <span>${escapeHtml(bucket.label)}</span>
          <strong>${bucket.count}</strong>
        </button>
      `,
    )
    .join("");
  chart.querySelectorAll<HTMLButtonElement>(".bucket").forEach((button) => {
    button.addEventListener("click", () => {
      const severity = button.dataset.severity as UnifiedOpsSeverity;
      const bucket = latestProjectionResult.buckets.find((entry) => entry.id === severity);
      if (!bucket) return;
      shell.controllers.chart.selectBucket(
        {
          filters: {
            severity: bucket.filter,
          },
          targets: bucket.targets,
        },
        { replaceSelection: true },
      );
      scheduleRender();
    });
  });
}

function renderDetail(): void {
  const selected = latestProjection.selection[0];
  const key = selected ? sourceSelectionKey(selected) : undefined;
  const record = key ? shell.workspace.state.realtime.features.records[key] : undefined;
  const feature = record?.feature;
  if (!feature) {
    setText("#detail-source", "-");
    setText("#detail-title", "No selected feature");
    setText("#detail-summary", "-");
    getElement<HTMLElement>("#detail-attributes").innerHTML = "";
    return;
  }
  setText("#detail-source", feature.sourceId);
  setText("#detail-title", feature.title);
  setText("#detail-summary", feature.summary);
  getElement<HTMLElement>("#detail-attributes").innerHTML = [
    ["ID", feature.id],
    ["Status", titleCase(feature.status)],
    ["Severity", titleCase(feature.severity)],
    ["District", feature.district],
    ["Assignment", feature.assignment ?? "-"],
    ["Updated", formatTime(feature.updatedAt)],
    ["Related", feature.relatedIds.join(", ")],
    ["Attachments", feature.attachments.join(", ")],
  ]
    .map(
      ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `,
    )
    .join("");
}

function renderDrafts(): void {
  const drafts = shell.workspace.state.drafts;
  const entries = Object.values(drafts.entries);
  setText("#draft-count", String(entries.length));
  setText("#active-draft", drafts.activeDraftId ?? "-");
  const list = getElement<HTMLElement>("#draft-list");
  list.innerHTML =
    entries.length === 0
      ? "<li><strong>No review drafts</strong><span>-</span></li>"
      : entries
          .map(
            (draft) => `
              <li data-active="${String(draft.id === drafts.activeDraftId)}">
                <strong>${escapeHtml(draft.label ?? draft.id)}</strong>
                <span>${escapeHtml(draft.source.toUpperCase())} / ${escapeHtml(draft.description ?? "-")}</span>
              </li>
            `,
          )
          .join("");
  getElement<HTMLButtonElement>("#apply-draft").disabled = entries.length === 0;
}

function renderJobs(): void {
  const entries = Object.values(shell.workspace.state.jobs.entries);
  const terminal = entries.filter(
    (entry) => entry.snapshot.status === "successful" || entry.snapshot.status === "failed",
  );
  setText("#job-count", String(entries.length));
  setText("#terminal-job-count", `${terminal.length} terminal`);
  const list = getElement<HTMLElement>("#job-list");
  list.innerHTML =
    entries.length === 0
      ? "<li><strong>No jobs</strong><span>-</span></li>"
      : entries
          .map(
            (entry) => `
              <li>
                <strong>${escapeHtml(entry.type)}</strong>
                <span>${escapeHtml(entry.id)} / ${escapeHtml(entry.snapshot.status)}</span>
              </li>
            `,
          )
          .join("");
}

function renderSnapshotDiagnostics(): void {
  const diagnostics = createUnifiedOpsSnapshotDiagnostics(shell.workspace.state);
  setText("#snapshot-id", lastSnapshot?.id ?? "-");
  setText("#snapshot-status", lastSnapshot ? `saved ${formatTime(lastSnapshot.savedAt)}` : "not saved");
  const list = getElement<HTMLElement>("#diagnostic-list");
  const rows = [
    ["Sources", `${diagnostics.activeSourceCount}/${diagnostics.sourceCount} active`],
    ["Filters", String(diagnostics.filterCount)],
    ["Selection", String(diagnostics.selectedFeatureCount)],
    ["Records", String(diagnostics.realtimeRecordCount)],
    ["Panels", String(diagnostics.modulePanelCount)],
    ["Warnings", diagnostics.warnings.length === 0 ? "none" : diagnostics.warnings.join("; ")],
  ];
  list.innerHTML = rows
    .map(
      ([label, value]) => `
        <li data-warning="${String(label === "Warnings" && value !== "none")}">
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(value)}</span>
        </li>
      `,
    )
    .join("");
}

function renderContext(): void {
  const state = shell.workspace.state;
  getElement<HTMLElement>("#context-json").textContent = JSON.stringify(
    {
      activeViewId: state.layout.activeViewId,
      activeSources: activeSourceIds(state),
      filters: latestProjection.filters,
      extent: latestProjection.extent,
      selection: latestProjection.selection,
      jobs: Object.keys(state.jobs.entries),
      drafts: Object.keys(state.drafts.entries),
      layerFilter: shell.mapLayerFilters.filters[OPS_LAYER_ID],
    },
    null,
    2,
  );
}

function updateRuntime(result: UnifiedOpsProjectionResult): void {
  const state = shell.workspace.state;
  runtime.ready = true;
  runtime.activeModule = state.layout.activeViewId;
  runtime.visibleCount = result.incidentRows.length;
  runtime.selectedId = selectedFeatureId(latestProjection.selection) ?? null;
  runtime.filterCount = Object.keys(latestProjection.filters).length;
  runtime.stagedDraftCount = Object.keys(state.drafts.entries).length;
  runtime.appliedDraftCount = appliedDraftCount;
  runtime.realtimeStatus = state.realtime.features.status;
  runtime.snapshotId = lastSnapshot?.id ?? null;
  runtime.lastStep = lastStep;
}

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-module]").forEach((button) => {
    button.addEventListener("click", () => {
      setUnifiedOpsActiveModule(shell, button.dataset.module as UnifiedOpsModuleId);
      scheduleRender();
    });
  });
  getElement<HTMLInputElement>("#source-incident-ops").addEventListener("change", (event) => {
    setUnifiedOpsActiveSource(shell, INCIDENT_SOURCE_ID, (event.target as HTMLInputElement).checked);
    scheduleRender();
  });
  getElement<HTMLInputElement>("#source-response-crews").addEventListener("change", (event) => {
    setUnifiedOpsActiveSource(shell, CREW_SOURCE_ID, (event.target as HTMLInputElement).checked);
    scheduleRender();
  });
  getElement<HTMLSelectElement>("#status-filter").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    setFilterValue("status", "status", value);
  });
  getElement<HTMLSelectElement>("#severity-filter").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    shell.controllers.filters.clearFilter("aiCritical");
    setFilterValue("severity", "severity", value);
  });
  getElement<HTMLButtonElement>("#clear-filters").addEventListener("click", () => {
    shell.controllers.filters.clearFilter("status");
    shell.controllers.filters.clearFilter("severity");
    shell.controllers.filters.clearFilter("aiCritical");
    scheduleRender();
  });
  getElement<HTMLButtonElement>("#step-realtime").addEventListener("click", () => {
    runtime.step();
  });
  getElement<HTMLButtonElement>("#stage-ai-draft").addEventListener("click", () => {
    runtime.stageDraft("ai");
  });
  getElement<HTMLButtonElement>("#stage-mcp-draft").addEventListener("click", () => {
    runtime.stageDraft("mcp");
  });
  getElement<HTMLButtonElement>("#apply-draft").addEventListener("click", () => {
    runtime.applyDraft();
  });
  getElement<HTMLButtonElement>("#save-snapshot").addEventListener("click", () => {
    runtime.saveSnapshot();
  });
  getElement<HTMLButtonElement>("#restore-snapshot").addEventListener("click", () => {
    runtime.restoreSnapshot();
  });
  renderMapPresetButtons();
}

function renderMapPresetButtons(): void {
  const container = getElement<HTMLElement>("#map-presets");
  container.innerHTML = MAP_PRESETS.map(
    (preset) => `<button type="button" data-preset="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</button>`,
  ).join("");
  container.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const preset = MAP_PRESETS.find((entry) => entry.id === button.dataset.preset);
      if (!preset) return;
      setText("#extent-label", preset.label);
      moveUnifiedOpsMap(shell, preset.extent);
      scheduleRender();
    });
  });
}

function setFilterValue(id: string, field: string, value: string): void {
  if (!value) {
    shell.controllers.filters.clearFilter(id);
    scheduleRender();
    return;
  }
  shell.controllers.filters.setFilter(id, {
    field,
    operator: "=",
    value,
    appliesTo: [INCIDENT_SOURCE_ID],
  });
  scheduleRender();
}

function saveCurrentSnapshot() {
  const saved = saveUnifiedOpsSnapshot(shell);
  lastSavedDocument = saved.document;
  lastSnapshot = {
    id: saved.id,
    savedAt: saved.document.migration.savedAt,
  };
  scheduleRender();
  return saved;
}

function restoreCurrentSnapshot(): boolean {
  if (!lastSavedDocument) return false;
  const restored = restoreUnifiedOpsSnapshot(shell, lastSavedDocument);
  scheduleRender();
  return restored.ok;
}

function applyActiveDraft(): void {
  const draftId = shell.workspace.state.drafts.activeDraftId ?? Object.keys(shell.workspace.state.drafts.entries)[0];
  if (!draftId) return;
  applyUnifiedOpsDraft(shell, draftId);
  appliedDraftCount += 1;
  scheduleRender();
}

function sourceSelectionKey(selection: (typeof latestProjection.selection)[number]): string | undefined {
  if (typeof selection === "object" && "sourceId" in selection) {
    return `${selection.sourceId}:${selection.id}`;
  }
  return `${INCIDENT_SOURCE_ID}:${selection}`;
}

function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

bindQueryProjectionToExploration(
  shell.views.table,
  (projection) => {
    latestProjection = projection;
    scheduleRender();
  },
  { applyInitial: true, includeSelf: true },
);
bindDetailToSelection(shell.views.detail, () => scheduleRender());
shell.workspace.subscribe("all", () => scheduleRender());

bindControls();
renderAll();
