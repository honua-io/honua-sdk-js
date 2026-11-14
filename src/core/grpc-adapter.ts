import { toProtoGeometry, toProtoSpatialReference } from "./grpc-geometry-input.js";
import { toProtoObjectId, toSafeNumberOrString } from "./grpc-int64.js";
export { toProtoApplyEditsRequest, fromProtoApplyEditsResponse } from "./grpc-edits.js";
import { create } from "@bufbuild/protobuf";
import {
  type AttributeValue,
  DistanceUnit,
  type FeaturePage,
  FieldType,
  GeometryType,
  type Feature as ProtoFeature,
  type FieldDefinition as ProtoFieldDefinition,
  QueryFeaturesRequestSchema,
  type QueryFeaturesResponse,
  SpatialFilterSchema,
  SpatialRelationship,
} from "../gen/geospatial/v1/index.js";
import { HonuaCapabilityNotSupportedError, HonuaGrpcError } from "./errors.js";
import { geometryInputSpatialReference } from "./geometry-input-sr.js";
import type {
  HonuaCountResponse,
  HonuaExtentResponse,
  HonuaFeature,
  HonuaFieldInfo,
  HonuaObjectIdsResponse,
  HonuaQueryResponse,
  HonuaSpatialReference,
  QueryFeaturesRequest,
} from "./types.js";

/**
 * Maps proto FieldType enum values to Esri-style field type strings
 * used in the JSON response shape.
 */
const FIELD_TYPE_MAP: Record<number, string> = {
  [FieldType.STRING]: "esriFieldTypeString",
  [FieldType.INTEGER]: "esriFieldTypeInteger",
  // BIG_INTEGER must map to esriFieldTypeBigInteger so a 64-bit column reports
  // the same field type as the PBF fast path (mapPbfFieldTypeToGeoServices maps
  // PBF type 13 -> esriFieldTypeBigInteger). Mapping it to esriFieldTypeInteger
  // made a 64-bit column's reported type diverge between the gRPC and PBF
  // transports for the same dataset.
  [FieldType.BIG_INTEGER]: "esriFieldTypeBigInteger",
  [FieldType.DOUBLE]: "esriFieldTypeDouble",
  [FieldType.FLOAT]: "esriFieldTypeSingle",
  // Esri/GeoServices has no boolean field type; ArcGIS surfaces booleans as a
  // small integer, and the PBF schema likewise carries booleans as small
  // integers, so esriFieldTypeSmallInteger keeps the two transports in parity.
  [FieldType.BOOLEAN]: "esriFieldTypeSmallInteger",
  [FieldType.DATE_TIME]: "esriFieldTypeDate",
  [FieldType.DATE]: "esriFieldTypeDate",
  [FieldType.TIME]: "esriFieldTypeDate",
  [FieldType.GEOMETRY]: "esriFieldTypeGeometry",
  [FieldType.JSON]: "esriFieldTypeString",
  [FieldType.BINARY]: "esriFieldTypeBlob",
  [FieldType.UUID]: "esriFieldTypeGUID",
};

/**
 * Maps proto GeometryType enum values to Esri-style geometry type strings.
 */
const GEOMETRY_TYPE_MAP: Record<number, string> = {
  [GeometryType.POINT]: "esriGeometryPoint",
  [GeometryType.MULTI_POINT]: "esriGeometryMultipoint",
  [GeometryType.LINE_STRING]: "esriGeometryPolyline",
  [GeometryType.MULTI_LINE_STRING]: "esriGeometryPolyline",
  [GeometryType.POLYGON]: "esriGeometryPolygon",
  [GeometryType.MULTI_POLYGON]: "esriGeometryPolygon",
  [GeometryType.NONE]: "esriGeometryNull",
};

const GEOSERVICES_TO_PROTO_SPATIAL_REL_MAP: Record<string, SpatialRelationship> = {
  esriSpatialRelIntersects: SpatialRelationship.INTERSECTS,
  esriSpatialRelContains: SpatialRelationship.CONTAINS,
  esriSpatialRelWithin: SpatialRelationship.WITHIN,
  esriSpatialRelEnvelopeIntersects: SpatialRelationship.ENVELOPE_INTERSECTS,
  esriSpatialRelIndexIntersects: SpatialRelationship.ENVELOPE_INTERSECTS,
  esriSpatialRelCrosses: SpatialRelationship.CROSSES,
  esriSpatialRelTouches: SpatialRelationship.TOUCHES,
  esriSpatialRelOverlaps: SpatialRelationship.OVERLAPS,
  esriSpatialRelDisjoint: SpatialRelationship.DISJOINT,
};

