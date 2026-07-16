import maplibregl from "maplibre-gl";

import type { Query } from "@honua/sdk-js";
import { mountSource } from "@honua/sdk-js/map";
import type { MountedSource, MountedSourceDiagnostics } from "@honua/sdk-js/map";

import { SampleCleanupRegistry } from "../../_kit/cleanup.js";
import { mountSamplePresentation } from "../../_kit/presentation.js";
import { resolveFirstMapConfig } from "./first-map-config.js";
import { firstMapCopyCode } from "./first-map-copy.js";
import type { FirstMapReady } from "./first-map-model.js";
import {
  FIRST_MAP_RUNTIME_BUDGET_MS,
  type FirstMapShellConfig,
  resolveFirstMapShellConfig,
  toFirstMapConfigInput,
} from "./first-map-shell-config.js";
import { createQuickstartTelemetry } from "./telemetry.js";
import { runFirstMapWorkflow } from "./workflow.js";

type Attributes = Record<string, unknown>;
type Ready = FirstMapReady<Attributes>;
type Config = ReturnType<typeof resolveFirstMapConfig<Attributes>>;

interface ActiveRun {
  readonly abort: AbortController;
  config?: Config;
  disposed?: boolean;
  ready?: Ready;
  map?: maplibregl.Map;
  mounted?: MountedSource<Attributes>;
  keyboardPopup?: maplibregl.Popup;
}

const stages = ["connect", "discover", "explain", "query", "mount"] as const;
const telemetry = createQuickstartTelemetry();
const lifecycle = new SampleCleanupRegistry();
let shellConfig: FirstMapShellConfig;
let active: ActiveRun | undefined;
let generation = 0;
let shellDisposed = false;
let presentation: ReturnType<typeof mountSamplePresentation> | undefined;

export function startFirstMapShell(): void {
  try {
    shellConfig = resolveFirstMapShellConfig(
      {
        VITE_HONUA_FIRST_MAP_BASEMAP_STYLE: import.meta.env.VITE_HONUA_FIRST_MAP_BASEMAP_STYLE,
        VITE_HONUA_FIRST_MAP_FILTER: import.meta.env.VITE_HONUA_FIRST_MAP_FILTER,
        VITE_HONUA_FIRST_MAP_MAX_FEATURES: import.meta.env.VITE_HONUA_FIRST_MAP_MAX_FEATURES,
        VITE_HONUA_FIRST_MAP_MODE: import.meta.env.VITE_HONUA_FIRST_MAP_MODE,
        VITE_HONUA_FIRST_MAP_PROTOCOL: import.meta.env.VITE_HONUA_FIRST_MAP_PROTOCOL,
        VITE_HONUA_FIRST_MAP_SOURCE_ID: import.meta.env.VITE_HONUA_FIRST_MAP_SOURCE_ID,
        VITE_HONUA_FIRST_MAP_URL: import.meta.env.VITE_HONUA_FIRST_MAP_URL,
      },
      window.location.origin,
    );
    presentation = mountSamplePresentation({
      sampleId: "maplibre-quickstart",
      evidence: {
        mode: shellConfig.mode === "fixture" ? "fixture replay" : "anonymous public endpoint",
        authentication: "none",
        workflow: "connect → discover → explain → query → mount",
        runtimeBudget: `${FIRST_MAP_RUNTIME_BUDGET_MS} ms`,
      },
      onDispose: disposeShell,
    });
    lifecycle.add(() => presentation?.root.remove());
    populateInitialForm(shellConfig);
    bindControls();
    telemetry.emit("init", { mode: shellConfig.mode, endpointOrigin: new URL(shellConfig.endpoint).origin });
    void runFromForm();
  } catch (error) {
    renderFailure(error);
  }
}

