import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibre-vite-worker.js";

import { type PmtilesArchiveInspection, inspectPmtilesArchive } from "@honua/sdk-js/pmtiles";
import type { DynamicStacAssetDescriptor, HonuaStacItemResponse, StacSearchMethod } from "@honua/sdk-js/stac";
import { createDynamicStacClient } from "@honua/sdk-js/stac";
import * as maplibregl from "maplibre-gl";

import { MAUI_BOUNDS, MAUI_DATETIME, mauiSearchRequest } from "./dynamic-stac-example.js";
import {
  PMTILES_AUTHORIZATION_SCOPE,
  PMTILES_INSPECTION_LIMITS,
  type StacFixtureTrace,
  createStacFixtureEnvironment,
} from "./fixtures.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_STAC_BROWSER__?: {
      readonly ready: boolean;
      readonly loadedCount: number;
      readonly paginationStatus: string;
      readonly selectedItemId?: string;
      readonly selectedAssetKey?: string;
      readonly selectedAssetFormat?: string;
      readonly mapReady: boolean;
      readonly mapImageSourceActive: boolean;
      readonly mapFootprintSourceActive: boolean;
      readonly mapSelectionSourceIds: readonly string[];
      readonly mapSelectionLayerIds: readonly string[];
      readonly mappedItemId?: string;
      readonly mappedCoordinates?: readonly (readonly [number, number])[];
      readonly pmtilesInspection?: PmtilesArchiveInspection;
      readonly trace: readonly StacFixtureTrace[];
      search(method: "GET" | "POST"): Promise<void>;
      loadNext(): Promise<void>;
      cancelPagination(): void;
      selectAsset(itemId: string, assetKey?: string): Promise<void>;
      dispose(): void;
    };
  }
}

const environment = createStacFixtureEnvironment(createDynamicStacClient, {
  assetDelayMs: 80,
  pmtilesDelayMs: 160,
  pageDelayMs: 80,
});
const IMAGE_SOURCE_ID = "selected-stac-image";
const IMAGE_LAYER_ID = "selected-stac-image-raster";
const FOOTPRINT_SOURCE_ID = "selected-stac-footprint";
const FOOTPRINT_FILL_LAYER_ID = "selected-stac-footprint-fill";
const FOOTPRINT_LINE_LAYER_ID = "selected-stac-footprint-line";
const map = new maplibregl.Map({
  container: "imagery-map",
  attributionControl: false,
  center: [-156.3, 20.8],
  zoom: 8,
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "ocean-background", type: "background", paint: { "background-color": "#073b4c" } }],
  },
});
let searchMethod: StacSearchMethod = "POST";
let searchGeneration = 0;
let abortController: AbortController | undefined;
let assetSelectionEpoch = 0;
let assetAbortController: AbortController | undefined;
let disposed = false;
let pageIterator: AsyncGenerator<readonly HonuaStacItemResponse[]> | undefined;
let items: HonuaStacItemResponse[] = [];
let paginationStatus = "idle";
let selectedItem: HonuaStacItemResponse | undefined;
let selectedAsset: DynamicStacAssetDescriptor | undefined;
let previewObjectUrl: string | undefined;
let mappedItemId: string | undefined;
let mappedCoordinates: readonly (readonly [number, number])[] | undefined;
let pmtilesInspection: PmtilesArchiveInspection | undefined;
let mapReady = false;
let ready = false;

const HANDOFFS = [
  { format: "COG", packageExport: "@honua/sdk-js/cog", href: "../../docs/walkthroughs/stac-to-cog-raster.md" },
  { format: "PMTiles", packageExport: "@honua/sdk-js/pmtiles", href: "../../docs/pmtiles.md" },
  {
    format: "GeoParquet",
    packageExport: "@honua/sdk-js/columnar-workflow",
    href: "../../docs/walkthroughs/server-or-browser-columnar.md",
  },
  {
    format: "Unified raster",
    packageExport: "@honua/sdk-js/raster",
    href: "../../docs/walkthroughs/stac-to-cog-raster.md",
  },
  { format: "Browser preview", packageExport: "@honua/sdk-js/runtime", href: "../../docs/browser-bundle.md" },
] as const;

