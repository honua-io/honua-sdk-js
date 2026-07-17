import "maplibre-gl/dist/maplibre-gl.css";

import { type ConnectProtocolHint, type Result, executeQueryPlan, isHonuaError } from "@honua/sdk-js";
import { type AutomaticMapLibrePlan, projectSourceToMapLibre } from "@honua/sdk-js/map";
import maplibregl from "maplibre-gl";

import { SampleCleanupRegistry } from "../../_kit/cleanup.js";
import { mountSamplePresentation } from "../../_kit/presentation.js";
import {
  SERVICE_EXPLORER_DEFAULT_LIMIT,
  SERVICE_EXPLORER_OPERATION_TIMEOUT_MS,
  type ServiceExplorerOperationId,
  type ServiceExplorerOperationProjection,
  generateServiceExplorerCode,
  projectServiceExplorerOperations,
} from "./operation-model.js";
import {
  type ServiceExplorerReadyState,
  type ServiceExplorerSourceView,
  type ServiceExplorerTruthState,
  createServiceExplorerTruthModel,
} from "./truth-model.js";

import "../../_kit/presentation.css";
import "./styles.css";

declare global {
  interface Window {
    __HONUA_SERVICE_EXPLORER_RUNTIME__?: {
      ready: boolean;
      state: ServiceExplorerTruthState["kind"];
      protocol: string;
      sourceId: string;
      queryEnabled: boolean;
      renderEnabled: boolean;
      resultCount: number;
      interactionCount: number;
      disposed?: boolean;
    };
    __HONUA_SERVICE_EXPLORER_DISPOSE__?: () => Promise<void>;
  }
}

const MAP_SOURCE_ID = "service-explorer-source";
const INSPECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#e8efeb" } }],
};

const cleanup = new SampleCleanupRegistry();
const truth = createServiceExplorerTruthModel();
const runtime: NonNullable<Window["__HONUA_SERVICE_EXPLORER_RUNTIME__"]> = {
  ready: false,
  state: "idle" as ServiceExplorerTruthState["kind"],
  protocol: "unresolved",
  sourceId: "unselected",
  queryEnabled: false,
  renderEnabled: false,
  resultCount: 0,
  interactionCount: 0,
};
window.__HONUA_SERVICE_EXPLORER_RUNTIME__ = runtime;

const map = new maplibregl.Map({
  container: "map",
  style: DEFAULT_STYLE,
  center: [-157.8583, 21.3069],
  zoom: 10,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
cleanup.resource(map);
cleanup.add(() => truth.dispose());

const presentation = mountSamplePresentation({
  sampleId: "service-explorer",
  evidence: {
    workflow: "public-kernel inspect → strict planner → execution",
    endpoint: "same-origin OGC fixture",
    credentials: "not retained",
  },
  onDispose: () => disposeDemo(),
});
cleanup.add(() => presentation.root.remove());

const form = element<HTMLFormElement>("#inspect-form");
const endpointInput = element<HTMLInputElement>("#endpoint-input");
const protocolInput = element<HTMLSelectElement>("#protocol-input");
const sourceInput = element<HTMLInputElement>("#source-input");
const inspectButton = element<HTMLButtonElement>("#inspect-button");
const cancelButton = element<HTMLButtonElement>("#cancel-button");
const sourceList = element<HTMLElement>("#source-list");
const capabilityList = element<HTMLElement>("#capability-list");
const diagnosticList = element<HTMLUListElement>("#diagnostic-list");
const queryLimit = element<HTMLInputElement>("#query-limit");
const queryButton = element<HTMLButtonElement>("#run-query-button");
const renderButton = element<HTMLButtonElement>("#prepare-render-button");
const copyButton = element<HTMLButtonElement>("#copy-code-button");
const codeOutput = element<HTMLElement>("#typescript-code");
const resultHead = element<HTMLTableSectionElement>("#result-head");
const resultBody = element<HTMLTableSectionElement>("#result-body");

let currentState: ServiceExplorerReadyState | undefined;
let currentProjection: ServiceExplorerOperationProjection | undefined;
let generatedOperation: ServiceExplorerOperationId = "query";
let operationController: AbortController | undefined;
let operationDeadline: number | undefined;
let mapLayerIds: string[] = [];
let mapSourceId: string | undefined;
let disposePromise: Promise<void> | undefined;

const unsubscribe = truth.subscribe((state) => renderTruth(state));
cleanup.add(unsubscribe);

cleanup.listen(form, "submit", (event) => {
  event.preventDefault();
  void inspectEndpoint();
});
cleanup.listen(cancelButton, "click", () => {
  if (operationController) {
    operationController.abort(new DOMException("Service Explorer operation was cancelled", "AbortError"));
    return;
  }
  truth.cancel();
});
cleanup.listen(queryLimit, "input", () => refreshOperationProjection());
cleanup.listen(queryButton, "click", () => void runAcceptedQuery());
cleanup.listen(renderButton, "click", () => void renderAcceptedSource());
cleanup.listen(copyButton, "click", () => void copyGeneratedCode());
cleanup.listen(sourceList, "click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-source-id]");
  if (!button || !sourceList.contains(button) || !button.dataset.sourceId) return;
  sourceInput.value = button.dataset.sourceId;
  runtime.interactionCount += 1;
  void inspectEndpoint();
});

