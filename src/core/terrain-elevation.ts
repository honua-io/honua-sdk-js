/**
 * Pure, DOM-free helpers for decoding RGB-encoded elevation tiles and
 * sampling an elevation profile along a line.
 *
 * Two encodings dominate Terrain-RGB / raster-DEM tiles in the wild:
 *
 * - **Mapbox Terrain-RGB** — `elevation = -10000 + ((R*256*256 + G*256 + B) * 0.1)`
 *   metres. This is the encoding MapLibre's `raster-dem` source uses with
 *   `encoding: "mapbox"`.
 * - **Terrarium (Mapzen / AWS Terrain Tiles)** — `elevation = (R*256 + G + B/256) - 32768`
 *   metres, used by MapLibre with `encoding: "terrarium"`.
 *
 * These functions are intentionally free of any map or DOM dependency so
 * they can run anywhere (browser, Node, workers) and be unit-tested against
 * known pixel → elevation values. `sampleElevationProfile` walks a line and
 * resolves an elevation at each sampled coordinate through a caller-supplied
 * accessor (e.g. a decoded raster lookup or a server elevation endpoint),
 * returning per-sample distance + elevation plus gain/loss summary stats.
 *
 * @module
 */

/** Mean Earth radius in metres, used for great-circle distance. */
const EARTH_RADIUS_METERS = 6_371_000;

/** A `[longitude, latitude]` coordinate pair in degrees (WGS84). */
export type ElevationCoordinate = readonly [longitude: number, latitude: number];

/**
 * Decodes a single Mapbox Terrain-RGB pixel into metres above sea level.
 *
 * `height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)`
 *
 * Channel values are clamped to the 0–255 byte range, so callers may pass
 * raw `ImageData`/`Uint8ClampedArray` samples directly.
 */
export function decodeTerrainRgbElevation(red: number, green: number, blue: number): number {
  const r = clampByte(red);
  const g = clampByte(green);
  const b = clampByte(blue);
  return -10_000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

/**
 * Decodes a single Terrarium (Mapzen / AWS Terrain Tiles) pixel into metres
 * above sea level.
 *
 * `height = (R * 256 + G + B / 256) - 32768`
 *
 * Channel values are clamped to the 0–255 byte range.
 */
export function decodeTerrariumElevation(red: number, green: number, blue: number): number {
  const r = clampByte(red);
  const g = clampByte(green);
  const b = clampByte(blue);
  return r * 256 + g + b / 256 - 32_768;
}

/** Terrain-RGB pixel encodings supported by {@link decodeElevationPixel}. */
export type TerrainElevationEncoding = "mapbox" | "terrarium";

/**
 * Decodes a Terrain-RGB pixel using the named encoding. Convenience wrapper
 * over {@link decodeTerrainRgbElevation} / {@link decodeTerrariumElevation}
 * for code that carries a MapLibre `raster-dem` `encoding` value.
 */
export function decodeElevationPixel(
  encoding: TerrainElevationEncoding,
  red: number,
  green: number,
  blue: number,
): number {
  return encoding === "terrarium"
    ? decodeTerrariumElevation(red, green, blue)
    : decodeTerrainRgbElevation(red, green, blue);
}

/** One sampled point of an elevation profile. */
export interface ElevationProfileSample {
  /** Sampled coordinate `[longitude, latitude]`. */
  readonly coordinate: ElevationCoordinate;
  /** Cumulative great-circle distance from the line start, in metres. */
  readonly distanceMeters: number;
  /** Elevation in metres returned by the sampler for this coordinate. */
  readonly elevationMeters: number;
}

/** An elevation profile sampled along a line. */
export interface ElevationProfile {
  /** The line that was sampled (the input, verbatim). */
  readonly line: readonly ElevationCoordinate[];
  /** The sampled points, ordered from line start to end. */
  readonly samples: readonly ElevationProfileSample[];
  /** Total great-circle length of the line, in metres. */
  readonly totalDistanceMeters: number;
  /** Lowest sampled elevation, in metres (0 when there are no samples). */
  readonly minElevationMeters: number;
  /** Highest sampled elevation, in metres (0 when there are no samples). */
  readonly maxElevationMeters: number;
  /** Cumulative elevation gain across consecutive samples, in metres. */
  readonly gainMeters: number;
  /** Cumulative elevation loss across consecutive samples, in metres. */
  readonly lossMeters: number;
}

/**
 * Resolves an elevation (metres) for a sampled coordinate. May be sync or
 * async — a decoded raster lookup, a server elevation endpoint, or anything
 * else. Receives the sample index and cumulative distance for convenience.
 * Return a non-finite value (e.g. `NaN`) to mark a coordinate as no-data; it
 * is treated as `0` in the profile summary.
 */
export type ElevationSampler = (
  coordinate: ElevationCoordinate,
  context: { readonly index: number; readonly distanceMeters: number },
) => number | Promise<number>;

/** Options for {@link sampleElevationProfile}. */
export interface SampleElevationProfileOptions {
  /** The polyline to sample, as `[lon, lat]` vertices (>= 2 required). */
  readonly line: readonly ElevationCoordinate[];
  /** How elevation is resolved at each sampled coordinate. */
  readonly sampler: ElevationSampler;
  /**
   * Number of evenly spaced samples (including both endpoints). Defaults to
   * `Math.max(2, line.length)`. Clamped to a minimum of 2.
   */
  readonly sampleCount?: number;
}

/**
 * Samples elevation at evenly spaced points along a line and returns a
 * profile with per-sample distance + elevation plus gain/loss/min/max stats.
 *
 * The line is resampled into `sampleCount` points spaced by equal
 * great-circle distance (not by vertex), so the profile is independent of how
 * densely the input line is digitized. Elevation at each point comes from the
 * supplied {@link ElevationSampler}; samplers may be async and are awaited in
 * order. No DOM or map dependency.
 *
 * @throws {RangeError} when `line` has fewer than two coordinates.
 */
export async function sampleElevationProfile(options: SampleElevationProfileOptions): Promise<ElevationProfile> {
  const { line, sampler } = options;
  if (line.length < 2) {
    throw new RangeError("sampleElevationProfile requires a line with at least two coordinates.");
  }

  const segmentLengths = line.slice(1).map((point, index) => haversineMeters(line[index]!, point));
  const totalDistanceMeters = segmentLengths.reduce((sum, value) => sum + value, 0);
  const sampleCount = Math.max(2, Math.trunc(options.sampleCount ?? Math.max(2, line.length)));

  const samples: ElevationProfileSample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const distanceMeters = totalDistanceMeters * (index / (sampleCount - 1));
    const coordinate = interpolateAlongLine(line, segmentLengths, distanceMeters);
    const elevation = await sampler(coordinate, { index, distanceMeters });
    samples.push({
      coordinate,
      distanceMeters,
      elevationMeters: Number.isFinite(elevation) ? elevation : 0,
    });
  }

  return summarize(line, samples, totalDistanceMeters);
}

