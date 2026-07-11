import {
  COLUMNAR_BATCH_KIND,
  COLUMNAR_BATCH_VERSION,
  COLUMNAR_TRANSFER_KIND,
  type ColumnarBatchLeaseState,
  type ColumnarBatchLimits,
  type ColumnarBatchMetrics,
  type ColumnarBatchV1,
  type ColumnarBufferV1,
  type ColumnarFieldV1,
  type ColumnarSchemaV1,
  type ColumnarTransferMessageV1,
  type ColumnarTransferOptions,
  type ColumnarTransferReceipt,
  type ColumnarTransferTarget,
  type ColumnarTypeV1,
  type CreateColumnarBatchInput,
  DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
  DEFAULT_COLUMNAR_BATCH_MAX_ROWS,
  HonuaColumnarTransferError,
} from "./types.js";

interface Inspection {
  readonly metrics: ColumnarBatchMetrics;
  readonly transfer: readonly ArrayBuffer[];
}

const BUFFER_ROLES = new Set(["validity", "offsets", "type-ids", "values", "dictionary", "geometry", "custom"]);
const trustedBatches = new WeakSet<object>();
const leasedBuffers = new WeakMap<ArrayBuffer, ColumnarBatchLease>();

function invalid(message: string): never {
  throw new HonuaColumnarTransferError("invalid-batch", message);
}

function invalidBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof HonuaColumnarTransferError) throw cause;
    throw new HonuaColumnarTransferError("invalid-batch", "Columnar batch validation failed", { cause });
  }
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${label} must be a non-empty string`);
  if (value !== value.trim()) invalid(`${label} must not have leading or trailing whitespace`);
  return value;
}

function requireSafeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative safe integer`);
  return value;
}

function normalizeLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new HonuaColumnarTransferError("invalid-batch", `${label} must be a positive safe integer`);
  }
  return resolved;
}

function normalizeStringRecord(
  value: Readonly<Record<string, string>> | undefined,
  label: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const normalized = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(value).sort()) {
    requireIdentifier(key, `${label} key`);
    const item = value[key];
    if (typeof item !== "string") invalid(`${label}.${key} must be a string`);
    normalized[key] = item;
  }
  return Object.freeze(normalized);
}

function normalizeParameters(
  value: Readonly<Record<string, string | number | boolean>> | undefined,
  label: string,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const normalized = Object.create(null) as Record<string, string | number | boolean>;
  for (const key of Object.keys(value).sort()) {
    requireIdentifier(key, `${label} key`);
    const item = value[key];
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      invalid(`${label}.${key} must be a string, number, or boolean`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) invalid(`${label}.${key} must be finite`);
    normalized[key] = item;
  }
  return Object.freeze(normalized);
}

function normalizeType(type: ColumnarTypeV1, label: string): ColumnarTypeV1 {
  if (typeof type !== "object" || type === null) invalid(`${label} must be an object`);
  const name = type.name;
  const rawParameters = type.parameters;
  const parameters = normalizeParameters(rawParameters, `${label}.parameters`);
  return Object.freeze({
    name: requireIdentifier(name, `${label}.name`),
    ...(parameters === undefined ? {} : { parameters }),
  });
}

