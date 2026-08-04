// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTemporalPlayback } from "../src/map/index.js";
import type {
  HonuaTimeChangeDetail,
  HonuaTimePlaybackChangeDetail,
  HonuaTimeSliderPlayback,
} from "../src/web-components/index.js";
import { type HonuaTimeSliderElement, defineHonuaWebComponents } from "../src/web-components/index.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-06-01T00:00:00Z");
const END = START + 30 * DAY;

/**
 * Widest listener shape that still satisfies every `HonuaTimeSliderPlayback.on`
 * overload under strict function-parameter variance.
 */
type TickListener = (payload: { window: { start: number; end: number } }) => void;

/**
 * Extending the shipped contract keeps the double honest: the element's
 * `playback` setter type-checks this object exactly as it does a real
 * controller, so a contract change breaks the suite instead of silently
 * passing through a cast.
 */
interface FakePlayback extends HonuaTimeSliderPlayback {
  playing: boolean;
  window: { start: number; end: number };
  extent: { start: number; end: number };
  stepMs: number;
  speed: number;
  step(direction?: 1 | -1): void;
  setSpeed(multiplier: number): void;
  /** Test-only: live listener count, for the disposal assertions. */
  listenerCount(): number;
  /** Test-only: emits a controller event to every subscriber. */
  emit(type: string): void;
  /** Test-only: per-method invocation counts. */
  readonly calls: { play: number; pause: number; scrub: number[]; step: number[]; setSpeed: number[] };
}

function createFakePlayback(options: { withSpeed?: boolean } = {}): FakePlayback {
  const listeners = new Map<string, Set<TickListener>>();
  const calls = { play: 0, pause: 0, scrub: [] as number[], step: [] as number[], setSpeed: [] as number[] };
  const playback: FakePlayback = {
    playing: false,
    window: { start: START + 5 * DAY, end: START + 6 * DAY },
    extent: { start: START, end: END },
    stepMs: DAY,
    speed: 1,
    play() {
      calls.play += 1;
      playback.playing = true;
      playback.emit("play");
    },
    pause() {
      calls.pause += 1;
      playback.playing = false;
      playback.emit("pause");
    },
    scrub(time: number) {
      calls.scrub.push(time);
      const span = playback.window.end - playback.window.start;
      const clamped = Math.min(Math.max(time, playback.extent.start), playback.extent.end - span);
      playback.window = { start: clamped, end: clamped + span };
    },
    step(direction: 1 | -1 = 1) {
      calls.step.push(direction);
      playback.scrub(playback.window.start + direction * playback.stepMs);
      calls.scrub.pop();
    },
    setSpeed(multiplier: number) {
      calls.setSpeed.push(multiplier);
      playback.speed = multiplier;
    },
    on(type: string, listener: TickListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
      return {
        remove: () => {
          set.delete(listener);
        },
      };
    },
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ window: playback.window });
    },
    calls,
  };
  if (options.withSpeed === false) {
    (playback as { setSpeed?: unknown }).setSpeed = undefined;
  }
  return playback;
}

function mount(playback?: FakePlayback): HonuaTimeSliderElement {
  defineHonuaWebComponents();
  const element = document.createElement("honua-time-slider") as HonuaTimeSliderElement;
  element.setAttribute("label", "Incident time");
  document.body.append(element);
  if (playback) element.playback = playback;
  return element;
}

function shadow(element: HonuaTimeSliderElement): ShadowRoot {
  if (!element.shadowRoot) throw new Error("missing shadow root");
  return element.shadowRoot;
}

function slider(element: HonuaTimeSliderElement): HTMLElement {
  const node = shadow(element).querySelector<HTMLElement>("[data-time-slider]");
  if (!node) throw new Error("missing scrubber");
  return node;
}

function pressKey(element: HonuaTimeSliderElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  slider(element).dispatchEvent(event);
  return event;
}

function styles(element: HonuaTimeSliderElement): string {
  return shadow(element).querySelector("style")?.textContent ?? "";
}

