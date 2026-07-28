/**
 * `<honua-basemap-switcher>` — framework-free custom element that switches a
 * MapLibre map between exclusive basemap definitions (issue #274).
 *
 * The element renders an accessible radio group (one radio per base) inside
 * shadow DOM with structural-only CSS and `::part()` hooks, and delegates all
 * style mutations to {@link HonuaBasemapStyleBinding}. It never imports
 * `maplibre-gl` or the SDK core, so the `@honua/sdk-js/controls` entry stays
 * independent of the core bundle.
 *
 * ## Wiring
 * - `element.map = map` (any MapLibre `Map`) or `element.connect(map)`;
 * - declaratively via `for="<honua-map id>"` — the element resolves the map
 *   from a sibling element exposing a `.map` property (e.g. `<honua-map>`)
 *   and also listens for the `honua-map-ready` event, matching the idiom of
 *   the `web-components` entry.
 *
 * ## Attributes
 * - `bases` — JSON array of {@link HonuaBasemapDefinition} (property `bases`
 *   is preferred for non-trivial configs).
 * - `value` — id of the base to activate; reflected on selection changes.
 * - `for` — id of the map-providing element, see Wiring.
 * - `label` — accessible name of the radio group (default "Basemaps").
 *
 * ## Events
 * - `change` — `CustomEvent<HonuaBasemapSwitcherChangeDetail>` (bubbles,
 *   composed) whenever the active base changes: user interaction,
 *   programmatic `value` assignment, or the initial/default activation.
 *
 * ## CSS parts
 * - `group` — the radio-group container (button-group layout).
 * - `radio` — each base button.
 * - `radio-active` — additionally present on the active base's button.
 *
 * ## Accessibility
 * Radio-group semantics (`role="radiogroup"` / `role="radio"`,
 * `aria-checked`) with roving tabindex; ArrowLeft/ArrowUp and
 * ArrowRight/ArrowDown move and select, Home/End jump to the first/last
 * base, Space/Enter select the focused base.
 */

import { HonuaBasemapStyleBinding } from "./basemap-style-binding.js";
import {
  HTMLElementBase,
  escapeAttribute,
  escapeHtml,
  globalDom,
  listenForHonuaMapReady,
  resolveHonuaMapFromContext,
} from "./element-utils.js";
import { defineHonuaSwipeControl } from "./swipe-control.js";
import type {
  HonuaBasemapDefinition,
  HonuaBasemapKind,
  HonuaBasemapSwitcherChangeDetail,
  HonuaBasemapSwitcherMap,
} from "./types.js";

/**
 * Custom element implementing the exclusive basemap switcher. Registered as
 * `honua-basemap-switcher` by {@link defineHonuaControls} (which runs
 * automatically on import when a `customElements` registry exists).
 */
export class HonuaBasemapSwitcherElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["bases", "value", "for", "label"];
  }

  readonly #binding = new HonuaBasemapStyleBinding();
  #requestedValue: string | undefined;
  #disposeMapReadyListener: (() => void) | undefined;
  #rendered = false;

  /**
   * The MapLibre map driven by this control. Assigning a map applies the
   * current selection to it; assigning `undefined` detaches and removes every
   * layer/source the control added.
   */
  public get map(): HonuaBasemapSwitcherMap | undefined {
    return this.#binding.map;
  }

  public set map(map: HonuaBasemapSwitcherMap | undefined) {
    this.#binding.setMap(map);
    if (map) this.#ensureActive();
  }

  /** Wires the control to a MapLibre map. Equivalent to setting `.map`. */
  public connect(map: HonuaBasemapSwitcherMap): void {
    this.map = map;
  }

  /** The registered base definitions. */
  public get bases(): readonly HonuaBasemapDefinition[] {
    return this.#binding.bases;
  }

  public set bases(bases: readonly HonuaBasemapDefinition[]) {
    const previousActive = this.#binding.activeId;
    this.#binding.setBases(bases);
    this.#rendered = false;
    this.render();
    if (previousActive !== undefined && this.#binding.activeId === undefined) {
      // The previously active base was removed; fall back to a valid base.
      this.#ensureActive(previousActive);
    } else {
      this.#ensureActive();
    }
  }

  /**
   * Id of the active base. Assigning a registered base id activates it (and
   * dispatches `change` when the selection actually changes); assignments
   * are remembered and honored once matching bases arrive.
   */
  public get value(): string | undefined {
    return this.#binding.activeId ?? this.#requestedValue;
  }

  public set value(value: string | undefined) {
    if (value === undefined) return;
    this.select(value);
  }

  /**
   * Activates the base with the given id. Returns `true` when the id matched
   * a registered base. Dispatches `change` when the active base changed.
   */
  public select(baseId: string): boolean {
    const previous = this.#binding.activeId;
    if (previous === baseId) {
      this.#requestedValue = undefined;
      return true;
    }
    const base = this.bases.find((candidate) => candidate.id === baseId);
    if (!base || !this.#binding.activate(baseId)) {
      this.#requestedValue = baseId;
      return false;
    }
    this.#requestedValue = undefined;
    this.#reflectValue(baseId);
    this.#updateSelectionDom();
    this.#dispatchChange({
      value: baseId,
      ...(previous !== undefined ? { previousValue: previous } : {}),
      kind: base.kind,
    });
    return true;
  }

  public attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "bases") {
      const parsed = parseBases(newValue);
      if (parsed) this.bases = parsed;
      return;
    }
    if (name === "value") {
      if (newValue !== null && newValue !== this.#binding.activeId) this.select(newValue);
      return;
    }
    if (name === "for") {
      this.#resolveMapFromContext();
      return;
    }
    if (name === "label") {
      this.#rendered = false;
      this.render();
    }
  }

  public connectedCallback(): void {
    this.#ensureShadowRoot();
    this.#listenForMapReady();
    this.#resolveMapFromContext();
    this.render();
    this.#ensureActive();
  }

  public disconnectedCallback(): void {
    this.#disposeMapReadyListener?.();
    this.#disposeMapReadyListener = undefined;
  }

  /**
   * Applies the pending `value` (attribute or property assignment made before
   * bases were registered), falling back to the first base so the map is
   * never left without an active base once wiring completes.
   */
  #ensureActive(removedActiveId?: string): void {
    if (this.#binding.activeId !== undefined || this.bases.length === 0) return;
    const requested =
      this.#requestedValue ?? (typeof this.getAttribute === "function" ? this.getAttribute("value") : null);
    if (requested !== null && requested !== undefined && requested !== removedActiveId && this.select(requested))
      return;
    const first = this.bases[0];
    if (first) this.select(first.id);
  }

  // ── map wiring (matches the web-components `for` + ready-event idiom) ──

  #listenForMapReady(): void {
    if (this.#disposeMapReadyListener) return;
    this.#disposeMapReadyListener = listenForHonuaMapReady(this, (map) => {
      const forId = typeof this.getAttribute === "function" ? this.getAttribute("for") : null;
      if (!forId && this.map) return;
      this.map = map as HonuaBasemapSwitcherMap;
    });
  }

  #resolveMapFromContext(): void {
    if (this.map) return;
    const map = resolveHonuaMapFromContext(this);
    if (map) this.map = map as HonuaBasemapSwitcherMap;
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
    if (this.#rendered) {
      this.#updateSelectionDom();
      return;
    }
    const focusedBaseId = root.activeElement?.getAttribute("data-base-id");
    const label = (typeof this.getAttribute === "function" ? this.getAttribute("label") : null) ?? "Basemaps";
    root.innerHTML = `
      <style>${structuralStyles()}</style>
      <div part="group" class="group" role="radiogroup" aria-label="${escapeAttribute(label)}">
        ${this.bases
          .map(
            (base) => `
          <button
            type="button"
            part="radio"
            class="radio"
            role="radio"
            aria-checked="false"
            tabindex="-1"
            data-base-id="${escapeAttribute(base.id)}"
            data-kind="${escapeAttribute(base.kind)}"
          >${escapeHtml(base.label)}</button>
        `,
          )
          .join("")}
      </div>
    `;
    this.#rendered = true;
    this.#bindGroup(root);
    this.#updateSelectionDom();
    if (focusedBaseId) {
      [...root.querySelectorAll<HTMLElement>("[data-base-id]")]
        .find((radio) => radio.getAttribute("data-base-id") === focusedBaseId)
        ?.focus({ preventScroll: true });
    }
  }

  #bindGroup(root: ShadowRoot): void {
    root.querySelectorAll<HTMLButtonElement>("button[data-base-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const baseId = button.dataset.baseId;
        if (baseId) this.select(baseId);
      });
    });
    root.querySelector(".group")?.addEventListener("keydown", (event) => {
      this.#onGroupKeydown(event as KeyboardEvent);
    });
  }

  #onGroupKeydown(event: KeyboardEvent): void {
    const radios = this.#radios();
    if (radios.length === 0) return;
    const activeIndex = Math.max(
      0,
      radios.findIndex((radio) => radio.dataset.baseId === this.#binding.activeId),
    );
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (activeIndex + 1) % radios.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (activeIndex - 1 + radios.length) % radios.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = radios.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = radios[nextIndex];
    const baseId = next?.dataset.baseId;
    if (!baseId) return;
    this.select(baseId);
    next.focus();
  }

  /** Roving tabindex + checked state, updated in place to preserve focus. */
  #updateSelectionDom(): void {
    const radios = this.#radios();
    if (radios.length === 0) return;
    const activeId = this.#binding.activeId;
    const fallbackTabStop = radios.some((radio) => radio.dataset.baseId === activeId) ? undefined : radios[0];
    for (const radio of radios) {
      const isActive = radio.dataset.baseId === activeId;
      radio.setAttribute("aria-checked", String(isActive));
      radio.setAttribute("part", isActive ? "radio radio-active" : "radio");
      radio.tabIndex = isActive || radio === fallbackTabStop ? 0 : -1;
    }
  }

  #radios(): HTMLButtonElement[] {
    const root = this.shadowRoot;
    if (!root || typeof root.querySelectorAll !== "function") return [];
    return [...root.querySelectorAll<HTMLButtonElement>("button[data-base-id]")];
  }

  #reflectValue(baseId: string): void {
    if (typeof this.setAttribute !== "function" || typeof this.getAttribute !== "function") return;
    if (this.getAttribute("value") !== baseId) this.setAttribute("value", baseId);
  }

  #dispatchChange(detail: HonuaBasemapSwitcherChangeDetail): void {
    if (!globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    this.dispatchEvent(new globalDom.CustomEvent("change", { bubbles: true, composed: true, detail }));
  }
}

