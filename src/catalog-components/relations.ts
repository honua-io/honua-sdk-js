import { PagedCatalogElement } from "./base.js";
import { catalogHref, node, renderCardList, renderItemLink, visibleCard } from "./dom.js";
import type { CatalogAppsUsingProjection, CatalogEndpointProjection, CatalogRelationQuery } from "./presentation.js";

abstract class CatalogRelationElement extends PagedCatalogElement {
  protected identity(): Omit<CatalogRelationQuery, "offset" | "limit"> | undefined {
    const catalogId = this.getAttribute("catalog");
    const service = this.getAttribute("service");
    const layer = this.getAttribute("layer");
    if (!catalogId || (service === null) === (layer === null) || !(service || layer)) {
      this.state("configuration", "Configure a catalog and exactly one service or layer.");
      return;
    }
    return { catalogId, kind: service !== null ? "service" : "layer", id: (service ?? layer) as string };
  }
}

export class HonuaServiceEndpointsElement extends CatalogRelationElement {
  static get observedAttributes(): string[] {
    return ["catalog", "service", "layer", "protocols", "group", "copy"];
  }

  override refresh(): void {
    const generation = this.clear();
    if (!this.isCurrent(generation)) return;
    const identity = this.identity();
    if (!identity) return;
    if (this.hasAttribute("group") && this.getAttribute("group") !== "protocol") {
      this.state("configuration", "Endpoint grouping supports protocol only.");
      return;
    }
    void this.read(
      generation,
      (client, signal) => client.getCatalogItem(identity, { signal }),
      (item) => {
        if (item.id !== identity.id || item.kind !== identity.kind) {
          this.state("unavailable", "Service endpoints are unavailable.");
          return;
        }
        if (!item.endpoints) {
          this.state("unsupported", "Service endpoints are not supported by this catalog client.");
          return;
        }
        const protocols = this.getAttribute("protocols")
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const endpoints = item.endpoints.flatMap((endpoint) => {
          const href = catalogHref(endpoint.href);
          return href && (!protocols?.length || protocols.includes(endpoint.protocol)) ? [{ ...endpoint, href }] : [];
        });
        this.renderEndpoints(endpoints, generation);
        this.structuredData(item.structuredData);
        if (this.isCurrent(generation))
          this.state(
            endpoints.length ? "ready" : "empty",
            endpoints.length ? "" : item.endpoints.length ? "No matching safe endpoints." : "No advertised endpoints.",
          );
      },
    );
  }

  private renderEndpoints(endpoints: readonly CatalogEndpointProjection[], generation: number): void {
    if (!this.hasAttribute("group")) {
      for (const endpoint of endpoints) this.content.append(this.endpointRow(endpoint, generation));
      return;
    }
    const groups = new Map<string, CatalogEndpointProjection[]>();
    for (const endpoint of endpoints)
      groups.set(endpoint.protocol, [...(groups.get(endpoint.protocol) ?? []), endpoint]);
    for (const [protocol, entries] of groups) {
      const section = node(this.ownerDocument, "section");
      section.className = "catalog-endpoints";
      section.setAttribute("aria-label", `${protocol} endpoints`);
      for (const endpoint of entries) section.append(this.endpointRow(endpoint, generation));
      this.content.append(section);
    }
  }

  private endpointRow(endpoint: CatalogEndpointProjection, generation: number): HTMLElement {
    const row = node(this.ownerDocument, "p");
    const link = node(this.ownerDocument, "a", endpoint.href);
    link.href = endpoint.href;
    row.append(link);
    if (endpoint.mediaType) row.append(node(this.ownerDocument, "span", ` (${endpoint.mediaType})`));
    if (this.hasAttribute("copy")) {
      const copy = node(this.ownerDocument, "button", `Copy ${endpoint.protocol} URL ${endpoint.href}`);
      copy.type = "button";
      copy.addEventListener("click", () => void this.copyEndpoint(endpoint, generation));
      row.append(copy);
    }
    return row;
  }

