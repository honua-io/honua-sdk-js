import { CatalogElement } from "./base.js";
import { node, renderCard, renderCatalogPaging, visibleCard } from "./dom.js";
import type { CatalogCardProjection, CatalogSearchProjection, CatalogSearchQuery } from "./presentation.js";

const kinds = ["dataset", "layer", "service", "map", "app"];

export class HonuaCatalogCardElement extends CatalogElement {
  static get observedAttributes(): string[] {
    return ["catalog", ...kinds, "show"];
  }

  override refresh(): void {
    const generation = this.clear();
    if (!this.isCurrent(generation)) return;
    const kind = this.localName.split("-")[1];
    const id = this.getAttribute(kind);
    const catalogId = this.getAttribute("catalog");
    if (!id || !catalogId) {
      this.state("configuration", "Configure a catalog and item identity.");
      return;
    }
    const identity = { catalogId, kind, id };
    void this.read(
      generation,
      (client, signal) => client.getCatalogItem(identity, { signal }),
      (item) => this.renderItem(item, identity, generation),
    );
  }

  private renderItem(
    item: CatalogCardProjection,
    identity: { readonly kind: string; readonly id: string },
    generation: number,
  ): void {
    if (!visibleCard(item) || item.kind !== identity.kind || item.id !== identity.id) {
      this.state("unavailable", "Catalog content is unavailable.");
      return;
    }
    this.content.append(renderCard(this.ownerDocument, item));
    this.structuredData(item.structuredData);
    if (this.isCurrent(generation)) this.state("ready", "");
  }
}

export class HonuaCatalogSearchElement extends CatalogElement {
  static get observedAttributes(): string[] {
    return ["catalog", "kind", "category", "limit", "label"];
  }
  private searchText = "";
  private offset = 0;
  private selectedKind = "";
  private sort: "title" | "-updated" = "title";
  private focusKey?: string;
  private filtersOpen = false;

  override attributeChangedCallback(name?: string): void {
    if (name === "kind") this.selectedKind = "";
    this.offset = 0;
    this.refresh();
  }

  override refresh(): void {
    this.focusKey = this.focusedControl();
    const generation = this.clear();
    if (!this.isCurrent(generation)) return;
    const catalogId = this.getAttribute("catalog");
    const kind = this.getAttribute("kind") ?? this.selectedKind;
    const limitText = this.getAttribute("limit");
    const limit = limitText === null ? 12 : Number(limitText);
    if (!catalogId || !Number.isInteger(limit) || limit < 1 || limit > 100 || (kind && !kinds.includes(kind))) {
      this.state("configuration", "Configure a catalog, supported kind and limit from 1 to 100.");
      return;
    }
    this.renderForm();
    this.restoreControlFocus(this.focusKey);
    if (!this.isCurrent(generation)) return;
    const query: CatalogSearchQuery = {
      catalogId,
      q: this.searchText || undefined,
      kind: kind ? [kind] : undefined,
      category: this.getAttribute("category") ? [this.getAttribute("category") ?? ""] : undefined,
      sort: this.sort,
      offset: this.offset,
      limit,
    };
    this.dispatchEvent(new CustomEvent("honua-catalog-query-change", { detail: query, bubbles: true, composed: true }));
    void this.read(
      generation,
      (client, signal) => client.listCatalog(query, { signal }),
      (page) => this.renderPage(page, query, generation),
    );
  }

  protected override recover(): void {
    this.renderForm();
    super.recover();
  }

  private renderForm(): void {
    const document = this.ownerDocument;
    const form = node(document, "form");
    form.setAttribute("role", "search");
    const label = node(document, "label", this.getAttribute("label") || "Search catalog");
    const input = node(document, "input");
    input.type = "search";
    input.name = "q";
    input.dataset.focus = "search";
    input.value = this.searchText;
    label.append(input);
    const submit = node(document, "button", "Search");
    submit.type = "submit";
    submit.dataset.focus = "submit";
    form.append(label, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.searchText = input.value.trim();
      this.offset = 0;
      this.refresh();
      this.content.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    });
    this.content.append(form);
  }

  private renderPage(page: CatalogSearchProjection, query: CatalogSearchQuery, generation: number): void {
    if (page.items.some((item) => !visibleCard(item))) {
      this.state("unavailable", "Catalog results are unavailable. Try another search.");
      return;
    }
    if (page.items.length === 0 && this.offset > 0) {
      const offset = Math.max(0, Math.floor((page.total - 1) / (query.limit ?? 12)) * (query.limit ?? 12));
      if (offset === this.offset) {
        this.state("unavailable", "This catalog page is unavailable. Search again to refresh the results.");
        return;
      }
      this.offset = offset;
      this.refresh();
      return;
    }
    this.renderFilters(page);
    const list = node(this.ownerDocument, "ul");
    list.className = "catalog-results";
    for (const item of page.items) {
      const row = node(this.ownerDocument, "li");
      row.append(renderCard(this.ownerDocument, item));
      list.append(row);
    }
    this.content.append(list);
    this.renderPaging(page, query.limit ?? 12);
    this.restoreControlFocus(this.focusKey);
    if (!this.isCurrent(generation)) return;
    this.structuredData(page.structuredData);
    if (!this.isCurrent(generation)) return;
    this.state(page.total === 0 ? "empty" : "ready", page.total === 0 ? "No matching items." : `${page.total} items`);
  }

  private renderFilters(page: CatalogSearchProjection): void {
    const document = this.ownerDocument;
    const filters = node(document, "details");
    filters.className = "catalog-filters";
    filters.open = this.filtersOpen;
    filters.addEventListener("toggle", () => {
      this.filtersOpen = filters.open;
    });
    filters.append(node(document, "summary", "Filters"));
    const label = node(document, "label", "Kind");
    const select = node(document, "select");
    select.dataset.focus = "kind";
    const all = node(document, "option", "All kinds");
    all.value = "";
    select.append(all);
    for (const facet of page.facets.kind ?? []) {
      if (!kinds.includes(facet.value)) continue;
      const option = node(document, "option", `${facet.label} (${facet.count})`);
      option.value = facet.value;
      select.append(option);
    }
    select.value = this.selectedKind || this.getAttribute("kind") || "";
    select.disabled = this.hasAttribute("kind");
    select.addEventListener("change", () => {
      this.selectedKind = select.value;
      this.offset = 0;
      this.refresh();
    });
    label.append(select);
    filters.append(label);
    const sortLabel = node(document, "label", "Sort by");
    const sort = node(document, "select");
    sort.dataset.focus = "sort";
    for (const [value, title] of [
      ["title", "Title"],
      ["-updated", "Recently updated"],
    ]) {
      const option = node(document, "option", title);
      option.value = value;
      sort.append(option);
    }
    sort.value = this.sort;
    sort.addEventListener("change", () => {
      this.sort = sort.value as "title" | "-updated";
      this.offset = 0;
      this.refresh();
    });
    sortLabel.append(sort);
    filters.append(sortLabel);
    this.content.append(filters);
  }

  private renderPaging(page: CatalogSearchProjection, limit: number): void {
    this.content.append(
      renderCatalogPaging(
        this.ownerDocument,
        { offset: this.offset, total: page.total, limit, label: "Catalog pages" },
        (offset) => {
          this.offset = offset;
          this.refresh();
        },
      ),
    );
  }
}
