import { selectHonuaAppWorkspaceDrafts } from "@honua/sdk-js/app-workspace";

import { applyFilters, createMcpGisAssistantSession } from "./assistant.js";
import type { AssistantFeature, AssistantToolCall, AssistantTurn } from "./types.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_MCP_GIS_ASSISTANT__?: {
      ready: boolean;
      ask(text: string): AssistantTurn;
      applyDraft(id?: string): void;
      visibleFeatureCount: number;
    };
  }
}

const session = createMcpGisAssistantSession();
let lastTurn = session.ask("List services, layers, and schema");

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(): void {
  renderStatus();
  renderCatalog();
  renderTurn(lastTurn);
  renderDraft();
  renderTable();
}

function renderStatus(): void {
  getElement<HTMLElement>("#credential-state").textContent = "Fixture safe mode";
  getElement<HTMLElement>("#cache-state").textContent = session.dataset.metadata.cache.status;
  getElement<HTMLElement>("#capability-state").textContent =
    `query ${session.dataset.metadata.capabilities.queryFeatures}, realtime ${session.dataset.metadata.capabilities.realtime}`;
  getElement<HTMLElement>("#result-limit").textContent = String(session.currentProjection().pagination.limit ?? 3);
}

function renderCatalog(): void {
  getElement<HTMLElement>("#service-list").innerHTML = session.dataset.services
    .map(
      (service) => `
        <li data-status="${service.status}">
          <strong>${escapeHtml(service.name)}</strong>
          <span>${escapeHtml(service.type)} / ${service.layerCount} layer(s)</span>
        </li>
      `,
    )
    .join("");

  getElement<HTMLElement>("#layer-list").innerHTML = session.dataset.layers
    .map(
      (layer) => `
        <li data-active="${layer.sourceId === session.dataset.activeSourceId}">
          <strong>${escapeHtml(layer.name)}</strong>
          <span>${escapeHtml(layer.geometryType)} / ${layer.featureCount} features</span>
        </li>
      `,
    )
    .join("");

  getElement<HTMLElement>("#schema-list").innerHTML = session.dataset.metadata.fields
    .map((field) => `<li><strong>${escapeHtml(field.alias)}</strong><span>${escapeHtml(field.name)}</span></li>`)
    .join("");
}

function renderTurn(turn: AssistantTurn): void {
  getElement<HTMLElement>("#assistant-answer").textContent = turn.assistantText;
  getElement<HTMLElement>("#bounded-summary").textContent = turn.summary
    ? `${turn.summary.returned}/${turn.summary.totalMatched} returned${turn.summary.truncated ? " (bounded)" : ""}`
    : "No feature query yet";
  getElement<HTMLElement>("#tool-calls").innerHTML = turn.toolCalls.map(renderToolCall).join("");
  getElement<HTMLElement>("#diagnostics").innerHTML = turn.diagnostics
    .map(
      (diagnostic) => `
        <li data-level="${diagnostic.level}">
          <strong>${escapeHtml(diagnostic.title)}</strong>
          <span>${escapeHtml(diagnostic.detail)}</span>
        </li>
      `,
    )
    .join("");
}

function renderToolCall(call: AssistantToolCall): string {
  return `
    <details open>
      <summary>${escapeHtml(call.name)} <span>${call.durationMs} ms</span></summary>
      <pre>${escapeHtml(JSON.stringify({ arguments: call.arguments, result: call.result }, null, 2))}</pre>
    </details>
  `;
}

function renderDraft(): void {
  const drafts = selectHonuaAppWorkspaceDrafts(session.workspace.state);
  const draft = drafts.activeDraftId ? drafts.entries[drafts.activeDraftId] : undefined;
  const panel = getElement<HTMLElement>("#draft-review");
  if (!draft) {
    panel.dataset.state = "empty";
    panel.innerHTML = "<h2>Review</h2><p>No generated filter is waiting for review.</p>";
    return;
  }
  panel.dataset.state = "ready";
  panel.innerHTML = `
    <h2>Review</h2>
    <p><strong>${escapeHtml(draft.label ?? draft.id)}</strong></p>
    <code>${escapeHtml(draft.description ?? "")}</code>
    <p>${escapeHtml(draft.metadata?.estimatedCount ?? 0)} matching feature(s), bounded before display.</p>
    <button id="apply-draft" type="button">Apply Filter</button>
  `;
  getElement<HTMLButtonElement>("#apply-draft").addEventListener("click", () => {
    session.applyDraft(draft.id);
    render();
  });
}

function renderTable(): void {
  const filters = session.currentProjection().filters;
  const rows = applyFilters(session.dataset.features, filters).slice(
    0,
    session.currentProjection().pagination.limit ?? 3,
  );
  getElement<HTMLElement>("#feature-count").textContent = String(rows.length);
  getElement<HTMLElement>("#feature-table").innerHTML = rows.map(renderFeatureRow).join("");
}

function renderFeatureRow(feature: AssistantFeature): string {
  return `
    <tr>
      <td>${escapeHtml(feature.id)}</td>
      <td>${escapeHtml(feature.title)}</td>
      <td>${escapeHtml(feature.attributes.status)}</td>
      <td>${escapeHtml(feature.attributes.priority)}</td>
    </tr>
  `;
}

function ask(text: string): AssistantTurn {
  lastTurn = session.ask(text);
  render();
  return lastTurn;
}

getElement<HTMLFormElement>("#assistant-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = getElement<HTMLInputElement>("#assistant-input");
  ask(input.value);
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) {
  button.addEventListener("click", () => ask(button.dataset.prompt ?? ""));
}

window.__HONUA_MCP_GIS_ASSISTANT__ = {
  ready: true,
  ask,
  applyDraft(id?: string) {
    const drafts = selectHonuaAppWorkspaceDrafts(session.workspace.state);
    session.applyDraft(id ?? drafts.activeDraftId ?? "");
    render();
  },
  get visibleFeatureCount() {
    return Number(getElement<HTMLElement>("#feature-count").textContent ?? "0");
  },
};

render();
