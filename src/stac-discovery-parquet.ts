export type GeoParquetFooterInspection =
  | Readonly<{ state: "incomplete" }>
  | Readonly<{ state: "invalid" }>
  | Readonly<{ state: "parquet" }>
  | Readonly<{ state: "geoparquet"; version: string; primaryColumn: string }>;

const COMPACT_STOP = 0;
const COMPACT_BOOLEAN_TRUE = 1;
const COMPACT_BOOLEAN_FALSE = 2;
const COMPACT_BYTE = 3;
const COMPACT_I16 = 4;
const COMPACT_I32 = 5;
const COMPACT_I64 = 6;
const COMPACT_DOUBLE = 7;
const COMPACT_BINARY = 8;
const COMPACT_LIST = 9;
const COMPACT_SET = 10;
const COMPACT_MAP = 11;
const COMPACT_STRUCT = 12;
const COMPACT_UUID = 13;
const MAX_COMPACT_NODES = 50_000;
const MAX_COMPACT_DEPTH = 32;
const MAX_KEY_VALUES = 4_096;
const MAX_GEOMETRY_COLUMNS = 1_024;
const MAX_GEOMETRY_TYPES = 32;
const MAX_COLUMN_NAME_LENGTH = 1_024;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const GEOPARQUET_1_1_ENCODINGS = new Set([
  "WKB",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
]);
const GEOMETRY_TYPE = /^(?:GeometryCollection|(?:Multi)?(?:Point|LineString|Polygon))(?: Z)?$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Inspect a complete bounded Parquet footer without guessing from raw text. */
export function inspectGeoParquetFooter(bytes: Uint8Array, totalBytes: number): GeoParquetFooterInspection {
  if (bytes.byteLength < 8 || ascii(bytes.subarray(bytes.byteLength - 4)) !== "PAR1") {
    return Object.freeze({ state: "invalid" });
  }
  const footerLengthOffset = bytes.byteLength - 8;
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset + footerLengthOffset, 4).getUint32(0, true);
  if (metadataLength === 0) return Object.freeze({ state: "invalid" });
  if (metadataLength + 8 > totalBytes) return Object.freeze({ state: "invalid" });
  if (metadataLength > footerLengthOffset) return Object.freeze({ state: "incomplete" });
  const metadata = bytes.subarray(footerLengthOffset - metadataLength, footerLengthOffset);
  let geoValue: string | undefined;
  try {
    geoValue = parseFileMetadata(metadata);
  } catch {
    return Object.freeze({ state: "invalid" });
  }
  if (geoValue === undefined) return Object.freeze({ state: "parquet" });
  const profile = parseGeoParquetProfile(geoValue);
  return profile ?? Object.freeze({ state: "parquet" });
}

export function hasParquetHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && ascii(bytes.subarray(0, 4)) === "PAR1";
}

function parseFileMetadata(bytes: Uint8Array): string | undefined {
  const reader = new CompactReader(bytes);
  const seen = new Set<number>();
  let lastFieldId = 0;
  let version: bigint | undefined;
  let schemaSeen = false;
  let rowCount: bigint | undefined;
  let rowGroupsSeen = false;
  let geoValue: string | undefined;
  while (true) {
    const field = reader.readField(lastFieldId);
    if (!field) break;
    lastFieldId = field.id;
    if (seen.has(field.id)) throw new Error("duplicate-field");
    seen.add(field.id);
    if (field.id === 1) {
      if (field.type !== COMPACT_I32) throw new Error("invalid-version");
      version = reader.readZigzagInteger();
    } else if (field.id === 2) {
      if (field.type !== COMPACT_LIST) throw new Error("invalid-schema");
      schemaSeen = true;
      reader.skipValue(field.type, true, 0);
    } else if (field.id === 3) {
      if (field.type !== COMPACT_I64) throw new Error("invalid-row-count");
      rowCount = reader.readZigzagInteger();
    } else if (field.id === 4) {
      if (field.type !== COMPACT_LIST) throw new Error("invalid-row-groups");
      rowGroupsSeen = true;
      reader.skipValue(field.type, true, 0);
    } else if (field.id === 5) {
      if (field.type !== COMPACT_LIST) throw new Error("invalid-key-values");
      geoValue = readKeyValues(reader);
    } else {
      reader.skipValue(field.type, true, 0);
    }
  }
  if (
    !reader.atEnd() ||
    version === undefined ||
    version < 1n ||
    !schemaSeen ||
    rowCount === undefined ||
    rowCount < 0n ||
    !rowGroupsSeen
  ) {
    throw new Error("incomplete-file-metadata");
  }
  return geoValue;
}