const defaultEndpoint = `${window.location.origin}/fixtures/ogc`;
endpointInput.value = defaultEndpoint;
protocolInput.value = "ogc-features";
sourceInput.value = "places";
queryLimit.value = String(SERVICE_EXPLORER_DEFAULT_LIMIT);
window.__HONUA_SERVICE_EXPLORER_DISPOSE__ = () => disposeDemo();
void inspectEndpoint();

async function inspectEndpoint(): Promise<void> {
  abortActiveOperation(new DOMException("Service Explorer operation was superseded", "AbortError"));
  const endpoint = endpointInput.value;
  const protocol = protocolInput.value as ConnectProtocolHint;
  const sourceId = sourceInput.value.trim();
  await truth.inspect(
    {
      url: endpoint,
      protocol,
      ...(sourceId ? { sourceId } : {}),
    },
    { signal: AbortSignal.timeout(INSPECTION_TIMEOUT_MS) },
  );
}

function renderTruth(state: ServiceExplorerTruthState): void {
  runtime.state = state.kind;
  runtime.ready = state.kind === "ready" || state.kind === "partial";
  inspectButton.disabled = state.kind === "loading";
  cancelButton.disabled = state.kind !== "loading";
  currentState = undefined;
  currentProjection = undefined;
  resetExplorerPresentation(state);
  setStateBadge(state.kind);

  if ("request" in state) {
    setText("#request-scope", `${state.request.authorization.mode}: ${state.request.authorization.scopeIdentity}`);
    endpointInput.value = state.request.endpoint;
  }

  if (state.kind === "idle") {
    setText("#state-detail", "Enter a service URL.");
    return;
  }
  if (state.kind === "loading") {
    setText("#state-detail", "Discovering service metadata with a 10 second deadline.");
    setText("#input-message", "Inspecting a credential-free endpoint identity…");
    return;
  }
  if (state.kind !== "ready" && state.kind !== "partial") {
    renderFailure(state);
    return;
  }

  currentState = state;
  const inspection = state.inspection;
  runtime.protocol = inspection.service.protocol;
  runtime.sourceId = inspection.dataset.selectedSourceId ?? "unselected";
  setText("#state-detail", `${inspection.dataset.sourceCount} source(s); ${inspection.service.cache.status} metadata.`);
  setText(
    "#input-message",
    state.kind === "partial" ? "Inspection completed with bounded partial evidence." : "Inspection completed.",
  );
  setText("#requested-protocol", inspection.service.detection.requestedProtocolHint);
  setText("#resolved-protocol", inspection.service.detection.resolvedProtocol);
  setText("#detection-confidence", inspection.service.detection.confidence);
  setText(
    "#metadata-cache",
    `${inspection.service.cache.status}; feature data ${inspection.service.cache.featureData}`,
  );
  setText("#cache-status", inspection.service.cache.status);
  renderSources(inspection.sources, inspection.dataset.selectedSourceId);
  const selected = selectedSource(state);
  renderSchema(selected);
  renderCapabilities(selected);
  renderDiagnostics(inspection.diagnostics);
  presentation.updateEvidence({
    protocol: inspection.service.protocol,
    source: inspection.dataset.selectedSourceId ?? "selection required",
    cache: inspection.service.cache.status,
    authorization: inspection.service.authorization.scopeIdentity,
  });
  presentation.showDegradation(
    state.kind === "partial" ? ["Inspection evidence is partial; actions remain planner-gated."] : [],
  );
  refreshOperationProjection();
}

