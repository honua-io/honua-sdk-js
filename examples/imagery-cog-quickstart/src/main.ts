import "maplibre-gl/dist/maplibre-gl.css";

import { connect } from "@honua/sdk-js";
import {
  type CogInspection,
  type CogMapLibreSnapshot,
  type CogTransferLedger,
  HonuaCogError,
  type MountedStacCogAssetToMapLibre,
  type StacCogAssetSession,
  type StacCogAssetToMapLibreMap,
  mountStacCogAssetToMapLibre,
  openStacCogAsset,
} from "@honua/sdk-js/cog";
import { HonuaClient, type StacAssetCandidate } from "@honua/sdk-js/honua";
import maplibregl from "maplibre-gl";

import { clientOptionsFromImageryConfig, rasterRequestHeaders, resolveImageryCogConfig } from "./config.js";
import {
  activeImageryLayerCount,
  createDefaultImageryDataset,
  createImageryRenderPlan,
  hydrateImageryRenderPlan,
  setImageryLayerOpacity,
  setImageryLayerVisibility,
  summarizeImageryCache,
  summarizeImageryCapabilities,
} from "./model.js";
import type { ImageryLayerState, ImageryRenderPlan } from "./types.js";

import "./styles.css";

interface DirectCogEvidence {
  readonly phase: "discovering" | "inspecting" | "reading" | "rendering" | "ready" | "failed" | "disposed";
  readonly generation: number;
  readonly selectedAssetKey?: string;
  readonly candidateCount: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly mapSourceMounted: boolean;
  readonly mapLayerMounted: boolean;
  readonly inspection?: CogInspection;
  readonly render?: CogMapLibreSnapshot;
  readonly transfer?: CogTransferLedger;
  readonly decoderModuleLoads: number;
  readonly decoderLoads: number;
  readonly decoderDisposals: number;
  readonly abortedOperations: number;
  readonly staleCompletions: number;
}

interface ImageryCogRuntime {
  readonly ready: boolean;
  readonly activeLayerCount: number;
  readonly layerIds: readonly string[];
  readonly tileTemplates: readonly string[];
  readonly directCog: DirectCogEvidence;
  toggleLayer(layerId: string, visible: boolean): void;
  setOpacity(layerId: string, opacity: number): void;
  selectCogAsset(assetKey: string): Promise<void>;
  disposeCog(): Promise<void>;
}

declare global {
  interface Window {
    __HONUA_IMAGERY_COG_DEMO__?: ImageryCogRuntime;
  }
}

const config = resolveImageryCogConfig(import.meta.env);
const client = new HonuaClient(clientOptionsFromImageryConfig(config));
const authHeaders = rasterRequestHeaders(config);
const dataset = createDefaultImageryDataset();
let renderPlan = createImageryRenderPlan(dataset, client);
let selectedLayerId = renderPlan.layers[0]?.layer.id ?? "";