function readKeyValues(reader: CompactReader): string | undefined {
  const list = reader.readListHeader();
  if (list.elementType !== COMPACT_STRUCT || list.size > MAX_KEY_VALUES) throw new Error("invalid-key-values");
  let geoValue: string | undefined;
  for (let index = 0; index < list.size; index += 1) {
    const entry = readKeyValue(reader);
    if (entry.key !== "geo") continue;
    if (geoValue !== undefined || entry.value === undefined) throw new Error("invalid-geo-key");
    geoValue = entry.value;
  }
  return geoValue;
}

function readKeyValue(reader: CompactReader): { readonly key: string; readonly value?: string } {
  let lastFieldId = 0;
  let key: string | undefined;
  let value: string | undefined;
  const seen = new Set<number>();
  while (true) {
    const field = reader.readField(lastFieldId);
    if (!field) break;
    lastFieldId = field.id;
    if (seen.has(field.id)) throw new Error("duplicate-key-value-field");
    seen.add(field.id);
    if (field.id === 1 || field.id === 2) {
      if (field.type !== COMPACT_BINARY) throw new Error("invalid-key-value-string");
      const text = UTF8.decode(reader.readBinary());
      if (field.id === 1) key = text;
      else value = text;
    } else {
      reader.skipValue(field.type, true, 1);
    }
  }
  if (key === undefined) throw new Error("missing-key");
  return Object.freeze({ key, ...(value !== undefined ? { value } : {}) });
}

function parseGeoParquetProfile(value: string): GeoParquetFooterInspection | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || !isSafeJson(parsed)) return undefined;
  const version = parsed.version;
  const primaryColumn = parsed.primary_column;
  const columns = parsed.columns;
  if (
    typeof version !== "string" ||
    !/^1\.(?:0|1)\.\d+$/.test(version) ||
    typeof primaryColumn !== "string" ||
    !primaryColumn ||
    primaryColumn.length > MAX_COLUMN_NAME_LENGTH ||
    !isPlainObject(columns) ||
    !validGeoParquetColumns(columns, version)
  ) {
    return undefined;
  }
  if (!Object.hasOwn(columns, primaryColumn)) return undefined;
  return Object.freeze({ state: "geoparquet", version, primaryColumn });
}

function validGeoParquetColumns(columns: Record<string, unknown>, version: string): boolean {
  const entries = Object.entries(columns);
  if (entries.length === 0 || entries.length > MAX_GEOMETRY_COLUMNS) return false;
  for (const [name, value] of entries) {
    if (!name || name.length > MAX_COLUMN_NAME_LENGTH || !isPlainObject(value)) return false;
    const encoding = value.encoding;
    const geometryTypes = value.geometry_types;
    if (
      typeof encoding !== "string" ||
      (version.startsWith("1.0.") ? encoding !== "WKB" : !GEOPARQUET_1_1_ENCODINGS.has(encoding)) ||
      !validGeometryTypes(geometryTypes)
    ) {
      return false;
    }
  }
  return true;
}

function validGeometryTypes(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_GEOMETRY_TYPES) return false;
  const unique = new Set<string>();
  for (const geometryType of value) {
    if (typeof geometryType !== "string" || !GEOMETRY_TYPE.test(geometryType) || unique.has(geometryType)) {
      return false;
    }
    unique.add(geometryType);
  }
  return true;
}

function isSafeJson(root: unknown): boolean {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_COMPACT_NODES || current.depth > MAX_COMPACT_DEPTH) return false;
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isPlainObject(current.value)) return false;
    for (const [key, child] of Object.entries(current.value)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ascii(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.byteLength; index += 1) output += String.fromCharCode(bytes[index]!);
  return output;
}

class CompactReader {
  private offset = 0;
  private nodes = 0;

  public constructor(private readonly bytes: Uint8Array) {}

