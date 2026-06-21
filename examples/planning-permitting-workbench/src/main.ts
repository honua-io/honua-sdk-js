import { selectLinkedViewQueryProjection } from "@honua/sdk-js/exploration";
import {
  type LinkedViewQueryProjection,
  bindDetailToSelection,
  bindQueryProjectionToExploration,
} from "@honua/sdk-js/interactions";

import { FLOOD_CLASSES, MAP_PRESETS, PARCELS, ZONING_CLASSES } from "./fixtures.js";
import {
  type PermitDraft,
  type PermitSubmitOutcome,
  type PlanningWorkbench,
  buildPrintManifest,
  clearWorkbenchFilters,
  createPlanningWorkbench,
  exportWorkbench,
  findParcel,
  findPermit,
  floodClass,
  isRegulatedFloodZone,
  isWorkbenchLayerVisible,
  measureRing,
  moveWorkbenchMap,
  permitReadiness,
  runWorkbenchQuery,
  selectParcel,
  selectZoningBucket,
  selectedParcelId,
  setFloodOnlyFilter,
  setWorkbenchActiveModule,
  setWorkbenchLayerVisible,
  setZoningFilter,
  sketchFootprintFromRing,
  submitPermitDraft,
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

import "./styles.css";

interface WorkbenchRuntime {
  ready: boolean;
  activeModule: string | undefined;
  parcelCount: number;
  filterCount: number;
  selectedParcelId: string | null;
  permitCount: number;
  editStatus: string;
  lastEditDegraded: boolean;
  sketchAcres: number;
  printId: string | null;
}

declare global {
  interface Window {
    __HONUA_PLANNING_WORKBENCH_RUNTIME__?: WorkbenchRuntime;
  }
}

const shell = createPlanningWorkbench();
let latestProjection: LinkedViewQueryProjection = selectLinkedViewQueryProjection(shell.exploration.state);
let renderQueued = false;

let draft = newPermitDraft();
let lastEditStatus = "ready";
let lastEditMessage = "Select a permit to edit, or start a new one.";
let lastEditDegraded = false;
let activeSketch: SketchFootprint | undefined;
let activeMeasure: MeasureResult | undefined;
let lastPrintId: string | null = null;

const runtime: WorkbenchRuntime = {
  ready: false,
  activeModule: shell.workspace.state.layout.activeViewId,
  parcelCount: 0,
  filterCount: 0,
  selectedParcelId: null,
  permitCount: 0,
  editStatus: lastEditStatus,
  lastEditDegraded: false,
  sketchAcres: 0,
  printId: null,
};
window.__HONUA_PLANNING_WORKBENCH_RUNTIME__ = runtime;

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
  renderPermitEditing();
  renderDetail();
  renderContext(query);
  updateRuntime(query);
}

function renderModules(): void {
  const activeModule = (shell.workspace.state.layout.activeViewId ?? "review-board") as WorkbenchModuleId;
  document.querySelectorAll<HTMLButtonElement>("[data-module]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.module === activeModule));
  });
  getElement<HTMLElement>("#review-board-module").dataset.active = String(activeModule === "review-board");
  getElement<HTMLElement>("#query-analysis-module").dataset.active = String(activeModule === "query-analysis");
  getElement<HTMLElement>("#permit-editing-module").dataset.active = String(activeModule === "permit-editing");
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
  return layer === "permits" ? "writable" : "ready";
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
    button.addEventListener("click", () => {
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
  setInputValue("#edit-parcel-field", draft.values.parcel_tmk);
  setInputValue("#edit-type-field", draft.values.permit_type);
  setInputValue("#edit-status-field", draft.values.status);
  setInputValue("#edit-reviewer-field", draft.values.reviewer);
  setInputValue("#edit-valuation-field", String(draft.values.valuation));
  setInputValue("#edit-description-field", draft.values.description);

  const message = getElement<HTMLElement>("#edit-message");
  message.textContent = lastEditMessage;
  message.dataset.degraded = String(lastEditDegraded);

  const readiness = permitReadiness(shell);
  const caps = shell.permitCapabilities();
  setText(
    "#edit-capability-state",
    `edits ${caps.applyEdits}; attachments ${caps.attachments}; conflicts ${caps.conflicts}`,
  );
  getElement<HTMLElement>("#edit-readiness-list").innerHTML = readiness
    .map(
      (entry) =>
        `<li><strong>${escapeHtml(entry.capability)}</strong><span>${escapeHtml(entry.state)} / ${escapeHtml(entry.note)}</span></li>`,
    )
    .join("");
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
  runtime.ready = true;
  runtime.activeModule = shell.workspace.state.layout.activeViewId;
  runtime.parcelCount = query.parcels.length;
  runtime.filterCount = Object.keys(latestProjection.filters).length;
  runtime.selectedParcelId = selectedParcelId(latestProjection.selection) ?? null;
  runtime.permitCount = visiblePermits(shell).length;
  runtime.editStatus = lastEditStatus;
  runtime.lastEditDegraded = lastEditDegraded;
  runtime.sketchAcres = activeSketch?.areaAcres ?? 0;
  runtime.printId = lastPrintId;
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
      moveWorkbenchMap(shell, presetForParcel(parcel));
      selectParcel(shell, parcel.id);
      setText("#search-status", "located");
      scheduleRender();
    });
  });
}

