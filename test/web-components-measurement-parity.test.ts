// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { HonuaMeasureChangeDetail, HonuaMeasurementElement } from "../src/web-components/index.js";
import { defineHonuaWebComponents } from "../src/web-components/index.js";
import { isMapPointerClaimed } from "../src/web-components/map-pointer-claim.js";

/**
 * `<honua-measurement>` 2D parity (issue #1419): projected vs geographic CRS,
 * antimeridian, invalid geometry, declarative attributes, teardown, keyboard
 * ownership, and the shared-selection pointer claim.
 *
 * Expected values are derived here from published definitions, not captured
 * from the element: EPSG:3857 uses the inverse-Gudermannian `atanh(sin φ)`
 * form (the implementation uses `ln tan(π/4 + φ/2)`), and the local planar
 * frame uses the WGS84 meters-per-degree constants.
 */

/** EPSG:3857 sphere radius (the WGS84 semi-major axis). */
const R = 6_378_137;
const DEG = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_132.92;
const metersPerDegLon = (latDeg: number): number => 111_412.84 * Math.cos(latDeg * DEG);
const mercatorX = (lngDeg: number): number => R * lngDeg * DEG;
const mercatorY = (latDeg: number): number => R * Math.atanh(Math.sin(latDeg * DEG));

interface FakeMap {
  on(type: string, listener: (event?: unknown) => void): void;
  off(type: string, listener: (event?: unknown) => void): void;
  emit(type: string, event?: unknown): void;
  listenerCount(type: string): number;
  doubleClickZoom: { enabled: boolean; disable(): void; enable(): void; isEnabled(): boolean };
}

function makeMap({ zoomEnabled = true } = {}): FakeMap {
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
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    doubleClickZoom: {
      enabled: zoomEnabled,
      disable() {
        this.enabled = false;
      },
      enable() {
        this.enabled = true;
      },
      isEnabled() {
        return this.enabled;
      },
    },
  };
}

function mount(map: FakeMap, markup?: string): HonuaMeasurementElement {
  defineHonuaWebComponents();
  let element: HonuaMeasurementElement;
  if (markup) {
    const template = document.createElement("div");
    template.innerHTML = markup;
    element = template.firstElementChild as HonuaMeasurementElement;
  } else {
    element = document.createElement("honua-measurement");
  }
  document.body.append(element);
  element.map = map;
  return element;
}

function click(map: FakeMap, lng: number, lat: number): void {
  map.emit("click", { lngLat: { lng, lat } });
}

function statusText(element: HonuaMeasurementElement): string {
  return element.shadowRoot?.querySelector("[role='status']")?.textContent ?? "";
}

describe("<honua-measurement> projected and geographic CRS", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("labels geodesic results with the geographic CRS they were measured in", () => {
    const map = makeMap();
    const element = mount(map);
    element.setMode("distance");
    click(map, 0, 0);
    click(map, 0, 1);
    expect(element.result?.crs).toBe("EPSG:4326");
    expect(element.result?.fidelity).toBe("geodesic");
  });

  it("measures EPSG:3857 planar distance in unscaled Web Mercator meters", () => {
    const map = makeMap();
    const element = mount(map);
    element.fidelity = "planar";
    element.planarCrs = "EPSG:3857";
    element.setMode("distance");
    click(map, 10, 60);
    click(map, 11, 60);

    // One degree along a parallel is R·(π/180) projected meters at any latitude.
    expect(element.result?.crs).toBe("EPSG:3857");
    expect(element.result?.distance).toBeCloseTo(mercatorX(1), 6);
    // The same segment in the local frame is ground-scaled: cos(60°) of the equatorial degree.
    element.planarCrs = "local";
    expect(element.result?.crs).toBe("local");
    expect(element.result?.distance).toBeCloseTo(metersPerDegLon(60), 6);
  });

  it("measures EPSG:3857 planar area against the inverse-Gudermannian projection", () => {
    const map = makeMap();
    const element = mount(map);
    element.fidelity = "planar";
    element.planarCrs = "EPSG:3857";
    element.setMode("area");
    click(map, 0, 50);
    click(map, 2, 50);
    click(map, 2, 51);
    click(map, 0, 51);

    const expected = mercatorX(2) * (mercatorY(51) - mercatorY(50));
    // ~3.9e10 m²: compare relatively; the two projection forms agree to float precision.
    expect(Math.abs((element.result?.area as number) - expected) / expected).toBeLessThan(1e-12);
  });

  it("recomputes, rather than rescales, when the planar CRS changes", () => {
    const map = makeMap();
    const element = mount(map);
    element.setMode("distance");
    click(map, 0, 45);
    click(map, 0, 46);
    const geodesic = element.result?.distance;

    const events: HonuaMeasureChangeDetail[] = [];
    element.addEventListener("honua-measure-change", (event) => {
      events.push((event as CustomEvent<HonuaMeasureChangeDetail>).detail);
    });
    // planarCrs is inert until fidelity is planar.
    element.planarCrs = "EPSG:3857";
    expect(events).toHaveLength(0);
    expect(element.result?.distance).toBe(geodesic);

    element.fidelity = "planar";
    expect(events).toHaveLength(1);
    expect(element.result?.distance).toBeCloseTo(mercatorY(46) - mercatorY(45), 6);
  });
});