function normalizeField(field: ColumnarFieldV1, path: string, depth: number): ColumnarFieldV1 {
  if (depth > 64) invalid(`${path} exceeds the maximum schema nesting depth`);
  if (typeof field !== "object" || field === null) invalid(`${path} must be an object`);
  const name = field.name;
  const type = field.type;
  const nullable = field.nullable;
  const rawChildren = field.children;
  const rawMetadata = field.metadata;
  if (typeof nullable !== "boolean") invalid(`${path}.nullable must be a boolean`);
  if (rawChildren !== undefined && !Array.isArray(rawChildren)) invalid(`${path}.children must be an array`);
  const children = rawChildren?.map((child, index) => normalizeField(child, `${path}.children[${index}]`, depth + 1));
  if (children) {
    const names = new Set<string>();
    for (const child of children) {
      if (names.has(child.name)) invalid(`${path} has duplicate child field ${child.name}`);
      names.add(child.name);
    }
  }
  const metadata = normalizeStringRecord(rawMetadata, `${path}.metadata`);
  return Object.freeze({
    name: requireIdentifier(name, `${path}.name`),
    type: normalizeType(type, `${path}.type`),
    nullable,
    ...(children === undefined ? {} : { children: Object.freeze(children) }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function normalizeSchema(schema: ColumnarSchemaV1): ColumnarSchemaV1 {
  if (typeof schema !== "object" || schema === null) invalid("schema must be an object");
  const id = schema.id;
  const rawFields = schema.fields;
  const rawMetadata = schema.metadata;
  if (!Array.isArray(rawFields)) invalid("schema.fields must be an array");
  const fieldNames = new Set<string>();
  const fields = rawFields.map((field, index) => {
    const normalized = normalizeField(field, `schema.fields[${index}]`, 0);
    if (fieldNames.has(normalized.name)) invalid(`schema has duplicate top-level field ${normalized.name}`);
    fieldNames.add(normalized.name);
    return normalized;
  });
  const metadata = normalizeStringRecord(rawMetadata, "schema.metadata");
  return Object.freeze({
    id: requireIdentifier(id, "schema.id"),
    fields: Object.freeze(fields),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function schemaFieldPaths(schema: ColumnarSchemaV1): ReadonlySet<string> {
  const paths = new Set<string>();
  const visit = (fields: readonly ColumnarFieldV1[], parent?: string): void => {
    for (const field of fields) {
      const path = parent ? `${parent}.${field.name}` : field.name;
      paths.add(path);
      if (field.children) visit(field.children, path);
    }
  };
  visit(schema.fields);
  return paths;
}

function assertBufferFields(buffers: readonly ColumnarBufferV1[], schema: ColumnarSchemaV1): void {
  const paths = schemaFieldPaths(schema);
  for (const [index, buffer] of buffers.entries()) {
    if (buffer.field !== undefined && !paths.has(buffer.field)) {
      invalid(`buffers[${index}].field does not exist in schema: ${buffer.field}`);
    }
  }
}

function assertRowRange(rowOffset: number | undefined, rowCount: number): void {
  if (rowOffset !== undefined && !Number.isSafeInteger(rowOffset + rowCount)) {
    invalid("rowOffset + rowCount exceeds safe integer precision");
  }
}

function normalizeBuffer(buffer: ColumnarBufferV1, index: number): ColumnarBufferV1 {
  const label = `buffers[${index}]`;
  if (typeof buffer !== "object" || buffer === null) invalid(`${label} must be an object`);
  const id = buffer.id;
  const role = buffer.role;
  const rawField = buffer.field;
  const data = buffer.data;
  const rawByteOffset = buffer.byteOffset;
  const rawByteLength = buffer.byteLength;
  if (!(data instanceof ArrayBuffer)) invalid(`${label}.data must be a transferable ArrayBuffer`);
  assertAttached(data, `${label}.data`);
  if (!BUFFER_ROLES.has(role)) invalid(`${label}.role is not supported`);
  const byteOffset = requireSafeNonNegativeInteger(rawByteOffset, `${label}.byteOffset`);
  const byteLength = requireSafeNonNegativeInteger(rawByteLength, `${label}.byteLength`);
  if (byteOffset + byteLength > data.byteLength) invalid(`${label} view exceeds its backing buffer`);
  const field = rawField === undefined ? undefined : requireIdentifier(rawField, `${label}.field`);
  return Object.freeze({
    id: requireIdentifier(id, `${label}.id`),
    role,
    ...(field === undefined ? {} : { field }),
    data,
    byteOffset,
    byteLength,
  });
}

function assertAttached(buffer: ArrayBuffer, label: string): void {
  try {
    // Constructing a zero-length view does not copy or touch payload bytes. It
    // succeeds for a legitimate empty buffer and throws for a detached one.
    new Uint8Array(buffer, 0, 0);
  } catch {
    invalid(`${label} is detached`);
  }
}

function normalizeBatchInput(input: CreateColumnarBatchInput): ColumnarBatchV1 {
  if (typeof input !== "object" || input === null) invalid("batch input must be an object");
  const id = input.id;
  const rawSchema = input.schema;
  const rawRowCount = input.rowCount;
  const rawSequence = input.sequence;
  const rawRowOffset = input.rowOffset;
  const rawBuffers = input.buffers;
  if (!Array.isArray(rawBuffers)) invalid("buffers must be an array");
  const schema = normalizeSchema(rawSchema);
  const rowCount = requireSafeNonNegativeInteger(rawRowCount, "rowCount");
  const sequence = requireSafeNonNegativeInteger(rawSequence, "sequence");
  const rowOffset = rawRowOffset === undefined ? undefined : requireSafeNonNegativeInteger(rawRowOffset, "rowOffset");
  assertRowRange(rowOffset, rowCount);
  const ids = new Set<string>();
  const buffers: ColumnarBufferV1[] = [];
  for (const [index, buffer] of rawBuffers.entries()) {
    const normalized = normalizeBuffer(buffer, index);
    if (ids.has(normalized.id)) invalid(`buffers has duplicate id ${normalized.id}`);
    ids.add(normalized.id);
    buffers.push(normalized);
  }
  assertBufferFields(buffers, schema);
  const batch = Object.freeze({
    kind: COLUMNAR_BATCH_KIND,
    version: COLUMNAR_BATCH_VERSION,
    id: requireIdentifier(id, "id"),
    schema,
    rowCount,
    sequence,
    ...(rowOffset === undefined ? {} : { rowOffset }),
    buffers: Object.freeze(buffers),
  });
  trustedBatches.add(batch);
  return batch;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaColumnarTransferError("aborted", "Columnar transfer was aborted");
}

function inspectTrusted(batch: ColumnarBatchV1, limits: ColumnarBatchLimits): Inspection {
  const maxRows = normalizeLimit(limits.maxRows, DEFAULT_COLUMNAR_BATCH_MAX_ROWS, "maxRows");
  const maxBackingBytes = normalizeLimit(
    limits.maxBackingBytes,
    DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
    "maxBackingBytes",
  );
  if (batch.rowCount > maxRows) {
    throw new HonuaColumnarTransferError(
      "row-limit-exceeded",
      `Columnar batch has ${batch.rowCount} rows; the limit is ${maxRows}`,
    );
  }

  const transfer: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  let logicalBytes = 0;
  let backingBytes = 0;
  for (const [index, buffer] of batch.buffers.entries()) {
    assertAttached(buffer.data, `buffers[${index}].data`);
    if (buffer.byteOffset + buffer.byteLength > buffer.data.byteLength) {
      invalid(`buffers[${index}] is detached or exceeds its backing buffer`);
    }
    logicalBytes += buffer.byteLength;
    if (!Number.isSafeInteger(logicalBytes)) invalid("logical byte length exceeds safe integer precision");
    if (!seen.has(buffer.data)) {
      seen.add(buffer.data);
      transfer.push(buffer.data);
      backingBytes += buffer.data.byteLength;
      if (!Number.isSafeInteger(backingBytes)) invalid("backing byte length exceeds safe integer precision");
    }
  }
  if (backingBytes > maxBackingBytes) {
    throw new HonuaColumnarTransferError(
      "memory-limit-exceeded",
      `Columnar batch owns ${backingBytes} backing bytes; the limit is ${maxBackingBytes}`,
    );
  }
  const metrics = Object.freeze({
    rows: batch.rowCount,
    logicalBytes,
    backingBytes,
    transferBytes: backingBytes,
    copiedBytes: 0 as const,
    bufferViews: batch.buffers.length,
    backingBuffers: transfer.length,
  });
  return { metrics, transfer: Object.freeze(transfer) };
}

function inspect(batch: ColumnarBatchV1, limits: ColumnarBatchLimits = {}): Inspection {
  return invalidBoundary(() => {
    if (typeof batch !== "object" || batch === null) invalid("batch must be an object");
    const kind = batch.kind;
    const version = batch.version;
    if (kind !== COLUMNAR_BATCH_KIND || version !== COLUMNAR_BATCH_VERSION) {
      invalid(`batch must be ${COLUMNAR_BATCH_KIND}@${COLUMNAR_BATCH_VERSION}`);
    }
    const snapshot = trustedBatches.has(batch) ? batch : normalizeBatchInput(batch);
    return inspectTrusted(snapshot, limits);
  });
}

/**
 * Validate and normalize one batch without copying its payload buffers.
 * Schema metadata is cloned/frozen so later caller mutation cannot change the
 * transport contract; every `data` reference remains exactly caller-owned.
 */
export function createColumnarBatch(
  input: CreateColumnarBatchInput,
  limits: ColumnarBatchLimits = {},
): ColumnarBatchV1 {
  return invalidBoundary(() => {
    const batch = normalizeBatchInput(input);
    inspectTrusted(batch, limits);
    return batch;
  });
}

/** Inspect an owned batch and return exact backing-allocation/copy accounting. */
export function inspectColumnarBatch(batch: ColumnarBatchV1, limits: ColumnarBatchLimits = {}): ColumnarBatchMetrics {
  return inspect(batch, limits).metrics;
}

/**
 * Owns the right to transfer a batch once. The SDK first uses structured clone
 * to detach the lease's buffers, then invokes the consumer with the owned clone
 * and its exact deduplicated transfer list. The optional consumer promise is an
 * acknowledgement/backpressure boundary; rejection never restores ownership.
 */
export class ColumnarBatchLease {
  #batch: ColumnarBatchV1 | undefined;
  #state: ColumnarBatchLeaseState = "owned";
  readonly #limits: ColumnarBatchLimits;
  readonly #reservedBuffers: readonly ArrayBuffer[];

  public constructor(batch: ColumnarBatchV1, limits: ColumnarBatchLimits = {}) {
    const snapshot = trustedBatches.has(batch) ? batch : createColumnarBatch(batch, limits);
    const inspection = inspect(snapshot, limits);
    for (const buffer of inspection.transfer) {
      if (leasedBuffers.has(buffer)) {
        throw new HonuaColumnarTransferError(
          "already-leased",
          "A backing buffer is already owned by another columnar batch lease",
        );
      }
    }
    this.#batch = snapshot;
    this.#limits = Object.freeze({ ...limits });
    this.#reservedBuffers = inspection.transfer;
    for (const buffer of this.#reservedBuffers) leasedBuffers.set(buffer, this);
  }

  public get state(): ColumnarBatchLeaseState {
    return this.#state;
  }

  public get batch(): ColumnarBatchV1 {
    if (this.#state === "disposed")
      throw new HonuaColumnarTransferError("disposed", "Columnar batch lease is disposed");
    if (this.#state === "transferred" || this.#state === "transferring") {
      throw new HonuaColumnarTransferError("already-transferred", "Columnar batch ownership has been transferred");
    }
    return this.#batch as ColumnarBatchV1;
  }

  public async transfer(
    target: ColumnarTransferTarget,
    options: ColumnarTransferOptions = {},
  ): Promise<ColumnarTransferReceipt> {
    const batch = this.batch;
    assertNotAborted(options.signal);
    const effectiveLimits: ColumnarBatchLimits = {
      maxRows: options.maxRows ?? this.#limits.maxRows,
      maxBackingBytes: options.maxBackingBytes ?? this.#limits.maxBackingBytes,
    };
    const { metrics, transfer } = inspect(batch, effectiveLimits);
    const message: ColumnarTransferMessageV1 = Object.freeze({
      kind: COLUMNAR_TRANSFER_KIND,
      version: COLUMNAR_BATCH_VERSION,
      batch,
      metrics,
    });

    this.#state = "transferring";
    let ownedMessage: ColumnarTransferMessageV1;
    try {
      ownedMessage = structuredClone(message, { transfer: [...transfer] });
    } catch (cause) {
      this.#state = "owned";
      throw new HonuaColumnarTransferError("transport-failed", "Columnar ownership transfer failed", {
        cause,
      });
    }
    this.#state = "transferred";
    this.#batch = undefined;
    this.releaseReservations();

    const ownedTransfer = inspect(ownedMessage.batch, effectiveLimits).transfer;
    let acknowledgement: void | Promise<void>;
    try {
      acknowledgement = target(ownedMessage, ownedTransfer);
    } catch (cause) {
      throw new HonuaColumnarTransferError("transport-failed", "Columnar consumer rejected the transferred batch", {
        cause,
      });
    }
    try {
      await acknowledgement;
    } catch (cause) {
      throw new HonuaColumnarTransferError(
        "transport-failed",
        "Columnar transfer was handed off but the consumer acknowledgement failed",
        { cause },
      );
    }
    return Object.freeze({ batchId: batch.id, metrics, acknowledged: true as const });
  }

  /** Release this lease's owned references. Idempotent after disposal. */
  public dispose(): void {
    if (this.#state === "disposed") return;
    if (this.#state === "transferring") {
      throw new HonuaColumnarTransferError("already-transferred", "Cannot dispose a columnar batch during transfer");
    }
    this.#batch = undefined;
    this.releaseReservations();
    this.#state = "disposed";
  }

  private releaseReservations(): void {
    for (const buffer of this.#reservedBuffers) {
      if (leasedBuffers.get(buffer) === this) leasedBuffers.delete(buffer);
    }
  }
}

/** Validate and wrap a batch in a one-owner transfer lease. */
export function leaseColumnarBatch(batch: ColumnarBatchV1, limits: ColumnarBatchLimits = {}): ColumnarBatchLease {
  return new ColumnarBatchLease(batch, limits);
}
