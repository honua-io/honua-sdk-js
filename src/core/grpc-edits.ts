import { create } from "@bufbuild/protobuf";
import {
  ApplyEditsRequestSchema,
  type ApplyEditsResponse,
  type AttributeValue,
  AttributeValueSchema,
  type EditResult,
  FeatureSchema,
  type Feature as ProtoFeature,
} from "../gen/geospatial/v1/index.js";
import { HonuaCapabilityNotSupportedError, HonuaGrpcError } from "./errors.js";
import { toProtoGeometry } from "./grpc-geometry-input.js";
import { toProtoObjectId, toSafeNumberOrString } from "./grpc-int64.js";
import type { ApplyEditsRequest, HonuaApplyEditsResponse, HonuaEditResult, HonuaFeature } from "./types.js";

/** Encode native edits without metadata requests or a REST fallback. */
export function toProtoApplyEditsRequest(request: ApplyEditsRequest) {
  const feature = (input: HonuaFeature): ProtoFeature => {
    if (input.geometry?.spatialReference != null) {
      throw new Error(
        "gRPC edit geometry must use layer coordinates without spatialReference; reprojection is unavailable.",
      );
    }
    const attributes = Object.fromEntries(
      Object.entries(input.attributes).map(([key, value]) => [key, toEditAttribute(value)]),
    );
    return create(FeatureSchema, {
      attributes,
      ...(input.geometry == null ? {} : { geometry: toProtoGeometry({ ...input.geometry }).geometry }),
    });
  };
  const deletes = typeof request.deletes === "string" ? request.deletes.split(",") : (request.deletes ?? []);
  return create(ApplyEditsRequestSchema, {
    serviceId: request.serviceId,
    layerId: request.layerId,
    adds: (request.adds ?? []).map(feature),
    updates: (request.updates ?? []).map((input) => {
      if (input.geometry === null) {
        throw new HonuaCapabilityNotSupportedError("clearGeometry", "grpc", `${request.serviceId}/${request.layerId}`);
      }
      const encoded = feature(input);
      const idField =
        (request.objectIdField && request.objectIdField in input.attributes ? request.objectIdField : undefined) ??
        Object.keys(input.attributes).find((key) => key.toLowerCase() === "objectid") ??
        Object.keys(input.attributes).find((key) => key.toLowerCase() === "id");
      const id = idField === undefined ? undefined : input.attributes[idField];
      encoded.id = id === undefined || id === null ? 0n : editObjectId(id);
      return encoded;
    }),
    deletes: deletes.map(editObjectId),
    rollbackOnFailure: request.rollbackOnFailure ?? true,
    idempotencyKey: request.idempotencyKey ?? "",
  });
}

function editObjectId(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return toProtoObjectId(String(value));
  if (typeof value === "string" || typeof value === "bigint") return toProtoObjectId(String(value));
  throw new Error("gRPC edit object IDs must be safe integers or int64 decimal strings.");
}

function toEditAttribute(value: unknown): AttributeValue {
  const attribute = create(AttributeValueSchema);
  if (value === null) attribute.value = { case: "nullValue", value: 0 };
  else if (typeof value === "string") attribute.value = { case: "stringValue", value };
  else if (typeof value === "boolean") attribute.value = { case: "boolValue", value };
  else if (typeof value === "bigint") attribute.value = { case: "int64Value", value: toProtoObjectId(String(value)) };
  else if (value instanceof Uint8Array) attribute.value = { case: "bytesValue", value };
  else if (value instanceof Date && Number.isFinite(value.getTime())) {
    attribute.value = { case: "datetimeValue", value: BigInt(value.getTime()) };
  } else if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("Unsafe integer edit attribute; use bigint for exact int64 values.");
    }
    attribute.value = Number.isInteger(value)
      ? { case: "int64Value", value: BigInt(value) }
      : { case: "doubleValue", value };
  } else {
    throw new Error("Unsupported gRPC edit attribute; use a scalar, Date, Uint8Array or null.");
  }
  return attribute;
}

export function fromProtoApplyEditsResponse(response: ApplyEditsResponse): HonuaApplyEditsResponse {
  const result = (entry: EditResult): HonuaEditResult => ({
    objectId: toSafeNumberOrString(entry.objectId),
    success: entry.success,
    ...(entry.error ? { error: { code: entry.error.code, description: entry.error.message } } : {}),
  });
  const outcomes = {
    addResults: response.addResults.map(result),
    updateResults: response.updateResults.map(result),
    deleteResults: response.deleteResults.map(result),
  };
  if (response.error) {
    throw new HonuaGrpcError(2, response.error.message, { ...response.error, ...outcomes });
  }
  return outcomes;
}
