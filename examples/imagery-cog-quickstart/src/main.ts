import "maplibre-gl/dist/maplibre-gl.css";

import { type ElevationCoordinate, HonuaClient, HonuaImageService } from "@honua/sdk-js/honua";
import maplibregl, { type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";

import { SampleCleanupRegistry } from "../../_kit/cleanup.js";
import { mountSamplePresentation } from "../../_kit/presentation.js";
import { clientOptionsFromImageryConfig, resolveImageryCogConfig } from "./config.js";
import {
  type ElevationLookupOutcome,
  type ElevationProfileOutcome,
  ImageryTerrainJourney,
  type ImageryTerrainSearchReceipt,
  type RasterAssetInspectionOutcome,
  type RasterAssetInspectionReady,
} from "./journey.js";
import {
  activeImageryLayerCount,
  buildImageServerTileUrlTemplate,
  createDefaultImageryDataset,
  createImageryRenderPlan,
  hydrateImageryRenderPlan,
  setImageryLayerOpacity,
  setImageryLayerVisibility,
  summarizeImageryCache,
} from "./model.js";
import type { ImageryRenderPlan } from "./types.js";

import "./styles.css";

declare const __HONUA_SDK_VERSION__: string;

const SEARCH_BBOX = [-158.18, 21.22, -157.7, 21.58] as const;
const FIXTURE_ROUTE: readonly ElevationCoordinate[] = [
  [-157.9, 21.35],
  [-157.86, 21.39],
  [-157.8, 21.45],
];
const TERRAIN_SOURCE_ID = "oahu-terrain-dem";
const TERRAIN_HILLSHADE_LAYER_ID = "oahu-terrain-hillshade";
const POINT_SOURCE_ID = "journey-elevation-point";
const POINT_LAYER_ID = "journey-elevation-point-layer";
const ROUTE_SOURCE_ID = "journey-elevation-route";
const ROUTE_LAYER_ID = "journey-elevation-route-layer";
const DEFAULT_ASSET_KEY = "cog";

interface ImageryTerrainBrowserRuntime {
  readonly ready: boolean;
  readonly disposed: boolean;
  readonly activeLayerCount: number;
  readonly layerIds: readonly string[];
  readonly tileTemplates: readonly string[];
  readonly selectedAssetKey: string | undefined;
  readonly inspectionStatus: RasterAssetInspectionOutcome["status"] | "idle" | "loading";
  readonly cancellationCount: number;
  readonly releasedRasterResources: number;
  readonly lastElevationMeters: number | undefined;
  readonly profileSampleCount: number;
  readonly terrainEnabled: boolean;
  readonly interactionCount: number;
  readonly resources: ReturnType<ImageryTerrainJourney["resources"]>;
  search(): Promise<void>;
  selectAsset(assetKey: string): Promise<RasterAssetInspectionOutcome | undefined>;
  lookupAt(longitude: number, latitude: number): Promise<ElevationLookupOutcome | undefined>;
  runFixtureProfile(): Promise<ElevationProfileOutcome | undefined>;
  setTerrainEnabled(enabled: boolean): void;
  setComparison(value: number): void;
  toggleLayer(layerId: string, visible: boolean): void;
  setOpacity(layerId: string, opacity: number): void;
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    __HONUA_IMAGERY_TERRAIN_RUNTIME__?: ImageryTerrainBrowserRuntime;
    __HONUA_IMAGERY_TERRAIN_DISPOSE__?: () => Promise<void>;
    /** Backward-compatible smoke hook retained while S3 converges old routes. */
    __HONUA_IMAGERY_COG_DEMO__?: ImageryTerrainBrowserRuntime;
  }
}

const config = resolveImageryCogConfig({
  VITE_HONUA_IMAGERY_BASE_URL: import.meta.env.VITE_HONUA_IMAGERY_BASE_URL,
});
const client = new HonuaClient(clientOptionsFromImageryConfig(config));
const dataset = createDefaultImageryDataset();
const journey = new ImageryTerrainJourney({ client });
const cleanup = new SampleCleanupRegistry();
const bootstrapController = new AbortController();
let renderPlan = createImageryRenderPlan(dataset, client);
let searchReceipt: ImageryTerrainSearchReceipt | undefined;
let selectedItemId: string | undefined;
let selectedAssetKey: string | undefined;
let inspectionOutcome: RasterAssetInspectionOutcome | undefined;
let elevationOutcome: ElevationLookupOutcome | undefined;
let profileOutcome: ElevationProfileOutcome | undefined;
let searchController: AbortController | undefined;
let pointController: AbortController | undefined;
let profileController: AbortController | undefined;
let inspectionLoading = false;
let pointLoading = false;
let profileLoading = false;
let elevationError: string | undefined;
let profileError: string | undefined;
let terrainEnabled = false;
let ready = false;
let disposed = false;
let comparisonValue = 68;
let selectionGeneration = 0;
let pointGeneration = 0;
let profileGeneration = 0;
let cancellationCount = 0;
let releasedRasterResources = 0;
let interactionCount = 0;
let disposePromise: Promise<void> | undefined;

