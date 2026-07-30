import type {
  GeoArrowBatchSerializationResult,
  GeoArrowSerializationMetrics,
  GeoArrowSerializationOptions,
} from "./geoarrow-types.js";
import { HonuaGeoArrowError as GeoArrowError } from "./geoarrow-types.js";
import { inspectGeoArrowBatch } from "./geoarrow.js";
import type { ColumnarBatchV1, ColumnarBufferRole } from "./types.js";

const SERIALIZATION_KIND = "honua.geoarrow.batch" as const;
const SERIALIZATION_VERSION = "1.0" as const;
const DEFAULT_MAX_SERIALIZED_BYTES = 128 * 1024 * 1024;
const BASE64_CHUNK = 0x8000;

interface SerializedBuffer {
  readonly id: string;
  readonly role: ColumnarBufferRole;
  readonly field?: string;
  readonly backingId: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

interface SerializedBacking {
  readonly id: string;
  data: string;
}

interface SerializedEnvelope {
  readonly kind: typeof SERIALIZATION_KIND;
  readonly version: typeof SERIALIZATION_VERSION;
  readonly batch: Omit<ColumnarBatchV1, "buffers"> & { readonly buffers: readonly SerializedBuffer[] };
  readonly backings: readonly SerializedBacking[];
}

function fail(
  message: string,
  code: "invalid-batch" | "serialization-limit-exceeded" | "unsupported-serialization",
): never {
  throw new GeoArrowError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + BASE64_CHUNK, bytes.length)));
  }
  return btoa(binary);
}

function fromBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail(`${label} must be valid base64.`, "invalid-batch");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw new GeoArrowError("invalid-batch", `${label} must be valid base64.`, undefined, { cause });
  }
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function serializedLimit(options: GeoArrowSerializationOptions): number {
  const limit = options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    fail("maxSerializedBytes must be a positive safe integer.", "invalid-batch");
  return limit;
}

function encodeEnvelope(envelope: SerializedEnvelope, limit: number): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.byteLength > limit) {
    fail(`GeoArrow envelope is ${bytes.byteLength} bytes; the limit is ${limit}.`, "serialization-limit-exceeded");
  }
  return bytes;
}

function readEnvelope(
  input: Uint8Array | ArrayBuffer,
  limit: number,
): { envelope: SerializedEnvelope; byteLength: number } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > limit) {
    fail(`GeoArrow envelope is ${bytes.byteLength} bytes; the limit is ${limit}.`, "serialization-limit-exceeded");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new GeoArrowError("invalid-batch", "GeoArrow envelope must be valid UTF-8 JSON.", undefined, { cause });
  }
  if (!isRecord(value) || value.kind !== SERIALIZATION_KIND) {
    fail(
      `Unsupported GeoArrow serialization kind "${String(isRecord(value) ? value.kind : undefined)}".`,
      "unsupported-serialization",
    );
  }
  if (value.version !== SERIALIZATION_VERSION) {
    fail(`Unsupported GeoArrow serialization version "${String(value.version)}".`, "unsupported-serialization");
  }
  if (!isRecord(value.batch) || !Array.isArray(value.batch.buffers) || !Array.isArray(value.backings)) {
    fail("GeoArrow envelope is missing its batch or backing buffers.", "invalid-batch");
  }
  return { envelope: value as unknown as SerializedEnvelope, byteLength: bytes.byteLength };
}

function metrics(serializedBytes: number, batch: ColumnarBatchV1): GeoArrowSerializationMetrics {
  const seen = new Set<ArrayBuffer>();
  for (const buffer of batch.buffers) seen.add(buffer.data);
  return Object.freeze({
    serializedBytes,
    backingBytes: [...seen].reduce((total, data) => total + data.byteLength, 0),
    backingBuffers: seen.size,
  });
}

