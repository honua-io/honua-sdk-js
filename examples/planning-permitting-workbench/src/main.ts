import { selectLinkedViewQueryProjection } from "@honua/sdk-js/exploration";
import {
  type LinkedViewQueryProjection,
  bindDetailToSelection,
  bindQueryProjectionToExploration,
} from "@honua/sdk-js/interactions";
import {
  type HonuaFeatureEditCommitDetail,
  type HonuaFeatureEditorCommit,
  type HonuaFeatureEditorElement,
  type HonuaFeatureEditorWorkflow,
  createFeatureEditorWorkflow,
} from "@honua/sdk-js/web-components";

import { SampleCleanupRegistry } from "../../_kit/cleanup.js";
import { announceSampleStatus, mountSamplePresentation } from "../../_kit/presentation.js";
import { FLOOD_CLASSES, MAP_PRESETS, PARCELS, ZONING_CLASSES } from "./fixtures.js";
import {
  DEFAULT_PROPOSAL,
  type PlanningAnalysisResult,
  type PlanningApplication,
  type PlanningPermittingJourney,
  type PlanningRecordAttributes,
  type PlanningScenario,
  type PlanningSearchResult,
  type PlanningSubmissionResult,
  createPlanningPermittingJourney,
} from "./journey.js";
import {
  type PermitDraft,
  buildPrintManifest,
  clearWorkbenchFilters,
  createPlanningWorkbench,
  findParcel,
  findPermit,
  floodClass,
  isRegulatedFloodZone,
  isWorkbenchLayerVisible,
  measureRing,
  moveWorkbenchMap,
  runWorkbenchQuery,
  selectParcel,
  selectZoningBucket,
  selectedParcelId,
  setFloodOnlyFilter,
  setWorkbenchActiveModule,
  setWorkbenchLayerVisible,
  setZoningFilter,
  sketchFootprintFromRing,
  visiblePermits,
  zoningClass,
} from "./model.js";
import { PARCEL_SOURCE_ID } from "./types.js";
import type {
  MeasureResult,
  ParcelFeature,
  PermitFeature,
  SketchFootprint,
  WorkbenchLayerId,
  WorkbenchModuleId,
  WorkbenchQueryResult,
  ZoningCode,
} from "./types.js";

import "../../_kit/presentation.css";
import "./styles.css";

declare const __HONUA_SAMPLE_SDK_MODE__: "source" | "packed";

interface WorkbenchRuntime {
  ready: boolean;
  sdkMode: "source" | "packed";
  workflowState: "connecting" | "ready" | "unavailable" | "disposed";
  workflowError?: string;
  searchFeatureId: number | null;
  analysisCandidateCount: number | null;
  lastScenario: PlanningScenario | null;
  lastSubmissionStatus: string | null;
  disposed: boolean;
  activeModule: string | undefined;
  parcelCount: number;
  filterCount: number;
  selectedParcelId: string | null;
  permitCount: number;
  editStatus: string;
  lastEditDegraded: boolean;
  sketchAcres: number;
  printId: string | null;
  /** Fixture-backed editor observability (issue #680 slice 2). */
  applicationCount: number;
  selectedApplicationId: number | null;
  editorStatus: string | null;
  editorOperation: string | null;
  editorConflict: boolean;
  lastCommitStatus: string | null;
  lastCommitTransported: boolean | null;
  lastCommittedFeatureId: number | null;
  reconciledVersion: number | null;
}

declare global {
  interface Window {
    __HONUA_PLANNING_WORKBENCH_RUNTIME__?: WorkbenchRuntime;
    __HONUA_PLANNING_WORKBENCH_DISPOSE__?: () => Promise<void>;
  }
}

const shell = createPlanningWorkbench();
const cleanup = new SampleCleanupRegistry();
const workflowController = new AbortController();
cleanup.add(() => shell.dispose());
cleanup.add(() => workflowController.abort());
let latestProjection: LinkedViewQueryProjection = selectLinkedViewQueryProjection(shell.exploration.state);
let renderQueued = false;

let draft = newPermitDraft();
let proposedHeightFeet = 28;
let lastEditStatus = "ready";
let lastEditMessage = "Connect, search, and analyze before submitting.";
let lastEditDegraded = false;
let activeSketch: SketchFootprint | undefined;
let activeMeasure: MeasureResult | undefined;
let lastPrintId: string | null = null;
let workflowState: WorkbenchRuntime["workflowState"] = "connecting";
let workflowError: string | undefined;
let planningJourney: PlanningPermittingJourney | undefined;
let planningSearch: PlanningSearchResult | undefined;
let planningAnalysis: PlanningAnalysisResult | undefined;
let lastPlanningSubmission: PlanningSubmissionResult | undefined;
let disposePromise: Promise<void> | undefined;
let searchInFlight = false;
let analysisInFlight = false;
let submissionInFlight = false;

let editorWorkflow: HonuaFeatureEditorWorkflow<PlanningRecordAttributes> | undefined;
let applications: readonly PlanningApplication[] = [];
let selectedApplicationId: number | undefined;
let applicationsInFlight = false;
let lastEditorCommit: HonuaFeatureEditorCommit | undefined;
let reconciledApplication: PlanningApplication | undefined;
let reconciliationMessage = "Select an application to edit, or start a new one for the searched parcel.";
let reconciliationDegraded = false;
let rehearsalMessage = "No rehearsal armed.";

const runtime: WorkbenchRuntime = {
  ready: false,
  sdkMode: __HONUA_SAMPLE_SDK_MODE__,
  workflowState,
  searchFeatureId: null,
  analysisCandidateCount: null,
  lastScenario: null,
  lastSubmissionStatus: null,
  disposed: false,
  activeModule: shell.workspace.state.layout.activeViewId,
  parcelCount: 0,
  filterCount: 0,
  selectedParcelId: null,
  permitCount: 0,
  editStatus: lastEditStatus,
  lastEditDegraded: false,
  sketchAcres: 0,
  printId: null,
  applicationCount: 0,
  selectedApplicationId: null,
  editorStatus: null,
  editorOperation: null,
  editorConflict: false,
  lastCommitStatus: null,
  lastCommitTransported: null,
  lastCommittedFeatureId: null,
  reconciledVersion: null,
};
window.__HONUA_PLANNING_WORKBENCH_RUNTIME__ = runtime;

