/**
 * `<honua-layer-list>` — framework-free custom element rendering a checkbox
 * row per overlay so users can toggle MapLibre overlay layers on and off
 * (issue #280, closing umbrella #274).
 *
 * Each overlay groups one or more style layer ids; toggling a row writes each
 * layer's `visibility` layout property (`"visible"` / `"none"`) on the map.
 * The element never imports `maplibre-gl` or the SDK core — it drives any
 * MapLibre `Map` through the duck-typed {@link HonuaLayerListMap} interface,
 * keeping the `@honua/sdk-js/controls` entry independent of the core bundle.
 *
 * ## Input modes
 * - **Property** (preferred) — assign the `overlays` property a
 *   {@link HonuaLayerListOverlay} array.
 * - **Attribute** — set the `overlays` attribute to a JSON array of the same
 *   shape (matching how `<honua-basemap-switcher>` accepts `bases` JSON).
 *
 * ## Wiring
 * - `element.map = map` (any MapLibre `Map`) or `element.connect(map)`;
 * - declaratively via `for="<honua-map id>"` — same idiom as
 *   `<honua-basemap-switcher>` / `<honua-legend>` (resolves `.map` from the
 *   referenced element and listens for `honua-map-ready`).
 *
 * ## Reactivity
 * - With the `auto-refresh` attribute the element subscribes to the map's
 *   `styledata` event while connected and re-syncs each checkbox's checked
 *   state from the map's current `visibility` (external style edits,
 *   visibility toggled elsewhere, layers seeded later).
 *
 * ## Attributes
 * - `overlays` — JSON array of {@link HonuaLayerListOverlay} (the `overlays`
 *   property is preferred for non-trivial configs).
 * - `for` — id of the map-providing element, see Wiring.
 * - `label` — accessible name of the list (default "Layers").
 * - `auto-refresh` — boolean; see Reactivity.
 *
 * ## CSS parts
 * `root`, `row`, `checkbox`, `label`, and `badge` (the "not seeded" hint
 * shown on a disabled row whose style layers are all missing). Structural CSS
 * only — theme via `::part()`.
 *
 * ## Accessibility
 * Rows are real `<label>` + `<input type="checkbox">` pairs; an overlay whose
 * style layers are all missing renders disabled with a `badge` part/slot.
 */

import {
  HTMLElementBase,
  escapeAttribute,
  escapeHtml,
  globalDom,
  listenForHonuaMapReady,
  resolveHonuaMapFromContext,
} from "./element-utils.js";
import type { HonuaLayerListChangeDetail, HonuaLayerListMap, HonuaLayerListOverlay } from "./types.js";

/**
 * Custom element implementing the overlay layer list. Registered as
 * `honua-layer-list` by `defineHonuaControls` (which runs automatically on
 * import of the controls entry when a `customElements` registry exists).
 */
