import "maplibre-gl/dist/maplibre-gl.css";

import { connect } from "@honua/sdk-js";
import {
  type CogDecoderFactory,
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
import { type ElevationCoordinate, HonuaClient, HonuaImageService, type StacAssetCandidate } from "@honua/sdk-js/honua";
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

import "../../_kit/design/index.css";
import "../../_kit/presentation.css";
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
const DIRECT_COG_SOURCE_ID = "honua-direct-cog";
const DIRECT_COG_LAYER_ID = "honua-direct-cog-layer";
const BACKGROUND_LAYER_ID = "background";

/* The basemap is the stage: its land tone is the design language's basemap
 * token, so the canvas re-keys with the active theme instead of leaving a
 * light plate behind dark chrome. */
function basemapLand(): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue("--hn-basemap-land").trim();
  return token.length > 0 ? token : "#f4f5f1";
}

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
  readonly directCog: DirectCogEvidence;
  search(): Promise<boolean>;
  selectAsset(assetKey: string): Promise<RasterAssetInspectionOutcome | undefined>;
  selectCogAsset(assetKey: string): Promise<void>;
  disposeCog(): Promise<void>;
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
    /** Backward-compatible smoke hook retained for converged legacy routes. */
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
    Range: "HonuaClient.pipelineFetch + @honua/sdk-js/cog bounded reads",
    Elevation: "HonuaClient.pipelineRequestJson + sampleElevationProfile",
    Rendering: "MapLibre direct COG / WMS / ImageServer / Terrain-RGB",
    Limitation: "Fixture decoder is deterministic; public UTM reprojection is not claimed",
  },
  onDispose: () => dispose(),
});
presentation.showDegradation([
  "The runnable fixture renders direct COG pixels through the opt-in /cog surface; scheduled public evidence qualifies bounded decoding but not browser-side UTM reprojection.",
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
    layers: [{ id: BACKGROUND_LAYER_ID, type: "background", paint: { "background-color": basemapLand() } }],
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
  released?: boolean;
}

let directCandidates: StacAssetCandidate[] = [];
let directGeneration = 0;
let activeCog: ActiveCogResources | undefined;
let fixtureDecoderModule: Awaited<typeof import("./fixture-cog-decoder.js")> | undefined;
let configuredDecoderFactory: CogDecoderFactory | undefined;
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

function instrumentConfiguredDecoderFactory(factory: CogDecoderFactory): CogDecoderFactory {
  return async (context) => {
    const decoder = await factory(context);
    let released = false;
    fixtureDecoderTelemetry.created();
    return {
      async inspect(operation) {
        try {
          return await decoder.inspect(operation);
        } catch (error) {
          if (operation.signal.aborted) fixtureDecoderTelemetry.aborted();
          throw error;
        }
      },
      async readWindow(request, operation) {
        try {
          return await decoder.readWindow(request, operation);
        } catch (error) {
          if (operation.signal.aborted) fixtureDecoderTelemetry.aborted();
          throw error;
        }
      },
      async dispose() {
        if (released) return;
        released = true;
        try {
          await decoder.dispose?.();
        } finally {
          fixtureDecoderTelemetry.disposed();
        }
      },
    };
  };
}

async function loadSelectedDecoderFactory(): Promise<CogDecoderFactory> {
  if (config.mode === "fixture-safe") return loadFixtureDecoderFactory();
  if (!configuredDecoderFactory) {
    const adapter = await import("../../../scripts/lib/geotiff-cog-decoder.mjs");
    configuredDecoderFactory = instrumentConfiguredDecoderFactory(await adapter.loadGeoTiffCogDecoderFactory());
    setDirectEvidence({ decoderModuleLoads: directEvidence.decoderModuleLoads + 1 });
  }
  return configuredDecoderFactory;
}

async function disposeCogResources(resources: ActiveCogResources | undefined): Promise<void> {
  if (!resources || resources.released) return;
  resources.released = true;
  const heldRasterResources = Boolean(resources.mount || resources.session);
  resources.controller.abort();
  try {
    if (resources.mount) await resources.mount.dispose();
    else if (resources.session) await resources.session.dispose();
  } catch {
    // Cleanup diagnostics are retained by the mount; switching remains usable.
  } finally {
    if (heldRasterResources) releasedRasterResources += 1;
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
  if (
    request.headers.has("range") &&
    ["/cors-blocked", "/cors-cog"].some((suffix) => new URL(request.url).pathname.endsWith(suffix))
  ) {
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
  try {
    const decoderFactory = await loadSelectedDecoderFactory();
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
      sourceId: DIRECT_COG_SOURCE_ID,
      layerId: DIRECT_COG_LAYER_ID,
      bands: { mode: "rgb", red: 1, green: 2, blue: 3 },
      resampling: "bilinear",
      disposeSession: true,
    });
    resources.mount = mount;
    const renderSnapshot = await mount.ready;
    if (!currentCogGeneration(resources)) return;
    if (renderSnapshot.state === "ready" && map.getLayer(DIRECT_COG_LAYER_ID)) {
      map.setPaintProperty(DIRECT_COG_LAYER_ID, "raster-opacity", comparisonValue / 100);
    }
    setDirectEvidence({
      phase: renderSnapshot.state === "ready" ? "ready" : "failed",
      render: renderSnapshot,
      transfer: session.transfer(),
      mapSourceMounted: Boolean(map.getSource(DIRECT_COG_SOURCE_ID)),
      mapLayerMounted: Boolean(map.getLayer(DIRECT_COG_LAYER_ID)),
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

async function refuseDirectCogAsset(assetKey: string, code: string, message: string): Promise<void> {
  const generation = ++directGeneration;
  const previous = activeCog;
  activeCog = undefined;
  await disposeCogResources(previous);
  if (generation !== directGeneration) return;
  setDirectEvidence({
    phase: "failed",
    generation,
    selectedAssetKey: assetKey,
    errorCode: code,
    errorMessage: message,
    inspection: undefined,
    render: undefined,
    transfer: undefined,
    mapSourceMounted: false,
    mapLayerMounted: false,
  });
}

async function initializeDirectCog(signal: AbortSignal): Promise<boolean> {
  const generation = ++directGeneration;
  const previous = activeCog;
  activeCog = undefined;
  directCandidates = [];
  await disposeCogResources(previous);
  if (signal.aborted || generation !== directGeneration || disposed) return false;
  setDirectEvidence({
    phase: "discovering",
    generation,
    candidateCount: 0,
    selectedAssetKey: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    inspection: undefined,
    render: undefined,
    transfer: undefined,
    mapSourceMounted: false,
    mapLayerMounted: false,
  });

  const scene = activeScene();
  if (!scene) {
    setDirectEvidence({
      phase: "failed",
      errorCode: "stac-item-unavailable",
      errorMessage: "No selected STAC item is available for direct COG classification.",
    });
    return false;
  }
  const endpoint =
    config.mode === "fixture-safe"
      ? new URL("/fixtures/cog/item.json", window.location.href).href
      : new URL(
          `stac/collections/${encodeURIComponent(scene.collectionId)}/items/${encodeURIComponent(scene.id)}`,
          `${config.honuaBaseUrl}/`,
        ).href;

  try {
    const connection = await connect({
      endpoint,
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: fetch },
      signal,
    });
    if (signal.aborted || generation !== directGeneration || disposed) return false;
    directCandidates = (connection.inspection.stacStatic?.assetCandidates ?? []).filter(
      (candidate) => candidate.state === "classified" && candidate.kind === "cog" && Boolean(candidate.href),
    );
    if (directCandidates.length === 0) {
      setDirectEvidence({
        phase: "failed",
        errorCode: "cog-candidate-unavailable",
        errorMessage: "The selected STAC item exposed no evidence-classified COG candidate.",
      });
      return false;
    }
    setDirectEvidence({ candidateCount: directCandidates.length });
    return true;
  } catch (error) {
    if (signal.aborted || generation !== directGeneration || disposed) return false;
    const failure = cogError(error);
    setDirectEvidence({
      phase: "failed",
      errorCode: failure.code,
      errorMessage: `Direct COG candidate discovery failed: ${failure.message}`,
    });
    return false;
  }
}

async function disposeDirectCog(): Promise<void> {
  const resources = activeCog;
  activeCog = undefined;
  directGeneration += 1;
  await disposeCogResources(resources);
  setDirectEvidence({
    phase: "disposed",
    generation: directGeneration,
    errorCode: undefined,
    errorMessage: undefined,
    inspection: undefined,
    transfer: undefined,
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
  renderDirectCog();
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
  const directCogCount = directEvidence.mapLayerMounted ? 1 : 0;
  setText("#active-layer-count", `${activeImageryLayerCount(renderPlan) + terrainCount + directCogCount} active`);
  setText(
    "#endpoint-state",
    terrainEnabled
      ? `${config.mode === "live" ? "Configured same-origin Honua" : "Same-origin fixture"} · WMS / ImageServer / STAC / Terrain-RGB`
      : `${config.mode === "live" ? "Configured same-origin Honua" : "Same-origin fixture"} · WMS / ImageServer / STAC`,
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
      <p class="limitation-note">${escapeHtml(inspectionOutcome.limitation)} The direct COG receipt and published comparison remain independently visible.</p>
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
      text: "Published WMS and ImageServer pixels use MapLibre raster sources; buildWmsRasterSourceSpec emits the exact MapLibre bbox token and literal tile dimensions.",
    },
    {
      level: "supported",
      text:
        directEvidence.phase === "ready"
          ? `The classified STAC COG is decoded through bounded reads and mounted in MapLibre (${directEvidence.transfer?.bytesFetched ?? 0} bytes fetched).`
          : `Direct COG rendering is available through the opt-in /cog surface; the current scenario is ${directEvidence.phase}${directEvidence.errorCode ? ` (${directEvidence.errorCode})` : ""}.`,
    },
    {
      level: "supported",
      text: `MapLibre Terrain-RGB and hillshade are available${terrainEnabled ? " and enabled at 1.25× exaggeration" : " but currently off"}.`,
    },
    {
      level: "degraded",
      text: "Fixture pixels use bilinear visual resampling; scientific raster analysis and public UTM browser reprojection are not claimed.",
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
      attribution: "Honua Terrain-RGB service",
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
    renderPlan = setImageryLayerOpacity(renderPlan, preview.layer.id, 1);
    if (map.getLayer(preview.mapLayerId)) map.setPaintProperty(preview.mapLayerId, "raster-opacity", 1);
  }
  if (map.getLayer(DIRECT_COG_LAYER_ID)) {
    map.setPaintProperty(DIRECT_COG_LAYER_ID, "raster-opacity", comparisonValue / 100);
  }
  const slider = getElement<HTMLInputElement>("#comparison-slider");
  slider.value = String(comparisonValue);
  setText("#comparison-value", `${comparisonValue}% direct COG over published imagery`);
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

async function runSearch(): Promise<boolean> {
  if (disposed) return false;
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
    if (controller.signal.aborted || disposed) return false;
    searchReceipt = receipt;
    selectedItemId = receipt.scenes.some((scene) => scene.id === selectedItemId)
      ? selectedItemId
      : receipt.scenes[0]?.id;
    const scene = activeScene();
    selectedAssetKey = scene?.assets.some((asset) => asset.key === DEFAULT_ASSET_KEY)
      ? DEFAULT_ASSET_KEY
      : scene?.assets[0]?.key;
    if (!scene) {
      selectionGeneration += 1;
      inspectionLoading = false;
      inspectionOutcome = undefined;
      directCandidates = [];
      setPreviewVisible(false);
      await disposeDirectCog();
      if (controller.signal.aborted || disposed) return false;
      setDirectEvidence({ candidateCount: 0, selectedAssetKey: undefined });
      setText("#asset-switch-state", "No asset is selected because the current search returned no scenes.");
      setText(
        "#attribution-state",
        "No scene attribution is active; provider attribution loads with a selected STAC item.",
      );
      presentation.updateEvidence({
        SDK: `@honua/sdk-js ${__HONUA_SDK_VERSION__}`,
        Search: receipt.sdkSurface,
        Range: "No asset selected",
        Cache: "No asset selected",
        Rendering: "WMS / ImageServer / Terrain-RGB (no direct COG selected)",
        Limitation: "No STAC scenes matched the current search filters",
      });
    }
    setText(
      "#search-status",
      receipt.scenes.length === 0
        ? "No scenes matched the current area, dates, and cloud threshold."
        : `${receipt.numberMatched} scene matched · ${receipt.scenes.length} loaded through ${receipt.sdkSurface}.`,
    );
    render();
    if (selectedItemId && selectedAssetKey) {
      await initializeDirectCog(controller.signal);
      if (controller.signal.aborted || disposed) return false;
      await inspectAsset(selectedAssetKey);
    }
    if (!disposed) {
      ready = true;
      renderStatus();
    }
    return true;
  } catch (error) {
    if (controller.signal.aborted) return false;
    setText("#search-status", `STAC search failed: ${error instanceof Error ? error.message : "unknown error"}`);
    presentation.showError(error);
    ready = false;
    renderStatus();
    announce(
      config.mode === "live"
        ? "Configured Honua STAC search failed. Verify the same-origin proxy and service capabilities."
        : "Fixture STAC search failed.",
    );
    return false;
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
    const inspectionPromise = journey.inspectAsset(selectedItemId, assetKey, bootstrapController.signal);
    const directCandidate = directCandidates.some((candidate) => candidate.assetKey === assetKey);
    const directPromise = directCandidate ? selectDirectCogAsset(assetKey) : undefined;
    outcome = await inspectionPromise;
    if (directPromise) await directPromise;
    else if (generation === selectionGeneration && !disposed) {
      await refuseDirectCogAsset(
        assetKey,
        outcome.status === "unsupported" ? outcome.code : "not-classified",
        outcome.status === "unsupported"
          ? outcome.message
          : "The selected STAC asset has no evidence-classified COG candidate for direct rendering.",
      );
    }
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
    setText(
      "#asset-switch-state",
      directEvidence.phase === "ready"
        ? `${assetKey} ready · direct COG and published comparison retained until the next switch.`
        : `${assetKey} range receipt ready · direct rendering failed visibly as ${directEvidence.errorCode ?? directEvidence.phase}.`,
    );
    presentation.updateEvidence({
      SDK: `@honua/sdk-js ${__HONUA_SDK_VERSION__}`,
      Search: searchReceipt?.sdkSurface ?? "not run",
      Range: `${outcome.range.contentRange} · ${outcome.range.tiffByteOrder}`,
      Cache: `${outcome.cache.status} · ${outcome.cache.etag ?? outcome.cache.checksum ?? "unversioned"}`,
      Rendering:
        directEvidence.phase === "ready"
          ? "MapLibre direct COG / WMS / ImageServer / Terrain-RGB"
          : "MapLibre WMS / ImageServer / Terrain-RGB (direct COG degraded)",
      Limitation:
        directEvidence.phase === "ready"
          ? "Direct fixture COG rendered; public UTM browser reprojection remains outside the claim"
          : (directEvidence.errorMessage ?? outcome.limitation),
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
  disposePromise = (async () => {
    await disposeDirectCog();
    await cleanup.dispose();
  })();
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
    return activeImageryLayerCount(renderPlan) + (terrainEnabled ? 1 : 0) + (directEvidence.mapLayerMounted ? 1 : 0);
  },
  get layerIds() {
    return [
      ...renderPlan.layers.map((state) => state.mapLayerId),
      DIRECT_COG_LAYER_ID,
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
  get directCog() {
    return directEvidence;
  },
  search: runSearch,
  selectAsset: inspectAsset,
  selectCogAsset: selectDirectCogAsset,
  disposeCog: disposeDirectCog,
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
  if (selectedAssetKey) {
    void (async () => {
      await initializeDirectCog(bootstrapController.signal);
      if (!bootstrapController.signal.aborted && selectedAssetKey) await inspectAsset(selectedAssetKey);
    })();
  }
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

type ThemePreference = "auto" | "light" | "dark";
const THEME_SEQUENCE: readonly ThemePreference[] = ["auto", "light", "dark"];

function setupThemeToggle(): void {
  const toggle = getElement<HTMLButtonElement>("#theme-toggle");
  let preference: ThemePreference = "auto";
  const apply = (): void => {
    if (preference === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = preference;
    toggle.textContent = `Theme: ${preference}`;
    retintBasemap();
  };
  cleanup.listen(toggle, "click", () => {
    const nextIndex = (THEME_SEQUENCE.indexOf(preference) + 1) % THEME_SEQUENCE.length;
    preference = THEME_SEQUENCE[nextIndex] ?? "auto";
    apply();
  });
  cleanup.listen(matchMedia("(prefers-color-scheme: dark)"), "change", () => retintBasemap());
  cleanup.add(() => {
    delete document.documentElement.dataset.theme;
  });
  apply();
}

function retintBasemap(): void {
  if (disposed || !map.getLayer(BACKGROUND_LAYER_ID)) return;
  map.setPaintProperty(BACKGROUND_LAYER_ID, "background-color", basemapLand());
}

setupThemeToggle();

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
  const searchSucceeded = await runSearch();
  if (disposed) return;
  ready = searchSucceeded;
  render();
  if (searchSucceeded) {
    announce(
      config.mode === "live"
        ? "Imagery and Terrain configured Honua journey ready."
        : "Imagery and Terrain fixture journey ready.",
    );
  }
}

void bootstrap().catch((error) => {
  if (bootstrapController.signal.aborted) return;
  presentation.showError(error);
  announce(`Imagery and Terrain failed: ${error instanceof Error ? error.message : "unknown error"}`);
});
