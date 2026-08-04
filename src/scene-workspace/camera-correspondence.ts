/**
 * The 2D/3D camera correspondence.
 *
 * The renderer-neutral {@link SceneCameraState} is a globe pose: geodetic
 * longitude/latitude, an ellipsoidal camera height in metres, and a
 * heading/pitch/roll triple in degrees using Cesium's sign convention
 * (`pitch = -90` looks straight down, `pitch = 0` looks at the horizon).
 *
 * A 2D web map does not carry a camera height at all — it carries a *zoom*,
 * which is a statement about ground resolution. This module is the documented,
 * unit-tested bridge between the two, so no consumer has to re-derive it. The
 * Cesium half of the same correspondence lives in `cesium-adapter.ts`
 * (`cameraStateToCesiumView` / `cesiumCameraToSceneState`), which needs no
 * conversion because the workspace camera *is* a globe pose.
 *
 * ## The zoom/height relationship
 *
 * Zoom fixes the ground resolution of the projected plane:
 *
 * ```text
 * groundResolution(zoom, lat) = C · cos(lat) / (tileSize · 2^zoom)   [m/px]
 * ```
 *
 * where `C` is the WGS84 equatorial circumference. The 2D renderer places its
 * perspective camera so the map centre fills the viewport at that resolution:
 *
 * ```text
 * centreDistance(px) = 0.5 · viewportHeight / tan(fov / 2)
 * centreDistance(m)  = groundResolution · centreDistance(px)
 * cameraHeight(m)    = centreDistance(m) · cos(pitch2D)
 * ```
 *
 * The relationship is therefore **not** latitude-independent and **not**
 * viewport-independent: the same zoom on a taller viewport puts the camera
 * further away in metres, because more ground is on screen at the same
 * resolution. Both halves are captured in {@link MapLibreCameraGeometry}, which
 * a live port reads from the map it is bound to rather than assuming.
 *
 * ## What cannot round-trip
 *
 * A globe camera can hold poses a Web Mercator plane cannot express. Those are
 * clamped and reported as {@link SceneCameraDegradation} entries rather than
 * silently applied: latitudes beyond the Mercator limit, zooms outside the
 * map's own range, pitches beyond the map's maximum, and a non-zero roll on a
 * renderer that does not support roll. A projection that needed no clamping
 * reports `exact` fidelity and round-trips to floating-point precision.
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface.
 * @module
 */

import type { SceneStateSyncFidelity } from "./state-sync.js";
import type { SceneCameraState } from "./types.js";

/** WGS84 equatorial circumference in metres (`2π · 6378137`). */
export const EARTH_CIRCUMFERENCE_METERS = 40_075_016.685_578_49;

/**
 * The Web Mercator latitude limit in degrees. Beyond it the projection is
 * undefined, so a globe camera over the poles has no 2D equivalent.
 */
export const WEB_MERCATOR_MAX_LATITUDE = 85.051_128_779_806_59;

/**
 * The viewport and lens properties a 2D zoom is defined against.
 *
 * A live port reads these from the map it is bound to; the defaults describe a
 * 600 CSS-pixel-tall viewport with the standard 512-pixel tile scheme and the
 * renderer's default vertical field of view.
 */
export interface MapLibreCameraGeometry {
  /** Viewport height in CSS pixels. */
  readonly viewportHeightPixels: number;
  /** Vertical field of view in radians. */
  readonly fovRadians: number;
  /** Tile edge length in pixels the zoom scale is defined against. */
  readonly tileSizePixels: number;
}

/** Documented defaults for {@link MapLibreCameraGeometry}. */
export const DEFAULT_MAPLIBRE_CAMERA_GEOMETRY: MapLibreCameraGeometry = Object.freeze({
  viewportHeightPixels: 600,
  fovRadians: 0.643_501_108_793_284_4,
  tileSizePixels: 512,
});

/** What a 2D map will actually accept; anything outside it is clamped. */
export interface MapLibreCameraLimits {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly maxPitch: number;
  /** Whether the renderer can express a non-zero roll. */
  readonly rollSupported: boolean;
}

/** Documented defaults for {@link MapLibreCameraLimits}. */
export const DEFAULT_MAPLIBRE_CAMERA_LIMITS: MapLibreCameraLimits = Object.freeze({
  minZoom: 0,
  maxZoom: 22,
  maxPitch: 60,
  rollSupported: false,
});

/** A 2D map camera: centre, zoom, and screen orientation, all in degrees. */
export interface MapLibreCameraView {
  readonly center: readonly [number, number];
  readonly zoom: number;
  /** Compass direction that is "up", clockwise from north — the same convention as a globe heading. */
  readonly bearing: number;
  /** Tilt in degrees where `0` looks straight down. */
  readonly pitch: number;
  readonly roll: number;
}

export type SceneCameraDegradationCode =
  | "camera-latitude-clamped"
  | "camera-zoom-clamped"
  | "camera-pitch-clamped"
  | "camera-roll-dropped";