const presentation = mountSamplePresentation({
  sampleId: "planning-permitting-workbench",
  evidence: {
    "SDK mode": __HONUA_SAMPLE_SDK_MODE__,
    fixture: "same-origin deterministic planning services",
    workflow: "public query, geocoding, geometry, edit session, attachments",
  },
  onDispose: disposeDemo,
});
window.__HONUA_PLANNING_WORKBENCH_DISPOSE__ = disposeDemo;
cleanup.add(() => {
  delete window.__HONUA_PLANNING_WORKBENCH_DISPOSE__;
});
cleanup.listen(window, "beforeunload", () => void disposeDemo(), { once: true });
cleanup.add(() => {
  for (const control of document.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
  >("input, select, textarea, button")) {
    control.disabled = true;
  }
});

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function setInputValue(selector: string, value: string): void {
  const element = getElement<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
  if (document.activeElement === element) return;
  element.value = value;
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

function newPermitDraft(): PermitDraft {
  const nextId = shell.permitSource.peekNextId();
  return {
    mode: "create",
    values: {
      OBJECTID: nextId,
      permit_no: `B2026-${String(1000 + nextId)}`,
      parcel_tmk: "3-8-001-014",
      permit_type: "residential",
      status: "intake",
      description: "New permit application.",
      applicant: "New applicant",
      reviewer: "Unassigned",
      valuation: 100_000,
      flood_review_required: false,
      version: 1,
      last_edited_date: new Date().toISOString(),
    },
    coordinate: [-156.5045, 20.8915],
  };
}

function draftFromPermit(permit: PermitFeature): PermitDraft {
  return {
    mode: "update",
    featureId: permit.id,
    values: { ...permit.attributes },
    coordinate: [permit.geometry.x, permit.geometry.y],
  };
}

function renderAll(): void {
  const state = shell.workspace.state;
  const projection = latestProjection;
  const parcelsActive = isWorkbenchLayerVisible(state, "parcels");
  const query = runWorkbenchQuery(projection, { parcelsActive });

  renderModules();
  renderLayers();
  renderLegend();
  renderPresets();
  renderMetrics(query);
  renderMap(query);
  renderParcelTable(query);
  renderChart(query);
  renderSketch(query);
  renderAnalysisTruth();
  renderPermitEditing();
  renderApplicationEditor();
  renderWorkflowTruth();
  renderDetail();
  renderContext(query);
  updateRuntime(query);
}

function renderModules(): void {
  const activeModule = (shell.workspace.state.layout.activeViewId ?? "review-board") as WorkbenchModuleId;
  document.querySelectorAll<HTMLButtonElement>("[data-module]").forEach((button) => {
    const active = button.dataset.module === activeModule;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  for (const module of ["review-board", "query-analysis", "permit-editing"] as const) {
    const panel = getElement<HTMLElement>(`#${module}-module`);
    const active = module === activeModule;
    panel.dataset.active = String(active);
    panel.hidden = !active;
  }
  setText("#context-active-view", activeModule);
}

function renderLayers(): void {
  const state = shell.workspace.state;
  const layers: WorkbenchLayerId[] = ["parcels", "zoning", "flood", "permits"];
  let on = 0;
  for (const layer of layers) {
    const visible = isWorkbenchLayerVisible(state, layer);
    if (visible) on += 1;
    getElement<HTMLInputElement>(`#layer-${layer}`).checked = visible;
    setText(`#${layer}-status`, visible ? statusFor(layer) : "off");
  }
  setText("#layer-count", `${on} on`);
}

function statusFor(layer: WorkbenchLayerId): string {
  if (layer !== "permits") return "ready";
  if (workflowState === "ready") return "metadata writable";
  if (workflowState === "unavailable") return "unavailable";
  if (workflowState === "disposed") return "disposed";
  return "checking";
}

function renderLegend(): void {
  getElement<HTMLElement>("#zoning-legend").innerHTML = ZONING_CLASSES.map(
    (zoning) => `
      <div class="legend-item">
        <span class="swatch" style="background:${escapeHtml(zoning.color)}"></span>
        <span>${escapeHtml(zoning.label)}</span>
      </div>`,
  ).join("");
  getElement<HTMLElement>("#flood-legend").innerHTML = FLOOD_CLASSES.map(
    (flood) => `
      <div class="legend-item">
        <span class="swatch" style="background:${escapeHtml(flood.color)}"></span>
        <span>${escapeHtml(flood.label)}${flood.regulated ? " (regulated)" : ""}</span>
      </div>`,
  ).join("");
}

function renderPresets(): void {
  const container = getElement<HTMLElement>("#map-presets");
  if (container.childElementCount > 0) return;
  container.innerHTML = MAP_PRESETS.map(
    (preset) => `<button type="button" data-preset="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</button>`,
  ).join("");
  container.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
    cleanup.listen(button, "click", () => {
      const preset = MAP_PRESETS.find((entry) => entry.id === button.dataset.preset);
      if (!preset) return;
      setText("#extent-label", preset.label);
      moveWorkbenchMap(shell, preset.extent);
      scheduleRender();
    });
  });
}

function renderMetrics(query: WorkbenchQueryResult): void {
  setText("#parcel-count", String(query.parcels.length));
  setText("#flood-count", String(query.floodExposed));
  setText("#assessed-total", formatCurrency(query.totalAssessedValue));
  setText("#aoi-count", String(query.parcels.length));
  setText("#filter-count", String(Object.keys(latestProjection.filters).length));
  setText("#selection-count", `${latestProjection.selection.length} selected`);
  setText("#extent-readout", formatExtent(latestProjection.extent));
  setText("#permit-count", String(visiblePermits(shell).length));
}

function renderMap(query: WorkbenchQueryResult): void {
  const map = getElement<HTMLElement>("#workbench-map");
  const extent = latestProjection.extent ?? MAP_PRESETS[0].extent;
  const permits = isWorkbenchLayerVisible(shell.workspace.state, "permits") ? visiblePermits(shell) : [];
  const selected = selectedParcelId(latestProjection.selection);
  map.innerHTML = `
    <div class="map-grid"></div>
    <div class="map-label top">Wailuku</div>
    <div class="map-label bottom">Kahului shore</div>
    ${query.parcels.map((parcel) => renderParcelPin(parcel, extent, selected)).join("")}
    ${permits.map((permit) => renderPermitPin(permit, extent)).join("")}
  `;
  map.querySelectorAll<HTMLButtonElement>(".map-pin[data-parcel]").forEach((pin) => {
    pin.addEventListener("click", () => {
      selectParcel(shell, pin.dataset.parcel ?? "");
      scheduleRender();
    });
  });
}

function renderParcelPin(
  parcel: ParcelFeature,
  extent: LinkedViewQueryProjection["extent"],
  selected?: string,
): string {
  const bounds = extent ?? MAP_PRESETS[0].extent;
  const x = clamp(((parcel.coordinate[0] - bounds.xmin) / (bounds.xmax - bounds.xmin)) * 100, 5, 95);
  const y = clamp(100 - ((parcel.coordinate[1] - bounds.ymin) / (bounds.ymax - bounds.ymin)) * 100, 5, 95);
  const color = zoningClass(parcel.zoning)?.color ?? "#888";
  return `
    <button
      type="button"
      class="map-pin"
      data-parcel="${escapeHtml(parcel.id)}"
      data-selected="${String(selected === parcel.id)}"
      data-flood="${String(isRegulatedFloodZone(parcel.floodZone))}"
      style="left:${x.toFixed(2)}%; top:${y.toFixed(2)}%; --pin-color:${escapeHtml(color)}"
      title="${escapeHtml(parcel.address)} (${escapeHtml(parcel.zoning)})"
      aria-label="Select ${escapeHtml(parcel.address)}"
    ><span>${escapeHtml(parcel.zoning)}</span></button>`;
}

function renderPermitPin(permit: PermitFeature, extent: LinkedViewQueryProjection["extent"]): string {
  const bounds = extent ?? MAP_PRESETS[0].extent;
  const x = clamp(((permit.geometry.x - bounds.xmin) / (bounds.xmax - bounds.xmin)) * 100, 5, 95);
  const y = clamp(100 - ((permit.geometry.y - bounds.ymin) / (bounds.ymax - bounds.ymin)) * 100, 5, 95);
  return `
    <span
      class="map-pin permit-pin"
      data-status="${escapeHtml(permit.attributes.status)}"
      style="left:${x.toFixed(2)}%; top:${y.toFixed(2)}%"
      title="${escapeHtml(permit.attributes.permit_no)} (${escapeHtml(permit.attributes.status)})"
    ><span>P</span></span>`;
}

function renderParcelTable(query: WorkbenchQueryResult): void {
  const body = getElement<HTMLElement>("#parcel-table-body");
  if (query.parcels.length === 0) {
    body.innerHTML = '<tr><td colspan="4">No parcels match the linked context.</td></tr>';
    return;
  }
  const selected = selectedParcelId(latestProjection.selection);
  body.innerHTML = query.parcels
    .map(
      (parcel) => `
        <tr data-selected="${String(selected === parcel.id)}">
          <td>${escapeHtml(parcel.tmk)}</td>
          <td><strong>${escapeHtml(parcel.address)}</strong><span>${escapeHtml(parcel.district)}</span></td>
          <td>${escapeHtml(parcel.zoning)}</td>
          <td><button type="button" data-open-parcel="${escapeHtml(parcel.id)}" aria-label="Open ${escapeHtml(parcel.address)}">Open</button></td>
        </tr>`,
    )
    .join("");
  body.querySelectorAll<HTMLButtonElement>("[data-open-parcel]").forEach((button) => {
    button.addEventListener("click", () => {
      selectParcel(shell, button.dataset.openParcel ?? "");
      scheduleRender();
    });
  });
}

function renderChart(query: WorkbenchQueryResult): void {
  const chart = getElement<HTMLElement>("#zoning-chart");
  const max = Math.max(1, ...query.buckets.map((bucket) => bucket.count));
  chart.innerHTML = query.buckets
    .map(
      (bucket) => `
        <button
          type="button"
          class="bucket"
          data-zoning="${escapeHtml(bucket.code)}"
          style="--bucket-size:${Math.max(6, Math.round((bucket.count / max) * 100))}%; --bucket-color:${escapeHtml(bucket.color)}"
        >
          <span>${escapeHtml(bucket.code)}</span>
          <strong>${bucket.count}</strong>
        </button>`,
    )
    .join("");
  chart.querySelectorAll<HTMLButtonElement>(".bucket").forEach((button) => {
    button.addEventListener("click", () => {
      const bucket = query.buckets.find((entry) => entry.code === button.dataset.zoning);
      if (!bucket || bucket.count === 0) return;
      selectZoningBucket(shell, bucket);
      scheduleRender();
    });
  });
}

function renderSketch(query: WorkbenchQueryResult): void {
  setText("#sketch-acres", activeSketch ? activeSketch.areaAcres.toFixed(2) : "0");
  setText("#measure-readout", activeMeasure ? `${activeMeasure.distanceMeters} m` : "0 m");
  setText("#sketch-status", activeSketch ? "AOI drawn" : "no sketch");
  const list = getElement<HTMLElement>("#sketch-readout");
  if (!activeSketch) {
    list.innerHTML =
      "<li><strong>No proposed footprint</strong><span>Sketch an AOI to run the flood check.</span></li>";
    return;
  }
  const floodParcels = query.parcels.filter((parcel) => isRegulatedFloodZone(parcel.floodZone));
  const rows = [
    ["Footprint area", `${activeSketch.areaAcres.toFixed(2)} acres`],
    ["Vertices", String(activeSketch.ring.length)],
    ["Measure", activeMeasure ? `${activeMeasure.distanceMeters} m over ${activeMeasure.segments} segs` : "not run"],
    [
      "Flood check",
      floodParcels.length > 0 ? `${floodParcels.length} regulated parcel(s) in AOI` : "clear of regulated zones",
    ],
  ];
  list.innerHTML = rows
    .map(
      ([label, value]) =>
        `<li data-warning="${String(label === "Flood check" && floodParcels.length > 0)}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></li>`,
    )
    .join("");
}

function renderAnalysisTruth(): void {
  const run = getElement<HTMLButtonElement>("#run-sdk-analysis");
  run.disabled = workflowState !== "ready" || !planningSearch || analysisInFlight;
  getElement<HTMLButtonElement>("#export-workspace").disabled =
    workflowState !== "ready" || !planningSearch || !planningAnalysis;
  if (workflowState !== "ready") {
    setText("#analysis-status", workflowState === "connecting" ? "checking capabilities" : workflowState);
    getElement<HTMLElement>("#analysis-truth-list").innerHTML =
      "<li><strong>Execution</strong><span>Disabled until metadata-backed discovery succeeds.</span></li>";
    return;
  }
  if (!planningSearch) {
    setText("#analysis-status", "search first");
    getElement<HTMLElement>("#analysis-truth-list").innerHTML =
      "<li><strong>Candidate query</strong><span>Blocked until a parcel is selected.</span></li>";
    return;
  }
  if (!planningAnalysis) {
    setText("#analysis-status", "ready");
    getElement<HTMLElement>("#analysis-truth-list").innerHTML =
      "<li><strong>Candidate query</strong><span>Ready; capped before client geometry executes.</span></li>";
    return;
  }
  setText("#analysis-status", planningAnalysis.intersectsFloodHazard ? "hazard overlap" : "no hazard overlap");
  getElement<HTMLElement>("#analysis-truth-list").innerHTML = [
    ["Source bound", `${planningAnalysis.boundedCandidateCount} / ${planningAnalysis.candidateLimit} candidates`],
    ["Proposal area", `${planningAnalysis.proposalAreaSquareMeters.toLocaleString()} m²`],
    ["Hazard overlap", `${planningAnalysis.hazardOverlapSquareMeters.toLocaleString()} m²`],
    ["Fidelity", `${planningAnalysis.fidelity.status}; ${planningAnalysis.fidelity.crs}`],
  ]
    .map(([label, value]) => `<li><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></li>`)
    .join("");
}

function renderWorkflowTruth(): void {
  getElement<HTMLButtonElement>("#search-submit").disabled = workflowState !== "ready" || searchInFlight;
  setText("#workflow-state", workflowState);
  const list = getElement<HTMLElement>("#workflow-truth-list");
  const degradation = getElement<HTMLElement>("#workflow-degradation");
  if (workflowState !== "ready" || !planningJourney) {
    list.innerHTML = [
      ["SDK mode", __HONUA_SAMPLE_SDK_MODE__],
      ["Discovery", workflowState === "connecting" ? "pending" : "failed closed"],
      ["Mutation", "disabled"],
    ]
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join("");
    degradation.textContent =
      workflowState === "connecting"
        ? "Waiting for metadata discovery; no mutation can be attempted."
        : workflowState === "disposed"
          ? "Demo resources are disposed and controls are disabled."
          : `Public workflow unavailable; analysis and mutation are disabled. ${workflowError ?? "No capability truth was returned."}`;
    degradation.dataset.degraded = "true";
    return;
  }

  const inspection = planningJourney.inspection();
  const descriptor = inspection.sources[0]?.descriptor;
  const hasVersionField = planningJourney.metadataFields().some((field) => field.name === "version");
  list.innerHTML = [
    ["SDK mode", __HONUA_SAMPLE_SDK_MODE__],
    ["Discovery", inspection.sources[0]?.discovery ?? "unavailable"],
    ["Protocol", descriptor?.protocol ?? "unavailable"],
    ["Query", descriptor?.capabilities.has("query") ? "supported" : "unsupported"],
    ["Edits", descriptor?.capabilities.has("applyEdits") ? "supported" : "unsupported"],
    ["Attachments", descriptor?.capabilities.has("attachments") ? "supported" : "unsupported"],
    ["Conflict metadata", hasVersionField ? "version field advertised" : "unsupported"],
    ["Selected parcel", planningSearch?.attributes.parcel_tmk ?? "none"],
    ["Last submission", lastPlanningSubmission?.status ?? "none"],
    ["Optimistic state", lastPlanningSubmission?.optimisticTransitions.join(" → ") || "none"],
  ]
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  if (lastPlanningSubmission && lastPlanningSubmission.status !== "succeeded") {
    degradation.textContent = lastPlanningSubmission.recovery;
    degradation.dataset.degraded = "true";
  } else if (!planningSearch) {
    degradation.textContent = "Search and bounded analysis are required before mutation is enabled.";
    degradation.dataset.degraded = "false";
  } else if (!planningAnalysis) {
    degradation.textContent = "Parcel selected; run bounded analysis before mutation is enabled.";
    degradation.dataset.degraded = "false";
  } else {
    degradation.textContent = "Metadata, bounded analysis, and mutation capabilities are explicit.";
    degradation.dataset.degraded = "false";
  }
}

function renderPermitEditing(): void {
  const permits = visiblePermits(shell);
  const list = getElement<HTMLElement>("#permit-list");
  list.innerHTML =
    permits.length === 0
      ? "<li><strong>No permits</strong><span>-</span></li>"
      : permits
          .map(
            (permit) => `
              <li data-active="${String(draft.featureId === permit.id)}">
                <button type="button" data-edit-permit="${permit.id}">
                  <strong>${escapeHtml(permit.attributes.permit_no)}</strong>
                  <span>${escapeHtml(permit.attributes.permit_type)} / ${escapeHtml(permit.attributes.status)}</span>
                </button>
              </li>`,
          )
          .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-edit-permit]").forEach((button) => {
    button.addEventListener("click", () => {
      const permit = findPermit(shell, Number(button.dataset.editPermit));
      if (!permit) return;
      draft = draftFromPermit(permit);
      lastEditStatus = "ready";
      lastEditMessage = `Editing ${permit.attributes.permit_no}.`;
      lastEditDegraded = false;
      scheduleRender();
    });
  });

  setText("#permit-mode", draft.mode);
  setText("#permit-count", String(permits.length));
  setText("#edit-permit-no", draft.values.permit_no);
  setText("#edit-status-readout", lastEditStatus);
  setInputValue("#edit-parcel-field", planningSearch?.attributes.parcel_tmk ?? draft.values.parcel_tmk);
  setInputValue("#edit-type-field", draft.values.permit_type);
  setInputValue("#edit-status-field", draft.values.status);
  setInputValue("#edit-height-field", String(proposedHeightFeet));
  setInputValue("#edit-description-field", draft.values.description);

  const message = getElement<HTMLElement>("#edit-message");
  message.textContent = lastEditMessage;
  message.dataset.degraded = String(lastEditDegraded);

  const canEdit = workflowState === "ready" && planningJourney !== undefined && planningSearch !== undefined;
  const canSubmit = canEdit && planningAnalysis !== undefined;
  for (const selector of [
    "#edit-type-field",
    "#edit-status-field",
    "#edit-height-field",
    "#edit-description-field",
    "#permit-scenario",
    "#force-conflict",
  ]) {
    getElement<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(selector).disabled =
      !canEdit;
  }
  const save = getElement<HTMLButtonElement>("#save-permit");
  save.disabled = !canSubmit || submissionInFlight;
  save.title = canSubmit ? "" : "Search and bounded analysis must succeed before submission.";

  const descriptor = planningJourney?.inspection().sources[0]?.descriptor;
  const readiness =
    workflowState === "ready" && descriptor
      ? [
          ["Query", descriptor.capabilities.has("query") ? "supported by metadata" : "unsupported"],
          ["Apply edits", descriptor.capabilities.has("applyEdits") ? "supported by metadata" : "unsupported"],
          ["Attachments", descriptor.capabilities.has("attachments") ? "supported by metadata" : "unsupported"],
          [
            "Conflict",
            planningJourney?.metadataFields().some((field) => field.name === "version")
              ? "version field advertised"
              : "unsupported",
          ],
          ["Workflow precondition", canSubmit ? "search and analysis complete" : "mutation disabled"],
        ]
      : [["Workflow", workflowState === "connecting" ? "metadata discovery pending" : "failed closed"]];
  setText(
    "#edit-capability-state",
    workflowState === "ready" ? (canSubmit ? "ready" : "preconditions pending") : workflowState,
  );
  getElement<HTMLElement>("#edit-readiness-list").innerHTML = readiness
    .map(
      ([capability, state]) => `<li><strong>${escapeHtml(capability)}</strong><span>${escapeHtml(state)}</span></li>`,
    )
    .join("");
}

