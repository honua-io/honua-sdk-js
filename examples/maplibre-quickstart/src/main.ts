import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";
import "../../_kit/design/index.css";

import * as maplibregl from "maplibre-gl";

import {
  FIRST_MAP_FIXTURE_GEOSERVICES_PATH,
  FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH,
  PUBLIC_FIRST_MAP_ENDPOINT,
  SAME_ORIGIN_FIRST_MAP_FIXTURE,
  endpointForFirstMapProtocol,
  resolveFirstMapConfig,
} from "./first-map-config.js";
import type { FirstMapMode, FirstMapProtocol } from "./first-map-config.js";
import {
  FIRST_MAP_TIMING_BUDGETS_MS,
  collectFirstMapBounds,
  combineFirstMapLayerFilter,
  createFirstMapCode,
  createFirstMapFilterChoices,
  createIdempotentAsyncDispose,
  filterFirstMapFeatures,
  findFirstMapFeature,
  observeFirstMapTiming,
  summarizeFirstMapFeatures,
} from "./first-map-presentation.js";
import type { FirstMapFeatureSummary, FirstMapFilterChoice } from "./first-map-presentation.js";
import { createFirstMapFixtureFetch } from "./fixture-fetch.js";
import { createQuickstartTelemetry } from "./telemetry.js";
import { runFirstMapWorkflow } from "./workflow.js";
import type { FirstMapReady, FirstMapWorkflowResult } from "./workflow.js";

import "./styles.css";

declare const __HONUA_SDK_VERSION__: string;

declare global {
  interface Window {
    /**
     * Test-only hook: the currently mounted MapLibre map instance, used by
     * the sample-gate visual-evidence harness (test/playwright/sample-gate-assertions.mjs)
     * to wait for a fully idle map before capturing reproducible screenshots.
     * Not part of the sample's product surface.
     */
    __HONUA_QUICKSTART_MAP__?: maplibregl.Map;
  }
}

type ThemePreference = "auto" | "light" | "dark";

const THEME_SEQUENCE: readonly ThemePreference[] = ["auto", "light", "dark"];
const FIXTURE_BASEMAP_LAYER_ID = "background";

const FIRST_MAP_SOURCE_ID = "first-map-features";
const FIRST_MAP_LAYER_ID = "first-map-feature";
const FIXTURE_OGC_ROOT_PATH = "/ogc/features";
const FIXTURE_BASEMAP_STYLE = "__honua-quickstart__/basemap-style.json";
const PUBLIC_BASEMAP_STYLE = FIXTURE_BASEMAP_STYLE;

