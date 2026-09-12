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

  it("emits system-color styles for the status and mode surface", () => {
    const element = mount(makeMap());
    const styles = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(styles).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(styles).toContain(".panel { background: Canvas; border-color: CanvasText; color: CanvasText; }");
    expect(styles).toContain(".state, .hint { color: GrayText; }");
    expect(styles).toContain("button { background: ButtonFace; border-color: ButtonText; color: ButtonText; }");
    expect(styles).toContain(
      'button[aria-pressed="true"] { background: Highlight; border-color: Highlight; color: HighlightText; }',
    );
    expect(styles).toContain("button:disabled { color: GrayText; }");
    expect(styles).toContain("button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }");
  });

  it("emits narrow-container-safe layout rules", () => {
    const element = mount(makeMap());
    const styles = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(styles).toContain("@media (max-width: 320px)");
    expect(styles).toContain(".segmented { grid-template-columns: minmax(0, 1fr); }");
    expect(styles).toContain(".actions button { flex: 1 1 120px; min-width: 0; }");
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

  it("restores focus to the active mode button after a rerender", () => {
    const map = makeMap();
    const element = mount(map);
    const distance = modeButton(element, "distance");
    distance.focus();
    element.setMode("distance");
    expect(element.shadowRoot?.activeElement?.getAttribute("data-measure-mode")).toBe("distance");
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

/**
 * Units, precision, and geodesic/planar fidelity (issue #1419): every
 * expected value below is derived from a closed-form formula written
 * independently of `#recompute`'s call path, never from a snapshot of the
 * element's own output.
 */
describe("<honua-measurement> units, precision, and fidelity", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  // Mean earth radius turf's geodesic ops use (`@turf/helpers` `earthRadius`).
  const EARTH_RADIUS_METERS = 6_371_008.8;
  // Same WGS84 meters-per-degree constants `MeasurementCompat` (src/esri-compat/measurement.ts) uses.
  const METERS_PER_DEG_LAT = 111_132.92;
  const METERS_PER_DEG_LON_AT_EQUATOR = 111_412.84;

  it("computes geodesic distance matching the equatorial great-circle arc-length formula", () => {
    // Two points on the equator: the great circle between them *is* the
    // equator, so the geodesic distance is exactly radius * angle(radians) —
    // a closed form independent of haversine or the SDK's own math.
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "distance").click();
    click(map, 0, 0);
    click(map, 10, 0);

    const expectedMeters = EARTH_RADIUS_METERS * (10 * (Math.PI / 180));
    expect(element.result?.distance).toBeCloseTo(expectedMeters, 0);
    expect(element.result?.fidelity).toBe("geodesic");
  });

  it("computes geodesic area matching the flat-earth parity formula for a small equatorial patch", () => {
    // For a patch this small near the equator, spherical excess is
    // negligible, so the same lat/lon-degree-to-meters approximation the
    // esri-compat shim uses independently predicts the geodesic area.
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "area").click();
    click(map, 0, 0);
    click(map, 0.01, 0);
    click(map, 0.01, 0.01);
    click(map, 0, 0.01);
    element.finish();

    // cos(0) = 1 at the equator.
    const expectedSquareMeters = 0.01 * METERS_PER_DEG_LAT * (0.01 * METERS_PER_DEG_LON_AT_EQUATOR);
    expect(Math.abs((element.result?.area ?? 0) - expectedSquareMeters) / expectedSquareMeters).toBeLessThan(0.002);
  });

  it("handles a distance sketch crossing the antimeridian as the short way around", () => {
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "distance").click();
    click(map, 179, 0);
    click(map, -179, 0);

    // The short way is 2 degrees of equatorial arc, not the 358-degree long way.
    const expectedShortWay = EARTH_RADIUS_METERS * (2 * (Math.PI / 180));
    const longWay = EARTH_RADIUS_METERS * (358 * (Math.PI / 180));
    expect(element.result?.distance).toBeCloseTo(expectedShortWay, 0);
    expect(element.result?.distance).toBeLessThan(longWay / 10);
  });

  it("reports zero distance/area for degenerate geometry without throwing", () => {
    const map = makeMap();
    const distanceElement = mount(map);
    modeButton(distanceElement, "distance").click();
    click(map, 5, 5);
    click(map, 5, 5); // repeated point: zero-length line

    expect(distanceElement.result?.distance).toBe(0);

    document.body.innerHTML = "";
    const areaMap = makeMap();
    const areaElement = mount(areaMap);
    modeButton(areaElement, "area").click();
    click(areaMap, 0, 0);
    click(areaMap, 1, 0);
    click(areaMap, 2, 0); // collinear: degenerate (zero-area) ring

    expect(areaElement.result?.area).toBeCloseTo(0, 6);
  });

  it("computes planar (flat-earth Euclidean) distance instead of the great circle", () => {
    const map = makeMap();
    const element = mount(map);
    element.fidelity = "planar";
    modeButton(element, "distance").click();
    click(map, 0, 0);
    click(map, 10, 0);

    // At the equator, 10 degrees of longitude is exactly 10 * metersPerDegLon(0) in the
    // flat-earth approximation — a closed form independent of the implementation.
    const expectedMeters = 10 * METERS_PER_DEG_LON_AT_EQUATOR;
    expect(element.result?.fidelity).toBe("planar");
    expect(element.result?.distance).toBeCloseTo(expectedMeters, 6);
  });

  it("switching fidelity recomputes from the drawn vertices, not from a formatted value", () => {
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "distance").click();
    click(map, 0, 0);
    click(map, 10, 0);
    const geodesicDistance = element.result?.distance;

    element.fidelity = "planar";
    const planarDistance = element.result?.distance;

    expect(geodesicDistance).toBeDefined();
    expect(planarDistance).toBeDefined();
    // The two fidelities disagree (the sphere radius `@turf/helpers` uses and
    // the WGS84 meters-per-degree constants are not identical); assert they
    // were independently recomputed rather than one being derived from the
    // other's rounded display.
    expect(planarDistance).not.toBe(geodesicDistance);
  });

  it("exposes the vertex CRS explicitly as WGS84", () => {
    const element = mount(makeMap());
    expect(element.crs).toBe("EPSG:4326");
  });

  it("reformats an existing result when unit/areaUnit/precision change, without recomputing geometry", () => {
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "distance").click();
    click(map, 0, 0);
    click(map, 0, 1); // ~110.6 km

    const rawMeters = element.result?.distance;
    expect(rawMeters).toBeDefined();

    element.unit = "meters";
    const meterText = statusText(element);
    element.unit = "kilometers";
    expect(statusText(element)).not.toBe(meterText);
    element.unit = "miles";
    expect(statusText(element)).toContain("mi");
    element.precision = 4;
    expect(statusText(element)).toMatch(/\d\.\d{4} mi/);

    // Switching back to meters must reflect the original full-precision
    // value, not a value re-derived from any rounded intermediate display.
    element.unit = "meters";
    element.precision = undefined;
    const expectedMeterText = `${(rawMeters as number).toFixed(1)} m`;
    expect(statusText(element)).toContain(expectedMeterText);

    // The underlying canonical result never changed shape or unit.
    expect(element.result?.distance).toBe(rawMeters);
  });

  it("keeps the accessible live-region contract when unit/precision change", () => {
    const map = makeMap();
    const element = mount(map);
    modeButton(element, "area").click();
    click(map, 0, 0);
    click(map, 0, 1);
    click(map, 1, 0);

    element.areaUnit = "acres";
    element.precision = 2;
    const status = element.shadowRoot?.querySelector("[role='status']");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("ac");
  });
});