const map = new maplibregl.Map({
  container: "map",
  center: [...dataset.center],
  zoom: dataset.zoom,
  attributionControl: false,
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#dce8ef" },
      },
    ],
  },
  transformRequest(url) {
    if (authHeaders && url.startsWith(client.serverBaseUrl)) {
      return { url, headers: authHeaders };
    }
    return { url };
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

interface ActiveCogResources {
  readonly generation: number;
  readonly controller: AbortController;
  session?: StacCogAssetSession;
  mount?: MountedStacCogAssetToMapLibre;
}

let directCandidates: StacAssetCandidate[] = [];
let directGeneration = 0;
let activeCog: ActiveCogResources | undefined;
let fixtureDecoderModule: Awaited<typeof import("./fixture-cog-decoder.js")> | undefined;
let directEvidence: DirectCogEvidence = {
  phase: "discovering",
  generation: 0,
  candidateCount: 0,
  mapSourceMounted: false,
  mapLayerMounted: false,
  decoderModuleLoads: 0,
  decoderLoads: 0,
  decoderDisposals: 0,
  abortedOperations: 0,
  staleCompletions: 0,
};

const fixtureDecoderTelemetry = {
  created() {
    directEvidence = { ...directEvidence, decoderLoads: directEvidence.decoderLoads + 1 };
    renderDirectCog();
  },
  disposed() {
    directEvidence = { ...directEvidence, decoderDisposals: directEvidence.decoderDisposals + 1 };
    renderDirectCog();
  },
  aborted() {
    directEvidence = { ...directEvidence, abortedOperations: directEvidence.abortedOperations + 1 };
    renderDirectCog();
  },
};

function setDirectEvidence(update: Partial<DirectCogEvidence>): void {
  directEvidence = { ...directEvidence, ...update };
  renderDirectCog();
}

function renderDirectCog(): void {
  const status = document.querySelector<HTMLElement>("#direct-cog-status");
  if (!status) return;
  const phaseLabel = directEvidence.phase.replaceAll("-", " ");
  status.textContent = directEvidence.errorCode
    ? `${phaseLabel}: ${directEvidence.errorCode}`
    : `${phaseLabel} · generation ${directEvidence.generation}`;
  status.dataset.phase = directEvidence.phase;
  setText(
    "#direct-cog-lifecycle",
    `${directEvidence.decoderLoads} decoder(s) created · ${directEvidence.decoderDisposals} released · ${directEvidence.abortedOperations} aborted · map ${directEvidence.mapSourceMounted && directEvidence.mapLayerMounted ? "mounted" : "released"}`,
  );

  const inspection = directEvidence.inspection;
  setText(
    "#direct-cog-inspection",
    inspection
      ? `${inspection.width}×${inspection.height} · ${inspection.crs.authority ?? "CRS"}:${inspection.crs.code ?? "unknown"} · ${inspection.bands.length} bands · overviews ${inspection.overviewDecimations.join(", ") || "none"}`
      : "No accepted inspection yet.",
  );
  setText(
    "#direct-cog-provenance",
    inspection
      ? `${inspection.provenance.stac.itemId ?? inspection.provenance.stac.objectId}/${inspection.provenance.stac.assetKey} · ${inspection.provenance.stac.confidence} confidence · ${inspection.provenance.stac.mediaType ?? "media type unavailable"}`
      : `${directEvidence.candidateCount} evidence-classified candidate(s).`,
  );
  setText(
    "#direct-cog-error",
    directEvidence.errorMessage
      ? `${directEvidence.errorCode ?? "error"}: ${directEvidence.errorMessage}`
      : "No range, CORS, CRS, or format refusal.",
  );

  const transfer = directEvidence.transfer;
  setText(
    "#direct-cog-transfer-summary",
    transfer
      ? `${transfer.bytesFetched} bytes across ${transfer.requests} exact range request(s)`
      : "No asset bytes fetched.",
  );
  getElement<HTMLElement>("#direct-cog-ranges").innerHTML = transfer?.ranges.length
    ? transfer.ranges
        .map(
          (range) =>
            `<li><code>${range.offset}-${range.offset + range.length - 1}</code><span>${range.purpose} · ${range.outcome} · ${range.bytesReceived} B${range.errorCode ? ` · ${escapeHtml(range.errorCode)}` : ""}</span></li>`,
        )
        .join("")
    : "<li><span>No range evidence yet.</span></li>";
}

async function loadFixtureDecoderFactory() {
  if (!fixtureDecoderModule) {
    fixtureDecoderModule = await import("./fixture-cog-decoder.js");
    setDirectEvidence({ decoderModuleLoads: directEvidence.decoderModuleLoads + 1 });
  }
  return fixtureDecoderModule.createFixtureCogDecoderFactory(fixtureDecoderTelemetry);
}

async function disposeCogResources(resources: ActiveCogResources | undefined): Promise<void> {
  if (!resources) return;
  resources.controller.abort();
  try {
    if (resources.mount) await resources.mount.dispose();
    else if (resources.session) await resources.session.dispose();
  } catch {
    // Cleanup diagnostics are retained by the mount; switching remains usable.
  }
}

function currentCogGeneration(resources: ActiveCogResources): boolean {
  return activeCog === resources && directGeneration === resources.generation;
}

function cogError(error: unknown): { code: string; message: string } {
  if (error instanceof HonuaCogError) return { code: error.code, message: error.message };
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name || "unknown-error";
    return { code, message: error.message };
  }
  return { code: "unknown-error", message: String(error) };
}

const directCogFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.headers.has("range") && new URL(request.url).pathname.endsWith("/cors-blocked")) {
    throw new TypeError("Fixture CORS policy blocked the direct asset range request.");
  }
  return fetch(request);
};

