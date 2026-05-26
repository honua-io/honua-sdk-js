/**
 * Interactive 3D analysis + measurement widgets for the scene workspace.
 *
 * These widgets consume the server's elevation/analysis endpoints (line-of-sight,
 * viewshed, elevation profile) and render the results into a live Cesium
 * `SceneView`, plus a fully client-side 3D distance/area measurement widget.
 *
 * Like {@link module:scene-workspace/cesium-adapter}, this module never imports
 * CesiumJS statically: the rendering helpers pull the runtime in lazily via
 * `await import("cesium")` so 2D-only consumers never pay the bundle cost. The
 * pure request-shaping and client-side geometry math (haversine distance,
 * spherical polygon area, WKT serialization) carry no Cesium dependency at all
 * and are unit-testable without a WebGL `Viewer`.
 *
 * Server calls go through a caller-supplied {@link SceneAnalysisRequestExecutor}
 * — typically `(...args) => client.pipelineRequestJson(...args)` against a
 * `HonuaClient` — so the widgets reuse the SDK's auth / retry / timeout /
 * interceptor pipeline instead of issuing ad-hoc `fetch` calls.
 *
 * @experimental Part of the experimental `scene-workspace` surface; not yet
 *   covered by the SDK's semver contract prior to `1.0.0`.
 * @module
 */

import type { QueryMethod } from "../core/types.js";

// ---------------------------------------------------------------------------
// Server request transport
// ---------------------------------------------------------------------------

/**
 * The minimal request-executor the analysis widgets need. This is exactly the
 * shape of `HonuaClient.pipelineRequestJson`, so a consumer wires the SDK's
 * shared HTTP pipeline (auth, retries, timeouts, interceptors) in with:
 *
 * ```ts
 * const executor: SceneAnalysisRequestExecutor =
 *   (method, path, init, signal) => client.pipelineRequestJson(method, path, init, signal);
 * ```
 *
 * Modelling the transport as a function rather than depending on the concrete
 * `HonuaClient` keeps this module free of a hard `core/client` import (and keeps
 * it equally usable from a Node backend, a worker, or a test with a mock).
 */
export type SceneAnalysisRequestExecutor = <T = unknown>(
  method: QueryMethod,
  path: string,
  init?: { headers?: Record<string, string>; body?: string | null },
  signal?: AbortSignal,
) => Promise<T>;

/**
 * A lon/lat/height position in the workspace contract units (degrees + metres).
 * Height is optional and defaults to ground (`0`) where the server / renderer
 * needs an explicit value.
 */
export interface SceneAnalysisPosition {
  readonly longitude: number;
  readonly latitude: number;
  readonly height?: number;
}

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" } as const;

function encodePath(datasetId: string, suffix: string): string {
  return `/elevation/${encodeURIComponent(datasetId)}/${suffix}`;
}

function appendQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

// ---------------------------------------------------------------------------
// Client-side geometry (no Cesium, no server)
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;
/** WGS84 mean Earth radius in metres — used for haversine / spherical area. */
const EARTH_RADIUS_METERS = 6_378_137;

/**
 * Great-circle (haversine) distance in metres between two lon/lat positions,
 * ignoring height. Pure; the basis of the horizontal leg of a 3D measurement.
 */
export function haversineMeters(a: SceneAnalysisPosition, b: SceneAnalysisPosition): number {
  const lat1 = a.latitude * DEG2RAD;
  const lat2 = b.latitude * DEG2RAD;
  const dLat = (b.latitude - a.latitude) * DEG2RAD;
  const dLon = (b.longitude - a.longitude) * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Slant (3D) distance in metres between two positions: the horizontal
 * great-circle distance combined with the height delta via Pythagoras. Heights
 * default to `0`. Pure.
 */
export function slantDistanceMeters(a: SceneAnalysisPosition, b: SceneAnalysisPosition): number {
  const ground = haversineMeters(a, b);
  const dz = (b.height ?? 0) - (a.height ?? 0);
  return Math.sqrt(ground * ground + dz * dz);
}

/**
 * Total 3D path length in metres along an ordered polyline (sum of per-segment
 * slant distances). Returns `0` for fewer than two positions. Pure.
 */
export function pathLengthMeters(positions: readonly SceneAnalysisPosition[]): number {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    total += slantDistanceMeters(positions[i - 1] as SceneAnalysisPosition, positions[i] as SceneAnalysisPosition);
  }
  return total;
}

