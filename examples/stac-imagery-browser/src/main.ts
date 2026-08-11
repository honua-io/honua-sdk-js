import type { DynamicStacAssetDescriptor, HonuaStacItemResponse, StacSearchMethod } from "@honua/sdk-js/stac";
import { createDynamicStacClient } from "@honua/sdk-js/stac";

import { MAUI_BOUNDS, MAUI_DATETIME, mauiSearchRequest } from "./dynamic-stac-example.js";
import { createStacFixtureEnvironment } from "./fixtures.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_STAC_BROWSER__?: {
      readonly ready: boolean;
      readonly loadedCount: number;
      readonly paginationStatus: string;
      readonly selectedItemId?: string;
      readonly trace: readonly { stage: string; method: string; url: string; assetKey?: string }[];
      search(method: "GET" | "POST"): Promise<void>;
      loadNext(): Promise<void>;
      cancelPagination(): void;
      selectAsset(itemId: string, assetKey?: string): Promise<void>;
    };
  }
}

const environment = createStacFixtureEnvironment(createDynamicStacClient, { pageDelayMs: 80 });
let searchMethod: StacSearchMethod = "POST";
let searchGeneration = 0;
let abortController: AbortController | undefined;
let pageIterator: AsyncGenerator<readonly HonuaStacItemResponse[]> | undefined;
let items: HonuaStacItemResponse[] = [];
let paginationStatus = "idle";
let selectedItem: HonuaStacItemResponse | undefined;
let selectedAsset: DynamicStacAssetDescriptor | undefined;
let previewObjectUrl: string | undefined;
let ready = false;

const HANDOFFS = [
  { format: "COG", packageExport: "@honua/sdk-js/cog", href: "../../docs/walkthroughs/stac-to-cog-raster.md" },
  { format: "PMTiles", packageExport: "@honua/sdk-js/contract", href: "../../docs/pmtiles.md" },
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
}

function renderTrace(): void {
  element<HTMLElement>("#network-log").textContent = environment
    .traceForScope(searchGeneration)
    .map((entry) => {
      const url = new URL(entry.url, "https://fixture.invalid");
      const detail = entry.assetKey ? ` ${entry.assetKey}` : "";
      return `${entry.method.padEnd(5)} ${url.pathname}${url.search}${detail}`;
    })
    .join("\n");
}

function clearAssetPreview(): void {
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = undefined;
  const image = element<HTMLImageElement>("#asset-preview");
  image.removeAttribute("src");
  image.hidden = true;
}

async function renderAssetPreview(asset: DynamicStacAssetDescriptor, generation: number): Promise<void> {
  if (asset.format !== "raster") return;
  const response = await environment.fetchAsset(asset.href);
  if (!response.ok) throw new Error(`Preview request failed with ${response.status}.`);
  const objectUrl = URL.createObjectURL(await response.blob());
  if (generation !== searchGeneration) {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  clearAssetPreview();
  previewObjectUrl = objectUrl;
  const image = element<HTMLImageElement>("#asset-preview");
  image.src = previewObjectUrl;
  image.alt = `${selectedItem ? title(selectedItem) : "Maui"} selected imagery asset`;
  image.hidden = false;
}

async function selectAsset(itemId: string, assetKey = "preview"): Promise<void> {
  const generation = searchGeneration;
  const item = items.find((candidate) => String(candidate.id) === itemId);
  if (!item) return;
  selectedItem = item;
  let candidates: readonly DynamicStacAssetDescriptor[];
  try {
    candidates = await environment.stac.assets(item, {
      assetKeys: [assetKey],
      formats: ["cog", "pmtiles", "geoparquet", "raster"],
    });
  } catch (error) {
    if (generation !== searchGeneration) return;
    throw error;
  }
  if (generation !== searchGeneration) return;
  selectedAsset = candidates[0];
  try {
    if (selectedAsset) await renderAssetPreview(selectedAsset, generation);
  } catch (error) {
    if (generation !== searchGeneration) return;
    throw error;
  }
  if (generation !== searchGeneration) return;
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
  paginationStatus = "cancelled";
  render();
}

async function runSearch(method: "GET" | "POST"): Promise<void> {
  const generation = searchGeneration + 1;
  searchGeneration = generation;
  abortController?.abort();
  const controller = new AbortController();
  searchMethod = method;
  clearAssetPreview();
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
  get trace() {
    return environment.traceForScope(searchGeneration);
  },
  search: runSearch,
  loadNext,
  cancelPagination,
  selectAsset,
};
render();
