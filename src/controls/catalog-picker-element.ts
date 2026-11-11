import type { HonuaCatalogPicker, HonuaCatalogPickerState, HonuaCatalogSelection } from "./catalog-picker.js";
import { HTMLElementBase, escapeHtml, globalDom, renderShadowRoot } from "./element-utils.js";

const STATUS: Record<HonuaCatalogPickerState["status"], string> = {
  idle: "Search the catalog to choose a dataset.",
  loading: "Searching catalog…",
  ready: "Choose a dataset from the results.",
  empty: "No datasets found. Try another search.",
  selecting: "Opening dataset…",
  selected: "Dataset selected.",
  unsupported: "This dataset cannot be opened in this workspace. Choose another result.",
  error: "The catalog request failed. Try again.",
};

const CSS = `:host{display:block;font:inherit;color:inherit;max-inline-size:100%;}
*{box-sizing:border-box}form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:end}
label{display:grid;gap:.25rem;flex:1;min-inline-size:min(12rem,100%)}
input,button{font:inherit;color:inherit;min-block-size:2.75rem}input{inline-size:100%;min-inline-size:0}
button{cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid currentColor;outline-offset:2px}
ul{list-style:none;padding:0;display:grid;gap:.5rem}li button{inline-size:100%;text-align:start;padding:.5rem;overflow-wrap:anywhere}
small{display:block;margin-block-start:.25rem}p{overflow-wrap:anywhere}`;

/** Native search form and result buttons. The caller owns and disposes `.picker`. */
export class HonuaCatalogPickerElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  #picker: HonuaCatalogPicker | undefined;
  #unsubscribe: (() => void) | undefined;
  #connected = false;
  #query = "";
  #selection: HonuaCatalogSelection | undefined;

  public get picker(): HonuaCatalogPicker | undefined {
    return this.#picker;
  }
  public set picker(value: HonuaCatalogPicker | undefined) {
    if (value === this.#picker) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#picker = value;
    this.#selection = value?.state.selection;
    this.#subscribe();
    this.render();
  }

  public connectedCallback(): void {
    this.#connected = true;
    if (!this.shadowRoot && typeof this.attachShadow === "function") this.attachShadow({ mode: "open" });
    this.#subscribe();
    this.render();
  }

  public disconnectedCallback(): void {
    this.#connected = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #subscribe(): void {
    if (!this.#connected || !this.#picker || this.#unsubscribe) return;
    this.#unsubscribe = this.#picker.subscribe((state) => {
      this.render();
      if (state.selection && state.selection !== this.#selection) {
        this.#selection = state.selection;
        const Event = globalDom.CustomEvent;
        if (Event && typeof this.dispatchEvent === "function") {
          this.dispatchEvent(
            new Event<HonuaCatalogSelection>("honua-catalog-select", {
              detail: state.selection,
              bubbles: true,
              composed: true,
            }),
          );
        }
      }
    });
  }

  public render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const active = root.activeElement as HTMLElement | null;
    const focus = active?.getAttribute("data-focus");
    const editing = focus === "query" ? (active as HTMLInputElement) : undefined;
    const caret = editing
      ? ([editing.selectionStart, editing.selectionEnd, editing.selectionDirection] as const)
      : undefined;
    const state = this.#picker?.state;
    const busy = state?.status === "loading" || state?.status === "selecting";
    const results =
      state?.records
        .map((record, index) => {
          const title =
            typeof record.properties?.title === "string"
              ? record.properties.title
              : String(record.id ?? `Dataset ${index + 1}`);
          const description = typeof record.properties?.description === "string" ? record.properties.description : "";
          return `<li><button type="button" data-result="${index}" data-focus="result-${index}">${escapeHtml(title)}${description ? `<small>${escapeHtml(description)}</small>` : ""}</button></li>`;
        })
        .join("") ?? "";
    renderShadowRoot(
      root,
      CSS,
      `<section part="root" aria-label="${escapeHtml(this.getAttribute?.("label") ?? "Catalog picker")}" aria-busy="${busy}">
      <form part="search"><label for="catalog-query">Search datasets<input id="catalog-query" data-focus="query" type="search" maxlength="256" value="${escapeHtml(this.#query)}" ${this.#picker ? "" : "disabled"}></label>
      <button type="submit" data-focus="search" ${this.#picker ? "" : "disabled"}>Search</button></form>
      <p part="status" role="status" aria-live="polite">${state ? STATUS[state.status] : "Connect a catalog to search datasets."}</p>
      <ul part="results" aria-label="Catalog results">${results}</ul></section>`,
    );
    const input = root.querySelector<HTMLInputElement>("input");
    input?.addEventListener("input", () => {
      this.#query = input.value;
    });
    root.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input) this.#query = input.value;
      void this.#picker?.search(this.#query).catch(() => {
        /* Native maxlength bounds user input. */
      });
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-result]")) {
      button.addEventListener("click", () => {
        void this.#picker?.select(Number(button.dataset.result)).catch(() => {});
      });
    }
    // State changes replace the markup; restore the native keyboard position.
    if (focus) root.querySelector<HTMLElement>(`[data-focus="${focus}"]`)?.focus();
    if (caret && caret[0] !== null && caret[1] !== null)
      input?.setSelectionRange(caret[0], caret[1], caret[2] ?? undefined);
  }
}

export function defineHonuaCatalogPicker(registry: CustomElementRegistry | undefined = globalDom.customElements): void {
  if (registry && !registry.get("honua-catalog-picker"))
    registry.define("honua-catalog-picker", HonuaCatalogPickerElement);
}
