/**
 * `<honua-measurement>` — the survival-tier distance/area measurement widget
 * (issue #493).
 *
 * Unlike `<honua-measure-control>` (which requires a host-supplied drawing
 * provider), this element ships a complete, deliberately simple drawing
 * interaction on top of the map's own pointer events:
 *
 * - **click** adds a vertex;
 * - **double-click** finishes the sketch (the map's double-click zoom is
 *   suspended while a mode is active when the map exposes the handle);
 * - **Escape** (or the Cancel button) discards the in-progress sketch.
 *
 * Distance and area are computed with the geodesic ops from the public
 * `@honua/geometry` surface (`length` / `area`), so the widget's numbers match
 * `geometryEngine` parity math everywhere else in the SDK.
 *
 * ## Wiring
 * - `element.map = map` (any MapLibre `Map`; duck-typed via
 *   {@link HonuaMeasurementMap}), or
 * - declaratively via `for="<honua-map id>"` — the element listens for the
 *   `honua-map-ready` event dispatched by `<honua-map>`.
 *
 * When the map exposes style mutation methods (`addSource` / `addLayer`), the
 * in-progress sketch renders as a line + fill overlay in a
 * `honua-measurement` GeoJSON source; on plain stubs the overlay is skipped.
 *
 * ## Accessibility
 * Mode buttons are a `role="group"` of toggle buttons with `aria-pressed`;
 * the live result is announced through a `role="status"` region; Finish /
 * Cancel buttons provide keyboard-operable equivalents of double-click /
 * Escape. Theme via the `--honua-ui-*` CSS custom properties.
 *
 * @module
 */

import { area as geodesicArea, length as geodesicLength } from "../geometry/index.js";
import type { HonuaMeasureChangeDetail, HonuaMeasureMode, HonuaMeasureResult, HonuaMeasurementMap } from "./types.js";

const globalDom = globalThis as typeof globalThis & {
  HTMLElement?: typeof HTMLElement;
  CustomEvent?: typeof CustomEvent;
  customElements?: CustomElementRegistry;
};

const HTMLElementBase: typeof HTMLElement = globalDom.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

const OVERLAY_SOURCE_ID = "honua-measurement";
const OVERLAY_LINE_LAYER_ID = "honua-measurement-line";
const OVERLAY_FILL_LAYER_ID = "honua-measurement-fill";

type LngLat = readonly [number, number];