async function selectDirectCogAsset(assetKey: string): Promise<void> {
  const candidate = directCandidates.find((entry) => entry.assetKey === assetKey);
  if (!candidate) throw new Error(`Unknown direct COG asset: ${assetKey}`);

  const generation = ++directGeneration;
  const previous = activeCog;
  const resources: ActiveCogResources = { generation, controller: new AbortController() };
  activeCog = resources;
  await disposeCogResources(previous);
  if (!currentCogGeneration(resources)) return;

  setDirectEvidence({
    phase: "inspecting",
    generation,
    selectedAssetKey: assetKey,
    errorCode: undefined,
    errorMessage: undefined,
    inspection: undefined,
    render: undefined,
    transfer: undefined,
    mapSourceMounted: false,
    mapLayerMounted: false,
  });
  getElement<HTMLSelectElement>("#direct-cog-asset").value = assetKey;

  try {
    const decoderFactory = await loadFixtureDecoderFactory();
    if (!currentCogGeneration(resources)) return;
    const session = openStacCogAsset(candidate, {
      decoderFactory,
      fetchFn: directCogFetch,
      limits: {
        maxRangeBytes: 64 * 1024,
        maxMetadataBytes: 256 * 1024,
        maxWindowBytes: 512 * 1024,
        maxTotalBytes: 768 * 1024,
        maxWindowPixels: 1_048_576,
      },
    });
    resources.session = session;
    const inspection = await session.inspect({ signal: resources.controller.signal });
    if (!currentCogGeneration(resources)) return;
    setDirectEvidence({ phase: "reading", inspection, transfer: inspection.transfer });

    const boundedRead = await session.readWindow(
      {
        x: 8,
        y: 8,
        width: 16,
        height: 16,
        bands: [1, 2, 3],
        sampling: { width: 8, height: 8, overviewDecimation: 2, resampling: "bilinear" },
      },
      { signal: resources.controller.signal },
    );
    if (!currentCogGeneration(resources)) return;
    setDirectEvidence({ phase: "rendering", transfer: boundedRead.transfer });

    const mount = mountStacCogAssetToMapLibre(map as unknown as StacCogAssetToMapLibreMap, session, {
      sourceId: "honua-direct-cog",
      layerId: "honua-direct-cog-layer",
      bands: { mode: "rgb", red: 1, green: 2, blue: 3 },
      resampling: "bilinear",
      disposeSession: true,
    });
    resources.mount = mount;
    const renderSnapshot = await mount.ready;
    if (!currentCogGeneration(resources)) return;
    setDirectEvidence({
      phase: renderSnapshot.state === "ready" ? "ready" : "failed",
      render: renderSnapshot,
      transfer: session.transfer(),
      mapSourceMounted: Boolean(map.getSource("honua-direct-cog")),
      mapLayerMounted: Boolean(map.getLayer("honua-direct-cog-layer")),
      ...(renderSnapshot.state === "ready"
        ? {}
        : {
            errorCode: renderSnapshot.diagnostics.at(-1)?.code ?? renderSnapshot.state,
            errorMessage: renderSnapshot.diagnostics.at(-1)?.message ?? "The direct COG renderer did not become ready.",
          }),
    });
  } catch (error) {
    const stale = !currentCogGeneration(resources);
    await disposeCogResources(resources);
    if (stale) {
      directEvidence = { ...directEvidence, staleCompletions: directEvidence.staleCompletions + 1 };
      return;
    }
    activeCog = undefined;
    const failure = cogError(error);
    setDirectEvidence({
      phase: "failed",
      errorCode: failure.code,
      errorMessage: failure.message,
      transfer: resources.session?.transfer(),
      mapSourceMounted: false,
      mapLayerMounted: false,
    });
  }
}

async function initializeDirectCog(): Promise<void> {
  setDirectEvidence({ phase: "discovering" });
  const endpoint = new URL("/fixtures/cog/item.json", window.location.href).href;
  const connection = await connect({
    endpoint,
    protocol: "stac",
    authorizationScopeFingerprint: "anonymous",
    clientOptions: { fetchFn: fetch },
  });
  directCandidates = (connection.inspection.stacStatic?.assetCandidates ?? []).filter(
    (candidate) => candidate.state === "classified" && candidate.kind === "cog" && Boolean(candidate.href),
  );
  if (directCandidates.length === 0) throw new Error("The fixture STAC item exposed no classified COG candidates.");
  setDirectEvidence({ candidateCount: directCandidates.length });

  const labels: Readonly<Record<string, string>> = {
    "visual-a": "Natural color A — successful COG",
    "visual-b": "Natural color B — successful COG",
    "visual-slow": "Slow asset — cancellation proof",
    "range-unsupported": "Failure: server ignores Range",
    "cors-blocked": "Failure: CORS blocks Range",
    "unsupported-crs": "Failure: unsupported CRS",
    "unsupported-format": "Failure: GeoTIFF is not COG",
  };
  const select = getElement<HTMLSelectElement>("#direct-cog-asset");
  select.innerHTML = directCandidates
    .map(
      (candidate) =>
        `<option value="${escapeHtml(candidate.assetKey)}">${escapeHtml(labels[candidate.assetKey] ?? candidate.assetKey)}</option>`,
    )
    .join("");
  select.addEventListener("change", () => void selectDirectCogAsset(select.value));
  await selectDirectCogAsset("visual-a");
}