function element<T extends Element>(selector: string): T {
  const target = document.querySelector<T>(selector);
  if (!target) throw new Error(`Missing required element: ${selector}`);
  return target;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function property(item: HonuaStacItemResponse, key: string): unknown {
  return item.properties && typeof item.properties === "object" ? item.properties[key] : undefined;
}

function title(item: HonuaStacItemResponse): string {
  return String(property(item, "title") ?? item.id);
}

function bbox(item: HonuaStacItemResponse): readonly number[] {
  return Array.isArray(item.bbox) ? item.bbox : MAUI_BOUNDS;
}

function render(): void {
  element<HTMLElement>("#method-state").textContent = `${searchMethod} Item Search`;
  element<HTMLElement>("#page-state").textContent = `${items.length} loaded / ${paginationStatus}`;
  element<HTMLElement>("#selected-state").textContent = selectedItem
    ? `Selected ${selectedItem.id}`
    : "Nothing selected";
  element<HTMLSelectElement>("#search-method").value = searchMethod;
  element<HTMLButtonElement>("#load-next").disabled = paginationStatus !== "ready for next page";
  element<HTMLButtonElement>("#cancel-pagination").disabled = paginationStatus !== "loading";
  renderResults();
  renderSelection();
  renderTrace();
}

function renderResults(): void {
  element<HTMLElement>("#result-list").innerHTML = items
    .map(
      (item, index) => `
        <li data-active="${item.id === selectedItem?.id}">
          <button type="button" data-result-id="${escapeHtml(item.id)}">
            <span class="result-index">${String(index + 1).padStart(2, "0")}</span>
            <span><strong>${escapeHtml(title(item))}</strong><small>${escapeHtml(property(item, "datetime"))} / ${escapeHtml(property(item, "eo:cloud_cover"))}% cloud</small></span>
          </button>
        </li>`,
    )
    .join("");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-result-id]")) {
    button.addEventListener("click", () => void selectAsset(button.dataset.resultId ?? "", "preview"));
  }
}

function renderSelection(): void {
  const item = selectedItem;
  const asset = selectedAsset;
  const metadata = element<HTMLElement>("#item-metadata");
  const assets = element<HTMLElement>("#asset-list");
  if (!item) {
    metadata.innerHTML = "<p>Run the bounded search to inspect a result.</p>";
    assets.innerHTML = "";
    renderPmtilesInspection();
    return;
  }

  metadata.innerHTML = `
    <p class="kicker">Selected record</p>
    <h2>${escapeHtml(title(item))}</h2>
    <dl>
      <dt>Item ID</dt><dd>${escapeHtml(item.id)}</dd>
      <dt>Captured</dt><dd>${escapeHtml(property(item, "datetime"))}</dd>
      <dt>Cloud</dt><dd>${escapeHtml(property(item, "eo:cloud_cover"))}%</dd>
      <dt>Bounds</dt><dd>${bbox(item)
        .map((value) => Number(value).toFixed(2))
        .join(", ")}</dd>
      <dt>Extensions</dt><dd>${item.stac_extensions?.length ? escapeHtml(item.stac_extensions.join(", ")) : "None required"}</dd>
    </dl>`;

  assets.innerHTML = Object.entries(item.assets ?? {})
    .map(
      ([key, candidate]) => `
        <li data-active="${key === asset?.key}">
          <button type="button" data-asset-key="${escapeHtml(key)}" data-item-id="${escapeHtml(item.id)}">
            <strong>${escapeHtml(candidate.title ?? key)}</strong>
            <small>${escapeHtml(candidate.type ?? "media type not advertised")}</small>
          </button>
        </li>`,
    )
    .join("");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-asset-key]")) {
    button.addEventListener(
      "click",
      () => void selectAsset(button.dataset.itemId ?? "", button.dataset.assetKey ?? "preview"),
    );
  }

  const handoff = element<HTMLElement>("#handoff-state");
  handoff.textContent = asset?.handoff
    ? `${asset.format} is ready for ${asset.handoff.packageExport}`
    : "This asset is discoverable, but it has no executable SDK handoff.";
  handoff.dataset.supported = String(asset?.handoff !== undefined);
  renderPmtilesInspection();
}

