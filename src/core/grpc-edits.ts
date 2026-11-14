import { create } from "@bufbuild/protobuf";
import {
  type ApplyEditsRequest as ApplyEditsMessage,
  ApplyEditsRequestSchema,
  type ApplyEditsResponse,
  ApplyServiceEditsRequestSchema,
  type ApplyServiceEditsResponse,
  type AttributeValue,
  AttributeValueSchema,
  type EditResult,
  FeatureSchema,
  type Feature as ProtoFeature,
} from "../gen/geospatial/v1/index.js";
import { HonuaCapabilityNotSupportedError, HonuaGrpcError } from "./errors.js";
import { toProtoGeometry } from "./grpc-geometry-input.js";
import { toProtoObjectId, toSafeNumberOrString } from "./grpc-int64.js";
import type {
  ApplyEditsRequest,
  ApplyServiceEditsRequest,
  GrpcPreciseAttributeType,
  HonuaApplyEditsResponse,
  HonuaApplyServiceEditsResponse,
  HonuaEditResult,
  HonuaFeature,
} from "./types.js";

/** Encode native edits without metadata requests or a REST fallback. */
export function toProtoApplyEditsRequest(request: ApplyEditsRequest) {
  const useGlobalIds = request.useGlobalIds === true;
  const deletes = typeof request.deletes === "string" ? request.deletes.split(",") : [...(request.deletes ?? [])];
  return create(ApplyEditsRequestSchema, {
    serviceId: request.serviceId,
    layerId: request.layerId,
    adds: (request.adds ?? []).map((input) => encodeAdd(input, request)),
    updates: (request.updates ?? []).map((input) => encodeUpdate(input, request)),
    ...(useGlobalIds
      ? { useGlobalIds: true, deleteGlobalIds: deletes.map((id) => toWireGlobalId(String(id).trim())) }
      : { deletes: deletes.map(editObjectId) }),
    rollbackOnFailure: request.rollbackOnFailure ?? true,
    idempotencyKey: request.idempotencyKey ?? "",
  });
}

function encodeFeature(input: HonuaFeature, request: ApplyEditsRequest): ProtoFeature {
  if (input.geometry?.spatialReference != null) {
    throw new Error(
      "gRPC edit geometry must use layer coordinates without spatialReference; reprojection is unavailable.",
    );
  }
  const attributes = Object.fromEntries(
    Object.entries(input.attributes).map(([key, value]) => [
      key,
      toEditAttribute(value, preciseType(request.attributeTypes, key)),
    ]),
  );
  return create(FeatureSchema, {
    attributes,
    ...(input.geometry == null ? {} : { geometry: toProtoGeometry({ ...input.geometry }).geometry }),
  });
}

/**
 * Adds send an explicit `globalId` as `Feature.global_id`. In integer mode a global ID that is
 * only an attribute stays an attribute, which servers before geospatial-grpc 1.2 also store.
 */
function encodeAdd(input: HonuaFeature, request: ApplyEditsRequest): ProtoFeature {
  if (input.globalId === undefined && request.useGlobalIds !== true) return encodeFeature(input, request);
  const { feature, globalId } = liftGlobalId(input, request.globalIdField);
  const encoded = encodeFeature(feature, request);
  if (globalId !== undefined) encoded.globalId = globalId;
  return encoded;
}

function encodeUpdate(input: HonuaFeature, request: ApplyEditsRequest): ProtoFeature {
  if (input.geometry === null) {
    throw new HonuaCapabilityNotSupportedError("clearGeometry", "grpc", `${request.serviceId}/${request.layerId}`);
  }
  if (request.useGlobalIds === true) {
    const encoded = encodeAdd(input, request);
    if (!encoded.globalId) {
      throw new Error("gRPC global-ID updates need globalId or a global ID in the globalIdField attribute.");
    }
    return encoded;
  }
  // Integer mode never sends Feature.global_id: it is a selector only with useGlobalIds.
  const encoded = encodeFeature(input, request);
  const idField =
    (request.objectIdField && request.objectIdField in input.attributes ? request.objectIdField : undefined) ??
    Object.keys(input.attributes).find((key) => key.toLowerCase() === "objectid") ??
    Object.keys(input.attributes).find((key) => key.toLowerCase() === "id");
  const id = idField === undefined ? undefined : input.attributes[idField];
  encoded.id = id === undefined || id === null ? 0n : editObjectId(id);
  return encoded;
}

const UUID_PATTERN = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;