async function disposeDirectCog(): Promise<void> {
  const resources = activeCog;
  activeCog = undefined;
  directGeneration += 1;
  await disposeCogResources(resources);
  setDirectEvidence({
    phase: "disposed",
    generation: directGeneration,
    render: undefined,
    mapSourceMounted: false,
    mapLayerMounted: false,
  });
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
  renderLayers();
  renderSelectedLayer();
  renderAudit();
}

function renderStatus(): void {
  setText("#mode-state", config.mode === "live" ? "Live Honua" : "Fixture safe mode");
  setText("#capability-state", summarizeImageryCapabilities(renderPlan));
  setText("#cache-state", summarizeImageryCache(renderPlan.dataset));
  setText("#active-layer-count", `${activeImageryLayerCount(renderPlan)} active`);
  setText("#endpoint-state", `${client.serverBaseUrl} / ${renderPlan.layers.length} render path(s)`);
}

function renderLayers(): void {
  const list = getElement<HTMLElement>("#layer-list");
  list.innerHTML = renderPlan.layers
    .map(
      (state) => `
        <article class="layer-row" data-visible="${state.visible}" data-selected="${state.layer.id === selectedLayerId}">
          <button type="button" class="layer-select" data-select-layer="${escapeHtml(state.layer.id)}">
            <strong>${escapeHtml(state.layer.title)}</strong>
            <span>${escapeHtml(state.layer.accessPath)} / ${escapeHtml(state.layer.bandPreset)}</span>
          </button>
          <label class="toggle-row">
            <input type="checkbox" data-toggle-layer="${escapeHtml(state.layer.id)}" ${state.visible ? "checked" : ""} />
            <span>Visible</span>
          </label>
          <label class="opacity-row">
            <span>Opacity</span>
            <input
              type="range"
              min="0"
              max="100"
              value="${Math.round(state.opacity * 100)}"
              data-opacity-layer="${escapeHtml(state.layer.id)}"
              aria-label="${escapeHtml(state.layer.title)} opacity"
            />
          </label>
        </article>
      `,
    )
    .join("");

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-select-layer]")) {
    button.addEventListener("click", () => {
      selectedLayerId = button.dataset.selectLayer ?? selectedLayerId;
      render();
    });
  }

  for (const checkbox of document.querySelectorAll<HTMLInputElement>("[data-toggle-layer]")) {
    checkbox.addEventListener("change", () => {
      const layerId = checkbox.dataset.toggleLayer ?? "";
      updateLayerVisibility(layerId, checkbox.checked);
    });
  }

  for (const slider of document.querySelectorAll<HTMLInputElement>("[data-opacity-layer]")) {
    slider.addEventListener("input", () => {
      const layerId = slider.dataset.opacityLayer ?? "";
      updateLayerOpacity(layerId, Number(slider.value) / 100);
    });
  }
}

function renderSelectedLayer(): void {
  const state = requireSelectedLayer();
  setText("#selected-kind", state.layer.auditCapability);
  getElement<HTMLElement>("#selected-metadata").innerHTML = `
    <div><dt>Service</dt><dd>${escapeHtml(state.layer.serviceId)}</dd></div>
    <div><dt>Endpoint</dt><dd>${escapeHtml(state.layer.endpointPath)}</dd></div>
    <div><dt>Asset</dt><dd>${escapeHtml(state.layer.sourceAsset)}</dd></div>
    <div><dt>Metadata</dt><dd>${escapeHtml(metadataLabel(state))}</dd></div>
  `;
  getElement<HTMLElement>("#legend-strip").innerHTML = state.layer.legend
    .map(
      (entry) => `
        <span>
          <i style="background:${escapeHtml(entry.color)}"></i>
          ${escapeHtml(entry.label)}
        </span>
      `,
    )
    .join("");
  setText(
    "#export-state",
    state.exportPreview?.href
      ? `Export preview ${state.exportPreview.width ?? 0}x${state.exportPreview.height ?? 0}: ${state.exportPreview.href}`
      : state.error
        ? `Capability load warning: ${state.error}`
        : "Export preview not requested for this render path.",
  );
}