function renderFailure(state: ServiceExplorerTruthState): void {
  const failure = "failure" in state ? state.failure : undefined;
  const title = failure?.title ?? "Inspection did not complete";
  setText("#state-detail", title);
  setText("#input-message", failure ? `${failure.code}: ${failure.detail}` : title);
  setText("#query-code", failure?.code ?? "inspection.unavailable");
  setText("#render-code", failure?.code ?? "inspection.unavailable");
  setText("#query-reason", "No inspected source is available for planning.");
  setText("#render-reason", "No inspected source is available for planning.");
  presentation.showDegradation([failure?.code ?? "inspection-unavailable"]);
}

function resetExplorerPresentation(state: ServiceExplorerTruthState): void {
  runtime.protocol = "unresolved";
  runtime.sourceId = "unselected";
  runtime.queryEnabled = false;
  runtime.renderEnabled = false;
  runtime.resultCount = 0;
  queryButton.disabled = true;
  renderButton.disabled = true;
  copyButton.disabled = true;
  clearMapPreview();

  setText("#input-message", "");
  setText("#request-scope", "anonymous: public");
  setText("#requested-protocol", "—");
  setText("#resolved-protocol", "—");
  setText("#detection-confidence", "—");
  setText("#metadata-cache", "—");
  setText("#cache-status", "not loaded");
  setText("#query-code", "source.selection-required");
  setText("#render-code", "source.selection-required");
  setText("#query-reason", "Inspect a source first.");
  setText("#render-reason", "Inspect a source first.");
  setText("#plan-id", "not accepted");
  setText("#plan-pushdown", "—");
  setText("#plan-fidelity", "—");
  setText("#plan-cache", "—");
  setText("#plan-residual", "—");
  setText("#result-count", "—");
  setText("#map-status", "waiting for an accepted operation");
  setText("#copy-status", "");
  codeOutput.textContent = "// Inspect an endpoint to generate evidence-equivalent TypeScript.";

  sourceList.replaceChildren(message("No inspected sources.", "empty-state"));
  capabilityList.replaceChildren(message("No selected source capability evidence.", "empty-state"));
  element<HTMLElement>("#schema-summary").replaceChildren(
    message("Inspect an endpoint to see source metadata.", "empty-state"),
  );
  diagnosticList.replaceChildren(listMessage("No inspection diagnostics.", "empty-state"));
  setText("#diagnostic-count", "0");
  element<HTMLOListElement>("#plan-steps").replaceChildren(listMessage("No accepted query plan.", "empty-state"));
  resultHead.replaceChildren();
  resultBody.replaceChildren(tableMessage("No query has run for this inspection."));

  const authorization = "request" in state ? state.request.authorization.scopeIdentity : "public";
  presentation.updateEvidence({
    protocol: "unresolved",
    source: "none",
    cache: "not loaded",
    authorization,
  });
  presentation.showDegradation([]);
}

function renderSources(sources: readonly ServiceExplorerSourceView[], selectedId: string | undefined): void {
  sourceList.replaceChildren();
  if (sources.length === 0) {
    sourceList.append(message("No bounded source descriptors were returned.", "empty-state"));
    return;
  }
  for (const source of sources) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-card";
    button.dataset.sourceId = source.id;
    button.dataset.selected = String(source.id === selectedId);
    const title = document.createElement("strong");
    title.textContent = source.id;
    const detail = document.createElement("span");
    detail.textContent = `${source.protocol} · ${source.discovery} · ${source.effectiveCapabilityCount} effective`;
    button.append(title, detail);
    sourceList.append(button);
  }
}