function presetForParcel(parcel: ParcelFeature) {
  return parcel.district === "Kahului" ? MAP_PRESETS[2].extent : MAP_PRESETS[1].extent;
}

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-module]").forEach((button) => {
    button.addEventListener("click", () => {
      setWorkbenchActiveModule(shell, button.dataset.module as WorkbenchModuleId);
      scheduleRender();
    });
  });

  (["parcels", "zoning", "flood", "permits"] as const).forEach((layer) => {
    getElement<HTMLInputElement>(`#layer-${layer}`).addEventListener("change", (event) => {
      setWorkbenchLayerVisible(shell, layer, (event.target as HTMLInputElement).checked);
      scheduleRender();
    });
  });

  populateZoningFilter();
  getElement<HTMLSelectElement>("#zoning-filter").addEventListener("change", (event) => {
    setZoningFilter(shell, (event.target as HTMLSelectElement).value as ZoningCode | "");
    scheduleRender();
  });
  getElement<HTMLInputElement>("#flood-filter").addEventListener("change", (event) => {
    setFloodOnlyFilter(shell, (event.target as HTMLInputElement).checked);
    scheduleRender();
  });
  getElement<HTMLButtonElement>("#clear-filters").addEventListener("click", () => {
    clearWorkbenchFilters(shell);
    getElement<HTMLSelectElement>("#zoning-filter").value = "";
    getElement<HTMLInputElement>("#flood-filter").checked = false;
    scheduleRender();
  });

  getElement<HTMLInputElement>("#search-input").addEventListener("input", (event) => {
    renderSearchResults((event.target as HTMLInputElement).value);
  });

  getElement<HTMLButtonElement>("#sketch-footprint").addEventListener("click", () => {
    activeSketch = sketchFootprintFromRing(sampleAoiRing());
    activeMeasure = undefined;
    scheduleRender();
  });
  getElement<HTMLButtonElement>("#measure-footprint").addEventListener("click", () => {
    activeMeasure = measureRing(activeSketch ? [...activeSketch.ring, activeSketch.ring[0]] : sampleAoiRing());
    if (!activeSketch) activeSketch = sketchFootprintFromRing(sampleAoiRing());
    scheduleRender();
  });
  getElement<HTMLButtonElement>("#clear-sketch").addEventListener("click", () => {
    activeSketch = undefined;
    activeMeasure = undefined;
    scheduleRender();
  });

  getElement<HTMLButtonElement>("#generate-print").addEventListener("click", () => {
    const manifest = buildPrintManifest(shell, { sketch: activeSketch, measure: activeMeasure });
    lastPrintId = manifest.id;
    setText("#print-status", "generated");
    getElement<HTMLElement>("#print-json").textContent = JSON.stringify(manifest, null, 2);
    scheduleRender();
  });
  getElement<HTMLButtonElement>("#export-workspace").addEventListener("click", () => {
    const manifest = buildPrintManifest(shell, { sketch: activeSketch, measure: activeMeasure });
    lastPrintId = manifest.id;
    setText("#print-status", "exported");
    getElement<HTMLElement>("#print-json").textContent = exportWorkbench(shell, manifest);
    scheduleRender();
  });

  getElement<HTMLButtonElement>("#new-permit").addEventListener("click", () => {
    draft = newPermitDraft();
    lastEditStatus = "ready";
    lastEditMessage = "New permit draft.";
    lastEditDegraded = false;
    scheduleRender();
  });
  getElement<HTMLInputElement>("#edit-parcel-field").addEventListener("input", (event) => {
    draft = { ...draft, values: { ...draft.values, parcel_tmk: (event.target as HTMLInputElement).value } };
  });
  getElement<HTMLSelectElement>("#edit-type-field").addEventListener("change", (event) => {
    draft = {
      ...draft,
      values: {
        ...draft.values,
        permit_type: (event.target as HTMLSelectElement).value as PermitDraft["values"]["permit_type"],
      },
    };
  });
  getElement<HTMLSelectElement>("#edit-status-field").addEventListener("change", (event) => {
    draft = {
      ...draft,
      values: { ...draft.values, status: (event.target as HTMLSelectElement).value as PermitDraft["values"]["status"] },
    };
  });
  getElement<HTMLInputElement>("#edit-reviewer-field").addEventListener("input", (event) => {
    draft = { ...draft, values: { ...draft.values, reviewer: (event.target as HTMLInputElement).value } };
  });
  getElement<HTMLInputElement>("#edit-valuation-field").addEventListener("input", (event) => {
    draft = { ...draft, values: { ...draft.values, valuation: Number((event.target as HTMLInputElement).value) || 0 } };
  });
  getElement<HTMLTextAreaElement>("#edit-description-field").addEventListener("input", (event) => {
    draft = { ...draft, values: { ...draft.values, description: (event.target as HTMLTextAreaElement).value } };
  });
  getElement<HTMLButtonElement>("#force-conflict").addEventListener("click", () => {
    shell.permitSource.failNextConflict = true;
    lastEditMessage = "Next save will hit a version conflict.";
    lastEditDegraded = false;
    scheduleRender();
  });
  getElement<HTMLButtonElement>("#save-permit").addEventListener("click", () => {
    void handleSavePermit();
  });

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
}

async function handleSavePermit(): Promise<void> {
  const outcome: PermitSubmitOutcome = await submitPermitDraft(shell, draft);
  lastEditStatus = outcome.status;
  lastEditMessage = outcome.message;
  lastEditDegraded = outcome.degraded;
  if (outcome.status === "applied" && outcome.committedFeatureId !== undefined) {
    const committed = findPermit(shell, outcome.committedFeatureId);
    if (committed) draft = draftFromPermit(committed);
  }
  scheduleRender();
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

bindControls();
renderAll();