function summarize(
  line: readonly ElevationCoordinate[],
  samples: readonly ElevationProfileSample[],
  totalDistanceMeters: number,
): ElevationProfile {
  const elevations = samples.map((sample) => sample.elevationMeters);
  let gainMeters = 0;
  let lossMeters = 0;
  for (let index = 1; index < elevations.length; index += 1) {
    const delta = elevations[index]! - elevations[index - 1]!;
    if (delta > 0) gainMeters += delta;
    else lossMeters += Math.abs(delta);
  }
  return {
    line,
    samples,
    totalDistanceMeters,
    minElevationMeters: elevations.length > 0 ? Math.min(...elevations) : 0,
    maxElevationMeters: elevations.length > 0 ? Math.max(...elevations) : 0,
    gainMeters,
    lossMeters,
  };
}

function interpolateAlongLine(
  line: readonly ElevationCoordinate[],
  segmentLengths: readonly number[],
  targetDistance: number,
): ElevationCoordinate {
  let traversed = 0;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index]!;
    if (targetDistance <= traversed + segmentLength || index === segmentLengths.length - 1) {
      const start = line[index]!;
      const end = line[index + 1]!;
      const ratio = segmentLength === 0 ? 0 : (targetDistance - traversed) / segmentLength;
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    traversed += segmentLength;
  }
  return line.at(-1)!;
}

/** Great-circle distance between two `[lon, lat]` coordinates, in metres. */
export function haversineMeters([lon1, lat1]: ElevationCoordinate, [lon2, lat2]: ElevationCoordinate): number {
  const phi1 = degreesToRadians(lat1);
  const phi2 = degreesToRadians(lat2);
  const deltaPhi = degreesToRadians(lat2 - lat1);
  const deltaLambda = degreesToRadians(lon2 - lon1);
  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}