function renderPmtilesInspection(): void {
  const output = element<HTMLElement>("#asset-inspection");
  if (selectedAsset?.format !== "pmtiles") {
    output.dataset.state = "idle";
    output.textContent = "Select the PMTiles asset to inspect its v3 metadata and exact HTTP range evidence.";
    return;
  }
  if (!pmtilesInspection) {
    output.dataset.state = "loading";
    output.textContent = "Inspecting the signed PMTiles descriptor within the reviewed request and byte limits...";
    return;
  }
  const metadata = pmtilesInspection.metadata;
  const ranges = metadata.transfer.ranges
    .map((range) => `${range.status} ${range.contentRange} (${range.bytesReceived} bytes)`)
    .join("\n");
  output.dataset.state = "complete";
  output.textContent = [
    `PMTiles v${metadata.specVersion} / ${metadata.tileKind.toUpperCase()} / z${metadata.minZoom}-z${metadata.maxZoom}`,
    `Bounds ${metadata.bounds.join(", ")}`,
    `Transfer ${metadata.transfer.requests} request / ${metadata.transfer.bytesFetched} bytes`,
    ranges,
    pmtilesInspection.rendererSource
      ? "Renderer descriptor derived; not mounted in this STAC inspection walkthrough."
      : "No renderer descriptor was derived from the inspected metadata.",
  ].join("\n");
}

function renderTrace(): void {
  element<HTMLElement>("#network-log").textContent = environment
    .traceForScope(searchGeneration, assetSelectionEpoch)
    .map((entry) => {
      const url = new URL(entry.url, "https://fixture.invalid");
      const detail = entry.assetKey ? ` ${entry.assetKey}` : "";
      const range = entry.range ? ` ${entry.range}` : "";
      const status = entry.status ? ` ${entry.status}` : "";
      const authorization = entry.authorization ? ` auth=${entry.authorization}` : "";
      return `${entry.method.padEnd(5)} ${url.pathname}${url.search}${detail}${range}${status}${authorization}`;
    })
    .join("\n");
}

function clearAssetPreview(): void {
  clearMapSelection();
  pmtilesInspection = undefined;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = undefined;
  const image = element<HTMLImageElement>("#asset-preview");
  image.removeAttribute("src");
  image.hidden = true;
}

function clearMapSelection(): void {
  for (const layerId of [FOOTPRINT_LINE_LAYER_ID, FOOTPRINT_FILL_LAYER_ID, IMAGE_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [FOOTPRINT_SOURCE_ID, IMAGE_SOURCE_ID]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
  mappedItemId = undefined;
  mappedCoordinates = undefined;
  delete element<HTMLElement>("#imagery-map").dataset.selectedItemId;
}

interface AssetSelectionContext {
  readonly generation: number;
  readonly epoch: number;
  readonly controller: AbortController;
}

function isCurrentAssetSelection(selection: AssetSelectionContext): boolean {
  return (
    !disposed &&
    selection.generation === searchGeneration &&
    selection.epoch === assetSelectionEpoch &&
    assetAbortController === selection.controller &&
    !selection.controller.signal.aborted
  );
}

function abortCurrentAssetSelection(clearState = true): void {
  assetAbortController?.abort();
  assetAbortController = undefined;
  if (clearState) {
    clearAssetPreview();
    selectedAsset = undefined;
  }
}

function beginAssetSelection(generation: number): AssetSelectionContext {
  assetAbortController?.abort();
  assetSelectionEpoch += 1;
  const controller = new AbortController();
  assetAbortController = controller;
  environment.setTraceScope(controller.signal, generation);
  environment.setTraceSelection(controller.signal, assetSelectionEpoch);
  clearAssetPreview();
  selectedAsset = undefined;
  return { generation, epoch: assetSelectionEpoch, controller };
}

async function renderMapSelection(
  objectUrl: string,
  item: HonuaStacItemResponse,
  selection: AssetSelectionContext,
): Promise<void> {
  if (!isCurrentAssetSelection(selection)) return;
  const [xmin, ymin, xmax, ymax] = bbox(item).map(Number);
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
    [xmin, ymax],
    [xmax, ymax],
    [xmax, ymin],
    [xmin, ymin],
  ];
  map.addSource(IMAGE_SOURCE_ID, { type: "image", url: objectUrl, coordinates });
  map.addLayer({ id: IMAGE_LAYER_ID, type: "raster", source: IMAGE_SOURCE_ID, paint: { "raster-opacity": 0.88 } });
  map.addSource(FOOTPRINT_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "Feature",
      properties: { itemId: String(item.id) },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [xmin, ymin],
            [xmax, ymin],
            [xmax, ymax],
            [xmin, ymax],
            [xmin, ymin],
          ],
        ],
      },
    },
  });
  map.addLayer({
    id: FOOTPRINT_FILL_LAYER_ID,
    type: "fill",
    source: FOOTPRINT_SOURCE_ID,
    paint: { "fill-color": "#f4b942", "fill-opacity": 0.1 },
  });
  map.addLayer({
    id: FOOTPRINT_LINE_LAYER_ID,
    type: "line",
    source: FOOTPRINT_SOURCE_ID,
    paint: { "line-color": "#fff7dc", "line-width": 3 },
  });
  map.fitBounds(
    [
      [xmin, ymin],
      [xmax, ymax],
    ],
    { duration: 0, padding: 42 },
  );
  await Promise.race([
    map.once("idle"),
    new Promise<void>((resolve) =>
      selection.controller.signal.addEventListener("abort", () => resolve(), { once: true }),
    ),
  ]);
  if (!isCurrentAssetSelection(selection)) return;
  mappedItemId = String(item.id);
  mappedCoordinates = coordinates;
  element<HTMLElement>("#imagery-map").dataset.selectedItemId = mappedItemId;
}