/**
 * Fixture-backed editing surface: the production `<honua-feature-editor>` bound
 * to the same metadata-discovered writable `Source` the journey inspects. The
 * shell owns selection, prefill, and reconciliation; the widget owns the
 * schema-derived form, geometry, attachments, validation, and failure truth.
 */
function renderApplicationEditor(): void {
  const list = getElement<HTMLElement>("#application-list");
  list.innerHTML =
    applications.length === 0
      ? `<li><strong>${escapeHtml(applicationsInFlight ? "Reading applications" : "No applications on file")}</strong><span>-</span></li>`
      : applications
          .map((application) => {
            const attributes = application.attributes;
            return `
              <li data-active="${String(selectedApplicationId === application.id)}">
                <button type="button" data-application="${escapeHtml(String(application.id))}">
                  <strong>${escapeHtml(attributes.permit_no)}</strong>
                  <span>${escapeHtml(attributes.status)} / v${escapeHtml(attributes.version ?? "-")} / ${escapeHtml(attributes.address)}</span>
                </button>
              </li>`;
          })
          .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-application]").forEach((button) => {
    button.addEventListener("click", () => selectApplication(Number(button.dataset.application)));
  });

  const snapshot = editorWorkflow?.snapshot();
  const editorReady = workflowState === "ready" && editorWorkflow !== undefined;
  setText(
    "#source-editor-state",
    editorReady
      ? applicationsInFlight
        ? "re-reading"
        : `${applications.length} on file`
      : workflowState === "connecting"
        ? "connecting"
        : "unavailable",
  );
  getElement<HTMLButtonElement>("#application-new").disabled = !editorReady || planningSearch === undefined;
  getElement<HTMLButtonElement>("#application-refresh").disabled = !editorReady || applicationsInFlight;
  getElement<HTMLButtonElement>("#rehearse-concurrent-edit").disabled =
    !editorReady || selectedApplicationId === undefined;
  getElement<HTMLButtonElement>("#rehearse-service-outage").disabled = !editorReady;
  getElement<HTMLElement>("#rehearsal-status").textContent = rehearsalMessage;

  setText(
    "#reconciliation-state",
    lastEditorCommit === undefined ? "no submission" : `${lastEditorCommit.operation}: ${lastEditorCommit.status}`,
  );
  const reconciled = reconciledApplication;
  getElement<HTMLElement>("#reconciliation-list").innerHTML = (
    [
      ["Editor state", snapshot?.status ?? "not attached"],
      ["Draft operation", snapshot?.operation ?? "none"],
      ["Transported", lastEditorCommit === undefined ? "n/a" : String(lastEditorCommit.transported)],
      ["Committed id", lastEditorCommit?.committedFeatureId ?? "none"],
      ["Re-read version", reconciled?.attributes.version ?? "none"],
      ["Re-read status", reconciled?.attributes.status ?? "none"],
    ] as ReadonlyArray<readonly [string, unknown]>
  )
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  const message = getElement<HTMLElement>("#reconciliation-message");
  message.textContent = reconciliationMessage;
  message.dataset.degraded = String(reconciliationDegraded);
}