  private async copyEndpoint(endpoint: CatalogEndpointProjection, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    try {
      const clipboard = this.ownerDocument.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error("Clipboard is unavailable");
      await clipboard.writeText(endpoint.href);
      if (!this.isCurrent(generation)) return;
      this.status.textContent = `Copied ${endpoint.protocol} URL.`;
      if (!this.isCurrent(generation)) return;
      this.dispatchEvent(new CustomEvent("honua-endpoint-copy", { detail: endpoint, bubbles: true, composed: true }));
    } catch {
      if (this.isCurrent(generation))
        this.status.textContent = "Copy is unavailable. Select the endpoint link to copy its address.";
    }
  }
}

export class HonuaAppsUsingElement extends CatalogRelationElement {
  static get observedAttributes(): string[] {
    return ["catalog", "service", "layer", "view", "limit"];
  }
  private recovering = false;

  override attributeChangedCallback(): void {
    this.offset = 0;
    this.refresh();
  }

  override refresh(): void {
    this.recovering = false;
    this.loadPage();
  }

  private loadPage(): void {
    const generation = this.beginPageRead();
    if (!this.isCurrent(generation)) return;
    const identity = this.identity();
    if (!identity) return;
    const limit = this.hasAttribute("limit") ? Number(this.getAttribute("limit")) : 12;
    const view = this.getAttribute("view") ?? "cards";
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !["cards", "table"].includes(view)) {
      this.state("configuration", "Configure a cards or table view and limit from 1 to 100.");
      return;
    }
    if (!this.client?.listCatalogAppsUsing) {
      this.state("unsupported", "Apps using this item are not supported by this catalog client.");
      return;
    }
    const query = { ...identity, offset: this.offset, limit };
    void this.read(
      generation,
      (client, signal) => {
        if (!client.listCatalogAppsUsing) throw new Error("Catalog lineage is unsupported");
        return client.listCatalogAppsUsing(query, { signal });
      },
      (page) => this.renderPage(page, query, generation),
    );
  }

  private renderPage(page: CatalogAppsUsingProjection, query: CatalogRelationQuery, generation: number): void {
    if (
      page.catalogId !== query.catalogId ||
      page.subject.kind !== query.kind ||
      page.subject.id !== query.id ||
      page.offset !== query.offset ||
      page.limit !== query.limit ||
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      page.items.length > query.limit ||
      (page.items.length === 0 && page.total > query.offset) ||
      (page.items.length > 0 && page.total < query.offset + page.items.length) ||
      page.items.some((item) => !["map", "app"].includes(item.kind) || !visibleCard(item))
    ) {
      this.state("unavailable", "Apps using this item are unavailable.");
      return;
    }
    if (!page.items.length && this.offset > 0) {
      const offset = Math.max(0, Math.floor((page.total - 1) / query.limit) * query.limit);
      if (this.recovering || offset >= this.offset) {
        this.state("unavailable", "This page is unavailable. Refresh to try again.");
        return;
      }
      this.offset = offset;
      this.recovering = true;
      this.loadPage();
      return;
    }
    this.renderItems(page);
    this.renderPaging(page.total, page.limit, "Apps and maps pages");
    this.restorePageFocus();
    if (!this.isCurrent(generation)) return;
    this.structuredData(page.structuredData);
    if (this.isCurrent(generation))
      this.state(
        page.total ? "ready" : "empty",
        page.total ? `${page.total} apps and maps` : "No Released apps or maps use this item.",
      );
  }

  private renderItems(page: CatalogAppsUsingProjection): void {
    if (this.getAttribute("view") !== "table") {
      this.content.append(renderCardList(this.ownerDocument, page.items));
      return;
    }
    const table = node(this.ownerDocument, "table");
    table.append(node(this.ownerDocument, "caption", "Apps and maps using this item"));
    const heading = node(this.ownerDocument, "tr");
    for (const label of ["Kind", "Title"]) {
      const cell = node(this.ownerDocument, "th", label);
      cell.scope = "col";
      heading.append(cell);
    }
    const head = node(this.ownerDocument, "thead");
    head.append(heading);
    table.append(head);
    const body = node(this.ownerDocument, "tbody");
    for (const item of page.items) {
      const row = node(this.ownerDocument, "tr");
      row.append(node(this.ownerDocument, "td", item.kind === "app" ? "App" : "Map"));
      const cell = node(this.ownerDocument, "td");
      cell.append(renderItemLink(this.ownerDocument, item));
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    this.content.append(table);
  }
}