async function renderAssetPreview(
  asset: DynamicStacAssetDescriptor,
  item: HonuaStacItemResponse,
  selection: AssetSelectionContext,
): Promise<void> {
  if (asset.format !== "raster") return;
  const response = await environment.fetchAsset(asset.href, { signal: selection.controller.signal });
  if (!response.ok) throw new Error(`Preview request failed with ${response.status}.`);
  if (!isCurrentAssetSelection(selection)) return;
  const blob = await response.blob();
  if (!isCurrentAssetSelection(selection)) return;
  const objectUrl = URL.createObjectURL(blob);
  if (!isCurrentAssetSelection(selection)) {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  previewObjectUrl = objectUrl;
  const image = element<HTMLImageElement>("#asset-preview");
  image.src = previewObjectUrl;
  image.alt = `${title(item)} selected imagery asset`;
  image.hidden = false;
  await image.decode();
  if (!isCurrentAssetSelection(selection)) return;
  await renderMapSelection(objectUrl, item, selection);
}

async function inspectSelectedPmtiles(
  asset: DynamicStacAssetDescriptor,
  selection: AssetSelectionContext,
): Promise<void> {
  if (asset.format !== "pmtiles") return;
  const inspection = await inspectPmtilesArchive({
    endpoint: asset.href,
    authorizationScopeFingerprint: PMTILES_AUTHORIZATION_SCOPE,
    client: environment.createAssetClient(asset.href),
    signal: selection.controller.signal,
    limits: PMTILES_INSPECTION_LIMITS,
  });
  if (!isCurrentAssetSelection(selection)) return;
  pmtilesInspection = inspection;
}

async function selectAsset(itemId: string, assetKey = "preview"): Promise<void> {
  const generation = searchGeneration;
  if (disposed || !abortController || abortController.signal.aborted) return;
  const selection = beginAssetSelection(generation);
  const item = items.find((candidate) => String(candidate.id) === itemId);
  if (!item) return;
  selectedItem = item;
  render();
  let candidates: readonly DynamicStacAssetDescriptor[];
  try {
    candidates = await environment.stac.assets(item, {
      assetKeys: [assetKey],
      formats: ["cog", "pmtiles", "geoparquet", "raster"],
      signal: selection.controller.signal,
    });
  } catch (error) {
    if (!isCurrentAssetSelection(selection)) return;
    throw error;
  }
  if (!isCurrentAssetSelection(selection)) return;
  selectedAsset = candidates[0];
  render();
  try {
    if (selectedAsset?.format === "pmtiles") {
      await inspectSelectedPmtiles(selectedAsset, selection);
    } else if (selectedAsset) {
      await renderAssetPreview(selectedAsset, item, selection);
    }
  } catch (error) {
    if (!isCurrentAssetSelection(selection)) return;
    throw error;
  }
  if (!isCurrentAssetSelection(selection)) return;
  render();
}

async function loadNext(): Promise<void> {
  const generation = searchGeneration;
  const iterator = pageIterator;
  const controller = abortController;
  if (!iterator || !controller || paginationStatus === "complete" || paginationStatus === "cancelled") return;
  await loadNextForGeneration(generation, iterator, controller);
}

async function loadNextForGeneration(
  generation: number,
  iterator: AsyncGenerator<readonly HonuaStacItemResponse[]>,
  controller: AbortController,
): Promise<void> {
  if (generation !== searchGeneration) return;
  paginationStatus = "loading";
  render();
  try {
    const next = await iterator.next();
    if (generation !== searchGeneration) return;
    if (next.done) {
      paginationStatus = "complete";
    } else {
      items.push(...next.value);
      paginationStatus = "ready for next page";
      if (!selectedItem && items[0]) await selectAsset(String(items[0].id), "preview");
    }
  } catch (error) {
    if (generation !== searchGeneration) return;
    if (controller.signal.aborted) paginationStatus = "cancelled";
    else throw error;
  }
  if (generation !== searchGeneration) return;
  render();
}

function cancelPagination(): void {
  abortController?.abort();
  abortCurrentAssetSelection();
  paginationStatus = "cancelled";
  render();
}

async function runSearch(method: "GET" | "POST"): Promise<void> {
  if (disposed) return;
  const generation = searchGeneration + 1;
  searchGeneration = generation;
  abortController?.abort();
  abortCurrentAssetSelection();
  const controller = new AbortController();
  searchMethod = method;
  items = [];
  selectedItem = undefined;
  selectedAsset = undefined;
  paginationStatus = "idle";
  environment.resetTrace();
  environment.setTraceScope(controller.signal, generation);
  const iterator = environment.stac.pages({
    ...mauiSearchRequest(method, controller.signal),
    pageSize: 2,
    maxPages: 3,
    prefetchPages: 0,
  });
  abortController = controller;
  pageIterator = iterator;
  await loadNextForGeneration(generation, iterator, controller);
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  searchGeneration += 1;
  abortController?.abort();
  abortController = undefined;
  abortCurrentAssetSelection();
  if (pageIterator) void pageIterator.return(undefined);
  pageIterator = undefined;
  map.remove();
}

element<HTMLFormElement>("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearch(element<HTMLSelectElement>("#search-method").value as "GET" | "POST");
});
element<HTMLButtonElement>("#load-next").addEventListener("click", () => void loadNext());
element<HTMLButtonElement>("#cancel-pagination").addEventListener("click", cancelPagination);