describe("<honua-measurement> antimeridian in planar frames", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("measures a planar line across the antimeridian the short way", () => {
    const map = makeMap();
    const element = mount(map);
    element.fidelity = "planar";
    element.setMode("distance");
    click(map, 179, 0);
    click(map, -179, 0);
    expect(element.result?.distance).toBeCloseTo(2 * metersPerDegLon(0), 6);

    element.planarCrs = "EPSG:3857";
    expect(element.result?.distance).toBeCloseTo(mercatorX(2), 6);
  });

  it("treats a world-copy longitude (181°) the same as its wrapped value (-179°)", () => {
    const wrappedMap = makeMap();
    const wrapped = mount(wrappedMap);
    wrapped.fidelity = "planar";
    wrapped.setMode("area");
    for (const [lng, lat] of [
      [179, 0],
      [-179, 0],
      [-179, 1],
      [179, 1],
    ] as const) {
      click(wrappedMap, lng, lat);
    }

    const copyMap = makeMap();
    const copy = mount(copyMap);
    copy.fidelity = "planar";
    copy.setMode("area");
    for (const [lng, lat] of [
      [179, 0],
      [181, 0],
      [181, 1],
      [179, 1],
    ] as const) {
      click(copyMap, lng, lat);
    }

    // 2° × 1° cell centered on latitude 0.5°.
    const expected = 2 * metersPerDegLon(0.5) * METERS_PER_DEG_LAT;
    expect(wrapped.result?.area).toBeCloseTo(expected, 3);
    expect(copy.result?.area).toBeCloseTo(expected, 3);
    expect(wrapped.result?.invalid).toBeUndefined();
  });
});

