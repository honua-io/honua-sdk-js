/**
 * `<honua-time-slider>` — the time-slider UI over the existing temporal
 * playback controller (issue #959, epic #486 "Esri Widget Cliff").
 *
 * Temporal playback has been headless since issue #497: `createTemporalPlayback`
 * (`@honua/sdk-js/map`) owns the window, the frame timer, and the filter sinks
 * that drive the map. This element is the missing *view* over that controller —
 * it introduces no second temporal model, keeps no window state of its own, and
 * never fetches or caches data. Every user gesture becomes one controller call,
 * and every rendered value comes back from the controller's own `tick` /
 * `play` / `pause` / `end` events. Layered over a realtime feed the controller
 * keeps issue #393's snapshot-plus-delta semantics untouched, because the
 * element adds nothing between the controller and its sinks.
 *
 * ## Wiring
 * ```ts doc-test=skip reason="wiring snippet requires an application host"
 * import { createTemporalPlayback } from "@honua/sdk-js/map";
 * import "@honua/sdk-js/web-components";
 *
 * const playback = createTemporalPlayback({ handle: mounted, timeField: "event_time", ... });
 * document.querySelector("honua-time-slider").playback = playback;
 * ```
 *
 * The `playback` property (or the equivalent {@link HonuaTimeSliderElement.connect})
 * accepts anything shaped like {@link HonuaTimeSliderPlayback}; the element
 * never imports the controller module, so the component kit's bundle does not
 * gain the `/map` entrypoint's closure.
 *
 * ## Attributes
 * - `label` — accessible name and heading of the panel.
 * - `unavailable-reason` — honest degraded state: set this when the mounted
 *   source has no usable temporal metadata. The panel still renders, names the
 *   reason, and disables every transport control rather than offering a
 *   scrubber that cannot move anything.
 * - `speeds` — comma-separated playback rate multipliers for the speed control
 *   (default `0.5,1,2,4`). The control is hidden entirely when the bound
 *   controller exposes no `setSpeed`.
 *
 * ## Events
 * - `honua-time-change` — `CustomEvent<HonuaTimeChangeDetail>` whenever the
 *   window moves (controller tick, scrub, step, or keyboard).
 * - `honua-time-playback-change` — `CustomEvent<HonuaTimePlaybackChangeDetail>`
 *   whenever transport or rate changes (play, pause, end, speed, binding).
 *
 * ## Accessibility
 * The scrubber follows the WAI-ARIA slider pattern: `role="slider"` with
 * `aria-valuemin` / `aria-valuemax` / `aria-valuenow` in epoch milliseconds,
 * a human-readable `aria-valuetext` naming the window, `aria-orientation`, and
 * an accessible name derived from the panel label. It is a single tab stop
 * (`tabindex="0"`, pinned to `-1` while degraded) and is operable from the
 * keyboard alone: ArrowRight/ArrowUp step forward, ArrowLeft/ArrowDown step
 * back (mirrored on the inline axis under `dir="rtl"`), PageUp/PageDown move
 * ten steps, Home/End jump to the first/last window. Transport is a
 * `role="group"` of buttons with `aria-pressed` on the play/pause toggle, and
 * the window readout is a `role="status"` live region.
 *
 * Rendering is CSP-safe (`renderCspSafeShadowHtml`) and the shadow tree is
 * built exactly once: state updates mutate the existing nodes in place, so
 * handlers never accumulate, an active drag is never torn out from under the
 * pointer, and the focused control is never replaced. Theme via the shared
 * `--honua-ui-*` custom properties.
 *
 * @module
 */

import { renderCspSafeShadowHtml } from "./csp-styles.js";
import type {
  HonuaComponentStatus,
  HonuaTimeChangeDetail,
  HonuaTimePlaybackChangeDetail,
  HonuaTimeSliderMessages,
  HonuaTimeSliderPlayback,
  HonuaTimeSliderWindow,
} from "./types.js";

