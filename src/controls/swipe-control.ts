/**
 * `<honua-swipe-control>` — framework-free custom element implementing the
 * dual-map "swipe"/compare trick (issue #279, candidate third control for the
 * native kit, #274).
 *
 * Two MapLibre maps are stacked (the host positions them; the control does
 * not own layout) and the control clips the **top** map against the **bottom**
 * map along a draggable divider via CSS `clip-path`. Dragging the divider (or
 * using the keyboard) reveals more or less of each map and emits a `change`
 * event with the divider position.
 *
 * Like the other controls, this element imports nothing from `maplibre-gl` or
 * the SDK core — it drives any MapLibre `Map` through the duck-typed
 * {@link HonuaSwipeMap} interface (it only needs `getContainer()`), so the
 * `@honua/sdk-js/controls` entry stays bundle-independent. Node imports are
 * safe; the element no-ops without a DOM.
 *
 * ## Wiring
 * - `element.topMap = map` / `element.bottomMap = map`, or
 *   `element.connect(topMap, bottomMap)`. The top map is the one that gets
 *   clipped; the bottom map shows through the revealed region.
 *
 * ## Attributes
 * - `position` — divider position as a percentage 0–100 (default 50).
 * - `orientation` — `"vertical"` (default) or `"horizontal"`.
 * - `label` — optional accessible name of the divider. Supply this from the
 *   host application's message source when the divider needs an accessible
 *   name; the control does not provide a locale-specific fallback.
 *
 * ## Events
 * - `change` — `CustomEvent<HonuaSwipeChangeDetail>` (bubbles, composed)
 *   whenever the divider position changes: drag, keyboard, or programmatic
 *   `position` assignment.
 *
 * ## CSS parts
 * - `divider` — the full-length divider line.
 * - `handle` — the draggable grip on the divider.
 *
 * ## Accessibility
 * The divider is an ARIA slider (`role="slider"`, `aria-valuenow/min/max`,
 * `aria-orientation`) with arrow-key control (ArrowLeft/ArrowRight or
 * ArrowUp/ArrowDown step by 1, Home/End jump to 0/100, with Shift = 10).
 *
 * @module
 */

import { HTMLElementBase, escapeAttribute, globalDom, renderShadowRoot } from "./element-utils.js";
import type { HonuaSwipeChangeDetail, HonuaSwipeMap, HonuaSwipeOrientation } from "./types.js";

const DEFAULT_POSITION = 50;
const STEP = 1;
const STEP_LARGE = 10;

/**
 * Custom element implementing the dual-map swipe/compare divider. Registered
 * as `honua-swipe-control` by {@link defineHonuaSwipeControl} (which runs
 * automatically on import when a `customElements` registry exists).
 */