/** Normalise a global ID to the wire form: lowercase, hyphenated, no braces. */
export function toWireGlobalId(value: string): string {
  const match = UUID_PATTERN.exec(value);
  if (!match?.[1]) throw new Error(`gRPC global IDs must be UUIDs; received "${value}".`);
  return match[1].toLowerCase();
}

/** Take the global ID from `globalId` or the global-ID attribute, removing that attribute. */
function liftGlobalId(input: HonuaFeature, field: string | undefined): { feature: HonuaFeature; globalId?: string } {
  const key = field
    ? Object.keys(input.attributes).find((name) => name.toLowerCase() === field.toLowerCase())
    : undefined;
  const raw = input.globalId ?? (key === undefined ? undefined : input.attributes[key]);
  const attributes =
    key === undefined
      ? input.attributes
      : Object.fromEntries(Object.entries(input.attributes).filter(([name]) => name !== key));
  const feature = { ...input, attributes };
  if (raw === undefined || raw === null || raw === "") return { feature };
  if (typeof raw !== "string") throw new Error("gRPC global IDs must be UUID strings.");
  return { feature, globalId: toWireGlobalId(raw.trim()) };
}

function preciseType(types: ApplyEditsRequest["attributeTypes"], key: string): GrpcPreciseAttributeType | undefined {
  if (!types) return undefined;
  if (Object.hasOwn(types, key)) return types[key];
  const lowered = key.toLowerCase();
  const match = Object.keys(types).find((name) => name.toLowerCase() === lowered);
  return match === undefined ? undefined : types[match];
}

function editObjectId(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return toProtoObjectId(String(value));
  if (typeof value === "string" || typeof value === "bigint") return toProtoObjectId(String(value));
  throw new Error("gRPC edit object IDs must be safe integers or int64 decimal strings.");
}

const PRECISE_PATTERNS: Record<GrpcPreciseAttributeType, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/,
  "timestamp-offset": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/,
  decimal: /^-?(0|[1-9]\d*)(\.\d+)?$/,
};

const PRECISE_CASES = {
  date: "dateValue",
  time: "timeValue",
  "timestamp-offset": "timestampOffsetValue",
  decimal: "decimalValue",
} as const;

/** Encode a declared date, time, offset timestamp or decimal without losing precision. */
function toPreciseAttribute(value: unknown, type: GrpcPreciseAttributeType): AttributeValue["value"] | undefined {
  let text: string;
  if (typeof value === "string") text = value;
  else if (type === "decimal" && (typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value)))) {
    text = String(value);
  } else if (type === "timestamp-offset" && value instanceof Date && Number.isFinite(value.getTime())) {
    text = value.toISOString();
  } else {
    // Null and other non-string values keep their ordinary encoding.
    return undefined;
  }
  if (!PRECISE_PATTERNS[type].test(text)) {
    // A JS number String() writes in exponent form keeps its ordinary double encoding.
    if (typeof value === "number") return undefined;
    throw new Error(`Invalid gRPC ${type} edit attribute "${text}".`);
  }
  return { case: PRECISE_CASES[type], value: text };
}