describe("<honua-measurement> invalid geometry", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("rejects non-finite and out-of-range vertices without changing state", () => {
    const map = makeMap();
    const element = mount(map);
    element.setMode("distance");
    expect(element.addVertex([0, 0])).toBe(true);

    const events: unknown[] = [];
    element.addEventListener("honua-measure-change", (event) => events.push(event));
    expect(element.addVertex([Number.NaN, 1])).toBe(false);
    expect(element.addVertex([1, Number.POSITIVE_INFINITY])).toBe(false);
    expect(element.addVertex([1, 90.000_1])).toBe(false);
    click(map, 1, -91);

    expect(element.vertices).toEqual([[0, 0]]);
    expect(events).toHaveLength(0);
    expect(element.result?.distance).toBeUndefined();
    expect(element.addVertex([0, 90])).toBe(true);
  });

  it("refuses to report an area for a self-intersecting (bow-tie) outline", () => {
    const map = makeMap();
    const element = mount(map);
    element.areaUnit = "square-kilometers";
    element.setMode("area");
    click(map, 0, 0);
    click(map, 1, 1);
    click(map, 1, 0);
    click(map, 0, 1);

    expect(element.result?.invalid).toBe("self-intersecting-ring");
    expect(element.result?.area).toBeUndefined();
    expect(statusText(element)).toMatch(/crosses itself/);
    expect(statusText(element)).not.toMatch(/km²/);

    element.fidelity = "planar";
    expect(element.result?.invalid).toBe("self-intersecting-ring");
    expect(element.result?.area).toBeUndefined();

    element.cancel();
    expect(element.result).toBeUndefined();
  });

  it("does not flag a valid concave outline", () => {
    const map = makeMap();
    const element = mount(map);
    element.fidelity = "planar";
    element.setMode("area");
    // An L-shape: 2×2 degree square minus its 1×1 upper-right quadrant, at the equator.
    for (const [lng, lat] of [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ] as const) {
      click(map, lng, lat);
    }
    expect(element.result?.invalid).toBeUndefined();
    const meanLat = (0 + 0 + 1 + 1 + 2 + 2) / 6;
    expect(element.result?.area).toBeCloseTo(3 * metersPerDegLon(meanLat) * METERS_PER_DEG_LAT, 3);
  });
});

describe("<honua-measurement> declarative attributes and deterministic formatting", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("maps attributes onto the unit, precision, fidelity, and CRS properties", () => {
    const map = makeMap();
    const element = mount(
      map,
      '<honua-measurement unit="miles" area-unit="acres" precision="3" fidelity="planar" planar-crs="EPSG:3857"></honua-measurement>',
    );
    expect(element.unit).toBe("miles");
    expect(element.areaUnit).toBe("acres");
    expect(element.precision).toBe(3);
    expect(element.fidelity).toBe("planar");
    expect(element.planarCrs).toBe("EPSG:3857");

    element.setMode("distance");
    click(map, 0, 0);
    click(map, 1, 0);
    const meters = mercatorX(1);
    expect(statusText(element)).toBe(`Distance: ${(meters / 1609.344).toFixed(3)} mi`);

    element.removeAttribute("unit");
    expect(element.unit).toBe("auto");
    expect(statusText(element)).toBe(`Distance: ${(meters / 1000).toFixed(3)} km`);
  });

  it("falls back to defaults for unknown or hostile values instead of rendering a malformed value", () => {
    const map = makeMap();
    const element = mount(map, '<honua-measurement unit="furlongs" precision="lots"></honua-measurement>');
    expect(element.unit).toBe("auto");
    expect(element.precision).toBeUndefined();

    element.setAttribute("fidelity", "spherical");
    element.setAttribute("planar-crs", "EPSG:27700");
    element.areaUnit = "roods" as never;
    element.precision = 1_000;
    expect(element.fidelity).toBe("geodesic");
    expect(element.planarCrs).toBe("local");
    expect(element.areaUnit).toBe("auto");
    expect(element.precision).toBe(20);

    element.setMode("distance");
    click(map, 0, 0);
    click(map, 0, 0.001);
    expect(statusText(element)).toMatch(/^Distance: \d+\.\d{20} m$/);
  });

  it("produces the same text for the same unit and precision regardless of the order of changes", () => {
    const sequences: ReadonlyArray<ReadonlyArray<(element: HonuaMeasurementElement) => void>> = [
      [
        (e) => {
          e.unit = "feet";
        },
        (e) => {
          e.precision = 0;
        },
        (e) => {
          e.unit = "yards";
        },
        (e) => {
          e.precision = 2;
        },
      ],
      [
        (e) => {
          e.precision = 5;
        },
        (e) => {
          e.unit = "nauticalmiles";
        },
        (e) => {
          e.precision = 2;
        },
        (e) => {
          e.unit = "yards";
        },
      ],
    ];
    const texts = sequences.map((steps) => {
      document.body.innerHTML = "";
      const map = makeMap();
      const element = mount(map);
      element.setMode("distance");
      click(map, 3, 3);
      click(map, 3.2, 3.1);
      for (const step of steps) step(element);
      return { text: statusText(element), meters: element.result?.distance as number };
    });
    expect(texts[0]?.text).toBe(texts[1]?.text);
    expect(texts[0]?.text).toBe(`Distance: ${((texts[0]?.meters as number) / 0.9144).toFixed(2)} yd`);
  });
});

