import {
  COLUMNAR_BATCH_KIND,
  COLUMNAR_BATCH_VERSION,
  COLUMNAR_TRANSFER_KIND,
  type ColumnarBatchIdentityV1,
  type ColumnarBatchLeaseState,
  type ColumnarBatchLimits,
  type ColumnarBatchMetrics,
  type ColumnarBatchV1,
  type ColumnarBufferV1,
  type ColumnarFieldV1,
  type ColumnarOrderingKeyV1,
  type ColumnarSchemaV1,
  type ColumnarTransferMessageV1,
  type ColumnarTransferOptions,
  type ColumnarTransferReceipt,
  type ColumnarTransferTarget,
  type ColumnarTypeV1,
  type CreateColumnarBatchInput,
  DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
  DEFAULT_COLUMNAR_BATCH_MAX_BUFFER_VIEWS,
  DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES,
  DEFAULT_COLUMNAR_BATCH_MAX_ROWS,
  DEFAULT_COLUMNAR_BATCH_MAX_SCHEMA_NODES,
  DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES,
  HonuaColumnarTransferError,
} from "./types.js";

interface Inspection {
  readonly metrics: ColumnarBatchMetrics;
  readonly transfer: readonly ArrayBuffer[];
}

interface ResolvedLimits {
  readonly maxRows: number;
  readonly maxBackingBytes: number;
  readonly maxSchemaNodes: number;
  readonly maxMetadataEntries: number;
  readonly maxBufferViews: number;
  readonly maxStringBytes: number;
}

interface NormalizationUsage {
  schemaNodes: number;
  metadataEntries: number;
  bufferViews: number;
  stringBytes: number;
}

const BUFFER_ROLES = new Set(["validity", "offsets", "type-ids", "values", "dictionary", "geometry", "custom"]);
const trustedBatches = new WeakSet<object>();
const trustedBatchUsage = new WeakMap<object, Readonly<NormalizationUsage>>();
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

function resolveLimits(limits: ColumnarBatchLimits): ResolvedLimits {
  return Object.freeze({
    maxRows: normalizeLimit(limits.maxRows, DEFAULT_COLUMNAR_BATCH_MAX_ROWS, "maxRows"),
    maxBackingBytes: normalizeLimit(
      limits.maxBackingBytes,
      DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
      "maxBackingBytes",
    ),
    maxSchemaNodes: normalizeLimit(limits.maxSchemaNodes, DEFAULT_COLUMNAR_BATCH_MAX_SCHEMA_NODES, "maxSchemaNodes"),
    maxMetadataEntries: normalizeLimit(
      limits.maxMetadataEntries,
      DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES,
      "maxMetadataEntries",
    ),
    maxBufferViews: normalizeLimit(limits.maxBufferViews, DEFAULT_COLUMNAR_BATCH_MAX_BUFFER_VIEWS, "maxBufferViews"),
    maxStringBytes: normalizeLimit(limits.maxStringBytes, DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES, "maxStringBytes"),
  });
}

function createUsage(): NormalizationUsage {
  return { schemaNodes: 0, metadataEntries: 0, bufferViews: 0, stringBytes: 0 };
}

function consumeCount(
  usage: NormalizationUsage,
  key: "schemaNodes" | "metadataEntries" | "bufferViews",
  count: number,
  limit: number,
  code: "schema-limit-exceeded" | "metadata-limit-exceeded" | "buffer-view-limit-exceeded",
  label: string,
): void {
  if (count > limit - usage[key]) {
    throw new HonuaColumnarTransferError(code, `${label} exceeds the configured ${limit}-entry limit`);
  }
  usage[key] += count;
}

function consumeString(value: unknown, label: string, usage: NormalizationUsage, limits: ResolvedLimits): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  const remaining = limits.maxStringBytes - usage.stringBytes;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > remaining) {
      throw new HonuaColumnarTransferError(
        "string-limit-exceeded",
        `${label} exceeds the configured ${limits.maxStringBytes}-byte descriptor string limit`,
      );
    }
  }
  usage.stringBytes += bytes;
  return value;
}

