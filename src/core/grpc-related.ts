import { create } from "@bufbuild/protobuf";
import { QueryRelatedRecordsRequestSchema, type QueryRelatedRecordsResponse } from "../gen/geospatial/v1/index.js";
import { HonuaCapabilityNotSupportedError } from "./errors.js";
import {
  GEOMETRY_TYPE_MAP,
  convertFeature,
  convertField,
  convertSpatialReference,
  splitOutFields,
  toProtoObjectIds,
} from "./grpc-feature-conversion.js";
import { toProtoSpatialReference } from "./grpc-geometry-input.js";
import { isJsSafeInteger } from "./grpc-int64.js";
import type { HonuaRelatedRecordGroup, HonuaRelatedRecordsResponse, QueryRelatedRecordsRequest } from "./types.js";

/** Encode one QueryRelatedRecords page request; `objectIds` name origin-layer features. */
export function toProtoRelatedRequest(request: QueryRelatedRecordsRequest, pageToken = "") {
  const { outSR, outSr, ...unsupported } = request.extraParams ?? {};
  const unknown = Object.keys(unsupported);
  if (unknown.length > 0) {
    // QueryRelatedRecords has no equivalent; never drop a constraint silently.
    throw new HonuaCapabilityNotSupportedError(
      `queryRelated.${unknown[0]}`,
      "grpc",
      `${request.serviceId}/${request.layerId}`,
    );
  }
  const outSpatialReference = toProtoSpatialReference(outSR ?? outSr);
  const ids = request.objectIds === undefined ? [] : toProtoObjectIds(request.objectIds);
  for (const id of ids) {
    if (!isJsSafeInteger(id)) {
      throw new RangeError(`Related-record origin ID ${id} exceeds the JavaScript safe integer range.`);
    }
  }
  const outFields = request.outFields === undefined ? [] : splitOutFields(request.outFields);
  return create(QueryRelatedRecordsRequestSchema, {
    serviceId: request.serviceId,
    layerId: request.layerId,
    relationshipId: request.relationshipId,
    objectIds: ids,
    outFields,
    where: request.where ?? "",
    returnGeometry: request.returnGeometry ?? true,
    ...(outSpatialReference ? { outSr: outSpatialReference } : {}),
    pageToken,
  });
}

function safeOriginId(objectId: bigint): number {
  if (!isJsSafeInteger(objectId)) {
    throw new RangeError(`Related-record origin ID ${objectId} exceeds the JavaScript safe integer range.`);
  }
  return Number(objectId);
}

/**
 * Merge QueryRelatedRecords pages into the `queryRelatedRecords` shape, keeping origin order.
 * Pages repeat destination metadata, so the first page supplies it.
 */
export function fromProtoRelatedPages(pages: readonly QueryRelatedRecordsResponse[]): HonuaRelatedRecordsResponse {
  const first = pages[0];
  if (!first) return { relatedRecordGroups: [] };
  const identity = { objectIdFieldName: first.objectIdFieldName, globalIdFieldName: first.globalIdFieldName };
  const groups = new Map<string, HonuaRelatedRecordGroup>();
  for (const page of pages) {
    for (const group of page.groups) {
      const key = group.objectId.toString();
      const target = groups.get(key) ?? { objectId: safeOriginId(group.objectId), relatedRecords: [] };
      target.relatedRecords?.push(...group.features.map((feature) => convertFeature(feature, identity)));
      groups.set(key, target);
    }
  }
  return {
    relatedRecordGroups: [...groups.values()],
    fields: first.fields.map(convertField),
    geometryType: GEOMETRY_TYPE_MAP[first.geometryType] ?? "esriGeometryPoint",
    ...(first.spatialReference ? { spatialReference: convertSpatialReference(first.spatialReference) } : {}),
  };
}