/**
 * Whether the editor is holding work a person would lose. A committed draft is
 * finished, so it is not "unsaved" — every other dirty draft is.
 */
function hasUnsavedDraft(): boolean {
  const snapshot = editorWorkflow?.snapshot();
  if (!snapshot || snapshot.form === undefined) return false;
  return snapshot.dirty && snapshot.status !== "committed";
}

function refuseWhileUnsaved(action: string): boolean {
  if (!hasUnsavedDraft()) return false;
  reconciliationMessage = `Submit or cancel the open draft before ${action}.`;
  reconciliationDegraded = true;
  announceSampleStatus(reconciliationMessage);
  scheduleRender();
  return true;
}

function selectApplication(featureId: number): void {
  const application = applications.find((candidate) => candidate.id === featureId);
  if (!application || !editorWorkflow) return;
  // An open draft owns its identity: never switch the selection out from under
  // unsaved work, and never silently discard it.
  if (refuseWhileUnsaved("switching to another application")) return;
  const snapshot = editorWorkflow.snapshot();
  // A committed draft is closed by `setSelection` itself; cancelling it here
  // would claim nothing was sent, which is untrue.
  if (snapshot.form !== undefined && snapshot.status !== "committed") editorWorkflow.cancel();
  selectedApplicationId = featureId;
  reconciledApplication = application;
  editorWorkflow.setSelection(application);
  reconciliationMessage = `Selected ${application.attributes.permit_no}. Choose Edit in the feature editor to open a draft.`;
  reconciliationDegraded = false;
  announceSampleStatus(`Selected planning application ${application.attributes.permit_no}.`);
  scheduleRender();
}

