import type { EditAttachmentMutation, EditWorkflowField, FeatureId } from "@honua/sdk-js/contract";
import { createEditWorkflowDemoSession } from "./model.js";
import type {
  EditWorkflowDemoSession,
  InspectionAttributes,
  InspectionFeature,
  InspectionPriority,
  InspectionStatus,
  MapAreaId,
} from "./types.js";

import "./styles.css";

interface EditWorkflowDemoRuntime {
  readonly ready: boolean;
  readonly visibleCount: number;
  selectFeature(featureId: FeatureId): void;
  submitDraft(): Promise<string>;
  forceConflict(): void;
  exportWorkspace(): string;
}

declare global {
  interface Window {
    __HONUA_EDIT_WORKFLOW_DEMO__?: EditWorkflowDemoRuntime;
  }
}

const session = createEditWorkflowDemoSession();
let ready = false;
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
  renderStatus();
  renderControls();
  renderReadiness();
  renderMap();
  renderTable();
  renderForm();
  void renderAttachments();
  renderDetail();
  renderCharts();
  renderLog();
  renderExport();
}

function renderStatus(): void {
  const models = session.uiModels();
  const cacheReady = models.cache.ready.length;
  const cacheStale = models.cache.stale.length;
  const result = session.lastResult();
  const caps = session.capabilities();
  const visible = session.visibleFeatures();
  const pending = session.pendingAttachments();
  const sketch = session.sketchSnapshot();

  setText("#cache-state", `${cacheReady} ready / ${cacheStale} stale`);
  setText("#visible-count", String(visible.length));
  setText("#pending-count", String(pending.length));
  setText("#submit-status", result ? titleCase(result.status) : "Ready");
  setText(
    "#rollback-state",
    result?.optimistic.rolledBack ? "Rolled back" : result?.optimistic.applied ? "Committed" : "Idle",
  );
  setText(
    "#capability-summary",
    `applyEdits ${caps.applyEdits} / attachments ${caps.attachments} / conflicts ${caps.conflicts}`,
  );
  setText(
    "#sketch-state",
    `${titleCase(sketch.sketch.status)} / undo ${sketch.undo.undoDepth} / redo ${sketch.undo.redoDepth}`,
  );
  getElement<HTMLElement>("#submit-status").dataset.status = result?.status ?? "ready";
  getElement<HTMLButtonElement>("#undo-sketch").disabled = !sketch.undo.canUndo;
  getElement<HTMLButtonElement>("#redo-sketch").disabled = !sketch.undo.canRedo;
}

function renderControls(): void {
  const areaSelect = getElement<HTMLSelectElement>("#area-select");
  const statusFilter = getElement<HTMLSelectElement>("#status-filter");
  const priorityFilter = getElement<HTMLSelectElement>("#priority-filter");
  const activeArea = session.activeArea();
  const filters = session.activeProjection().filters;

  areaSelect.innerHTML = session.dataset.mapAreas
    .map(
      (area) =>
        `<option value="${escapeHtml(area.id)}" ${area.id === activeArea.id ? "selected" : ""}>${escapeHtml(area.title)}</option>`,
    )
    .join("");
  statusFilter.value = typeof filters.status?.value === "string" ? filters.status.value : "all";
  priorityFilter.value = typeof filters.priority?.value === "string" ? filters.priority.value : "all";
  setText("#area-cache-key", activeArea.cacheKey);
}

function renderReadiness(): void {
  getElement<HTMLElement>("#source-readiness").innerHTML = session
    .readiness()
    .map(
      (entry) => `
        <article class="readiness-row" data-state="${escapeHtml(entry.state)}">
          <strong>${escapeHtml(entry.capability)}</strong>
          <span>${escapeHtml(entry.state)}</span>
          <small>${escapeHtml(entry.sourceId)}: ${escapeHtml(entry.note)}</small>
        </article>
      `,
    )
    .join("");
}