const globalDom = globalThis as typeof globalThis & {
  HTMLElement?: typeof HTMLElement;
  CustomEvent?: typeof CustomEvent;
  customElements?: CustomElementRegistry;
  getComputedStyle?: (element: Element) => { direction?: string };
};

const HTMLElementBase: typeof HTMLElement = globalDom.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

const DEFAULT_SPEEDS: readonly number[] = [0.5, 1, 2, 4];
/** Steps moved by PageUp / PageDown, per the WAI-ARIA slider pattern. */
const LARGE_STEP = 10;

type TimeChangeSource = HonuaTimeChangeDetail["source"];

export class HonuaTimeSliderElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label", "unavailable-reason", "speeds"];
  }

  #playback: HonuaTimeSliderPlayback | undefined;
  #subscriptions: { remove(): void }[] = [];
  #messages: HonuaTimeSliderMessages = {};
  #connected = false;
  #shape = "";
  #dragging = false;
  #disposeDrag: (() => void) | undefined;

  // ── binding ────────────────────────────────────────────────

  /** The temporal playback controller this slider drives and reflects. */
  public get playback(): HonuaTimeSliderPlayback | undefined {
    return this.#playback;
  }

  public set playback(playback: HonuaTimeSliderPlayback | undefined) {
    if (this.#playback === playback) return;
    this.#unsubscribe();
    this.#playback = playback;
    if (playback) this.#subscribe(playback);
    this.render();
    this.#dispatchPlaybackChange({});
  }

  /** Binds a playback controller. Equivalent to assigning `.playback`. */
  public connect(playback: HonuaTimeSliderPlayback): void {
    this.playback = playback;
  }

  /** Caller-supplied message source; assigning re-renders the panel text. */
  public get messages(): HonuaTimeSliderMessages {
    return this.#messages;
  }

  public set messages(messages: HonuaTimeSliderMessages | undefined) {
    this.#messages = messages ?? {};
    this.render();
  }

  /**
   * Why playback is unavailable, e.g. the mounted source exposes no temporal
   * field. Reflects the `unavailable-reason` attribute.
   */
  public get unavailableReason(): string | undefined {
    return this.#attr("unavailable-reason") ?? undefined;
  }

  public set unavailableReason(reason: string | undefined) {
    if (typeof this.setAttribute !== "function") return;
    if (reason === undefined || reason === "") this.removeAttribute?.("unavailable-reason");
    else this.setAttribute("unavailable-reason", reason);
  }

  /** Playback rate multipliers offered by the speed control. */
  public get speeds(): readonly number[] {
    const declared = this.#attr("speeds");
    if (!declared) return DEFAULT_SPEEDS;
    const parsed = declared
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry) && entry > 0);
    return parsed.length > 0 ? parsed : DEFAULT_SPEEDS;
  }

  public set speeds(values: readonly number[] | undefined) {
    if (typeof this.setAttribute !== "function") return;
    if (!values || values.length === 0) this.removeAttribute?.("speeds");
    else this.setAttribute("speeds", values.join(","));
  }

  // ── derived state ──────────────────────────────────────────

  /** `unsupported` when a reason is declared, `ready` when bound, else `idle`. */
  public get status(): HonuaComponentStatus {
    if (this.unavailableReason) return "unsupported";
    return this.#playback ? "ready" : "idle";
  }

  /** The controller's current window, when one is bound. */
  public get window(): HonuaTimeSliderWindow | undefined {
    return this.#playback?.window;
  }

  /** The controller's full playable extent, when one is bound. */
  public get extent(): HonuaTimeSliderWindow | undefined {
    return this.#playback?.extent;
  }

  public get playing(): boolean {
    return this.#playback?.playing ?? false;
  }

  public get speed(): number {
    return this.#playback?.speed ?? 1;
  }

  /** Window-start position within the scrubbable range, 0..1. */
  public get progress(): number {
    const min = this.#min();
    const max = this.#max();
    const now = this.#playback?.window.start;
    if (min === undefined || max === undefined || now === undefined || max <= min) return 0;
    return Math.min(1, Math.max(0, (now - min) / (max - min)));
  }

  // ── commands ───────────────────────────────────────────────

  public play(): void {
    if (!this.#operable()) return;
    this.#playback?.play();
  }

  public pause(): void {
    this.#playback?.pause();
  }

  /** Play when paused, pause when playing. */
  public toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Moves the window `count` steps forward (positive) or back (negative). */
  public step(direction: 1 | -1 = 1, count = 1): void {
    const playback = this.#playback;
    if (!playback || !this.#operable()) return;
    const repeats = Math.max(1, Math.trunc(count));
    if (typeof playback.step === "function") {
      for (let index = 0; index < repeats; index += 1) playback.step(direction);
    } else {
      playback.scrub(playback.window.start + direction * this.#stepMs() * repeats);
    }
    this.#afterWindowMove("step");
  }

  /** Jumps the window start to `epochMs`, clamped by the controller. */
  public scrubTo(epochMs: number): void {
    const playback = this.#playback;
    if (!playback || !this.#operable() || !Number.isFinite(epochMs)) return;
    playback.scrub(epochMs);
    this.#afterWindowMove("scrub");
  }

  /** Changes the playback rate multiplier when the controller supports it. */
  public setSpeed(multiplier: number): void {
    const playback = this.#playback;
    if (!playback || typeof playback.setSpeed !== "function") return;
    if (!Number.isFinite(multiplier) || multiplier <= 0) return;
    playback.setSpeed(multiplier);
    this.#sync();
    this.#dispatchPlaybackChange({});
  }

  // ── lifecycle ──────────────────────────────────────────────

  public attributeChangedCallback(): void {
    this.render();
  }

  public connectedCallback(): void {
    this.#connected = true;
    this.#ensureShadowRoot();
    // Reconnecting re-takes exactly the subscriptions disconnect released, so
    // a detach/reattach cycle neither strands a listener nor double-binds.
    if (this.#playback && this.#subscriptions.length === 0) this.#subscribe(this.#playback);
    this.render();
  }

  public disconnectedCallback(): void {
    this.#connected = false;
    this.#disposeDrag?.();
    this.#disposeDrag = undefined;
    this.#dragging = false;
    this.#unsubscribe();
  }

  #subscribe(playback: HonuaTimeSliderPlayback): void {
    this.#subscriptions = [
      playback.on("tick", () => {
        this.#sync();
        this.#dispatchChange("tick");
      }),
      playback.on("play", () => {
        this.#sync();
        this.#dispatchPlaybackChange({});
      }),
      playback.on("pause", () => {
        this.#sync();
        this.#dispatchPlaybackChange({});
      }),
      playback.on("end", () => {
        this.#sync();
        this.#dispatchPlaybackChange({ ended: true });
      }),
    ];
  }

  #unsubscribe(): void {
    for (const subscription of this.#subscriptions.splice(0)) subscription.remove();
  }

  // ── rendering ──────────────────────────────────────────────

  #ensureShadowRoot(): void {
    if (!this.shadowRoot && typeof this.attachShadow === "function") {
      this.attachShadow({ mode: "open" });
    }
  }

  /**
   * Builds the shadow tree once per structural shape, then updates it in place.
   * The shape only changes when the speed control appears/disappears or its
   * options change, so a playback tick never replaces a node — which is what
   * keeps handlers from accumulating and the focused control (or an active
   * pointer drag) intact.
   */
  protected render(): void {
    const root = this.shadowRoot;
    if (!root || !this.#connected) return;
    const shape = `${this.#showSpeed() ? this.speeds.join(",") : "none"}`;
    if (shape !== this.#shape) {
      this.#shape = shape;
      renderCspSafeShadowHtml(root, this.#template());
      this.#bind(root);
    }
    this.#sync();
  }

  #template(): string {
    const speeds = this.#showSpeed()
      ? `
        <label class="speed" part="speed">
          <span data-time-speed-label></span>
          <select data-time-speed>
            ${this.speeds.map((value) => `<option value="${value}"></option>`).join("")}
          </select>
        </label>`
      : "";
    return `
      <style>${structuralStyles()}</style>
      <section class="panel" part="panel">
        <div class="bar">
          <h2 data-time-heading></h2>
          <span class="state" data-time-state></span>
        </div>
        <p class="window" part="window" data-time-window role="status" aria-live="polite"></p>
        <div class="track" part="track">
          <div
            class="slider"
            part="slider"
            data-time-slider
            id="honua-time-slider-scrubber"
            role="slider"
            aria-orientation="horizontal"
          >
            <span class="fill" data-time-fill aria-hidden="true"></span>
            <span class="thumb" part="thumb" data-time-thumb aria-hidden="true"></span>
          </div>
        </div>
        <div class="transport" role="group" data-time-transport>
          <button type="button" part="step" data-time-step="-1"></button>
          <button type="button" part="toggle" data-time-toggle></button>
          <button type="button" part="step" data-time-step="1"></button>
        </div>
        ${speeds}
        <p class="hint" data-time-hint></p>
      </section>
    `;
  }

  #bind(root: ShadowRoot): void {
    const slider = root.querySelector<HTMLElement>("[data-time-slider]");
    slider?.addEventListener("keydown", (event) => this.#onKeyDown(event as KeyboardEvent));
    slider?.addEventListener("pointerdown", (event) => this.#onPointerDown(event as PointerEvent));
    root.querySelector<HTMLButtonElement>("[data-time-toggle]")?.addEventListener("click", () => this.toggle());
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-time-step]")) {
      button.addEventListener("click", () => {
        this.step(button.getAttribute("data-time-step") === "-1" ? -1 : 1);
      });
    }
    const speed = root.querySelector<HTMLSelectElement>("[data-time-speed]");
    speed?.addEventListener("change", () => this.setSpeed(Number(speed.value)));
  }

  /** Updates every rendered value in place. Never replaces a node. */
  #sync(): void {
    const root = this.shadowRoot;
    if (!root || typeof root.querySelector !== "function") return;
    const messages = this.#messages;
    const label = this.#label();
    const status = this.status;
    const operable = this.#operable();
    const playing = this.playing;

    root.querySelector("section")?.setAttribute("aria-label", label);
    setText(root.querySelector("[data-time-heading]"), label);
    setText(root.querySelector("[data-time-state]"), this.#statusText(status));
    setText(root.querySelector("[data-time-window]"), this.#windowText());

    const slider = root.querySelector<HTMLElement>("[data-time-slider]");
    if (slider) {
      const min = this.#min();
      const max = this.#max();
      const now = this.#playback?.window.start;
      slider.setAttribute("aria-label", messages.sliderLabel?.(label) ?? `${label} window start`);
      slider.setAttribute("aria-valuemin", String(min ?? 0));
      slider.setAttribute("aria-valuemax", String(max ?? 0));
      slider.setAttribute("aria-valuenow", String(now ?? min ?? 0));
      slider.setAttribute("aria-valuetext", this.#windowText());
      slider.setAttribute("aria-disabled", String(!operable));
      slider.setAttribute("tabindex", operable ? "0" : "-1");
      const fill = root.querySelector<HTMLElement>("[data-time-fill]");
      const thumb = root.querySelector<HTMLElement>("[data-time-thumb]");
      const percent = `${(this.progress * 100).toFixed(2)}%`;
      if (fill?.style) fill.style.inlineSize = percent;
      if (thumb?.style) thumb.style.insetInlineStart = percent;
    }

    const transport = root.querySelector("[data-time-transport]");
    transport?.setAttribute("aria-label", messages.transportGroupLabel?.(label) ?? `${label} playback`);
    const toggle = root.querySelector<HTMLButtonElement>("[data-time-toggle]");
    if (toggle) {
      setText(toggle, playing ? (messages.pause ?? "Pause") : (messages.play ?? "Play"));
      toggle.setAttribute("aria-pressed", String(playing));
      toggle.disabled = !operable;
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-time-step]")) {
      const backward = button.getAttribute("data-time-step") === "-1";
      setText(button, backward ? (messages.stepBackward ?? "Step back") : (messages.stepForward ?? "Step forward"));
      button.disabled = !operable;
    }

    setText(root.querySelector("[data-time-speed-label]"), messages.speedLabel ?? "Speed");
    const speed = root.querySelector<HTMLSelectElement>("[data-time-speed]");
    if (speed) {
      for (const option of speed.querySelectorAll<HTMLOptionElement>("option")) {
        const multiplier = Number(option.value);
        setText(option, messages.speedOption?.(multiplier) ?? `${multiplier}x`);
      }
      const current = String(this.speed);
      if (speed.value !== current && this.speeds.some((value) => String(value) === current)) speed.value = current;
      speed.disabled = !operable;
    }

    setText(
      root.querySelector("[data-time-hint]"),
      messages.hint ??
        "Arrow keys step the window, Page Up and Page Down move ten steps, Home and End jump to the ends.",
    );
  }

  #statusText(status: HonuaComponentStatus): string {
    const declared = this.#messages.status?.[status];
    if (declared) return declared;
    if (status === "unsupported") return "unavailable";
    if (status === "idle") return "no playback";
    return "ready";
  }

  #windowText(): string {
    const reason = this.unavailableReason;
    if (reason) return this.#messages.unavailable?.(reason) ?? reason;
    const window = this.#playback?.window;
    if (!window) return this.#messages.noPlayback ?? "Bind a temporal playback controller to scrub time.";
    const format = this.#messages.instant ?? formatInstant;
    const start = format(window.start);
    const end = format(window.end);
    return this.#messages.window?.(start, end) ?? `${start} to ${end}`;
  }

  // ── interaction ────────────────────────────────────────────

  #onKeyDown(event: KeyboardEvent): void {
    if (!this.#operable()) return;
    const mirrored = this.#isRtl();
    let handled = true;
    switch (event.key) {
      case "ArrowRight":
        this.#keyboardStep(mirrored ? -1 : 1, 1);
        break;
      case "ArrowUp":
        this.#keyboardStep(1, 1);
        break;
      case "ArrowLeft":
        this.#keyboardStep(mirrored ? 1 : -1, 1);
        break;
      case "ArrowDown":
        this.#keyboardStep(-1, 1);
        break;
      case "PageUp":
        this.#keyboardStep(1, LARGE_STEP);
        break;
      case "PageDown":
        this.#keyboardStep(-1, LARGE_STEP);
        break;
      case "Home":
        this.#keyboardScrub(this.#min());
        break;
      case "End":
        this.#keyboardScrub(this.#max());
        break;
      default:
        handled = false;
        break;
    }
    if (handled) event.preventDefault?.();
  }

  #keyboardStep(direction: 1 | -1, count: number): void {
    const playback = this.#playback;
    if (!playback) return;
    const repeats = Math.max(1, Math.trunc(count));
    if (typeof playback.step === "function") {
      for (let index = 0; index < repeats; index += 1) playback.step(direction);
    } else {
      playback.scrub(playback.window.start + direction * this.#stepMs() * repeats);
    }
    this.#afterWindowMove("keyboard");
  }

  #keyboardScrub(time: number | undefined): void {
    if (time === undefined || !this.#playback) return;
    this.#playback.scrub(time);
    this.#afterWindowMove("keyboard");
  }

  #onPointerDown(event: PointerEvent): void {
    if (!this.#operable() || typeof this.getBoundingClientRect !== "function") return;
    const slider = this.shadowRoot?.querySelector<HTMLElement>("[data-time-slider]");
    if (!slider) return;
    this.#dragging = true;
    slider.setPointerCapture?.(event.pointerId);
    event.preventDefault?.();
    const move = (moveEvent: Event): void => {
      if (this.#dragging) this.#scrubFromPointer(slider, moveEvent as PointerEvent);
    };
    const up = (upEvent: Event): void => {
      this.#dragging = false;
      slider.releasePointerCapture?.((upEvent as PointerEvent).pointerId);
      this.#disposeDrag?.();
      this.#disposeDrag = undefined;
    };
    slider.addEventListener("pointermove", move as EventListener);
    slider.addEventListener("pointerup", up as EventListener);
    slider.addEventListener("pointercancel", up as EventListener);
    this.#disposeDrag = () => {
      slider.removeEventListener("pointermove", move as EventListener);
      slider.removeEventListener("pointerup", up as EventListener);
      slider.removeEventListener("pointercancel", up as EventListener);
    };
    this.#scrubFromPointer(slider, event);
  }

  #scrubFromPointer(slider: HTMLElement, event: PointerEvent): void {
    const rect = slider.getBoundingClientRect?.();
    const min = this.#min();
    const max = this.#max();
    if (!rect || !rect.width || min === undefined || max === undefined) return;
    const raw = (event.clientX - rect.left) / rect.width;
    const fraction = Math.min(1, Math.max(0, this.#isRtl() ? 1 - raw : raw));
    this.#playback?.scrub(min + fraction * (max - min));
    this.#afterWindowMove("scrub");
  }

  // ── helpers ────────────────────────────────────────────────

  /**
   * Controller sinks are asynchronous, so `tick` lands a turn later. Sync now
   * so the rendered value tracks the gesture, and report the gesture's own
   * source rather than letting it surface as an anonymous `tick`.
   */
  #afterWindowMove(source: TimeChangeSource): void {
    this.#sync();
    this.#dispatchChange(source);
  }

  #operable(): boolean {
    return this.#playback !== undefined && !this.unavailableReason;
  }

  #showSpeed(): boolean {
    return typeof this.#playback?.setSpeed === "function";
  }

  #stepMs(): number {
    const playback = this.#playback;
    if (!playback) return 0;
    const declared = playback.stepMs;
    if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) return declared;
    return Math.max(1, playback.window.end - playback.window.start);
  }

  #min(): number | undefined {
    return this.#playback?.extent.start;
  }

  /** The last window start that still fits inside the extent. */
  #max(): number | undefined {
    const playback = this.#playback;
    if (!playback) return undefined;
    const windowMs = playback.window.end - playback.window.start;
    return Math.max(playback.extent.start, playback.extent.end - windowMs);
  }

  #label(): string {
    return this.#messages.label ?? this.#attr("label") ?? "Time";
  }

  #attr(name: string): string | null {
    return typeof this.getAttribute === "function" ? this.getAttribute(name) : null;
  }

  #isRtl(): boolean {
    const explicit = this.#attr("dir")?.toLowerCase();
    if (explicit === "rtl") return true;
    if (explicit === "ltr") return false;
    return globalDom.getComputedStyle?.(this as unknown as Element)?.direction === "rtl";
  }

  #dispatchChange(source: TimeChangeSource): void {
    const window = this.#playback?.window;
    if (!window || !globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    const detail: HonuaTimeChangeDetail = {
      window,
      progress: this.progress,
      playing: this.playing,
      speed: this.speed,
      status: this.status,
      source,
    };
    this.dispatchEvent(new globalDom.CustomEvent("honua-time-change", { bubbles: true, composed: true, detail }));
  }

  #dispatchPlaybackChange(extra: { ended?: boolean }): void {
    if (!globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    const reason = this.unavailableReason;
    const detail: HonuaTimePlaybackChangeDetail = {
      playing: this.playing,
      speed: this.speed,
      status: this.status,
      ...(extra.ended ? { ended: true } : {}),
      ...(reason ? { reason } : {}),
    };
    this.dispatchEvent(
      new globalDom.CustomEvent("honua-time-playback-change", { bubbles: true, composed: true, detail }),
    );
  }
}