function startApplicationDraft(): void {
  if (!planningJourney || !editorWorkflow || !planningSearch) return;
  // `begin("create")` replaces whatever draft is open, so the same rule the
  // selection path enforces applies here: unsaved work is never discarded to
  // start a new application.
  if (refuseWhileUnsaved("starting a new application")) return;
  const base = planningJourney.createDraft(DEFAULT_PROPOSAL);
  editorWorkflow.begin("create");
  editorWorkflow.setValues({ ...base.values });
  editorWorkflow.setGeometry("point", { ...base.geometry });
  reconciliationMessage = `New application drafted for parcel ${planningSearch.attributes.parcel_tmk}; review the metadata-derived form, then submit.`;
  reconciliationDegraded = false;
  scheduleRender();
}

async function refreshApplications(focusFeatureId?: number): Promise<void> {
  if (!planningJourney) return;
  applicationsInFlight = true;
  scheduleRender();
  try {
    const next = await planningJourney.listApplications();
    workflowController.signal.throwIfAborted();
    applications = next;
    const focus = focusFeatureId ?? selectedApplicationId;
    reconciledApplication = focus === undefined ? undefined : next.find((candidate) => candidate.id === focus);
    if (focusFeatureId !== undefined) selectedApplicationId = focusFeatureId;
  } catch (error) {
    if (workflowController.signal.aborted) return;
    reconciliationMessage = safeErrorMessage(error);
    reconciliationDegraded = true;
    presentation.showError(error);
  } finally {
    applicationsInFlight = false;
    scheduleRender();
  }
}

/**
 * Whether the feature write itself reached the service. True for a clean
 * commit, and also for the partial outcome where the feature edit applied and
 * only an attachment was refused — the record on file has moved either way, so
 * the shell must re-read it either way.
 */
function featureEditLanded(commit: HonuaFeatureEditorCommit): boolean {
  if (commit.status === "committed") return true;
  if (!commit.transported) return false;
  if (!commit.attachments.some((attachment) => attachment.status === "failed")) return false;
  return commit.failures.every((failure) => failure.operation.startsWith("attachment-"));
}

async function handleEditorCommit(commit: HonuaFeatureEditorCommit): Promise<void> {
  lastEditorCommit = commit;
  const landed = featureEditLanded(commit);
  const featureId =
    numberOrNull(commit.committedFeatureId) ??
    numberOrNull(editorWorkflow?.snapshot().identity?.featureId) ??
    selectedApplicationId ??
    undefined;
  const reconciled = landed && featureId !== undefined ? await reconcileCommittedRecord(featureId) : undefined;

  if (commit.status === "committed") {
    reconciliationMessage = reconciled
      ? `Service re-read confirms ${reconciled.attributes.permit_no} at version ${String(reconciled.attributes.version)} with status ${reconciled.attributes.status}.`
      : "The service accepted the edit; the re-read did not return the committed record.";
    reconciliationDegraded = reconciled === undefined;
    presentation.clearStatus();
    announceSampleStatus(`Planning application ${commit.operation} committed and reconciled from the source.`);
  } else {
    reconciliationMessage = editorRecovery(commit, reconciled);
    reconciliationDegraded = true;
    presentation.showDegradation([reconciliationMessage]);
    announceSampleStatus(`Planning application ${commit.operation} did not commit: ${commit.status}.`);
  }
  scheduleRender();
}

/**
 * Re-reads the record the service just wrote and moves every local view of it
 * onto that server truth.
 *
 * - A committed draft is finished, so the editor's selection is rebound to the
 *   re-read record; the next `update` then opens on the fresh concurrency token
 *   instead of the one the commit consumed.
 * - A partial outcome leaves the draft open on purpose (the attachment still
 *   needs recovering), so only the concurrency token is adopted into it. Retry
 *   then re-transports against the version now on file rather than the stale
 *   one the service would have to reject.
 */
async function reconcileCommittedRecord(featureId: number): Promise<PlanningApplication | undefined> {
  await refreshApplications(featureId);
  const reconciled = reconciledApplication;
  const workflow = editorWorkflow;
  if (!reconciled || !workflow) return reconciled;
  const snapshot = workflow.snapshot();
  if (snapshot.form === undefined || snapshot.status === "committed") {
    workflow.setSelection(reconciled);
    return reconciled;
  }
  workflow.adoptServerState(reconciled);
  return reconciled;
}

/** Explicit, non-optimistic recovery guidance for every rejected editor commit. */
function editorRecovery(commit: HonuaFeatureEditorCommit, reconciled: PlanningApplication | undefined): string {
  if (!commit.transported) {
    return `Nothing was sent to the service: ${commit.failures[0]?.description ?? "the draft was refused before transport"}.`;
  }
  if (commit.status === "conflict") {
    return "The service reported a version conflict. Resolve it in the editor, then retry or reload the feature.";
  }
  const attachmentFailure = commit.attachments.find((attachment) => attachment.status === "failed");
  if (attachmentFailure) {
    const adopted = reconciled
      ? ` The record is now at version ${String(reconciled.attributes.version)} and the open draft adopted that version, so Retry re-sends against it.`
      : "";
    return `The feature edit reached the service but ${attachmentFailure.name} was rejected (${attachmentFailure.error ?? "no reason given"}).${adopted} Retry the attachment separately.`;
  }
  return `The service rejected the ${commit.operation}: ${commit.failures[0]?.description ?? "no reason given"}.`;
}

