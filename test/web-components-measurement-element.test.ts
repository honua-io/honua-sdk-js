// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HonuaMeasureChangeDetail, HonuaMeasurementElement } from "../src/web-components/index.js";
import { defineHonuaWebComponents } from "../src/web-components/index.js";

/**
 * Survival-tier `<honua-measurement>` (issue #493): click-to-add-vertex
 * drawing over the map's pointer events, double-click finish, Escape cancel,
 * and geodesic distance/area computed via the public `@honua/geometry` ops.
 */

interface FakeMap {
  on(type: string, listener: (event?: unknown) => void): void;
  off(type: string, listener: (event?: unknown) => void): void;
  emit(type: string, event?: unknown): void;
  listenerCount(type: string): number;
  doubleClickZoom: { disabled: boolean; disable(): void; enable(): void };
}

function makeMap(): FakeMap {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  return {
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    doubleClickZoom: {
      disabled: false,
      disable() {
        this.disabled = true;
      },
      enable() {
        this.disabled = false;
      },
    },
  };
}

function mount(map: FakeMap): HonuaMeasurementElement {
  defineHonuaWebComponents();
  const element = document.createElement("honua-measurement") as HonuaMeasurementElement;
  document.body.append(element);
  element.map = map;
  return element;
}

function click(map: FakeMap, lng: number, lat: number): void {
  map.emit("click", { lngLat: { lng, lat } });
}

function modeButton(element: HonuaMeasurementElement, mode: string): HTMLButtonElement {
  const button = element.shadowRoot?.querySelector<HTMLButtonElement>(`button[data-measure-mode='${mode}']`);
  if (!button) throw new Error(`missing ${mode} button`);
  return button;
}

function statusText(element: HonuaMeasurementElement): string {
  return element.shadowRoot?.querySelector("[role='status']")?.textContent ?? "";
}

describe("<honua-measurement> (survival tier)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an accessible mode group with pressed state and live status", () => {
    const element = mount(makeMap());
    const root = element.shadowRoot;
    expect(root?.querySelector("[role='group']")).not.toBeNull();
    expect(modeButton(element, "off").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(element, "distance").getAttribute("aria-pressed")).toBe("false");
    const status = root?.querySelector("[role='status']");
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });

  it("measures distance from map clicks with the geodesic geometry ops", () => {
    const map = makeMap();
    const element = mount(map);
    const changes: HonuaMeasureChangeDetail[] = [];
    element.addEventListener("honua-measure-change", (event) => {
      changes.push((event as CustomEvent<HonuaMeasureChangeDetail>).detail);
    });

    modeButton(element, "distance").click();
    expect(element.mode).toBe("distance");
    expect(map.doubleClickZoom.disabled).toBe(true);

    click(map, 0, 0);
    click(map, 0, 1);

    const result = element.result;
    expect(result?.mode).toBe("distance");
    expect(result?.coordinates).toEqual([
      [0, 0],
      [0, 1],
    ]);
    // One degree of latitude is ~110.6 km geodesically.
    expect(result?.distance).toBeGreaterThan(110_000);
    expect(result?.distance).toBeLessThan(112_000);
    expect(statusText(element)).toContain("Distance:");
    expect(statusText(element)).toContain("km");
    expect(changes.at(-1)?.result?.distance).toBe(result?.distance);
  });

  it("finishes on double-click, dropping the double-click's duplicate vertex", () => {
    const map = makeMap();
    const element = mount(map);

    modeButton(element, "distance").click();
    click(map, 0, 0);
    click(map, 0, 1);
    // The browser fires two clicks before dblclick; simulate the duplicate.
    click(map, 0, 1);
    let prevented = false;
    map.emit("dblclick", {
      lngLat: { lng: 0, lat: 1 },
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(element.vertices).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(statusText(element)).toContain("(finished)");

    // The next click starts a new sketch.
    click(map, 10, 10);
    expect(element.vertices).toEqual([[10, 10]]);
  });

  it("measures area from three or more vertices", () => {
    const map = makeMap();
    const element = mount(map);

    modeButton(element, "area").click();
    click(map, 0, 0);
    click(map, 0, 1);
    expect(statusText(element)).toContain("vertices needed");
    click(map, 1, 0);

    const result = element.result;
    expect(result?.mode).toBe("area");
    // A 1°x1° right triangle near the equator is ~6.1e9 m².
    expect(result?.area).toBeGreaterThan(5e9);
    expect(result?.area).toBeLessThan(7e9);
    expect(statusText(element)).toContain("Area:");
    expect(statusText(element)).toContain("km²");
  });

  it("cancels with Escape and via the Cancel button; Finish is keyboard-operable", () => {
    const map = makeMap();
    const element = mount(map);

    modeButton(element, "distance").click();
    click(map, 0, 0);
    click(map, 0, 1);
    expect(element.vertices).toHaveLength(2);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(element.vertices).toHaveLength(0);
    expect(element.result).toBeUndefined();
    // Mode stays active after cancel.
    expect(element.mode).toBe("distance");

    click(map, 0, 0);
    click(map, 0, 1);
    element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-measure-finish]")?.click();
    expect(statusText(element)).toContain("(finished)");

    element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-measure-cancel]")?.click();
    expect(element.vertices).toHaveLength(0);
  });

  it("unbinds map listeners and restores double-click zoom when switching off", () => {
    const map = makeMap();
    const element = mount(map);

    modeButton(element, "distance").click();
    expect(map.listenerCount("click")).toBe(1);
    expect(map.listenerCount("dblclick")).toBe(1);

    modeButton(element, "off").click();
    expect(map.listenerCount("click")).toBe(0);
    expect(map.listenerCount("dblclick")).toBe(0);
    expect(map.doubleClickZoom.disabled).toBe(false);

    // Clicks while off do nothing.
    click(map, 0, 0);
    expect(element.vertices).toHaveLength(0);
  });

  it("does not accumulate map listeners across repeated mode rerenders", () => {
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "distance").click();

    for (let index = 0; index < 4; index += 1) {
      modeButton(element, "distance").click();
    }

    expect(map.listenerCount("click")).toBe(1);
    expect(map.listenerCount("dblclick")).toBe(1);
  });

  it("stops drawing when disconnected from the DOM", () => {
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "distance").click();
    expect(map.listenerCount("click")).toBe(1);

    element.remove();
    expect(map.listenerCount("click")).toBe(0);
    expect(map.doubleClickZoom.disabled).toBe(false);
  });

  it("mounts and disconnects without console errors", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const element = mount(makeMap());
      element.remove();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
