import { vi } from "vitest";
import { defineCatalogComponents } from "../../../src/catalog-components/index.js";
import type { CatalogCardProjection, CatalogComponentClient } from "../../../src/catalog-components/presentation.js";

export const catalogCardFixture: CatalogCardProjection = {
  id: "flood-zones", kind: "dataset", title: "Flood zones", summary: "Current flood areas",
  detailHref: "https://catalog.example/items/flood-zones", datasetKind: "feature-type", spatial: true,
  thumbnail: { href: "https://catalog.example/thumbnail.png", alt: "Flood areas along the river" },
  health: { status: "degraded" }, releasedVersionId: null,
};

export function catalogClientFixture(item = catalogCardFixture): CatalogComponentClient {
  return {
    listCatalog: vi.fn(async () => ({ items: [item], total: 1, offset: 0, limit: 12, facets: {} })),
    getCatalogItem: vi.fn(async () => item),
  };
}

export type CatalogTestElement = HTMLElement & { client: CatalogComponentClient | undefined; refresh(): void };

export function mountCatalogFixture(tag: string, client = catalogClientFixture(), prepare?: (element: CatalogTestElement) => void): CatalogTestElement {
  defineCatalogComponents({ enabled: true });
  const element = document.createElement(tag) as CatalogTestElement;
  element.setAttribute("catalog", "open-data");
  if (tag.endsWith("-card")) element.setAttribute(tag.split("-")[1], catalogCardFixture.id);
  element.client = client;
  prepare?.(element);
  document.body.append(element);
  return element;
}