async function rehearseConcurrentEdit(): Promise<void> {
  if (!planningJourney || !editorWorkflow) return;
  const identity = editorWorkflow.snapshot().identity?.featureId;
  const featureId = Number(identity ?? selectedApplicationId);
  if (!Number.isFinite(featureId)) {
    rehearsalMessage = "Select an application before rehearsing a concurrent reviewer edit.";
    scheduleRender();
    return;
  }
  try {
    const response = await planningFetch(`${window.location.origin}/__fixture__/concurrent-edit?objectId=${featureId}`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(`The fixture refused the concurrent edit (${response.status}).`);
    const fresh = await planningJourney.loadApplication(featureId);
    workflowController.signal.throwIfAborted();
    if (!fresh) throw new Error("The concurrently edited application could not be re-read.");
    const outcome = editorWorkflow.applyExternalChange(fresh);
    rehearsalMessage = `Another reviewer saved version ${String(fresh.attributes.version)}; the open draft reconciled as “${outcome}”.`;
    await refreshApplications();
    announceSampleStatus(`Concurrent reviewer edit reconciled as ${outcome}.`);
  } catch (error) {
    if (workflowController.signal.aborted) return;
    rehearsalMessage = safeErrorMessage(error);
    presentation.showError(error);
  } finally {
    scheduleRender();
  }
}

async function rehearseServiceOutage(): Promise<void> {
  try {
    const response = await planningFetch(`${window.location.origin}/__fixture__/arm-update-fault`, { method: "POST" });
    if (!response.ok) throw new Error(`The fixture refused to arm the outage (${response.status}).`);
    rehearsalMessage = "A one-shot service outage is armed: the next update is rejected and a retry can still succeed.";
    announceSampleStatus("Armed a one-shot planning service outage.");
  } catch (error) {
    if (workflowController.signal.aborted) return;
    rehearsalMessage = safeErrorMessage(error);
    presentation.showError(error);
  } finally {
    scheduleRender();
  }
}

function renderDetail(): void {
  const parcelId = selectedParcelId(latestProjection.selection);
  const parcel = findParcel(parcelId);
  const warning = getElement<HTMLElement>("#flood-warning");
  if (!parcel) {
    setText("#detail-source", "-");
    setText("#detail-title", "No selected parcel");
    setText("#detail-summary", "-");
    getElement<HTMLElement>("#detail-attributes").innerHTML = "";
    warning.dataset.active = "false";
    warning.textContent = "";
    return;
  }
  const zoning = zoningClass(parcel.zoning);
  const flood = floodClass(parcel.floodZone);
  setText("#detail-source", PARCEL_SOURCE_ID);
  setText("#detail-title", parcel.address);
  setText("#detail-summary", `${zoning?.label ?? parcel.zoning} — owned by ${parcel.ownerName}`);
  getElement<HTMLElement>("#detail-attributes").innerHTML = [
    ["TMK", parcel.tmk],
    ["Zoning", zoning?.label ?? parcel.zoning],
    ["Max height", zoning ? `${zoning.maxHeightFeet} ft` : "-"],
    ["Flood zone", flood?.label ?? parcel.floodZone],
    ["Acreage", `${parcel.acreage} ac`],
    ["Assessed", formatCurrency(parcel.assessedValue)],
    ["District", parcel.district],
  ]
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");

  if (isRegulatedFloodZone(parcel.floodZone)) {
    warning.dataset.active = "true";
    warning.textContent = `Regulated flood zone ${parcel.floodZone}: flood review required for permits on this parcel.`;
  } else {
    warning.dataset.active = "false";
    warning.textContent = "";
  }
}

function renderContext(query: WorkbenchQueryResult): void {
  getElement<HTMLElement>("#context-json").textContent = JSON.stringify(
    {
      activeViewId: shell.workspace.state.layout.activeViewId,
      filters: latestProjection.filters,
      extent: latestProjection.extent,
      selection: latestProjection.selection,
      parcelsInContext: query.parcels.length,
      floodExposed: query.floodExposed,
      sketchAcres: activeSketch?.areaAcres ?? null,
    },
    null,
    2,
  );
}

function updateRuntime(query: WorkbenchQueryResult): void {
  runtime.ready = workflowState === "ready" || workflowState === "unavailable";
  runtime.workflowState = workflowState;
  runtime.workflowError = workflowError;
  runtime.searchFeatureId = planningSearch?.featureId ?? null;
  runtime.analysisCandidateCount = planningAnalysis?.boundedCandidateCount ?? null;
  runtime.lastScenario = lastPlanningSubmission?.scenario ?? null;
  runtime.lastSubmissionStatus = lastPlanningSubmission?.status ?? null;
  runtime.disposed = workflowState === "disposed";
  runtime.activeModule = shell.workspace.state.layout.activeViewId;
  runtime.parcelCount = query.parcels.length;
  runtime.filterCount = Object.keys(latestProjection.filters).length;
  runtime.selectedParcelId = selectedParcelId(latestProjection.selection) ?? null;
  runtime.permitCount = visiblePermits(shell).length;
  runtime.editStatus = lastEditStatus;
  runtime.lastEditDegraded = lastEditDegraded;
  runtime.sketchAcres = activeSketch?.areaAcres ?? 0;
  runtime.printId = lastPrintId;

  const editorSnapshot = editorWorkflow?.snapshot();
  runtime.applicationCount = applications.length;
  runtime.selectedApplicationId = selectedApplicationId ?? null;
  runtime.editorStatus = editorSnapshot?.status ?? null;
  runtime.editorOperation = editorSnapshot?.operation ?? null;
  runtime.editorConflict = editorSnapshot?.conflict !== undefined;
  runtime.lastCommitStatus = lastEditorCommit?.status ?? null;
  runtime.lastCommitTransported = lastEditorCommit?.transported ?? null;
  runtime.lastCommittedFeatureId = numberOrNull(lastEditorCommit?.committedFeatureId);
  runtime.reconciledVersion = numberOrNull(reconciledApplication?.attributes.version);
}

function numberOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function renderSearchResults(term: string): void {
  const list = getElement<HTMLElement>("#search-results");
  const trimmed = term.trim().toLowerCase();
  if (!trimmed) {
    list.innerHTML = "";
    return;
  }
  const matches = PARCELS.filter(
    (parcel) =>
      parcel.address.toLowerCase().includes(trimmed) ||
      parcel.tmk.toLowerCase().includes(trimmed) ||
      parcel.ownerName.toLowerCase().includes(trimmed),
  ).slice(0, 5);
  list.innerHTML =
    matches.length === 0
      ? "<li><strong>No match</strong><span>-</span></li>"
      : matches
          .map(
            (parcel) => `
              <li>
                <button type="button" data-search-parcel="${escapeHtml(parcel.id)}">
                  <strong>${escapeHtml(parcel.address)}</strong>
                  <span>${escapeHtml(parcel.tmk)} / ${escapeHtml(parcel.zoning)}</span>
                </button>
              </li>`,
          )
          .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-search-parcel]").forEach((button) => {
    button.addEventListener("click", () => {
      const parcel = findParcel(button.dataset.searchParcel);
      if (!parcel) return;
      getElement<HTMLInputElement>("#search-input").value = parcel.address;
      void handlePlanningSearch(parcel.address);
    });
  });
}

async function handlePlanningSearch(address: string): Promise<void> {
  if (!planningJourney || workflowState !== "ready" || searchInFlight) {
    announceSampleStatus("Planning search is unavailable until metadata discovery succeeds.");
    return;
  }
  searchInFlight = true;
  setText("#search-status", "searching");
  scheduleRender();
  try {
    const search = await planningJourney.search(address);
    workflowController.signal.throwIfAborted();
    planningSearch = search;
    planningAnalysis = undefined;
    lastPlanningSubmission = undefined;
    const parcel = PARCELS.find((candidate) => candidate.tmk === search.attributes.parcel_tmk);
    if (parcel) {
      moveWorkbenchMap(shell, presetForParcel(parcel));
      selectParcel(shell, parcel.id);
      draft = {
        ...draft,
        values: {
          ...draft.values,
          parcel_tmk: parcel.tmk,
          permit_type: search.attributes.permit_type as PermitDraft["values"]["permit_type"],
          status: "intake",
          description: search.attributes.description,
        },
        coordinate: parcel.coordinate,
      };
    }
    setText("#search-status", "parcel selected");
    lastEditMessage = "Parcel selected. Run bounded analysis before submitting.";
    lastEditDegraded = false;
    presentation.clearStatus();
    announceSampleStatus(`Selected parcel ${search.attributes.parcel_tmk} from the public source query.`);
  } catch (error) {
    if (workflowController.signal.aborted) return;
    setText("#search-status", "search failed");
    lastEditMessage = safeErrorMessage(error);
    lastEditDegraded = true;
    presentation.showError(error);
  } finally {
    searchInFlight = false;
    getElement<HTMLElement>("#search-results").replaceChildren();
    scheduleRender();
  }
}