function renderMap(): void {
  const visible = session.visibleFeatures();
  const selected = session.detailFeature();
  const activeArea = session.activeArea();
  const map = getElement<HTMLElement>("#map-surface");
  map.innerHTML = `
    <div class="map-grid"></div>
    <div class="map-window">
      <strong>${escapeHtml(activeArea.title)}</strong>
      <span>${escapeHtml(String(visible.length))} filtered record(s)</span>
    </div>
    ${visible.map((feature) => renderMarker(feature, selected?.id === feature.id)).join("")}
  `;
  for (const button of Array.from(map.querySelectorAll<HTMLButtonElement>(".map-marker"))) {
    button.addEventListener("click", () => {
      const id = button.dataset.featureId;
      if (id) session.selectFeature(Number(id));
      render();
    });
  }
}

function renderMarker(feature: InspectionFeature, selected: boolean): string {
  return `
    <button
      type="button"
      class="map-marker"
      data-feature-id="${escapeHtml(feature.id)}"
      data-priority="${escapeHtml(feature.attributes.priority)}"
      data-selected="${selected ? "true" : "false"}"
      style="left:${feature.mapPosition.x}%; top:${feature.mapPosition.y}%"
      aria-label="Open ${escapeHtml(feature.title)}"
    >
      <span>${escapeHtml(feature.attributes.inspection_score)}</span>
    </button>
  `;
}

function renderTable(): void {
  const selected = session.detailFeature();
  const body = getElement<HTMLElement>("#feature-table");
  const rows = session.visibleFeatures();
  body.innerHTML =
    rows.length === 0
      ? `<tr><td colspan="5">No records in the linked context</td></tr>`
      : rows.map((feature) => renderFeatureRow(feature, selected?.id === feature.id)).join("");
  for (const button of Array.from(body.querySelectorAll<HTMLButtonElement>("button[data-feature-id]"))) {
    button.addEventListener("click", () => {
      const id = button.dataset.featureId;
      if (id) session.selectFeature(Number(id));
      render();
    });
  }
}

function renderFeatureRow(feature: InspectionFeature, selected: boolean): string {
  return `
    <tr data-selected="${selected ? "true" : "false"}">
      <td><button type="button" data-feature-id="${escapeHtml(feature.id)}">Open ${escapeHtml(feature.title)}</button></td>
      <td>${escapeHtml(titleCase(feature.attributes.status))}</td>
      <td>${escapeHtml(titleCase(feature.attributes.priority))}</td>
      <td>${escapeHtml(feature.attributes.inspection_score)}</td>
      <td>${escapeHtml(feature.attributes.version)}</td>
    </tr>
  `;
}

function renderForm(): void {
  const draft = session.draft();
  const form = getElement<HTMLElement>("#feature-form");
  form.innerHTML = session
    .metadataFields()
    .filter((field) => field.editable !== false)
    .map((field) => renderField(field, draft.values))
    .join("");
  for (const input of Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-field]"),
  )) {
    input.addEventListener("input", () => {
      const fieldName = input.dataset.field as keyof InspectionAttributes | undefined;
      if (!fieldName) return;
      session.updateDraftValue(fieldName, input.value);
      renderStatus();
    });
  }
  setText("#form-mode", titleCase(draft.mode));
  setText("#form-feature-id", draft.featureId === undefined ? "new" : String(draft.featureId));
}

