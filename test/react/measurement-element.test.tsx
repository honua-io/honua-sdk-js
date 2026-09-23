// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  HonuaMeasureAreaUnit,
  HonuaMeasureChangeDetail,
  HonuaMeasureDistanceUnit,
  HonuaMeasureFidelity,
  HonuaMeasurePlanarCrs,
  HonuaMeasurementElement,
  HonuaMeasurementMap,
} from "../../src/web-components/index.js";
import { defineHonuaMeasurement } from "../../src/web-components/index.js";
import { isMapPointerClaimed } from "../../src/web-components/map-pointer-claim.js";

/**
 * React binding evidence for `<honua-measurement>` (issue #1419 AC-3).
 *
 * React 19 binds custom elements natively: a prop whose name is a property on
 * the upgraded element is assigned as that property (so `map`, `precision`,
 * and `planarCrs` arrive as real values, not strings), and an `on<event>`
 * function prop becomes an `addEventListener(<event>)`. This suite proves the
 * element's contract survives that binding — including StrictMode's double
 * mount and unmount teardown — so React apps need no wrapper component.
 */

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "honua-measurement": {
        ref?: React.Ref<HonuaMeasurementElement>;
        label?: string;
        map?: HonuaMeasurementMap;
        unit?: HonuaMeasureDistanceUnit;
        areaUnit?: HonuaMeasureAreaUnit;
        precision?: number;
        fidelity?: HonuaMeasureFidelity;
        planarCrs?: HonuaMeasurePlanarCrs;
        "onhonua-measure-change"?: (event: CustomEvent<HonuaMeasureChangeDetail>) => void;
      };
    }
  }
}

interface FakeMap extends HonuaMeasurementMap {
  emit(type: string, event?: unknown): void;
  listenerCount(type: string): number;
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
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

beforeAll(() => {
  defineHonuaMeasurement();
});

afterEach(cleanup);

describe("<honua-measurement> under React", () => {
  it("receives props as typed properties and events as listeners", () => {
    const map = makeMap();
    const details: HonuaMeasureChangeDetail[] = [];
    let element: HonuaMeasurementElement | null = null;

    render(
      <honua-measurement
        ref={(node) => {
          element = node;
        }}
        map={map}
        unit="miles"
        precision={3}
        fidelity="planar"
        planarCrs="EPSG:3857"
        onhonua-measure-change={(event) => details.push(event.detail)}
      />,
    );

    const measurement = element as unknown as HonuaMeasurementElement;
    expect(measurement.map).toBe(map);
    expect(measurement.unit).toBe("miles");
    expect(measurement.precision).toBe(3);
    expect(measurement.planarCrs).toBe("EPSG:3857");

    act(() => {
      measurement.setMode("distance");
      map.emit("click", { lngLat: { lng: 0, lat: 0 } });
      map.emit("click", { lngLat: { lng: 1, lat: 0 } });
    });

    // EPSG:3857: one degree of longitude is R·π/180 meters.
    const meters = (6_378_137 * Math.PI) / 180;
    expect(details.at(-1)?.result?.distance).toBeCloseTo(meters, 6);
    expect(details.at(-1)?.result?.crs).toBe("EPSG:3857");
    expect(measurement.shadowRoot?.querySelector("[role='status']")?.textContent).toBe(
      `Distance: ${(meters / 1609.344).toFixed(3)} mi`,
    );
  });

  it("reformats on a React re-render without recomputing the canonical value", () => {
    const map = makeMap();
    let element: HonuaMeasurementElement | null = null;
    let setUnit: (unit: HonuaMeasureDistanceUnit) => void = () => {};

    function App() {
      const [unit, update] = useState<HonuaMeasureDistanceUnit>("meters");
      setUnit = update;
      return (
        <honua-measurement
          ref={(node) => {
            element = node;
          }}
          map={map}
          unit={unit}
        />
      );
    }

    render(<App />);
    const measurement = element as unknown as HonuaMeasurementElement;
    act(() => {
      measurement.setMode("distance");
      map.emit("click", { lngLat: { lng: 0, lat: 0 } });
      map.emit("click", { lngLat: { lng: 0, lat: 1 } });
    });
    const canonical = measurement.result?.distance as number;

    act(() => setUnit("feet"));
    expect(measurement.unit).toBe("feet");
    expect(measurement.result?.distance).toBe(canonical);
    expect(measurement.shadowRoot?.querySelector("[role='status']")?.textContent).toBe(
      `Distance: ${(canonical / 0.3048).toFixed(2)} ft`,
    );
  });

  it("tears down map listeners and the pointer claim on unmount, including under StrictMode", () => {
    const map = makeMap();
    let element: HonuaMeasurementElement | null = null;
    const { unmount } = render(
      <StrictMode>
        <honua-measurement
          ref={(node) => {
            element = node;
          }}
          map={map}
        />
      </StrictMode>,
    );

    act(() => {
      (element as unknown as HonuaMeasurementElement).setMode("area");
    });
    expect(map.listenerCount("click")).toBe(1);
    expect(isMapPointerClaimed(map)).toBe(true);

    unmount();
    expect(map.listenerCount("click")).toBe(0);
    expect(map.listenerCount("dblclick")).toBe(0);
    expect(map.listenerCount("remove")).toBe(0);
    expect(isMapPointerClaimed(map)).toBe(false);
  });
});