const presentation = mountSamplePresentation({
  sampleId: "imagery-cog-quickstart",
  evidence: {
    SDK: `@honua/sdk-js ${__HONUA_SDK_VERSION__}`,
    Search: "HonuaClient.stac().search",
    Range: "HonuaClient.pipelineFetch · bytes=0-63",
    Elevation: "HonuaClient.pipelineRequestJson + sampleElevationProfile",
    Rendering: "MapLibre WMS / ImageServer / Terrain-RGB",
    Limitation: "Direct COG decoding remains #537",
  },
  onDispose: () => dispose(),
});
presentation.showDegradation([
  "Direct STAC-to-COG pixels are not rendered while #537 remains open; the bounded receipt is compared with published WMS/ImageServer pixels.",
  "Cesium remains a lab and is not loaded by this journey.",
]);
cleanup.add(() => presentation.root.remove());

const map = new maplibregl.Map({
  container: "map",
  center: [...dataset.center],
  zoom: dataset.zoom,
  pitch: 0,
  bearing: 0,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#d8e5e3" } }],
  },
});
const mapLoaded = new Promise<void>((resolve) => map.once("load", () => resolve()));
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
cleanup.resource(map);
cleanup.add(() => journey.dispose());
cleanup.add(() => bootstrapController.abort("Imagery and Terrain demo disposed."));
cleanup.add(() => searchController?.abort("Imagery and Terrain demo disposed."));
cleanup.add(() => pointController?.abort("Imagery and Terrain demo disposed."));
cleanup.add(() => profileController?.abort("Imagery and Terrain demo disposed."));

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

function announce(message: string): void {
  setText("#journey-announcer", message);
}

function activeScene() {
  return searchReceipt?.scenes.find((scene) => scene.id === selectedItemId);
}

function render(): void {
  renderStatus();
  renderScenes();
  renderAssetPicker();
  renderInspection();
  renderElevation();
  renderProfile();
  renderFidelity();
}

function renderStatus(): void {
  setText("#mode-state", config.mode === "live" ? "Configured Honua" : "Fixture safe");
  setText(
    "#capability-state",
    ready ? "Search → inspect → render → elevation" : searchReceipt ? "Scene selected" : "Starting",
  );
  setText(
    "#cache-state",
    inspectionOutcome?.status === "ready"
      ? `${inspectionOutcome.cache.status} · ${inspectionOutcome.cache.etag ?? "checksum identity"}`
      : summarizeImageryCache(renderPlan.dataset),
  );
  const terrainCount = terrainEnabled ? 1 : 0;
  setText("#active-layer-count", `${activeImageryLayerCount(renderPlan) + terrainCount} active`);
  setText(
    "#endpoint-state",
    terrainEnabled
      ? "Same-origin fixture · WMS / ImageServer / STAC / Terrain-RGB"
      : "Same-origin fixture · WMS / ImageServer / STAC",
  );
}

function renderScenes(): void {
  const container = getElement<HTMLElement>("#scene-results");
  const scenes = searchReceipt?.scenes ?? [];
  container.innerHTML = scenes
    .map(
      (scene) => `
        <button class="scene-button" type="button" data-scene-id="${escapeHtml(scene.id)}" aria-pressed="${
          scene.id === selectedItemId
        }">
          <strong>${escapeHtml(scene.title)}</strong>
          <span>${escapeHtml(scene.acquiredAt ?? "Acquisition unknown")} · ${escapeHtml(
            scene.cloudCover ?? "?",
          )}% cloud · ${scene.assets.length} assets</span>
        </button>
      `,
    )
    .join("");
}

function renderAssetPicker(): void {
  const picker = getElement<HTMLSelectElement>("#asset-picker");
  const scene = activeScene();
  if (!scene) {
    picker.disabled = true;
    picker.innerHTML = "<option>Search for a scene first</option>";
    return;
  }
  picker.disabled = false;
  picker.innerHTML = scene.assets
    .map(
      (asset) =>
        `<option value="${escapeHtml(asset.key)}" ${asset.key === selectedAssetKey ? "selected" : ""}>${escapeHtml(
          asset.title,
        )} · ${escapeHtml(asset.key)}</option>`,
    )
    .join("");
}

