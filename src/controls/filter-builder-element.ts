import type { Query } from "../contract/types.js";
import type { FilterRegistry } from "../filter-registry/index.js";
import { HTMLElementBase, globalDom, renderShadowRoot } from "./element-utils.js";
import {
  FILTER_BUILDER_CSS,
  FILTER_BUILDER_NO_FILTER_TEXT,
  filterBuilderMarkup,
  readFilterBuilderDraft,
} from "./filter-builder-view.js";
import { FILTER_BUILDER_MAX_ROWS, applyFilterBuilder, compileFilterBuilder } from "./filter-builder.js";
import type { HonuaFilterBuilderDraft, HonuaFilterBuilderProjection } from "./filter-builder.js";

const INITIAL_STATUS = "Apply filters to update matching rows.";

export type HonuaFilterBuilderCount = (query: Query, signal: AbortSignal) => Promise<number>;

function cloneDraft(draft: HonuaFilterBuilderDraft): HonuaFilterBuilderDraft {
  return structuredClone(draft);
}

/** Native filter editor; emits builder-only queries and optionally owns clauses in a shared registry. */
export class HonuaFilterBuilderElement extends HTMLElementBase {
  #draft?: HonuaFilterBuilderDraft;
  #registry?: FilterRegistry;
  #count?: HonuaFilterBuilderCount;
  #abort?: AbortController;
  #status = INITIAL_STATUS;
  #cql2 = "";

  public constructor() {
    super();
    if (typeof this.attachShadow === "function") this.attachShadow({ mode: "open" });
  }
  public get draft(): HonuaFilterBuilderDraft | undefined {
    return this.#draft && cloneDraft(this.#draft);
  }
  public set draft(value: HonuaFilterBuilderDraft | undefined) {
    this.#invalidateCount();
    if (this.#draft?.ownerId !== value?.ownerId || this.#draft?.sourceId !== value?.sourceId) this.#releaseApplied();
    this.#draft = value && cloneDraft(value);
    this.#status = "Draft changed. Apply filters to update matching rows.";
    this.render();
  }
  public get registry(): FilterRegistry | undefined {
    return this.#registry;
  }
  public set registry(value: FilterRegistry | undefined) {
    if (this.#registry === value) return;
    this.#invalidateCount();
    this.#releaseApplied();
    this.#registry = value;
    this.#refreshStatus();
  }
  public get countRows(): HonuaFilterBuilderCount | undefined {
    return this.#count;
  }
  public set countRows(value: HonuaFilterBuilderCount | undefined) {
    this.#invalidateCount();
    this.#count = value;
  }
  public get countStatus(): string {
    return this.#status;
  }
  public connectedCallback(): void {
    this.render();
  }
  public disconnectedCallback(): void {
    this.#invalidateCount();
    this.#releaseApplied();
  }

  /** Validates atomically before updating the registry, then counts this exact query. */
  public async apply(): Promise<HonuaFilterBuilderProjection> {
    if (!this.#draft) throw new Error("Choose a source before applying filters.");
    this.#invalidateCount();
    const projection = this.#registry
      ? applyFilterBuilder(this.#registry, this.#draft)
      : compileFilterBuilder(this.#draft);
    this.#cql2 = projection.cql2;
    this.#status = this.#count ? "Counting matching rows…" : "Filters applied. Matching count not requested.";
    const task = this.#count
      ? { countRows: this.#count, query: projection.query, abort: new AbortController() }
      : undefined;
    this.#abort = task?.abort;
    this.#refreshStatus();
    if (globalDom.CustomEvent && typeof this.dispatchEvent === "function")
      this.dispatchEvent(
        new globalDom.CustomEvent("honua-filter-change", { detail: projection, bubbles: true, composed: true }),
      );
    if (task && !task.abort.signal.aborted) await this.#updateCount(task);
    return projection;
  }
  public render(): void {
    if (!this.shadowRoot) return;
    if (!this.#draft) {
      renderShadowRoot(this.shadowRoot, FILTER_BUILDER_CSS, '<p role="status">Choose a source to build filters.</p>');
      return;
    }
    renderShadowRoot(this.shadowRoot, FILTER_BUILDER_CSS, filterBuilderMarkup(this.#draft, this.#status, this.#cql2));
    this.shadowRoot.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#capture();
      void this.apply().catch(() => this.#showError());
    });
    this.shadowRoot.querySelector("[data-add]")?.addEventListener("click", () => this.#addRow());
    for (const button of this.shadowRoot.querySelectorAll<HTMLButtonElement>("[data-remove]"))
      button.addEventListener("click", () => this.#removeRow(Number(button.dataset.remove)));
  }
  #capture(): void {
    if (this.shadowRoot && this.#draft) this.#draft = readFilterBuilderDraft(this.shadowRoot, this.#draft);
  }
  #addRow(): void {
    this.#capture();
    if (!this.#draft || !this.#draft.fields[0] || this.#draft.rows.length >= FILTER_BUILDER_MAX_ROWS) return;
    this.#draft = {
      ...this.#draft,
      rows: [...this.#draft.rows, { field: this.#draft.fields[0].name, operator: "eq", value: "" }],
    };
    this.render();
    this.shadowRoot
      ?.querySelectorAll<HTMLSelectElement>("[data-field]")
      .item(this.#draft.rows.length - 1)
      ?.focus();
  }
  #removeRow(index: number): void {
    this.#capture();
    if (!this.#draft) return;
    this.#draft = { ...this.#draft, rows: this.#draft.rows.filter((_, rowIndex) => rowIndex !== index) };
    this.render();
    this.shadowRoot?.querySelector<HTMLButtonElement>("[data-add]")?.focus();
  }
  async #updateCount(task: {
    query: Query;
    countRows: HonuaFilterBuilderCount;
    abort: AbortController;
  }): Promise<void> {
    const { query, countRows, abort } = task;
    try {
      const count = await countRows(query, abort.signal);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid matching count.");
      if (!abort.signal.aborted) this.#status = `${count} matching ${count === 1 ? "row" : "rows"}`;
    } catch {
      if (!abort.signal.aborted) this.#status = "Matching count unavailable.";
    }
    if (!abort.signal.aborted) this.#refreshStatus();
  }
  #refreshStatus(): void {
    const output = this.shadowRoot?.querySelector("output");
    if (output) output.textContent = this.#status;
    const cql2 = this.shadowRoot?.querySelector("pre");
    if (cql2) cql2.textContent = this.#cql2 || FILTER_BUILDER_NO_FILTER_TEXT;
  }
  #invalidateCount(): void {
    this.#abort?.abort();
    this.#abort = undefined;
  }
  #releaseApplied(): void {
    if (this.#draft) this.#registry?.clearOwner({ kind: "control", id: this.#draft.ownerId });
    this.#cql2 = "";
    this.#status = INITIAL_STATUS;
  }
  #showError(): void {
    this.#status = "Filters were not applied. Check field values, extent bounds and timestamps with timezones.";
    this.#refreshStatus();
  }
}

/** Opt-in registration; importing without a browser is safe. */
export function defineHonuaFilterBuilder(registry = globalDom.customElements): void {
  if (registry && !registry.get("honua-filter-builder"))
    registry.define("honua-filter-builder", HonuaFilterBuilderElement);
}