element<HTMLElement>("#handoff-list").innerHTML = HANDOFFS.map(
  (handoff) =>
    `<li><a href="${handoff.href}"><strong>${handoff.format}</strong><code>${handoff.packageExport}</code></a></li>`,
).join("");
element<HTMLElement>("#query-bounds").textContent = MAUI_BOUNDS.join(", ");
element<HTMLElement>("#query-time").textContent = MAUI_DATETIME;

await map.once("load");
mapReady = true;
await environment.stac.catalog();
await runSearch("POST");
ready = true;
window.__HONUA_STAC_BROWSER__ = {
  get ready() {
    return ready;
  },
  get loadedCount() {
    return items.length;
  },
  get paginationStatus() {
    return paginationStatus;
  },
  get selectedItemId() {
    return selectedItem ? String(selectedItem.id) : undefined;
  },
  get selectedAssetKey() {
    return selectedAsset?.key;
  },
  get selectedAssetFormat() {
    return selectedAsset?.format;
  },
  get mapReady() {
    return mapReady;
  },
  get mapImageSourceActive() {
    return map.getSource(IMAGE_SOURCE_ID) !== undefined;
  },
  get mapFootprintSourceActive() {
    return map.getSource(FOOTPRINT_SOURCE_ID) !== undefined;
  },
  get mapSelectionSourceIds() {
    return [IMAGE_SOURCE_ID, FOOTPRINT_SOURCE_ID].filter((id) => map.getSource(id) !== undefined);
  },
  get mapSelectionLayerIds() {
    return [IMAGE_LAYER_ID, FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID].filter(
      (id) => map.getLayer(id) !== undefined,
    );
  },
  get mappedItemId() {
    return mappedItemId;
  },
  get mappedCoordinates() {
    return mappedCoordinates;
  },
  get pmtilesInspection() {
    return pmtilesInspection;
  },
  get trace() {
    return environment.traceForScope(searchGeneration, assetSelectionEpoch);
  },
  search: runSearch,
  loadNext,
  cancelPagination,
  selectAsset,
  dispose,
};
window.addEventListener("pagehide", dispose, { once: true });
render();