interface FirstMapLaunch {
  readonly endpoint: string;
  readonly mode: FirstMapMode;
  readonly protocol: FirstMapProtocol;
  readonly maxFeatures: number;
  readonly basemapStyle: string;
  readonly selectedRecordId?: string;
  readonly where?: string;
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function readOptional(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readProtocol(value: string | undefined): FirstMapProtocol {
  if (value === undefined || value === "auto") return "auto";
  if (value === "geoservices-feature-service" || value === "ogc-features") return value;
  throw new TypeError(`Unsupported First Map protocol hint: ${value}`);
}

function endpointFromEnvironment(env: Record<string, string | undefined>): { endpoint: string; live: boolean } {
  const direct = readOptional(env, "VITE_HONUA_QUICKSTART_ENDPOINT");
  if (direct === SAME_ORIGIN_FIRST_MAP_FIXTURE) {
    return { endpoint: new URL(`.${FIRST_MAP_FIXTURE_GEOSERVICES_PATH}/`, location.href).href, live: false };
  }
  if (direct) return { endpoint: direct, live: true };
  return { endpoint: PUBLIC_FIRST_MAP_ENDPOINT, live: true };
}

function initialLaunch(): FirstMapLaunch {
  const env = {
    VITE_HONUA_QUICKSTART_BASEMAP_STYLE: import.meta.env.VITE_HONUA_QUICKSTART_BASEMAP_STYLE,
    VITE_HONUA_QUICKSTART_ENDPOINT: import.meta.env.VITE_HONUA_QUICKSTART_ENDPOINT,
    VITE_HONUA_QUICKSTART_PROTOCOL: import.meta.env.VITE_HONUA_QUICKSTART_PROTOCOL,
    VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT: import.meta.env.VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT,
    VITE_HONUA_QUICKSTART_WHERE: import.meta.env.VITE_HONUA_QUICKSTART_WHERE,
  };
  const configured = endpointFromEnvironment(env);
  const maxFeatures = Number(readOptional(env, "VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT") ?? "25");
  const where =
    readOptional(env, "VITE_HONUA_QUICKSTART_WHERE") ??
    (configured.endpoint === PUBLIC_FIRST_MAP_ENDPOINT ? `id <= ${maxFeatures}` : undefined);
  const selectedRecordId = configured.live ? undefined : "1";
  const mode: FirstMapMode = configured.live ? "public-live" : "fixture";
  return {
    endpoint: configured.endpoint,
    mode,
    protocol: readProtocol(readOptional(env, "VITE_HONUA_QUICKSTART_PROTOCOL")),
    maxFeatures,
    basemapStyle:
      readOptional(env, "VITE_HONUA_QUICKSTART_BASEMAP_STYLE") ??
      (mode === "fixture" ? FIXTURE_BASEMAP_STYLE : PUBLIC_BASEMAP_STYLE),
    ...(selectedRecordId ? { selectedRecordId } : {}),
    ...(where ? { where } : {}),
  };
}

function isPackagedFixtureEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  if (url.search || url.hash) return false;
  const fixtureBase = new URL(".", location.href);
  const endpointIdentity = (value: URL) => `${value.origin}${value.pathname.replace(/\/+$/, "") || "/"}`;
  const identity = endpointIdentity(url);
  return [
    FIRST_MAP_FIXTURE_GEOSERVICES_PATH,
    FIXTURE_OGC_ROOT_PATH,
    FIRST_MAP_FIXTURE_OGC_COLLECTION_PATH,
  ].some((path) => identity === endpointIdentity(new URL(`.${path}`, fixtureBase)));
}

function isFixtureEndpoint(endpoint: string): boolean {
  return isPackagedFixtureEndpoint(endpoint);
}

function safeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

function completeJourney(stage: "connect" | "discover" | "explain" | "query" | "mount", detail: string): void {
  const item = getElement<HTMLElement>(`#journey-${stage}`);
  item.dataset.state = "complete";
  const copy = item.querySelector<HTMLElement>("small");
  if (copy) copy.textContent = detail;
}

function resetJourney(): void {
  for (const stage of ["connect", "discover", "explain", "query", "mount"]) {
    const item = getElement<HTMLElement>(`#journey-${stage}`);
    item.dataset.state = "pending";
    const copy = item.querySelector<HTMLElement>("small");
    if (copy) copy.textContent = "Waiting";
  }
}

function resetPresentation(): void {
  setText("#result-count", "0 mapped features");
  setText("#result-provenance", "Connecting to the selected source");
  setText("#result-interaction", "Select a feature on the map or from the result list.");
  setText("#map-visible-count", "0 visible");
  setText("#map-filter-count", "0 filters");
  setText("#linked-visible-count", "0");
  setText("#linked-filter-state", "None");
  setText("#linked-extent", "Mounted result");
  setText("#status-feature-count", "0");
  setText("#status-geometry-types", "Waiting…");
  for (const selector of [
    "#evidence-endpoint",
    "#evidence-freshness",
    "#evidence-auth",
    "#evidence-versions",
    "#evidence-cache",
    "#evidence-degradation",
    "#evidence-timing",
    "#plan-id",
    "#plan-pushdown",
    "#plan-fidelity",
    "#plan-cache",
  ]) {
    setText(selector, "Waiting…");
  }
  setText("#evidence-source", "—");
  setText("#evidence-observed", "—");
  setText("#evidence-data-version", "—");
  getElement<HTMLElement>("#capability-list").replaceChildren();
  getElement<HTMLElement>("#plan-json").textContent = "{}";
  getElement<HTMLElement>("#linked-query-projection").textContent = "{}";
  const steps = getElement<HTMLOListElement>("#plan-steps");
  steps.replaceChildren();
  const pendingStep = document.createElement("li");
  pendingStep.textContent = "Waiting for discovery.";
  steps.append(pendingStep);
  const body = getElement<HTMLTableSectionElement>("#feature-list");
  body.replaceChildren();
  const row = body.insertRow();
  const cell = row.insertCell();
  cell.colSpan = 3;
  cell.className = "empty-copy";
  cell.textContent = "Loading the bounded query result…";
}

function renderFeatureList(
  summaries: readonly FirstMapFeatureSummary[],
  selectedId: string | undefined,
  select: (summary: FirstMapFeatureSummary) => void,
): void {
  const body = getElement<HTMLTableSectionElement>("#feature-list");
  body.replaceChildren();
  if (summaries.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.className = "empty-copy";
    cell.textContent = "No features match the mounted-result filter.";
    return;
  }
  for (const summary of summaries) {
    const row = body.insertRow();
    const featureCell = row.insertCell();
    const title = document.createElement("span");
    title.className = "feature-name";
    title.textContent = summary.title;
    const kind = document.createElement("span");
    kind.className = "feature-kind";
    kind.textContent = summary.geometryKind;
    featureCell.append(title, kind);
    row.insertCell().textContent = summary.subtitle;
    const action = row.insertCell();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hn-btn hn-btn--sm feature-inspect-button";
    button.dataset.featureId = summary.id;
    button.dataset.selected = summary.id === selectedId ? "true" : "false";
    button.setAttribute("aria-pressed", summary.id === selectedId ? "true" : "false");
    button.setAttribute("aria-label", `Inspect ${summary.title}`);
    button.textContent = "View";
    button.addEventListener("click", () => select(summary));
    action.append(button);
  }
}

function renderSelection(summary: FirstMapFeatureSummary | undefined): void {
  setText("#linked-selection-count", summary ? "1" : "0");
  setText("#selected-feature-title", summary?.title ?? "No linked selection");
  setText("#selected-feature-subtitle", summary?.subtitle ?? "Select a feature from the map or results list.");
  setText("#selected-feature-id", summary?.id ?? "—");
  setText("#selected-feature-geometry", summary?.geometryKind ?? "—");
  setText(
    "#result-interaction",
    summary ? `Selected ${summary.title}` : "Select a feature on the map or from the result list.",
  );
  const attributes = getElement<HTMLElement>("#selected-feature-attributes");
  attributes.replaceChildren();
  if (!summary) {
    const empty = document.createElement("div");
    empty.className = "empty-copy";
    empty.textContent = "Attributes will appear after a linked selection.";
    attributes.append(empty);
    return;
  }
  for (const [field, value] of Object.entries(summary.attributes).slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "attribute-row";
    const term = document.createElement("dt");
    term.textContent = field;
    const detail = document.createElement("dd");
    detail.textContent = value === null ? "null" : String(value);
    row.append(term, detail);
    attributes.append(row);
  }
}

function createPopupContent(summary: FirstMapFeatureSummary): HTMLElement {
  const article = document.createElement("div");
  article.className = "hn-popup";
  article.setAttribute("role", "region");
  article.setAttribute("aria-label", `${summary.title} feature details`);
  const kicker = document.createElement("p");
  kicker.className = "hn-register popup-kicker";
  kicker.textContent = summary.geometryKind;
  const heading = document.createElement("h3");
  heading.className = "hn-popup-title";
  heading.textContent = summary.title;
  const subtitle = document.createElement("p");
  subtitle.className = "hn-muted popup-subtitle";
  subtitle.textContent = summary.subtitle;
  const grid = document.createElement("div");
  grid.className = "popup-grid";
  for (const [field, value] of Object.entries(summary.attributes).slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "hn-popup-row";
    const key = document.createElement("span");
    key.className = "hn-popup-key";
    key.textContent = field;
    const detail = document.createElement("span");
    detail.className = "hn-popup-value";
    detail.textContent = value === null ? "null" : String(value);
    row.append(key, detail);
    grid.append(row);
  }
  article.append(kicker, heading, subtitle, grid);
  return article;
}

function renderFilterOptions(select: HTMLSelectElement, choices: readonly FirstMapFilterChoice[]): void {
  select.replaceChildren(new Option("All rendered features", ""));
  let group: HTMLOptGroupElement | undefined;
  let field: string | undefined;
  for (const choice of choices) {
    if (choice.field !== field) {
      field = choice.field;
      group = document.createElement("optgroup");
      group.label = choice.fieldLabel;
      select.append(group);
    }
    group?.append(new Option(choice.label, choice.id));
  }
  select.disabled = choices.length === 0;
}

function renderPlan(result: FirstMapReady<Record<string, unknown>>): void {
  const { plan } = result;
  setText("#plan-id", plan.id);
  setText("#plan-pushdown", plan.pushdown);
  setText("#plan-fidelity", plan.fidelity);
  setText("#plan-cache", `${plan.cache.action} (${plan.cache.reason})`);
  const steps = getElement<HTMLOListElement>("#plan-steps");
  steps.replaceChildren();
  for (const step of plan.steps) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = `${step.engine} / ${step.operation}`;
    item.append(label, ` — ${step.reason}`);
    steps.append(item);
  }
  getElement<HTMLElement>("#plan-json").textContent = JSON.stringify(
    { query: result.plan.ir.query, plan, execution: result.query.execution },
    null,
    2,
  );
}

