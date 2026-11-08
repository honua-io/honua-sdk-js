import { node, renderCard, visibleCard } from "./dom.js";
import type {
  CatalogCardProjection,
  CatalogComponentClient,
  CatalogSearchProjection,
  CatalogSearchQuery,
  CatalogStructuredData,
} from "./presentation.js";
import { contributeCatalogStructuredData } from "./structured-data.js";

const ElementBase = globalThis.HTMLElement ?? (class {} as typeof HTMLElement);
const kinds = ["dataset", "layer", "service", "map", "app"];
const stylesheet = new URL("./catalog.css", import.meta.url).href;

abstract class CatalogElement extends ElementBase {
  private currentClient?: CatalogComponentClient;
  private generation = 0;
  private request?: AbortController;
  private clearStructuredData?: () => void;
  protected readonly content: HTMLElement;
  protected readonly status: HTMLElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const styles = node(this.ownerDocument, "link");
    styles.rel = "stylesheet";
    styles.href = stylesheet;
    this.content = node(this.ownerDocument, "div");
    this.status = node(this.ownerDocument, "p");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    root.append(styles, this.status, this.content);
  }

  get client(): CatalogComponentClient | undefined {
    return this.currentClient;
  }
  set client(client: CatalogComponentClient | undefined) {
    this.currentClient = client;
    this.refresh();
  }

  connectedCallback(): void {
    this.refresh();
  }
  disconnectedCallback(): void {
    this.clear();
  }
  attributeChangedCallback(): void {
    this.refresh();
  }

  protected clear(): number {
    const generation = ++this.generation;
    const request = this.request;
    this.request = undefined;
    const clearStructuredData = this.clearStructuredData;
    this.clearStructuredData = undefined;
    clearStructuredData?.();
    this.content.replaceChildren();
    this.status.textContent = "";
    if (clearStructuredData) this.structuredData();
    request?.abort();
    return generation;
  }

  protected isCurrent(generation: number): boolean {
    return generation === this.generation && this.isConnected;
  }

  protected state(state: string, message: string): void {
    this.status.textContent = message;
    this.dispatchEvent(
      new CustomEvent("honua-catalog-state-change", {
        detail: { state },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected async read<T>(
    generation: number,
    load: (client: CatalogComponentClient, signal: AbortSignal) => Promise<T>,
    render: (result: T) => void,
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const client = this.client;
    if (!client) {
      this.state("unsupported", "Catalog client is not configured.");
      return;
    }
    const request = new AbortController();
    this.request = request;
    this.state("loading", "Loading…");
    if (!this.isCurrent(generation) || request.signal.aborted) return;
    try {
      const result = await load(client, request.signal);
      if (this.isCurrent(generation) && !request.signal.aborted) render(result);
    } catch {
      if (this.isCurrent(generation) && !request.signal.aborted) {
        const failedGeneration = this.clear();
        if (!this.isCurrent(failedGeneration)) return;
        this.recover();
        this.state("unavailable", "Catalog content is unavailable. Try again or sign in on the catalog site.");
      }
    }
  }

  protected recover(): void {
    const retry = node(this.ownerDocument, "button", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => this.refresh());
    this.content.append(retry);
  }

  protected structuredData(projection?: CatalogStructuredData): void {
    if (projection) this.clearStructuredData = contributeCatalogStructuredData(this.ownerDocument, this, projection);
    this.dispatchEvent(
      new CustomEvent("honua-catalog-structured-data-change", {
        detail: projection ?? null,
        bubbles: true,
        composed: true,
      }),
    );
  }

  abstract refresh(): void;
}

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
    void this.read(
      generation,
      (client, signal) => client.getCatalogItem({ catalogId, kind, id }, { signal }),
      (item) => this.renderItem(item, kind, id, generation),
    );
  }

  private renderItem(item: CatalogCardProjection, kind: string, id: string, generation: number): void {
    if (!visibleCard(item) || item.kind !== kind || item.id !== id) {
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
    this.focusKey = (this.shadowRoot?.activeElement as HTMLElement | null)?.dataset.focus;
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
    this.restoreFocus();
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
    this.restoreFocus();
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
    const navigation = node(this.ownerDocument, "nav");
    navigation.setAttribute("aria-label", "Catalog pages");
    const previous = this.button("Previous", () => {
      this.offset = Math.max(0, this.offset - limit);
      this.refresh();
    });
    previous.dataset.page = "previous";
    previous.dataset.focus = "previous";
    previous.disabled = this.offset === 0;
    const next = this.button("Next", () => {
      this.offset += limit;
      this.refresh();
    });
    next.dataset.page = "next";
    next.dataset.focus = "next";
    next.disabled = this.offset + limit >= page.total;
    navigation.append(
      previous,
      node(
        this.ownerDocument,
        "span",
        page.total === 0
          ? "0 results"
          : `${this.offset + 1}–${Math.min(this.offset + limit, page.total)} of ${page.total}`,
      ),
      next,
    );
    this.content.append(navigation);
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = node(this.ownerDocument, "button", label);
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  }

  private restoreFocus(): void {
    const active = this.ownerDocument.activeElement;
    if (!this.focusKey || this.shadowRoot?.activeElement || (active !== this && active !== this.ownerDocument.body))
      return;
    const target = this.content.querySelector<HTMLElement>(`[data-focus="${this.focusKey}"]`);
    if (target instanceof HTMLButtonElement && target.disabled)
      this.content.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    else target?.focus();
  }
}
