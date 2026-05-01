/**
 * Popup bindings. The runtime wires `MapPackage.popupBindings[]` into
 * MapLibre `click` handlers using a duck-typed map interface (no runtime
 * dependency on `maplibre-gl`). The default DOM renderer is intentionally
 * unstyled — `#29` operator components replace it with richer popup UIs.
 *
 * @module
 */

import type { MapEventTarget } from "../interactions/feature-state.js";
import type { HonuaMapPackagePopupBinding } from "./map-package.js";

/**
 * Minimal subset of `maplibre-gl.Popup` needed to open a popup at
 * click coordinates. Any object implementing these methods works.
 */
export interface PopupHandle {
  setLngLat(coord: [number, number]): this;
  setDOMContent(node: Node): this;
  setHTML(html: string): this;
  addTo(map: unknown): this;
  remove(): void;
}

/** Factory a host supplies so the runtime never imports `maplibre-gl` directly. */
export type PopupFactory = () => PopupHandle;

/** Custom popup renderer that receives the click event features. */
export type PopupRenderer = (context: PopupRenderContext) => Node | string | undefined;

export interface PopupRenderContext {
  binding: HonuaMapPackagePopupBinding;
  features: ReadonlyArray<PopupFeature>;
  lngLat: [number, number];
}

export interface PopupFeature {
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: unknown;
}

export interface BindPopupOptions {
  binding: HonuaMapPackagePopupBinding;
  /** MapLibre layer id to listen to for clicks. */
  layerId: string;
  /** Create a new popup handle (usually `new maplibregl.Popup()`). */
  popupFactory: PopupFactory;
  /** Custom renderer; defaults to unstyled key/value list. */
  render?: PopupRenderer;
}

/** Handle returned by {@link bindPopup} — call `remove()` on teardown. */
export interface PopupBindingHandle {
  remove(): void;
  readonly layerId: string;
}

/**
 * Subscribe to `click` events on `layerId` and render a popup at the
 * click point. Assumes the host passes a map that matches `MapEventTarget`
 * (all MapLibre `Map` instances do).
 */
export function bindPopup(
  map: MapEventTarget & {
    /* passed through to popup.addTo */
  },
  options: BindPopupOptions,
): PopupBindingHandle {
  const { binding, layerId, popupFactory, render = defaultPopupRenderer } = options;
  let current: PopupHandle | undefined;

  function onClick(...args: unknown[]): void {
    const event = args[0] as
      | {
          lngLat?: { lng: number; lat: number };
          features?: PopupFeature[];
        }
      | undefined;
    if (!event?.lngLat || !event.features || event.features.length === 0) return;

    const lngLat: [number, number] = [event.lngLat.lng, event.lngLat.lat];
    const rendered = render({ binding, features: event.features, lngLat });
    if (!rendered) return;

    current?.remove();
    current = popupFactory().setLngLat(lngLat);
    if (typeof rendered === "string") current.setHTML(rendered);
    else current.setDOMContent(rendered);
    current.addTo(map);
  }

  map.on("click", layerId, onClick);

  return {
    layerId,
    remove() {
      current?.remove();
      current = undefined;
      map.off("click", layerId, onClick);
    },
  };
}

/**
 * Default renderer: an unstyled `<dl>` list of `binding.fieldName` (when
 * set) or all properties on the first feature. Use a custom renderer for
 * anything production-quality.
 */
export function defaultPopupRenderer(context: PopupRenderContext): Node | undefined {
  const doc = resolveDocument();
  if (!doc) return undefined;

  const root = doc.createElement("div");
  if (context.binding.title) {
    const title = doc.createElement("h3");
    title.textContent = context.binding.title;
    root.appendChild(title);
  }

  const feature = context.features[0];
  if (!feature || !feature.properties) return root;

  if (context.binding.template) {
    const body = doc.createElement("div");
    body.textContent = renderStringTemplate(context.binding.template, feature.properties);
    root.appendChild(body);
    return root;
  }

  const fields = context.binding.fieldName
    ? [context.binding.fieldName].filter((f) => Object.hasOwn(feature.properties ?? {}, f))
    : Object.keys(feature.properties);

  const dl = doc.createElement("dl");
  for (const field of fields) {
    const dt = doc.createElement("dt");
    dt.textContent = field;
    const dd = doc.createElement("dd");
    dd.textContent = String(feature.properties[field]);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  root.appendChild(dl);
  return root;
}

function renderStringTemplate(template: string, properties: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = properties[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function resolveDocument(): Document | undefined {
  if (typeof document !== "undefined") return document;
  return undefined;
}