async function handlePlanningAnalysis(): Promise<void> {
  if (!planningJourney || !planningSearch || workflowState !== "ready" || analysisInFlight) {
    announceSampleStatus("Bounded analysis requires a selected parcel and available public workflow.");
    return;
  }
  analysisInFlight = true;
  setText("#analysis-status", "running");
  scheduleRender();
  try {
    planningAnalysis = await planningJourney.analyze(DEFAULT_PROPOSAL);
    workflowController.signal.throwIfAborted();
    lastEditMessage = "Bounded source query and exact client geometry completed; submission is enabled.";
    lastEditDegraded = false;
    presentation.clearStatus();
    announceSampleStatus(
      `Bounded analysis completed with ${planningAnalysis.boundedCandidateCount} of ${planningAnalysis.candidateLimit} candidates.`,
    );
  } catch (error) {
    if (workflowController.signal.aborted) return;
    planningAnalysis = undefined;
    lastEditMessage = safeErrorMessage(error);
    lastEditDegraded = true;
    presentation.showError(error);
  } finally {
    analysisInFlight = false;
    scheduleRender();
  }
}

function presetForParcel(parcel: ParcelFeature) {
  return parcel.district === "Kahului" ? MAP_PRESETS[2].extent : MAP_PRESETS[1].extent;
}