function renderInspection(): void {
  const container = getElement<HTMLElement>("#inspection-content");
  if (inspectionLoading) {
    container.dataset.status = "loading";
    container.innerHTML =
      '<h3>Inspecting bounded range</h3><p class="empty-copy">Requesting only the first 64 bytes through the SDK pipeline.</p>';
    return;
  }
  if (!inspectionOutcome) {
    delete container.dataset.status;
    container.innerHTML = '<p class="empty-copy">Select a STAC asset to inspect its bounded range receipt.</p>';
    return;
  }
  if (inspectionOutcome.status === "cancelled") {
    container.dataset.status = "loading";
    container.innerHTML = `<h3>Obsolete selection cancelled</h3><p class="empty-copy">${escapeHtml(
      inspectionOutcome.reason,
    )} work released without changing the current map.</p>`;
    return;
  }
  if (inspectionOutcome.status === "unsupported") {
    container.dataset.status = "unsupported";
    container.innerHTML = `
      <h3><span class="unsupported-code">${escapeHtml(inspectionOutcome.code)}</span> Visible degradation</h3>
      <p class="unsupported-message">${escapeHtml(inspectionOutcome.message)}</p>
      <dl class="inspection-grid">
        <div><dt>Identity</dt><dd>${escapeHtml(inspectionOutcome.identity.collectionId)} / ${escapeHtml(
          inspectionOutcome.identity.itemId,
        )} / ${escapeHtml(inspectionOutcome.identity.assetKey)}</dd></div>
        <div><dt>Acquired / version</dt><dd>${escapeHtml(
          inspectionOutcome.identity.acquiredAt ?? "unknown",
        )} · ${escapeHtml(inspectionOutcome.identity.version ?? "unknown")}</dd></div>
        <div class="inspection-wide"><dt>Asset</dt><dd>${escapeHtml(inspectionOutcome.identity.assetHref)}</dd></div>
      </dl>
      <p class="limitation-note">STAC identity remains visible; the map falls back to the supported WMS preview.</p>
    `;
    return;
  }

  const resolution = inspectionOutcome.bands.find((band) => band.resolutionMeters !== undefined)?.resolutionMeters;
  container.dataset.status = "ready";
  container.innerHTML = `
    <h3>Range receipt ready</h3>
    <dl class="inspection-grid">
      <div><dt>Identity</dt><dd>${escapeHtml(inspectionOutcome.identity.collectionId)} / ${escapeHtml(
        inspectionOutcome.identity.itemId,
      )} / ${escapeHtml(inspectionOutcome.identity.assetKey)}</dd></div>
      <div><dt>Range</dt><dd>${escapeHtml(inspectionOutcome.range.contentRange)} · ${inspectionOutcome.range.bytesReceived} bytes</dd></div>
      <div><dt>CRS / resolution</dt><dd>${escapeHtml(inspectionOutcome.crs)} · ${escapeHtml(
        resolution ?? "unknown",
      )} m</dd></div>
      <div><dt>Bands / nodata</dt><dd>${inspectionOutcome.bands.length} bands · ${escapeHtml(
        inspectionOutcome.bands.map((band) => band.nodata).join(", "),
      )}</dd></div>
      <div><dt>ETag / cache</dt><dd>${escapeHtml(inspectionOutcome.cache.etag ?? "none")} · ${escapeHtml(
        inspectionOutcome.cache.cacheControl ?? inspectionOutcome.cache.status,
      )}</dd></div>
      <div><dt>Checksum</dt><dd>${escapeHtml(inspectionOutcome.provenance.checksum ?? "not declared")}</dd></div>
      <div><dt>Acquired / version</dt><dd>${escapeHtml(
        inspectionOutcome.identity.acquiredAt ?? "unknown",
      )} · ${escapeHtml(inspectionOutcome.identity.version ?? "unknown")}</dd></div>
      <div><dt>License</dt><dd>${escapeHtml(inspectionOutcome.provenance.license)}</dd></div>
    </dl>
    <p class="limitation-note">${escapeHtml(inspectionOutcome.limitation)} Pixels use the published comparison path below.</p>
  `;
  setText(
    "#attribution-state",
    `${inspectionOutcome.provenance.attribution} · ${inspectionOutcome.provenance.license} · ${inspectionOutcome.provenance.provider}`,
  );
}