function firstMapDegradation(result: FirstMapReady<Record<string, unknown>>): string[] {
  return [
    ...result.plan.warnings.map(({ message }) => message),
    ...(result.query.degraded?.map(({ reason }) => reason) ?? []),
    ...result.mounted.diagnostics.filter(({ severity }) => severity === "warning").map(({ message }) => message),
  ];
}

function renderEvidence(result: FirstMapReady<Record<string, unknown>>, timingMs: number, mode: FirstMapMode): void {
  const { view, plan, query } = result;
  const degradation = firstMapDegradation(result);
  const timing = observeFirstMapTiming(timingMs, FIRST_MAP_TIMING_BUDGETS_MS.fixtureWorkflowReady);
  setText("#evidence-endpoint", safeEndpoint(view.connection.endpoint));
  setText(
    "#evidence-source",
    `${view.source.protocol} · ${view.source.id} · ${view.source.attribution ?? "no attribution advertised"}`,
  );
  setText(
    "#evidence-freshness",
    view.connection.observedAt ? "SDK observation available" : "SDK observation unavailable",
  );
  setText(
    "#evidence-observed",
    view.connection.observedAt ? `Observed ${view.connection.observedAt}` : "Observation unavailable",
  );
  setText("#evidence-auth", "anonymous public");
  setText("#evidence-versions", `SDK ${__HONUA_SDK_VERSION__} · plan ${plan.version}`);
  setText("#evidence-data-version", `${query.execution.terminal.featureCount} accepted feature(s)`);
  setText("#evidence-cache", view.connection.cacheStatus);
  setText("#evidence-degradation", degradation.length > 0 ? degradation.join(" · ") : "None — exact accepted plan");
  setText(
    "#evidence-timing",
    mode === "fixture"
      ? `${timing.elapsedMs} ms / ${timing.budgetMs} ms (${timing.varianceMs >= 0 ? "+" : ""}${timing.varianceMs} ms)`
      : `${timing.elapsedMs} ms observed (fixture budget not applied)`,
  );
  const capabilities = getElement<HTMLElement>("#capability-list");
  capabilities.replaceChildren();
  for (const capability of view.source.capabilities) {
    const item = document.createElement("span");
    item.textContent = capability;
    capabilities.append(item);
  }
}

