import { createColumnarBatch, inspectColumnarBatch } from "./transfer.js";
import type { ColumnarBatchLimits, ColumnarBatchV1 } from "./types.js";

/** Version discriminator for the persisted columnar batch wire format. */
export const COLUMNAR_SERIALIZATION_VERSION = "1.0" as const;
/** Stable discriminator for persisted Honua columnar batches. */
export const COLUMNAR_SERIALIZATION_KIND = "honua.columnar-batch-serialization" as const;
/** Eight-byte prefix used to reject unrelated or truncated payloads early. */
export const COLUMNAR_SERIALIZATION_MAGIC = "HONUACB1" as const;
export const DEFAULT_COLUMNAR_BATCH_MAX_SERIALIZED_BYTES = 68 * 1024 * 1024;

export interface ColumnarSerializationLimits extends ColumnarBatchLimits {
  /** Maximum bytes accepted or produced, including the wire header. */
  readonly maxSerializedBytes?: number;
}
export interface ColumnarSerializationMetrics {
  readonly rows: number;
  readonly serializedBytes: number;
  readonly payloadBytes: number;
  readonly copiedBytes: number;
  readonly backingBuffers: number;
}
export interface SerializedColumnarBatch {
  readonly bytes: ArrayBuffer;
  readonly metrics: ColumnarSerializationMetrics;
}
export interface DeserializedColumnarBatch {
  readonly batch: ColumnarBatchV1;
  readonly metrics: ColumnarSerializationMetrics;
}
export class HonuaColumnarSerializationError extends Error {
  public constructor(
    public readonly code: "invalid-input" | "invalid-batch" | "version-mismatch" | "size-limit-exceeded",
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HonuaColumnarSerializationError";
  }
}

interface WireBuffer {
  readonly id: string;
  readonly role: ColumnarBatchV1["buffers"][number]["role"];
  readonly field?: string;
  readonly backing: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}
interface WireDocument {
  readonly kind: typeof COLUMNAR_SERIALIZATION_KIND;
  readonly version: typeof COLUMNAR_SERIALIZATION_VERSION;
  readonly batch: Omit<ColumnarBatchV1, "buffers"> & { readonly buffers: readonly WireBuffer[] };
  readonly backings: readonly number[];
}

function fail(
  code: ConstructorParameters<typeof HonuaColumnarSerializationError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new HonuaColumnarSerializationError(code, message, cause === undefined ? {} : { cause });
}
function maxBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_COLUMNAR_BATCH_MAX_SERIALIZED_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0)
    fail("invalid-input", "maxSerializedBytes must be a positive safe integer.");
  return resolved;
}
function inputBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail("invalid-input", "Serialized columnar input must be an ArrayBuffer or ArrayBuffer view.");
}
function jsonBytes(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch (cause) {
    fail("invalid-batch", "Columnar batch metadata is not JSON serializable.", cause);
  }
}
function readHeader(
  source: Uint8Array,
  ceiling: number,
): { readonly document: WireDocument; readonly payloadOffset: number } {
  if (source.byteLength > ceiling) fail("size-limit-exceeded", "Serialized columnar batch exceeds the byte ceiling.");
  if (source.byteLength < 12) fail("invalid-batch", "Serialized columnar batch is truncated.");
  if (new TextDecoder().decode(source.subarray(0, 8)) !== COLUMNAR_SERIALIZATION_MAGIC)
    fail("invalid-batch", "Serialized columnar batch has an invalid magic prefix.");
  const headerBytes = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(8, true);
  const payloadOffset = 12 + headerBytes;
  if (payloadOffset > source.byteLength || headerBytes > ceiling)
    fail("invalid-batch", "Serialized columnar header is truncated.");
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(source.subarray(12, payloadOffset)));
  } catch (cause) {
    fail("invalid-batch", "Serialized columnar header is not valid JSON.", cause);
  }
  if (typeof document !== "object" || document === null)
    fail("invalid-batch", "Serialized columnar header must be an object.");
  const value = document as Partial<WireDocument>;
  if (value.kind !== COLUMNAR_SERIALIZATION_KIND) fail("invalid-batch", "Serialized columnar kind is not supported.");
  if (value.version !== COLUMNAR_SERIALIZATION_VERSION)
    fail("version-mismatch", `Serialized columnar version ${String(value.version)} is not supported.`);
  if (!value.batch || !Array.isArray(value.batch.buffers) || !Array.isArray(value.backings))
    fail("invalid-batch", "Serialized columnar header is missing batch buffers or backings.");
  return { document: value as WireDocument, payloadOffset };
}

