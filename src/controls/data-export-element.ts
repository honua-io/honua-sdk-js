import type { CanonicalFeature } from "../contract/types.js";
import { serializeHonuaDataExport } from "./data-export.js";
import type { HonuaDataExportArtifact, HonuaDataExportFormat } from "./data-export.js";
import { HTMLElementBase, globalDom, renderShadowRoot } from "./element-utils.js";

/**
 * Downloads only the filtered rows supplied by the host application. Set
 * `fields` to an explicit public-property allowlist, and update `rows` whenever
 * the shared filter registry changes. No network request or client is owned.
 *
 * Native buttons support keyboard activation. Theme with the root, button,
 * and status CSS parts. Events: `honua-data-export` (the safe artifact) and
 * `honua-data-export-error` (a fixed message, never source values).
 */
export class HonuaDataExportElement extends HTMLElementBase {
  #rows: readonly CanonicalFeature[] = [];
  #fields: readonly string[] = [];
  #maxRows = 10_000;
  #busy = false;

  public constructor() {
    super();
    if (typeof this.attachShadow === "function") this.attachShadow({ mode: "open" });
  }
  public get rows(): readonly CanonicalFeature[] {
    return this.#rows;
  }
  public set rows(value: readonly CanonicalFeature[]) {
    this.#rows = value;
    this.render();
  }
  public get fields(): readonly string[] {
    return this.#fields;
  }
  public set fields(value: readonly string[]) {
    this.#fields = [...value];
    this.render();
  }
  public get maxRows(): number {
    return this.#maxRows;
  }
  public set maxRows(value: number) {
    this.#maxRows = value;
    this.render();
  }
  public connectedCallback(): void {
    this.render();
  }

  /** Serializes the current snapshot; useful for a host-managed download. */
  public createArtifact(format: HonuaDataExportFormat): HonuaDataExportArtifact {
    return serializeHonuaDataExport({ rows: this.#rows, fields: this.#fields, format, maxRows: this.#maxRows });
  }
  public render(): void {
    if (!this.shadowRoot) return;
    renderShadowRoot(
      this.shadowRoot,
      `
      :host { display:block; min-width:0; max-width:100%; }
      .root { display:flex; flex-wrap:wrap; align-items:center; gap:0.5em; }
      button { font:inherit; min-height:2.75em; }
      .status { flex-basis:100%; overflow-wrap:anywhere; }
      button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
    `,
      `<div class="root" part="root" role="group" aria-label="Export filtered rows">
      <button part="button" type="button" data-format="csv" ${this.#busy || this.#rows.length === 0 ? "disabled" : ""}>Download CSV</button>
      <button part="button" type="button" data-format="geojson" ${this.#busy || this.#rows.length === 0 ? "disabled" : ""}>Download GeoJSON</button>
      <span class="status" part="status" role="status">${this.#rows.length === 0 ? "No rows to export. Adjust your filters." : `${this.#rows.length} filtered ${this.#rows.length === 1 ? "row" : "rows"}`}</span>
    </div>`,
    );
    for (const button of this.shadowRoot.querySelectorAll<HTMLButtonElement>("button[data-format]")) {
      button.addEventListener("click", () => this.#download(button.dataset.format as HonuaDataExportFormat));
    }
  }
  #download(format: HonuaDataExportFormat): void {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const artifact = this.createArtifact(format);
      const url = URL.createObjectURL(new Blob([artifact.text], { type: artifact.mimeType }));
      const anchor = this.ownerDocument.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      try {
        anchor.click();
      } finally {
        // Keep the URL alive through the browser's queued download task.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      this.#status(`Downloaded ${artifact.rowCount} filtered ${artifact.rowCount === 1 ? "row" : "rows"}.`);
      if (globalDom.CustomEvent)
        this.dispatchEvent(
          new globalDom.CustomEvent("honua-data-export", { detail: artifact, bubbles: true, composed: true }),
        );
    } catch {
      const message = "Export could not be created. Check the row limit, public fields and WGS84 geometry.";
      this.#status(message);
      if (globalDom.CustomEvent)
        this.dispatchEvent(
          new globalDom.CustomEvent("honua-data-export-error", { detail: { message }, bubbles: true, composed: true }),
        );
    } finally {
      this.#busy = false;
    }
  }
  #status(message: string): void {
    const status = this.shadowRoot?.querySelector('[role="status"]');
    if (status) status.textContent = message;
  }
}

/** Opt-in registration; safe to import without a browser. */
export function defineHonuaDataExport(registry = globalDom.customElements): void {
  if (registry && !registry.get("honua-data-export")) registry.define("honua-data-export", HonuaDataExportElement);
}