function bindControls(): void {
  lifecycle.listen(element<HTMLFormElement>("endpoint-form"), "submit", (event) => {
    event.preventDefault();
    void runFromForm();
  });
  lifecycle.listen(element<HTMLFormElement>("filter-form"), "submit", (event) => {
    event.preventDefault();
    void applyFilter();
  });
  lifecycle.listen(element<HTMLButtonElement>("clear-filter"), "click", () => {
    element<HTMLInputElement>("native-filter").value = "";
    void applyFilter();
  });
  lifecycle.listen(element<HTMLButtonElement>("inspect-visible"), "click", inspectVisibleFeature);
  lifecycle.listen(element<HTMLButtonElement>("copy-code"), "click", () => void copyVisibleCode());
  const resetSourceChoice = () => {
    element<HTMLSelectElement>("source-id").replaceChildren();
    element<HTMLElement>("source-field").hidden = true;
  };
  lifecycle.listen(element<HTMLInputElement>("endpoint-url"), "input", resetSourceChoice);
  lifecycle.listen(element<HTMLSelectElement>("protocol-hint"), "change", resetSourceChoice);
  window.__HONUA_QUICKSTART_DISPOSE__ = disposeShell;
  lifecycle.add(() => {
    delete window.__HONUA_QUICKSTART_DISPOSE__;
  });
  lifecycle.listen(window, "pagehide", () => void disposeShell(), { once: true });
}

function populateInitialForm(config: FirstMapShellConfig): void {
  element<HTMLInputElement>("endpoint-url").value = config.endpoint;
  element<HTMLSelectElement>("protocol-hint").value = config.protocol;
  element<HTMLInputElement>("native-filter").value = config.query.where ?? "";
  setMode(config.mode);
}