function boundedMetadataKeys(
  value: object,
  label: string,
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): string[] {
  const remaining = limits.maxMetadataEntries - usage.metadataEntries;
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (keys.length >= remaining) {
      throw new HonuaColumnarTransferError(
        "metadata-limit-exceeded",
        `${label} exceeds the configured ${limits.maxMetadataEntries}-entry limit`,
      );
    }
    keys.push(key);
  }
  consumeCount(usage, "metadataEntries", keys.length, limits.maxMetadataEntries, "metadata-limit-exceeded", label);
  return keys.sort();
}

function requireIdentifier(value: unknown, label: string, usage: NormalizationUsage, limits: ResolvedLimits): string {
  const normalized = consumeString(value, label, usage, limits);
  if (normalized.trim().length === 0) invalid(`${label} must be a non-empty string`);
  if (normalized !== normalized.trim()) invalid(`${label} must not have leading or trailing whitespace`);
  return normalized;
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
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const keys = boundedMetadataKeys(value, label, usage, limits);
  const normalized = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    const normalizedKey = requireIdentifier(key, `${label} key`, usage, limits);
    normalized[normalizedKey] = consumeString(value[key], `${label}.${key}`, usage, limits);
  }
  return Object.freeze(normalized);
}

function normalizeParameters(
  value: Readonly<Record<string, string | number | boolean>> | undefined,
  label: string,
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const keys = boundedMetadataKeys(value, label, usage, limits);
  const normalized = Object.create(null) as Record<string, string | number | boolean>;
  for (const key of keys) {
    const normalizedKey = requireIdentifier(key, `${label} key`, usage, limits);
    const item = value[key];
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      invalid(`${label}.${key} must be a string, number, or boolean`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) invalid(`${label}.${key} must be finite`);
    normalized[normalizedKey] = typeof item === "string" ? consumeString(item, `${label}.${key}`, usage, limits) : item;
  }
  return Object.freeze(normalized);
}

function normalizeType(
  type: ColumnarTypeV1,
  label: string,
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): ColumnarTypeV1 {
  if (typeof type !== "object" || type === null) invalid(`${label} must be an object`);
  const name = type.name;
  const rawParameters = type.parameters;
  const parameters = normalizeParameters(rawParameters, `${label}.parameters`, usage, limits);
  return Object.freeze({
    name: requireIdentifier(name, `${label}.name`, usage, limits),
    ...(parameters === undefined ? {} : { parameters }),
  });
}

