/**
 * `HonuaWidgetHost` — mounts the app-platform survival-tier web components
 * (`@honua/sdk-js/web-components`, moving to `@honua/app-platform`) into the
 * `container` an esri-compat widget shim was constructed with, so shim UI
 * renders through the shared component set instead of shim-only markup
 * (issue #493, REQ-004).
 *
 * The host is deliberately defensive:
 *
 * - It resolves the ArcGIS-style `container` option (an `HTMLElement` or an
 *   element id) only when a DOM is present; headless (Node) shim usage keeps
 *   working with no DOM side effects.
 * - The web-component kit is loaded with a **dynamic** import. The published
 *   `@honua/sdk-esri-compat` split package does not ship the web-component
 *   sources, so there the mount quietly no-ops and the shims stay
 *   state-model-only — exactly their pre-delegation behavior.
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

export class HonuaWidgetHost {
  readonly #tagName: string;
  readonly #container: HTMLElement | undefined;
  #element: HonuaWidgetHostElement | undefined;
  #kitLoad: Promise<boolean> | undefined;

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
   * Ensures the web-component kit is registered and the element is mounted
   * into the container. Returns the element, or `undefined` when no DOM /
   * container / kit is available (headless shims, the standalone esri-compat
   * split package).
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
    this.#kitLoad ??= (async () => {
      if (globalDom.customElements?.get(this.#tagName)) return true;
      try {
        // Dynamic so the esri-compat split package (which does not ship the
        // web-component sources) degrades to the headless shim behavior.
        await import("../web-components/index.js");
      } catch {
        return false;
      }
      return globalDom.customElements?.get(this.#tagName) !== undefined;
    })();
    return this.#kitLoad;
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
