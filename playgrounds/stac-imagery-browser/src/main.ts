import {
  cancelStacPagination,
  collectionCacheSummary,
  createStacBrowserSession,
  loadNextStacPage,
  selectStacAsset,
  updateStacFilters,
} from "./model.js";
import type { StacBrowserSession, StacSearchFilters } from "./types.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_STAC_BROWSER__?: {
      ready: boolean;
      loadNext(): void;
      cancelPagination(): void;
      selectAsset(itemId: string, assetKey?: string): void;
      loadedCount: number;
      projectionMessage?: string;
    };
  }
}

let session = createStacBrowserSession();

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
  renderFilters();
  renderCollections();
  renderResults();
  renderFootprint();
  renderInspector();
}

function renderStatus(): void {
  getElement<HTMLElement>("#mode-state").textContent = "Fixture safe mode";
  getElement<HTMLElement>("#cache-state").textContent = collectionCacheSummary(session.dataset);
  getElement<HTMLElement>("#capability-state").textContent =
    `STAC ${session.dataset.capabilities.stacSearch}, tiles ${session.dataset.capabilities.tilePreview}, raster ${session.dataset.capabilities.rasterAnalysis}`;
  getElement<HTMLElement>("#page-state").textContent =
    `${session.loadedItems.length}/${session.totalMatched} loaded, ${session.paginationStatus}`;
}

function renderFilters(): void {
  getElement<HTMLInputElement>("#collection").value = session.filters.collectionId;
  getElement<HTMLInputElement>("#start-date").value = session.filters.startDate;
  getElement<HTMLInputElement>("#end-date").value = session.filters.endDate;
  getElement<HTMLInputElement>("#cloud-cover").value = String(session.filters.maxCloudCover);
  getElement<HTMLElement>("#cloud-value").textContent = `${session.filters.maxCloudCover}%`;
  getElement<HTMLInputElement>("#asset-type").value = session.filters.assetType;
  getElement<HTMLInputElement>("#aoi").value = [
    session.filters.aoi.xmin,
    session.filters.aoi.ymin,
    session.filters.aoi.xmax,
    session.filters.aoi.ymax,
  ].join(",");
}

function renderCollections(): void {
  getElement<HTMLElement>("#collection-list").innerHTML = session.dataset.collections
    .map(
      (collection) => `
        <li data-cache="${collection.cache.status}">
          <strong>${escapeHtml(collection.title)}</strong>
          <span>${escapeHtml(collection.id)} / ${escapeHtml(collection.cache.status)} / ${collection.cache.schemaCached ? "schema cached" : "schema pending"}</span>
        </li>
      `,
    )
    .join("");
}

function renderResults(): void {
  getElement<HTMLElement>("#result-list").innerHTML = session.loadedItems
    .map(
      (item) => `
        <li data-active="${item.id === session.activeItem?.id}">
          <button type="button" data-item="${escapeHtml(item.id)}" data-asset="visual">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.datetime.slice(0, 10))} / ${item.cloudCover}% cloud / ${escapeHtml(item.platform)}</span>
          </button>
        </li>
      `,
    )
    .join("");

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-item]")) {
    button.addEventListener("click", () => {
      session = selectStacAsset(session, button.dataset.item ?? "", button.dataset.asset ?? "visual");
      render();
    });
  }

  getElement<HTMLButtonElement>("#load-next").disabled =
    session.paginationStatus === "complete" || session.paginationStatus === "cancelled";
  getElement<HTMLButtonElement>("#cancel-pagination").disabled =
    session.paginationStatus === "complete" || session.paginationStatus === "cancelled";
}

