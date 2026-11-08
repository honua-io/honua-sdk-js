import { node, renderCatalogPaging } from "./dom.js";
import type { CatalogComponentClient, CatalogStructuredData } from "./presentation.js";
import { contributeCatalogStructuredData } from "./structured-data.js";

const ElementBase = globalThis.HTMLElement ?? (class {} as typeof HTMLElement);
const stylesheet = new URL("./catalog.css", import.meta.url).href;

export abstract class CatalogElement extends ElementBase {
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

  protected focusedControl(): string | undefined {
    return (this.shadowRoot?.activeElement as HTMLElement | null)?.dataset.focus;
  }

  protected restoreControlFocus(key?: string): void {
    const active = this.ownerDocument.activeElement;
    if (!key || this.shadowRoot?.activeElement || (active !== this && active !== this.ownerDocument.body)) return;
    const target = [...this.content.querySelectorAll<HTMLElement>("[data-focus]")].find(
      (element) => element.dataset.focus === key,
    );
    if (!target?.hasAttribute("disabled")) target?.focus();
    else
      (
        this.content.querySelector<HTMLElement>('input[type="search"]') ??
        this.content.querySelector<HTMLElement>("button:not(:disabled)") ??
        this.content.querySelector<HTMLElement>("a")
      )?.focus();
  }

  abstract refresh(): void;
}

export abstract class PagedCatalogElement extends CatalogElement {
  protected offset = 0;
  protected focusKey?: string;
  private recovering = false;

  override refresh(): void {
    this.recovering = false;
    this.loadPage();
  }

  protected abstract loadPage(): void;

  protected recoverShrunkPage(total: number, limit: number): void {
    if (this.recovering || total > this.offset) {
      this.focusKey = undefined;
      this.state("unavailable", "This catalog page is unavailable. Refresh to try again.");
      return;
    }
    this.offset = Math.max(0, Math.floor((total - 1) / limit) * limit);
    this.recovering = true;
    this.loadPage();
  }

  protected beginPageRead(): number {
    this.focusKey = this.focusedControl() ?? this.focusKey;
    return this.clear();
  }

  protected restorePageFocus(): void {
    this.restoreControlFocus(this.focusKey);
    this.focusKey = undefined;
  }

  protected renderPaging(total: number, limit: number, label: string): void {
    this.content.append(
      renderCatalogPaging(this.ownerDocument, { offset: this.offset, total, limit, label }, (offset) => {
        this.offset = offset;
        this.refresh();
      }),
    );
  }
}
