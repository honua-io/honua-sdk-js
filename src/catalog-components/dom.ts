import { isCredentialQueryName } from "../connect-url-safety.js";
import { sanitizeDisplayHref } from "../web-components/display-href.js";
import type { CatalogCardProjection } from "./presentation.js";

export function catalogHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!sanitizeDisplayHref(value) || url.hash) return;
    if ([...url.searchParams.keys()].some(isCredentialQueryName)) return;
    return url.href;
  } catch {
    return;
  }
}

export function node<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function visibleCard(item: CatalogCardProjection): boolean {
  return (
    ["dataset", "layer", "service", "map", "app"].includes(item.kind) &&
    (!(item.kind === "map" || item.kind === "app") || Boolean(item.releasedVersionId)) &&
    Boolean(catalogHref(item.detailHref))
  );
}

export function renderCard(document: Document, item: CatalogCardProjection): HTMLElement {
  const article = node(document, "article");
  article.className = "catalog-card";
  const imageHref = item.thumbnail && catalogHref(item.thumbnail.href);
  if (imageHref) {
    const image = node(document, "img");
    image.src = imageHref;
    image.alt = item.thumbnail?.alt ?? "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.replaceWith(thumbnailFallback(document, item)), { once: true });
    article.append(image);
  } else article.append(thumbnailFallback(document, item));
  article.append(node(document, "p", kindLabel(item)));
  const heading = node(document, "h2");
  const link = node(document, "a", item.title);
  link.href = catalogHref(item.detailHref) ?? "";
  link.addEventListener("click", (event) => {
    const navigation = new CustomEvent("honua-catalog-item-activate", {
      detail: { kind: item.kind, id: item.id, href: link.href },
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    if (!article.dispatchEvent(navigation)) event.preventDefault();
  });
  heading.append(link);
  article.append(heading);
  if (item.summary) article.append(node(document, "p", item.summary));
  const health = item.health?.status;
  const healthLabel =
    health === "healthy"
      ? "Healthy"
      : health === "degraded"
        ? "Degraded"
        : health === "down"
          ? "Down"
          : "Health unknown";
  const badge = node(document, "p", healthLabel);
  badge.className = "catalog-health";
  badge.dataset.health = ["healthy", "degraded", "down"].includes(health ?? "") ? (health ?? "unknown") : "unknown";
  article.append(badge);
  return article;
}

function thumbnailFallback(document: Document, item: CatalogCardProjection): HTMLElement {
  const placeholder = node(document, "div", `${kindLabel(item)} preview unavailable`);
  placeholder.className = "catalog-thumbnail-fallback";
  return placeholder;
}

function kindLabel(item: CatalogCardProjection): string {
  if (item.kind === "dataset")
    return item.datasetKind === "coverage" ? "Coverage" : item.spatial === false ? "Table" : "Feature type";
  return item.kind.charAt(0).toUpperCase() + item.kind.slice(1);
}