function bindControls(): void {
  const moduleTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-module]")];
  moduleTabs.forEach((button) => {
    cleanup.listen(button, "click", () => {
      setWorkbenchActiveModule(shell, button.dataset.module as WorkbenchModuleId);
      scheduleRender();
    });
    cleanup.listen(button, "keydown", (event) => {
      if (!(event instanceof KeyboardEvent) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const current = moduleTabs.indexOf(button);
      const target =
        event.key === "Home"
          ? moduleTabs[0]
          : event.key === "End"
            ? moduleTabs[moduleTabs.length - 1]
            : event.key === "ArrowRight"
              ? moduleTabs[(current + 1) % moduleTabs.length]
              : moduleTabs[(current - 1 + moduleTabs.length) % moduleTabs.length];
      if (!target) return;
      setWorkbenchActiveModule(shell, target.dataset.module as WorkbenchModuleId);
      target.focus();
      scheduleRender();
    });
  });

  (["parcels", "zoning", "flood", "permits"] as const).forEach((layer) => {
    cleanup.listen(getElement<HTMLInputElement>(`#layer-${layer}`), "change", (event) => {
      setWorkbenchLayerVisible(shell, layer, (event.target as HTMLInputElement).checked);
      scheduleRender();
    });
  });

  populateZoningFilter();
  cleanup.listen(getElement<HTMLSelectElement>("#zoning-filter"), "change", (event) => {
    setZoningFilter(shell, (event.target as HTMLSelectElement).value as ZoningCode | "");
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLInputElement>("#flood-filter"), "change", (event) => {
    setFloodOnlyFilter(shell, (event.target as HTMLInputElement).checked);
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#clear-filters"), "click", () => {
    clearWorkbenchFilters(shell);
    getElement<HTMLSelectElement>("#zoning-filter").value = "";
    getElement<HTMLInputElement>("#flood-filter").checked = false;
    scheduleRender();
  });

  cleanup.listen(getElement<HTMLInputElement>("#search-input"), "input", (event) => {
    renderSearchResults((event.target as HTMLInputElement).value);
  });
  cleanup.listen(getElement<HTMLFormElement>("#planning-search-form"), "submit", (event) => {
    event.preventDefault();
    void handlePlanningSearch(getElement<HTMLInputElement>("#search-input").value.trim());
  });
  cleanup.listen(getElement<HTMLButtonElement>("#run-sdk-analysis"), "click", () => {
    void handlePlanningAnalysis();
  });

  cleanup.listen(getElement<HTMLButtonElement>("#sketch-footprint"), "click", () => {
    activeSketch = sketchFootprintFromRing(sampleAoiRing());
    activeMeasure = undefined;
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#measure-footprint"), "click", () => {
    activeMeasure = measureRing(activeSketch ? [...activeSketch.ring, activeSketch.ring[0]] : sampleAoiRing());
    if (!activeSketch) activeSketch = sketchFootprintFromRing(sampleAoiRing());
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#clear-sketch"), "click", () => {
    activeSketch = undefined;
    activeMeasure = undefined;
    scheduleRender();
  });

  cleanup.listen(getElement<HTMLButtonElement>("#generate-print"), "click", () => {
    const manifest = buildPrintManifest(shell, { sketch: activeSketch, measure: activeMeasure });
    lastPrintId = manifest.id;
    setText("#print-status", "generated");
    getElement<HTMLElement>("#print-json").textContent = JSON.stringify(manifest, null, 2);
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#export-workspace"), "click", () => {
    if (!planningJourney || !planningSearch || !planningAnalysis || workflowState !== "ready") {
      setText("#print-status", "blocked");
      getElement<HTMLElement>("#print-json").textContent =
        "Planning review export requires metadata discovery, parcel search, and bounded analysis.";
      announceSampleStatus("Planning review export is blocked until search and bounded analysis succeed.");
      return;
    }
    lastPrintId = `planning-review-${planningSearch.featureId}`;
    setText("#print-status", "planning review exported");
    getElement<HTMLElement>("#print-json").textContent = planningJourney.exportReview();
    announceSampleStatus("Exported the public SDK planning review model.");
    scheduleRender();
  });

  cleanup.listen(getElement<HTMLButtonElement>("#new-permit"), "click", () => {
    draft = newPermitDraft();
    proposedHeightFeet = 28;
    lastEditStatus = "ready";
    lastEditMessage = "New permit draft.";
    lastEditDegraded = false;
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLSelectElement>("#edit-type-field"), "change", (event) => {
    draft = {
      ...draft,
      values: {
        ...draft.values,
        permit_type: (event.target as HTMLSelectElement).value as PermitDraft["values"]["permit_type"],
      },
    };
  });
  cleanup.listen(getElement<HTMLSelectElement>("#edit-status-field"), "change", (event) => {
    draft = {
      ...draft,
      values: { ...draft.values, status: (event.target as HTMLSelectElement).value as PermitDraft["values"]["status"] },
    };
  });
  cleanup.listen(getElement<HTMLInputElement>("#edit-height-field"), "input", (event) => {
    proposedHeightFeet = Number((event.target as HTMLInputElement).value) || 0;
  });
  cleanup.listen(getElement<HTMLTextAreaElement>("#edit-description-field"), "input", (event) => {
    draft = { ...draft, values: { ...draft.values, description: (event.target as HTMLTextAreaElement).value } };
  });
  cleanup.listen(getElement<HTMLSelectElement>("#permit-scenario"), "change", (event) => {
    const scenario = (event.target as HTMLSelectElement).value as PlanningScenario;
    lastEditMessage = `Selected deterministic ${scenario} scenario.`;
    lastEditDegraded = false;
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#force-conflict"), "click", () => {
    getElement<HTMLSelectElement>("#permit-scenario").value = "conflict";
    lastEditMessage = "Conflict selected; the fixture will return a version conflict without hiding it.";
    lastEditDegraded = false;
    scheduleRender();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#save-permit"), "click", () => {
    void handleSavePermit();
  });

  cleanup.listen(getElement<HTMLButtonElement>("#application-new"), "click", () => startApplicationDraft());
  cleanup.listen(getElement<HTMLButtonElement>("#application-refresh"), "click", () => {
    void refreshApplications();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#rehearse-concurrent-edit"), "click", () => {
    void rehearseConcurrentEdit();
  });
  cleanup.listen(getElement<HTMLButtonElement>("#rehearse-service-outage"), "click", () => {
    void rehearseServiceOutage();
  });

  cleanup.add(
    bindQueryProjectionToExploration(
      shell.views.table,
      (projection) => {
        latestProjection = projection;
        scheduleRender();
      },
      { applyInitial: true, includeSelf: true },
    ),
  );
  cleanup.add(bindDetailToSelection(shell.views.detail, () => scheduleRender()));
  cleanup.add(shell.workspace.subscribe("all", () => scheduleRender()));
}

async function handleSavePermit(): Promise<void> {
  if (!planningJourney || !planningSearch || !planningAnalysis || workflowState !== "ready" || submissionInFlight) {
    lastEditStatus = "blocked";
    lastEditMessage = "Submission is disabled until metadata discovery, parcel search, and bounded analysis succeed.";
    lastEditDegraded = true;
    announceSampleStatus(lastEditMessage);
    scheduleRender();
    return;
  }
  submissionInFlight = true;
  lastEditStatus = "submitting";
  scheduleRender();
  try {
    const scenario = getElement<HTMLSelectElement>("#permit-scenario").value as PlanningScenario;
    const baseDraft = planningJourney.createDraft(DEFAULT_PROPOSAL);
    const workflowDraft = {
      ...baseDraft,
      values: {
        ...baseDraft.values,
        permit_no: draft.values.permit_no,
        parcel_tmk: planningSearch.attributes.parcel_tmk,
        address: planningSearch.attributes.address,
        zoning: planningSearch.attributes.zoning,
        flood_zone: planningSearch.attributes.flood_zone,
        permit_type: draft.values.permit_type,
        status: draft.values.status,
        description: draft.values.description,
        proposed_height_ft: proposedHeightFeet,
      },
    };
    const submission = await planningJourney.submit(workflowDraft, scenario);
    workflowController.signal.throwIfAborted();
    lastPlanningSubmission = submission;
    lastEditStatus = submission.status;
    lastEditMessage = submission.recovery;
    lastEditDegraded = submission.status !== "succeeded";
    if (lastEditDegraded) presentation.showDegradation([`${scenario}: ${submission.recovery}`]);
    else presentation.clearStatus();
    announceSampleStatus(`Planning submission ${scenario} completed with status ${submission.status}.`);
  } catch (error) {
    if (workflowController.signal.aborted) return;
    lastEditStatus = "failed";
    lastEditMessage = safeErrorMessage(error);
    lastEditDegraded = true;
    presentation.showError(error);
  } finally {
    submissionInFlight = false;
    scheduleRender();
  }
}

function populateZoningFilter(): void {
  const select = getElement<HTMLSelectElement>("#zoning-filter");
  for (const zoning of ZONING_CLASSES) {
    const option = document.createElement("option");
    option.value = zoning.code;
    option.textContent = zoning.label;
    select.append(option);
  }
}

function populatePlanningDomains(journey: PlanningPermittingJourney): void {
  for (const [fieldName, selector] of [
    ["permit_type", "#edit-type-field"],
    ["status", "#edit-status-field"],
  ] as const) {
    const field = journey.metadataFields().find((candidate) => candidate.name === fieldName);
    const values = field?.domain?.type === "coded-value" ? field.domain.codedValues : undefined;
    if (!values || values.length === 0) {
      throw new Error(`Planning metadata did not provide the ${fieldName} coded-value domain.`);
    }
    const select = getElement<HTMLSelectElement>(selector);
    select.replaceChildren(
      ...values.map(({ code, name }) => {
        const option = document.createElement("option");
        option.value = String(code);
        option.textContent = name;
        return option;
      }),
    );
  }
}

/**
 * Binds `<honua-feature-editor>` to the journey's writable source. The widget
 * derives its own form from the advertised field metadata; the shell only
 * supplies selection, prefill, and the post-commit re-read.
 */
function attachApplicationEditor(journey: PlanningPermittingJourney): void {
  const element = getElement<HonuaFeatureEditorElement<PlanningRecordAttributes>>("#application-editor");
  const workflow = createFeatureEditorWorkflow<PlanningRecordAttributes>({
    source: journey.editableSource(),
    metadata: {
      fields: journey.metadataFields(),
      primaryKey: "OBJECTID",
      conflict: { state: "supported", versionField: "version" },
    },
    rollbackOnFailure: true,
  });
  editorWorkflow = workflow;
  element.workflow = workflow;
  cleanup.add(() => {
    element.workflow = undefined;
    element.remove();
    editorWorkflow = undefined;
  });
  cleanup.listen(element, "honua-feature-edit-change", () => scheduleRender());
  cleanup.listen(element, "honua-feature-edit-commit", (event) => {
    const detail = (event as CustomEvent<HonuaFeatureEditCommitDetail>).detail;
    void handleEditorCommit(detail.commit);
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Planning workflow failed without a structured error.";
}

const planningFetch: typeof fetch = (input, init) => {
  const signals = [workflowController.signal];
  if (init?.signal) signals.push(init.signal);
  return fetch(input, {
    ...init,
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  });
};

async function bootstrap(): Promise<void> {
  bindControls();
  renderAll();
  try {
    const journey = await createPlanningPermittingJourney({
      baseUrl: window.location.origin,
      fetchFn: planningFetch,
    });
    if (workflowController.signal.aborted || cleanup.disposed) {
      await journey.dispose();
      return;
    }
    planningJourney = journey;
    cleanup.add(() => journey.dispose());
    populatePlanningDomains(journey);
    attachApplicationEditor(journey);
    workflowState = "ready";
    workflowError = undefined;
    setText("#search-status", "ready");
    const descriptor = journey.inspection().sources[0]?.descriptor;
    presentation.updateEvidence({
      "SDK mode": __HONUA_SAMPLE_SDK_MODE__,
      fixture: "same-origin deterministic planning services",
      discovery: journey.inspection().sources[0]?.discovery ?? "unavailable",
      protocol: descriptor?.protocol ?? "unavailable",
    });
    presentation.clearStatus();
    announceSampleStatus("Planning metadata loaded; address search is ready.");
    await refreshApplications();
  } catch (error) {
    if (workflowController.signal.aborted) return;
    workflowState = "unavailable";
    workflowError = safeErrorMessage(error);
    setText("#search-status", "unavailable");
    lastEditStatus = "unsupported";
    lastEditMessage = "Public workflow unavailable; no analysis or mutation fallback was attempted.";
    lastEditDegraded = true;
    presentation.showDegradation([lastEditMessage, workflowError]);
  } finally {
    scheduleRender();
  }
}

function disposeDemo(): Promise<void> {
  if (disposePromise) return disposePromise;
  workflowState = "disposed";
  runtime.ready = false;
  runtime.workflowState = "disposed";
  runtime.disposed = true;
  setText("#workflow-state", "disposed");
  setText("#workflow-degradation", "Demo resources are disposed and controls are disabled.");
  announceSampleStatus("Planning workbench disposed.");
  disposePromise = (async () => {
    await cleanup.dispose();
    presentation.root.remove();
  })();
  return disposePromise;
}

function sampleAoiRing(): ReadonlyArray<readonly [number, number]> {
  const extent = latestProjection.extent ?? MAP_PRESETS[0].extent;
  const dx = (extent.xmax - extent.xmin) * 0.2;
  const dy = (extent.ymax - extent.ymin) * 0.2;
  const cx = (extent.xmin + extent.xmax) / 2;
  const cy = (extent.ymin + extent.ymax) / 2;
  return [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx - dx, cy + dy],
  ];
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatExtent(extent: LinkedViewQueryProjection["extent"]): string {
  if (!extent) return "No extent";
  return `${extent.xmin.toFixed(3)}, ${extent.ymin.toFixed(3)} to ${extent.xmax.toFixed(3)}, ${extent.ymax.toFixed(3)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

void bootstrap();