function workflowFailureMessage(
  result: Exclude<FirstMapWorkflowResult<Record<string, unknown>>, FirstMapReady<Record<string, unknown>>>,
): string {
  if (result.state === "source-selection-required") {
    return `Choose a source explicitly. Advertised: ${result.sources.map(({ id }) => id).join(", ") || "none"}.`;
  }
  return `${result.error.code}: ${result.error.message}`;
}

function mountedLayerIds(map: maplibregl.Map): string[] {
  return (map.getStyle().layers ?? [])
    .filter((layer) => "source" in layer && layer.source === FIRST_MAP_SOURCE_ID)
    .map(({ id }) => id);
}

function fitToFeatures(map: maplibregl.Map, summaries: readonly FirstMapFeatureSummary[]): void {
  const bounds = collectFirstMapBounds(summaries);
  if (!bounds) return;
  if (bounds.minX === bounds.maxX && bounds.minY === bounds.maxY) {
    map.jumpTo({ center: [bounds.minX, bounds.minY], zoom: 13 });
    return;
  }
  map.fitBounds(
    [
      [bounds.minX, bounds.minY],
      [bounds.maxX, bounds.maxY],
    ],
    { padding: 64, maxZoom: 14, duration: 0 },
  );
}

/**
 * Cartography: the deterministic fixture basemap is a single background layer,
 * so the app (which owns presentation) re-keys it to the active theme's
 * `--hn-basemap-land` token — land reads as the app surface shifted one step,
 * in light and dark alike. Live styles are left untouched.
 */
function harmonizeFixtureBasemap(map: maplibregl.Map | undefined, basemapStyle: string): void {
  if (!map || basemapStyle !== FIXTURE_BASEMAP_STYLE) return;
  const land = getComputedStyle(document.documentElement).getPropertyValue("--hn-basemap-land").trim();
  if (!land || !map.getLayer(FIXTURE_BASEMAP_LAYER_ID)) return;
  map.setPaintProperty(FIXTURE_BASEMAP_LAYER_ID, "background-color", land);
}

async function copyVisibleCode(): Promise<void> {
  const code = getElement<HTMLElement>("#workflow-code").textContent ?? "";
  const status = getElement<HTMLElement>("#copy-code-status");
  try {
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(code);
    status.textContent = "Copied workflow call site.";
  } catch {
    status.textContent = "Copy unavailable; select the visible code manually.";
    getElement<HTMLElement>("#workflow-code").focus();
  }
}