function renderElevation(): void {
  const container = getElement<HTMLElement>("#elevation-result");
  if (pointLoading) {
    container.innerHTML = '<p class="empty-copy">Querying the same-origin elevation endpoint.</p>';
    return;
  }
  if (elevationError) {
    container.innerHTML = `<h3><span class="unsupported-code">error</span> Elevation failed</h3><p>${escapeHtml(
      elevationError,
    )}</p>`;
    return;
  }
  if (!elevationOutcome) {
    container.innerHTML = '<p class="empty-copy">Choose a point or click the map.</p>';
    return;
  }
  if (elevationOutcome.status === "cancelled") {
    container.innerHTML = '<p class="empty-copy">Elevation lookup cancelled.</p>';
    return;
  }
  if (elevationOutcome.status === "unsupported") {
    container.innerHTML = `<h3><span class="unsupported-code">nodata</span> No elevation</h3><p>${escapeHtml(
      elevationOutcome.message,
    )}</p>`;
    return;
  }
  container.innerHTML = `
    <h3>${elevationOutcome.elevationMeters.toFixed(1)} m</h3>
    <dl class="result-grid">
      <div><dt>Coordinate</dt><dd>${elevationOutcome.coordinate[0].toFixed(4)}, ${elevationOutcome.coordinate[1].toFixed(
        4,
      )}</dd></div>
      <div><dt>Vertical datum</dt><dd>${escapeHtml(elevationOutcome.provenance.verticalDatum)}</dd></div>
      <div><dt>Resolution</dt><dd>${escapeHtml(elevationOutcome.provenance.resolutionMeters ?? "unknown")} m</dd></div>
      <div><dt>Source</dt><dd>${escapeHtml(elevationOutcome.provenance.source)} · ${escapeHtml(
        elevationOutcome.provenance.version ?? "unversioned",
      )}</dd></div>
    </dl>
  `;
}