const GEOSERVICES_TO_PROTO_DISTANCE_UNIT_MAP: Record<string, DistanceUnit> = {
  esrisrunit_meter: DistanceUnit.METERS,
  meter: DistanceUnit.METERS,
  meters: DistanceUnit.METERS,
  m: DistanceUnit.METERS,
  esrisrunit_foot: DistanceUnit.FEET,
  esrisrunit_usfoot: DistanceUnit.FEET,
  foot: DistanceUnit.FEET,
  feet: DistanceUnit.FEET,
  ft: DistanceUnit.FEET,
  esrisrunit_kilometer: DistanceUnit.KILOMETERS,
  kilometer: DistanceUnit.KILOMETERS,
  kilometers: DistanceUnit.KILOMETERS,
  km: DistanceUnit.KILOMETERS,
  esrisrunit_statutemile: DistanceUnit.MILES,
  mile: DistanceUnit.MILES,
  miles: DistanceUnit.MILES,
  mi: DistanceUnit.MILES,
};

function toProtoPageInt64(field: "resultOffset" | "resultRecordCount", value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer for the gRPC int64 contract`);
  }
  return BigInt(value);
}

/**
 * Converts a SDK QueryFeaturesRequest into a proto QueryFeaturesRequest message.
 */
export function toProtoQueryRequest(request: QueryFeaturesRequest) {
  if (
    request.outStatistics !== undefined ||
    request.groupByFieldsForStatistics !== undefined ||
    request.extraParams?.outStatistics !== undefined ||
    request.extraParams?.groupByFieldsForStatistics !== undefined
  ) {
    throw new HonuaCapabilityNotSupportedError("queryAggregate", "grpc", `${request.serviceId}/${request.layerId}`);
  }
  const msg = create(QueryFeaturesRequestSchema);
  msg.serviceId = request.serviceId;
  msg.layerId = request.layerId;
  msg.where = request.where ?? "1=1";
  msg.returnGeometry = request.returnGeometry ?? true;

  const outSpatialReference =
    toProtoSpatialReference(request.outSr) ??
    toProtoSpatialReference(request.extraParams?.outSR) ??
    toProtoSpatialReference(request.extraParams?.outSr);
  if (outSpatialReference) {
    msg.outSr = outSpatialReference;
  }

  if (request.outFields !== undefined) {
    const fields =
      typeof request.outFields === "string"
        ? request.outFields
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
        : request.outFields;
    msg.outFields = fields;
  }

  if (request.objectIds !== undefined) {
    const ids =
      typeof request.objectIds === "string"
        ? request.objectIds.split(",").map(toProtoObjectId)
        : request.objectIds.map((id) => {
            if (!Number.isSafeInteger(id)) {
              throw new RangeError("objectIds must contain only safe integers for the gRPC int64 contract");
            }
            return BigInt(id);
          });
    msg.objectIds = ids;
  }

  if (request.resultOffset !== undefined) {
    msg.resultOffsetLong = toProtoPageInt64("resultOffset", request.resultOffset);
  }
  if (request.resultRecordCount !== undefined) {
    msg.resultRecordCountLong = toProtoPageInt64("resultRecordCount", request.resultRecordCount);
  }
  if (request.orderByFields !== undefined) {
    msg.orderBy = request.orderByFields;
  }
  if (request.returnDistinctValues !== undefined) {
    msg.returnDistinct = request.returnDistinctValues;
  }
  if (request.geometry !== undefined) {
    const filter = create(SpatialFilterSchema);
    const { geometry, spatialReference } = toProtoGeometry(request.geometry);
    filter.geometry = geometry;

    if (request.spatialRel) {
      const mapped = GEOSERVICES_TO_PROTO_SPATIAL_REL_MAP[request.spatialRel];
      if (!mapped) {
        throw new Error(`Unsupported spatial relationship for gRPC transport: ${request.spatialRel}`);
      }
      filter.spatialRelationship = mapped;
    } else {
      filter.spatialRelationship = SpatialRelationship.INTERSECTS;
    }

    const inputSpatialReference =
      spatialReference ??
      toProtoSpatialReference(request.extraParams?.inSR) ??
      toProtoSpatialReference(geometryInputSpatialReference(request.geometry));
    if (inputSpatialReference) {
      filter.spatialReference = inputSpatialReference;
    }

    const distance = request.distance ?? parseExtraNumber(request.extraParams ?? {}, "distance");
    if (distance !== undefined) {
      filter.distance = distance;
    }

    const nearestCountRaw = request.nearestCount ?? parseExtraNumber(request.extraParams ?? {}, "nearestCount");
    if (nearestCountRaw !== undefined) {
      filter.nearestCount = Math.trunc(nearestCountRaw);
    }

    const returnDistance = request.returnDistance ?? parseExtraBoolean(request.extraParams ?? {}, "returnDistance");
    if (returnDistance !== undefined) {
      filter.returnDistance = returnDistance;
    }

    const unit = request.units ?? parseExtraString(request.extraParams ?? {}, "units");
    if (unit !== undefined) {
      const mappedUnit = GEOSERVICES_TO_PROTO_DISTANCE_UNIT_MAP[unit.trim().toLowerCase()];
      if (!mappedUnit) {
        throw new Error(`Unsupported distance unit for gRPC transport: ${unit}`);
      }

      filter.distanceUnit = mappedUnit;
    }

    msg.spatialFilter = filter;
  }

  if (request.extraParams) {
    const returnCountOnly = parseExtraBoolean(request.extraParams, "returnCountOnly");
    if (returnCountOnly !== undefined) {
      msg.returnCountOnly = returnCountOnly;
    }

    const returnIdsOnly = parseExtraBoolean(request.extraParams, "returnIdsOnly");
    if (returnIdsOnly !== undefined) {
      msg.returnIdsOnly = returnIdsOnly;
    }

    const returnExtentOnly = parseExtraBoolean(request.extraParams, "returnExtentOnly");
    if (returnExtentOnly !== undefined) {
      msg.returnExtentOnly = returnExtentOnly;
    }

    const geometryPrecision = parseExtraNumber(request.extraParams, "geometryPrecision");
    if (geometryPrecision !== undefined) {
      msg.geometryPrecision = geometryPrecision;
    }

    const maxAllowableOffset = parseExtraNumber(request.extraParams, "maxAllowableOffset");
    if (maxAllowableOffset !== undefined) {
      msg.maxAllowableOffset = maxAllowableOffset;
    }
  }

  return msg;
}

/**
 * Converts a proto QueryFeaturesResponse into the JSON-compatible shape
 * matching the `f=json` response format.
 */
export function fromProtoQueryResponse(
  response: QueryFeaturesResponse,
): HonuaQueryResponse | HonuaCountResponse | HonuaObjectIdsResponse | HonuaExtentResponse {
  const hasFeatureMetadata =
    response.fields.length > 0 ||
    response.objectIdFieldName.length > 0 ||
    response.geometryType !== GeometryType.UNSPECIFIED ||
    response.spatialReference !== undefined ||
    response.exceededTransferLimit;

  // Count-only response. Handle zero-count results as well.
  if (
    response.features.length === 0 &&
    response.objectIds.length === 0 &&
    response.extent === undefined &&
    (response.count !== 0n || !hasFeatureMetadata)
  ) {
    return { count: toSafeNumberOrString(response.count) };
  }

  // IDs-only response
  if (isIdsOnlyResponse(response)) {
    return {
      objectIdFieldName: response.objectIdFieldName,
      objectIds: response.objectIds.map(toSafeNumberOrString),
    };
  }

  // Extent-only response
  if (response.extent && response.features.length === 0) {
    const ext = response.extent;
    return {
      extent: {
        xmin: ext.xmin,
        ymin: ext.ymin,
        xmax: ext.xmax,
        ymax: ext.ymax,
        spatialReference: ext.spatialReference ? convertSpatialReference(ext.spatialReference) : undefined,
      },
      ...(response.count !== 0n ? { count: toSafeNumberOrString(response.count) } : {}),
    };
  }

  // Standard feature response
  return {
    objectIdFieldName: response.objectIdFieldName,
    geometryType: GEOMETRY_TYPE_MAP[response.geometryType] ?? "esriGeometryPoint",
    spatialReference: response.spatialReference ? convertSpatialReference(response.spatialReference) : undefined,
    fields: response.fields.map(convertField),
    features: response.features.map((feature) => convertFeature(feature, response.objectIdFieldName)),
    exceededTransferLimit: response.exceededTransferLimit || undefined,
  };
}

function isIdsOnlyResponse(response: QueryFeaturesResponse): boolean {
  if (response.features.length > 0 || response.extent !== undefined) {
    return false;
  }

  if (response.objectIds.length > 0) {
    return true;
  }

  return (
    response.objectIdFieldName.length > 0 &&
    response.fields.length === 0 &&
    response.geometryType === GeometryType.UNSPECIFIED &&
    response.spatialReference === undefined &&
    response.count === 0n &&
    !response.exceededTransferLimit
  );
}

function parseExtraBoolean(params: Record<string, string | number | boolean>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return undefined;
}

function parseExtraNumber(params: Record<string, string | number | boolean>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseExtraString(params: Record<string, string | number | boolean>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }

  return String(value);
}

/**
 * Converts a stream of proto FeaturePages into an async generator
 * that yields arrays of JSON-compatible features, matching the
 * existing queryFeaturesStream yield type.
 */
export async function* streamProtoPages(
  stream: AsyncIterable<FeaturePage>,
): AsyncGenerator<HonuaFeature[], void, undefined> {
  // Metadata is populated on the first page only; later pages reuse it.
  let objectIdFieldName = "";
  try {
    for await (const page of stream) {
      if (page.objectIdFieldName) {
        objectIdFieldName = page.objectIdFieldName;
      }
      if (page.features.length === 0 && page.isLastPage) {
        break;
      }
      const features = page.features.map((feature) => convertFeature(feature, objectIdFieldName));
      if (features.length > 0) {
        yield features;
      }
      if (page.isLastPage) {
        break;
      }
    }
  } catch (error) {
    throw wrapConnectError(error);
  }
}

/**
 * Wraps a ConnectError (or any error from the gRPC transport) in a
 * HonuaGrpcError for consistent `instanceof` discrimination.
 */
export function wrapConnectError(error: unknown): Error {
  if (error instanceof HonuaGrpcError) return error;
  if (error instanceof Error && "code" in error && typeof (error as Record<string, unknown>).code === "number") {
    const candidate = error as Record<string, unknown>;
    return new HonuaGrpcError(
      candidate.code as number,
      error.message,
      "rawMessage" in error ? candidate.rawMessage : undefined,
      {
        initialMetadata: candidate.headers ?? candidate.initialMetadata,
        trailingMetadata: candidate.trailers ?? candidate.trailer ?? candidate.metadata,
      },
    );
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function convertSpatialReference(sr: { wkid: number; latestWkid: number; wkt: string }): HonuaSpatialReference {
  const result: HonuaSpatialReference = {};
  if (sr.wkid !== 0) {
    result.wkid = sr.wkid;
  }
  if (sr.latestWkid !== 0) {
    result.latestWkid = sr.latestWkid;
  }
  if (sr.wkt) {
    result.wkt = sr.wkt;
  }
  return result;
}

function convertField(field: ProtoFieldDefinition): HonuaFieldInfo {
  return {
    name: field.name,
    type: FIELD_TYPE_MAP[field.fieldType] ?? "esriFieldTypeString",
    alias: field.alias || field.name,
    length: field.length || undefined,
    nullable: field.nullable,
  };
}

/**
 * geospatial.v1 carries the object ID in `Feature.id` and the server no
 * longer repeats it in `Feature.attributes` (honua-server#5330), so it is
 * restored under the declared `objectIdFieldName` to match `f=json` output.
 * An `id` of 0 means no object ID (for example distinct projections), and an
 * attribute already present under that name in any casing (a legacy server
 * repeating it, or a differing custom public ID) is kept as sent.
 */
function convertFeature(feature: ProtoFeature, objectIdFieldName: string): HonuaFeature {
  const attributes: Record<string, unknown> = {};
  for (const [key, attrValue] of Object.entries(feature.attributes)) {
    attributes[key] = convertAttributeValue(attrValue);
  }

  if (objectIdFieldName.length > 0 && feature.id !== 0n && !hasAttributeIgnoreCase(attributes, objectIdFieldName)) {
    attributes[objectIdFieldName] = toSafeNumberOrString(feature.id);
  }

  const result: HonuaFeature = { attributes };

  if (feature.geometry) {
    result.geometry = convertGeometry(feature.geometry);
  }

  return result;
}

function hasAttributeIgnoreCase(attributes: Record<string, unknown>, name: string): boolean {
  const lowered = name.toLowerCase();
  return Object.keys(attributes).some((key) => key.toLowerCase() === lowered);
}

function convertAttributeValue(attr: AttributeValue): unknown {
  switch (attr.value.case) {
    case "stringValue":
      return attr.value.value;
    case "int32Value":
      return attr.value.value;
    case "int64Value":
      return toSafeNumberOrString(attr.value.value);
    case "doubleValue":
      return attr.value.value;
    case "floatValue":
      return attr.value.value;
    case "boolValue":
      return attr.value.value;
    case "datetimeValue":
      return toSafeNumberOrString(attr.value.value);
    case "bytesValue":
      return attr.value.value;
    case "nullValue":
      return null;
    default:
      return null;
  }
}

/** Keep absent ordinates in their geometry-wide positions for lossless edit roundtrips. */
function coordToArray(
  coordinate: { x: number; y: number; z?: number; m?: number },
  dimensions: Record<string, boolean>,
): (number | null)[] {
  const coords: (number | null)[] = [coordinate.x, coordinate.y];
  if (dimensions.hasZ) coords.push(coordinate.z ?? null);
  if (dimensions.hasM) coords.push(coordinate.m ?? null);
  return coords;
}

function coordinateDimensionFlags(coordinates: { z?: number; m?: number }[]): Record<string, boolean> {
  const hasZ = coordinates.some((coordinate) => coordinate.z !== undefined);
  const hasM = coordinates.some((coordinate) => coordinate.m !== undefined);
  return hasZ || hasM ? { hasZ, hasM } : {};
}

function convertGeometry(geometry: NonNullable<ProtoFeature["geometry"]>): Record<string, unknown> | null {
  switch (geometry.shape.case) {
    case "point": {
      const p = geometry.shape.value;
      const result: Record<string, unknown> = { x: p.x, y: p.y };
      if (p.z !== undefined) result.z = p.z;
      if (p.m !== undefined) result.m = p.m;
      return result;
    }
    case "multiPoint": {
      const mp = geometry.shape.value;
      const dimensions = coordinateDimensionFlags(mp.points);
      return {
        points: mp.points.map((p) => coordToArray(p, dimensions)),
        ...dimensions,
      };
    }
    case "polyline": {
      const pl = geometry.shape.value;
      const dimensions = coordinateDimensionFlags(pl.paths.flatMap((path) => path.coords));
      return {
        paths: pl.paths.map((path) => path.coords.map((c) => coordToArray(c, dimensions))),
        ...dimensions,
      };
    }
    case "polygon": {
      const pg = geometry.shape.value;
      const dimensions = coordinateDimensionFlags(pg.rings.flatMap((ring) => ring.coords));
      return {
        rings: pg.rings.map((ring) => ring.coords.map((c) => coordToArray(c, dimensions))),
        ...dimensions,
      };
    }
    case "multiPolygon": {
      return convertMultiPolygon(geometry.shape.value);
    }
    default:
      return null;
  }
}

function convertMultiPolygon(mpg: {
  polygons: { rings: { coords: { x: number; y: number; z?: number; m?: number }[] }[] }[];
}) {
  const dimensions = coordinateDimensionFlags(
    mpg.polygons.flatMap((polygon) => polygon.rings.flatMap((ring) => ring.coords)),
  );
  const rings: (number | null)[][][] = [];
  for (const poly of mpg.polygons) {
    for (const ring of poly.rings) {
      rings.push(ring.coords.map((c) => coordToArray(c, dimensions)));
    }
  }
  return {
    rings,
    ...dimensions,
  };
}