describe("<honua-measurement> teardown, keyboard ownership, and shared selection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps drawing after the element is moved in the DOM, without duplicating listeners", () => {
    const map = makeMap();
    const element = mount(map);
    element.setMode("distance");
    click(map, 0, 0);

    const panel = document.createElement("aside");
    document.body.append(panel);
    panel.append(element); // disconnect + reconnect

    expect(map.listenerCount("click")).toBe(1);
    expect(map.listenerCount("dblclick")).toBe(1);
    expect(map.listenerCount("remove")).toBe(1);
    click(map, 0, 1);
    expect(element.vertices).toHaveLength(2);
    expect(element.result?.distance).toBeGreaterThan(0);
  });

  it("releases every map listener and the pointer claim when removed", () => {
    const map = makeMap();
    const element = mount(map);
    element.setMode("area");
    expect(isMapPointerClaimed(map)).toBe(true);
    expect(map.doubleClickZoom.enabled).toBe(false);

    element.remove();
    expect(map.listenerCount("click")).toBe(0);
    expect(map.listenerCount("dblclick")).toBe(0);
    expect(map.listenerCount("remove")).toBe(0);
    expect(isMapPointerClaimed(map)).toBe(false);
    expect(map.doubleClickZoom.enabled).toBe(true);
  });

  it("leaves double-click zoom disabled if the host had disabled it before measuring", () => {
    const map = makeMap({ zoomEnabled: false });
    const element = mount(map);
    element.setMode("distance");
    element.setMode("off");
    expect(map.doubleClickZoom.enabled).toBe(false);
  });

  it("drops a destroyed map without calling back into it and waits for another", () => {
    const map = makeMap();
    const element = mount(map);
    element.setMode("distance");
    click(map, 0, 0);
    map.off = () => {
      throw new Error("a removed map must not be called");
    };

    expect(() => map.emit("remove")).not.toThrow();
    expect(element.map).toBeUndefined();
    expect(isMapPointerClaimed(map)).toBe(false);
    expect(element.shadowRoot?.textContent).toContain("waiting for map");

    const next = makeMap();
    element.map = next;
    click(next, 0, 1);
    click(next, 0, 2);
    expect(next.listenerCount("click")).toBe(1);
    expect(element.vertices.length).toBeGreaterThanOrEqual(2);
  });

  it("claims the map pointer only while a mode is active", () => {
    const map = makeMap();
    const element = mount(map);
    expect(isMapPointerClaimed(map)).toBe(false);
    element.setMode("distance");
    expect(isMapPointerClaimed(map)).toBe(true);
    element.setMode("off");
    expect(isMapPointerClaimed(map)).toBe(false);
  });

  it("leaves Escape to another text field, and to handlers that already consumed it", () => {
    const map = makeMap();
    const element = mount(map);
    element.setMode("distance");
    click(map, 0, 0);

    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(element.vertices).toHaveLength(1);

    const consumed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    consumed.preventDefault();
    window.dispatchEvent(consumed);
    expect(element.vertices).toHaveLength(1);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(element.vertices).toHaveLength(0);
  });

  it("publishes renderer-neutral, plain-data results", () => {
    const map = makeMap();
    const element = mount(map);
    const details: HonuaMeasureChangeDetail[] = [];
    element.addEventListener("honua-measure-change", (event) => {
      details.push((event as CustomEvent<HonuaMeasureChangeDetail>).detail);
    });
    element.setMode("area");
    click(map, 0, 0);
    click(map, 1, 0);
    click(map, 1, 1);
    element.finish();

    const result = details.at(-1)?.result;
    expect(result).toBeDefined();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(Object.keys(result ?? {}).sort()).toEqual(["area", "coordinates", "crs", "fidelity", "mode"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