describe("<honua-time-slider>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  // ── screen-reader semantics ────────────────────────────────

  it("renders the WAI-ARIA slider contract over the bound controller", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const scrubber = slider(element);

    expect(shadow(element).querySelector("section")?.getAttribute("aria-label")).toBe("Incident time");
    expect(shadow(element).querySelector("h2")?.textContent).toBe("Incident time");
    expect(scrubber.getAttribute("role")).toBe("slider");
    expect(scrubber.getAttribute("aria-orientation")).toBe("horizontal");
    expect(scrubber.getAttribute("aria-label")).toBe("Incident time window start");
    expect(scrubber.getAttribute("aria-valuemin")).toBe(String(START));
    // The last window start that still fits inside the extent, not the extent end.
    expect(scrubber.getAttribute("aria-valuemax")).toBe(String(END - DAY));
    expect(scrubber.getAttribute("aria-valuenow")).toBe(String(START + 5 * DAY));
    expect(scrubber.getAttribute("aria-valuetext")).toBe("2026-06-06 00:00 to 2026-06-07 00:00");
    expect(scrubber.getAttribute("aria-disabled")).toBe("false");
    // Pinned rather than inferred: jsdom does not model focusability.
    expect(scrubber.getAttribute("tabindex")).toBe("0");

    const transport = shadow(element).querySelector("[role='group']");
    expect(transport?.getAttribute("aria-label")).toBe("Incident time playback");
    expect(shadow(element).querySelector("[data-time-toggle]")?.getAttribute("aria-pressed")).toBe("false");
    const readout = shadow(element).querySelector("[data-time-window]");
    expect(readout?.getAttribute("role")).toBe("status");
    expect(readout?.getAttribute("aria-live")).toBe("polite");
  });

  it("reports the window and playing state through aria after a tick", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    playback.play();
    playback.scrub(START + 9 * DAY);
    playback.emit("tick");

    expect(slider(element).getAttribute("aria-valuenow")).toBe(String(START + 9 * DAY));
    expect(slider(element).getAttribute("aria-valuetext")).toBe("2026-06-10 00:00 to 2026-06-11 00:00");
    expect(shadow(element).querySelector("[data-time-toggle]")?.getAttribute("aria-pressed")).toBe("true");
    expect(shadow(element).querySelector("[data-time-toggle]")?.textContent).toBe("Pause");
  });

  // ── degraded states ────────────────────────────────────────

  it("renders an honest degraded panel with no controller bound", () => {
    const element = mount();
    expect(element.status).toBe("idle");
    expect(shadow(element).querySelector("[data-time-window]")?.textContent).toBe(
      "Bind a temporal playback controller to scrub time.",
    );
    expect(shadow(element).querySelector("[data-time-state]")?.textContent).toBe("no playback");
    expect(slider(element).getAttribute("aria-disabled")).toBe("true");
    expect(slider(element).getAttribute("tabindex")).toBe("-1");
    expect(shadow(element).querySelector<HTMLButtonElement>("[data-time-toggle]")?.disabled).toBe(true);
    // No controller means no speed affordance rather than one that does nothing.
    expect(shadow(element).querySelector("[data-time-speed]")).toBeNull();
  });

  it("names the reason and refuses to operate when the source has no temporal metadata", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    element.unavailableReason = "The incidents source exposes no time field.";

    expect(element.status).toBe("unsupported");
    expect(shadow(element).querySelector("[data-time-window]")?.textContent).toBe(
      "The incidents source exposes no time field.",
    );
    expect(shadow(element).querySelector("[data-time-state]")?.textContent).toBe("unavailable");
    expect(slider(element).getAttribute("aria-disabled")).toBe("true");
    expect(slider(element).getAttribute("tabindex")).toBe("-1");

    const event = pressKey(element, "ArrowRight");
    element.play();
    element.step(1);
    expect(event.defaultPrevented).toBe(false);
    expect(playback.calls).toMatchObject({ play: 0, step: [] });
  });

  it("hides the speed control when the controller cannot change rate", () => {
    const playback = createFakePlayback({ withSpeed: false });
    const element = mount(playback);
    expect(shadow(element).querySelector("[data-time-speed]")).toBeNull();
    expect(shadow(element).querySelector("[data-time-toggle]")).not.toBeNull();
  });

  // ── keyboard behavior (real key events) ────────────────────

  it("drives the controller from the full WAI-ARIA slider key set", () => {
    const playback = createFakePlayback();
    const element = mount(playback);

    expect(pressKey(element, "ArrowRight").defaultPrevented).toBe(true);
    expect(playback.window.start).toBe(START + 6 * DAY);
    pressKey(element, "ArrowUp");
    expect(playback.window.start).toBe(START + 7 * DAY);
    pressKey(element, "ArrowLeft");
    expect(playback.window.start).toBe(START + 6 * DAY);
    pressKey(element, "ArrowDown");
    expect(playback.window.start).toBe(START + 5 * DAY);

    pressKey(element, "PageUp");
    expect(playback.window.start).toBe(START + 15 * DAY);
    pressKey(element, "PageDown");
    expect(playback.window.start).toBe(START + 5 * DAY);

    pressKey(element, "Home");
    expect(playback.window.start).toBe(START);
    pressKey(element, "End");
    expect(playback.window.start).toBe(END - DAY);

    expect(slider(element).getAttribute("aria-valuenow")).toBe(String(END - DAY));
  });

  it("leaves keys it does not own to the page", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const event = pressKey(element, "Tab");
    expect(event.defaultPrevented).toBe(false);
    expect(playback.calls.step).toEqual([]);
    expect(playback.calls.scrub).toEqual([]);
  });

  it("falls back to scrubbing when the controller exposes no step()", () => {
    const playback = createFakePlayback();
    (playback as { step?: unknown }).step = undefined;
    const element = mount(playback);
    pressKey(element, "ArrowRight");
    expect(playback.calls.scrub).toEqual([START + 6 * DAY]);
  });

  // ── transport ──────────────────────────────────────────────

  it("toggles play and pause from one button and steps from the transport row", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const toggle = shadow(element).querySelector<HTMLButtonElement>("[data-time-toggle]");

    toggle?.click();
    expect(playback.calls.play).toBe(1);
    expect(toggle?.textContent).toBe("Pause");
    toggle?.click();
    expect(playback.calls.pause).toBe(1);
    expect(toggle?.textContent).toBe("Play");

    shadow(element).querySelector<HTMLButtonElement>("[data-time-step='1']")?.click();
    shadow(element).querySelector<HTMLButtonElement>("[data-time-step='-1']")?.click();
    expect(playback.calls.step).toEqual([1, -1]);
  });

  it("changes the controller rate from the speed control", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const speed = shadow(element).querySelector<HTMLSelectElement>("[data-time-speed]");
    if (!speed) throw new Error("missing speed control");
    expect([...speed.options].map((option) => option.value)).toEqual(["0.5", "1", "2", "4"]);
    expect([...speed.options].map((option) => option.textContent)).toEqual(["0.5x", "1x", "2x", "4x"]);
    expect(speed.value).toBe("1");

    speed.value = "2";
    speed.dispatchEvent(new Event("change"));
    expect(playback.calls.setSpeed).toEqual([2]);
    expect(element.speed).toBe(2);
  });

  it("honors a caller-supplied speed list", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    element.speeds = [1, 8];
    const speed = shadow(element).querySelector<HTMLSelectElement>("[data-time-speed]");
    expect([...(speed?.options ?? [])].map((option) => option.value)).toEqual(["1", "8"]);
  });

  // ── events ─────────────────────────────────────────────────

  it("emits honua-time-change with the moving source and honua-time-playback-change for transport", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const changes: HonuaTimeChangeDetail[] = [];
    const transport: HonuaTimePlaybackChangeDetail[] = [];
    element.addEventListener("honua-time-change", (event) => {
      changes.push((event as CustomEvent<HonuaTimeChangeDetail>).detail);
    });
    element.addEventListener("honua-time-playback-change", (event) => {
      transport.push((event as CustomEvent<HonuaTimePlaybackChangeDetail>).detail);
    });

    element.step(1);
    element.scrubTo(START + 2 * DAY);
    pressKey(element, "ArrowRight");
    playback.emit("tick");
    expect(changes.map((change) => change.source)).toEqual(["step", "scrub", "keyboard", "tick"]);
    expect(changes.at(-1)).toMatchObject({ playing: false, speed: 1, status: "ready" });
    expect(changes.at(-1)?.window.start).toBe(START + 3 * DAY);

    playback.play();
    playback.pause();
    playback.emit("end");
    expect(transport.map((entry) => entry.playing)).toEqual([true, false, false]);
    expect(transport.at(-1)?.ended).toBe(true);
  });

  // ── focus + duplicate listeners ────────────────────────────

  it("keeps the focused scrubber and its node identity across state updates", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const scrubber = slider(element);
    scrubber.focus();
    expect(shadow(element).activeElement).toBe(scrubber);

    playback.emit("tick");
    element.setSpeed(2);
    element.messages = { label: "Zeitachse" };
    playback.emit("tick");

    expect(slider(element)).toBe(scrubber);
    expect(shadow(element).activeElement).toBe(scrubber);
    expect(shadow(element).querySelector("h2")?.textContent).toBe("Zeitachse");
  });

  it("does not accumulate handlers across repeated state updates", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const changes: HonuaTimeChangeDetail[] = [];
    element.addEventListener("honua-time-change", (event) => {
      changes.push((event as CustomEvent<HonuaTimeChangeDetail>).detail);
    });
    for (let index = 0; index < 10; index += 1) playback.emit("tick");
    element.messages = { label: "Incident time" };
    changes.length = 0;

    shadow(element).querySelector<HTMLButtonElement>("[data-time-toggle]")?.click();
    expect(playback.calls.play).toBe(1);
    pressKey(element, "ArrowRight");
    expect(playback.calls.step).toEqual([1]);
    // Exactly one window-change event per interaction, not one per past render.
    expect(changes).toHaveLength(1);
  });

  // ── disposal ───────────────────────────────────────────────

  it("releases every controller subscription on disconnect and re-takes them once on reconnect", () => {
    const playback = createFakePlayback();
    const element = mount(playback);
    const bound = playback.listenerCount();
    expect(bound).toBeGreaterThan(0);

    element.remove();
    expect(playback.listenerCount()).toBe(0);
    const before = shadow(element).innerHTML;
    playback.emit("tick");
    expect(shadow(element).innerHTML).toBe(before);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      document.body.append(element);
      expect(playback.listenerCount()).toBe(bound);
      element.remove();
      expect(playback.listenerCount()).toBe(0);
    }
  });

  it("releases the previous controller when a second one is bound", () => {
    const first = createFakePlayback();
    const second = createFakePlayback();
    const element = mount(first);
    expect(first.listenerCount()).toBeGreaterThan(0);
    element.playback = second;
    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBeGreaterThan(0);
  });

  // ── real controller binding ────────────────────────────────

  it("binds the real createTemporalPlayback controller and drives its window", async () => {
    const applied: number[] = [];
    const playback = createTemporalPlayback({
      extent: [START, END],
      windowMs: 2 * DAY,
      stepMs: DAY,
      apply: (window) => {
        applied.push(window.start);
      },
    });
    try {
      const element = mount();
      // Structural assignability: the shipped controller satisfies the
      // element's duck-typed `HonuaTimeSliderPlayback` contract.
      element.playback = playback;
      expect(element.status).toBe("ready");
      expect(slider(element).getAttribute("aria-valuemax")).toBe(String(END - 2 * DAY));

      pressKey(element, "ArrowRight");
      await Promise.resolve();
      expect(playback.window.start).toBe(START + DAY);
      expect(applied.at(-1)).toBe(START + DAY);

      const speed = shadow(element).querySelector<HTMLSelectElement>("[data-time-speed]");
      if (!speed) throw new Error("missing speed control");
      speed.value = "4";
      speed.dispatchEvent(new Event("change"));
      expect(playback.speed).toBe(4);

      pressKey(element, "End");
      await Promise.resolve();
      expect(playback.window.start).toBe(END - 2 * DAY);
      expect(element.progress).toBe(1);
    } finally {
      playback.dispose();
    }
  });

  // ── emitted styles ─────────────────────────────────────────

  it("declares forced-colors and prefers-contrast rules for the panel and the scrubber", () => {
    const element = mount(createFakePlayback());
    const css = styles(element);
    expect(css).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(css).toContain(".panel { background: Canvas; border-color: CanvasText; color: CanvasText; }");
    expect(css).toContain(".state, .hint { color: GrayText; }");
    expect(css).toContain("button { background: ButtonFace; border-color: ButtonText; color: ButtonText; }");
    expect(css).toContain(
      'button[aria-pressed="true"] { background: Highlight; border-color: Highlight; color: HighlightText; }',
    );
    expect(css).toContain("button:disabled { color: GrayText; }");
    expect(css).toContain(".slider { background: Canvas; border: 1px solid ButtonText; forced-color-adjust: none; }");
    expect(css).toContain(".fill { background: Highlight; }");
    expect(css).toContain(".thumb { background: ButtonText; border-color: Canvas; }");
    expect(css).toContain(".slider:focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }");
    expect(css).toContain('.slider[aria-disabled="true"] { border-color: GrayText; }');
  });

  it("declares narrow-container rules that stack the transport and speed rows", () => {
    const element = mount(createFakePlayback());
    const css = styles(element);
    expect(css).toContain("@media (max-width: 320px)");
    expect(css).toContain(".panel { min-width: 0; }");
    expect(css).toContain(".bar { align-items: flex-start; flex-direction: column; }");
    expect(css).toContain(".transport { grid-template-columns: minmax(0, 1fr); }");
    expect(css).toContain(".transport button { inline-size: 100%; }");
    expect(css).toContain(".speed { align-items: flex-start; flex-direction: column; }");
    expect(css).toContain(".speed select { inline-size: 100%; }");
    expect(css).toContain("max-inline-size: 100%;");
    // No motion to suppress: the reduced-motion row depends on this staying true.
    expect(css).not.toContain("transition:");
    expect(css).not.toContain("animation:");
  });

  // ── console hygiene ────────────────────────────────────────

  it("emits no console error or warning across its whole lifecycle", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const playback = createFakePlayback();
      const element = mount();
      element.playback = playback;
      element.play();
      element.step(1);
      element.scrubTo(START + DAY);
      element.setSpeed(2);
      playback.emit("tick");
      element.unavailableReason = "No temporal metadata.";
      element.unavailableReason = undefined;
      element.playback = undefined;
      element.remove();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