function renderSchema(source: ServiceExplorerSourceView | undefined): void {
  const host = element<HTMLElement>("#schema-summary");
  host.replaceChildren();
  if (!source) {
    host.append(message("Choose a visible inspected source to see schema and CRS truth.", "empty-state"));
    return;
  }
  const summary = document.createElement("dl");
  summary.className = "fact-grid compact";
  appendFact(summary, "Schema", `${source.schema.state}; ${source.schema.fieldCount} field(s)`);
  appendFact(summary, "Primary key", source.schema.primaryKey ?? "not reported");
  appendFact(summary, "Schema identity", source.schema.schemaV2?.fingerprint ?? "not reported");
  appendFact(summary, "CRS", source.crs.length > 0 ? source.crs.join(", ") : "not reported");
  appendFact(
    summary,
    "Evidence provenance",
    source.provenance.length > 0 ? source.provenance.map((entry) => entry.source).join(", ") : "not reported",
  );
  host.append(summary);
  if (source.schema.fields.length > 0) {
    const fields = document.createElement("p");
    fields.className = "field-summary";
    fields.textContent = source.schema.fields.map((field) => `${field.name}: ${field.type}`).join(" · ");
    host.append(fields);
  }
}

function renderCapabilities(source: ServiceExplorerSourceView | undefined): void {
  capabilityList.replaceChildren();
  if (!source) {
    capabilityList.append(message("No selected source capability evidence.", "empty-state"));
    return;
  }
  const profile = new Map(source.capabilityProfile?.entries.map((entry) => [entry.id, entry]));
  for (const decision of source.capabilityDecisions) {
    const card = document.createElement("article");
    card.className = "capability-card";
    card.dataset.effective = String(decision.effective);
    const heading = document.createElement("div");
    heading.className = "capability-heading";
    const name = document.createElement("strong");
    name.textContent = decision.capability;
    const status = document.createElement("code");
    status.textContent = decision.code;
    heading.append(name, status);
    const reason = document.createElement("p");
    reason.textContent = decision.reason;
    card.append(heading, reason);
    const evidence = decision.evidence.map(
      (item) => `${item.kind}: ${item.supported ? "supports" : "does not support"}`,
    );
    const entry = profile.get(decision.capability);
    evidence.unshift(
      `claimed ${entry?.claimed ?? "not reported"} · observed ${entry?.observed ?? "not reported"} · effective ${entry?.effective ?? (decision.effective ? "supported" : "unsupported")}`,
    );
    if (entry) {
      if (entry.pagination) {
        evidence.push(
          `pagination ${entry.pagination.modes.join(", ") || "not reported"}${entry.pagination.maxPageSize ? ` · max ${entry.pagination.maxPageSize}` : ""}`,
        );
      }
      if (entry.authorizationScopes.length > 0)
        evidence.push(`authorization scopes: ${entry.authorizationScopes.join(", ")}`);
    }
    if (evidence.length > 0) {
      const evidenceText = document.createElement("small");
      evidenceText.textContent = evidence.join(" · ");
      card.append(evidenceText);
    }
    capabilityList.append(card);
  }
  if (source.capabilityDecisions.length === 0) {
    capabilityList.append(message("The kernel reported no capability decisions for this source.", "empty-state"));
  }
}

function renderDiagnostics(diagnostics: ServiceExplorerReadyState["inspection"]["diagnostics"]): void {
  diagnosticList.replaceChildren();
  setText("#diagnostic-count", String(diagnostics.length));
  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    item.dataset.severity = diagnostic.severity;
    const code = document.createElement("code");
    code.textContent = diagnostic.code;
    const text = document.createElement("span");
    text.textContent = diagnostic.message;
    item.append(code, text);
    diagnosticList.append(item);
  }
  if (diagnostics.length === 0) {
    const item = document.createElement("li");
    item.className = "empty-state";
    item.textContent = "No inspection diagnostics.";
    diagnosticList.append(item);
  }
}