export class HonuaMeasurementElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  #map: HonuaMeasurementMap | undefined;
  #mode: HonuaMeasureMode = "off";
  #vertices: LngLat[] = [];
  #finished = false;
  #result: HonuaMeasureResult | undefined;
  #connected = false;
  #disposeMapReadyListener: (() => void) | undefined;
  #clickListener: ((event?: unknown) => void) | undefined;
  #dblclickListener: ((event?: unknown) => void) | undefined;
  #keydownListener: ((event: KeyboardEvent) => void) | undefined;

  /** The MapLibre map this widget draws on. */
  public get map(): HonuaMeasurementMap | undefined {
    return this.#map;
  }

  public set map(map: HonuaMeasurementMap | undefined) {
    if (this.#map === map) return;
    this.#deactivateDrawing();
    this.#map = map;
    if (this.#mode !== "off") this.#activateDrawing();
    this.render();
  }

  /** Wires the widget to a MapLibre map. Equivalent to setting `.map`. */
  public connect(map: HonuaMeasurementMap): void {
    this.map = map;
  }

  /** The active measure mode. */
  public get mode(): HonuaMeasureMode {
    return this.#mode;
  }

  /** The current (or last finished) measurement result. */
  public get result(): HonuaMeasureResult | undefined {
    return this.#result;
  }

  /** The in-progress vertex list (`[lng, lat]` positions). */
  public get vertices(): readonly LngLat[] {
    return this.#vertices;
  }

  /** Activates a measure mode; `"off"` cancels any in-progress sketch. */
  public setMode(mode: HonuaMeasureMode): void {
    if (this.#mode === mode) return;
    this.#deactivateDrawing();
    this.#mode = mode;
    this.#vertices = [];
    this.#finished = false;
    this.#result = undefined;
    if (mode !== "off") this.#activateDrawing();
    this.#dispatchChange();
    this.render();
  }

  /** Adds a vertex programmatically (same as a map click). */
  public addVertex(lngLat: LngLat): void {
    if (this.#mode === "off") return;
    if (this.#finished) {
      this.#vertices = [];
      this.#finished = false;
    }
    this.#vertices = [...this.#vertices, [lngLat[0], lngLat[1]]];
    this.#recompute();
    this.#syncOverlay();
    this.#dispatchChange();
    this.render();
  }

  /** Finishes the in-progress sketch (same as double-click). */
  public finish(): void {
    if (this.#mode === "off" || this.#vertices.length === 0 || this.#finished) return;
    this.#finished = true;
    this.#recompute();
    this.#syncOverlay();
    this.#dispatchChange();
    this.render();
  }

  /** Cancels the in-progress sketch (same as Escape); the mode stays active. */
  public cancel(): void {
    if (this.#vertices.length === 0 && !this.#finished) return;
    this.#vertices = [];
    this.#finished = false;
    this.#result = undefined;
    this.#syncOverlay();
    this.#dispatchChange();
    this.render();
  }

  public attributeChangedCallback(name: string): void {
    if (name === "for") {
      this.#resolveMapFromContext();
      return;
    }
    this.render();
  }

  public connectedCallback(): void {
    this.#connected = true;
    this.#ensureShadowRoot();
    this.#listenForMapReady();
    this.#resolveMapFromContext();
    this.render();
  }

  public disconnectedCallback(): void {
    this.#connected = false;
    this.#disposeMapReadyListener?.();
    this.#disposeMapReadyListener = undefined;
    this.#deactivateDrawing();
  }

  // ── drawing interaction ─────────────────────────────────────

  #activateDrawing(): void {
    const map = this.#map;
    if (!map || this.#clickListener) return;
    const onClick = (event?: unknown): void => {
      const lngLat = eventLngLat(event);
      if (lngLat) this.addVertex(lngLat);
    };
    const onDblclick = (event?: unknown): void => {
      preventMapDefault(event);
      // The double-click's own click events already appended a duplicate
      // trailing vertex; drop it before finishing.
      if (!this.#finished && this.#vertices.length >= 2) {
        const last = this.#vertices[this.#vertices.length - 1];
        const previous = this.#vertices[this.#vertices.length - 2];
        if (last && previous && last[0] === previous[0] && last[1] === previous[1]) {
          this.#vertices = this.#vertices.slice(0, -1);
        }
      }
      this.finish();
    };
    map.on("click", onClick);
    map.on("dblclick", onDblclick);
    map.doubleClickZoom?.disable?.();
    this.#clickListener = onClick;
    this.#dblclickListener = onDblclick;
    if (typeof window !== "undefined" && !this.#keydownListener) {
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") this.cancel();
      };
      window.addEventListener("keydown", onKeydown);
      this.#keydownListener = onKeydown;
    }
  }

  #deactivateDrawing(): void {
    const map = this.#map;
    if (map) {
      if (this.#clickListener) map.off?.("click", this.#clickListener);
      if (this.#dblclickListener) map.off?.("dblclick", this.#dblclickListener);
      map.doubleClickZoom?.enable?.();
      this.#removeOverlay(map);
    }
    this.#clickListener = undefined;
    this.#dblclickListener = undefined;
    if (this.#keydownListener && typeof window !== "undefined") {
      window.removeEventListener("keydown", this.#keydownListener);
      this.#keydownListener = undefined;
    }
  }

  #recompute(): void {
    const mode = this.#mode;
    const coordinates = this.#vertices;
    if (mode === "off" || coordinates.length === 0) {
      this.#result = undefined;
      return;
    }
    const result: HonuaMeasureResult = { mode, coordinates };
    try {
      if (mode === "distance" && coordinates.length >= 2) {
        this.#result = {
          ...result,
          distance: geodesicLength({ type: "LineString", coordinates: coordinates.map(toPosition) }, "meters"),
        };
        return;
      }
      if (mode === "area" && coordinates.length >= 3) {
        const ring = [...coordinates.map(toPosition), toPosition(coordinates[0] as LngLat)];
        this.#result = {
          ...result,
          area: geodesicArea({ type: "Polygon", coordinates: [ring] }),
        };
        return;
      }
    } catch {
      // Degenerate geometry (repeated points, collinear ring): report the
      // vertices without a computed value rather than throwing from an event.
    }
    this.#result = result;
  }

  // ── map overlay (best-effort; skipped on stubs) ─────────────

  #syncOverlay(): void {
    const map = this.#map;
    if (!map?.addSource || !map.getSource) return;
    const data = this.#overlayGeoJson();
    try {
      const existing = map.getSource(OVERLAY_SOURCE_ID) as { setData?(data: unknown): void } | undefined;
      if (existing?.setData) {
        existing.setData(data);
        return;
      }
      map.addSource(OVERLAY_SOURCE_ID, { type: "geojson", data });
      map.addLayer?.({
        id: OVERLAY_FILL_LAYER_ID,
        type: "fill",
        source: OVERLAY_SOURCE_ID,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.16 },
      });
      map.addLayer?.({
        id: OVERLAY_LINE_LAYER_ID,
        type: "line",
        source: OVERLAY_SOURCE_ID,
        paint: { "line-color": "#2563eb", "line-width": 2, "line-dasharray": [2, 1] },
      });
    } catch {
      // Overlay rendering is cosmetic; measurement math never depends on it.
    }
  }

  #removeOverlay(map: HonuaMeasurementMap): void {
    try {
      if (map.getLayer?.(OVERLAY_LINE_LAYER_ID)) map.removeLayer?.(OVERLAY_LINE_LAYER_ID);
      if (map.getLayer?.(OVERLAY_FILL_LAYER_ID)) map.removeLayer?.(OVERLAY_FILL_LAYER_ID);
      if (map.getSource?.(OVERLAY_SOURCE_ID)) map.removeSource?.(OVERLAY_SOURCE_ID);
    } catch {
      // Best-effort cleanup.
    }
  }

  #overlayGeoJson(): unknown {
    const coordinates = this.#vertices.map(toPosition);
    const features: unknown[] = [];
    if (this.#mode === "area" && coordinates.length >= 3) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[...coordinates, coordinates[0]]] },
      });
    }
    if (coordinates.length >= 2) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates },
      });
    }
    return { type: "FeatureCollection", features };
  }

  // ── map wiring (matches the `for` + honua-map-ready idiom) ──

  #listenForMapReady(): void {
    if (this.#disposeMapReadyListener) return;
    const target = this.#rootEventTarget();
    if (!target) return;
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ map?: unknown }>).detail;
      if (!detail?.map) return;
      const forId = this.#attr("for");
      if (forId && (event.target as Element | null)?.id !== forId) return;
      if (!forId && this.#map) return;
      this.map = detail.map as HonuaMeasurementMap;
    };
    target.addEventListener("honua-map-ready", listener as EventListener);
    this.#disposeMapReadyListener = () => target.removeEventListener("honua-map-ready", listener as EventListener);
  }

  #resolveMapFromContext(): void {
    if (this.#map) return;
    const forId = this.#attr("for");
    if (!forId) return;
    const root = this.getRootNode?.() as (Document | ShadowRoot) | undefined;
    const host =
      root && "getElementById" in root
        ? root.getElementById(forId)
        : typeof document !== "undefined"
          ? document.getElementById(forId)
          : null;
    const map = (host as { map?: unknown } | null)?.map;
    if (map) this.map = map as HonuaMeasurementMap;
  }

  #rootEventTarget(): EventTarget | undefined {
    const root = this.getRootNode?.();
    if (root && "addEventListener" in root) return root as EventTarget;
    return typeof document !== "undefined" ? document : undefined;
  }

  // ── rendering ──────────────────────────────────────────────

  #ensureShadowRoot(): void {
    if (!this.shadowRoot && typeof this.attachShadow === "function") {
      this.attachShadow({ mode: "open" });
    }
  }

  protected render(): void {
    const root = this.shadowRoot;
    if (!root || !this.#connected) return;
    const focusedMode = root.activeElement?.getAttribute("data-measure-mode");
    const label = this.#attr("label") ?? "Measure";
    const ready = this.#map !== undefined;
    const sketchActive = this.#mode !== "off" && this.#vertices.length > 0 && !this.#finished;
    root.innerHTML = `
      <style>${structuralStyles()}</style>
      <section class="panel" part="panel" aria-label="${escapeAttribute(label)}">
        <div class="bar">
          <h2>${escapeHtml(label)}</h2>
          <span class="state">${escapeHtml(ready ? "ready" : "waiting for map")}</span>
        </div>
        <div class="segmented" role="group" aria-label="${escapeAttribute(`${label} mode`)}">
          ${(["off", "distance", "area"] as const)
            .map(
              (mode) => `
            <button type="button" part="mode" data-measure-mode="${mode}" aria-pressed="${String(
              this.#mode === mode,
            )}"${ready || mode === "off" ? "" : " disabled"}>${escapeHtml(modeLabel(mode))}</button>
          `,
            )
            .join("")}
        </div>
        <p class="value" part="value" role="status" aria-live="polite">${escapeHtml(this.#resultText())}</p>
        <div class="actions">
          <button type="button" part="finish" data-measure-finish${sketchActive ? "" : " disabled"}>Finish</button>
          <button type="button" part="cancel" data-measure-cancel${
            this.#vertices.length > 0 ? "" : " disabled"
          }>Cancel</button>
        </div>
        <p class="hint">${escapeHtml(
          this.#mode === "off"
            ? "Pick a mode, then click the map to add vertices."
            : "Click adds a vertex; double-click or Finish completes; Escape or Cancel discards.",
        )}</p>
      </section>
    `;
    root.querySelectorAll<HTMLButtonElement>("button[data-measure-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        this.setMode((button.dataset.measureMode ?? "off") as HonuaMeasureMode);
      });
    });
    root.querySelector<HTMLButtonElement>("button[data-measure-finish]")?.addEventListener("click", () => {
      this.finish();
    });
    root.querySelector<HTMLButtonElement>("button[data-measure-cancel]")?.addEventListener("click", () => {
      this.cancel();
    });
    if (focusedMode) {
      [...root.querySelectorAll<HTMLButtonElement>("[data-measure-mode]")]
        .find((button) => button.getAttribute("data-measure-mode") === focusedMode)
        ?.focus({ preventScroll: true });
    }
  }

  #resultText(): string {
    const result = this.#result;
    if (this.#mode === "off") return "Measurement off.";
    if (!result || this.#vertices.length === 0) {
      return this.#mode === "distance" ? "Click the map to start a line." : "Click the map to outline an area.";
    }
    if (this.#mode === "distance") {
      if (result.distance === undefined) return `${this.#vertices.length} vertex — add another to measure.`;
      return `Distance: ${formatDistance(result.distance)}${this.#finished ? " (finished)" : ""}`;
    }
    if (result.area === undefined) {
      return `${this.#vertices.length} of 3 vertices needed for an area.`;
    }
    return `Area: ${formatArea(result.area)}${this.#finished ? " (finished)" : ""}`;
  }

  #dispatchChange(): void {
    if (!globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    const detail: HonuaMeasureChangeDetail = {
      mode: this.#mode,
      status: this.#map ? "ready" : "idle",
      ...(this.#result ? { result: this.#result } : {}),
    };
    this.dispatchEvent(new globalDom.CustomEvent("honua-measure-change", { bubbles: true, composed: true, detail }));
  }

  #attr(name: string): string | null {
    return typeof this.getAttribute === "function" ? this.getAttribute(name) : null;
  }
}