/**
 * Registers `<honua-basemap-switcher>`. Skipped when the tag is already
 * defined. Broken out from {@link defineHonuaControls} so the catalog-driven
 * registry (`./registry.js`) can register this tag individually.
 */
export function defineHonuaBasemapSwitcher(registry = globalDom.customElements): void {
  if (!registry) return;
  if (!registry.get("honua-basemap-switcher")) {
    registry.define("honua-basemap-switcher", HonuaBasemapSwitcherElement);
  }
}

/**
 * Registers the controls-entry custom elements that do NOT contend for a tag
 * with the `web-components` kit: `honua-basemap-switcher` and
 * `honua-swipe-control`. Invoked automatically on import when a global
 * `customElements` registry is present; call explicitly when using a scoped
 * registry.
 *
 * `honua-legend` and `honua-layer-list` are intentionally NOT registered here
 * — both tags also have a controller-driven implementation in the
 * `web-components` kit, and the `web-components` kit's implementation is that
 * tag's canonical/default registrant (see `./catalog.js`). Registering both
 * kits' colliding elements from unguarded module-load side effects made the
 * winner depend on import order (issue #679); each is opt-in instead, via
 * {@link defineHonuaLegend} / {@link defineHonuaLayerList}, so claiming the
 * controls-kit implementation is always an explicit, deterministic choice.
 */
export function defineHonuaControls(registry = globalDom.customElements): void {
  if (!registry) return;
  defineHonuaBasemapSwitcher(registry);
  defineHonuaSwipeControl(registry);
}

if (globalDom.customElements) {
  defineHonuaControls(globalDom.customElements);
}

function parseBases(value: string | null): readonly HonuaBasemapDefinition[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((item): HonuaBasemapDefinition[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<HonuaBasemapDefinition>;
      if (typeof candidate.id !== "string" || typeof candidate.label !== "string") return [];
      return [
        {
          id: candidate.id,
          label: candidate.label,
          kind: isBasemapKind(candidate.kind) ? candidate.kind : "vector",
          sources: candidate.sources && typeof candidate.sources === "object" ? candidate.sources : {},
          layers: Array.isArray(candidate.layers)
            ? candidate.layers.filter((layer) => typeof layer?.id === "string")
            : [],
        },
      ];
    });
  } catch {
    return undefined;
  }
}

function isBasemapKind(value: unknown): value is HonuaBasemapKind {
  return value === "vector" || value === "raster" || value === "raster-dem-composite";
}

/** Structural-only styles; theme via `::part(group)` / `::part(radio)` / `::part(radio-active)`. */
function structuralStyles(): string {
  return `
    :host { display: inline-block; }
    .group { display: inline-flex; flex-wrap: wrap; }
    .radio { font: inherit; cursor: pointer; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .radio[aria-checked="true"] {
        forced-color-adjust: none;
        outline: 2px solid Highlight;
        outline-offset: 2px;
      }
    }
  `;
}