export class HonuaLayerListElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["overlays", "for", "label", "auto-refresh"];
  }

  #map: HonuaLayerListMap | undefined;
  #overlays: readonly HonuaLayerListOverlay[] = [];
  #connected = false;
  #disposeMapReadyListener: (() => void) | undefined;
  #styledataListener: (() => void) | undefined;

  /** The MapLibre map this list toggles overlay visibility on. */
  public get map(): HonuaLayerListMap | undefined {
    return this.#map;
  }

  public set map(map: HonuaLayerListMap | undefined) {
    if (this.#map === map) return;
    this.#unsubscribeStyledata();
    this.#map = map;
    this.#subscribeStyledata();
    this.render();
  }

  /** Wires the list to a MapLibre map. Equivalent to setting `.map`. */
  public connect(map: HonuaLayerListMap): void {
    this.map = map;
  }

  /** The registered overlay definitions. */
  public get overlays(): readonly HonuaLayerListOverlay[] {
    return this.#overlays;
  }

  public set overlays(overlays: readonly HonuaLayerListOverlay[]) {
    this.#overlays = normalizeOverlays(overlays);
    this.render();
  }

  /** Refresh automatically on the map's `styledata` event. Reflects `auto-refresh`. */
  public get autoRefresh(): boolean {
    return this.#hasAttr("auto-refresh");
  }

  public set autoRefresh(value: boolean) {
    if (typeof this.setAttribute !== "function") return;
    if (value) this.setAttribute("auto-refresh", "");
    else this.removeAttribute?.("auto-refresh");
  }

  /** Re-syncs checkbox state from the map and re-renders. */
  public refresh(): void {
    this.render();
  }

  /**
   * Shows or hides the overlay with the given id, writing each of its style
   * layers' `visibility`. Returns `true` when the overlay was found and at
   * least one of its layers exists on the map. Dispatches `change`.
   */
  public setVisible(overlayId: string, visible: boolean): boolean {
    const overlay = this.#overlays.find((candidate) => candidate.id === overlayId);
    if (!overlay) return false;
    const map = this.#map;
    if (!map) return false;
    let applied = false;
    for (const layerId of overlay.layers) {
      if (!this.#layerExists(layerId)) continue;
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      applied = true;
    }
    if (!applied) return false;
    this.#syncRow(overlayId);
    this.#dispatchChange({ id: overlayId, visible });
    return true;
  }

  public attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "overlays") {
      const parsed = parseOverlays(newValue);
      if (parsed) this.overlays = parsed;
      return;
    }
    if (name === "for") {
      this.#resolveMapFromContext();
      return;
    }
    if (name === "auto-refresh") {
      if (newValue === null) this.#unsubscribeStyledata();
      else this.#subscribeStyledata();
      return;
    }
    // "label" only changes the rendering.
    this.render();
  }

  public connectedCallback(): void {
    this.#connected = true;
    this.#ensureShadowRoot();
    this.#listenForMapReady();
    this.#resolveMapFromContext();
    this.#subscribeStyledata();
    this.render();
  }

  public disconnectedCallback(): void {
    this.#connected = false;
    this.#disposeMapReadyListener?.();
    this.#disposeMapReadyListener = undefined;
    this.#unsubscribeStyledata();
  }

  // ── map wiring (matches the `for` + ready-event idiom) ──────

  #listenForMapReady(): void {
    if (this.#disposeMapReadyListener) return;
    this.#disposeMapReadyListener = listenForHonuaMapReady(this, (map) => {
      const forId = this.#attr("for");
      if (!forId && this.map) return;
      this.map = map as HonuaLayerListMap;
    });
  }

  #resolveMapFromContext(): void {
    if (this.map) return;
    const map = resolveHonuaMapFromContext(this);
    if (map) this.map = map as HonuaLayerListMap;
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

  // ── overlay state ──────────────────────────────────────────

  /** Whether a style layer is present on the current map (drives not-seeded). */
  #layerExists(layerId: string): boolean {
    const map = this.#map;
    if (!map?.getLayer) return false;
    return map.getLayer(layerId) != null;
  }

  /** True when at least one of the overlay's style layers exists on the map. */
  #isSeeded(overlay: HonuaLayerListOverlay): boolean {
    return overlay.layers.some((layerId) => this.#layerExists(layerId));
  }

  /**
   * Whether an overlay reads as visible: visible unless every present layer's
   * `visibility` is `"none"`. Unseeded overlays read as unchecked.
   */
  #isVisible(overlay: HonuaLayerListOverlay): boolean {
    const map = this.#map;
    if (!map) return false;
    for (const layerId of overlay.layers) {
      if (!this.#layerExists(layerId)) continue;
      if (map.getLayoutProperty?.(layerId, "visibility") !== "none") return true;
    }
    return false;
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
    const label = this.#attr("label") ?? "Layers";
    root.innerHTML = `
      <style>${structuralStyles()}</style>
      <div part="root" class="root" role="group" aria-label="${escapeAttribute(label)}">
        ${this.#overlays.map((overlay) => this.#renderRow(overlay)).join("")}
      </div>
    `;
    this.#bindRows(root);
  }

  #renderRow(overlay: HonuaLayerListOverlay): string {
    const seeded = this.#isSeeded(overlay);
    const checked = seeded && this.#isVisible(overlay);
    const attribution = overlay.attribution
      ? `<span part="attribution" class="attribution">${escapeHtml(overlay.attribution)}</span>`
      : "";
    const badge = seeded ? "" : `<span part="badge" class="badge"><slot name="not-seeded">Not seeded</slot></span>`;
    return `
      <label part="row" class="row" data-overlay-id="${escapeAttribute(overlay.id)}"${seeded ? "" : " data-not-seeded"}>
        <input
          part="checkbox"
          class="checkbox"
          type="checkbox"
          ${checked ? "checked" : ""}
          ${seeded ? "" : "disabled"}
          data-overlay-id="${escapeAttribute(overlay.id)}"
        />
        <span part="label" class="label">${escapeHtml(overlay.label)}</span>
        ${attribution}
        ${badge}
      </label>
    `;
  }

  #bindRows(root: ShadowRoot): void {
    root.querySelectorAll<HTMLInputElement>("input[data-overlay-id]").forEach((input) => {
      input.addEventListener("change", () => {
        const overlayId = input.dataset.overlayId;
        if (overlayId) this.setVisible(overlayId, input.checked);
      });
    });
  }

  /** Re-syncs a single row's checked state in place (preserves focus). */
  #syncRow(overlayId: string): void {
    const root = this.shadowRoot;
    if (!root || typeof root.querySelector !== "function") return;
    const overlay = this.#overlays.find((candidate) => candidate.id === overlayId);
    if (!overlay) return;
    const input = root.querySelector<HTMLInputElement>(`input[data-overlay-id="${cssEscape(overlayId)}"]`);
    if (input) input.checked = this.#isSeeded(overlay) && this.#isVisible(overlay);
  }

  // ── attribute helpers (safe under Node test stubs) ──────────

  #attr(name: string): string | null {
    return typeof this.getAttribute === "function" ? this.getAttribute(name) : null;
  }

  #hasAttr(name: string): boolean {
    if (typeof this.hasAttribute === "function") return this.hasAttribute(name);
    return this.#attr(name) !== null;
  }

  #dispatchChange(detail: HonuaLayerListChangeDetail): void {
    if (!globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    this.dispatchEvent(new globalDom.CustomEvent("change", { bubbles: true, composed: true, detail }));
  }
}