/** One named way a globe pose failed to survive projection onto a 2D map. */
export interface SceneCameraDegradation {
  readonly code: SceneCameraDegradationCode;
  readonly message: string;
  readonly requested: number;
  readonly applied: number;
}

/** A projected 2D view plus the honest account of what projecting it cost. */
export interface MapLibreCameraProjection {
  readonly view: MapLibreCameraView;
  /** `exact` when nothing was clamped or dropped, `equivalent` otherwise. */
  readonly fidelity: SceneStateSyncFidelity;
  readonly degradations: readonly SceneCameraDegradation[];
}

const DEG2RAD = Math.PI / 180;
/** Smallest camera height treated as physical, so the inverse never divides by zero. */
const MIN_CAMERA_HEIGHT_METERS = 1e-3;

/**
 * Ground resolution in metres per CSS pixel at a zoom and latitude.
 *
 * This is the definition of zoom, and the only part of the correspondence that
 * is independent of the viewport and the lens.
 */
export function mapLibreGroundResolutionMeters(
  zoom: number,
  latitude: number,
  geometry: MapLibreCameraGeometry = DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
): number {
  const normalized = normalizeGeometry(geometry);
  const cosine = Math.cos(clampLatitude(latitude) * DEG2RAD);
  return (EARTH_CIRCUMFERENCE_METERS * cosine) / (normalized.tileSizePixels * 2 ** zoom);
}

/**
 * Camera height in metres above the map centre for a 2D zoom.
 *
 * `pitchDegrees` is the 2D tilt (`0` = straight down), not the globe pitch.
 */
export function mapLibreZoomToCameraHeight(
  zoom: number,
  latitude: number,
  pitchDegrees = 0,
  geometry: MapLibreCameraGeometry = DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
): number {
  const normalized = normalizeGeometry(geometry);
  const distance = mapLibreGroundResolutionMeters(zoom, latitude, normalized) * centerDistancePixels(normalized);
  return Math.max(MIN_CAMERA_HEIGHT_METERS, distance * Math.cos(clampPitch(pitchDegrees) * DEG2RAD));
}

/**
 * The inverse of {@link mapLibreZoomToCameraHeight}: the zoom whose camera sits
 * `height` metres above the map centre. Unclamped — callers decide what their
 * map will accept.
 */
export function mapLibreCameraHeightToZoom(
  height: number,
  latitude: number,
  pitchDegrees = 0,
  geometry: MapLibreCameraGeometry = DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
): number {
  const normalized = normalizeGeometry(geometry);
  const safeHeight = Math.max(MIN_CAMERA_HEIGHT_METERS, finite(height, MIN_CAMERA_HEIGHT_METERS));
  const distance = safeHeight / Math.cos(clampPitch(pitchDegrees) * DEG2RAD);
  const resolution = distance / centerDistancePixels(normalized);
  const cosine = Math.cos(clampLatitude(latitude) * DEG2RAD);
  return Math.log2((EARTH_CIRCUMFERENCE_METERS * cosine) / (normalized.tileSizePixels * resolution));
}

/**
 * Read a 2D map view as a renderer-neutral globe pose.
 *
 * Always lossless in this direction: every 2D view is a valid globe pose. The
 * pitch convention flips (`pitch2D = 0` looks down, which is `pitch = -90` on
 * the globe) and the bearing is the heading unchanged.
 */
export function mapLibreViewToSceneCamera(
  view: MapLibreCameraView,
  geometry: MapLibreCameraGeometry = DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
): SceneCameraState {
  const longitude = wrapLongitude(finite(view.center[0], 0));
  const latitude = clampLatitude(finite(view.center[1], 0));
  const pitch = clampPitch(finite(view.pitch, 0));
  return Object.freeze({
    longitude,
    latitude,
    height: mapLibreZoomToCameraHeight(finite(view.zoom, 0), latitude, pitch, geometry),
    heading: wrapDegrees(finite(view.bearing, 0)),
    pitch: pitch - 90,
    roll: wrapSignedDegrees(finite(view.roll, 0)),
  });
}

/**
 * Project a globe pose onto a 2D map view, clamping what the plane cannot hold
 * and naming every clamp.
 *
 * The caller is expected to apply `view` and surface `degradations`; the shared
 * state is deliberately left alone, because writing the clamped pose back would
 * drag the 3D view down to the 2D renderer's limits.
 */
