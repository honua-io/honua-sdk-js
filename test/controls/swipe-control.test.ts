import { describe, expect, test } from "vitest";

import { HonuaSwipeControlElement, defineHonuaSwipeControl } from "../../src/controls/swipe-control.js";
import type { HonuaSwipeChangeDetail, HonuaSwipeMap } from "../../src/controls/types.js";

/**
 * Headless DOM stubs for the swipe control, mirroring the stub posture of
 * test/controls/basemap-switcher.test.ts (no jsdom: the controls entry runs
 * under Node and the element no-ops without a DOM, so the test supplies the
 * minimal surface it touches — a shadow root with a divider element, a
 * bounding rect, attributes, and event capture).
 */

interface DividerStub {
  style: Record<string, string>;
  attributes: Map<string, string>;
  classList: { toggle(name: string, force?: boolean): void; has(name: string): boolean };
  classes: Set<string>;
  listeners: Map<string, ((event: unknown) => void)[]>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  setPointerCapture(): void;
  releasePointerCapture(): void;
  emit(type: string, event: unknown): void;
}

function makeDivider(): DividerStub {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  return {
    style: {},
    attributes,
    classes,
    classList: {
      toggle(name: string, force?: boolean) {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
      },
      has: (name: string) => classes.has(name),
    },
    listeners,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    removeEventListener(type, listener) {
      const existing = listeners.get(type);
      if (!existing) return;
      listeners.set(
        type,
        existing.filter((entry) => entry !== listener),
      );
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function makeMap(): HonuaSwipeMap & { container: { style: Record<string, string> } } {
  const container = { style: {} as Record<string, string> };
  return { container, getContainer: () => container as unknown as HTMLElement };
}

function makeElement(): {
  element: HonuaSwipeControlElement;
  divider: DividerStub;
  attributes: Map<string, string>;
  events: CustomEvent<HonuaSwipeChangeDetail>[];
  rect: { left: number; top: number; width: number; height: number };
} {
  const element = new HonuaSwipeControlElement();
  const attributes = new Map<string, string>();
  const events: CustomEvent<HonuaSwipeChangeDetail>[] = [];
  const divider = makeDivider();
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  const shadow = {
    set innerHTML(_value: string) {
      /* rendered string is irrelevant; the divider stub is resolved below */
    },
    querySelector: (selector: string) => (selector === ".divider" ? divider : null),
  };
  Object.assign(element, {
    shadowRoot: shadow,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    dispatchEvent: (event: Event) => {
      events.push(event as CustomEvent<HonuaSwipeChangeDetail>);
      return true;
    },
  });
  // Drive the same lifecycle the browser would (shadow root already supplied).
  element.connectedCallback();
  return { element, divider, attributes, events, rect };
}

describe("HonuaSwipeControlElement", () => {
  test("defaults to a 50% vertical divider and positions it", () => {
    const { element, divider } = makeElement();
    expect(element.position).toBe(50);
    expect(element.orientation).toBe("vertical");
    expect(divider.style.left).toBe("50%");
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
  });

  test("clips the top map and leaves the bottom map untouched", () => {
    const { element } = makeElement();
    const top = makeMap();
    const bottom = makeMap();
    element.connect(top, bottom);

    expect(top.container.style.clipPath).toBe("inset(0 0 0 50%)");
    expect(bottom.container.style.clipPath).toBeUndefined();
  });

  test("setting position reapplies the clip, reflects the attribute, and emits change", () => {
    const { element, attributes, events } = makeElement();
    const top = makeMap();
    element.topMap = top;

    element.position = 25;

    expect(element.position).toBe(25);
    expect(top.container.style.clipPath).toBe("inset(0 0 0 25%)");
    expect(attributes.get("position")).toBe("25");
    expect(events.at(-1)?.type).toBe("change");
    expect(events.at(-1)?.detail).toEqual({ position: 25, orientation: "vertical" });
  });

  test("clamps the position to the 0–100 range", () => {
    const { element } = makeElement();
    element.position = 250;
    expect(element.position).toBe(100);
    element.position = -10;
    expect(element.position).toBe(0);
  });

  test("dragging the divider updates the clip and emits change", () => {
    const { element, divider, events } = makeElement();
    const top = makeMap();
    element.topMap = top;

    // rect is 200px wide starting at left=0; clientX=150 => 75%.
    divider.emit("pointerdown", { pointerId: 1, clientX: 150, clientY: 0, preventDefault() {} });

    expect(element.position).toBe(75);
    expect(top.container.style.clipPath).toBe("inset(0 0 0 75%)");
    expect(events.at(-1)?.detail.position).toBe(75);

    // Continue dragging to 25% then release.
    divider.emit("pointermove", { pointerId: 1, clientX: 50, clientY: 0 });
    expect(element.position).toBe(25);
    divider.emit("pointerup", { pointerId: 1, clientX: 50, clientY: 0 });
    // After release, further moves are ignored.
    divider.emit("pointermove", { pointerId: 1, clientX: 100, clientY: 0 });
    expect(element.position).toBe(25);
  });

  test("arrow keys step the divider and emit change", () => {
    const { element, divider, events } = makeElement();
    divider.emit("keydown", { key: "ArrowRight", preventDefault() {} });
    expect(element.position).toBe(51);
    divider.emit("keydown", { key: "ArrowLeft", shiftKey: true, preventDefault() {} });
    expect(element.position).toBe(41);
    divider.emit("keydown", { key: "Home", preventDefault() {} });
    expect(element.position).toBe(0);
    divider.emit("keydown", { key: "End", preventDefault() {} });
    expect(element.position).toBe(100);
    expect(events.at(-1)?.detail.position).toBe(100);
  });

  test("horizontal orientation clips along the top edge and drags vertically", () => {
    const { element, divider } = makeElement();
    const top = makeMap();
    element.topMap = top;
    element.orientation = "horizontal";
    element.attributeChangedCallback("orientation", null, "horizontal");

    expect(element.orientation).toBe("horizontal");
    expect(top.container.style.clipPath).toBe("inset(50% 0 0 0)");
    expect(divider.classList.has("divider-horizontal")).toBe(true);

    // rect is 100px tall starting at top=0; clientY=20 => 20%.
    divider.emit("pointerdown", { pointerId: 1, clientX: 0, clientY: 20, preventDefault() {} });
    expect(element.position).toBe(20);
    expect(top.container.style.clipPath).toBe("inset(20% 0 0 0)");
  });

  test("reassigning the top map clears the previous map's clip", () => {
    const { element } = makeElement();
    const first = makeMap();
    const second = makeMap();
    element.topMap = first;
    expect(first.container.style.clipPath).toBe("inset(0 0 0 50%)");

    element.topMap = second;
    expect(first.container.style.clipPath).toBe("");
    expect(second.container.style.clipPath).toBe("inset(0 0 0 50%)");
  });

  test("defineHonuaSwipeControl is a no-op without a registry", () => {
    expect(() => defineHonuaSwipeControl(undefined)).not.toThrow();
  });
});