/**
 * Registers the layer-list custom element (`honua-layer-list`). Skips the
 * registration when the tag is already defined.
 *
 * Unlike the other controls-kit elements, this is **opt-in** and is NOT run by
 * the blanket `defineHonuaControls()` / module-load auto-registration. The
 * `web-components` entry ships its own (controller-driven) `honua-layer-list`
 * under the same tag and is that tag's canonical/default registrant (see
 * `./catalog.js`), so callers who want the native, overlay-definition-driven
 * layer list register it explicitly:
 *
 * ```ts
 * import { defineHonuaLayerList } from "@honua/sdk-js/controls";
 * defineHonuaLayerList();
 * ```
 */
export function defineHonuaLayerList(registry = globalDom.customElements): void {
  if (!registry) return;
  if (!registry.get("honua-layer-list")) {
    registry.define("honua-layer-list", HonuaLayerListElement);
  }
}

function normalizeOverlays(value: readonly HonuaLayerListOverlay[]): HonuaLayerListOverlay[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HonuaLayerListOverlay[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<HonuaLayerListOverlay>;
    if (typeof candidate.id !== "string" || typeof candidate.label !== "string") return [];
    const layers = Array.isArray(candidate.layers)
      ? candidate.layers.filter((layer): layer is string => typeof layer === "string")
      : [];
    return [
      {
        id: candidate.id,
        label: candidate.label,
        layers,
        ...(typeof candidate.attribution === "string" ? { attribution: candidate.attribution } : {}),
      },
    ];
  });
}

function parseOverlays(value: string | null): readonly HonuaLayerListOverlay[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return normalizeOverlays(parsed as HonuaLayerListOverlay[]);
  } catch {
    return undefined;
  }
}

/** Minimal CSS identifier escape for the attribute selector in `#syncRow`. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** Structural-only styles; theme via `::part(root)`, `::part(row)`, `::part(checkbox)`, ... */
function structuralStyles(): string {
  return `
    :host { display: block; }
    .root { display: flex; flex-direction: column; }
    .row { display: flex; align-items: center; gap: 0.5em; }
    .checkbox { flex: none; }
    .badge { font-size: 0.75em; }
    [data-not-seeded] { cursor: not-allowed; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .row:has(.checkbox:checked) { outline: 2px solid CanvasText; outline-offset: 2px; }
      .row[data-not-seeded] { color: GrayText; }
    }
  `;
}
