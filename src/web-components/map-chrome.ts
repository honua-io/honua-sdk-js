/**
 * Map chrome that wraps a MapLibre control, or a home button that returns
 * to the viewpoint stored on the compat shim.
 */

import {
  AttributionControl,
  FullscreenControl,
  type IControl,
  type Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
} from "maplibre-gl";

interface CompatView {
  zoom?: number;
  goTo?: (target: unknown) => unknown;
  container?: unknown;
}

type ChromeMap = MapLibreMap | CompatView;

const HTMLElementBase: typeof HTMLElement =
  (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement ?? (class {} as unknown as typeof HTMLElement);

function labelOf(element: HTMLElement, fallback: string): string {
  return element.getAttribute("label") ?? fallback;
}

abstract class HonuaChromeElement extends HTMLElementBase {
  #map: ChromeMap | undefined;
  #view: unknown;
  #control: IControl | undefined;

  public get map(): ChromeMap | undefined {
    return this.#map;
  }

  public set map(map: ChromeMap | undefined) {
    this.#map = map;
    this.render();
  }

  public get view(): unknown {
    return this.#view;
  }

  public set view(view: unknown) {
    this.#view = view;
    this.render();
  }

  /** Compat view pushed by the host. A MapLibre map is not a view. */
  protected compatView(): CompatView | undefined {
    if (isCompatView(this.#view)) return this.#view;
    if (isCompatView(this.#map)) return this.#map;
    return undefined;
  }

  public connectedCallback(): void {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.render();
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  protected abstract fallback(): string;
  protected abstract control(): IControl | undefined;
  /** Control chrome wired to the compat view when no MapLibre map is mounted. */
  protected renderCompat(_section: HTMLElement): void {}

  protected render(): void {
    if (!this.shadowRoot) return;
    const label = labelOf(this, this.fallback());
    this.shadowRoot.innerHTML = `<section aria-label="${escapeAttr(label)}"><slot></slot></section>`;
    const section = this.shadowRoot.querySelector("section");
    if (!section) return;
    try {
      this.#control?.onRemove(this.#map as MapLibreMap);
    } catch {
      // A control that failed onAdd can still be replaced on the next render.
    }
    const control = this.control();
    this.#control = control;
    if (control && isMapLibreMap(this.#map)) {
      try {
        section.append(control.onAdd(this.#map));
        return;
      } catch {
        // The MapLibre control rejected this map. The compat view still gets a control.
      }
    }
    this.renderCompat(section);
  }
}

function isMapLibreMap(value: unknown): value is MapLibreMap {
  if (!value || typeof value !== "object") return false;
  const map = value as {
    getCanvas?: unknown;
    getContainer?: unknown;
    zoomIn?: unknown;
    _getUIString?: unknown;
  };
  return (
    typeof map.getCanvas === "function" &&
    typeof map.getContainer === "function" &&
    typeof map.zoomIn === "function" &&
    typeof map._getUIString === "function"
  );
}

function isCompatView(value: unknown): value is CompatView {
  return !!value && typeof value === "object" && !isMapLibreMap(value);
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeText(value: string): string {
  return escapeAttr(value);
}

export class HonuaZoomElement extends HonuaChromeElement {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  protected fallback(): string {
    return "Zoom";
  }

  protected control(): IControl | undefined {
    if (this.compatView() || !isMapLibreMap(this.map)) return undefined;
    return new NavigationControl({ showCompass: false, showZoom: true });
  }

  protected override renderCompat(section: HTMLElement): void {
    const group = document.createElement("div");
    group.className = "maplibregl-ctrl maplibregl-ctrl-group";
    group.append(
      this.zoomButton("maplibregl-ctrl-zoom-in", "Zoom in", 1),
      this.zoomButton("maplibregl-ctrl-zoom-out", "Zoom out", -1),
    );
    section.append(group);
  }

  private zoomButton(className: string, label: string, delta: number): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("aria-label", label);
    const icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    button.addEventListener("click", () => this.step(delta));
    return button;
  }

  private step(delta: number): void {
    const view = this.compatView();
    if (!view) return;
    const current = typeof view.zoom === "number" && Number.isFinite(view.zoom) ? view.zoom : 2;
    const next = current + delta;
    view.zoom = next;
    if (typeof view.goTo === "function") void view.goTo.call(view, { zoom: next });
  }
}

export class HonuaScaleBarElement extends HonuaChromeElement {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #text = "";
  #unit = "metric";

  public get text(): string {
    return this.#text;
  }

  public set text(text: string | undefined) {
    this.#text = text ?? "";
    this.render();
  }

  public get unit(): string {
    return this.#unit;
  }

  public set unit(unit: string | undefined) {
    this.#unit = unit ?? "metric";
    this.render();
  }

  protected fallback(): string {
    return "Scale";
  }

  protected control(): IControl | undefined {
    if (this.compatView() || this.#text.trim() || !isMapLibreMap(this.map)) return undefined;
    const unit = this.#unit === "imperial" || this.#unit === "nautical" ? this.#unit : "metric";
    return new ScaleControl({ maxWidth: 80, unit });
  }

  protected override renderCompat(section: HTMLElement): void {
    const node = document.createElement("div");
    node.className = "maplibregl-ctrl maplibregl-ctrl-scale";
    node.textContent = this.scaleLabel();
    section.append(node);
  }

  private scaleLabel(): string {
    if (this.#text.trim()) return this.#text;
    const zoom = this.compatView()?.zoom;
    if (typeof zoom !== "number" || !Number.isFinite(zoom)) return "";
    return formatScaleBar(zoom, this.#unit);
  }
}

export class HonuaFullscreenElement extends HonuaChromeElement {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  protected fallback(): string {
    return "Fullscreen";
  }

  protected control(): IControl | undefined {
    if (this.compatView() || !isMapLibreMap(this.map)) return undefined;
    return new FullscreenControl();
  }

  protected override renderCompat(section: HTMLElement): void {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "maplibregl-ctrl-fullscreen";
    button.textContent = labelOf(this, "Fullscreen");
    button.addEventListener("click", () => {
      const container = this.compatView()?.container;
      const target = container instanceof HTMLElement ? container : this.ownerDocument?.documentElement;
      const request = target?.requestFullscreen;
      if (typeof request === "function") void request.call(target);
    });
    section.append(button);
  }
}

export class HonuaAttributionElement extends HonuaChromeElement {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #attributions: readonly string[] = [];

  public get attributions(): readonly string[] {
    return this.#attributions;
  }

  public set attributions(attributions: readonly string[] | undefined) {
    this.#attributions = attributions ?? [];
    this.render();
  }

  protected fallback(): string {
    return "Attribution";
  }

  protected control(): IControl | undefined {
    if (!isMapLibreMap(this.map)) return undefined;
    return new AttributionControl({ compact: false, customAttribution: this.#attributions.join(" | ") });
  }

  protected override renderCompat(section: HTMLElement): void {
    const node = document.createElement("div");
    node.className = "maplibregl-ctrl maplibregl-ctrl-attrib";
    node.textContent = this.#attributions.join(" | ");
    section.append(node);
  }
}

export class HonuaCompassElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #view: { rotation?: number; goTo?: (target: unknown) => unknown } | undefined;

  public get view(): { rotation?: number; goTo?: (target: unknown) => unknown } | undefined {
    return this.#view;
  }

  public set view(view: { rotation?: number; goTo?: (target: unknown) => unknown } | undefined) {
    this.#view = view;
    this.render();
  }

  public connectedCallback(): void {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.render();
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  public reset(): void {
    if (this.#view) this.#view.rotation = 0;
    void this.#view?.goTo?.({ rotation: 0 });
    this.render();
  }

  private render(): void {
    if (!this.shadowRoot) return;
    const label = labelOf(this, "Compass");
    this.shadowRoot.innerHTML = `<section aria-label="${escapeAttr(label)}"><button type="button" class="maplibregl-ctrl-compass">${escapeText(label)}</button></section>`;
    this.shadowRoot.querySelector("button")?.addEventListener("click", () => this.reset());
  }
}

export class HonuaHomeElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #view: { goTo?: (target: unknown) => unknown } | undefined;
  #viewpoint: { center?: unknown; zoom?: number } | undefined;

  public get view(): { goTo?: (target: unknown) => unknown } | undefined {
    return this.#view;
  }

  public set view(view: { goTo?: (target: unknown) => unknown } | undefined) {
    this.#view = view;
  }

  public get viewpoint(): { center?: unknown; zoom?: number } | undefined {
    return this.#viewpoint;
  }

  public set viewpoint(viewpoint: { center?: unknown; zoom?: number } | undefined) {
    this.#viewpoint = viewpoint;
    this.render();
  }

  public connectedCallback(): void {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.render();
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  public go(): void {
    const target = { center: this.#viewpoint?.center, zoom: this.#viewpoint?.zoom };
    void this.#view?.goTo?.(target);
  }

  private render(): void {
    if (!this.shadowRoot) return;
    const label = labelOf(this, "Home");
    this.shadowRoot.innerHTML = `<section aria-label="${escapeAttr(label)}"><button type="button" class="maplibregl-ctrl-home">${escapeText(label)}</button></section>`;
    this.shadowRoot.querySelector("button")?.addEventListener("click", () => this.go());
  }
}

function formatScaleBar(zoom: number, unit: string): string {
  const scale = 591657527.591555 / 2 ** zoom;
  const ratioText = `1:${Math.max(1, Math.round(scale)).toLocaleString("en-US")}`;
  if (unit === "imperial") return `${ratioText} | ${formatImperialDistance(scale)}`;
  if (unit === "dual") return `${ratioText} | ${formatMetricDistance(scale)} / ${formatImperialDistance(scale)}`;
  return `${ratioText} | ${formatMetricDistance(scale)}`;
}

function formatMetricDistance(scale: number): string {
  const meters = Math.max(1, Math.round(scale * 0.00028));
  if (meters >= 1000) return `${Math.round(meters / 1000)} km`;
  return `${meters} m`;
}

function formatImperialDistance(scale: number): string {
  const feet = Math.max(1, Math.round(scale * 0.0009186351706));
  if (feet >= 5280) return `${Math.round(feet / 5280)} mi`;
  return `${feet} ft`;
}