function refreshOperationProjection(): void {
  const state = currentState;
  const connection = state ? truth.connection() : undefined;
  if (!state || !connection) return;
  currentProjection = projectServiceExplorerOperations(state, connection, Number(queryLimit.value));
  const { query, render } = currentProjection.actions;
  runtime.queryEnabled = query.enabled;
  runtime.renderEnabled = render.enabled;
  queryButton.disabled = !query.enabled;
  renderButton.disabled = !render.enabled;
  setText("#query-code", query.code);
  setText("#query-reason", query.reason);
  setText("#render-code", render.code);
  setText("#render-reason", render.reason);
  renderQueryPlan(currentProjection);
  updateGeneratedCode(generatedOperation);
}

function renderQueryPlan(projection: ServiceExplorerOperationProjection): void {
  const plan = projection.queryPlan;
  setText("#plan-id", plan?.id ?? projection.renderPlan?.id ?? "not accepted");
  setText("#plan-pushdown", plan?.pushdown ?? "not applicable");
  setText("#plan-fidelity", plan?.fidelity ?? projection.renderPlan?.selected?.fidelity ?? "not accepted");
  setText("#plan-cache", plan?.cache ?? projection.renderPlan?.cache ?? "not accepted");
  setText(
    "#plan-residual",
    plan?.steps.some((step) => step.engine === "client") ? "bounded client step" : plan ? "none" : "not accepted",
  );
  const steps = element<HTMLOListElement>("#plan-steps");
  steps.replaceChildren();
  for (const step of plan?.steps ?? []) {
    const item = document.createElement("li");
    item.textContent = `${step.engine} · ${step.operation} · ${step.pushdown} pushdown · ${step.reason}`;
    steps.append(item);
  }
  if (!plan) steps.append(listMessage("No accepted query plan.", "empty-state"));
}

async function runAcceptedQuery(): Promise<void> {
  const projection = currentProjection;
  if (!projection?.actions.query.enabled || !projection.queryPlan || !projection.source) return;
  generatedOperation = "query";
  updateGeneratedCode("query");
  const controller = replaceOperationController();
  setText("#map-status", "executing accepted plan");
  try {
    const execution = await executeQueryPlan(projection.queryPlan, projection.source, { signal: controller.signal });
    controller.signal.throwIfAborted();
    await applyQueryResult(projection, execution.result, controller.signal);
    controller.signal.throwIfAborted();
    renderResult(execution.result);
    runtime.resultCount = execution.result.features.length;
    runtime.interactionCount += 1;
    setText("#result-count", `${execution.result.features.length}${execution.result.exceededTransferLimit ? "+" : ""}`);
    setText("#map-status", execution.result.features.length === 0 ? "empty exact result" : "exact result projected");
    presentation.showDegradation(execution.result.degraded?.map((entry) => entry.reason) ?? []);
  } catch (error) {
    if (operationController === controller) {
      if (controller.signal.aborted) showOperationAbort(controller.signal.reason);
      else showOperationFailure(error, "query execution failed");
    }
  } finally {
    finishOperation(controller);
  }
}

async function renderAcceptedSource(): Promise<void> {
  const projection = currentProjection;
  const plan = projection?.renderPlan;
  if (!projection?.actions.render.enabled || !plan?.selected || !projection.source) return;
  generatedOperation = "render";
  updateGeneratedCode("render");
  const controller = replaceOperationController();
  try {
    if (plan.selected.strategy === "geojson-query") {
      if (!projection.queryPlan) throw new Error("accepted render plan is missing its accepted query plan");
      const execution = await executeQueryPlan(projection.queryPlan, projection.source, { signal: controller.signal });
      controller.signal.throwIfAborted();
      await applyQueryResult(projection, execution.result, controller.signal);
      controller.signal.throwIfAborted();
      renderResult(execution.result);
      runtime.resultCount = execution.result.features.length;
      setText("#result-count", String(execution.result.features.length));
    } else {
      await applyNativePlan(plan, controller.signal);
    }
    runtime.interactionCount += 1;
    setText("#map-status", `${plan.selected.strategy} mounted`);
    showRenderPlan(plan);
  } catch (error) {
    if (operationController === controller) {
      if (controller.signal.aborted) showOperationAbort(controller.signal.reason);
      else showOperationFailure(error, "render preparation failed");
    }
  } finally {
    finishOperation(controller);
  }
}