async function runFromForm(): Promise<void> {
  const runId = ++generation;
  const previous = active;
  active = undefined;
  if (reportCleanupFailures(await disposeRun(previous))) return;
  if (shellDisposed || runId !== generation) return;
  resetJourney();
  hide("workflow-error");
  hide("overflow-warning");
  const abort = new AbortController();
  const resources: ActiveRun = { abort };
  active = resources;
  setRunning(true);
  telemetry.patchRuntime({ disposed: false, journeyComplete: false, mapReady: false, lastError: null });
  setOverlay("loading", "Inspecting endpoint", "Honua is discovering sources and explaining a bounded map strategy.");
  const endpoint = element<HTMLInputElement>("endpoint-url").value.trim();
  const protocol = element<HTMLSelectElement>("protocol-hint").value as FirstMapShellConfig["protocol"];
  const sourceId = element<HTMLElement>("source-field").hidden
    ? undefined
    : element<HTMLSelectElement>("source-id").value;
  let config: Config;
  try {
    config = resolveFirstMapConfig(toFirstMapConfigInput(shellConfig, { endpoint, protocol, sourceId }));
  } catch (error) {
    renderFailure(error);
    if (active === resources) active = undefined;
    reportCleanupFailures(await disposeRun(resources));
    setRunning(false);
    return;
  }
  resources.config = config;
  setMode(config.mode);
  const startedAt = performance.now();
  const result = await runFirstMapWorkflow(config, { signal: abort.signal });
  if (runId !== generation || abort.signal.aborted || shellDisposed) {
    if (result.state === "ready") resources.ready = result;
    reportCleanupFailures(await disposeRun(resources));
    return;
  }
  if (result.state === "source-selection-required") {
    completeStage("connect", startedAt, "Connected");
    completeStage("discover", startedAt, `${result.sources.length} sources advertised`);
    renderSourceChoices(
      result.sources.map(({ id }) => id),
      result.reason,
    );
    setOverlay("choice", "Choose an advertised source", "Honua never guesses when discovery is ambiguous.");
    if (active === resources) active = undefined;
    reportCleanupFailures(await disposeRun(resources));
    setRunning(false);
    return;
  }
  if (result.state !== "ready") {
    renderFailure(new Error(`${result.error.code}: ${result.error.message}`));
    if (active === resources) active = undefined;
    reportCleanupFailures(await disposeRun(resources));
    setRunning(false);
    return;
  }
  resources.ready = result;
  completeStage("connect", startedAt, result.view.connection.protocol);
  completeStage("discover", startedAt, result.view.source.id);
  completeStage("explain", startedAt, result.view.strategy);
  telemetry.emit("plan-explained", { strategy: result.view.strategy, reasons: result.view.strategyReasons });
  renderWorkflowEvidence(config, result);
  renderCopyCode(config, config.query);
  try {
    telemetry.emit("query-started", { sourceId: result.view.source.id, limit: result.view.maxFeatures });
    await mountReadyResult(result, shellConfig.basemapStyle, resources);
    if (runId !== generation || abort.signal.aborted) return;
    const diagnostics = resources.mounted?.diagnostics;
    if (!diagnostics) throw new Error("First Map mount completed without diagnostics.");
    completeStage("query", startedAt, `${diagnostics.featureCount ?? 0} features`);
    completeStage("mount", startedAt, `${resources.mounted?.layerIds.length ?? 0} layers`);
    renderMountedDiagnostics(diagnostics);
    const firstMapDurationMs = Math.round(performance.now() - startedAt);
    const withinRuntimeBudget = firstMapDurationMs <= FIRST_MAP_RUNTIME_BUDGET_MS;
    text("evidence-runtime", `${firstMapDurationMs} / ${FIRST_MAP_RUNTIME_BUDGET_MS} ms`);
    setOverlay("ready", "Map ready", "Filter the source or inspect a visible feature with the keyboard.");
    telemetry.emit("query-finished", { featureCount: diagnostics.featureCount, totalCount: diagnostics.totalCount });
    telemetry.emit("map-ready", {
      strategy: diagnostics.strategy,
      layerIds: resources.mounted?.layerIds,
      firstMapDurationMs,
      runtimeBudgetMs: FIRST_MAP_RUNTIME_BUDGET_MS,
      withinRuntimeBudget,
    });
    telemetry.patchRuntime({
      mode: config.mode === "fixture" ? "fixture" : "live",
      baseUrl: new URL(config.endpoint).origin,
      serviceId: result.view.source.id,
      featureCount: diagnostics.featureCount,
      renderableFeatureCount: diagnostics.featureCount,
      geometryTypes: diagnostics.geometryKinds ? [...diagnostics.geometryKinds] : [],
      planId: diagnostics.strategy,
      firstMapDurationMs,
      runtimeBudgetMs: FIRST_MAP_RUNTIME_BUDGET_MS,
      withinRuntimeBudget,
      mapReady: true,
      layerIds: resources.mounted ? [...resources.mounted.layerIds] : [],
      linkedVisibleFeatureCount: diagnostics.featureCount,
      journeyComplete: true,
    });
    presentation?.updateEvidence({
      mode: config.mode === "fixture" ? "fixture replay" : "anonymous public endpoint",
      authentication: "none",
      protocol: result.view.connection.protocol,
      source: result.view.source.id,
      cache: result.view.connection.cacheStatus,
      firstMap: `${firstMapDurationMs} ms`,
      runtimeBudget: `${FIRST_MAP_RUNTIME_BUDGET_MS} ms (${withinRuntimeBudget ? "pass" : "exceeded"})`,
    });
    presentation?.showDegradation(result.view.connection.diagnostics.map(({ code, message }) => `${code}: ${message}`));
    if (!withinRuntimeBudget) {
      throw new Error(`First Map exceeded its ${FIRST_MAP_RUNTIME_BUDGET_MS} ms runtime budget.`);
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      renderFailure(error);
      if (active === resources) active = undefined;
      reportCleanupFailures(await disposeRun(resources));
    }
  } finally {
    if (runId === generation && !shellDisposed) setRunning(false);
  }
}