async function bootstrap(): Promise<void> {
  const telemetry = createQuickstartTelemetry(window);
  const form = getElement<HTMLFormElement>("#endpoint-form");
  const endpointInput = getElement<HTMLInputElement>("#endpoint-url");
  const protocolSelect = getElement<HTMLSelectElement>("#endpoint-protocol");
  const launchButton = getElement<HTMLButtonElement>("#load-endpoint-button");
  const filterSelect = getElement<HTMLSelectElement>("#attribute-filter");
  const clearFilterButton = getElement<HTMLButtonElement>("#clear-filter-button");
  const overlay = getElement<HTMLElement>("#map-overlay");
  const overlayTitle = getElement<HTMLElement>(".map-overlay-title");
  const overlayBody = getElement<HTMLElement>(".map-overlay-body");
  const startup = initialLaunch();
  const basemapStyle = startup.basemapStyle;
  let activeDispose: (() => Promise<void>) | undefined;
  let inFlightAbort: AbortController | undefined;
  let removeInFlightMap: (() => void) | undefined;

  endpointInput.value = startup.endpoint;
  protocolSelect.value = startup.protocol;

  const disposeCurrent = async (): Promise<void> => {
    inFlightAbort?.abort("First Map shell disposed");
    await activeDispose?.();
    removeInFlightMap?.();
    activeDispose = undefined;
    inFlightAbort = undefined;
    removeInFlightMap = undefined;
  };

  window.__HONUA_QUICKSTART_DISPOSE__ = disposeCurrent;
  window.addEventListener("beforeunload", () => void disposeCurrent(), { once: true });
  getElement<HTMLButtonElement>("#copy-code-button").addEventListener("click", () => void copyVisibleCode());

  const themeToggle = getElement<HTMLButtonElement>("#theme-toggle");
  let themePreference: ThemePreference = "auto";
  const applyThemePreference = (): void => {
    if (themePreference === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = themePreference;
    themeToggle.textContent = `Theme: ${themePreference}`;
    harmonizeFixtureBasemap(window.__HONUA_QUICKSTART_MAP__, basemapStyle);
  };
  themeToggle.addEventListener("click", () => {
    const nextIndex = (THEME_SEQUENCE.indexOf(themePreference) + 1) % THEME_SEQUENCE.length;
    themePreference = THEME_SEQUENCE[nextIndex] ?? "auto";
    applyThemePreference();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
    harmonizeFixtureBasemap(window.__HONUA_QUICKSTART_MAP__, basemapStyle),
  );

  const drawerToggle = getElement<HTMLButtonElement>("#drawer-toggle");
  const drawerContent = getElement<HTMLElement>("#drawer-content");
  drawerToggle.addEventListener("click", () => {
    const expanded = drawerToggle.getAttribute("aria-expanded") === "true";
    drawerToggle.setAttribute("aria-expanded", String(!expanded));
    drawerToggle.textContent = expanded ? "Expand" : "Collapse";
    drawerContent.hidden = expanded;
  });

  async function run(launch: FirstMapLaunch): Promise<void> {
    await disposeCurrent();
    resetJourney();
    resetPresentation();
    renderSelection(undefined);
    filterSelect.replaceChildren(new Option("All rendered features", ""));
    filterSelect.disabled = true;
    clearFilterButton.disabled = true;
    launchButton.disabled = true;
    form.setAttribute("aria-busy", "true");
    overlay.dataset.state = "loading";
    overlayTitle.textContent = "Connect → discover → explain → query → mount";
    overlayBody.textContent = "Running the published SDK workflow against the selected public endpoint.";
    setText("#status-error", "None");
    setText("#demo-status", "Waiting for the accepted plan and first usable map frame.");
    setText("#copy-code-status", "Code is ready to copy.");
    const modeBadge = getElement<HTMLElement>("#mode-badge");
    modeBadge.dataset.mode = launch.mode;
    modeBadge.textContent = launch.mode === "fixture" ? "Fixture replay" : "Anonymous live";
    telemetry.patchRuntime({
      mode: launch.mode,
      baseUrl: safeEndpoint(launch.endpoint),
      mapReady: false,
      journeyComplete: false,
      disposed: false,
      lastError: null,
    });
    telemetry.emit("init", { mode: launch.mode, endpoint: safeEndpoint(launch.endpoint), protocol: launch.protocol });

    const startedAt = performance.now();
    const controller = new AbortController();
    inFlightAbort = controller;
    const map = new maplibregl.Map({
      container: "map",
      style: basemapStyle,
      center: [-157.8583, 21.3069],
      zoom: 11,
      // Deterministic capture: MapLibre's default 300ms label/marker fade
      // makes back-to-back screenshots non-byte-identical while symbols are
      // still cross-fading in. The sample-gate visual-evidence harness also
      // waits for map.once("idle"), but eliminating the fade at the source
      // is what actually makes that wait sufficient.
      fadeDuration: 0,
    });
    window.__HONUA_QUICKSTART_MAP__ = map;
    map.on("style.load", () => harmonizeFixtureBasemap(map, basemapStyle));
    let mapRemoved = false;
    const removeMap = () => {
      if (mapRemoved) return;
      mapRemoved = true;
      if (window.__HONUA_QUICKSTART_MAP__ === map) window.__HONUA_QUICKSTART_MAP__ = undefined;
      map.remove();
    };
    removeInFlightMap = removeMap;
    try {
      const config = resolveFirstMapConfig({
        endpoint: launch.endpoint,
        mode: launch.mode,
        protocol: launch.protocol,
        maxFeatures: launch.maxFeatures,
        query: {
          ...(launch.where && launch.where !== "1=1" ? { where: launch.where } : {}),
          pagination: { limit: launch.maxFeatures },
        },
      });
      getElement<HTMLElement>("#workflow-code").textContent = createFirstMapCode(config);
      const result = await runFirstMapWorkflow(config, {
        map,
        maplibre: maplibregl,
        ...(launch.mode === "fixture" && isPackagedFixtureEndpoint(launch.endpoint)
          ? { fetchFn: createFirstMapFixtureFetch(launch.endpoint) }
          : {}),
        rendererOptions: {
          sourceId: FIRST_MAP_SOURCE_ID,
          layerId: FIRST_MAP_LAYER_ID,
          firstFrameEvent: "render",
        },
        signal: controller.signal,
      });
      if (result.state !== "ready") {
        const message = workflowFailureMessage(result);
        removeMap();
        overlay.dataset.state = "error";
        overlayTitle.textContent = "First Map stopped explicitly";
        overlayBody.textContent = message;
        setText("#status-error", message);
        setText("#demo-status", message);
        telemetry.patchRuntime({ lastError: message, mapReady: false });
        telemetry.emit("error", { state: result.state, message });
        return;
      }

      const workflowTiming = observeFirstMapTiming(
        performance.now() - startedAt,
        FIRST_MAP_TIMING_BUDGETS_MS.fixtureWorkflowReady,
      );
      const summaries = summarizeFirstMapFeatures(result.query.features);
      const choices = createFirstMapFilterChoices(summaries);
      const choicesById = new Map(choices.map((choice) => [choice.id, choice]));
      const layerIds = mountedLayerIds(map);
      const baseFilters = new Map(layerIds.map((layerId) => [layerId, map.getFilter(layerId)]));
      let selected: FirstMapFeatureSummary | undefined;
      let activePopup: maplibregl.Popup | undefined;
      let activeChoice: FirstMapFilterChoice | undefined;
      const cleanupCallbacks: Array<() => void> = [];

      completeJourney("connect", result.view.connection.protocol);
      completeJourney("discover", result.view.source.id);
      completeJourney("explain", result.plan.fingerprint.slice(0, 18));
      completeJourney("query", `${summaries.length} bounded feature(s)`);
      completeJourney("mount", `${layerIds.length} MapLibre layer(s)`);
      renderPlan(result);
      renderEvidence(result, workflowTiming.elapsedMs, launch.mode);
      renderFilterOptions(filterSelect, choices);
      clearFilterButton.disabled = choices.length === 0;
      fitToFeatures(map, summaries);
      setText("#status-compatibility", `Inspected via ${result.view.connection.protocol}`);
      setText("#status-target", safeEndpoint(result.view.connection.endpoint));
      setText("#status-service-layer", result.view.source.id);
      setText("#status-feature-count", `${summaries.length} accepted`);
      setText("#result-count", `${summaries.length} mapped feature${summaries.length === 1 ? "" : "s"}`);
      setText("#result-provenance", safeEndpoint(result.view.connection.endpoint));
      setText(
        "#status-geometry-types",
        [...new Set(summaries.map(({ geometryKind }) => geometryKind))].join(", ") || "none",
      );

      const selectFeature = (summary: FirstMapFeatureSummary, lngLat = summary.center): void => {
        const interactionStartedAt = performance.now();
        selected = summary;
        renderSelection(summary);
        renderFeatureList(filterFirstMapFeatures(summaries, activeChoice), selected.id, selectFeature);
        activePopup?.remove();
        if (lngLat) {
          activePopup = new maplibregl.Popup({
            closeButton: true,
            closeOnClick: false,
            maxWidth: "320px",
          })
            .setLngLat([lngLat[0], lngLat[1]])
            .setDOMContent(createPopupContent(summary))
            .addTo(map);
          activePopup.on("close", () => telemetry.patchRuntime({ popupOpen: false }));
        }
        const interaction = observeFirstMapTiming(
          performance.now() - interactionStartedAt,
          FIRST_MAP_TIMING_BUDGETS_MS.interaction,
        );
        telemetry.patchRuntime({
          selectedFeatureId: summary.id,
          popupOpen: Boolean(activePopup),
          interactionDurationMs: interaction.elapsedMs,
          interactionBudgetMet: interaction.withinBudget,
        });
        telemetry.emit("feature-selected", { featureId: summary.id, durationMs: interaction.elapsedMs });
      };

      const applyFilter = (choice: FirstMapFilterChoice | undefined): void => {
        const interactionStartedAt = performance.now();
        activeChoice = choice;
        const visible = filterFirstMapFeatures(summaries, choice);
        if (selected && !visible.some(({ id }) => id === selected?.id)) {
          selected = undefined;
          activePopup?.remove();
          activePopup = undefined;
          renderSelection(undefined);
          telemetry.patchRuntime({ selectedFeatureId: null, popupOpen: false });
        }
        for (const layerId of layerIds) {
          map.setFilter(
            layerId,
            combineFirstMapLayerFilter(baseFilters.get(layerId), choice) as maplibregl.FilterSpecification,
          );
        }
        setText("#linked-visible-count", String(visible.length));
        setText("#map-visible-count", `${visible.length} visible`);
        setText("#linked-filter-state", choice?.fieldLabel ?? "None");
        setText("#map-filter-count", choice ? "1 filter" : "0 filters");
        getElement<HTMLElement>("#linked-query-projection").textContent = JSON.stringify(
          {
            scope: "mounted bounded result",
            acceptedPlanFingerprint: result.plan.fingerprint,
            filter: choice ? { field: choice.field, operator: "=", value: choice.value } : null,
            visibleFeatureIds: visible.map(({ id }) => id),
          },
          null,
          2,
        );
        renderFeatureList(visible, selected?.id, selectFeature);
        const interaction = observeFirstMapTiming(
          performance.now() - interactionStartedAt,
          FIRST_MAP_TIMING_BUDGETS_MS.interaction,
        );
        telemetry.patchRuntime({
          linkedVisibleFeatureCount: visible.length,
          linkedFilterCount: choice ? 1 : 0,
          interactionDurationMs: interaction.elapsedMs,
          interactionBudgetMet: interaction.withinBudget,
        });
        telemetry.emit("linked-filter-changed", {
          active: Boolean(choice),
          durationMs: interaction.elapsedMs,
          withinBudget: interaction.withinBudget,
        });
      };

      const onFilterChange = () => applyFilter(choicesById.get(filterSelect.value));
      const onClearFilter = () => {
        filterSelect.value = "";
        applyFilter(undefined);
        filterSelect.focus();
      };
      filterSelect.addEventListener("change", onFilterChange);
      clearFilterButton.addEventListener("click", onClearFilter);
      cleanupCallbacks.push(
        () => filterSelect.removeEventListener("change", onFilterChange),
        () => clearFilterButton.removeEventListener("click", onClearFilter),
      );

      const onMapClick = (event: maplibregl.MapMouseEvent) => {
        const [feature] = map.queryRenderedFeatures(event.point, { layers: layerIds });
        const summary = findFirstMapFeature(
          summaries,
          feature?.id,
          feature?.properties as Readonly<Record<string, unknown>> | undefined,
        );
        if (summary) selectFeature(summary, [event.lngLat.lng, event.lngLat.lat]);
      };
      map.on("click", onMapClick);
      cleanupCallbacks.push(() => map.off("click", onMapClick));
      for (const layerId of layerIds) {
        const enter = () => {
          map.getCanvas().style.cursor = "pointer";
        };
        const leave = () => {
          map.getCanvas().style.cursor = "";
        };
        map.on("mouseenter", layerId, enter);
        map.on("mouseleave", layerId, leave);
        cleanupCallbacks.push(
          () => map.off("mouseenter", layerId, enter),
          () => map.off("mouseleave", layerId, leave),
        );
      }

      applyFilter(undefined);
      const firstFeature = launch.selectedRecordId
        ? summaries.find(({ id }) => id === launch.selectedRecordId)
        : summaries[0];
      if (launch.selectedRecordId && !firstFeature) {
        throw new Error(`Selected fixture record ${launch.selectedRecordId} was not returned by the bounded query.`);
      }
      if (firstFeature) selectFeature(firstFeature);
      overlay.dataset.state = "ready";
      overlayTitle.textContent = "First Map ready";
      overlayBody.textContent = "Map, popup, filter, table, code, and accepted-plan evidence are available.";
      setText(
        "#demo-status",
        launch.mode === "fixture"
          ? `First usable map in ${workflowTiming.elapsedMs} ms; ${workflowTiming.withinBudget ? "within" : "over"} the ${workflowTiming.budgetMs} ms fixture runtime budget.`
          : `First usable map in ${workflowTiming.elapsedMs} ms on the configured public network; the fixture runtime budget is not applied.`,
      );
      telemetry.patchRuntime({
        serviceId: result.view.source.id,
        sourceProtocol: result.view.source.protocol,
        sourceId: result.view.source.id,
        sourceAttribution: result.view.source.attribution ?? null,
        sourceObservedAt: result.view.connection.observedAt ?? null,
        sourceFreshness: result.view.connection.observedAt ? "observed" : "unavailable",
        cacheStatus: result.view.connection.cacheStatus,
        degradation: firstMapDegradation(result),
        authorizationMode: "anonymous",
        featureCount: summaries.length,
        renderableFeatureCount: summaries.filter(({ geometryKind }) => geometryKind !== "attribute-only").length,
        geometryTypes: [...new Set(summaries.map(({ geometryKind }) => geometryKind))],
        sdkVersion: __HONUA_SDK_VERSION__,
        planId: result.plan.id,
        planFingerprint: result.plan.fingerprint,
        planPushdown: result.plan.pushdown,
        layerIds,
        mapReady: true,
        journeyComplete: true,
        firstMapDurationMs: workflowTiming.elapsedMs,
        firstMapBudgetMs: launch.mode === "fixture" ? workflowTiming.budgetMs : undefined,
        firstMapBudgetMet: launch.mode === "fixture" ? workflowTiming.withinBudget : undefined,
      });
      telemetry.emit("map-ready", { layerIds, featureCount: summaries.length, durationMs: workflowTiming.elapsedMs });

      activeDispose = createIdempotentAsyncDispose(async () => {
        const cleanupStartedAt = performance.now();
        const failures: unknown[] = [];
        for (const cleanup of cleanupCallbacks.reverse()) {
          try {
            cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          activePopup?.remove();
        } catch (error) {
          failures.push(error);
        }
        try {
          await result.dispose();
        } catch (error) {
          failures.push(error);
        }
        try {
          removeMap();
        } catch (error) {
          failures.push(error);
        }
        const cleanupTiming = observeFirstMapTiming(
          performance.now() - cleanupStartedAt,
          FIRST_MAP_TIMING_BUDGETS_MS.cleanup,
        );
        telemetry.patchRuntime({
          mapReady: false,
          popupOpen: false,
          disposed: true,
          cleanupDurationMs: cleanupTiming.elapsedMs,
          cleanupBudgetMet: cleanupTiming.withinBudget,
        });
        if (failures.length > 0) throw new AggregateError(failures, "First Map cleanup completed with failures.");
      });
      removeInFlightMap = undefined;
    } catch (error) {
      removeMap();
      const message = error instanceof Error ? error.message : String(error);
      overlay.dataset.state = "error";
      overlayTitle.textContent = "Unable to start First Map";
      overlayBody.textContent = message;
      setText("#status-error", message);
      setText("#demo-status", message);
      telemetry.patchRuntime({ lastError: message, mapReady: false });
      telemetry.emit("error", { message });
    } finally {
      if (inFlightAbort === controller) inFlightAbort = undefined;
      launchButton.disabled = false;
      form.removeAttribute("aria-busy");
    }
  }

  protocolSelect.addEventListener("change", () => {
    endpointInput.value = endpointForFirstMapProtocol(
      endpointInput.value.trim(),
      readProtocol(protocolSelect.value),
      location.href,
    );
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const endpoint = endpointInput.value.trim();
    const launch: FirstMapLaunch = {
      endpoint,
      mode: isFixtureEndpoint(endpoint) ? "fixture" : "public-live",
      protocol: readProtocol(protocolSelect.value),
      maxFeatures: startup.maxFeatures,
      basemapStyle,
      ...(startup.where ? { where: startup.where } : {}),
    };
    void run(launch);
  });

  await run(startup);
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const overlay = document.querySelector<HTMLElement>("#map-overlay");
  if (overlay) overlay.dataset.state = "error";
  const title = document.querySelector<HTMLElement>(".map-overlay-title");
  if (title) title.textContent = "Unable to configure First Map";
  const body = document.querySelector<HTMLElement>(".map-overlay-body");
  if (body) body.textContent = message;
  const status = document.querySelector<HTMLElement>("#demo-status");
  if (status) status.textContent = message;
  window.__HONUA_QUICKSTART_RUNTIME__ = {
    ...(window.__HONUA_QUICKSTART_RUNTIME__ ?? {}),
    mapReady: false,
    journeyComplete: false,
    lastError: message,
  };
});