function normalizeField(
  field: ColumnarFieldV1,
  path: string,
  depth: number,
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): ColumnarFieldV1 {
  if (depth > 64) invalid(`${path} exceeds the maximum schema nesting depth`);
  if (typeof field !== "object" || field === null) invalid(`${path} must be an object`);
  consumeCount(usage, "schemaNodes", 1, limits.maxSchemaNodes, "schema-limit-exceeded", "schema fields");
  const name = field.name;
  const type = field.type;
  const nullable = field.nullable;
  const rawChildren = field.children;
  const rawMetadata = field.metadata;
  if (typeof nullable !== "boolean") invalid(`${path}.nullable must be a boolean`);
  if (rawChildren !== undefined && !Array.isArray(rawChildren)) invalid(`${path}.children must be an array`);
  const childCount = rawChildren?.length;
  if (childCount !== undefined && childCount > limits.maxSchemaNodes - usage.schemaNodes) {
    throw new HonuaColumnarTransferError(
      "schema-limit-exceeded",
      `schema fields exceeds the configured ${limits.maxSchemaNodes}-entry limit`,
    );
  }
  let children: ColumnarFieldV1[] | undefined;
  if (rawChildren && childCount !== undefined) {
    children = [];
    for (let index = 0; index < childCount; index += 1) {
      children.push(normalizeField(rawChildren[index]!, `${path}.children[${index}]`, depth + 1, usage, limits));
    }
  }
  if (children) {
    const names = new Set<string>();
    for (const child of children) {
      if (names.has(child.name)) invalid(`${path} has duplicate child field ${child.name}`);
      names.add(child.name);
    }
  }
  const metadata = normalizeStringRecord(rawMetadata, `${path}.metadata`, usage, limits);
  return Object.freeze({
    name: requireIdentifier(name, `${path}.name`, usage, limits),
    type: normalizeType(type, `${path}.type`, usage, limits),
    nullable,
    ...(children === undefined ? {} : { children: Object.freeze(children) }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function normalizeSchema(
  schema: ColumnarSchemaV1,
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): ColumnarSchemaV1 {
  if (typeof schema !== "object" || schema === null) invalid("schema must be an object");
  const id = schema.id;
  const rawFields = schema.fields;
  const rawMetadata = schema.metadata;
  if (!Array.isArray(rawFields)) invalid("schema.fields must be an array");
  const fieldCount = rawFields.length;
  if (fieldCount > limits.maxSchemaNodes - usage.schemaNodes) {
    throw new HonuaColumnarTransferError(
      "schema-limit-exceeded",
      `schema fields exceeds the configured ${limits.maxSchemaNodes}-entry limit`,
    );
  }
  const fieldNames = new Set<string>();
  const fields: ColumnarFieldV1[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    const normalized = normalizeField(rawFields[index]!, `schema.fields[${index}]`, 0, usage, limits);
    if (fieldNames.has(normalized.name)) invalid(`schema has duplicate top-level field ${normalized.name}`);
    fieldNames.add(normalized.name);
    fields.push(normalized);
  }
  const metadata = normalizeStringRecord(rawMetadata, "schema.metadata", usage, limits);
  return Object.freeze({
    id: requireIdentifier(id, "schema.id", usage, limits),
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

function requireRfc3339(value: unknown, label: string, usage: NormalizationUsage, limits: ResolvedLimits): string {
  const normalized = consumeString(value, label, usage, limits);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ||
    !Number.isFinite(Date.parse(normalized))
  ) {
    invalid(`${label} must be an RFC 3339 instant`);
  }
  return normalized;
}

function normalizeBatchIdentity(
  identity: ColumnarBatchIdentityV1 | undefined,
  schema: ColumnarSchemaV1,
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): ColumnarBatchIdentityV1 | undefined {
  if (identity === undefined) return undefined;
  if (typeof identity !== "object" || identity === null) invalid("identity must be an object");
  consumeCount(usage, "metadataEntries", 7, limits.maxMetadataEntries, "metadata-limit-exceeded", "identity");

  const sourceId = requireIdentifier(identity.sourceId, "identity.sourceId", usage, limits);
  const sourceVersion = requireIdentifier(identity.sourceVersion, "identity.sourceVersion", usage, limits);
  const schemaVersion = requireIdentifier(identity.schemaVersion, "identity.schemaVersion", usage, limits);
  if (schemaVersion !== schema.id) invalid("identity.schemaVersion must equal schema.id");
  const planId = requireIdentifier(identity.planId, "identity.planId", usage, limits);
  const authorizationScope = requireIdentifier(
    identity.authorizationScope,
    "identity.authorizationScope",
    usage,
    limits,
  );

  const ordering = identity.ordering;
  if (typeof ordering !== "object" || ordering === null) invalid("identity.ordering must be an object");
  if (typeof ordering.stable !== "boolean") invalid("identity.ordering.stable must be a boolean");
  if (!Array.isArray(ordering.keys)) invalid("identity.ordering.keys must be an array");
  const keyCount = ordering.keys.length;
  consumeCount(
    usage,
    "metadataEntries",
    keyCount * 3,
    limits.maxMetadataEntries,
    "metadata-limit-exceeded",
    "identity ordering keys",
  );
  if (ordering.stable && keyCount === 0) invalid("a stable identity ordering requires at least one key");
  const fieldPaths = schemaFieldPaths(schema);
  const orderingKeys: ColumnarOrderingKeyV1[] = [];
  for (let index = 0; index < keyCount; index += 1) {
    const key = ordering.keys[index];
    if (typeof key !== "object" || key === null) invalid(`identity.ordering.keys[${index}] must be an object`);
    const field = requireIdentifier(key.field, `identity.ordering.keys[${index}].field`, usage, limits);
    if (!fieldPaths.has(field)) invalid(`identity.ordering.keys[${index}].field does not exist in schema: ${field}`);
    if (key.direction !== "ascending" && key.direction !== "descending") {
      invalid(`identity.ordering.keys[${index}].direction is not supported`);
    }
    if (key.nulls !== "first" && key.nulls !== "last") {
      invalid(`identity.ordering.keys[${index}].nulls is not supported`);
    }
    orderingKeys.push(Object.freeze({ field, direction: key.direction, nulls: key.nulls }));
  }

  const freshness = identity.freshness;
  if (typeof freshness !== "object" || freshness === null) invalid("identity.freshness must be an object");
  const observedAt = requireRfc3339(identity.freshness.observedAt, "identity.freshness.observedAt", usage, limits);
  const staleAfter =
    freshness.staleAfter === undefined
      ? undefined
      : requireRfc3339(freshness.staleAfter, "identity.freshness.staleAfter", usage, limits);
  if (staleAfter !== undefined && Date.parse(staleAfter) < Date.parse(observedAt)) {
    invalid("identity.freshness.staleAfter must not precede observedAt");
  }
  const validator =
    freshness.validator === undefined
      ? undefined
      : requireIdentifier(freshness.validator, "identity.freshness.validator", usage, limits);
  const generation =
    freshness.generation === undefined
      ? undefined
      : requireIdentifier(freshness.generation, "identity.freshness.generation", usage, limits);

  return Object.freeze({
    sourceId,
    sourceVersion,
    schemaVersion,
    planId,
    authorizationScope,
    ordering: Object.freeze({ stable: ordering.stable, keys: Object.freeze(orderingKeys) }),
    freshness: Object.freeze({
      observedAt,
      ...(staleAfter === undefined ? {} : { staleAfter }),
      ...(validator === undefined ? {} : { validator }),
      ...(generation === undefined ? {} : { generation }),
    }),
  });
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

function normalizeBuffer(
  buffer: ColumnarBufferV1,
  index: number,
  usage: NormalizationUsage,
  limits: ResolvedLimits,
): ColumnarBufferV1 {
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
  const field = rawField === undefined ? undefined : requireIdentifier(rawField, `${label}.field`, usage, limits);
  return Object.freeze({
    id: requireIdentifier(id, `${label}.id`, usage, limits),
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

function normalizeBatchInput(input: CreateColumnarBatchInput, limits: ResolvedLimits): ColumnarBatchV1 {
  if (typeof input !== "object" || input === null) invalid("batch input must be an object");
  const id = input.id;
  const rawSchema = input.schema;
  const rawRowCount = input.rowCount;
  const rawSequence = input.sequence;
  const rawRowOffset = input.rowOffset;
  const rawIdentity = input.identity;
  const rawBuffers = input.buffers;
  if (!Array.isArray(rawBuffers)) invalid("buffers must be an array");
  const usage = createUsage();
  const bufferCount = rawBuffers.length;
  if (bufferCount > limits.maxBufferViews) {
    throw new HonuaColumnarTransferError(
      "buffer-view-limit-exceeded",
      `buffers exceeds the configured ${limits.maxBufferViews}-entry limit`,
    );
  }
  consumeCount(usage, "bufferViews", bufferCount, limits.maxBufferViews, "buffer-view-limit-exceeded", "buffers");
  const schema = normalizeSchema(rawSchema, usage, limits);
  const rowCount = requireSafeNonNegativeInteger(rawRowCount, "rowCount");
  const sequence = requireSafeNonNegativeInteger(rawSequence, "sequence");
  const rowOffset = rawRowOffset === undefined ? undefined : requireSafeNonNegativeInteger(rawRowOffset, "rowOffset");
  assertRowRange(rowOffset, rowCount);
  const identity = normalizeBatchIdentity(rawIdentity, schema, usage, limits);
  const ids = new Set<string>();
  const buffers: ColumnarBufferV1[] = [];
  for (let index = 0; index < bufferCount; index += 1) {
    const normalized = normalizeBuffer(rawBuffers[index]!, index, usage, limits);
    if (ids.has(normalized.id)) invalid(`buffers has duplicate id ${normalized.id}`);
    ids.add(normalized.id);
    buffers.push(normalized);
  }
  assertBufferFields(buffers, schema);
  const batch = Object.freeze({
    kind: COLUMNAR_BATCH_KIND,
    version: COLUMNAR_BATCH_VERSION,
    id: requireIdentifier(id, "id", usage, limits),
    schema,
    rowCount,
    sequence,
    ...(rowOffset === undefined ? {} : { rowOffset }),
    ...(identity === undefined ? {} : { identity }),
    buffers: Object.freeze(buffers),
  });
  trustedBatches.add(batch);
  trustedBatchUsage.set(batch, Object.freeze({ ...usage }));
  return batch;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaColumnarTransferError("aborted", "Columnar transfer was aborted");
}

function inspectTrusted(batch: ColumnarBatchV1, limits: ResolvedLimits): Inspection {
  const usage = trustedBatchUsage.get(batch);
  if (!usage) invalid("trusted batch normalization accounting is unavailable");
  if (usage.schemaNodes > limits.maxSchemaNodes) {
    throw new HonuaColumnarTransferError(
      "schema-limit-exceeded",
      `Columnar batch has ${usage.schemaNodes} schema fields; the limit is ${limits.maxSchemaNodes}`,
    );
  }
  if (usage.metadataEntries > limits.maxMetadataEntries) {
    throw new HonuaColumnarTransferError(
      "metadata-limit-exceeded",
      `Columnar batch has ${usage.metadataEntries} metadata entries; the limit is ${limits.maxMetadataEntries}`,
    );
  }
  if (usage.bufferViews > limits.maxBufferViews) {
    throw new HonuaColumnarTransferError(
      "buffer-view-limit-exceeded",
      `Columnar batch has ${usage.bufferViews} buffer views; the limit is ${limits.maxBufferViews}`,
    );
  }
  if (usage.stringBytes > limits.maxStringBytes) {
    throw new HonuaColumnarTransferError(
      "string-limit-exceeded",
      `Columnar batch has ${usage.stringBytes} descriptor string bytes; the limit is ${limits.maxStringBytes}`,
    );
  }
  if (batch.rowCount > limits.maxRows) {
    throw new HonuaColumnarTransferError(
      "row-limit-exceeded",
      `Columnar batch has ${batch.rowCount} rows; the limit is ${limits.maxRows}`,
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
  if (backingBytes > limits.maxBackingBytes) {
    throw new HonuaColumnarTransferError(
      "memory-limit-exceeded",
      `Columnar batch owns ${backingBytes} backing bytes; the limit is ${limits.maxBackingBytes}`,
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
    const resolvedLimits = resolveLimits(limits);
    if (typeof batch !== "object" || batch === null) invalid("batch must be an object");
    const kind = batch.kind;
    const version = batch.version;
    if (kind !== COLUMNAR_BATCH_KIND || version !== COLUMNAR_BATCH_VERSION) {
      invalid(`batch must be ${COLUMNAR_BATCH_KIND}@${COLUMNAR_BATCH_VERSION}`);
    }
    const snapshot = trustedBatches.has(batch) ? batch : normalizeBatchInput(batch, resolvedLimits);
    return inspectTrusted(snapshot, resolvedLimits);
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
    const resolvedLimits = resolveLimits(limits);
    const batch = normalizeBatchInput(input, resolvedLimits);
    inspectTrusted(batch, resolvedLimits);
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
  readonly #limits: ResolvedLimits;
  readonly #reservedBuffers: readonly ArrayBuffer[];

  public constructor(batch: ColumnarBatchV1, limits: ColumnarBatchLimits = {}) {
    const resolvedLimits = resolveLimits(limits);
    let snapshot: ColumnarBatchV1;
    if (trustedBatches.has(batch)) snapshot = batch;
    else {
      snapshot = invalidBoundary(() => {
        if (typeof batch !== "object" || batch === null) invalid("batch must be an object");
        const kind = batch.kind;
        const version = batch.version;
        if (kind !== COLUMNAR_BATCH_KIND || version !== COLUMNAR_BATCH_VERSION) {
          invalid(`batch must be ${COLUMNAR_BATCH_KIND}@${COLUMNAR_BATCH_VERSION}`);
        }
        return normalizeBatchInput(batch, resolvedLimits);
      });
    }
    const inspection = inspectTrusted(snapshot, resolvedLimits);
    for (const buffer of inspection.transfer) {
      if (leasedBuffers.has(buffer)) {
        throw new HonuaColumnarTransferError(
          "already-leased",
          "A backing buffer is already owned by another columnar batch lease",
        );
      }
    }
    this.#batch = snapshot;
    this.#limits = resolvedLimits;
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
      maxSchemaNodes: options.maxSchemaNodes ?? this.#limits.maxSchemaNodes,
      maxMetadataEntries: options.maxMetadataEntries ?? this.#limits.maxMetadataEntries,
      maxBufferViews: options.maxBufferViews ?? this.#limits.maxBufferViews,
      maxStringBytes: options.maxStringBytes ?? this.#limits.maxStringBytes,
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