function renderFootprint(): void {
  const item = session.activeItem;
  const map = getElement<HTMLElement>("#footprint-map");
  if (!item) {
    map.innerHTML = "<p>No footprint selected.</p>";
    return;
  }
  const points = item.footprint
    .map(([x, y]) => {
      const px = ((x - item.bbox.xmin) / (item.bbox.xmax - item.bbox.xmin || 1)) * 78 + 10;
      const py = 90 - ((y - item.bbox.ymin) / (item.bbox.ymax - item.bbox.ymin || 1)) * 78;
      return `${px},${py}`;
    })
    .join(" ");
  map.innerHTML = `
    <svg viewBox="0 0 100 100" role="img" aria-label="Selected item footprint">
      <rect x="8" y="8" width="84" height="84"></rect>
      <polyline points="${escapeHtml(points)}"></polyline>
      <circle cx="50" cy="50" r="3"></circle>
    </svg>
  `;
}

function renderInspector(): void {
  const item = session.activeItem;
  const projection = session.projection;
  getElement<HTMLElement>("#item-metadata").innerHTML = item
    ? `
      <dl>
        <dt>Item</dt><dd>${escapeHtml(item.id)}</dd>
        <dt>Collection</dt><dd>${escapeHtml(item.collectionId)}</dd>
        <dt>Datetime</dt><dd>${escapeHtml(item.datetime)}</dd>
        <dt>Cloud cover</dt><dd>${item.cloudCover}%</dd>
      </dl>
    `
    : "<p>No item selected.</p>";

  getElement<HTMLElement>("#asset-list").innerHTML = item
    ? item.assets
        .map(
          (asset) => `
            <li data-support="${asset.support}">
              <button type="button" data-item="${escapeHtml(item.id)}" data-asset-key="${escapeHtml(asset.key)}">
                <strong>${escapeHtml(asset.title)}</strong>
                <span>${escapeHtml(asset.type)} / ${escapeHtml(asset.support)}</span>
              </button>
            </li>
          `,
        )
        .join("")
    : "";

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-asset-key]")) {
    button.addEventListener("click", () => {
      session = selectStacAsset(session, button.dataset.item ?? "", button.dataset.assetKey ?? "visual");
      render();
    });
  }

  const preview = getElement<HTMLElement>("#preview-state");
  if (!projection) {
    preview.textContent = "No selected asset.";
  } else {
    preview.dataset.renderable = String(projection.renderable);
    preview.textContent = projection.message;
  }
}

function filtersFromForm(): StacSearchFilters {
  const [xmin, ymin, xmax, ymax] = getElement<HTMLInputElement>("#aoi")
    .value.split(",")
    .map((value) => Number(value.trim()));
  return {
    aoi: { xmin, ymin, xmax, ymax },
    startDate: getElement<HTMLInputElement>("#start-date").value,
    endDate: getElement<HTMLInputElement>("#end-date").value,
    collectionId: getElement<HTMLInputElement>("#collection").value,
    maxCloudCover: Number(getElement<HTMLInputElement>("#cloud-cover").value),
    assetType: getElement<HTMLInputElement>("#asset-type").value,
  };
}

getElement<HTMLFormElement>("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  session = updateStacFilters(session, filtersFromForm());
  render();
});

getElement<HTMLButtonElement>("#load-next").addEventListener("click", () => {
  session = loadNextStacPage(session);
  render();
});

getElement<HTMLButtonElement>("#cancel-pagination").addEventListener("click", () => {
  session = cancelStacPagination(session);
  render();
});

getElement<HTMLInputElement>("#cloud-cover").addEventListener("input", () => {
  getElement<HTMLElement>("#cloud-value").textContent = `${getElement<HTMLInputElement>("#cloud-cover").value}%`;
});

window.__HONUA_STAC_BROWSER__ = {
  ready: true,
  loadNext() {
    session = loadNextStacPage(session);
    render();
  },
  cancelPagination() {
    session = cancelStacPagination(session);
    render();
  },
  selectAsset(itemId: string, assetKey = "visual") {
    session = selectStacAsset(session, itemId, assetKey);
    render();
  },
  get loadedCount() {
    return session.loadedItems.length;
  },
  get projectionMessage() {
    return session.projection?.message;
  },
};

render();