function renderProfile(): void {
  const container = getElement<HTMLElement>("#profile-result");
  if (profileLoading) {
    container.innerHTML = '<p class="empty-copy">Sampling four deterministic route positions.</p>';
    return;
  }
  if (profileError) {
    container.innerHTML = `<h3><span class="unsupported-code">error</span> Profile failed</h3><p>${escapeHtml(
      profileError,
    )}</p>`;
    return;
  }
  if (!profileOutcome) {
    container.innerHTML = '<p class="empty-copy">No route sampled yet.</p>';
    return;
  }
  if (profileOutcome.status === "cancelled") {
    container.innerHTML = '<p class="empty-copy">Route profile cancelled.</p>';
    return;
  }
  if (profileOutcome.status === "unsupported") {
    container.innerHTML = `<h3><span class="unsupported-code">nodata</span> Profile stopped</h3><p>${escapeHtml(
      profileOutcome.message,
    )}</p>`;
    return;
  }
  const profile = profileOutcome.profile;
  const points = profile.samples.map((sample) => sample.elevationMeters);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(1, max - min);
  const chartWidth = 320;
  const chartHeight = 116;
  const pad = 16;
  const coordinates = profile.samples.map((sample, index) => {
    const x = pad + (index / Math.max(1, profile.samples.length - 1)) * (chartWidth - pad * 2);
    const y = chartHeight - pad - ((sample.elevationMeters - min) / span) * (chartHeight - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = [`${pad},${chartHeight - pad}`, ...coordinates, `${chartWidth - pad},${chartHeight - pad}`].join(" ");
  container.innerHTML = `
    <h3>${profile.samples.length} samples · ${(profile.totalDistanceMeters / 1000).toFixed(1)} km</h3>
    <p>${min.toFixed(0)}–${max.toFixed(0)} m · gain ${profile.gainMeters.toFixed(0)} m · loss ${profile.lossMeters.toFixed(
      0,
    )} m</p>
    <svg class="profile-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Route elevation profile from ${min.toFixed(
      0,
    )} to ${max.toFixed(0)} metres">
      <path class="profile-grid-line" d="M ${pad} ${chartHeight - pad} H ${chartWidth - pad} M ${pad} ${pad} V ${
        chartHeight - pad
      }"></path>
      <polygon class="profile-area" points="${area}"></polygon>
      <text x="${pad}" y="${chartHeight - 3}">${min.toFixed(0)} m</text>
      <text x="${chartWidth - pad}" y="${chartHeight - 3}" text-anchor="end">${max.toFixed(0)} m</text>
    </svg>
  `;
}

function renderFidelity(): void {
  const rows = [
    {
      level: "supported",
      text: "Published WMS and ImageServer pixels use MapLibre raster sources; this sample explicitly normalizes the SDK helper's legacy WMS bbox token while #620 corrects it package-wide.",
    },
    {
      level: "degraded",
      text: "COG is metadata plus a bounded TIFF range receipt; direct decoding/rendering remains #537.",
    },
    {
      level: "supported",
      text: `MapLibre Terrain-RGB and hillshade are available${terrainEnabled ? " and enabled at 1.25× exaggeration" : " but currently off"}.`,
    },
    {
      level: "degraded",
      text: "Visual raster filtering uses MapLibre defaults; scientific resampling and raster analysis are not claimed.",
    },
    { level: "lab", text: "Cesium production is intentionally excluded; the separate adapter remains a lab." },
  ] as const;
  getElement<HTMLElement>("#fidelity-list").innerHTML = rows
    .map(
      (row) =>
        `<li><span class="fidelity-badge" data-level="${row.level}">${row.level}</span><span>${escapeHtml(
          row.text,
        )}</span></li>`,
    )
    .join("");
}

function addImageryLayers(plan: ImageryRenderPlan): void {
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

function addTerrainAndAnalysisLayers(): void {
  const service = new HonuaImageService({ client, serviceId: "OahuTerrain" });
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    map.addSource(TERRAIN_SOURCE_ID, {
      type: "raster-dem",
      tiles: [buildImageServerTileUrlTemplate(service, "png")],
      tileSize: 256,
      encoding: "mapbox",
      minzoom: 6,
      maxzoom: 14,
      attribution: "Honua deterministic Terrain-RGB fixture",
    });
  }
  if (!map.getLayer(TERRAIN_HILLSHADE_LAYER_ID)) {
    map.addLayer({
      id: TERRAIN_HILLSHADE_LAYER_ID,
      type: "hillshade",
      source: TERRAIN_SOURCE_ID,
      layout: { visibility: "none" },
      paint: {
        "hillshade-shadow-color": "#344f49",
        "hillshade-highlight-color": "#f7f1d8",
        "hillshade-accent-color": "#af7440",
        "hillshade-exaggeration": 0.42,
      },
    });
  }
  map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: featureCollection() as never });
  map.addLayer({
    id: ROUTE_LAYER_ID,
    type: "line",
    source: ROUTE_SOURCE_ID,
    paint: { "line-color": "#d85c42", "line-width": 4, "line-opacity": 0.96 },
  });
  map.addSource(POINT_SOURCE_ID, { type: "geojson", data: featureCollection() as never });
  map.addLayer({
    id: POINT_LAYER_ID,
    type: "circle",
    source: POINT_SOURCE_ID,
    paint: {
      "circle-radius": 7,
      "circle-color": "#087f78",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.5,
    },
  });
}

function featureCollection(features: unknown[] = []) {
  return { type: "FeatureCollection", features } as const;
}

function setPreviewVisible(visible: boolean): void {
  const preview = renderPlan.layers.find((state) => state.layer.accessPath === "image-server-tile");
  if (!preview) return;
  renderPlan = setImageryLayerVisibility(renderPlan, preview.layer.id, visible);
  if (map.getLayer(preview.mapLayerId))
    map.setLayoutProperty(preview.mapLayerId, "visibility", visible ? "visible" : "none");
}

function setComparison(value: number): void {
  comparisonValue = Math.max(0, Math.min(100, Math.round(value)));
  const preview = renderPlan.layers.find((state) => state.layer.accessPath === "image-server-tile");
  if (preview) {
    renderPlan = setImageryLayerOpacity(renderPlan, preview.layer.id, comparisonValue / 100);
    if (map.getLayer(preview.mapLayerId))
      map.setPaintProperty(preview.mapLayerId, "raster-opacity", comparisonValue / 100);
  }
  const slider = getElement<HTMLInputElement>("#comparison-slider");
  slider.value = String(comparisonValue);
  setText("#comparison-value", `${comparisonValue}% ImageServer over WMS`);
  renderStatus();
}

function fitDatasetExtent(): void {
  map.fitBounds(
    [
      [dataset.extent.xmin, dataset.extent.ymin],
      [dataset.extent.xmax, dataset.extent.ymax],
    ],
    { padding: 54, duration: 0 },
  );
}

function setTerrainEnabled(enabled: boolean): void {
  if (disposed || terrainEnabled === enabled) return;
  terrainEnabled = enabled;
  map.setTerrain(enabled ? { source: TERRAIN_SOURCE_ID, exaggeration: 1.25 } : null);
  if (map.getLayer(TERRAIN_HILLSHADE_LAYER_ID)) {
    map.setLayoutProperty(TERRAIN_HILLSHADE_LAYER_ID, "visibility", enabled ? "visible" : "none");
  }
  map.easeTo({ pitch: enabled ? 48 : 0, bearing: enabled ? -17 : 0, duration: 0 });
  getElement<HTMLInputElement>("#terrain-toggle").checked = enabled;
  renderStatus();
  renderFidelity();
  announce(enabled ? "Terrain and 2.5D context enabled." : "Terrain and 2.5D context disabled.");
}

async function runSearch(): Promise<void> {
  if (disposed) return;
  interactionCount += 1;
  searchController?.abort("Search superseded.");
  const controller = new AbortController();
  searchController = controller;
  const startDate = getElement<HTMLInputElement>("#start-date-input").value;
  const endDate = getElement<HTMLInputElement>("#end-date-input").value;
  const collectionId = getElement<HTMLSelectElement>("#collection-input").value;
  const maxCloudCover = Number(getElement<HTMLInputElement>("#cloud-input").value);
  setText("#search-status", "Searching STAC by area, date, and cloud threshold.");
  try {
    const receipt = await journey.search({
      collectionId,
      bbox: SEARCH_BBOX,
      datetime: `${startDate}T00:00:00Z/${endDate}T23:59:59Z`,
      maxCloudCover,
      signal: controller.signal,
    });
    if (controller.signal.aborted || disposed) return;
    searchReceipt = receipt;
    selectedItemId = receipt.scenes.some((scene) => scene.id === selectedItemId)
      ? selectedItemId
      : receipt.scenes[0]?.id;
    const scene = activeScene();
    selectedAssetKey = scene?.assets.some((asset) => asset.key === DEFAULT_ASSET_KEY)
      ? DEFAULT_ASSET_KEY
      : scene?.assets[0]?.key;
    setText(
      "#search-status",
      receipt.scenes.length === 0
        ? "No scenes matched the current area, dates, and cloud threshold."
        : `${receipt.numberMatched} scene matched · ${receipt.scenes.length} loaded through ${receipt.sdkSurface}.`,
    );
    render();
    if (selectedItemId && selectedAssetKey) await inspectAsset(selectedAssetKey);
  } catch (error) {
    if (controller.signal.aborted) return;
    setText("#search-status", `STAC search failed: ${error instanceof Error ? error.message : "unknown error"}`);
    presentation.showError(error);
  }
}

async function inspectAsset(assetKey: string): Promise<RasterAssetInspectionOutcome | undefined> {
  if (disposed || !selectedItemId) return undefined;
  interactionCount += 1;
  selectedAssetKey = assetKey;
  const generation = ++selectionGeneration;
  inspectionLoading = true;
  setText("#asset-switch-state", `Inspecting ${assetKey}; obsolete selection work will be cancelled.`);
  renderAssetPicker();
  renderInspection();
  let outcome: RasterAssetInspectionOutcome;
  try {
    outcome = await journey.inspectAsset(selectedItemId, assetKey, bootstrapController.signal);
  } catch (error) {
    if (bootstrapController.signal.aborted) return undefined;
    presentation.showError(error);
    setText("#asset-switch-state", `Inspection failed: ${error instanceof Error ? error.message : "unknown error"}`);
    inspectionLoading = false;
    renderInspection();
    return undefined;
  }
  if (outcome.status === "cancelled") cancellationCount += 1;
  if (generation !== selectionGeneration || disposed) return outcome;
  inspectionLoading = false;
  inspectionOutcome = outcome;

  if (outcome.status === "ready") {
    setPreviewVisible(true);
    setComparison(comparisonValue);
    journey.retainRasterResource(outcome, () => {
      releasedRasterResources += 1;
      setPreviewVisible(false);
    });
    setText("#asset-switch-state", `${assetKey} ready · published preview retained until the next switch.`);
    presentation.updateEvidence({
      SDK: `@honua/sdk-js ${__HONUA_SDK_VERSION__}`,
      Search: searchReceipt?.sdkSurface ?? "not run",
      Range: `${outcome.range.contentRange} · ${outcome.range.tiffByteOrder}`,
      Cache: `${outcome.cache.status} · ${outcome.cache.etag ?? outcome.cache.checksum ?? "unversioned"}`,
      Rendering: "MapLibre WMS / ImageServer / Terrain-RGB",
      Limitation: outcome.limitation,
    });
  } else if (outcome.status === "unsupported") {
    setPreviewVisible(false);
    setText("#asset-switch-state", `${assetKey} is visibly unsupported: ${outcome.code}. WMS remains available.`);
  } else {
    setText("#asset-switch-state", `${assetKey} inspection cancelled: ${outcome.reason}.`);
  }
  render();
  announce(getElement<HTMLElement>("#asset-switch-state").textContent ?? "Asset inspection updated.");
  return outcome;
}

async function lookupAt(coordinate: ElevationCoordinate): Promise<ElevationLookupOutcome | undefined> {
  if (disposed) return { status: "cancelled", coordinate };
  interactionCount += 1;
  pointController?.abort("Elevation lookup superseded.");
  const controller = new AbortController();
  pointController = controller;
  const generation = ++pointGeneration;
  pointLoading = true;
  elevationError = undefined;
  renderElevation();
  try {
    const outcome = await journey.lookupElevation(coordinate, controller.signal);
    if (controller.signal.aborted || generation !== pointGeneration || disposed) {
      return outcome.status === "cancelled" ? outcome : { status: "cancelled", coordinate };
    }
    elevationOutcome = outcome;
    pointLoading = false;
    if (outcome.status === "ready") {
      (map.getSource(POINT_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
        featureCollection([
          {
            type: "Feature",
            properties: { elevationMeters: outcome.elevationMeters },
            geometry: { type: "Point", coordinates: coordinate },
          },
        ]) as never,
      );
    }
    renderElevation();
    announce(
      outcome.status === "ready" ? `Elevation ${outcome.elevationMeters.toFixed(1)} metres.` : "Elevation unavailable.",
    );
    return outcome;
  } catch (error) {
    if (controller.signal.aborted || generation !== pointGeneration || disposed) {
      return { status: "cancelled", coordinate };
    }
    pointLoading = false;
    elevationError = error instanceof Error ? error.message : "Unknown elevation lookup failure";
    renderElevation();
    announce(`Elevation failed: ${elevationError}`);
    return undefined;
  } finally {
    if (pointController === controller) pointController = undefined;
  }
}

async function runFixtureProfile(): Promise<ElevationProfileOutcome | undefined> {
  if (disposed) return { status: "cancelled" };
  interactionCount += 1;
  profileController?.abort("Elevation profile superseded.");
  const controller = new AbortController();
  profileController = controller;
  const generation = ++profileGeneration;
  profileLoading = true;
  profileError = undefined;
  renderProfile();
  (map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(
    featureCollection([
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: FIXTURE_ROUTE } },
    ]) as never,
  );
  try {
    const outcome = await journey.sampleProfile(FIXTURE_ROUTE, { sampleCount: 4, signal: controller.signal });
    if (controller.signal.aborted || generation !== profileGeneration || disposed) {
      return outcome.status === "cancelled" ? outcome : { status: "cancelled" };
    }
    profileOutcome = outcome;
    profileLoading = false;
    renderProfile();
    announce(
      outcome.status === "ready"
        ? `Route profile loaded with ${outcome.profile.samples.length} samples.`
        : "Route profile unavailable.",
    );
    return outcome;
  } catch (error) {
    if (controller.signal.aborted || generation !== profileGeneration || disposed) return { status: "cancelled" };
    profileLoading = false;
    profileError = error instanceof Error ? error.message : "Unknown elevation profile failure";
    renderProfile();
    announce(`Elevation profile failed: ${profileError}`);
    return undefined;
  } finally {
    if (profileController === controller) profileController = undefined;
  }
}

function updateLayerVisibility(layerId: string, visible: boolean): void {
  renderPlan = setImageryLayerVisibility(renderPlan, layerId, visible);
  const state = renderPlan.layers.find((candidate) => candidate.layer.id === layerId);
  if (state && map.getLayer(state.mapLayerId)) {
    map.setLayoutProperty(state.mapLayerId, "visibility", visible ? "visible" : "none");
  }
  renderStatus();
}

function updateLayerOpacity(layerId: string, opacity: number): void {
  renderPlan = setImageryLayerOpacity(renderPlan, layerId, opacity);
  const state = renderPlan.layers.find((candidate) => candidate.layer.id === layerId);
  if (state && map.getLayer(state.mapLayerId)) map.setPaintProperty(state.mapLayerId, "raster-opacity", state.opacity);
}

async function dispose(): Promise<void> {
  if (disposePromise) return disposePromise;
  disposed = true;
  ready = false;
  pointGeneration += 1;
  profileGeneration += 1;
  selectionGeneration += 1;
  searchController?.abort("Imagery and Terrain demo disposed.");
  pointController?.abort("Imagery and Terrain demo disposed.");
  profileController?.abort("Imagery and Terrain demo disposed.");
  bootstrapController.abort("Imagery and Terrain demo disposed.");
  disposePromise = cleanup.dispose();
  await disposePromise;
}

const runtime: ImageryTerrainBrowserRuntime = {
  get ready() {
    return ready;
  },
  get disposed() {
    return disposed && cleanup.disposed;
  },
  get activeLayerCount() {
    return activeImageryLayerCount(renderPlan) + (terrainEnabled ? 1 : 0);
  },
  get layerIds() {
    return [
      ...renderPlan.layers.map((state) => state.mapLayerId),
      TERRAIN_HILLSHADE_LAYER_ID,
      POINT_LAYER_ID,
      ROUTE_LAYER_ID,
    ];
  },
  get tileTemplates() {
    return [
      ...renderPlan.layers.flatMap((state) => state.sourceSpec.tiles),
      buildImageServerTileUrlTemplate(new HonuaImageService({ client, serviceId: "OahuTerrain" }), "png"),
    ];
  },
  get selectedAssetKey() {
    return selectedAssetKey;
  },
  get inspectionStatus() {
    return inspectionLoading ? "loading" : (inspectionOutcome?.status ?? "idle");
  },
  get cancellationCount() {
    return cancellationCount;
  },
  get releasedRasterResources() {
    return releasedRasterResources;
  },
  get lastElevationMeters() {
    return elevationOutcome?.status === "ready" ? elevationOutcome.elevationMeters : undefined;
  },
  get profileSampleCount() {
    return profileOutcome?.status === "ready" ? profileOutcome.profile.samples.length : 0;
  },
  get terrainEnabled() {
    return terrainEnabled;
  },
  get interactionCount() {
    return interactionCount;
  },
  get resources() {
    return journey.resources();
  },
  search: runSearch,
  selectAsset: inspectAsset,
  lookupAt(longitude, latitude) {
    return lookupAt([longitude, latitude]);
  },
  runFixtureProfile,
  setTerrainEnabled,
  setComparison,
  toggleLayer: updateLayerVisibility,
  setOpacity: updateLayerOpacity,
  dispose,
};
window.__HONUA_IMAGERY_TERRAIN_RUNTIME__ = runtime;
window.__HONUA_IMAGERY_TERRAIN_DISPOSE__ = dispose;
window.__HONUA_IMAGERY_COG_DEMO__ = runtime;

cleanup.listen(getElement<HTMLFormElement>("#stac-search-form"), "submit", (event) => {
  event.preventDefault();
  void runSearch();
});
cleanup.listen(getElement<HTMLElement>("#scene-results"), "click", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-scene-id]") : null;
  if (!target?.dataset.sceneId || target.dataset.sceneId === selectedItemId) return;
  selectedItemId = target.dataset.sceneId;
  selectedAssetKey =
    activeScene()?.assets.find((asset) => asset.key === DEFAULT_ASSET_KEY)?.key ?? activeScene()?.assets[0]?.key;
  renderScenes();
  renderAssetPicker();
  if (selectedAssetKey) void inspectAsset(selectedAssetKey);
});
cleanup.listen(getElement<HTMLSelectElement>("#asset-picker"), "change", (event) => {
  const picker = event.currentTarget as HTMLSelectElement;
  void inspectAsset(picker.value);
});
cleanup.listen(getElement<HTMLInputElement>("#comparison-slider"), "input", (event) => {
  interactionCount += 1;
  setComparison(Number((event.currentTarget as HTMLInputElement).value));
});
cleanup.listen(getElement<HTMLInputElement>("#terrain-toggle"), "change", (event) => {
  interactionCount += 1;
  setTerrainEnabled((event.currentTarget as HTMLInputElement).checked);
});
cleanup.listen(getElement<HTMLButtonElement>("#zoom-extent"), "click", () => {
  interactionCount += 1;
  fitDatasetExtent();
});
cleanup.listen(getElement<HTMLFormElement>("#elevation-form"), "submit", (event) => {
  event.preventDefault();
  const longitude = Number(getElement<HTMLInputElement>("#longitude-input").value);
  const latitude = Number(getElement<HTMLInputElement>("#latitude-input").value);
  void lookupAt([longitude, latitude]);
});
cleanup.listen(getElement<HTMLButtonElement>("#run-profile"), "click", () => void runFixtureProfile());
cleanup.listen(window, "beforeunload", () => void dispose(), { once: true });

const mapClick = (event: MapMouseEvent) => {
  getElement<HTMLInputElement>("#longitude-input").value = event.lngLat.lng.toFixed(4);
  getElement<HTMLInputElement>("#latitude-input").value = event.lngLat.lat.toFixed(4);
  void lookupAt([event.lngLat.lng, event.lngLat.lat]);
};
map.on("click", mapClick);
cleanup.add(() => {
  map.off("click", mapClick);
});

async function bootstrap(): Promise<void> {
  render();
  await mapLoaded;
  if (disposed) return;
  addImageryLayers(renderPlan);
  addTerrainAndAnalysisLayers();
  fitDatasetExtent();
  setComparison(comparisonValue);
  renderPlan = await hydrateImageryRenderPlan(renderPlan, client);
  await runSearch();
  if (disposed) return;
  ready = true;
  render();
  announce("Imagery and Terrain fixture journey ready.");
}

void bootstrap().catch((error) => {
  if (bootstrapController.signal.aborted) return;
  presentation.showError(error);
  announce(`Imagery and Terrain failed: ${error instanceof Error ? error.message : "unknown error"}`);
});

window.addEventListener("pagehide", () => void disposeDirectCog(), { once: true });