function renderField(field: EditWorkflowField, values: InspectionAttributes): string {
  const value = values[field.name] ?? "";
  const label = field.alias ?? field.name;
  if (field.domain?.type === "coded-value") {
    return `
      <label>
        <span>${escapeHtml(label)}</span>
        <select id="field-${escapeHtml(field.name)}" data-field="${escapeHtml(field.name)}">
          ${(field.domain.codedValues ?? [])
            .map(
              (coded) =>
                `<option value="${escapeHtml(coded.code)}" ${coded.code === value ? "selected" : ""}>${escapeHtml(coded.name)}</option>`,
            )
            .join("")}
        </select>
      </label>
    `;
  }
  if (field.name === "notes") {
    return `
      <label class="wide-field">
        <span>${escapeHtml(label)}</span>
        <textarea id="field-${escapeHtml(field.name)}" data-field="${escapeHtml(field.name)}" rows="4">${escapeHtml(value)}</textarea>
      </label>
    `;
  }
  const inputType = field.type?.toLowerCase().includes("integer") ? "number" : "text";
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input id="field-${escapeHtml(field.name)}" data-field="${escapeHtml(field.name)}" type="${inputType}" value="${escapeHtml(value)}" />
    </label>
  `;
}

async function renderAttachments(): Promise<void> {
  const draft = session.draft();
  const attachments = await session.attachmentList();
  const pending = session.pendingAttachments();
  const list = getElement<HTMLElement>("#attachment-list");
  const pendingList = getElement<HTMLElement>("#pending-attachments");

  list.innerHTML =
    attachments.length === 0
      ? "<li>No attachments</li>"
      : attachments
          .map(
            (attachment) =>
              `<li><strong>${escapeHtml(attachment.name ?? attachment.id)}</strong><span>${escapeHtml(attachment.contentType ?? "file")}</span></li>`,
          )
          .join("");
  pendingList.innerHTML =
    pending.length === 0 ? "<li>No staged attachment edits</li>" : pending.map(renderPendingAttachment).join("");
  getElement<HTMLButtonElement>("#stage-delete-attachment").disabled =
    draft.featureId === undefined || attachments.length === 0;
}

function renderPendingAttachment(mutation: EditAttachmentMutation): string {
  if (mutation.operation === "delete") {
    return `<li><strong>Delete</strong><span>${escapeHtml(mutation.attachmentIds.join(", "))}</span></li>`;
  }
  return `<li><strong>${escapeHtml(titleCase(mutation.operation))}</strong><span>${escapeHtml(mutation.name ?? "attachment")}</span></li>`;
}

function renderDetail(): void {
  const feature = session.detailFeature();
  if (!feature) {
    setText("#feature-detail", "No selected record");
    return;
  }
  getElement<HTMLElement>("#feature-detail").innerHTML = `
    <strong>${escapeHtml(feature.title)}</strong>
    <span>${escapeHtml(feature.attributes.asset_id)}</span>
    <span>${escapeHtml(titleCase(feature.attributes.status))} / ${escapeHtml(titleCase(feature.attributes.priority))}</span>
  `;
}

function renderCharts(): void {
  const buckets = countByStatus(session.visibleFeatures());
  getElement<HTMLElement>("#status-buckets").innerHTML = buckets
    .map(
      (bucket) => `
        <button type="button" data-status="${escapeHtml(bucket.status)}">
          <span>${escapeHtml(titleCase(bucket.status))}</span>
          <strong>${escapeHtml(bucket.count)}</strong>
        </button>
      `,
    )
    .join("");
  for (const button of Array.from(
    getElement<HTMLElement>("#status-buckets").querySelectorAll<HTMLButtonElement>("button"),
  )) {
    button.addEventListener("click", () => {
      session.setStatusFilter(button.dataset.status as InspectionStatus);
      render();
    });
  }
}

function renderLog(): void {
  const result = session.lastResult();
  getElement<HTMLElement>("#operation-log").innerHTML = session
    .operationLog()
    .map(
      (entry) => `
        <article data-status="${escapeHtml(entry.status)}">
          <strong>${escapeHtml(entry.title)}</strong>
          <span>${escapeHtml(entry.detail)}</span>
          <small>${escapeHtml(entry.optimistic)}</small>
        </article>
      `,
    )
    .join("");
  getElement<HTMLElement>("#failure-list").innerHTML =
    result && result.failures.length > 0
      ? result.failures
          .map((failure) => `<li>${escapeHtml(failure.kind)}: ${escapeHtml(failure.description)}</li>`)
          .join("")
      : "<li>No failed edit diagnostics</li>";
}

function renderExport(): void {
  getElement<HTMLPreElement>("#workspace-export").textContent = workspaceExport;
}

function countByStatus(
  features: readonly InspectionFeature[],
): ReadonlyArray<{ readonly status: InspectionStatus; readonly count: number }> {
  const counts: Partial<Record<InspectionStatus, number>> = {};
  for (const feature of features) counts[feature.attributes.status] = (counts[feature.attributes.status] ?? 0) + 1;
  return (["open", "in-progress", "closed"] as const)
    .map((status) => ({ status, count: counts[status] ?? 0 }))
    .filter((bucket) => bucket.count > 0);
}

function wireEvents(): void {
  getElement<HTMLSelectElement>("#area-select").addEventListener("change", (event) => {
    session.selectMapArea((event.currentTarget as HTMLSelectElement).value as MapAreaId);
    render();
  });
  getElement<HTMLSelectElement>("#status-filter").addEventListener("change", (event) => {
    session.setStatusFilter((event.currentTarget as HTMLSelectElement).value as InspectionStatus | "all");
    render();
  });
  getElement<HTMLSelectElement>("#priority-filter").addEventListener("change", (event) => {
    session.setPriorityFilter((event.currentTarget as HTMLSelectElement).value as InspectionPriority | "all");
    render();
  });
  getElement<HTMLButtonElement>("#new-feature").addEventListener("click", () => {
    session.startCreateDraft();
    render();
  });
  getElement<HTMLButtonElement>("#save-edit").addEventListener("click", async () => {
    await session.submitDraft();
    render();
  });
  getElement<HTMLButtonElement>("#delete-feature").addEventListener("click", async () => {
    await session.deleteSelected();
    render();
  });
  getElement<HTMLButtonElement>("#stage-attachment").addEventListener("click", () => {
    session.stageAttachmentAdd("after-action.png");
    render();
  });
  getElement<HTMLButtonElement>("#sketch-point").addEventListener("click", () => {
    const geometry = session.draft().geometry;
    session.applySketchGeometry("point", { ...geometry, x: geometry.x + 0.001, y: geometry.y + 0.001 });
    render();
  });
  getElement<HTMLButtonElement>("#sketch-rectangle").addEventListener("click", () => {
    const geometry = session.draft().geometry;
    session.applySketchGeometry("rectangle", { ...geometry, x: geometry.x + 0.002, y: geometry.y - 0.001 });
    render();
  });
  getElement<HTMLButtonElement>("#sketch-circle").addEventListener("click", () => {
    session.applySketchGeometry("circle", session.draft().geometry);
    render();
  });
  getElement<HTMLButtonElement>("#undo-sketch").addEventListener("click", () => {
    session.undoSketchEdit();
    render();
  });
  getElement<HTMLButtonElement>("#redo-sketch").addEventListener("click", () => {
    session.redoSketchEdit();
    render();
  });
  getElement<HTMLButtonElement>("#stage-large-attachment").addEventListener("click", () => {
    session.stageAttachmentAdd("too-large-photo.jpg");
    render();
  });
  getElement<HTMLButtonElement>("#stage-delete-attachment").addEventListener("click", async () => {
    await session.stageAttachmentDelete();
    render();
  });
  getElement<HTMLButtonElement>("#force-conflict").addEventListener("click", () => {
    session.forceNextConflict();
    session.updateDraftValue("notes", `${session.draft().values.notes} Conflict probe`);
    render();
  });
  getElement<HTMLButtonElement>("#unsupported-check").addEventListener("click", async () => {
    await session.runUnsupportedCheck();
    render();
  });
  getElement<HTMLButtonElement>("#export-workspace").addEventListener("click", () => {
    workspaceExport = session.exportWorkspace();
    renderExport();
  });
}

wireEvents();
render();
ready = true;

window.__HONUA_EDIT_WORKFLOW_DEMO__ = {
  get ready() {
    return ready;
  },
  get visibleCount() {
    return session.visibleFeatures().length;
  },
  selectFeature(featureId) {
    session.selectFeature(featureId);
    render();
  },
  async submitDraft() {
    const result = await session.submitDraft();
    render();
    return result.status;
  },
  forceConflict() {
    session.forceNextConflict();
  },
  exportWorkspace() {
    workspaceExport = session.exportWorkspace();
    renderExport();
    return workspaceExport;
  },
};
