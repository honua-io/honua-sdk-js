/**
 * `<honua-legend>` — framework-free custom element rendering swatch+label
 * rows from the same definitions the map uses (issue #274), so the map and
 * its legend cannot drift apart.
 *
 * ## Input modes
 * - **Explicit entries** — assign the `entries` property a flat
 *   {@link HonuaLegendEntry} array (rendered as one untitled section) and/or
 *   {@link HonuaLegendSection} groups with optional titles.
 * - **Derive mode** (the headline) — set the `layer` attribute to a style
 *   layer id; the element parses the layer's categorical color paint
 *   expression into entries via {@link deriveLegendEntries}. See
 *   `legend-derive.ts` for the supported expression shapes (literal color,
 *   `match` on a `["get", <attr>]` input, simple-equality `case`, numeric
 *   `step`); anything else fails gracefully — the element keeps rendering
 *   its explicit sections and exposes the failure on `deriveError`.
 *   Both modes compose: explicit sections render first, then the derived
 *   section.
 *
 * ## Wiring
 * - `element.map = map` (any MapLibre `Map`) or `element.connect(map)`;
 * - declaratively via `for="<honua-map id>"` — same idiom as
 *   `<honua-basemap-switcher>` (resolves `.map` from the referenced element
 *   and listens for `honua-map-ready`).
 *
 * ## Reactivity
 * - `refresh()` re-derives and re-renders on demand;
 * - with the `auto-refresh` attribute, the element subscribes to the map's
 *   `styledata` event while connected and refreshes automatically (style
 *   edits, layers added later, visibility toggles).
 *
 * ## Attributes
 * - `for` — id of the map-providing element.
 * - `layer` — style layer id to derive entries from.
 * - `layer-title` — optional title rendered above the derived section.
 * - `heading` — optional heading rendered above the whole legend.
 * - `follow-layer-visibility` — boolean; hide a section while its source
 *   layer's `visibility` layout property is `"none"` (sections carry the
 *   derived `layer` id or their own `layer` field).
 * - `auto-refresh` — boolean; see Reactivity.
 *
 * ## CSS parts
 * `root`, `heading`, `section`, `section-title`, `row`, `swatch`, `label`.
 * Structural CSS only — theme via `::part()`.
 *
 * ## Accessibility
 * Rows are real list items (`<ul>`/`<li>`); swatches are `aria-hidden`
 * presentation, with the text labels carrying the meaning.
 *
 * Note: the `web-components` entry also registers a (controller-driven)
 * `honua-legend` element, and is that tag's canonical/default registrant
 * (see `./catalog.js`) — importing `@honua/sdk-js/controls` alone or
 * alongside `@honua/sdk-js/web-components`, in either order, never registers
 * this implementation automatically. Call {@link defineHonuaLegend} (or
 * `registerComponent("controls.legend")` from `./registry.js`) explicitly,
 * before anything else claims the tag, to use this map-style-derived element
 * instead.
 */

import {
  HTMLElementBase,
  escapeAttribute,
  escapeHtml,
  globalDom,
  listenForHonuaMapReady,
  resolveHonuaMapFromContext,
} from "./element-utils.js";
import { HonuaLegendDeriveError, deriveLegendEntries } from "./legend-derive.js";
import type { HonuaLegendEntry, HonuaLegendMap, HonuaLegendSection, HonuaLegendSwatchShape } from "./types.js";

/**
 * Custom element implementing the legend. Registered as `honua-legend` by
 * {@link defineHonuaLegend} (opt-in; not part of the blanket
 * {@link defineHonuaControls} auto-registration — see that function's doc for
 * why).
 */
