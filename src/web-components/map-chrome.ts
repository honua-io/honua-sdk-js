/**
 * Map chrome that wraps a MapLibre control, or a home button that returns
 * to the viewpoint stored on the compat shim.
 */

import {
  AttributionControl,
  FullscreenControl,
  NavigationControl,
  ScaleControl,
  type IControl,
  type Map as MapLibreMap,
} from "maplibre-gl";

type ChromeMap = MapLibreMap | {
  addControl?: (control: IControl) => void;
  removeControl?: (control: IControl) => void;
};

const HTMLElementBase: typeof HTMLElement =
  (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement ?? (class {} as unknown as typeof HTMLElement);

function labelOf(element: HTMLElement, fallback: string): string {
  return element.getAttribute("label") ?? fallback;
}

abstract class HonuaChromeElement extends HTMLElementBase {
  #map: ChromeMap | undefined;
  #control: IControl | undefined;

  public get map(): ChromeMap | undefined {
    return this.#map;
  }

  public set map(map: ChromeMap | undefined) {
    this.#map = map;
    this.render();
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
    if (!control) return;
    try {
      const node = mountControl(control, this.#map);
      section.append(node);
      this.#map?.addControl?.(control);
    } catch {
      section.insertAdjacentHTML("beforeend", `<div class="maplibregl-ctrl">${escapeText(label)}</div>`);
    }
  }
}

function mountControl(control: IControl, map: ChromeMap | undefined): HTMLElement {
  const target = (map ?? stubMap()) as MapLibreMap;
  try {
    return control.onAdd(target);
  } catch {
    return control.onAdd(stubMap());
  }
}

function stubMap(): MapLibreMap {
  const container = document.createElement("div");
  const handlers = {
    on() {
      return this;
    },
    off() {
      return this;
    },
    isEnabled: () => false,
    enable() {},
    disable() {},
    disableRotation() {},
    enableRotation() {},
  };
  const point = (x: number, y: number) => ({
    x,
    y,
    distanceTo(other: { x: number; y: number }) {
      return Math.hypot(x - other.x, y - other.y);
    },
  });
  return {
    getZoom: () => 2,
    getBearing: () => 0,
    getPitch: () => 0,
    getRoll: () => 0,
    getMinZoom: () => 0,
    getMaxZoom: () => 22,
    zoomIn() {},
    zoomOut() {},
    setBearing() {},
    resetNorth() {},
    resetNorthPitch() {},
    easeTo() {},
    on() {
      return this;
    },
    off() {
      return this;
    },
    _getUIString: (key: string) => key,
    getContainer: () => container,
    getCanvasContainer: () => container,
    style: { tileManagers: {} },
    _camera: { transform: { width: 200, height: 200 } },
    unproject: (xy: [number, number]) => point(xy[0], xy[1]),
    project: (lnglat: { x: number; y: number }) => point(lnglat.x, lnglat.y),
    cooperativeGestures: handlers,
    scrollZoom: handlers,
    dragRotate: handlers,
    touchZoomRotate: handlers,
    doubleClickZoom: handlers,
    keyboard: handlers,
    boxZoom: handlers,
  } as unknown as MapLibreMap;
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

  protected control(): IControl {
    return new NavigationControl({ showCompass: false, showZoom: true });
  }
}

export class HonuaScaleBarElement extends HonuaChromeElement {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  protected fallback(): string {
    return "Scale";
  }

  protected control(): IControl {
    return new ScaleControl({ maxWidth: 80, unit: "metric" });
  }
}

export class HonuaFullscreenElement extends HonuaChromeElement {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  protected fallback(): string {
    return "Fullscreen";
  }

  protected control(): IControl {
    return new FullscreenControl();
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

  protected control(): IControl {
    return new AttributionControl({ compact: false, customAttribution: this.#attributions.join(" | ") });
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
