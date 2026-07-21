/**
 * `HonuaWidgetHost` — mounts the app-platform survival-tier web components
 * (`@honua/sdk-js/web-components`, moving to `@honua/app-platform`) into the
 * `container` an esri-compat widget shim was constructed with, so shim UI
 * renders through the shared component set instead of shim-only markup
 * (issue #493, REQ-004).
 *
 * The host **never imports the web-component kit** — not even dynamically:
 * the `/esri-compat` entrypoint is bundle-budgeted, and any intra-package
 * import (static or `import()`) would pull the whole kit plus its geometry
 * closure into every compat bundle. Instead the application injects the kit
 * once via {@link registerHonuaWidgetKit}:
 *
 * ```ts doc-test=skip reason="wiring snippet requires an application host"
 * import { registerHonuaWidgetKit } from "@honua/sdk-esri-compat";
 *
 * // Eager (module object) or lazy (loader) — both work:
 * registerHonuaWidgetKit(() => import("@honua/sdk-js/web-components"));
 * ```
 *
 * The host is deliberately defensive:
 *
 * - It resolves the ArcGIS-style `container` option (an `HTMLElement` or an
 *   element id) only when a DOM is present; headless (Node) shim usage keeps
 *   working with no DOM side effects.
 * - Without a registered kit — the default, and the only possibility in the
 *   standalone `@honua/sdk-esri-compat` split package unless the app installs
 *   the kit — mounting quietly no-ops and the shims stay state-model-only,
 *   exactly their pre-delegation behavior.
 * - The delegation tag must be owned by the kit's own element class; a
 *   foreign registrant (e.g. an app that explicitly opted into the controls
 *   kit's `honua-legend` via `defineHonuaLegend()`, which has a different
 *   `entries` API) also falls back to the headless behavior.
 *
 * @module
 */

type WidgetHostDom = {
  document?: Document;
  customElements?: CustomElementRegistry;
};

const globalDom = globalThis as typeof globalThis & WidgetHostDom;

/** Element surface the host hands back to shim update callbacks. */
export interface HonuaWidgetHostElement extends HTMLElement {
  [key: string]: unknown;
}

/**
 * Structural slice of the `@honua/sdk-js/web-components` module the host
 * needs: the element classes (to verify tag ownership) and the registration
 * helper. Passing the whole module object satisfies this interface.
 */
export interface HonuaWidgetKitLike {
  HonuaLegendElement?: CustomElementConstructor;
  HonuaLayerListElement?: CustomElementConstructor;
  HonuaSearchElement?: CustomElementConstructor;
  HonuaMeasurementElement?: CustomElementConstructor;
  defineHonuaWebComponents?: (registry?: CustomElementRegistry) => void;
}

/** A kit module object, or a (possibly async) loader for one. */
export type HonuaWidgetKitSource = HonuaWidgetKitLike | (() => HonuaWidgetKitLike | Promise<HonuaWidgetKitLike>);

let widgetKitSource: HonuaWidgetKitSource | undefined;

/**
 * Injects the web-component kit that {@link HonuaWidgetHost} delegates to.
 * Call once from application code with the `@honua/sdk-js/web-components`
 * (or `@honua/app-platform/web-components`) module — eagerly or as a lazy
 * loader. Pass `undefined` to unregister (shims return to headless mode).
 */
export function registerHonuaWidgetKit(source: HonuaWidgetKitSource | undefined): void {
  widgetKitSource = source;
}

export class HonuaWidgetHost {
  readonly #tagName: string;
  readonly #container: HTMLElement | undefined;
  #element: HonuaWidgetHostElement | undefined;
  #kitLoad: Promise<boolean> | undefined;
  #kitLoadSource: HonuaWidgetKitSource | undefined;

  public constructor(tagName: string, container: unknown) {
    this.#tagName = tagName;
    this.#container = resolveContainer(container);
  }

  /** Whether a usable container was resolved (requires a DOM). */
  public get available(): boolean {
    return this.#container !== undefined;
  }

  /** The mounted element, when {@link mount} has completed. */
  public get element(): HonuaWidgetHostElement | undefined {
    return this.#element;
  }

  /**
   * Ensures the injected web-component kit is registered and the element is
   * mounted into the container. Returns the element, or `undefined` when no
   * DOM / container / kit is available (headless shims, or an application
   * that never called {@link registerHonuaWidgetKit}).
   */
  public async mount(): Promise<HonuaWidgetHostElement | undefined> {
    const container = this.#container;
    if (!container || !globalDom.document) return undefined;
    if (!(await this.#loadKit())) return undefined;
    if (!this.#element || !this.#element.isConnected) {
      const element = globalDom.document.createElement(this.#tagName) as HonuaWidgetHostElement;
      container.replaceChildren(element);
      this.#element = element;
    }
    return this.#element;
  }

  /**
   * Mounts (when needed) and applies `assign` to the element. Fire-and-forget
   * friendly: shims call `void host.update(...)` from synchronous refresh
   * paths.
   */
  public async update(assign: (element: HonuaWidgetHostElement) => void): Promise<void> {
    const element = await this.mount();
    if (element) assign(element);
  }

  /** Removes the mounted element from the container. */
  public destroy(): void {
    this.#element?.remove();
    this.#element = undefined;
  }

  #loadKit(): Promise<boolean> {
    const source = widgetKitSource;
    // No kit injected (yet): stay headless without caching, so a later
    // registerHonuaWidgetKit call is picked up by the next refresh.
    if (!source) return Promise.resolve(false);
    if (!this.#kitLoad || this.#kitLoadSource !== source) {
      this.#kitLoadSource = source;
      this.#kitLoad = (async () => {
        let kit: HonuaWidgetKitLike;
        try {
          kit = typeof source === "function" ? await source() : source;
          // Importing the kit module registers the elements as a side effect;
          // calling the helper again is an if-missing no-op, but covers kits
          // handed over as plain objects in scoped-registry setups.
          kit.defineHonuaWebComponents?.();
        } catch {
          return false;
        }
        // The tag must be owned by the kit's own class. Another registrant
        // can still win the tag (e.g. an app that explicitly registers the
        // controls kit's own `honua-legend`, which has a different `entries`
        // API); mounting that element and assigning the web-components
        // properties would render nothing, so fall back to the headless shim
        // behavior.
        const expected = expectedKitConstructor(kit, this.#tagName);
        const registered = globalDom.customElements?.get(this.#tagName);
        return expected !== undefined && registered === expected;
      })();
    }
    return this.#kitLoad;
  }
}

/** Resolves the web-components kit class that must own `tagName` for delegation. */
function expectedKitConstructor(kit: HonuaWidgetKitLike, tagName: string): CustomElementConstructor | undefined {
  switch (tagName) {
    case "honua-legend":
      return kit.HonuaLegendElement;
    case "honua-layer-list":
      return kit.HonuaLayerListElement;
    case "honua-search":
      return kit.HonuaSearchElement;
    case "honua-measurement":
      return kit.HonuaMeasurementElement;
    default:
      return undefined;
  }
}

function resolveContainer(container: unknown): HTMLElement | undefined {
  if (!globalDom.document) return undefined;
  if (typeof container === "string") {
    return globalDom.document.getElementById(container) ?? undefined;
  }
  if (
    typeof container === "object" &&
    container !== null &&
    typeof (container as { appendChild?: unknown }).appendChild === "function"
  ) {
    return container as HTMLElement;
  }
  return undefined;
}