function toEditAttribute(value: unknown, type?: GrpcPreciseAttributeType): AttributeValue {
  const attribute = create(AttributeValueSchema);
  const precise = type === undefined ? undefined : toPreciseAttribute(value, type);
  if (precise !== undefined) attribute.value = precise;
  else if (value === null) attribute.value = { case: "nullValue", value: 0 };
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

/** gRPC status FAILED_PRECONDITION. */
const FAILED_PRECONDITION = 9;

/**
 * Decode an ApplyEdits response. With `sent`, a global-ID batch whose delete results do not
 * match its `delete_global_ids` is refused: a server older than geospatial-grpc 1.2 ignores the
 * unknown selectors and would otherwise report an empty success.
 */
export function fromProtoApplyEditsResponse(
  response: ApplyEditsResponse,
  sent?: Pick<ApplyEditsMessage, "useGlobalIds" | "deleteGlobalIds" | "adds" | "updates">,
): HonuaApplyEditsResponse {
  if (sent && !response.error && globalIdsIgnored(sent, response)) {
    throw globalIdsIgnoredError(decodeOutcomes(response));
  }
  const outcomes = decodeOutcomes(response);
  if (response.error) {
    throw new HonuaGrpcError(2, response.error.message, { ...response.error, ...outcomes });
  }
  return outcomes;
}

/**
 * Servers before geospatial-grpc 1.2 drop the unknown global-ID fields: delete selectors yield
 * no results, and successful rows sent with `Feature.global_id` come back without one.
 */
function globalIdsIgnored(
  sent: Pick<ApplyEditsMessage, "useGlobalIds" | "deleteGlobalIds" | "adds" | "updates">,
  response: ApplyEditsResponse,
): boolean {
  const unechoed = (features: readonly ProtoFeature[], results: readonly EditResult[]) =>
    features.some((feature, index) => {
      const result = results[index];
      return feature.globalId.length > 0 && result?.success === true && result.globalId.length === 0;
    });
  return (
    (sent.useGlobalIds && response.deleteResults.length !== sent.deleteGlobalIds.length) ||
    unechoed(sent.adds, response.addResults) ||
    unechoed(sent.updates, response.updateResults)
  );
}

/** Older servers drop unknown global-ID fields; other rows in the batch may have committed. */
function globalIdsIgnoredError(details: unknown): HonuaGrpcError {
  return new HonuaGrpcError(
    FAILED_PRECONDITION,
    "The server ignored global IDs in this batch (it predates geospatial-grpc 1.2); " +
      "other edits in this batch may have been committed, see details.",
    details,
  );
}

function decodeOutcomes(response: ApplyEditsResponse) {
  const result = (entry: EditResult): HonuaEditResult => ({
    objectId: toSafeNumberOrString(entry.objectId),
    ...(entry.globalId ? { globalId: entry.globalId } : {}),
    success: entry.success,
    ...(entry.error ? { error: { code: entry.error.code, description: entry.error.message } } : {}),
  });
  return {
    addResults: response.addResults.map(result),
    updateResults: response.updateResults.map(result),
    deleteResults: response.deleteResults.map(result),
  };
}

/** Encode multi-layer edits with the same per-layer rules as `toProtoApplyEditsRequest`. */
export function toProtoApplyServiceEditsRequest(request: ApplyServiceEditsRequest) {
  const layers = new Set<number>();
  return create(ApplyServiceEditsRequestSchema, {
    serviceId: request.serviceId,
    edits: request.edits.map((layer) => {
      if (layers.has(layer.layerId)) throw new Error(`ApplyServiceEdits names layer ${layer.layerId} twice.`);
      layers.add(layer.layerId);
      const encoded = toProtoApplyEditsRequest({ ...layer, serviceId: request.serviceId });
      return {
        layerId: layer.layerId,
        adds: encoded.adds,
        updates: encoded.updates,
        deletes: encoded.deletes,
        useGlobalIds: encoded.useGlobalIds,
        deleteGlobalIds: encoded.deleteGlobalIds,
      };
    }),
    rollbackOnFailure: request.rollbackOnFailure ?? true,
    idempotencyKey: request.idempotencyKey ?? "",
  });
}

/**
 * Decode per-layer results. A layer's own error stays on that layer; a global error (the
 * transaction failed, and with rollback nothing committed) throws with every layer attached.
 */
export function fromProtoApplyServiceEditsResponse(
  response: ApplyServiceEditsResponse,
  sent: Pick<ReturnType<typeof toProtoApplyServiceEditsRequest>, "edits">,
): HonuaApplyServiceEditsResponse {
  const decoded = {
    layers: response.results.map((entry) => ({
      layerId: entry.layerId,
      ...(entry.results ? decodeOutcomes(entry.results) : { addResults: [], updateResults: [], deleteResults: [] }),
      ...(entry.results?.error
        ? { error: { code: entry.results.error.code, description: entry.results.error.message } }
        : {}),
    })),
  };
  if (response.error) {
    throw new HonuaGrpcError(2, response.error.message, { ...response.error, ...decoded });
  }
  const order = response.results.map((entry) => entry.layerId).join(",");
  if (order !== sent.edits.map((layer) => layer.layerId).join(",")) {
    // The contract returns every request layer in request order; anything else is a protocol violation.
    throw new HonuaGrpcError(13, `ApplyServiceEdits returned layers [${order}] for a request of different layers.`, {
      results: response.results.map((entry) => entry.layerId),
    });
  }
  const ignored = response.results.some((entry, index) => {
    const layer = sent.edits[index];
    return (
      layer !== undefined &&
      entry.results !== undefined &&
      !entry.results.error &&
      globalIdsIgnored(layer, entry.results)
    );
  });
  if (ignored) {
    throw globalIdsIgnoredError(decoded);
  }
  return decoded;
}