async function mountReadyResult(result: Ready, basemapStyle: string, resources: ActiveRun): Promise<void> {
  const map = new maplibregl.Map({
    container: "map",
    style: basemapStyle,
    center: [-157.86, 21.31],
    zoom: 10,
    cooperativeGestures: true,
  });
  resources.map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  await mapLoaded(map, resources.abort.signal);
  resources.mounted = await mountSource(map, result.mount.source, {
    ...result.mount.options,
    signal: resources.abort.signal,
    fitBounds: { padding: 56 },
    hover: true,
    popup: {
      factory: () => new maplibregl.Popup({ maxWidth: "22rem" }),
      render: ({ features }) => popupContent(features[0]?.properties ?? {}, "Map feature"),
    },
  });
  await nextMapIdle(map);
}

async function applyFilter(): Promise<void> {
  const resources = active;
  const mounted = resources?.mounted;
  const ready = resources?.ready;
  const config = resources?.config;
  if (!resources || !mounted || !ready || !config || mounted.state !== "ready") return;
  const runId = generation;
  const input = element<HTMLInputElement>("native-filter");
  const submit = element<HTMLButtonElement>("apply-filter");
  submit.disabled = true;
  hide("filter-error");
  try {
    const { where: _previous, ...baseQuery } = ready.mount.options.query ?? {};
    void _previous;
    const where = input.value.trim();
    const query: Readonly<Omit<Query<Attributes>, "signal">> = where ? { ...baseQuery, where } : baseQuery;
    const diagnostics = await mounted.setFilter(query);
    if (resources.map) await nextMapIdle(resources.map);
    if (active !== resources || runId !== generation || resources.abort.signal.aborted) return;
    renderMountedDiagnostics(diagnostics);
    renderCopyCode(config, query);
    hide("filter-error");
    telemetry.emit("linked-filter-changed", { active: Boolean(where), featureCount: diagnostics.featureCount });
    telemetry.patchRuntime({
      linkedVisibleFeatureCount: diagnostics.featureCount,
      linkedFilterCount: where ? 1 : 0,
    });
  } catch (error) {
    if (active === resources && !resources.abort.signal.aborted) showError("filter-error", error);
  } finally {
    if (active === resources && runId === generation) submit.disabled = false;
  }
}

function inspectVisibleFeature(): void {
  const resources = active;
  if (!resources?.map || !resources.mounted) return;
  const feature = resources.map.queryRenderedFeatures(undefined, { layers: [...resources.mounted.layerIds] })[0];
  if (!feature) {
    showError("filter-error", new Error("No rendered feature is currently available to inspect."));
    return;
  }
  resources.keyboardPopup?.remove();
  const properties = feature.properties ?? {};
  const popup = new maplibregl.Popup({ maxWidth: "22rem" })
    .setLngLat(resources.map.getCenter())
    .setDOMContent(popupContent(properties, "Visible feature details"))
    .addTo(resources.map);
  popup.on("close", () => telemetry.patchRuntime({ popupOpen: false }));
  resources.keyboardPopup = popup;
  popup.getElement().querySelector<HTMLElement>(".popup-card")?.focus();
  const featureId = feature.id ?? properties.OBJECTID ?? properties.id ?? null;
  telemetry.emit("feature-selected", { featureId });
  telemetry.patchRuntime({ selectedFeatureId: featureId === null ? null : String(featureId), popupOpen: true });
}

function popupContent(properties: Record<string, unknown>, label: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "popup-card";
  article.role = "dialog";
  article.ariaLabel = label;
  article.tabIndex = -1;
  const heading = document.createElement("h3");
  heading.textContent = displayValue(properties.NAME ?? properties.name ?? properties.title ?? "Feature");
  article.append(heading);
  for (const [name, value] of Object.entries(properties).slice(0, 6)) {
    const row = document.createElement("p");
    const key = document.createElement("strong");
    key.textContent = `${name}: `;
    row.append(key, displayValue(value));
    article.append(row);
  }
  return article;
}