/** Registers `<honua-time-slider>`; skipped when the tag is already defined. */
export function defineHonuaTimeSlider(registry = globalDom.customElements): void {
  if (!registry) return;
  if (!registry.get("honua-time-slider")) {
    registry.define("honua-time-slider", HonuaTimeSliderElement);
  }
}

function setText(node: Element | null | undefined, value: string): void {
  if (node && node.textContent !== value) node.textContent = value;
}

/** Locale-neutral default instant format; override with `messages.instant`. */
function formatInstant(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "";
  return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Structural styles themable via the shared `--honua-ui-*` custom properties.
 * Deliberately declares no transition, animation, or keyframes: the element
 * owns no motion, so there is nothing for `prefers-reduced-motion` to suppress.
 */
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
      direction: inherit;
      display: block;
      font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :host([dir="rtl"]) { direction: rtl; }
    *, *::before, *::after { box-sizing: inherit; }
    button {
      border: 1px solid var(--honua-ui-border);
      background: var(--honua-ui-bg);
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      font: inherit;
      min-height: 32px;
      padding-block: 0;
      padding-inline: 10px;
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
      min-width: 200px;
      padding-block: 10px;
      padding-inline: 10px;
      text-align: start;
    }
    .bar { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .state { color: var(--honua-ui-muted); font-size: 12px; }
    .window { margin: 0; overflow-wrap: anywhere; }
    .track { display: block; min-width: 0; padding-block: 4px; }
    .slider {
      background: var(--honua-ui-border);
      block-size: 6px;
      border-radius: 3px;
      cursor: pointer;
      inline-size: 100%;
      max-inline-size: 100%;
      position: relative;
      touch-action: none;
    }
    .slider[aria-disabled="true"] { cursor: not-allowed; opacity: 0.55; }
    .slider:focus-visible { outline: 2px solid var(--honua-ui-accent); outline-offset: 3px; }
    .fill {
      background: var(--honua-ui-accent);
      block-size: 100%;
      border-radius: 3px;
      display: block;
      inline-size: 0%;
      max-inline-size: 100%;
    }
    .thumb {
      background: var(--honua-ui-accent);
      block-size: 16px;
      border: 2px solid var(--honua-ui-bg);
      border-radius: 50%;
      display: block;
      inline-size: 16px;
      inset-block-start: -5px;
      inset-inline-start: 0%;
      position: absolute;
      transform: translateX(-50%);
    }
    :host([dir="rtl"]) .thumb { transform: translateX(50%); }
    .transport { display: grid; gap: 6px; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); }
    .transport button { min-width: 0; overflow-wrap: anywhere; white-space: normal; }
    .speed { align-items: center; display: flex; gap: 8px; }
    .speed select { flex: 1 1 auto; font: inherit; min-width: 0; }
    .hint { color: var(--honua-ui-muted); font-size: 12px; margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 320px) {
      .panel { min-width: 0; }
      .bar { align-items: flex-start; flex-direction: column; }
      .transport { grid-template-columns: minmax(0, 1fr); }
      .transport button { inline-size: 100%; }
      .speed { align-items: flex-start; flex-direction: column; }
      .speed select { inline-size: 100%; }
    }
    @media (forced-colors: active), (prefers-contrast: more) {
      .panel { background: Canvas; border-color: CanvasText; color: CanvasText; }
      .state, .hint { color: GrayText; }
      button { background: ButtonFace; border-color: ButtonText; color: ButtonText; }
      button[aria-pressed="true"] { background: Highlight; border-color: Highlight; color: HighlightText; }
      button:disabled { color: GrayText; }
      button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
      .slider { background: Canvas; border: 1px solid ButtonText; forced-color-adjust: none; }
      .fill { background: Highlight; }
      .thumb { background: ButtonText; border-color: Canvas; }
      .slider:focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }
      .slider[aria-disabled="true"] { border-color: GrayText; }
    }
  `;
}