export class HonuaLegendElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["for", "layer", "layer-title", "heading", "follow-layer-visibility", "auto-refresh"];
  }

  #map: HonuaLegendMap | undefined;
  #explicitSections: readonly HonuaLegendSection[] = [];
  #derivedEntries: readonly HonuaLegendEntry[] | undefined;
  #deriveError: string | undefined;
  #connected = false;
  #disposeMapReadyListener: (() => void) | undefined;
  #styledataListener: (() => void) | undefined;

  /** The MapLibre map this legend reads from (derive mode and visibility coupling). */
  public get map(): HonuaLegendMap | undefined {
    return this.#map;
  }

  public set map(map: HonuaLegendMap | undefined) {
    if (this.#map === map) return;
    this.#unsubscribeStyledata();
    this.#map = map;
    this.refresh();
    this.#subscribeStyledata();
  }

  /** Wires the legend to a MapLibre map. Equivalent to setting `.map`. */
  public connect(map: HonuaLegendMap): void {
    this.map = map;
  }

  /**
   * Explicit legend content. Accepts a flat {@link HonuaLegendEntry} array
   * (one untitled section), {@link HonuaLegendSection} groups, or a mix;
   * the getter returns the normalized sections. Invalid items are dropped.
   */
  public get entries(): readonly HonuaLegendSection[] {
    return this.#explicitSections;
  }

  public set entries(value: readonly (HonuaLegendEntry | HonuaLegendSection)[]) {
    this.#explicitSections = normalizeSections(value);
    this.render();
  }

  /** Style layer id used by derive mode. Reflects the `layer` attribute. */
  public get layer(): string | undefined {
    return this.#attr("layer") ?? undefined;
  }

  public set layer(value: string | undefined) {
    if (typeof this.setAttribute !== "function") return;
    if (value === undefined) this.removeAttribute?.("layer");
    else this.setAttribute("layer", value);
  }

  /** Hide sections whose source layer is hidden. Reflects `follow-layer-visibility`. */
  public get followLayerVisibility(): boolean {
    return this.#hasAttr("follow-layer-visibility");
  }

  public set followLayerVisibility(value: boolean) {
    this.#setBooleanAttr("follow-layer-visibility", value);
  }

  /** Refresh automatically on the map's `styledata` event. Reflects `auto-refresh`. */
  public get autoRefresh(): boolean {
    return this.#hasAttr("auto-refresh");
  }

  public set autoRefresh(value: boolean) {
    this.#setBooleanAttr("auto-refresh", value);
  }

  /**
   * Why the last derive attempt failed (message of the underlying
   * {@link HonuaLegendDeriveError}), or `undefined` while derive mode is
   * succeeding or inactive.
   */
  public get deriveError(): string | undefined {
    return this.#deriveError;
  }

  /**
   * The sections the legend renders: explicit sections followed by the
   * derived section (when derive mode is active and succeeded).
   */
  public get sections(): readonly HonuaLegendSection[] {
    const layerId = this.layer;
    if (!this.#derivedEntries || !layerId) return this.#explicitSections;
    const title = this.#attr("layer-title");
    return [
      ...this.#explicitSections,
      { ...(title !== null ? { title } : {}), layer: layerId, entries: this.#derivedEntries },
    ];
  }

  /** Re-derives entries from the map (when in derive mode) and re-renders. */
  public refresh(): void {
    this.#derive();
    this.render();
  }

  public attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "for") {
      this.#resolveMapFromContext();
      return;
    }
    if (name === "layer" || name === "layer-title") {
      this.refresh();
      return;
    }
    if (name === "auto-refresh") {
      if (newValue === null) this.#unsubscribeStyledata();
      else this.#subscribeStyledata();
      return;
    }
    // "heading" / "follow-layer-visibility" only change the rendering.
    this.render();
  }

  public connectedCallback(): void {
    this.#connected = true;
    this.#ensureShadowRoot();
    this.#listenForMapReady();
    this.#resolveMapFromContext();
    this.#subscribeStyledata();
    this.refresh();
  }

  public disconnectedCallback(): void {
    this.#connected = false;
    this.#disposeMapReadyListener?.();
    this.#disposeMapReadyListener = undefined;
    this.#unsubscribeStyledata();
  }

  // ── derive mode ────────────────────────────────────────────

  #derive(): void {
    this.#derivedEntries = undefined;
    const layerId = this.layer;
    const map = this.#map;
    if (!layerId || !map) {
      this.#deriveError = undefined;
      return;
    }
    try {
      this.#derivedEntries = deriveLegendEntries(map, layerId);
      this.#deriveError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A missing layer is usually transient (style still loading), so it is
      // not warned about; real shape mismatches are warned once per message.
      const transient = error instanceof HonuaLegendDeriveError && error.code === "layer-not-found";
      if (!transient && message !== this.#deriveError && typeof console !== "undefined") {
        console.warn(`<honua-legend> could not derive entries: ${message}`);
      }
      this.#deriveError = message;
    }
  }

  // ── map wiring (matches the `for` + ready-event idiom) ──────

  #listenForMapReady(): void {
    if (this.#disposeMapReadyListener) return;
    this.#disposeMapReadyListener = listenForHonuaMapReady(this, (map) => {
      const forId = this.#attr("for");
      if (!forId && this.map) return;
      this.map = map as HonuaLegendMap;
    });
  }

  #resolveMapFromContext(): void {
    if (this.map) return;
    const map = resolveHonuaMapFromContext(this);
    if (map) this.map = map as HonuaLegendMap;
  }

  #subscribeStyledata(): void {
    if (this.#styledataListener || !this.#connected || !this.autoRefresh) return;
    const map = this.#map;
    if (!map || typeof map.on !== "function") return;
    const listener = () => this.refresh();
    map.on("styledata", listener);
    this.#styledataListener = listener;
  }

  #unsubscribeStyledata(): void {
    const listener = this.#styledataListener;
    if (!listener) return;
    this.#styledataListener = undefined;
    this.#map?.off?.("styledata", listener);
  }

  // ── rendering ──────────────────────────────────────────────

  #ensureShadowRoot(): void {
    if (!this.shadowRoot && typeof this.attachShadow === "function") {
      this.attachShadow({ mode: "open" });
    }
  }

  protected render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const heading = this.#attr("heading");
    root.innerHTML = `
      <style>${structuralStyles()}</style>
      <div part="root" class="root">
        ${heading ? `<p part="heading" class="heading">${escapeHtml(heading)}</p>` : ""}
        ${this.sections.map((section) => this.#renderSection(section)).join("")}
      </div>
    `;
  }

  #renderSection(section: HonuaLegendSection): string {
    const hidden = this.#sectionHidden(section);
    return `
      <section part="section" class="section"${hidden ? " hidden" : ""}${
        section.layer ? ` data-layer="${escapeAttribute(section.layer)}"` : ""
      }>
        ${section.title ? `<p part="section-title" class="section-title">${escapeHtml(section.title)}</p>` : ""}
        <ul class="rows">
          ${section.entries.map((entry) => renderRow(entry)).join("")}
        </ul>
      </section>
    `;
  }

  #sectionHidden(section: HonuaLegendSection): boolean {
    if (!this.followLayerVisibility || !section.layer) return false;
    return this.#map?.getLayoutProperty?.(section.layer, "visibility") === "none";
  }

  // ── attribute helpers (safe under Node test stubs) ──────────

  #attr(name: string): string | null {
    return typeof this.getAttribute === "function" ? this.getAttribute(name) : null;
  }

  #hasAttr(name: string): boolean {
    if (typeof this.hasAttribute === "function") return this.hasAttribute(name);
    return this.#attr(name) !== null;
  }

  #setBooleanAttr(name: string, value: boolean): void {
    if (typeof this.setAttribute !== "function") return;
    if (value) this.setAttribute(name, "");
    else this.removeAttribute?.(name);
  }
}

