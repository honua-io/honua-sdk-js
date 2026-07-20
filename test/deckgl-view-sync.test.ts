import { describe, expect, it, vi } from "vitest";

import {
  type DeckGlCameraState,
  type DeckGlMapCameraSource,
  bindDeckGlViewportToMap,
  readMapCameraState,
} from "../src/deckgl/index.js";

interface FakeMaplibreMap extends DeckGlMapCameraSource {
  _fireMove(): void;
  _center: { lng: number; lat: number };
  _zoom: number;
  _pitch: number;
  _bearing: number;
}

function fakeMap(
  initial?: Partial<{ lng: number; lat: number; zoom: number; pitch: number; bearing: number }>,
): FakeMaplibreMap {
  const handlers = new Set<() => void>();
  const state = {
    lng: initial?.lng ?? -122.4,
    lat: initial?.lat ?? 37.8,
    zoom: initial?.zoom ?? 10,
    pitch: initial?.pitch ?? 0,
    bearing: initial?.bearing ?? 0,
  };
  return {
    getCenter: () => ({ lng: state.lng, lat: state.lat }),
    getZoom: () => state.zoom,
    getPitch: () => state.pitch,
    getBearing: () => state.bearing,
    on(event, handler) {
      if (event === "move") handlers.add(handler);
    },
    off(event, handler) {
      if (event === "move") handlers.delete(handler);
    },
    _fireMove() {
      for (const handler of handlers) handler();
    },
    get _center() {
      return { lng: state.lng, lat: state.lat };
    },
    set _center(value) {
      state.lng = value.lng;
      state.lat = value.lat;
    },
    get _zoom() {
      return state.zoom;
    },
    set _zoom(value) {
      state.zoom = value;
    },
    get _pitch() {
      return state.pitch;
    },
    set _pitch(value) {
      state.pitch = value;
    },
    get _bearing() {
      return state.bearing;
    },
    set _bearing(value) {
      state.bearing = value;
    },
  };
}

function fakeOverlay(): { setProps: (props: { viewState: DeckGlCameraState }) => void; calls: DeckGlCameraState[] } {
  const calls: DeckGlCameraState[] = [];
  return {
    calls,
    setProps(props) {
      calls.push(props.viewState);
    },
  };
}

describe("readMapCameraState", () => {
  it("reads the current MapLibre camera as a deck.gl view state", () => {
    const map = fakeMap({ lng: -157.86, lat: 21.31, zoom: 12, pitch: 30, bearing: 45 });
    expect(readMapCameraState(map)).toEqual({
      longitude: -157.86,
      latitude: 21.31,
      zoom: 12,
      pitch: 30,
      bearing: 45,
    });
  });

  it("rejects a camera source missing required methods", () => {
    expect(() => readMapCameraState({} as DeckGlMapCameraSource)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });

  it("rejects non-finite camera fields", () => {
    const map = fakeMap();
    map.getZoom = () => Number.NaN;
    expect(() => readMapCameraState(map)).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });
});

describe("bindDeckGlViewportToMap", () => {
  it("pushes the map's current camera to the overlay on bind by default", () => {
    const map = fakeMap({ lng: 10, lat: 20, zoom: 5, pitch: 0, bearing: 0 });
    const overlay = fakeOverlay();

    bindDeckGlViewportToMap(map, overlay);

    expect(overlay.calls).toHaveLength(1);
    expect(overlay.calls[0]).toEqual({ longitude: 10, latitude: 20, zoom: 5, pitch: 0, bearing: 0 });
  });

  it("does not push initial state when applyInitial is false", () => {
    const map = fakeMap();
    const overlay = fakeOverlay();

    bindDeckGlViewportToMap(map, overlay, { applyInitial: false });

    expect(overlay.calls).toHaveLength(0);
  });

  it("pushes an updated camera on every map move event", () => {
    const map = fakeMap({ lng: 0, lat: 0, zoom: 1, pitch: 0, bearing: 0 });
    const overlay = fakeOverlay();
    bindDeckGlViewportToMap(map, overlay);

    map._center = { lng: 5, lat: 5 };
    map._zoom = 3;
    map._fireMove();

    expect(overlay.calls).toHaveLength(2);
    expect(overlay.calls[1]).toMatchObject({ longitude: 5, latitude: 5, zoom: 3 });
  });

  it("dispose() removes the move listener and stops further pushes; is idempotent", () => {
    const map = fakeMap();
    const overlay = fakeOverlay();
    const handle = bindDeckGlViewportToMap(map, overlay);
    const callsAfterBind = overlay.calls.length;

    handle.dispose();
    expect(handle.disposed).toBe(true);
    map._fireMove();
    expect(overlay.calls).toHaveLength(callsAfterBind);

    expect(() => handle.dispose()).not.toThrow();
  });

  it("stops pushing once disposed even if a stale move event fires mid-flight", () => {
    const map = fakeMap();
    const overlay = fakeOverlay();
    const handle = bindDeckGlViewportToMap(map, overlay);
    const setPropsSpy = vi.spyOn(overlay, "setProps");
    handle.dispose();

    map._fireMove();

    expect(setPropsSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed camera source or overlay target", () => {
    expect(() => bindDeckGlViewportToMap({} as DeckGlMapCameraSource, fakeOverlay())).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
    expect(() =>
      bindDeckGlViewportToMap(fakeMap(), {} as { setProps: (props: { viewState: DeckGlCameraState }) => void }),
    ).toThrowError(expect.objectContaining({ code: "invalid-data" }));
  });
});