/**
 * Spherical polygon area in square metres for a ring of lon/lat positions,
 * using L'Huilier's spherical-excess formula projected onto the WGS84 mean
 * sphere. The ring is auto-closed; returns `0` for fewer than three positions.
 * The result is unsigned (absolute area). Pure; the basis of the measure
 * widget's area readout.
 */
export function sphericalPolygonAreaSquareMeters(positions: readonly SceneAnalysisPosition[]): number {
  if (positions.length < 3) return 0;
  let total = 0;
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    const p1 = positions[i] as SceneAnalysisPosition;
    const p2 = positions[(i + 1) % n] as SceneAnalysisPosition;
    // Normalize the longitude delta into [-180, 180] so edges crossing the
    // antimeridian use the short arc: e.g. 179.9 → -179.9 must read as +0.2°,
    // not -359.8°, otherwise the area is inflated by orders of magnitude.
    const dLon = normalizeLongitudeDeltaDegrees(p2.longitude - p1.longitude);
    total += dLon * DEG2RAD * (2 + Math.sin(p1.latitude * DEG2RAD) + Math.sin(p2.latitude * DEG2RAD));
  }
  return Math.abs((total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS) / 2);
}

/**
 * Wrap a longitude difference (degrees) into `(-180, 180]` so polygon edges that
 * cross the ±180° antimeridian are integrated along the short arc. Pure.
 */