/**
 * Registers the legend custom element (`honua-legend`) with the
 * map-style-derived, framework-free implementation. Skips the registration
 * when the tag is already defined.
 *
 * Like {@link defineHonuaLayerList}, this is **opt-in** and is NOT run by the
 * blanket `defineHonuaControls()` / module-load auto-registration — the
 * `web-components` entry ships its own (controller-driven) `honua-legend`
 * and is that tag's canonical/default registrant, so a caller who wants this
 * implementation instead claims the tag explicitly:
 *
 * ```ts
 * import { defineHonuaLegend } from "@honua/sdk-js/controls";
 * defineHonuaLegend();
 * ```
 */
export function defineHonuaLegend(registry = globalDom.customElements): void {
  if (!registry) return;
  if (!registry.get("honua-legend")) {
    registry.define("honua-legend", HonuaLegendElement);
  }
}

function normalizeSections(value: readonly (HonuaLegendEntry | HonuaLegendSection)[]): HonuaLegendSection[] {
  const sections: HonuaLegendSection[] = [];
  let loose: HonuaLegendEntry[] = [];
  const flushLoose = (): void => {
    if (loose.length > 0) sections.push({ entries: loose });
    loose = [];
  };
  for (const item of value ?? []) {
    if (isSection(item)) {
      flushLoose();
      const entries = item.entries.filter(isEntry).map(normalizeEntry);
      sections.push({
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.layer === "string" ? { layer: item.layer } : {}),
        entries,
      });
    } else if (isEntry(item)) {
      loose.push(normalizeEntry(item));
    }
  }
  flushLoose();
  return sections;
}