export function sceneCameraToMapLibreView(
  camera: SceneCameraState,
  options: {
    readonly geometry?: MapLibreCameraGeometry;
    readonly limits?: MapLibreCameraLimits;
  } = {},
): MapLibreCameraProjection {
  const geometry = normalizeGeometry(options.geometry ?? DEFAULT_MAPLIBRE_CAMERA_GEOMETRY);
  const limits = normalizeLimits(options.limits ?? DEFAULT_MAPLIBRE_CAMERA_LIMITS);
  const degradations: SceneCameraDegradation[] = [];

  const requestedLatitude = finite(camera.latitude, 0);
  const latitude = clampLatitude(requestedLatitude);
  if (Math.abs(requestedLatitude - latitude) > 1e-9) {
    degradations.push(
      degradation(
        "camera-latitude-clamped",
        "Latitude is beyond the Web Mercator limit and was clamped; the 2D plane cannot reach the poles.",
        requestedLatitude,
        latitude,
      ),
    );
  }

  const requestedPitch = finite(camera.pitch ?? -90, -90) + 90;
  const pitch = Math.min(Math.max(requestedPitch, 0), limits.maxPitch);
  if (Math.abs(requestedPitch - pitch) > 1e-9) {
    degradations.push(
      degradation(
        "camera-pitch-clamped",
        "Globe pitch exceeds the 2D map's maximum tilt and was clamped.",
        requestedPitch,
        pitch,
      ),
    );
  }

  const requestedZoom = mapLibreCameraHeightToZoom(
    Math.max(finite(camera.height, MIN_CAMERA_HEIGHT_METERS), MIN_CAMERA_HEIGHT_METERS),
    latitude,
    pitch,
    geometry,
  );
  const zoom = Math.min(Math.max(requestedZoom, limits.minZoom), limits.maxZoom);
  if (Math.abs(requestedZoom - zoom) > 1e-9) {
    degradations.push(
      degradation(
        "camera-zoom-clamped",
        "Camera height maps outside the 2D map's zoom range and was clamped.",
        requestedZoom,
        zoom,
      ),
    );
  }

  const requestedRoll = wrapSignedDegrees(finite(camera.roll ?? 0, 0));
  const roll = limits.rollSupported ? requestedRoll : 0;
  if (!limits.rollSupported && Math.abs(requestedRoll) > 1e-9) {
    degradations.push(
      degradation(
        "camera-roll-dropped",
        "The 2D renderer cannot express camera roll; the globe's roll was dropped.",
        requestedRoll,
        0,
      ),
    );
  }

  return Object.freeze({
    view: Object.freeze({
      center: Object.freeze([wrapLongitude(finite(camera.longitude, 0)), latitude]) as readonly [number, number],
      zoom,
      bearing: wrapDegrees(finite(camera.heading ?? 0, 0)),
      pitch,
      roll,
    }),
    fidelity: (degradations.length === 0 ? "exact" : "equivalent") satisfies SceneStateSyncFidelity,
    degradations: Object.freeze(degradations),
  });
}

function degradation(
  code: SceneCameraDegradationCode,
  message: string,
  requested: number,
  applied: number,
): SceneCameraDegradation {
  return Object.freeze({ code, message, requested, applied });
}

function centerDistancePixels(geometry: MapLibreCameraGeometry): number {
  return (0.5 * geometry.viewportHeightPixels) / Math.tan(geometry.fovRadians / 2);
}

function normalizeGeometry(geometry: MapLibreCameraGeometry): MapLibreCameraGeometry {
  const viewportHeightPixels = positive(
    geometry?.viewportHeightPixels,
    DEFAULT_MAPLIBRE_CAMERA_GEOMETRY.viewportHeightPixels,
  );
  const tileSizePixels = positive(geometry?.tileSizePixels, DEFAULT_MAPLIBRE_CAMERA_GEOMETRY.tileSizePixels);
  const fovRaw = positive(geometry?.fovRadians, DEFAULT_MAPLIBRE_CAMERA_GEOMETRY.fovRadians);
  const fovRadians = fovRaw >= Math.PI ? DEFAULT_MAPLIBRE_CAMERA_GEOMETRY.fovRadians : fovRaw;
  return { viewportHeightPixels, fovRadians, tileSizePixels };
}

function normalizeLimits(limits: MapLibreCameraLimits): MapLibreCameraLimits {
  const minZoom = finite(limits?.minZoom, DEFAULT_MAPLIBRE_CAMERA_LIMITS.minZoom);
  const maxZoomRaw = finite(limits?.maxZoom, DEFAULT_MAPLIBRE_CAMERA_LIMITS.maxZoom);
  return {
    minZoom,
    maxZoom: Math.max(minZoom, maxZoomRaw),
    maxPitch: Math.min(Math.max(finite(limits?.maxPitch, DEFAULT_MAPLIBRE_CAMERA_LIMITS.maxPitch), 0), 89),
    rollSupported: limits?.rollSupported === true,
  };
}

function clampLatitude(latitude: number): number {
  return Math.min(Math.max(latitude, -WEB_MERCATOR_MAX_LATITUDE), WEB_MERCATOR_MAX_LATITUDE);
}

function clampPitch(pitch: number): number {
  return Math.min(Math.max(pitch, 0), 89);
}

function wrapLongitude(longitude: number): number {
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** Wrap into `[0, 360)`, matching the heading range the Cesium half normalizes to. */
function wrapDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Wrap into `(-180, 180]`, the natural range for a signed roll. */
function wrapSignedDegrees(degrees: number): number {
  const wrapped = wrapDegrees(degrees);
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