async function applyQueryResult(
  projection: ServiceExplorerOperationProjection,
  result: Result<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<void> {
  if (!projection.source || !projection.queryPlan) return;
  signal.throwIfAborted();
  const mapProjection = projectSourceToMapLibre(projection.source, projection.queryPlan, result, {
    sourceId: MAP_SOURCE_ID,
    layerId: "service-explorer-features",
  });
  await waitForMapStyle(signal);
  signal.throwIfAborted();
  clearMapPreview();
  map.addSource(mapProjection.sourceId, mapProjection.source as maplibregl.SourceSpecification);
  mapSourceId = mapProjection.sourceId;
  for (const layer of mapProjection.layers) {
    map.addLayer(layer as unknown as maplibregl.LayerSpecification);
    mapLayerIds.push(String(layer.id));
  }
}

async function applyNativePlan(plan: AutomaticMapLibrePlan, signal: AbortSignal): Promise<void> {
  if (!plan.source) throw new Error("accepted native render plan is missing a source projection");
  await waitForMapStyle(signal);
  signal.throwIfAborted();
  clearMapPreview();
  map.addSource(plan.sourceId, plan.source as maplibregl.SourceSpecification);
  mapSourceId = plan.sourceId;
  for (const layer of plan.layers) {
    map.addLayer(layer as unknown as maplibregl.LayerSpecification);
    mapLayerIds.push(String(layer.id));
  }
}

function clearMapPreview(): void {
  for (const layerId of mapLayerIds.reverse()) if (map.getLayer(layerId)) map.removeLayer(layerId);
  mapLayerIds = [];
  if (mapSourceId && map.getSource(mapSourceId)) map.removeSource(mapSourceId);
  mapSourceId = undefined;
}

function renderResult(result: Result<Record<string, unknown>>): void {
  resultHead.replaceChildren();
  resultBody.replaceChildren();
  const fields = [...new Set(result.features.flatMap((feature) => Object.keys(feature.attributes)))].slice(0, 8);
  if (fields.length === 0) {
    resultBody.append(
      tableMessage(result.features.length === 0 ? "The accepted query returned no rows." : "Rows have no attributes."),
    );
    return;
  }
  const headerRow = document.createElement("tr");
  for (const field of fields) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = field;
    headerRow.append(cell);
  }
  resultHead.append(headerRow);
  for (const feature of result.features) {
    const row = document.createElement("tr");
    for (const field of fields) {
      const cell = document.createElement("td");
      cell.textContent = boundedValue(feature.attributes[field]);
      row.append(cell);
    }
    resultBody.append(row);
  }
}

function showRenderPlan(plan: AutomaticMapLibrePlan): void {
  setText("#plan-id", plan.id);
  setText("#plan-pushdown", plan.selected?.dataPath === "materialized" ? "query plan" : "native");
  setText("#plan-fidelity", plan.selected?.fidelity ?? "not accepted");
  setText("#plan-cache", plan.cache);
  setText("#plan-residual", "none");
  const steps = element<HTMLOListElement>("#plan-steps");
  steps.replaceChildren();
  for (const candidate of plan.candidates) {
    const item = document.createElement("li");
    item.textContent = `${candidate.strategy} · ${candidate.eligible ? "eligible" : candidate.reason} · ${candidate.message}`;
    steps.append(item);
  }
}

function updateGeneratedCode(operation: ServiceExplorerOperationId): void {
  const state = currentState;
  const projection = currentProjection;
  if (!state || !projection || !projection.actions[operation].enabled) {
    codeOutput.textContent = `// ${projection?.actions[operation].code ?? "source.selection-required"}: ${projection?.actions[operation].reason ?? "Inspect an endpoint first."}`;
    copyButton.disabled = true;
    return;
  }
  codeOutput.textContent = generateServiceExplorerCode(state, projection, operation);
  copyButton.disabled = false;
}