export class HonuaSwipeControlElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["position", "orientation", "label"];
  }

  #topMap: HonuaSwipeMap | undefined;
  #bottomMap: HonuaSwipeMap | undefined;
  #position = DEFAULT_POSITION;
  #rendered = false;
  #dragging = false;
  #disposeDrag: (() => void) | undefined;

  /** The clipped (overlay) map. Reapplies the clip when assigned. */
  public get topMap(): HonuaSwipeMap | undefined {
    return this.#topMap;
  }

  public set topMap(map: HonuaSwipeMap | undefined) {
    this.#clearClip(this.#topMap);
    this.#topMap = map;
    this.#applyClip();
  }

  /** The underlying map revealed by the clip. */
  public get bottomMap(): HonuaSwipeMap | undefined {
    return this.#bottomMap;
  }

  public set bottomMap(map: HonuaSwipeMap | undefined) {
    this.#bottomMap = map;
  }

  /** Wires both maps at once. The first map is clipped against the second. */
  public connect(topMap: HonuaSwipeMap, bottomMap?: HonuaSwipeMap): void {
    this.topMap = topMap;
    if (bottomMap) this.bottomMap = bottomMap;
  }

  /** Divider position as a percentage 0–100. Reflects the `position` attribute. */
  public get position(): number {
    return this.#position;
  }

  public set position(value: number) {
    this.#setPosition(value, true);
  }

  /** Divider orientation. Reflects the `orientation` attribute. */
  public get orientation(): HonuaSwipeOrientation {
    return this.#attr("orientation") === "horizontal" ? "horizontal" : "vertical";
  }

  public set orientation(value: HonuaSwipeOrientation) {
    if (typeof this.setAttribute !== "function") return;
    this.setAttribute("orientation", value === "horizontal" ? "horizontal" : "vertical");
  }

  /** Accessible name of the divider. Reflects the `label` attribute. */
  public get label(): string | null {
    return this.#label();
  }

  public set label(value: string | null) {
    if (typeof this.setAttribute !== "function") return;
    if (value === null) {
      this.removeAttribute?.("label");
    } else {
      this.setAttribute("label", value);
    }
  }

  public attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "position") {
      const parsed = newValue === null ? DEFAULT_POSITION : Number(newValue);
      if (Number.isFinite(parsed)) this.#setPosition(parsed, false);
      return;
    }
    if (name === "orientation") {
      this.#updateDividerDom();
      this.#applyClip();
      return;
    }
    if (name === "label") {
      this.#updateDividerDom();
    }
  }

  public connectedCallback(): void {
    this.#ensureShadowRoot();
    this.render();
    this.#applyClip();
  }

  public disconnectedCallback(): void {
    this.#disposeDrag?.();
    this.#disposeDrag = undefined;
  }

  // ── position ───────────────────────────────────────────────

  #setPosition(value: number, fromProperty: boolean): void {
    const next = clampPercent(value);
    const changed = next !== this.#position;
    this.#position = next;
    if (fromProperty) this.#reflectPosition(next);
    this.#updateDividerDom();
    this.#applyClip();
    if (changed) this.#dispatchChange();
  }

  // ── clip-path application ──────────────────────────────────

  #applyClip(): void {
    const container = this.#topMap?.getContainer?.();
    if (!container?.style) return;
    const pct = `${this.#position}%`;
    // Reveal the top map only on the trailing side of the divider so the
    // bottom map shows through on the leading side.
    container.style.clipPath =
      this.orientation === "horizontal"
        ? `inset(${pct} 0 0 0)` // hide the top portion above the divider
        : `inset(0 0 0 ${pct})`; // hide the left portion before the divider
  }

  #clearClip(map: HonuaSwipeMap | undefined): void {
    const container = map?.getContainer?.();
    if (container?.style) container.style.clipPath = "";
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
      this.#updateDividerDom();
      return;
    }
    const label = this.#label();
    const ariaLabel = label === null ? "" : ` aria-label="${escapeAttribute(label)}"`;
    renderShadowRoot(
      root,
      structuralStyles(),
      `
      <div
        part="divider"
        class="divider"
        role="slider"
        tabindex="0"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="${this.#position}"
        aria-orientation="${this.orientation}"
        ${ariaLabel}
      >
        <span part="handle" class="handle" aria-hidden="true"></span>
      </div>
    `,
    );
    this.#rendered = true;
    this.#bindDivider(root);
    this.#updateDividerDom();
  }

  #divider(): HTMLElement | null {
    const root = this.shadowRoot;
    if (!root || typeof root.querySelector !== "function") return null;
    return root.querySelector<HTMLElement>(".divider");
  }

  #updateDividerDom(): void {
    const divider = this.#divider();
    if (!divider?.style) return;
    const pct = `${this.#position}%`;
    if (this.orientation === "horizontal") {
      divider.style.left = "0";
      divider.style.top = pct;
    } else {
      divider.style.top = "0";
      divider.style.left = pct;
    }
    divider.classList?.toggle("divider-horizontal", this.orientation === "horizontal");
    divider.setAttribute?.("aria-valuenow", String(this.#position));
    divider.setAttribute?.("aria-orientation", this.orientation);
    const label = this.#label();
    if (label === null) divider.removeAttribute?.("aria-label");
    else divider.setAttribute?.("aria-label", label);
  }

  // ── interaction ────────────────────────────────────────────

  #bindDivider(root: ShadowRoot): void {
    const divider = root.querySelector<HTMLElement>(".divider");
    if (!divider) return;
    divider.addEventListener("pointerdown", (event) => this.#onPointerDown(event as PointerEvent));
    divider.addEventListener("keydown", (event) => this.#onKeyDown(event as KeyboardEvent));
  }

  #onPointerDown(event: PointerEvent): void {
    if (typeof this.getBoundingClientRect !== "function") return;
    this.#dragging = true;
    const divider = this.#divider();
    divider?.setPointerCapture?.(event.pointerId);
    event.preventDefault?.();
    const move = (moveEvent: Event): void => {
      if (this.#dragging) this.#setPositionFromPointer(moveEvent as PointerEvent);
    };
    const up = (upEvent: Event): void => {
      this.#dragging = false;
      divider?.releasePointerCapture?.((upEvent as PointerEvent).pointerId);
      this.#disposeDrag?.();
      this.#disposeDrag = undefined;
    };
    const owner = (divider as EventTarget | null) ?? this;
    owner.addEventListener("pointermove", move as EventListener);
    owner.addEventListener("pointerup", up as EventListener);
    owner.addEventListener("pointercancel", up as EventListener);
    this.#disposeDrag = () => {
      owner.removeEventListener("pointermove", move as EventListener);
      owner.removeEventListener("pointerup", up as EventListener);
      owner.removeEventListener("pointercancel", up as EventListener);
    };
    this.#setPositionFromPointer(event);
  }

  #setPositionFromPointer(event: PointerEvent): void {
    const rect = this.getBoundingClientRect();
    if (!rect) return;
    const ratio =
      this.orientation === "horizontal"
        ? rect.height === 0
          ? 0
          : (event.clientY - rect.top) / rect.height
        : rect.width === 0
          ? 0
          : (event.clientX - rect.left) / rect.width;
    this.#setPosition(ratio * 100, true);
  }

  #onKeyDown(event: KeyboardEvent): void {
    const horizontal = this.orientation === "horizontal";
    const step = event.shiftKey ? STEP_LARGE : STEP;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = this.#position + step;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = this.#position - step;
        break;
      case "Home":
        next = horizontal ? 100 : 0;
        break;
      case "End":
        next = horizontal ? 0 : 100;
        break;
      default:
        return;
    }
    event.preventDefault?.();
    this.#setPosition(next, true);
  }

  // ── helpers ────────────────────────────────────────────────

  #label(): string | null {
    return this.#attr("label");
  }

  #attr(name: string): string | null {
    return typeof this.getAttribute === "function" ? this.getAttribute(name) : null;
  }

  #reflectPosition(value: number): void {
    if (typeof this.setAttribute !== "function" || typeof this.getAttribute !== "function") return;
    const serialized = String(value);
    if (this.getAttribute("position") !== serialized) this.setAttribute("position", serialized);
  }

  #dispatchChange(): void {
    if (!globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    const detail: HonuaSwipeChangeDetail = { position: this.#position, orientation: this.orientation };
    this.dispatchEvent(new globalDom.CustomEvent("change", { bubbles: true, composed: true, detail }));
  }
}