function isSection(item: unknown): item is HonuaLegendSection {
  return typeof item === "object" && item !== null && Array.isArray((item as HonuaLegendSection).entries);
}

function isEntry(item: unknown): item is HonuaLegendEntry {
  if (typeof item !== "object" || item === null) return false;
  const entry = item as HonuaLegendEntry;
  if (typeof entry.label !== "string") return false;
  if (typeof entry.color === "string") return true;
  return (
    typeof entry.color === "object" &&
    entry.color !== null &&
    (entry.color.fill === undefined || typeof entry.color.fill === "string") &&
    (entry.color.outline === undefined || typeof entry.color.outline === "string")
  );
}

function normalizeEntry(entry: HonuaLegendEntry): HonuaLegendEntry {
  const shape = isSwatchShape(entry.shape) ? entry.shape : "fill";
  return { label: entry.label, color: entry.color, shape };
}

function isSwatchShape(value: unknown): value is HonuaLegendSwatchShape {
  return value === "fill" || value === "line" || value === "circle";
}

function renderRow(entry: HonuaLegendEntry): string {
  const fill = typeof entry.color === "string" ? entry.color : entry.color.fill;
  const outline = typeof entry.color === "object" && entry.color !== null ? entry.color.outline : undefined;
  const shape = entry.shape ?? "fill";
  const swatchStyle = [
    ...(fill !== undefined ? [`--legend-fill:${fill}`] : []),
    ...(outline !== undefined ? [`--legend-outline:${outline}`] : []),
  ].join(";");
  return `
    <li part="row" class="row">
      <span part="swatch" class="swatch swatch-${shape}" aria-hidden="true"${
        swatchStyle ? ` style="${escapeAttribute(swatchStyle)}"` : ""
      }></span>
      <span part="label" class="label">${escapeHtml(entry.label)}</span>
    </li>
  `;
}

/** Structural-only styles; theme via `::part(root)`, `::part(row)`, `::part(swatch)`, ... */
function structuralStyles(): string {
  return `
    :host {
      display: block;
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
    }
    .root, .section, .rows {
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
    }
    .heading, .section-title { margin: 0; }
    .section { margin: 0; }
    .rows { list-style: none; margin: 0; padding: 0; }
    .row {
      display: flex;
      align-items: center;
      gap: 0.5em;
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .heading, .section-title, .label {
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .swatch {
      flex: none;
      inline-size: 1em;
      block-size: 1em;
      box-sizing: border-box;
      background: var(--legend-fill, transparent);
      border: 1px solid var(--legend-outline, transparent);
    }
    .swatch-line { block-size: 3px; border: none; }
    .swatch-circle { border-radius: 50%; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .row { color: CanvasText; }
      .swatch {
        background: CanvasText;
        border: 1px solid CanvasText;
        forced-color-adjust: none;
      }
      .swatch-line { background: CanvasText; border: none; }
    }
  `;
}
