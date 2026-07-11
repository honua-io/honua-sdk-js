/** Version discriminator for the first Honua columnar batch contract. */
export const COLUMNAR_BATCH_VERSION = "1.0" as const;

/** Stable structured-clone discriminator for a columnar batch. */
export const COLUMNAR_BATCH_KIND = "honua.columnar-batch" as const;

/** Stable structured-clone discriminator for a worker transfer message. */
export const COLUMNAR_TRANSFER_KIND = "honua.columnar-transfer" as const;

/** Conservative defaults for one independently transferable batch. */
export const DEFAULT_COLUMNAR_BATCH_MAX_ROWS = 1_000_000;
export const DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES = 64 * 1024 * 1024;
export const DEFAULT_COLUMNAR_BATCH_MAX_SCHEMA_NODES = 4_096;
export const DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES = 8_192;
export const DEFAULT_COLUMNAR_BATCH_MAX_BUFFER_VIEWS = 16_384;
export const DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES = 1024 * 1024;

/**
 * Adapter-declared logical type name. Adapters may use Arrow or GeoArrow names
 * and metadata, but this Honua envelope does not itself define an Arrow memory
 * layout or replace an Arrow schema.
 */
export interface ColumnarTypeV1 {
  readonly name: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

/** Dependency-free field description carried with a Honua columnar batch. */
export interface ColumnarFieldV1 {
  readonly name: string;
  readonly type: ColumnarTypeV1;
  readonly nullable: boolean;
  readonly children?: readonly ColumnarFieldV1[];
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A versioned schema identity and its dependency-free field descriptions.
 * The id must change whenever field order, types, nullability, CRS, or
 * extension metadata changes.
 */
export interface ColumnarSchemaV1 {
  readonly id: string;
  readonly fields: readonly ColumnarFieldV1[];
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Adapter-declared purpose of a buffer in the Honua envelope. */
export type ColumnarBufferRole = "validity" | "offsets" | "type-ids" | "values" | "dictionary" | "geometry" | "custom";

/**
 * A view onto an owned transferable backing buffer. Multiple descriptors may
 * reference the same `ArrayBuffer`; transfer and memory accounting deduplicate
 * by backing-buffer identity.
 */
export interface ColumnarBufferV1 {
  readonly id: string;
  readonly role: ColumnarBufferRole;
  /** Dot-separated field path when the buffer belongs to one field. */
  readonly field?: string;
  readonly data: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/** Input accepted by {@link createColumnarBatch}. */
export interface CreateColumnarBatchInput {
  readonly id: string;
  readonly schema: ColumnarSchemaV1;
  readonly rowCount: number;
  readonly sequence: number;
  readonly rowOffset?: number;
  readonly buffers: readonly ColumnarBufferV1[];
}

/**
 * Protocol-neutral, dependency-free transport representation of one columnar
 * record batch. Adapters can reference existing Arrow/GeoArrow buffers and
 * metadata, but consumers still need the originating adapter's layout contract.
 */
export interface ColumnarBatchV1 extends CreateColumnarBatchInput {
  readonly kind: typeof COLUMNAR_BATCH_KIND;
  readonly version: typeof COLUMNAR_BATCH_VERSION;
}

/** Explicit creation and transfer ceilings. There is no unbounded mode. */
export interface ColumnarBatchLimits {
  readonly maxRows?: number;
  /** Counts complete unique backing buffers, not only referenced slices. */
  readonly maxBackingBytes?: number;
  /** Maximum total top-level and nested schema fields. */
  readonly maxSchemaNodes?: number;
  /** Maximum combined schema, field, and type-parameter entries. */
  readonly maxMetadataEntries?: number;
  /** Maximum number of buffer descriptors, including zero-byte/shared views. */
  readonly maxBufferViews?: number;
  /** Maximum UTF-8 bytes across descriptor identifiers, keys, and string values. */
  readonly maxStringBytes?: number;
}

/** Exact payload-copy and backing-allocation accounting for a batch. */
export interface ColumnarBatchMetrics {
  readonly rows: number;
  /** Sum of descriptor slice lengths; overlapping slices count separately. */
  readonly logicalBytes: number;
  /** Sum of `byteLength` for complete unique transferable backing buffers. */
  readonly backingBytes: number;
  /** Bytes relinquished when the transfer list is posted. */
  readonly transferBytes: number;
  /** Always zero: the SDK never slices or clones payload buffers. */
  readonly copiedBytes: 0;
  readonly bufferViews: number;
  readonly backingBuffers: number;
}

/** Structured-clone-safe worker message paired with an exact transfer list. */
export interface ColumnarTransferMessageV1 {
  readonly kind: typeof COLUMNAR_TRANSFER_KIND;
  readonly version: typeof COLUMNAR_BATCH_VERSION;
  readonly batch: ColumnarBatchV1;
  readonly metrics: ColumnarBatchMetrics;
}

export type ColumnarBatchLeaseState = "owned" | "transferring" | "transferred" | "disposed";

export type ColumnarTransferErrorCode =
  | "invalid-batch"
  | "row-limit-exceeded"
  | "memory-limit-exceeded"
  | "schema-limit-exceeded"
  | "metadata-limit-exceeded"
  | "buffer-view-limit-exceeded"
  | "string-limit-exceeded"
  | "already-leased"
  | "aborted"
  | "already-transferred"
  | "disposed"
  | "transport-failed";

/** Typed failures for validation, ownership, cancellation, and transport. */
export class HonuaColumnarTransferError extends Error {
  public constructor(
    public readonly code: ColumnarTransferErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HonuaColumnarTransferError";
  }
}

/** Synchronous ownership handoff plus optional asynchronous consumer ack. */
export type ColumnarTransferTarget = (
  message: ColumnarTransferMessageV1,
  /** Transfer list for an optional subsequent worker/port handoff. */
  transfer: readonly ArrayBuffer[],
) => void | Promise<void>;

export interface ColumnarTransferOptions extends ColumnarBatchLimits {
  /** Cancellation is honored before the SDK performs its ownership handoff. */
  readonly signal?: AbortSignal;
}

export interface ColumnarTransferReceipt {
  readonly batchId: string;
  readonly metrics: ColumnarBatchMetrics;
  readonly acknowledged: true;
}
