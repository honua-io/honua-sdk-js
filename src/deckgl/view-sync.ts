/**
 * Shared camera/viewport state between a MapLibre basemap and a deck.gl
 * overlay — the "overlay" composition mode from `#561`: deck.gl renders over
 * the same MapLibre map and shares its view/camera/interaction rather than
 * owning its own.
 *
 * Both sides are duck-typed; this module never imports `maplibre-gl` or
 * `@deck.gl/core`. In "standalone" mode (deck.gl owns the viewport, no
 * MapLibre map present) callers simply do not use this module — the deck.gl
 * adapter itself never requires it (`DeckGlAdapter.project()` /
 * `DeckGlProjection.mount()` have no view-state dependency).
 *
 * @experimental
 * @module
 */

import type { DeckGlDisposalHandle } from "./types.js";
import { HonuaDeckGlAdapterError } from "./types.js";

/** The `viewState` shape every deck.gl `View`/`MapView` accepts. */
export interface DeckGlCameraState {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
  readonly pitch: number;
  readonly bearing: number;
}

/** Minimal duck-typed subset of `maplibre-gl.Map` needed to read and observe the current camera. */
export interface DeckGlMapCameraSource {
  getCenter(): { readonly lng: number; readonly lat: number };
  getZoom(): number;
  getPitch(): number;
  getBearing(): number;
  on(event: "move", handler: () => void): void;
  off(event: "move", handler: () => void): void;
}

/** Minimal duck-typed subset of a deck.gl `Deck`/`MapboxOverlay` instance needed to push a view-state update. */
export interface DeckGlOverlayViewTarget {
  setProps(props: { readonly viewState: DeckGlCameraState }): void;
}

export interface BindDeckGlViewportToMapOptions {
  /** Push the map's current camera to the overlay immediately on bind. @default true */
  readonly applyInitial?: boolean;
}

/**
 * Read the current MapLibre camera as a deck.gl view state without binding
 * anything. Useful to seed a standalone deck.gl `initialViewState` from a
 * map the app is migrating away from, or to snapshot the overlay camera on
 * demand.
 */
export function readMapCameraState(map: DeckGlMapCameraSource): DeckGlCameraState {
  const source = requireCameraSource(map);
  const center = source.getCenter();
  if (typeof center !== "object" || center === null || !Number.isFinite(center.lng) || !Number.isFinite(center.lat)) {
    throw new HonuaDeckGlAdapterError("invalid-data", "map.getCenter() must return a finite { lng, lat }.");
  }
  const zoom = source.getZoom();
  const pitch = source.getPitch();
  const bearing = source.getBearing();
  for (const [field, value] of [
    ["zoom", zoom],
    ["pitch", pitch],
    ["bearing", bearing],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new HonuaDeckGlAdapterError("invalid-data", `map.get${capitalize(field)}() must return a finite number.`, {
        field,
      });
    }
  }
  return Object.freeze({
    longitude: center.lng,
    latitude: center.lat,
    zoom,
    pitch,
    bearing,
  });
}

/**
 * Synchronize a deck.gl overlay's `viewState` prop with a MapLibre map's
 * camera: every `"move"` event (pan/zoom/rotate/pitch) re-reads the map's
 * camera and pushes it into the overlay via `setProps`. One-directional
 * (map -> overlay) because in overlay mode the map remains the source of
 * truth for user interaction; `dispose()` removes only the `"move"`
 * listener it added and never otherwise touches the map or overlay.
 */
export function bindDeckGlViewportToMap(
  map: DeckGlMapCameraSource,
  overlay: DeckGlOverlayViewTarget,
  options: BindDeckGlViewportToMapOptions = {},
): DeckGlDisposalHandle {
  const { applyInitial = true } = options;
  const source = requireCameraSource(map);
  const target = requireOverlayTarget(overlay);
  let disposed = false;

  function apply(): void {
    if (disposed) return;
    target.setProps({ viewState: readMapCameraState(source) });
  }

  source.on("move", apply);
  if (applyInitial) apply();

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      source.off("move", apply);
    },
  });
}

function requireCameraSource(map: DeckGlMapCameraSource): DeckGlMapCameraSource {
  if (
    typeof map !== "object" ||
    map === null ||
    typeof map.getCenter !== "function" ||
    typeof map.getZoom !== "function" ||
    typeof map.getPitch !== "function" ||
    typeof map.getBearing !== "function" ||
    typeof map.on !== "function" ||
    typeof map.off !== "function"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "A camera source must implement getCenter/getZoom/getPitch/getBearing/on/off.",
    );
  }
  return map;
}

function requireOverlayTarget(overlay: DeckGlOverlayViewTarget): DeckGlOverlayViewTarget {
  if (typeof overlay !== "object" || overlay === null || typeof overlay.setProps !== "function") {
    throw new HonuaDeckGlAdapterError("invalid-data", "An overlay view target must implement setProps.");
  }
  return overlay;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