  public atEnd(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  public readField(lastFieldId: number): { readonly id: number; readonly type: number } | undefined {
    this.countNode();
    const header = this.readByte();
    if (header === COMPACT_STOP) return undefined;
    const type = header & 0x0f;
    this.assertType(type);
    const delta = header >>> 4;
    const id = delta === 0 ? this.readFieldId() : lastFieldId + delta;
    if (id <= 0 || id > 32_767) throw new Error("invalid-field-id");
    return Object.freeze({ id, type });
  }

  public readZigzagInteger(): bigint {
    const value = this.readUnsignedVarint();
    return (value >> 1n) ^ -(value & 1n);
  }

  public readBinary(): Uint8Array {
    const length = this.readLength();
    return this.readBytes(length);
  }

  public readListHeader(): { readonly size: number; readonly elementType: number } {
    this.countNode();
    const header = this.readByte();
    const inlineSize = header >>> 4;
    const size = inlineSize === 15 ? this.readLength() : inlineSize;
    const elementType = header & 0x0f;
    if (size > 0) this.assertType(elementType);
    return Object.freeze({ size, elementType });
  }

  public skipValue(type: number, fieldValue: boolean, depth: number): void {
    this.countNode();
    if (depth > MAX_COMPACT_DEPTH) throw new Error("compact-depth");
    if (type === COMPACT_BOOLEAN_TRUE || type === COMPACT_BOOLEAN_FALSE) {
      if (!fieldValue) {
        const value = this.readByte();
        if (value !== COMPACT_BOOLEAN_TRUE && value !== COMPACT_BOOLEAN_FALSE) throw new Error("invalid-boolean");
      }
      return;
    }
    if (type === COMPACT_BYTE) {
      this.readByte();
      return;
    }
    if (type === COMPACT_I16 || type === COMPACT_I32 || type === COMPACT_I64) {
      this.readUnsignedVarint();
      return;
    }
    if (type === COMPACT_DOUBLE) {
      this.readBytes(8);
      return;
    }
    if (type === COMPACT_BINARY) {
      this.readBinary();
      return;
    }
    if (type === COMPACT_LIST || type === COMPACT_SET) {
      const list = this.readListHeader();
      for (let index = 0; index < list.size; index += 1) this.skipValue(list.elementType, false, depth + 1);
      return;
    }
    if (type === COMPACT_MAP) {
      const size = this.readLength();
      if (size === 0) return;
      const types = this.readByte();
      const keyType = types >>> 4;
      const valueType = types & 0x0f;
      this.assertType(keyType);
      this.assertType(valueType);
      for (let index = 0; index < size; index += 1) {
        this.skipValue(keyType, false, depth + 1);
        this.skipValue(valueType, false, depth + 1);
      }
      return;
    }
    if (type === COMPACT_STRUCT) {
      let lastFieldId = 0;
      while (true) {
        const field = this.readField(lastFieldId);
        if (!field) break;
        lastFieldId = field.id;
        this.skipValue(field.type, true, depth + 1);
      }
      return;
    }
    if (type === COMPACT_UUID) {
      this.readBytes(16);
      return;
    }
    throw new Error("unsupported-compact-type");
  }

  private readFieldId(): number {
    const value = this.readZigzagInteger();
    if (value < 1n || value > 32_767n) throw new Error("invalid-field-id");
    return Number(value);
  }

  private readLength(): number {
    const value = this.readUnsignedVarint();
    if (value > BigInt(this.bytes.byteLength - this.offset) || value > BigInt(MAX_COMPACT_NODES)) {
      throw new Error("invalid-length");
    }
    return Number(value);
  }

  private readUnsignedVarint(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte();
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("invalid-varint");
  }

  private readByte(): number {
    if (this.offset >= this.bytes.byteLength) throw new Error("unexpected-end");
    return this.bytes[this.offset++]!;
  }

  private readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new Error("unexpected-end");
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private assertType(type: number): void {
    if (type < COMPACT_BOOLEAN_TRUE || type > COMPACT_UUID) throw new Error("invalid-compact-type");
  }

  private countNode(): void {
    this.nodes += 1;
    if (this.nodes > MAX_COMPACT_NODES) throw new Error("compact-node-limit");
  }
}
