import { create } from "@bufbuild/protobuf";
import {
  type AttributeValue,
  CoordinateSchema,
  CoordinateSequenceSchema,
  DistanceUnit,
  type FeaturePage,
  FieldType,
  GeometrySchema,
  GeometryType,
  MultiPointGeometrySchema,
  PointGeometrySchema,
  PolygonGeometrySchema,
  PolylineGeometrySchema,
  type Feature as ProtoFeature,
  type FieldDefinition as ProtoFieldDefinition,
  QueryFeaturesRequestSchema,
  type QueryFeaturesResponse,
  SpatialFilterSchema,
  SpatialReferenceSchema,
  SpatialRelationship,
  StatisticDefinitionSchema,
  StatisticType,
} from "../gen/geospatial/v1/index.js";
import { HonuaGrpcError } from "./errors.js";
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

const ESRI_TO_PROTO_SPATIAL_REL_MAP: Record<string, SpatialRelationship> = {
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

const ESRI_TO_PROTO_DISTANCE_UNIT_MAP: Record<string, DistanceUnit> = {
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

const STATISTIC_TYPE_MAP: Record<string, StatisticType> = {
  count: StatisticType.COUNT,
  sum: StatisticType.SUM,
  min: StatisticType.MIN,
  max: StatisticType.MAX,
  avg: StatisticType.AVG,
  stddev: StatisticType.STDDEV,
  var: StatisticType.VAR,
};

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MIN_PROTO_INT64 = -(1n << 63n);
const MAX_PROTO_INT64 = (1n << 63n) - 1n;

function toProtoObjectId(value: string): bigint {
  const token = value.trim();
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(token)) {
    throw new RangeError("string objectIds must contain canonical decimal int64 values");
  }
  const parsed = BigInt(token);
  if (parsed < MIN_PROTO_INT64 || parsed > MAX_PROTO_INT64) {
    throw new RangeError("string objectIds must remain within the signed int64 range");
  }
  return parsed;
}

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
  if (request.groupByFieldsForStatistics !== undefined) {
    msg.groupBy = request.groupByFieldsForStatistics
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  if (request.outStatistics !== undefined) {
    msg.outStatistics = toProtoStatistics(request.outStatistics);
  }

  if (request.geometry !== undefined) {
    const filter = create(SpatialFilterSchema);
    const { geometry, spatialReference } = toProtoGeometry(request.geometry);
    filter.geometry = geometry;

    if (request.spatialRel) {
      const mapped = ESRI_TO_PROTO_SPATIAL_REL_MAP[request.spatialRel];
      if (!mapped) {
        throw new Error(`Unsupported spatial relationship for gRPC transport: ${request.spatialRel}`);
      }
      filter.spatialRelationship = mapped;
    } else {
      filter.spatialRelationship = SpatialRelationship.INTERSECTS;
    }

    if (spatialReference) {
      filter.spatialReference = spatialReference;
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
      const mappedUnit = ESRI_TO_PROTO_DISTANCE_UNIT_MAP[unit.trim().toLowerCase()];
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
    features: response.features.map(convertFeature),
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

function toProtoStatistics(
  value: string | readonly Record<string, unknown>[],
): ReturnType<typeof create<typeof StatisticDefinitionSchema>>[] {
  const raw: readonly Record<string, unknown>[] = typeof value === "string" ? parseStatisticsString(value) : value;

  return raw.map((item, index) => {
    const statisticTypeValue = item.statisticType;
    if (typeof statisticTypeValue !== "string") {
      throw new Error(`Invalid outStatistics[${index}].statisticType`);
    }

    const statisticType = STATISTIC_TYPE_MAP[statisticTypeValue.toLowerCase()];
    if (!statisticType) {
      throw new Error(`Unsupported statisticType for gRPC transport: ${statisticTypeValue}`);
    }

    const onStatisticFieldValue = item.onStatisticField;
    if (typeof onStatisticFieldValue !== "string" || onStatisticFieldValue.trim().length === 0) {
      throw new Error(`Invalid outStatistics[${index}].onStatisticField`);
    }

    const outStatisticFieldNameValue = item.outStatisticFieldName;
    const outStatisticFieldName =
      typeof outStatisticFieldNameValue === "string" && outStatisticFieldNameValue.trim().length > 0
        ? outStatisticFieldNameValue.trim()
        : `${statisticTypeValue}_${onStatisticFieldValue}`;

    const definition = create(StatisticDefinitionSchema);
    definition.onStatisticField = onStatisticFieldValue;
    definition.statisticType = statisticType;
    definition.outStatisticFieldName = outStatisticFieldName;
    return definition;
  });
}

function parseStatisticsString(value: string): readonly Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid outStatistics JSON for gRPC transport.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("outStatistics JSON must be an array for gRPC transport.");
  }
  return parsed as readonly Record<string, unknown>[];
}

function toProtoGeometry(geometryValue: string | Record<string, unknown>): {
  geometry: ReturnType<typeof create<typeof GeometrySchema>>;
  spatialReference?: ReturnType<typeof create<typeof SpatialReferenceSchema>>;
} {
  const source = parseGeometryValue(geometryValue);
  const geometry = create(GeometrySchema);

  if (isPoint(source)) {
    const point = create(PointGeometrySchema);
    point.x = source.x;
    point.y = source.y;
    if (typeof source.z === "number" && Number.isFinite(source.z)) {
      point.z = source.z;
    }
    if (typeof source.m === "number" && Number.isFinite(source.m)) {
      point.m = source.m;
    }
    geometry.shape = { case: "point", value: point };
  } else if (isEnvelope(source)) {
    const polygon = create(PolygonGeometrySchema);
    polygon.rings = [
      toCoordinateSequence([
        [source.xmin, source.ymin],
        [source.xmax, source.ymin],
        [source.xmax, source.ymax],
        [source.xmin, source.ymax],
        [source.xmin, source.ymin],
      ]),
    ];
    geometry.shape = { case: "polygon", value: polygon };
  } else if (isMultipoint(source)) {
    const multipoint = create(MultiPointGeometrySchema);
    multipoint.points = source.points.map((point, index) => toPointGeometryFromArray(point, `points[${index}]`));
    geometry.shape = { case: "multiPoint", value: multipoint };
  } else if (isPolyline(source)) {
    const polyline = create(PolylineGeometrySchema);
    polyline.paths = source.paths.map((path, index) => toCoordinateSequence(path, `paths[${index}]`));
    geometry.shape = { case: "polyline", value: polyline };
  } else if (isPolygon(source)) {
    const polygon = create(PolygonGeometrySchema);
    polygon.rings = source.rings.map((ring, index) => toCoordinateSequence(ring, `rings[${index}]`));
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

function toProtoSpatialReference(value: unknown): ReturnType<typeof create<typeof SpatialReferenceSchema>> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const spatialReference = create(SpatialReferenceSchema);
    spatialReference.wkid = value;
    return spatialReference;
  }

  if (typeof value === "string") {
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

function toPointGeometryFromArray(
  value: unknown,
  context: string,
): ReturnType<typeof create<typeof PointGeometrySchema>> {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`Invalid coordinate array at ${context}`);
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid coordinate values at ${context}`);
  }

  const point = create(PointGeometrySchema);
  point.x = x;
  point.y = y;
  const z = value[2];
  if (typeof z === "number" && Number.isFinite(z)) {
    point.z = z;
  }
  const m = value[3];
  if (typeof m === "number" && Number.isFinite(m)) {
    point.m = m;
  }
  return point;
}

function toCoordinateSequence(
  value: unknown,
  context = "coords",
): ReturnType<typeof create<typeof CoordinateSequenceSchema>> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid coordinate sequence at ${context}`);
  }
  const sequence = create(CoordinateSequenceSchema);
  sequence.coords = value.map((coord, index) => toCoordinate(coord, `${context}[${index}]`));
  return sequence;
}

function toCoordinate(value: unknown, context: string): ReturnType<typeof create<typeof CoordinateSchema>> {
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
  const z = value[2];
  if (typeof z === "number" && Number.isFinite(z)) {
    coordinate.z = z;
  }
  const m = value[3];
  if (typeof m === "number" && Number.isFinite(m)) {
    coordinate.m = m;
  }
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

/**
 * Converts a stream of proto FeaturePages into an async generator
 * that yields arrays of JSON-compatible features, matching the
 * existing queryFeaturesStream yield type.
 */
export async function* streamProtoPages(
  stream: AsyncIterable<FeaturePage>,
): AsyncGenerator<HonuaFeature[], void, undefined> {
  try {
    for await (const page of stream) {
      if (page.features.length === 0 && page.isLastPage) {
        break;
      }
      const features = page.features.map(convertFeature);
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

function convertFeature(feature: ProtoFeature): HonuaFeature {
  const attributes: Record<string, unknown> = {};
  for (const [key, attrValue] of Object.entries(feature.attributes)) {
    attributes[key] = convertAttributeValue(attrValue);
  }

  const result: HonuaFeature = { attributes };

  if (feature.geometry) {
    result.geometry = convertGeometry(feature.geometry);
  }

  return result;
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

function toSafeNumberOrString(value: bigint): number | string {
  if (value <= MAX_SAFE_INTEGER_BIGINT && value >= MIN_SAFE_INTEGER_BIGINT) {
    return Number(value);
  }
  return value.toString();
}

/**
 * Builds an Esri-JSON coordinate array from a proto coordinate. Z and M are
 * appended only when present, matching `f=json` / PBF output:
 *   - `[x, y]`        (2D)
 *   - `[x, y, z]`     (Z only)
 *   - `[x, y, m]`     (M only — Esri's M-without-Z convention)
 *   - `[x, y, z, m]`  (Z and M)
 *
 * A `NaN` placeholder is never emitted: `JSON.stringify` would serialize it to
 * `null`, which is invalid Esri-JSON/GeoJSON and diverges from the other
 * transports.
 */
function coordToArray(x: number, y: number, z: number | undefined, m: number | undefined): number[] {
  const coords: number[] = [x, y];
  if (z !== undefined) coords.push(z);
  if (m !== undefined) coords.push(m);
  return coords;
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
      return {
        points: mp.points.map((p) => coordToArray(p.x, p.y, p.z, p.m)),
      };
    }
    case "polyline": {
      const pl = geometry.shape.value;
      return {
        paths: pl.paths.map((path) => path.coords.map((c) => coordToArray(c.x, c.y, c.z, c.m))),
      };
    }
    case "polygon": {
      const pg = geometry.shape.value;
      return {
        rings: pg.rings.map((ring) => ring.coords.map((c) => coordToArray(c.x, c.y, c.z, c.m))),
      };
    }
    case "multiPolygon": {
      const mpg = geometry.shape.value;
      const rings: number[][][] = [];
      for (const poly of mpg.polygons) {
        for (const ring of poly.rings) {
          rings.push(ring.coords.map((c) => coordToArray(c.x, c.y, c.z, c.m)));
        }
      }
      return { rings };
    }
    default:
      return null;
  }
}