function renderAudit(): void {
  getElement<HTMLElement>("#audit-table").innerHTML = renderPlan.auditRows
    .map(
      (row) => `
        <article>
          <strong>${escapeHtml(row.capability)}</strong>
          <span>${escapeHtml(row.sampleLayer)}</span>
          <code>${escapeHtml(row.sdkSurface)}</code>
          <small>${escapeHtml(row.cachePolicy)}</small>
        </article>
      `,
    )
    .join("");
}

function addMapLayers(plan: ImageryRenderPlan): void {
  for (const state of plan.layers) {
    if (!map.getSource(state.mapSourceId)) {
      map.addSource(state.mapSourceId, {
        type: "raster",
        tiles: [...state.sourceSpec.tiles],
        tileSize: state.sourceSpec.tileSize,
        ...(state.sourceSpec.scheme ? { scheme: state.sourceSpec.scheme } : {}),
        ...(state.sourceSpec.minzoom !== undefined ? { minzoom: state.sourceSpec.minzoom } : {}),
        ...(state.sourceSpec.maxzoom !== undefined ? { maxzoom: state.sourceSpec.maxzoom } : {}),
        ...(state.sourceSpec.attribution ? { attribution: state.sourceSpec.attribution } : {}),
      });
    }
    if (!map.getLayer(state.mapLayerId)) {
      map.addLayer({
        id: state.mapLayerId,
        type: "raster",
        source: state.mapSourceId,
        layout: { visibility: state.visible ? "visible" : "none" },
        paint: { "raster-opacity": state.opacity },
      });
    }
  }
}

function updateLayerVisibility(layerId: string, visible: boolean): void {
  renderPlan = setImageryLayerVisibility(renderPlan, layerId, visible);
  const state = renderPlan.layers.find((candidate) => candidate.layer.id === layerId);
  if (state && map.getLayer(state.mapLayerId)) {
    map.setLayoutProperty(state.mapLayerId, "visibility", visible ? "visible" : "none");
  }
  render();
}

function updateLayerOpacity(layerId: string, opacity: number): void {
  renderPlan = setImageryLayerOpacity(renderPlan, layerId, opacity);
  const state = renderPlan.layers.find((candidate) => candidate.layer.id === layerId);
  if (state && map.getLayer(state.mapLayerId)) {
    map.setPaintProperty(state.mapLayerId, "raster-opacity", state.opacity);
  }
  render();
}

function requireSelectedLayer(): ImageryLayerState {
  return renderPlan.layers.find((state) => state.layer.id === selectedLayerId) ?? renderPlan.layers[0]!;
}

function metadataLabel(state: ImageryLayerState): string {
  if (state.error) return "warning";
  const service = state.metadata?.serviceDescription;
  const layerCount = state.metadata?.layers?.length ?? 0;
  return service ? `${service} / ${layerCount} layer(s)` : "fixture metadata";
}

function fitDatasetExtent(): void {
  map.fitBounds(
    [
      [dataset.extent.xmin, dataset.extent.ymin],
      [dataset.extent.xmax, dataset.extent.ymax],
    ],
    { padding: 56, duration: 350 },
  );
}

getElement<HTMLButtonElement>("#zoom-extent").addEventListener("click", fitDatasetExtent);

map.once("load", async () => {
  addMapLayers(renderPlan);
  fitDatasetExtent();
  render();
  const hydration = hydrateImageryRenderPlan(renderPlan, client);
  try {
    await initializeDirectCog();
  } catch (error) {
    const failure = cogError(error);
    setDirectEvidence({ phase: "failed", errorCode: failure.code, errorMessage: failure.message });
  }
  renderPlan = await hydration;
  render();
  window.__HONUA_IMAGERY_COG_DEMO__ = {
    ready: true,
    get activeLayerCount() {
      return activeImageryLayerCount(renderPlan);
    },
    get layerIds() {
      return renderPlan.layers.map((state) => state.mapLayerId);
    },
    get tileTemplates() {
      return renderPlan.layers.flatMap((state) => state.sourceSpec.tiles);
    },
    get directCog() {
      return directEvidence;
    },
    toggleLayer(layerId: string, visible: boolean) {
      updateLayerVisibility(layerId, visible);
    },
    setOpacity(layerId: string, opacity: number) {
      updateLayerOpacity(layerId, opacity);
    },
    selectCogAsset(assetKey: string) {
      return selectDirectCogAsset(assetKey);
    },
    disposeCog() {
      return disposeDirectCog();
    },
  };
});

window.addEventListener("pagehide", () => void disposeDirectCog(), { once: true });