function renderWorkflowEvidence(config: ReturnType<typeof resolveFirstMapConfig<Attributes>>, ready: Ready): void {
  text("evidence-endpoint", ready.view.connection.endpoint);
  text("evidence-protocol", ready.view.connection.protocol);
  text("evidence-source", ready.view.source.id);
  text("evidence-cache", ready.view.connection.cacheStatus);
  text("evidence-observed", ready.view.connection.observedAt ?? "Not advertised");
  text("evidence-attribution", ready.view.source.attribution ?? "Not advertised by source");
  text("plan-strategy", ready.view.strategy);
  text("plan-limit", String(ready.view.maxFeatures));
  const capabilities = element<HTMLUListElement>("capability-list");
  capabilities.replaceChildren(...ready.view.source.capabilities.map(tag));
  const reasons = element<HTMLUListElement>("plan-reasons");
  reasons.replaceChildren(
    ...(ready.view.strategyReasons.length > 0
      ? ready.view.strategyReasons.map((reason) => listItem(`${reason.code}: ${reason.message}`))
      : [listItem("No strategy degradation was required.")]),
  );
  const diagnostics = element<HTMLUListElement>("connection-diagnostics");
  diagnostics.replaceChildren(
    ...(ready.view.connection.diagnostics.length > 0
      ? ready.view.connection.diagnostics.map((item) => listItem(`${item.code}: ${item.message}`))
      : [listItem("No discovery warnings.")]),
  );
  telemetry.patchRuntime({ mode: config.mode === "fixture" ? "fixture" : "live" });
}

function renderMountedDiagnostics(diagnostics: MountedSourceDiagnostics): void {
  const featureCount = diagnostics.featureCount ?? 0;
  text("linked-visible-count", String(featureCount));
  text("map-visible-count", `${featureCount} visible`);
  text("map-filter-count", element<HTMLInputElement>("native-filter").value.trim() ? "1 filter" : "No filter");
  text("diagnostic-geometry", diagnostics.geometryKinds?.join(", ") || "No renderable geometry");
  text("diagnostic-total", diagnostics.totalCount === undefined ? "Not reported" : String(diagnostics.totalCount));
  element<HTMLButtonElement>("inspect-visible").disabled = featureCount === 0;
  if (diagnostics.overflow?.truncated) {
    text(
      "overflow-warning",
      `Showing ${diagnostics.overflow.renderedFeatureCount} of ${diagnostics.overflow.totalCount ?? "more than the"} matching features (limit ${diagnostics.overflow.limit}).`,
    );
    show("overflow-warning");
  } else {
    hide("overflow-warning");
  }
}

function renderSourceChoices(sourceIds: readonly string[], reason: string): void {
  const field = element<HTMLElement>("source-field");
  const select = element<HTMLSelectElement>("source-id");
  select.replaceChildren(
    ...sourceIds.map((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      return option;
    }),
  );
  field.hidden = false;
  text(
    "source-help",
    reason === "ambiguous" ? "Choose one source; First Map will not guess." : "Choose a valid source.",
  );
  select.focus();
}

function renderCopyCode(config: Config, query: Readonly<Omit<Query<Attributes>, "signal">>): void {
  element<HTMLElement>("copyable-code").textContent = firstMapCopyCode(config, shellConfig.basemapStyle, query);
}

async function copyVisibleCode(): Promise<void> {
  const code = element<HTMLElement>("copyable-code").textContent ?? "";
  try {
    await navigator.clipboard.writeText(code);
    text("copy-status", "Copied to clipboard.");
  } catch (error) {
    showError("copy-status", error);
  }
}