/**
 * Registers the swipe control custom element (`honua-swipe-control`). Invoked
 * automatically on import when a global `customElements` registry is present;
 * call explicitly when using a scoped registry. Skips the registration when
 * the tag is already defined.
 */
export function defineHonuaSwipeControl(registry = globalDom.customElements): void {
  if (!registry) return;
  if (!registry.get("honua-swipe-control")) {
    registry.define("honua-swipe-control", HonuaSwipeControlElement);
  }
}

if (globalDom.customElements) {
  defineHonuaSwipeControl(globalDom.customElements);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_POSITION;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Structural-only styles; theme via `::part(divider)` / `::part(handle)`. */
function structuralStyles(): string {
  return `
    :host { position: absolute; inset: 0; pointer-events: none; display: block; }
    .divider {
      position: absolute;
      top: 0;
      block-size: 100%;
      inline-size: 0;
      border-inline-start: 2px solid currentColor;
      transform: translateX(-1px);
      cursor: ew-resize;
      pointer-events: auto;
      touch-action: none;
    }
    .divider-horizontal {
      inline-size: 100%;
      block-size: 0;
      border-inline-start: none;
      border-block-start: 2px solid currentColor;
      transform: translateY(-1px);
      cursor: ns-resize;
    }
    .handle {
      position: absolute;
      inset-block-start: 50%;
      inset-inline-start: 0;
      inline-size: 1.5em;
      block-size: 1.5em;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: currentColor;
    }
    .divider-horizontal .handle {
      inset-block-start: 0;
      inset-inline-start: 50%;
    }
  `;
}
