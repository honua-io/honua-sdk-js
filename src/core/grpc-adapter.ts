import { toProtoGeometry, toProtoSpatialReference } from "./grpc-geometry-input.js";
import { toSafeNumberOrString } from "./grpc-int64.js";
export {
  fromProtoApplyEditsResponse,
  fromProtoApplyServiceEditsResponse,
  toProtoApplyEditsRequest,
  toProtoApplyServiceEditsRequest,
} from "./grpc-edits.js";
export { fromProtoRelatedPages, toProtoRelatedRequest } from "./grpc-related.js";
import { create } from "@bufbuild/protobuf";
import {
  DistanceUnit,
  type FeaturePage,
  GeometryType,
  type QueryFeaturesRequest as ProtoQueryFeaturesRequest,
  QueryFeaturesRequestSchema,
  type QueryFeaturesResponse,
  SpatialFilterSchema,
  SpatialRelationship,
} from "../gen/geospatial/v1/index.js";
import { HonuaCapabilityNotSupportedError, HonuaGrpcError } from "./errors.js";
import { geometryInputSpatialReference } from "./geometry-input-sr.js";
import { toWireGlobalId } from "./grpc-edits.js";
import {
  GEOMETRY_TYPE_MAP,
  convertFeature,
  convertField,
  convertSpatialReference,
  splitOutFields,
  toProtoObjectIds,
} from "./grpc-feature-conversion.js";
import type {
  HonuaCountResponse,
  HonuaExtentResponse,
  HonuaFeature,
  HonuaObjectIdsResponse,
  HonuaQueryResponse,
  QueryFeaturesRequest,
} from "./types.js";

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

/** Validate and normalise UUID selectors; an empty list would silently mean "no selector". */
function toProtoGlobalIds(request: QueryFeaturesRequest): string[] {
  if (request.objectIds !== undefined) {
    throw new Error("objectIds and globalIds cannot be combined in one gRPC query");
  }
  if (!request.globalIds?.length) {
    throw new Error("globalIds must name at least one global ID; omit it to query without a selector");
  }
  return request.globalIds.map((id) => toWireGlobalId(id.trim()));
}

/**
 * Converts a SDK QueryFeaturesRequest into a proto QueryFeaturesRequest message.
 */
export function toProtoQueryRequest(request: QueryFeaturesRequest) {
  if (request.extraParams?.time !== undefined) {
    throw new HonuaCapabilityNotSupportedError("temporalFilter", "grpc", `${request.serviceId}/${request.layerId}`);
  }
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
    msg.outFields = splitOutFields(request.outFields);
  }

  if (request.objectIds !== undefined) {
    msg.objectIds = toProtoObjectIds(request.objectIds);
  }

  if (request.globalIds !== undefined) {
    msg.globalIds = toProtoGlobalIds(request);
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
  sent?: Pick<ProtoQueryFeaturesRequest, "globalIds" | "serviceId" | "layerId">,
): HonuaQueryResponse | HonuaCountResponse | HonuaObjectIdsResponse | HonuaExtentResponse {
  // Count, id and extent responses carry the field name too. An empty name means
  // the server did not honour global_ids, including a pre-1.2 server.
  ensureGlobalIdSelectorHonored(sent, response.globalIdFieldName);
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
  const identity = { objectIdFieldName: response.objectIdFieldName, globalIdFieldName: response.globalIdFieldName };
  return {
    objectIdFieldName: response.objectIdFieldName,
    ...(response.globalIdFieldName ? { globalIdFieldName: response.globalIdFieldName } : {}),
    geometryType: GEOMETRY_TYPE_MAP[response.geometryType] ?? "esriGeometryPoint",
    spatialReference: response.spatialReference ? convertSpatialReference(response.spatialReference) : undefined,
    fields: response.fields.map(convertField),
    features: response.features.map((feature) => convertFeature(feature, identity)),
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
  sent?: Pick<ProtoQueryFeaturesRequest, "globalIds" | "serviceId" | "layerId">,
): AsyncGenerator<HonuaFeature[], void, undefined> {
  let first = true;
  // Metadata is populated on the first page only; later pages reuse it.
  let identity = { objectIdFieldName: "", globalIdFieldName: "" };
  try {
    for await (const page of stream) {
      ensureGlobalIdSelectorHonored(first ? sent : undefined, page.globalIdFieldName);
      first = false;
      identity = pageIdentity(identity, page);
      if (page.features.length === 0 && page.isLastPage) {
        break;
      }
      const features = page.features.map((feature) => convertFeature(feature, identity));
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
 * A server older than geospatial-grpc 1.2 ignores `global_ids` and answers with an unfiltered
 * page. A 1.2 server always names the layer's global-ID field when it honours the selector, so
 * a response without one is refused rather than returned as the selected rows.
 */
function ensureGlobalIdSelectorHonored(
  sent: Pick<ProtoQueryFeaturesRequest, "globalIds" | "serviceId" | "layerId"> | undefined,
  globalIdFieldName: string,
): void {
  if (sent && sent.globalIds.length > 0 && globalIdFieldName.length === 0) {
    throw new HonuaCapabilityNotSupportedError("globalIds", "grpc", `${sent.serviceId}/${sent.layerId}`);
  }
}

/** Metadata arrives on the first page; later pages keep the identity fields already seen. */
function pageIdentity(
  identity: { objectIdFieldName: string; globalIdFieldName: string },
  page: FeaturePage,
): { objectIdFieldName: string; globalIdFieldName: string } {
  return {
    objectIdFieldName: page.objectIdFieldName || identity.objectIdFieldName,
    globalIdFieldName: page.globalIdFieldName || identity.globalIdFieldName,
  };
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
