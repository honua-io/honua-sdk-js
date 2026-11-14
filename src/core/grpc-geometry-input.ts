import { create } from "@bufbuild/protobuf";
import {
  CoordinateSchema,
  CoordinateSequenceSchema,
  GeometrySchema,
  MultiPointGeometrySchema,
  PointGeometrySchema,
  PolygonGeometrySchema,
  PolylineGeometrySchema,
  SpatialReferenceSchema,
} from "../gen/geospatial/v1/index.js";

export function toProtoGeometry(geometryValue: string | Record<string, unknown>): {
  geometry: ReturnType<typeof create<typeof GeometrySchema>>;
  spatialReference?: ReturnType<typeof create<typeof SpatialReferenceSchema>>;
} {
  const source = parseGeometryValue(geometryValue);
  const dimensions = { hasZ: source.hasZ, hasM: source.hasM };
  const geometry = create(GeometrySchema);

  if (isPoint(source)) {
    geometry.shape = { case: "point", value: inputPoint(source) };
  } else if (isEnvelope(source)) {
    geometry.shape = { case: "polygon", value: inputEnvelope(source) };
  } else if (isMultipoint(source)) {
    const multipoint = create(MultiPointGeometrySchema);
    multipoint.points = source.points.map((point, index) =>
      toPointGeometryFromArray(point, `points[${index}]`, dimensions),
    );
    geometry.shape = { case: "multiPoint", value: multipoint };
  } else if (isPolyline(source)) {
    const polyline = create(PolylineGeometrySchema);
    polyline.paths = source.paths.map((path, index) => toCoordinateSequence(path, `paths[${index}]`, dimensions));
    geometry.shape = { case: "polyline", value: polyline };
  } else if (isPolygon(source)) {
    const polygon = create(PolygonGeometrySchema);
    polygon.rings = source.rings.map((ring, index) => toCoordinateSequence(ring, `rings[${index}]`, dimensions));
    geometry.shape = { case: "polygon", value: polygon };
  } else {
    throw new Error("Unsupported geometry shape for gRPC transport.");
  }

  return {
    geometry,
    spatialReference: toProtoSpatialReference((source as Record<string, unknown>).spatialReference),
  };
}

function parseGeometryValue(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Geometry must be a JSON object for gRPC transport.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Geometry JSON must parse to an object for gRPC transport.");
    }
    return parsed as Record<string, unknown>;
  }
  return value;
}

export function toProtoSpatialReference(
  value: unknown,
): ReturnType<typeof create<typeof SpatialReferenceSchema>> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const spatialReference = create(SpatialReferenceSchema);
    spatialReference.wkid = value;
    return spatialReference;
  }
  if (typeof value === "string") {
    return stringSpatialReference(value);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const spatialReference = create(SpatialReferenceSchema);
  const source = value as Record<string, unknown>;
  const wkid = source.wkid;
  if (typeof wkid === "number" && Number.isFinite(wkid)) {
    spatialReference.wkid = wkid;
  }
  const latestWkid = source.latestWkid;
  if (typeof latestWkid === "number" && Number.isFinite(latestWkid)) {
    spatialReference.latestWkid = latestWkid;
  }
  const wkt = source.wkt;
  if (typeof wkt === "string" && wkt.length > 0) {
    spatialReference.wkt = wkt;
  }
  if (spatialReference.wkid === 0 && spatialReference.latestWkid === 0 && !spatialReference.wkt) {
    return undefined;
  }
  return spatialReference;
}

interface GeometryDimensions {
  hasZ?: unknown;
  hasM?: unknown;
}

function coordinateDimensions(value: unknown[], dimensions: GeometryDimensions): { z?: number; m?: number } {
  const result: { z?: number; m?: number } = {};
  const mOnly = dimensions.hasM === true && dimensions.hasZ !== true;
  const z = mOnly || dimensions.hasZ === false ? undefined : value[2];
  const m = dimensions.hasM === false ? undefined : value[mOnly ? 2 : 3];
  if (typeof z === "number" && Number.isFinite(z)) result.z = z;
  if (typeof m === "number" && Number.isFinite(m)) result.m = m;
  return result;
}

function toPointGeometryFromArray(
  value: unknown,
  context: string,
  dimensions: GeometryDimensions = {},
): ReturnType<typeof create<typeof PointGeometrySchema>> {
  const { x, y, z, m } = toCoordinate(value, context, dimensions);
  return create(PointGeometrySchema, { x, y, z, m });
}

function toCoordinateSequence(
  value: unknown,
  context = "coords",
  dimensions: GeometryDimensions = {},
): ReturnType<typeof create<typeof CoordinateSequenceSchema>> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid coordinate sequence at ${context}`);
  }
  const sequence = create(CoordinateSequenceSchema);
  sequence.coords = value.map((coord, index) => toCoordinate(coord, `${context}[${index}]`, dimensions));
  return sequence;
}

function toCoordinate(
  value: unknown,
  context: string,
  dimensions: GeometryDimensions = {},
): ReturnType<typeof create<typeof CoordinateSchema>> {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`Invalid coordinate at ${context}`);
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid coordinate values at ${context}`);
  }

  const coordinate = create(CoordinateSchema);
  coordinate.x = x;
  coordinate.y = y;
  Object.assign(coordinate, coordinateDimensions(value, dimensions));
  return coordinate;
}

function isPoint(value: Record<string, unknown>): value is { x: number; y: number; z?: number; m?: number } {
  return typeof value.x === "number" && typeof value.y === "number";
}

function isEnvelope(
  value: Record<string, unknown>,
): value is { xmin: number; ymin: number; xmax: number; ymax: number } {
  return (
    typeof value.xmin === "number" &&
    typeof value.ymin === "number" &&
    typeof value.xmax === "number" &&
    typeof value.ymax === "number"
  );
}

function isMultipoint(value: Record<string, unknown>): value is { points: unknown[] } {
  return Array.isArray(value.points);
}

function isPolyline(value: Record<string, unknown>): value is { paths: unknown[] } {
  return Array.isArray(value.paths);
}

function isPolygon(value: Record<string, unknown>): value is { rings: unknown[] } {
  return Array.isArray(value.rings);
}

function inputPoint(source: { x: number; y: number; z?: number; m?: number }) {
  const point = create(PointGeometrySchema, { x: source.x, y: source.y });
  if (typeof source.z === "number" && Number.isFinite(source.z)) point.z = source.z;
  if (typeof source.m === "number" && Number.isFinite(source.m)) point.m = source.m;
  return point;
}

function inputEnvelope(source: { xmin: number; ymin: number; xmax: number; ymax: number }) {
  return create(PolygonGeometrySchema, {
    rings: [
      toCoordinateSequence([
        [source.xmin, source.ymin],
        [source.xmax, source.ymin],
        [source.xmax, source.ymax],
        [source.xmin, source.ymax],
        [source.xmin, source.ymin],
      ]),
    ],
  });
}

function stringSpatialReference(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    const spatialReference = create(SpatialReferenceSchema);
    spatialReference.wkid = asNumber;
    return spatialReference;
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return toProtoSpatialReference(parsed);
    } catch {
      throw new Error("Invalid outSr JSON for gRPC transport.");
    }
  }

  const spatialReference = create(SpatialReferenceSchema);
  spatialReference.wkt = trimmed;
  return spatialReference;
}