async function copyGeneratedCode(): Promise<void> {
  if (copyButton.disabled) return;
  try {
    await navigator.clipboard.writeText(codeOutput.textContent ?? "");
    setText("#copy-status", "Copied the evidence-equivalent TypeScript.");
  } catch {
    setText("#copy-status", "Clipboard access was unavailable; select the code manually.");
  }
}

function selectedSource(state: ServiceExplorerReadyState): ServiceExplorerSourceView | undefined {
  const id = state.inspection.dataset.selectedSourceId;
  return id ? state.inspection.sources.find((source) => source.id === id) : state.inspection.sources[0];
}

function setStateBadge(kind: ServiceExplorerTruthState["kind"]): void {
  const label = kind === "partial" ? "Partial evidence" : kind.charAt(0).toUpperCase() + kind.slice(1);
  setText("#state-label", label);
  element<HTMLElement>("#state-dot").dataset.state = kind;
}

function replaceOperationController(): AbortController {
  abortActiveOperation(new DOMException("Service Explorer operation was superseded", "AbortError"));
  const controller = new AbortController();
  operationController = controller;
  operationDeadline = window.setTimeout(() => {
    controller.abort(
      new DOMException(
        `Service Explorer operation exceeded ${SERVICE_EXPLORER_OPERATION_TIMEOUT_MS}ms`,
        "TimeoutError",
      ),
    );
  }, SERVICE_EXPLORER_OPERATION_TIMEOUT_MS);
  queryButton.disabled = true;
  renderButton.disabled = true;
  cancelButton.disabled = false;
  return controller;
}

function finishOperation(controller: AbortController): void {
  if (operationController !== controller) return;
  if (operationDeadline !== undefined) window.clearTimeout(operationDeadline);
  operationDeadline = undefined;
  operationController = undefined;
  cancelButton.disabled = truth.state.kind !== "loading";
  refreshOperationProjection();
}

function abortActiveOperation(reason: unknown): void {
  const controller = operationController;
  operationController = undefined;
  if (operationDeadline !== undefined) window.clearTimeout(operationDeadline);
  operationDeadline = undefined;
  if (controller && !controller.signal.aborted) controller.abort(reason);
}

function waitForMapStyle(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (map.isStyleLoaded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanupListeners = () => {
      map.off("load", loaded);
      map.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const loaded = () => {
      cleanupListeners();
      resolve();
    };
    const failed = (event: maplibregl.ErrorEvent) => {
      cleanupListeners();
      reject(event.error);
    };
    const aborted = () => {
      cleanupListeners();
      reject(signal.reason);
    };
    map.once("load", loaded);
    map.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function showOperationFailure(error: unknown, fallback: string): void {
  const code = isHonuaError(error) ? error.sdkCode : "service-explorer.operation-failed";
  setText("#map-status", `${code}: ${fallback}`);
  presentation.showDegradation([code]);
}

function showOperationAbort(reason: unknown): void {
  const timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
  const code = timedOut ? "operation.timeout" : "operation.cancelled";
  setText("#map-status", timedOut ? `${code}: operation exceeded its bounded deadline` : `${code}: operation stopped`);
  presentation.showDegradation([code]);
}

function boundedValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value).slice(0, 256);
  } catch {
    return "[unprintable]";
  }
}

function appendFact(host: HTMLElement, label: string, value: string): void {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  wrapper.append(term, detail);
  host.append(wrapper);
}

function message(text: string, className?: string): HTMLElement {
  const node = document.createElement("p");
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function listMessage(text: string, className?: string): HTMLLIElement {
  const node = document.createElement("li");
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function tableMessage(text: string): HTMLTableRowElement {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
  return row;
}

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing Service Explorer element: ${selector}`);
  return value;
}

function setText(selector: string, value: string): void {
  element<HTMLElement>(selector).textContent = value;
}

function disposeDemo(): Promise<void> {
  if (disposePromise) return disposePromise;
  abortActiveOperation(new DOMException("Service Explorer demo was disposed", "AbortError"));
  runtime.disposed = true;
  runtime.ready = false;
  disposePromise = cleanup.dispose();
  return disposePromise;
}