/** Serialize one validated GeoArrow batch into a bounded, versioned persistence envelope. */
export function serializeGeoArrowBatch(batch: ColumnarBatchV1, options: GeoArrowSerializationOptions = {}): Uint8Array {
  const limit = serializedLimit(options);
  const inspection = inspectGeoArrowBatch(batch, options);
  const backings: SerializedBacking[] = [];
  const backingViews: Uint8Array[] = [];
  const backingIds = new Map<ArrayBuffer, string>();
  const buffers: SerializedBuffer[] = [];
  for (const descriptor of inspection.batch.buffers) {
    let backingId = backingIds.get(descriptor.data);
    if (!backingId) {
      backingId = `backing-${backings.length}`;
      backingIds.set(descriptor.data, backingId);
      backings.push({ id: backingId, data: "" });
      backingViews.push(new Uint8Array(descriptor.data));
    }
    buffers.push({
      id: descriptor.id,
      role: descriptor.role,
      ...(descriptor.field === undefined ? {} : { field: descriptor.field }),
      backingId,
      byteOffset: descriptor.byteOffset,
      byteLength: descriptor.byteLength,
    });
  }
  const envelope: SerializedEnvelope = {
    kind: SERIALIZATION_KIND,
    version: SERIALIZATION_VERSION,
    batch: { ...inspection.batch, buffers },
    backings,
  };
  const base64Bytes = backingViews.reduce((total, bytes) => total + 4 * Math.ceil(bytes.byteLength / 3), 0);
  const envelopeOverhead = new TextEncoder().encode(
    JSON.stringify({ ...envelope, backings: backings.map(({ id }) => ({ id, data: "" })) }),
  ).byteLength;
  if (envelopeOverhead + base64Bytes > limit) {
    fail(
      `GeoArrow envelope requires at least ${envelopeOverhead + base64Bytes} bytes; the limit is ${limit}.`,
      "serialization-limit-exceeded",
    );
  }
  backings.forEach((backing, index) => {
    backing.data = toBase64(backingViews[index]!);
  });
  return encodeEnvelope(envelope, limit);
}

/** Deserialize and revalidate a persisted GeoArrow envelope with explicit size ceilings. */
export function deserializeGeoArrowBatch(
  input: Uint8Array | ArrayBuffer,
  options: GeoArrowSerializationOptions = {},
): GeoArrowBatchSerializationResult {
  const limit = serializedLimit(options);
  const { envelope, byteLength } = readEnvelope(input, limit);
  const backingMap = new Map<string, ArrayBuffer>();
  let backingBytes = 0;
  for (const backing of envelope.backings) {
    if (!isRecord(backing) || typeof backing.id !== "string" || backingMap.has(backing.id)) {
      fail("GeoArrow envelope contains an invalid or duplicate backing id.", "invalid-batch");
    }
    const bytes = fromBase64(backing.data, `backing ${backing.id}`);
    backingBytes += bytes.byteLength;
    if (options.maxBackingBytes !== undefined && backingBytes > options.maxBackingBytes) {
      fail(`GeoArrow backings exceed the ${options.maxBackingBytes}-byte limit.`, "serialization-limit-exceeded");
    }
    backingMap.set(backing.id, bytes.buffer as ArrayBuffer);
  }
  const serializedBatch = envelope.batch;
  const buffers = serializedBatch.buffers.map((descriptor) => {
    if (!isRecord(descriptor) || typeof descriptor.id !== "string" || typeof descriptor.backingId !== "string") {
      fail("GeoArrow envelope contains an invalid buffer descriptor.", "invalid-batch");
    }
    const data = backingMap.get(descriptor.backingId);
    if (!data) fail(`GeoArrow buffer references unknown backing "${descriptor.backingId}".`, "invalid-batch");
    return {
      id: descriptor.id,
      role: descriptor.role,
      ...(descriptor.field === undefined ? {} : { field: descriptor.field }),
      data,
      byteOffset: descriptor.byteOffset,
      byteLength: descriptor.byteLength,
    };
  });
  const batch = { ...serializedBatch, buffers } as ColumnarBatchV1;
  inspectGeoArrowBatch(batch, options);
  return Object.freeze({
    batch,
    metrics: metrics(byteLength, batch),
  });
}

export type { GeoArrowBatchSerializationResult, GeoArrowSerializationMetrics } from "./geoarrow-types.js";