async function disposeRun(resources: ActiveRun | undefined): Promise<unknown[]> {
  if (!resources || resources.disposed) return [];
  resources.disposed = true;
  resources.abort.abort(new DOMException("First Map run disposed", "AbortError"));
  const failures: unknown[] = [];
  for (const cleanup of [
    () => resources.keyboardPopup?.remove(),
    () => resources.mounted?.dispose(),
    () => resources.map?.remove(),
    () => resources.ready?.dispose(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function disposeShell(): Promise<void> {
  if (shellDisposed) return;
  shellDisposed = true;
  generation += 1;
  const resources = active;
  active = undefined;
  const failures = await disposeRun(resources);
  try {
    await lifecycle.dispose();
  } catch (error) {
    failures.push(error);
  }
  telemetry.patchRuntime({ disposed: true, journeyComplete: false, mapReady: false, popupOpen: false });
  if (failures.length > 0) {
    const error = new AggregateError(failures, "First Map cleanup did not complete cleanly.");
    telemetry.emit("error", { message: error.message, phase: "cleanup" });
    telemetry.patchRuntime({ lastError: error.message });
    throw error;
  }
}

function renderFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "First Map could not complete the workflow.";
  telemetry.emit("error", { message });
  telemetry.patchRuntime({ lastError: message, journeyComplete: false, mapReady: false });
  presentation?.showError(error);
  showError("workflow-error", error);
  setOverlay("error", "Map unavailable", message);
  const pending = stages.find((stage) => element<HTMLElement>(`journey-${stage}`).dataset.state !== "complete");
  if (pending) element<HTMLElement>(`journey-${pending}`).dataset.state = "error";
}

function reportCleanupFailures(failures: readonly unknown[]): boolean {
  if (failures.length === 0) return false;
  renderFailure(new AggregateError([...failures], "First Map cleanup did not complete cleanly."));
  return true;
}

function setRunning(running: boolean): void {
  element<HTMLElement>("endpoint-form").setAttribute("aria-busy", String(running));
  element<HTMLButtonElement>("build-map").disabled = running;
  element<HTMLButtonElement>("apply-filter").disabled = running;
  element<HTMLButtonElement>("clear-filter").disabled = running;
}

function resetJourney(): void {
  for (const stage of stages) {
    const item = element<HTMLElement>(`journey-${stage}`);
    item.dataset.state = "pending";
    const detail = item.querySelector("small");
    if (detail) detail.textContent = "Waiting";
  }
}

function completeStage(stage: (typeof stages)[number], startedAt: number, detail: string): void {
  const item = element<HTMLElement>(`journey-${stage}`);
  item.dataset.state = "complete";
  const description = item.querySelector("small");
  if (description) description.textContent = `${Math.round(performance.now() - startedAt)} ms · ${detail}`;
}

function setMode(mode: "fixture" | "public-live"): void {
  const badge = element<HTMLElement>("mode-badge");
  badge.dataset.mode = mode;
  badge.textContent = mode === "fixture" ? "Fixture replay" : "Anonymous public endpoint";
}

function setOverlay(state: string, title: string, body: string): void {
  const overlay = element<HTMLElement>("map-overlay");
  overlay.dataset.state = state;
  text("map-overlay-title", title);
  text("map-overlay-body", body);
}

function showError(id: string, error: unknown): void {
  text(id, error instanceof Error ? error.message : String(error));
  show(id);
}

function tag(value: string): HTMLLIElement {
  const item = listItem(value);
  item.className = "tag";
  return item;
}

function listItem(value: string): HTMLLIElement {
  const item = document.createElement("li");
  item.textContent = value;
  return item;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`First Map markup is missing #${id}.`);
  return value as T;
}

function text(id: string, value: string): void {
  element(id).textContent = value;
}

function show(id: string): void {
  element(id).hidden = false;
}

function hide(id: string): void {
  element(id).hidden = true;
}

function mapLoaded(map: maplibregl.Map, signal: AbortSignal): Promise<void> {
  if (map.loaded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLoad = () => finish(resolve);
    const onAbort = () => finish(() => reject(signal.reason));
    const finish = (done: () => void) => {
      map.off("load", onLoad);
      signal.removeEventListener("abort", onAbort);
      done();
    };
    map.on("load", onLoad);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function nextMapIdle(map: maplibregl.Map): Promise<void> {
  if (map.loaded() && !map.isMoving()) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 2_000);
    map.once("idle", () => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}