/** Registers `<honua-measurement>`; skipped when the tag is already defined. */
export function defineHonuaMeasurement(registry = globalDom.customElements): void {
  if (!registry) return;
  if (!registry.get("honua-measurement")) {
    registry.define("honua-measurement", HonuaMeasurementElement);
  }
}

function toPosition(lngLat: LngLat): [number, number] {
  return [lngLat[0], lngLat[1]];
}

function eventLngLat(event: unknown): LngLat | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const lngLat = (event as { lngLat?: { lng?: unknown; lat?: unknown } }).lngLat;
  if (typeof lngLat?.lng === "number" && typeof lngLat.lat === "number") {
    return [lngLat.lng, lngLat.lat];
  }
  return undefined;
}

function preventMapDefault(event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const preventDefault = (event as { preventDefault?: unknown }).preventDefault;
  if (typeof preventDefault === "function") (preventDefault as () => void).call(event);
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${meters.toFixed(1)} m`;
}

function formatArea(squareMeters: number): string {
  if (squareMeters >= 1_000_000) return `${(squareMeters / 1_000_000).toFixed(2)} km²`;
  if (squareMeters >= 10_000) return `${(squareMeters / 10_000).toFixed(2)} ha`;
  return `${squareMeters.toFixed(1)} m²`;
}

function modeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/** Structural styles themable via the shared `--honua-ui-*` custom properties. */
function structuralStyles(): string {
  return `
    :host {
      --honua-ui-bg: #ffffff;
      --honua-ui-fg: #172033;
      --honua-ui-muted: #667085;
      --honua-ui-border: #d0d5dd;
      --honua-ui-accent: #1d4ed8;
      --honua-ui-accent-fg: #ffffff;
      box-sizing: border-box;
      color: var(--honua-ui-fg);
      display: block;
      font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    *, *::before, *::after { box-sizing: inherit; }
    button {
      border: 1px solid var(--honua-ui-border);
      background: var(--honua-ui-bg);
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      font: inherit;
      min-height: 32px;
      padding: 0 10px;
    }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    button[aria-pressed="true"] {
      background: var(--honua-ui-accent);
      border-color: var(--honua-ui-accent);
      color: var(--honua-ui-accent-fg);
    }
    h2 { font-size: 14px; margin: 0; }
    .panel {
      background: var(--honua-ui-bg);
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      display: grid;
      gap: 10px;
      min-width: 180px;
      padding: 10px;
    }
    .bar { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .state { color: var(--honua-ui-muted); font-size: 12px; }
    .segmented { display: grid; gap: 6px; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); }
    .actions { display: flex; gap: 6px; }
    .value { margin: 0; }
    .hint { color: var(--honua-ui-muted); font-size: 12px; margin: 0; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .panel { background: Canvas; border-color: CanvasText; color: CanvasText; }
      .state, .hint { color: GrayText; }
      button { background: ButtonFace; border-color: ButtonText; color: ButtonText; }
      button[aria-pressed="true"] { background: Highlight; border-color: Highlight; color: HighlightText; }
      button:disabled { color: GrayText; }
      button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
    }
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
