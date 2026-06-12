/**
 * Internal helpers shared by the controls-entry custom elements.
 *
 * Controls never import `maplibre-gl` or the SDK core, and they must load
 * safely under Node (no DOM): `globalDom` exposes the optional browser
 * globals, and `HTMLElementBase` substitutes an empty class when
 * `HTMLElement` is unavailable so element classes can still be unit-tested
 * headlessly.
 *
 * The map-wiring helpers implement the `for="<honua-map id>"` idiom shared by
 * every control: resolve the map from a sibling element exposing a `.map`
 * property, and listen for the `honua-map-ready` event (matching the
 * `web-components` entry).
 *
 * @module
 */

export const globalDom = globalThis as typeof globalThis & {
  HTMLElement?: typeof HTMLElement;
  CustomEvent?: typeof CustomEvent;
  customElements?: CustomElementRegistry;
};

export const HTMLElementBase: typeof HTMLElement = globalDom.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

/**
 * Minimal element surface required by the wiring helpers. Real elements
 * always satisfy it; headless test stubs only need `getAttribute`.
 */
export interface HostElementLike {
  getAttribute?(name: string): string | null;
  getRootNode?(): Node;
}

/** Event target used for `honua-map-ready` listening: the element's root (document or shadow root), falling back to `document`. */
export function rootEventTarget(element: HostElementLike): EventTarget | undefined {
  const root = element.getRootNode?.();
  if (root && "addEventListener" in root) return root as EventTarget;
  return typeof document !== "undefined" ? document : undefined;
}

/**
 * Subscribes to `honua-map-ready` events on the element's root and invokes
 * `assign` with the announced map. When the element has a `for` attribute,
 * only events from the element with that id are honored. Returns a dispose
 * function, or `undefined` when no event target exists (e.g. under Node).
 */
export function listenForHonuaMapReady(
  element: HostElementLike,
  assign: (map: unknown) => void,
): (() => void) | undefined {
  const target = rootEventTarget(element);
  if (!target) return undefined;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ map?: unknown }>).detail;
    if (!detail?.map) return;
    const forId = typeof element.getAttribute === "function" ? element.getAttribute("for") : null;
    if (forId && (event.target as Element | null)?.id !== forId) return;
    assign(detail.map);
  };
  target.addEventListener("honua-map-ready", listener as EventListener);
  return () => target.removeEventListener("honua-map-ready", listener as EventListener);
}

/**
 * Resolves the map from the element referenced by the `for` attribute (an
 * element exposing a `.map` property, e.g. `<honua-map>`), or `undefined`
 * when the attribute is absent or the host has no map yet.
 */
export function resolveHonuaMapFromContext(element: HostElementLike): unknown {
  if (typeof element.getAttribute !== "function") return undefined;
  const forId = element.getAttribute("for");
  if (!forId) return undefined;
  const root = element.getRootNode?.() as (Document | ShadowRoot) | undefined;
  const host =
    root && "getElementById" in root
      ? root.getElementById(forId)
      : typeof document !== "undefined"
        ? document.getElementById(forId)
        : null;
  return (host as { map?: unknown } | null)?.map;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
