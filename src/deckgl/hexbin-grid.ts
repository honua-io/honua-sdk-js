import type { DeckGlHexbinRequest } from "./hexbin.js";
import { HonuaDeckGlAdapterError } from "./types.js";

const EARTH_RADIUS = 6_378_137;
const MAX_LATITUDE = 85.0511287798066;
const DEGREES = Math.PI / 180;
const VERTICES_PER_BIN = 7;

export interface Bin {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  count: number;
}

export interface HexbinLimits {
  readonly rows: number;
  readonly maxBins: number;
}

export function countBins(request: DeckGlHexbinRequest, limits: HexbinLimits) {
  const bins: Bin[] = [];
  const lookup = new Map<string, number>();
  const assignments = new Uint32Array(limits.rows);
  const maxBins = limits.maxBins;
  for (let row = 0; row < limits.rows; row++) {
    const [x, y] = project(request.positions[row * 2], request.positions[row * 2 + 1]);
    const [q, r] = roundHex(
      ((Math.sqrt(3) * x) / 3 - y / 3) / request.radiusMeters,
      (2 * y) / 3 / request.radiusMeters,
    );
    const id = `${request.radiusMeters}:${q}:${r}`;
    let index = lookup.get(id);
    if (index === undefined) {
      if (bins.length >= maxBins) throw new HonuaDeckGlAdapterError("limit-exceeded", "Hexbin count exceeds maxBins.");
      index = bins.length;
      bins.push({
        id,
        x: request.radiusMeters * Math.sqrt(3) * (q + r / 2),
        y: request.radiusMeters * 1.5 * r,
        count: 0,
      });
      lookup.set(id, index);
    }
    bins[index].count++;
    assignments[row] = index;
  }
  return { bins, assignments };
}

function project(longitude: number, latitude: number): [number, number] {
  if (
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180 ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > MAX_LATITUDE
  ) {
    throw invalid("Hexbin positions must be finite WGS84 coordinates within the Web Mercator latitude range.");
  }
  return [
    EARTH_RADIUS * longitude * DEGREES,
    EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (latitude * DEGREES) / 2)),
  ];
}

export function unproject(x: number, y: number): [number, number] {
  return [x / EARTH_RADIUS / DEGREES, (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEGREES];
}

function roundHex(q: number, r: number): [number, number] {
  let roundedQ = Math.round(q);
  let roundedR = Math.round(r);
  const roundedS = Math.round(-q - r);
  const differenceQ = Math.abs(roundedQ - q);
  const differenceR = Math.abs(roundedR - r);
  if (differenceQ > differenceR && differenceQ > Math.abs(roundedS + q + r)) roundedQ = -roundedR - roundedS;
  else if (differenceR > Math.abs(roundedS + q + r)) roundedR = -roundedQ - roundedS;
  return [roundedQ, roundedR];
}

export function binGeometry(bins: readonly Bin[], request: DeckGlHexbinRequest) {
  const positions = new Float64Array(bins.length * VERTICES_PER_BIN * 2);
  const colors = new Uint8Array(bins.length * VERTICES_PER_BIN * 4);
  const startIndices = new Uint32Array(bins.length + 1);
  for (let index = 0; index < bins.length; index++) {
    const bin = bins[index];
    const color = request.color?.(bin.count) ?? [0, 120, 180, 210];
    if (color.length !== 4 || !color.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
      throw invalid("Hexbin colors must be RGBA bytes.");
    startIndices[index] = index * VERTICES_PER_BIN;
    for (let vertex = 0; vertex < VERTICES_PER_BIN; vertex++) {
      const angle = ((vertex % 6) * 60 + 30) * DEGREES;
      const point = unproject(
        bin.x + request.radiusMeters * Math.cos(angle),
        bin.y + request.radiusMeters * Math.sin(angle),
      );
      positions.set(point, (index * VERTICES_PER_BIN + vertex) * 2);
      colors.set(color, (index * VERTICES_PER_BIN + vertex) * 4);
    }
  }
  startIndices[bins.length] = bins.length * VERTICES_PER_BIN;
  return {
    length: bins.length * VERTICES_PER_BIN,
    startIndices,
    attributes: {
      getPolygon: { value: positions, size: 2 as const },
      getFillColor: { value: colors, size: 4 as const },
    },
  };
}

function invalid(message: string): HonuaDeckGlAdapterError {
  return new HonuaDeckGlAdapterError("invalid-data", message);
}