function normalizeLongitudeDeltaDegrees(deltaDegrees: number): number {
  let d = deltaDegrees % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/**
 * Serialize an ordered list of positions as a 2D WKT `LINESTRING` (lon lat),
 * the geometry shape the elevation profile endpoint expects on its `line`
 * query parameter. Height is dropped (the profile endpoint samples the surface).
 * Pure.
 */
export function positionsToWktLineString(positions: readonly SceneAnalysisPosition[]): string {
  const coords = positions.map((p) => `${p.longitude} ${p.latitude}`).join(", ");
  return `LINESTRING (${coords})`;
}

// ---------------------------------------------------------------------------
// Elevation profile widget (consumes GET /elevation/{datasetId}/profile)
// ---------------------------------------------------------------------------

/** One ordered sample along an elevation profile, mirroring the server shape. */
export interface ElevationProfileSample {
  readonly distanceMeters: number;
  readonly elevation: number | null;
  readonly noData: boolean;
}

/** The decoded `ElevationProfileResponse` the profile endpoint returns. */
export interface ElevationProfileResult {
  readonly datasetId: string;
  readonly layerId: number;
  readonly sampleCount: number;
  readonly lineLengthMeters: number;
  readonly lineSrid: number;
  readonly isAllNoData: boolean;
  readonly samples: readonly ElevationProfileSample[];
}

/** Parameters for an elevation-profile request along a polyline. */
export interface ElevationProfileRequest {
  readonly datasetId: string;
  /** Ordered polyline (>= 2 positions) the profile is sampled along. */
  readonly polyline: readonly SceneAnalysisPosition[];
  /** Number of evenly-spaced samples (server clamps to its configured max). */
  readonly sampleCount?: number;
  /** Sample interval in metres (mutually exclusive with `sampleCount`). */
  readonly intervalMeters?: number;
  /** Spatial reference of the polyline coordinates; omitted ⇒ WGS84 lon/lat. */
  readonly srid?: number;
  readonly mosaicRule?: string;
  readonly signal?: AbortSignal;
}

interface RawProfileResponse {
  datasetId?: string;
  layerId?: number;
  sampleCount?: number;
  lineLengthMeters?: number;
  lineSrid?: number;
  isAllNoData?: boolean;
  samples?: Array<{ distanceMeters?: number; elevation?: number | null; noData?: boolean }>;
}

function normalizeProfileResponse(datasetId: string, raw: RawProfileResponse): ElevationProfileResult {
  const samples: ElevationProfileSample[] = (raw.samples ?? []).map((sample) => ({
    distanceMeters: sample.distanceMeters ?? 0,
    elevation: sample.elevation ?? null,
    noData: sample.noData ?? sample.elevation == null,
  }));
  return {
    datasetId: raw.datasetId ?? datasetId,
    layerId: raw.layerId ?? -1,
    sampleCount: raw.sampleCount ?? samples.length,
    lineLengthMeters: raw.lineLengthMeters ?? 0,
    lineSrid: raw.lineSrid ?? 4326,
    isAllNoData: raw.isAllNoData ?? samples.every((sample) => sample.noData),
    samples,
  };
}

/**
 * Build the relative request path (with query string) for an elevation-profile
 * request, including the WKT-serialized `line`. Exported so the request shape is
 * directly unit-testable without a transport. The profile endpoint is a `GET`.
 */
export function buildElevationProfilePath(request: ElevationProfileRequest): string {
  return appendQuery(encodePath(request.datasetId, "profile"), {
    line: positionsToWktLineString(request.polyline),
    sampleCount: request.sampleCount,
    interval: request.intervalMeters,
    srid: request.srid,
    mosaicRule: request.mosaicRule,
  });
}

/**
 * Request an elevation profile along a polyline and return the decoded samples.
 * Charting is left to the consumer; pair this with
 * {@link renderElevationProfilePolyline} to draw the sampled line in the scene.
 */
export async function requestElevationProfile(
  execute: SceneAnalysisRequestExecutor,
  request: ElevationProfileRequest,
): Promise<ElevationProfileResult> {
  if (request.polyline.length < 2) {
    throw new Error("requestElevationProfile requires a polyline with at least two positions.");
  }
  const raw = await execute<RawProfileResponse>("GET", buildElevationProfilePath(request), undefined, request.signal);
  return normalizeProfileResponse(request.datasetId, raw);
}

// ---------------------------------------------------------------------------
// Line-of-sight widget (consumes POST /elevation/{datasetId}/line-of-sight)
// ---------------------------------------------------------------------------

/** Parameters for a line-of-sight request between an observer and a target. */
export interface LineOfSightRequest {
  readonly datasetId: string;
  readonly observer: SceneAnalysisPosition;
  readonly target: SceneAnalysisPosition;
  /**
   * Observer height OFFSET above the terrain surface, in metres (e.g. eye
   * height). The server's `observerHeight` is exactly this terrain-relative
   * offset, so this value wins over `observer.height` when supplied; otherwise
   * `observer.height` is used as the offset and finally `0`.
   */
  readonly observerOffsetMeters?: number;
  /** Target height OFFSET above the terrain surface, in metres. Same precedence as the observer. */
  readonly targetOffsetMeters?: number;
  /** Number of range samples along the sightline (server requires >= 2 when supplied). */
  readonly sampleCount?: number;
  readonly mosaicRule?: string;
  readonly signal?: AbortSignal;
}

/** The decoded line-of-sight result: visibility + first obstruction (if any). */
export interface LineOfSightResult {
  readonly datasetId: string;
  readonly layerId?: number;
  readonly visible: boolean;
  /** First terrain obstruction between observer and target, when not visible. */
  readonly obstruction?: SceneAnalysisPosition;
  /** Distance from the observer to the first obstruction, in metres, when obstructed. */
  readonly obstructionDistanceMeters?: number;
  /** Great-circle distance between observer and target, in metres. */
  readonly distanceMeters?: number;
  /** Observer elevation (ground elevation + observer height offset), in metres. */
  readonly observerElevation?: number;
  /** Target elevation (ground elevation + target height offset), in metres. */
  readonly targetElevation?: number;
  /** Number of range samples the server took along the sightline. */
  readonly sampleCount?: number;
  /** Whether any sampled point fell on terrain NoData. */
  readonly hasNoDataSamples?: boolean;
}

interface RawLosResponse {
  datasetId?: string;
  layerId?: number;
  visible?: boolean;
  distanceMeters?: number;
  observerGroundElevation?: number;
  observerElevation?: number;
  targetGroundElevation?: number;
  targetElevation?: number;
  sampleCount?: number;
  hasNoDataSamples?: boolean;
  mosaicRule?: string;
  obstruction?: { lon?: number; lat?: number; elevation?: number; distanceMeters?: number } | null;
}

/**
 * Build the FLAT JSON request body sent to the line-of-sight endpoint. Pure.
 *
 * The server contract is flat (`observerLon/observerLat/observerHeight/...`)
 * and treats `observerHeight`/`targetHeight` as the height OFFSET above the
 * terrain surface. We therefore fold the ergonomic offset into that field with
 * precedence `offsetMeters ?? position.height ?? 0`.
 */
export function buildLineOfSightBody(request: LineOfSightRequest): Record<string, unknown> {
  return {
    observerLon: request.observer.longitude,
    observerLat: request.observer.latitude,
    observerHeight: request.observerOffsetMeters ?? request.observer.height ?? 0,
    targetLon: request.target.longitude,
    targetLat: request.target.latitude,
    targetHeight: request.targetOffsetMeters ?? request.target.height ?? 0,
    sampleCount: request.sampleCount,
    mosaicRule: request.mosaicRule,
  };
}

function normalizeLosResponse(datasetId: string, raw: RawLosResponse): LineOfSightResult {
  const obstruction =
    raw.obstruction && raw.obstruction.lon != null && raw.obstruction.lat != null
      ? {
          longitude: raw.obstruction.lon,
          latitude: raw.obstruction.lat,
          height: raw.obstruction.elevation ?? 0,
        }
      : undefined;
  return {
    datasetId: raw.datasetId ?? datasetId,
    layerId: raw.layerId,
    visible: raw.visible ?? obstruction === undefined,
    obstruction,
    obstructionDistanceMeters: raw.obstruction?.distanceMeters,
    distanceMeters: raw.distanceMeters,
    observerElevation: raw.observerElevation,
    targetElevation: raw.targetElevation,
    sampleCount: raw.sampleCount,
    hasNoDataSamples: raw.hasNoDataSamples,
  };
}

/**
 * Request a line-of-sight analysis between an observer and a target. Pair the
 * result with {@link renderLineOfSight} to draw the sightline (green visible /
 * red obstructed segments) and an obstruction marker into the scene.
 */
export async function requestLineOfSight(
  execute: SceneAnalysisRequestExecutor,
  request: LineOfSightRequest,
): Promise<LineOfSightResult> {
  const raw = await execute<RawLosResponse>(
    "POST",
    encodePath(request.datasetId, "line-of-sight"),
    { headers: { ...JSON_HEADERS }, body: JSON.stringify(buildLineOfSightBody(request)) },
    request.signal,
  );
  return normalizeLosResponse(request.datasetId, raw);
}

// ---------------------------------------------------------------------------
// Viewshed widget (consumes POST /elevation/{datasetId}/viewshed)
// ---------------------------------------------------------------------------

/** Parameters for a viewshed request from an observer position. */
export interface ViewshedRequest {
  readonly datasetId: string;
  readonly observer: SceneAnalysisPosition;
  /**
   * Observer height OFFSET above the terrain surface, in metres (e.g. tower /
   * mast height). Maps to the server's `observerHeight`. Precedence:
   * `observerOffsetMeters ?? observer.height ?? 0`.
   */
  readonly observerOffsetMeters?: number;
  /** Height offset applied to each sampled target point, in metres. Maps to the server's `targetHeight`. */
  readonly targetHeightMeters?: number;
  /** Analysis radius in metres. Required, must be > 0. */
  readonly radiusMeters: number;
  /** Number of azimuth rays cast over the full 360°. Server requires >= 1 when supplied. */
  readonly rayCount?: number;
  /** Range samples taken along each ray. Server requires >= 2 when supplied. */
  readonly samplesPerRay?: number;
  readonly mosaicRule?: string;
  readonly signal?: AbortSignal;
}

/** One radial visibility sample returned by the viewshed endpoint. */
export interface ViewshedSample {
  /** The sampled ground point (height is the terrain elevation, or `0` for NoData). */
  readonly position: SceneAnalysisPosition;
  /** Azimuth of the ray this sample belongs to, in degrees. */
  readonly azimuthDegrees: number;
  /** Distance from the observer to this sample along the ray, in metres. */
  readonly distanceMeters: number;
  /** Whether the observer can see this sampled point. */
  readonly visible: boolean;
}

/**
 * The decoded viewshed result. The visible extent is returned as RADIAL POINT
 * SAMPLES (per-ray range samples), not polygon rings.
 */
export interface ViewshedResult {
  readonly datasetId: string;
  readonly layerId?: number;
  readonly observer: SceneAnalysisPosition;
  readonly radiusMeters: number;
  /** Number of azimuth rays cast. */
  readonly rayCount?: number;
  /** Range samples per ray. */
  readonly samplesPerRay?: number;
  /** Total number of samples returned. */
  readonly sampleCount: number;
  /** Number of samples flagged visible. */
  readonly visibleSampleCount: number;
  /** The radial visibility samples. */
  readonly samples: readonly ViewshedSample[];
}

interface RawViewshedResponse {
  datasetId?: string;
  layerId?: number;
  observerGroundElevation?: number;
  observerElevation?: number;
  observerNoData?: boolean;
  radiusMeters?: number;
  rayCount?: number;
  samplesPerRay?: number;
  sampleCount?: number;
  visibleSampleCount?: number;
  mosaicRule?: string;
  samples?: Array<{
    lon?: number;
    lat?: number;
    azimuthDegrees?: number;
    distanceMeters?: number;
    elevation?: number | null;
    visible?: boolean;
  }>;
}

/**
 * Build the FLAT JSON request body sent to the viewshed endpoint. Pure.
 *
 * The server runs a full-360° radial cast controlled by `rayCount` /
 * `samplesPerRay`; there is no azimuth sweep. `observerHeight`/`targetHeight`
 * are terrain-relative offsets (precedence `offset ?? position.height ?? 0` for
 * the observer).
 */
export function buildViewshedBody(request: ViewshedRequest): Record<string, unknown> {
  return {
    observerLon: request.observer.longitude,
    observerLat: request.observer.latitude,
    observerHeight: request.observerOffsetMeters ?? request.observer.height ?? 0,
    targetHeight: request.targetHeightMeters,
    radiusMeters: request.radiusMeters,
    rayCount: request.rayCount,
    samplesPerRay: request.samplesPerRay,
    mosaicRule: request.mosaicRule,
  };
}

function normalizeViewshedResponse(request: ViewshedRequest, raw: RawViewshedResponse): ViewshedResult {
  const samples: ViewshedSample[] = (raw.samples ?? []).map((sample) => ({
    position: {
      longitude: sample.lon ?? 0,
      latitude: sample.lat ?? 0,
      height: sample.elevation ?? 0,
    },
    azimuthDegrees: sample.azimuthDegrees ?? 0,
    distanceMeters: sample.distanceMeters ?? 0,
    visible: sample.visible ?? false,
  }));
  return {
    datasetId: raw.datasetId ?? request.datasetId,
    layerId: raw.layerId,
    observer: request.observer,
    radiusMeters: raw.radiusMeters ?? request.radiusMeters,
    rayCount: raw.rayCount,
    samplesPerRay: raw.samplesPerRay,
    sampleCount: raw.sampleCount ?? samples.length,
    visibleSampleCount: raw.visibleSampleCount ?? samples.filter((sample) => sample.visible).length,
    samples,
  };
}

/**
 * Request a viewshed analysis from an observer position. Pair the result with
 * {@link renderViewshed} to draw the visible / obstructed radial samples.
 */
export async function requestViewshed(
  execute: SceneAnalysisRequestExecutor,
  request: ViewshedRequest,
): Promise<ViewshedResult> {
  const raw = await execute<RawViewshedResponse>(
    "POST",
    encodePath(request.datasetId, "viewshed"),
    { headers: { ...JSON_HEADERS }, body: JSON.stringify(buildViewshedBody(request)) },
    request.signal,
  );
  return normalizeViewshedResponse(request, raw);
}

// ---------------------------------------------------------------------------
// Measurement widget (fully client-side; no server)
// ---------------------------------------------------------------------------

/** A 3D measurement computed from picked / supplied scene positions. */
export interface SceneMeasurement {
  readonly positions: readonly SceneAnalysisPosition[];
  /** Total 3D path length in metres (sum of slant segments). */
  readonly lengthMeters: number;
  /** Per-segment slant distances in metres (length === positions.length - 1). */
  readonly segmentMeters: readonly number[];
  /** Polygon area in m² when `mode` is `area` and there are >= 3 positions. */
  readonly areaSquareMeters?: number;
  readonly mode: "distance" | "area";
}

/**
 * Compute a 3D distance or area measurement from an ordered list of positions
 * (typically picked off the scene). For `distance` the result carries the total
 * 3D path length and per-segment slant distances; for `area` it additionally
 * carries the spherical polygon area. Pure.
 */
export function measureScenePositions(
  positions: readonly SceneAnalysisPosition[],
  mode: "distance" | "area" = "distance",
): SceneMeasurement {
  const segmentMeters: number[] = [];
  for (let i = 1; i < positions.length; i++) {
    segmentMeters.push(
      slantDistanceMeters(positions[i - 1] as SceneAnalysisPosition, positions[i] as SceneAnalysisPosition),
    );
  }
  const measurement: SceneMeasurement = {
    positions,
    lengthMeters: segmentMeters.reduce((sum, segment) => sum + segment, 0),
    segmentMeters,
    mode,
  };
  if (mode === "area") {
    return { ...measurement, areaSquareMeters: sphericalPolygonAreaSquareMeters(positions) };
  }
  return measurement;
}

// ---------------------------------------------------------------------------
// Cesium rendering (lazy import — never statically importing "cesium")
// ---------------------------------------------------------------------------

/**
 * The Cesium `EntityCollection` surface (off `viewer.entities`) the analysis
 * renderers add/remove graphics through. Real Cesium `EntityCollection`
 * instances satisfy this; tests pass a plain object.
 */
export interface CesiumEntityCollectionLike {
  add(entity: unknown): unknown;
  remove(entity: unknown): boolean;
}

/**
 * The minimal slice of `typeof import("cesium")` the analysis renderers touch.
 * Modelled so a `vi.mock("cesium")` stub can satisfy it without a WebGL context.
 */
export interface SceneAnalysisCesiumModule {
  readonly Cartesian3: {
    fromDegrees(longitude: number, latitude: number, height?: number): unknown;
    fromDegreesArrayHeights(coordinates: number[]): unknown;
  };
  readonly Color: {
    fromCssColorString(color: string): unknown;
    readonly LIME: unknown;
    readonly RED: unknown;
    readonly YELLOW: unknown;
  };
}

/**
 * A handle over the entities one analysis render added, so a caller can clear
 * the overlay (e.g. before re-running the analysis). Keyed by a stable kind.
 */
export interface SceneAnalysisOverlay {
  readonly kind: "line-of-sight" | "viewshed" | "elevation-profile" | "measurement";
  readonly entities: readonly unknown[];
  remove(): void;
}

/**
 * Lazily import the CesiumJS runtime. Kept in its own function so the dynamic
 * `import("cesium")` is the only reference to the package here, which is what
 * keeps Cesium out of the 2D bundle (asserted by the static-import guard test).
 */
async function loadAnalysisCesium(): Promise<SceneAnalysisCesiumModule> {
  return (await import("cesium")) as unknown as SceneAnalysisCesiumModule;
}

function flattenHeights(positions: readonly SceneAnalysisPosition[]): number[] {
  const out: number[] = [];
  for (const position of positions) {
    out.push(position.longitude, position.latitude, position.height ?? 0);
  }
  return out;
}

function makeOverlay(
  kind: SceneAnalysisOverlay["kind"],
  entities: CesiumEntityCollectionLike,
  added: readonly unknown[],
): SceneAnalysisOverlay {
  return {
    kind,
    entities: added,
    remove() {
      for (const entity of added) entities.remove(entity);
    },
  };
}

/**
 * Render a line-of-sight result into the scene's entity collection: the
 * observer→target sightline (lime when visible, red when obstructed) plus a
 * yellow point marking the first obstruction when present. Returns an overlay
 * handle so the caller can clear it before re-running. Cesium is loaded lazily.
 */
export async function renderLineOfSight(
  entities: CesiumEntityCollectionLike,
  request: Pick<LineOfSightRequest, "observer" | "target">,
  result: LineOfSightResult,
  cesium?: SceneAnalysisCesiumModule,
): Promise<SceneAnalysisOverlay> {
  const mod = cesium ?? (await loadAnalysisCesium());
  const added: unknown[] = [];
  const sightline = entities.add({
    name: "line-of-sight",
    polyline: {
      positions: mod.Cartesian3.fromDegreesArrayHeights(flattenHeights([request.observer, request.target])),
      width: 3,
      material: result.visible ? mod.Color.LIME : mod.Color.RED,
    },
  });
  added.push(sightline);
  if (result.obstruction) {
    const marker = entities.add({
      name: "line-of-sight-obstruction",
      position: mod.Cartesian3.fromDegrees(
        result.obstruction.longitude,
        result.obstruction.latitude,
        result.obstruction.height ?? 0,
      ),
      point: { pixelSize: 10, color: mod.Color.YELLOW },
    });
    added.push(marker);
  }
  return makeOverlay("line-of-sight", entities, added);
}

/**
 * Render a viewshed result into the scene's entity collection: one point per
 * radial sample — green (`Color.LIME`) where the observer can see the sample,
 * red (`Color.RED`) where it is obstructed. Returns an overlay handle. Cesium
 * is loaded lazily.
 */
export async function renderViewshed(
  entities: CesiumEntityCollectionLike,
  result: ViewshedResult,
  cesium?: SceneAnalysisCesiumModule,
): Promise<SceneAnalysisOverlay> {
  const mod = cesium ?? (await loadAnalysisCesium());
  const added: unknown[] = [];
  for (const sample of result.samples) {
    const point = entities.add({
      name: sample.visible ? "viewshed-visible" : "viewshed-obstructed",
      position: mod.Cartesian3.fromDegrees(
        sample.position.longitude,
        sample.position.latitude,
        sample.position.height ?? 0,
      ),
      point: { pixelSize: 4, color: sample.visible ? mod.Color.LIME : mod.Color.RED },
    });
    added.push(point);
  }
  return makeOverlay("viewshed", entities, added);
}

/**
 * Render an elevation profile's sampled line into the scene's entity collection
 * as a polyline draped at the sampled positions. Because the server returns
 * distance/elevation samples (not lon/lat), the caller passes the original
 * `polyline` so the rendered line aligns with the requested geometry; the
 * sample elevations are not required for the line render and charting is left to
 * the consumer. Returns an overlay handle. Cesium is loaded lazily.
 */
export async function renderElevationProfilePolyline(
  entities: CesiumEntityCollectionLike,
  polyline: readonly SceneAnalysisPosition[],
  cesium?: SceneAnalysisCesiumModule,
): Promise<SceneAnalysisOverlay> {
  const mod = cesium ?? (await loadAnalysisCesium());
  const line = entities.add({
    name: "elevation-profile",
    polyline: {
      positions: mod.Cartesian3.fromDegreesArrayHeights(flattenHeights(polyline)),
      width: 2,
      material: mod.Color.fromCssColorString("#1e90ff"),
      clampToGround: true,
    },
  });
  return makeOverlay("elevation-profile", entities, [line]);
}

/**
 * Render a measurement into the scene's entity collection: the measured
 * polyline (or closed polygon outline for `area`) plus a label at the last
 * vertex with the formatted length / area. Returns an overlay handle. Cesium is
 * loaded lazily.
 */
export async function renderMeasurement(
  entities: CesiumEntityCollectionLike,
  measurement: SceneMeasurement,
  cesium?: SceneAnalysisCesiumModule,
): Promise<SceneAnalysisOverlay> {
  const mod = cesium ?? (await loadAnalysisCesium());
  const added: unknown[] = [];
  const positions = measurement.positions;
  if (positions.length >= 2) {
    const closed = measurement.mode === "area" ? [...positions, positions[0] as SceneAnalysisPosition] : positions;
    const line = entities.add({
      name: "measurement-line",
      polyline: {
        positions: mod.Cartesian3.fromDegreesArrayHeights(flattenHeights(closed)),
        width: 2,
        material: mod.Color.YELLOW,
      },
    });
    added.push(line);
  }
  const last = positions[positions.length - 1];
  if (last) {
    const label = entities.add({
      name: "measurement-label",
      position: mod.Cartesian3.fromDegrees(last.longitude, last.latitude, last.height ?? 0),
      label: { text: formatMeasurementLabel(measurement) },
    });
    added.push(label);
  }
  return makeOverlay("measurement", entities, added);
}

/**
 * Format a human-readable label for a measurement (km/m for distance, km²/m²
 * for area). Pure; exported so consumers can reuse the same formatting in
 * their own UI/labels.
 */
export function formatMeasurementLabel(measurement: SceneMeasurement): string {
  if (measurement.mode === "area" && measurement.areaSquareMeters !== undefined) {
    const area = measurement.areaSquareMeters;
    return area >= 1_000_000 ? `${(area / 1_000_000).toFixed(2)} km²` : `${area.toFixed(1)} m²`;
  }
  const length = measurement.lengthMeters;
  return length >= 1000 ? `${(length / 1000).toFixed(2)} km` : `${length.toFixed(1)} m`;
}
