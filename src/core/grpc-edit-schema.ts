import type { FieldType as ProtoFieldType } from "../gen/geospatial/v1/common_pb.js";
import type { LayerDescriptor } from "../gen/geospatial/v1/metadata_types_pb.js";
import type { HonuaClient } from "./client.js";
import { HonuaAbortError, HonuaGrpcError } from "./errors.js";
import type { GrpcPreciseAttributeType } from "./types.js";

/** Edit-encoding hints read from a native layer descriptor. */
export interface GrpcEditSchema {
  readonly attributeTypes: Readonly<Record<string, GrpcPreciseAttributeType>>;
  readonly globalIdField?: string;
}

// Frozen wire enum values, checked against the generated enum, so this module
// needs no protobuf runtime.
const FieldType = { TIMESTAMP_OFFSET: 14, DECIMAL: 15 } as const satisfies Pick<
  typeof ProtoFieldType,
  "TIMESTAMP_OFFSET" | "DECIMAL"
>;

// Only field types a 1.2 descriptor alone can declare. DATE and TIME also exist in 1.1
// descriptors, whose servers would read the new oneof cases as no value at all, so those
// columns keep plain strings (servers accept ISO text there) unless the caller declares them.
const PRECISE_FIELD_TYPES: Readonly<Partial<Record<number, GrpcPreciseAttributeType>>> = {
  [FieldType.TIMESTAMP_OFFSET]: "timestamp-offset",
  [FieldType.DECIMAL]: "decimal",
};

/**
 * Derive which attributes need geospatial-grpc 1.2 precise values (offset
 * timestamps and exact decimals) and the global-ID field, so edits encode
 * strings by the layer's declared types instead of guessing.
 */
export function grpcEditSchema(layer: LayerDescriptor | undefined): GrpcEditSchema {
  const attributeTypes: Record<string, GrpcPreciseAttributeType> = {};
  for (const field of layer?.fields ?? []) {
    const definition = field.definition;
    const type = definition ? PRECISE_FIELD_TYPES[definition.fieldType] : undefined;
    if (definition?.name && type) attributeTypes[definition.name] = type;
  }
  return Object.freeze({
    attributeTypes: Object.freeze(attributeTypes),
    ...(layer?.globalIdField ? { globalIdField: layer.globalIdField } : {}),
  });
}

/** gRPC status UNIMPLEMENTED: the server predates DescribeLayer, which geospatial-grpc 1.1 added. */
const GRPC_UNIMPLEMENTED = 12;

/** A stalled DescribeLayer must not hold every later edit on the source. */
const DESCRIBE_TIMEOUT_MS = 30_000;

/**
 * Read the layer's precise field types and global-ID field once per source
 * from DescribeLayer, so gRPC edits encode by declared type. A failed read is
 * not cached; a server without DescribeLayer gets untyped encoding.
 */
export function memoizedGrpcEditSchema(
  client: Pick<HonuaClient, "describeLayer">,
  serviceId: string,
  layerId: number,
): (signal?: AbortSignal) => Promise<GrpcEditSchema> {
  let pending: Promise<GrpcEditSchema> | undefined;
  return (signal) => {
    pending ??= client.describeLayer({ serviceId, layerId, signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS) }).then(
      (response) => grpcEditSchema(response.layer),
      (error: unknown) => {
        if (error instanceof HonuaGrpcError && error.code === GRPC_UNIMPLEMENTED) return grpcEditSchema(undefined);
        pending = undefined;
        throw error;
      },
    );
    return abortable(pending, signal);
  };
}

/** Stop waiting on the shared read when this caller aborts; the read itself continues. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new HonuaAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new HonuaAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