/** Serialize one validated batch into a bounded, versioned binary envelope. */
export function serializeColumnarBatch(
  batch: ColumnarBatchV1,
  limits: ColumnarSerializationLimits = {},
): SerializedColumnarBatch {
  const ceiling = maxBytes(limits.maxSerializedBytes);
  const metrics = inspectColumnarBatch(batch, limits);
  const backingMap = new Map<ArrayBuffer, number>();
  const backings: ArrayBuffer[] = [];
  const buffers: WireBuffer[] = batch.buffers.map((buffer) => {
    let backing = backingMap.get(buffer.data);
    if (backing === undefined) {
      backing = backings.length;
      backingMap.set(buffer.data, backing);
      backings.push(buffer.data);
    }
    return {
      id: buffer.id,
      role: buffer.role,
      ...(buffer.field === undefined ? {} : { field: buffer.field }),
      backing,
      byteOffset: buffer.byteOffset,
      byteLength: buffer.byteLength,
    };
  });
  const document: WireDocument = {
    kind: COLUMNAR_SERIALIZATION_KIND,
    version: COLUMNAR_SERIALIZATION_VERSION,
    batch: { ...batch, buffers },
    backings: backings.map((backing) => backing.byteLength),
  };
  const header = jsonBytes(document);
  const payloadBytes = backings.reduce((total, backing) => total + backing.byteLength, 0);
  const totalBytes = 12 + header.byteLength + payloadBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > ceiling)
    fail("size-limit-exceeded", "Serialized columnar batch exceeds the byte ceiling.");
  const output = new Uint8Array(totalBytes);
  output.set(new TextEncoder().encode(COLUMNAR_SERIALIZATION_MAGIC), 0);
  new DataView(output.buffer).setUint32(8, header.byteLength, true);
  output.set(header, 12);
  let offset = 12 + header.byteLength;
  for (const backing of backings) {
    output.set(new Uint8Array(backing), offset);
    offset += backing.byteLength;
  }
  return Object.freeze({
    bytes: output.buffer,
    metrics: Object.freeze({
      rows: batch.rowCount,
      serializedBytes: totalBytes,
      payloadBytes,
      copiedBytes: totalBytes,
      backingBuffers: backings.length,
    }),
  });
}

/** Deserialize a bounded envelope, copying each unique backing exactly once. */
export function deserializeColumnarBatch(
  input: ArrayBuffer | ArrayBufferView,
  limits: ColumnarSerializationLimits = {},
): DeserializedColumnarBatch {
  const source = inputBytes(input);
  const ceiling = maxBytes(limits.maxSerializedBytes);
  const { document, payloadOffset } = readHeader(source, ceiling);
  const sizes = document.backings;
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0))
    fail("invalid-batch", "Serialized backing sizes must be non-negative safe integers.");
  const payloadBytes = sizes.reduce((total, size) => total + size, 0);
  if (payloadOffset + payloadBytes !== source.byteLength)
    fail("invalid-batch", "Serialized payload length does not match its header.");
  const backings: ArrayBuffer[] = [];
  let offset = payloadOffset;
  for (const size of sizes) {
    if (size > (limits.maxBackingBytes ?? Number.MAX_SAFE_INTEGER))
      fail("size-limit-exceeded", "Serialized backing exceeds the backing ceiling.");
    const backing = new ArrayBuffer(size);
    new Uint8Array(backing).set(source.subarray(offset, offset + size));
    backings.push(backing);
    offset += size;
  }
  const buffers = document.batch.buffers.map((buffer) => {
    const backing = backings[buffer.backing];
    if (
      !backing ||
      !Number.isSafeInteger(buffer.byteOffset) ||
      !Number.isSafeInteger(buffer.byteLength) ||
      buffer.byteOffset < 0 ||
      buffer.byteLength < 0 ||
      buffer.byteOffset + buffer.byteLength > backing.byteLength
    )
      fail("invalid-batch", "Serialized buffer view is outside its backing.");
    return { ...buffer, data: backing };
  });
  let batch: ColumnarBatchV1;
  try {
    batch = createColumnarBatch({ ...document.batch, buffers }, limits);
  } catch (cause) {
    fail("invalid-batch", "Serialized columnar batch failed bounded validation.", cause);
  }
  const inspected = inspectColumnarBatch(batch, limits);
  return Object.freeze({
    batch,
    metrics: Object.freeze({
      rows: batch.rowCount,
      serializedBytes: source.byteLength,
      payloadBytes,
      copiedBytes: payloadBytes,
      backingBuffers: inspected.backingBuffers,
    }),
  });
}
