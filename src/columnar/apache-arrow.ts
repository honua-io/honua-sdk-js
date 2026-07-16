import {
  type ApacheArrowAdapterMetrics,
  type ApacheArrowAdapterOptions,
  type ApacheArrowDataLike,
  type ApacheArrowFieldLike,
  type ApacheArrowModuleLike,
  type ApacheArrowRecordBatchLike,
  type ApacheArrowRecordBatchResult,
  type ApacheArrowVectorLike,
  type FromApacheArrowRecordBatchOptions,
  GEOARROW_SPEC_VERSION,
  type GeoArrowBatchFromApacheResult,
  type GeoArrowBatchInspection,
  type GeoArrowConversionLimits,
  type GeoArrowDimensions,
  type GeoArrowTimestampUnit,
  HONUA_GEOARROW_LAYOUT_VERSION,
  HonuaGeoArrowError,
  type LoadApacheArrowOptions,
} from "./geoarrow-types.js";
import { inspectGeoArrowBatch } from "./geoarrow.js";
import { createColumnarBatch, inspectColumnarBatch } from "./transfer.js";
import {
  type ColumnarBatchIdentityV1,
  type ColumnarBatchV1,
  type ColumnarBufferV1,
  type ColumnarFieldV1,
  type ColumnarSchemaV1,
  DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
  DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES,
  DEFAULT_COLUMNAR_BATCH_MAX_SCHEMA_NODES,
  DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES,
} from "./types.js";

const APACHE_ARROW_PACKAGE = "apache-arrow";
const MAX_ARROW_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_ARROW_METADATA_DEPTH = 64;
const MAX_ARROW_METADATA_NODES = 65_536;
const REQUIRED_EXPORTS = Object.freeze([
  "Dictionary",
  "Field",
  "FixedSizeList",
  "Float64",
  "Int32",
  "List",
  "RecordBatch",
  "Schema",
  "Struct",
  "TimestampMicrosecond",
  "TimestampMillisecond",
  "TimestampNanosecond",
  "TimestampSecond",
  "Uint32",
  "Utf8",
  "makeData",
  "makeVector",
]);

const TRANSPORT_META = Object.freeze({
  batchId: "honua.columnar.batch.id",
  sequence: "honua.columnar.batch.sequence",
  rowOffset: "honua.columnar.batch.row-offset",
  schema: "honua.columnar.schema.json",
  identity: "honua.columnar.identity.json",
});

const LAYOUT_META = Object.freeze({
  version: "honua.geoarrow.layout.version",
  specVersion: "honua.geoarrow.spec.version",
  geometryField: "honua.geoarrow.geometry.field",
  geometryKind: "honua.geoarrow.geometry.kind",
  dimensions: "honua.geoarrow.geometry.dimensions",
  coordinateLayout: "honua.geoarrow.geometry.coordinate-layout",
  temporalField: "honua.geoarrow.temporal.field",
  temporalUnit: "honua.geoarrow.temporal.unit",
  temporalTimezone: "honua.geoarrow.temporal.timezone",
  dictionaryField: "honua.geoarrow.dictionary.field",
  dictionaryOrdered: "honua.geoarrow.dictionary.ordered",
  featureIdField: "honua.geoarrow.feature-id.field",
});

const defaultImportModule = (specifier: string): Promise<unknown> => import(specifier);

function fail(
  code: ConstructorParameters<typeof HonuaGeoArrowError>[0],
  message: string,
  detail?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): never {
  throw new HonuaGeoArrowError(code, message, detail, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function validateModule(module: unknown): ApacheArrowModuleLike {
  if (!isRecord(module)) {
    fail("missing-peer", `The optional peer "${APACHE_ARROW_PACKAGE}" did not expose a module namespace.`, {
      package: APACHE_ARROW_PACKAGE,
    });
  }
  for (const name of REQUIRED_EXPORTS) {
    if (typeof module[name] !== "function") {
      fail("missing-peer", `The loaded "${APACHE_ARROW_PACKAGE}" module does not export ${name}.`, {
        package: APACHE_ARROW_PACKAGE,
        export: name,
      });
    }
  }
  return module;
}

/** Load Apache Arrow only when its adapter is explicitly requested. */
export async function loadApacheArrow(options: LoadApacheArrowOptions = {}): Promise<ApacheArrowModuleLike> {
  let module: unknown;
  try {
    module = await (options.importModule ?? defaultImportModule)(APACHE_ARROW_PACKAGE);
  } catch (cause) {
    fail(
      "missing-peer",
      `The GeoArrow adapter requires the optional peer "${APACHE_ARROW_PACKAGE}". Install it or inject a module.`,
      { package: APACHE_ARROW_PACKAGE },
      cause,
    );
  }
  return validateModule(module);
}

function construct(module: ApacheArrowModuleLike, name: string, args: readonly unknown[]): object {
  const ctor = module[name];
  if (typeof ctor !== "function") fail("missing-peer", `Apache Arrow export ${name} is unavailable.`);
  try {
    return Reflect.construct(ctor, args);
  } catch (cause) {
    fail("unsupported-layout", `Apache Arrow failed to construct ${name}.`, { export: name }, cause);
  }
}

function invoke(module: ApacheArrowModuleLike, name: string, args: readonly unknown[]): unknown {
  const operation = module[name];
  if (typeof operation !== "function") fail("missing-peer", `Apache Arrow export ${name} is unavailable.`);
  try {
    return Reflect.apply(operation, module, args);
  } catch (cause) {
    fail("unsupported-layout", `Apache Arrow ${name} rejected the normative layout.`, { export: name }, cause);
  }
}

function mapOf(record: Readonly<Record<string, string>> | undefined): Map<string, string> {
  return new Map(Object.entries(record ?? {}));
}

function data(module: ApacheArrowModuleLike, props: Readonly<Record<string, unknown>>): ApacheArrowDataLike {
  return invoke(module, "makeData", [props]) as ApacheArrowDataLike;
}

function field(
  module: ApacheArrowModuleLike,
  name: string,
  type: object,
  nullable: boolean,
  metadata?: Readonly<Record<string, string>>,
): object {
  return construct(module, "Field", [name, type, nullable, mapOf(metadata)]);
}

function dimensionNames(dimensions: GeoArrowDimensions): readonly ("x" | "y" | "z" | "m")[] {
  switch (dimensions) {
    case "xy":
      return ["x", "y"];
    case "xyz":
      return ["x", "y", "z"];
    case "xym":
      return ["x", "y", "m"];
    case "xyzm":
      return ["x", "y", "z", "m"];
    default:
      fail("unsupported-layout", `Unsupported GeoArrow dimensions "${String(dimensions)}".`);
  }
}

interface ArrowTypedNode {
  readonly type: object;
  readonly data: ApacheArrowDataLike;
}

function coordinateNode(
  module: ApacheArrowModuleLike,
  inspection: GeoArrowBatchInspection,
  nullBitmap?: Uint8Array,
): ArrowTypedNode {
  const geometry = inspection.geometry;
  const names = dimensionNames(geometry.dimensions);
  const floatType = construct(module, "Float64", []);
  if (geometry.coordinateLayout === "interleaved") {
    const child = data(module, {
      type: floatType,
      length: geometry.coordinates.interleaved!.length,
      data: geometry.coordinates.interleaved,
    });
    const type = construct(module, "FixedSizeList", [names.length, field(module, names.join(""), floatType, false)]);
    return Object.freeze({
      type,
      data: data(module, {
        type,
        length: inspection.metrics.vertices,
        child,
        ...(nullBitmap === undefined ? {} : { nullBitmap }),
      }),
    });
  }
  const fields = names.map((name) => field(module, name, floatType, false));
  const type = construct(module, "Struct", [fields]);
  return Object.freeze({
    type,
    data: data(module, {
      type,
      length: inspection.metrics.vertices,
      children: names.map((name) =>
        data(module, { type: floatType, length: inspection.metrics.vertices, data: geometry.coordinates[name] }),
      ),
      ...(nullBitmap === undefined ? {} : { nullBitmap }),
    }),
  });
}

function geometryNode(module: ApacheArrowModuleLike, inspection: GeoArrowBatchInspection): ArrowTypedNode {
  const geometry = inspection.geometry;
  if (geometry.kind === "point") return coordinateNode(module, inspection, geometry.validity);
  const coordinate = coordinateNode(module, inspection);
  const verticesType = construct(module, "List", [field(module, "vertices", coordinate.type, false)]);
  if (geometry.kind === "linestring") {
    return Object.freeze({
      type: verticesType,
      data: data(module, {
        type: verticesType,
        length: inspection.batch.rowCount,
        valueOffsets: geometry.offsets,
        child: coordinate.data,
        ...(geometry.validity === undefined ? {} : { nullBitmap: geometry.validity }),
      }),
    });
  }
  const rings = data(module, {
    type: verticesType,
    length: inspection.metrics.rings,
    valueOffsets: geometry.ringOffsets,
    child: coordinate.data,
  });
  const polygonType = construct(module, "List", [field(module, "rings", verticesType, false)]);
  return Object.freeze({
    type: polygonType,
    data: data(module, {
      type: polygonType,
      length: inspection.batch.rowCount,
      valueOffsets: geometry.offsets,
      child: rings,
      ...(geometry.validity === undefined ? {} : { nullBitmap: geometry.validity }),
    }),
  });
}

function timestampType(module: ApacheArrowModuleLike, unit: GeoArrowTimestampUnit, timezone?: string): object {
  const name =
    unit === "second"
      ? "TimestampSecond"
      : unit === "millisecond"
        ? "TimestampMillisecond"
        : unit === "microsecond"
          ? "TimestampMicrosecond"
          : "TimestampNanosecond";
  return construct(module, name, [timezone ?? null]);
}

function sourceField(batch: ColumnarBatchV1, name: string): ColumnarFieldV1 {
  const result = batch.schema.fields.find((candidate) => candidate.name === name);
  if (!result) fail("invalid-batch", `Columnar schema field "${name}" is missing.`);
  return result;
}

function transportMetadata(batch: ColumnarBatchV1): Map<string, string> {
  const metadata = mapOf(batch.schema.metadata);
  metadata.set(TRANSPORT_META.batchId, batch.id);
  metadata.set(TRANSPORT_META.sequence, String(batch.sequence));
  if (batch.rowOffset !== undefined) metadata.set(TRANSPORT_META.rowOffset, String(batch.rowOffset));
  metadata.set(TRANSPORT_META.schema, JSON.stringify(batch.schema));
  metadata.set(TRANSPORT_META.identity, JSON.stringify(batch.identity));
  return metadata;
}

/**
 * Wrap a validated Honua batch as a real Apache Arrow RecordBatch. Every Arrow
 * data node aliases the Honua buffers; no geometry, attribute, or validity
 * payload is copied.
 */
export async function toApacheArrowRecordBatch(
  batch: ColumnarBatchV1,
  options: ApacheArrowAdapterOptions = {},
): Promise<ApacheArrowRecordBatchResult> {
  const module = options.module ? validateModule(options.module) : await loadApacheArrow(options);
  const inspection = inspectGeoArrowBatch(batch);
  const arrowFields: object[] = [];
  const arrowData: ApacheArrowDataLike[] = [];

  const geometry = geometryNode(module, inspection);
  const geometrySchemaField = sourceField(batch, inspection.geometry.field);
  arrowFields.push(
    field(module, inspection.geometry.field, geometry.type, geometrySchemaField.nullable, geometrySchemaField.metadata),
  );
  arrowData.push(geometry.data);

  if (inspection.temporal) {
    const source = sourceField(batch, inspection.temporal.field);
    const type = timestampType(module, inspection.temporal.unit, inspection.temporal.timezone);
    arrowFields.push(field(module, inspection.temporal.field, type, source.nullable, source.metadata));
    arrowData.push(
      data(module, {
        type,
        length: batch.rowCount,
        data: inspection.temporal.values,
        ...(inspection.temporal.validity === undefined ? {} : { nullBitmap: inspection.temporal.validity }),
      }),
    );
  }

  if (inspection.dictionary) {
    const source = sourceField(batch, inspection.dictionary.field);
    const utf8 = construct(module, "Utf8", []);
    const dictionaryData = data(module, {
      type: utf8,
      length: inspection.dictionary.offsets.length - 1,
      valueOffsets: inspection.dictionary.offsets,
      data: inspection.dictionary.values,
    });
    const dictionaryVector = invoke(module, "makeVector", [dictionaryData]);
    const type = construct(module, "Dictionary", [
      utf8,
      construct(module, "Int32", []),
      0,
      inspection.dictionary.ordered,
    ]);
    arrowFields.push(field(module, inspection.dictionary.field, type, source.nullable, source.metadata));
    arrowData.push(
      data(module, {
        type,
        length: batch.rowCount,
        data: inspection.dictionary.indices,
        dictionary: dictionaryVector,
        ...(inspection.dictionary.validity === undefined ? {} : { nullBitmap: inspection.dictionary.validity }),
      }),
    );
  }

  if (inspection.featureIds) {
    const source = sourceField(batch, inspection.featureIds.field);
    const type = construct(module, "Uint32", []);
    arrowFields.push(field(module, inspection.featureIds.field, type, source.nullable, source.metadata));
    arrowData.push(data(module, { type, length: batch.rowCount, data: inspection.featureIds.values }));
  }

  const schema = construct(module, "Schema", [arrowFields, transportMetadata(batch)]);
  const structType = construct(module, "Struct", [arrowFields]);
  const structData = data(module, { type: structType, length: batch.rowCount, children: arrowData });
  const recordBatch = construct(module, "RecordBatch", [schema, structData]) as ApacheArrowRecordBatchLike;
  if (recordBatch.numRows !== batch.rowCount) fail("invalid-batch", "Apache Arrow changed the RecordBatch row count.");
  const metrics = inspectColumnarBatch(batch);
  return Object.freeze({
    recordBatch,
    metrics: Object.freeze({
      rows: batch.rowCount,
      backingBytes: metrics.backingBytes,
      referencedBytes: metrics.logicalBytes,
      copiedBytes: 0,
    }),
  });
}

function requireMap(value: unknown, label: string): ReadonlyMap<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as ReadonlyMap<string, string>).get !== "function" ||
    !Number.isSafeInteger((value as ReadonlyMap<string, string>).size) ||
    (value as ReadonlyMap<string, string>).size < 0
  ) {
    fail("invalid-batch", `${label} must be an Arrow metadata Map.`);
  }
  return value as ReadonlyMap<string, string>;
}

function mapValue(metadata: ReadonlyMap<string, string>, key: string): string | undefined {
  const value = metadata.get(key);
  if (value !== undefined && typeof value !== "string")
    fail("invalid-batch", `Arrow metadata "${key}" must be a string.`);
  return value;
}

function requiredMapValue(metadata: ReadonlyMap<string, string>, key: string): string {
  const value = mapValue(metadata, key);
  if (value === undefined) fail("invalid-batch", `Arrow schema metadata is missing "${key}".`, { key });
  return value;
}

function positiveMetadataLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    fail("invalid-input", `${label} must be a positive safe integer.`);
  }
  return resolved;
}

function assertBoundedUtf8(value: string, limit: number, label: string): void {
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
    if (bytes > limit) fail("invalid-batch", `${label} exceeds the ${limit}-byte metadata limit.`);
  }
}

function parseJson<T>(encoded: string, label: string, limits: GeoArrowConversionLimits): T {
  const maxBytes = Math.min(
    positiveMetadataLimit(limits.maxStringBytes, DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES, "maxStringBytes"),
    MAX_ARROW_METADATA_BYTES,
  );
  const maxNodes = Math.min(
    positiveMetadataLimit(
      limits.maxMetadataEntries,
      DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES,
      "maxMetadataEntries",
    ) + positiveMetadataLimit(limits.maxSchemaNodes, DEFAULT_COLUMNAR_BATCH_MAX_SCHEMA_NODES, "maxSchemaNodes"),
    MAX_ARROW_METADATA_NODES,
  );
  assertBoundedUtf8(encoded, maxBytes, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch (cause) {
    fail("invalid-batch", `${label} is not valid JSON.`, undefined, cause);
  }
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: parsed, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > maxNodes) fail("invalid-batch", `${label} exceeds the ${maxNodes}-node metadata limit.`);
    if (current.depth > MAX_ARROW_METADATA_DEPTH) {
      fail("invalid-batch", `${label} exceeds the ${MAX_ARROW_METADATA_DEPTH}-level metadata depth limit.`);
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const child of Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return parsed as T;
}

function parseInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    fail("invalid-batch", `${label} must be a non-negative safe integer.`);
  return parsed;
}

function typeString(field: unknown, label: string): string {
  if (!isRecord(field) || !isRecord(field.type) || typeof field.type.toString !== "function") {
    fail("invalid-batch", `${label} must expose an Arrow type.`);
  }
  try {
    const value = field.type.toString();
    if (typeof value !== "string" || value.length === 0) fail("invalid-batch", `${label} Arrow type is empty.`);
    return value;
  } catch (cause) {
    if (cause instanceof HonuaGeoArrowError) throw cause;
    fail("invalid-batch", `${label} Arrow type could not be inspected.`, undefined, cause);
  }
}

function typeChildren(field: ApacheArrowFieldLike, label: string): readonly ApacheArrowFieldLike[] {
  const children = field.type.children;
  if (!Array.isArray(children)) fail("invalid-batch", `${label} Arrow type must expose its child fields.`);
  return children;
}

function requireArrowLeaf(field: ApacheArrowFieldLike, expectedType: string, label: string): void {
  if (field.nullable || typeString(field, label) !== expectedType) {
    fail("invalid-batch", `${label} must be a non-nullable ${expectedType} Arrow field.`);
  }
  if (field.type.children != null && (!Array.isArray(field.type.children) || field.type.children.length !== 0)) {
    fail("invalid-batch", `${label} must not contain Arrow child fields.`);
  }
}

interface InferredCoordinate {
  readonly dimensions: GeoArrowDimensions;
  readonly coordinateLayout: "interleaved" | "separated";
  readonly schema: ColumnarFieldV1;
}

function inferCoordinate(field: ApacheArrowFieldLike, label: string): InferredCoordinate {
  const actualType = typeString(field, label);
  const children = typeChildren(field, label);
  if (actualType.startsWith("FixedSizeList[")) {
    if (children.length !== 1) fail("invalid-batch", `${label} interleaved coordinates need one child field.`);
    const values = children[0]!;
    const dimensions = values.name as GeoArrowDimensions;
    const names = dimensionNames(dimensions);
    requireArrowLeaf(values, "Float64", `${label}.${values.name}`);
    if (values.name !== names.join("") || actualType !== `FixedSizeList[${names.length}]<Float64>`) {
      fail("invalid-batch", `${label} interleaved coordinate dimensions do not match its fixed-size list.`);
    }
    return Object.freeze({
      dimensions,
      coordinateLayout: "interleaved",
      schema: {
        name: values.name,
        type: { name: "fixed_size_list", parameters: { size: names.length, valueType: "float64" } },
        nullable: false,
        children: [{ name: "values", type: { name: "float64" }, nullable: false }],
      },
    });
  }
  if (!actualType.startsWith("Struct<")) {
    fail("unsupported-layout", `${label} must use separated Struct or interleaved FixedSizeList coordinates.`);
  }
  const joined = children.map(({ name }) => name).join("");
  const dimensions = joined as GeoArrowDimensions;
  const names = dimensionNames(dimensions);
  if (children.length !== names.length || children.some((child, index) => child.name !== names[index])) {
    fail("invalid-batch", `${label} separated coordinate dimensions are not in normative x/y/z/m order.`);
  }
  children.forEach((child) => requireArrowLeaf(child, "Float64", `${label}.${child.name}`));
  const expected = `Struct<{${names.map((name) => `${name}:Float64`).join(", ")}}>`;
  if (actualType !== expected) fail("invalid-batch", `${label} separated coordinate type is malformed.`);
  return Object.freeze({
    dimensions,
    coordinateLayout: "separated",
    schema: {
      name: "coordinates",
      type: { name: "struct", parameters: { dimensions } },
      nullable: false,
      children: names.map((name) => ({ name, type: { name: "float64" }, nullable: false })),
    },
  });
}

interface InferredGeometry {
  readonly kind: "point" | "linestring" | "polygon";
  readonly dimensions: GeoArrowDimensions;
  readonly coordinateLayout: "interleaved" | "separated";
  readonly field: ColumnarFieldV1;
}

function inferGeometry(field: ApacheArrowFieldLike): InferredGeometry {
  const metadata = requireMap(field.metadata, `Arrow field "${field.name}" metadata`);
  const extensionName = mapValue(metadata, "ARROW:extension:name");
  if (
    extensionName !== "geoarrow.point" &&
    extensionName !== "geoarrow.linestring" &&
    extensionName !== "geoarrow.polygon"
  ) {
    fail("unsupported-layout", `Arrow field "${field.name}" is not a supported GeoArrow geometry extension.`);
  }
  const kind = extensionName.slice("geoarrow.".length) as "point" | "linestring" | "polygon";
  let coordinateField = field;
  if (kind === "linestring" || kind === "polygon") {
    const outer = typeChildren(field, `Arrow geometry field "${field.name}"`);
    const outerName = kind === "linestring" ? "vertices" : "rings";
    if (outer.length !== 1 || outer[0]?.name !== outerName || outer[0].nullable) {
      fail("invalid-batch", `Arrow ${kind} storage must contain one non-nullable "${outerName}" child.`);
    }
    coordinateField = outer[0];
    if (kind === "polygon") {
      const rings = typeChildren(coordinateField, `Arrow geometry field "${field.name}".rings`);
      if (rings.length !== 1 || rings[0]?.name !== "vertices" || rings[0].nullable) {
        fail("invalid-batch", "Arrow polygon rings must contain one non-nullable vertices child.");
      }
      coordinateField = rings[0];
    }
  }
  const coordinate = inferCoordinate(coordinateField, `Arrow geometry field "${field.name}" coordinates`);
  let children: readonly ColumnarFieldV1[];
  if (kind === "point") children = [coordinate.schema];
  else if (kind === "linestring") {
    children = [
      {
        name: "vertices",
        type: { name: "list", parameters: { offsetType: "int32" } },
        nullable: false,
        children: [coordinate.schema],
      },
    ];
  } else {
    children = [
      {
        name: "rings",
        type: { name: "list", parameters: { offsetType: "int32" } },
        nullable: false,
        children: [
          {
            name: "vertices",
            type: { name: "list", parameters: { offsetType: "int32" } },
            nullable: false,
            children: [coordinate.schema],
          },
        ],
      },
    ];
  }
  const extensionMetadata = mapValue(metadata, "ARROW:extension:metadata");
  if (metadata.size !== (extensionMetadata === undefined ? 1 : 2)) {
    fail("unsupported-layout", `Arrow geometry field "${field.name}" contains unsupported custom metadata.`);
  }
  return Object.freeze({
    kind,
    dimensions: coordinate.dimensions,
    coordinateLayout: coordinate.coordinateLayout,
    field: {
      name: field.name,
      type: {
        name: `geoarrow.${kind}`,
        parameters: {
          dimensions: coordinate.dimensions,
          coordinateLayout: coordinate.coordinateLayout,
          offsetType: "int32",
        },
      },
      nullable: field.nullable,
      children,
      metadata: {
        "ARROW:extension:name": extensionName,
        ...(extensionMetadata === undefined ? {} : { "ARROW:extension:metadata": extensionMetadata }),
      },
    },
  });
}

function inferTimestamp(field: ApacheArrowFieldLike): {
  readonly unit: GeoArrowTimestampUnit;
  readonly timezone?: string;
} | null {
  const match = /^Timestamp<(SECOND|MILLISECOND|MICROSECOND|NANOSECOND)(?:, (.+))?>$/.exec(
    typeString(field, `Arrow field "${field.name}"`),
  );
  if (!match) return null;
  return Object.freeze({
    unit: match[1]!.toLowerCase() as GeoArrowTimestampUnit,
    ...(match[2] === undefined ? {} : { timezone: match[2] }),
  });
}

function inferStandardSchema(
  recordBatch: ApacheArrowRecordBatchLike,
  schemaId: string,
): { readonly schema: ColumnarSchemaV1; readonly metadata: ReadonlyMap<string, string> } {
  const arrowFields = recordBatch.schema.fields;
  const geometryFields = arrowFields.filter((candidate) =>
    mapValue(
      requireMap(candidate.metadata, `Arrow field "${candidate.name}" metadata`),
      "ARROW:extension:name",
    )?.startsWith("geoarrow."),
  );
  if (geometryFields.length !== 1 || arrowFields[0] !== geometryFields[0]) {
    fail("unsupported-layout", "A standard import requires exactly one leading supported GeoArrow geometry field.");
  }
  const geometry = inferGeometry(geometryFields[0]!);
  const schemaMetadata: Record<string, string> = {
    [LAYOUT_META.version]: HONUA_GEOARROW_LAYOUT_VERSION,
    [LAYOUT_META.specVersion]: GEOARROW_SPEC_VERSION,
    [LAYOUT_META.geometryField]: geometry.field.name,
    [LAYOUT_META.geometryKind]: geometry.kind,
    [LAYOUT_META.dimensions]: geometry.dimensions,
    [LAYOUT_META.coordinateLayout]: geometry.coordinateLayout,
  };
  const fields: ColumnarFieldV1[] = [geometry.field];
  let stage = 0;
  for (const arrowField of arrowFields.slice(1)) {
    if (requireMap(arrowField.metadata, `Arrow field "${arrowField.name}" metadata`).size !== 0) {
      fail("unsupported-layout", `Arrow field "${arrowField.name}" contains unsupported custom metadata.`);
    }
    if (
      arrowField.type.children != null &&
      (!Array.isArray(arrowField.type.children) || arrowField.type.children.length !== 0)
    ) {
      fail("unsupported-layout", `Arrow attribute field "${arrowField.name}" must be a scalar supported column.`);
    }
    const timestamp = inferTimestamp(arrowField);
    const actualType = typeString(arrowField, `Arrow field "${arrowField.name}"`);
    if (timestamp) {
      if (stage > 0) fail("unsupported-layout", "Timestamp must precede dictionary and feature-id fields.");
      stage = 1;
      schemaMetadata[LAYOUT_META.temporalField] = arrowField.name;
      schemaMetadata[LAYOUT_META.temporalUnit] = timestamp.unit;
      if (timestamp.timezone !== undefined) schemaMetadata[LAYOUT_META.temporalTimezone] = timestamp.timezone;
      fields.push({
        name: arrowField.name,
        type: {
          name: "timestamp",
          parameters: {
            unit: timestamp.unit,
            ...(timestamp.timezone === undefined ? {} : { timezone: timestamp.timezone }),
          },
        },
        nullable: arrowField.nullable,
      });
    } else if (actualType === "Dictionary<Int32, Utf8>") {
      if (stage > 1) fail("unsupported-layout", "Dictionary must precede the feature-id field.");
      stage = 2;
      const ordered = arrowField.type.isOrdered;
      if (typeof ordered !== "boolean") fail("invalid-batch", `Arrow dictionary "${arrowField.name}" lacks ordering.`);
      schemaMetadata[LAYOUT_META.dictionaryField] = arrowField.name;
      schemaMetadata[LAYOUT_META.dictionaryOrdered] = String(ordered);
      fields.push({
        name: arrowField.name,
        type: { name: "dictionary", parameters: { indexType: "int32", valueType: "utf8", ordered } },
        nullable: arrowField.nullable,
      });
    } else if (actualType === "Uint32") {
      if (stage > 2) fail("unsupported-layout", "Only one feature-id field is supported.");
      stage = 3;
      if (arrowField.nullable)
        fail("unsupported-layout", "The normative uint32 feature-id field must be non-nullable.");
      schemaMetadata[LAYOUT_META.featureIdField] = arrowField.name;
      fields.push({ name: arrowField.name, type: { name: "uint32" }, nullable: false });
    } else {
      fail("unsupported-layout", `Arrow field "${arrowField.name}" is outside the supported normative layout.`);
    }
  }
  return Object.freeze({
    schema: { id: schemaId, fields, metadata: schemaMetadata },
    metadata: new Map(Object.entries(schemaMetadata)),
  });
}

function requireRecordBatch(value: ApacheArrowRecordBatchLike): ApacheArrowRecordBatchLike {
  if (!isRecord(value) || !Number.isSafeInteger(value.numRows) || value.numRows < 0) {
    fail("invalid-batch", "Apache Arrow RecordBatch must expose a non-negative numRows.");
  }
  if (!isRecord(value.schema) || !Array.isArray(value.schema.fields))
    fail("invalid-batch", "Arrow schema is malformed.");
  if (typeof value.getChildAt !== "function") fail("invalid-batch", "Arrow RecordBatch must expose getChildAt().");
  requireMap(value.schema.metadata, "recordBatch.schema.metadata");
  value.schema.fields.forEach((field, index) => {
    if (
      !isRecord(field) ||
      typeof field.name !== "string" ||
      field.name.length === 0 ||
      typeof field.nullable !== "boolean"
    ) {
      fail("invalid-batch", `Arrow schema field ${index} is malformed.`);
    }
    requireMap(field.metadata, `recordBatch.schema.fields[${index}].metadata`);
    typeString(field, `recordBatch.schema.fields[${index}]`);
  });
  return value;
}

function vectorData(
  recordBatch: ApacheArrowRecordBatchLike,
  fieldIndex: number,
  fieldName: string,
): ApacheArrowDataLike {
  const vector = recordBatch.getChildAt(fieldIndex);
  if (!vector || !Array.isArray(vector.data) || vector.data.length !== 1) {
    fail("unsupported-layout", `Arrow field "${fieldName}" must contain exactly one contiguous data node.`);
  }
  const node = vector.data[0]!;
  if (node.offset !== 0)
    fail("unsupported-layout", `Sliced Arrow field "${fieldName}" is not supported without copying.`);
  if (node.length !== recordBatch.numRows)
    fail("invalid-batch", `Arrow field "${fieldName}" length must equal numRows.`);
  return node;
}

function requireChild(node: ApacheArrowDataLike, index: number, label: string): ApacheArrowDataLike {
  if (!Array.isArray(node.children)) fail("invalid-batch", `${label}.children must be an array.`);
  const child = node.children[index];
  if (!child) fail("invalid-batch", `${label} is missing child ${index}.`);
  if (child.offset !== 0) fail("unsupported-layout", `${label} contains a sliced child and would require copying.`);
  if (child.nullBitmap !== undefined && child.nullBitmap.byteLength !== 0) {
    fail("unsupported-layout", `${label} contains nullable child storage outside the normative layout.`);
  }
  return child;
}

function requireView<T extends ArrayBufferView>(value: unknown, ctor: { new (...args: never[]): T }, label: string): T {
  if (!(value instanceof ctor)) fail("invalid-batch", `${label} has the wrong Arrow buffer component type.`);
  if (!(value.buffer instanceof ArrayBuffer)) {
    fail("unsupported-layout", `${label} uses shared or foreign backing memory that cannot be transferred.`);
  }
  return value;
}

function pushView(
  buffers: ColumnarBufferV1[],
  id: string,
  role: ColumnarBufferV1["role"],
  fieldName: string,
  view: ArrayBufferView,
): void {
  if (!(view.buffer instanceof ArrayBuffer)) fail("unsupported-layout", `Arrow buffer "${id}" is not transferable.`);
  buffers.push({
    id,
    role,
    field: fieldName,
    data: view.buffer,
    byteOffset: view.byteOffset,
    byteLength: view.byteLength,
  });
}

function exactPrefix<T extends { readonly length: number; subarray(start: number, end: number): T }>(
  view: T,
  length: number,
  label: string,
): T {
  if (!Number.isSafeInteger(length) || length < 0 || view.length < length) {
    fail("invalid-batch", `${label} does not contain its required ${length} logical values.`);
  }
  return view.length === length ? view : view.subarray(0, length);
}

function resolveForeignCopyLimits(limits: GeoArrowConversionLimits): {
  readonly maxBackingBytes: number;
  readonly maxCopiedBytes: number;
} {
  const maxBackingBytes = positiveMetadataLimit(
    limits.maxBackingBytes,
    DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
    "maxBackingBytes",
  );
  const maxCopiedBytes = positiveMetadataLimit(limits.maxCopiedBytes, maxBackingBytes, "maxCopiedBytes");
  if (maxCopiedBytes > 0x7fff_ffff) {
    fail("invalid-input", "maxCopiedBytes exceeds the int32 GeoArrow representation ceiling.");
  }
  return Object.freeze({ maxBackingBytes, maxCopiedBytes: Math.min(maxCopiedBytes, maxBackingBytes) });
}

function fullyCoveredBacking(backing: ArrayBuffer, descriptors: readonly ColumnarBufferV1[]): boolean {
  if (backing.byteLength === 0) return true;
  const ranges = descriptors
    .filter(({ byteLength }) => byteLength > 0)
    .map(({ byteOffset, byteLength }) => [byteOffset, byteOffset + byteLength] as const)
    .sort(([left], [right]) => left - right);
  let coveredThrough = 0;
  for (const [start, end] of ranges) {
    if (start > coveredThrough) return false;
    if (end > coveredThrough) coveredThrough = end;
  }
  return coveredThrough === backing.byteLength;
}

function isolateForeignBackings(
  buffers: readonly ColumnarBufferV1[],
  limits: GeoArrowConversionLimits,
): { readonly buffers: readonly ColumnarBufferV1[]; readonly copiedBytes: number } {
  const byBacking = new Map<ArrayBuffer, ColumnarBufferV1[]>();
  for (const buffer of buffers) {
    const descriptors = byBacking.get(buffer.data) ?? [];
    descriptors.push(buffer);
    byBacking.set(buffer.data, descriptors);
  }
  const unsafe = new Set<ArrayBuffer>();
  let copiedBytes = 0;
  let retainedBackingBytes = 0;
  const resolved = resolveForeignCopyLimits(limits);
  for (const [backing, descriptors] of byBacking) {
    if (fullyCoveredBacking(backing, descriptors)) {
      retainedBackingBytes += backing.byteLength;
      continue;
    }
    unsafe.add(backing);
    for (const descriptor of descriptors) {
      if (descriptor.byteLength > resolved.maxCopiedBytes - copiedBytes) {
        fail("copy-limit-exceeded", `Foreign Arrow isolation exceeds the ${resolved.maxCopiedBytes}-byte copy limit.`, {
          actual: copiedBytes + descriptor.byteLength,
          limit: resolved.maxCopiedBytes,
        });
      }
      copiedBytes += descriptor.byteLength;
    }
  }
  if (copiedBytes > resolved.maxBackingBytes - retainedBackingBytes) {
    fail("copy-limit-exceeded", "Foreign Arrow isolation would exceed the bounded batch backing allocation.", {
      actual: retainedBackingBytes + copiedBytes,
      limit: resolved.maxBackingBytes,
    });
  }
  if (unsafe.size === 0) return Object.freeze({ buffers, copiedBytes: 0 });
  const isolated = buffers.map((buffer) => {
    if (!unsafe.has(buffer.data)) return buffer;
    let data: ArrayBuffer;
    try {
      data = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(data).set(new Uint8Array(buffer.data, buffer.byteOffset, buffer.byteLength));
    } catch (cause) {
      fail("copy-limit-exceeded", `Unable to isolate foreign Arrow buffer "${buffer.id}".`, undefined, cause);
    }
    return {
      ...buffer,
      data,
      byteOffset: 0,
    };
  });
  return Object.freeze({ buffers: Object.freeze(isolated), copiedBytes });
}

function pushValidity(buffers: ColumnarBufferV1[], fieldName: string, node: ApacheArrowDataLike): void {
  if (node.nullBitmap === undefined || node.nullBitmap.byteLength === 0) return;
  const logicalBytes = Math.ceil(node.length / 8);
  pushView(
    buffers,
    `${fieldName}.validity`,
    "validity",
    fieldName,
    exactPrefix(node.nullBitmap, logicalBytes, `${fieldName} validity`),
  );
}

function geometryBuffersFromArrow(
  recordBatch: ApacheArrowRecordBatchLike,
  fieldIndex: number,
  fieldName: string,
  schemaMetadata: Readonly<Record<string, string>>,
  buffers: ColumnarBufferV1[],
): void {
  const node = vectorData(recordBatch, fieldIndex, fieldName);
  const kind = schemaMetadata["honua.geoarrow.geometry.kind"];
  const layout = schemaMetadata["honua.geoarrow.geometry.coordinate-layout"];
  const dimensions = schemaMetadata["honua.geoarrow.geometry.dimensions"] as GeoArrowDimensions;
  const names = dimensionNames(dimensions);
  pushValidity(buffers, fieldName, node);
  let coordinateNode: ApacheArrowDataLike;
  if (kind === "point") coordinateNode = node;
  else if (kind === "linestring") {
    pushView(
      buffers,
      `${fieldName}.offsets`,
      "offsets",
      fieldName,
      exactPrefix(
        requireView(node.valueOffsets, Int32Array, `${fieldName} offsets`),
        node.length + 1,
        `${fieldName} offsets`,
      ),
    );
    coordinateNode = requireChild(node, 0, fieldName);
  } else if (kind === "polygon") {
    pushView(
      buffers,
      `${fieldName}.offsets`,
      "offsets",
      fieldName,
      exactPrefix(
        requireView(node.valueOffsets, Int32Array, `${fieldName} offsets`),
        node.length + 1,
        `${fieldName} offsets`,
      ),
    );
    const rings = requireChild(node, 0, `${fieldName}.rings`);
    pushView(
      buffers,
      `${fieldName}.ring-offsets`,
      "offsets",
      fieldName,
      exactPrefix(
        requireView(rings.valueOffsets, Int32Array, `${fieldName} ring offsets`),
        rings.length + 1,
        `${fieldName} ring offsets`,
      ),
    );
    coordinateNode = requireChild(rings, 0, `${fieldName}.vertices`);
  } else fail("unsupported-layout", `Unsupported Arrow GeoArrow geometry kind "${String(kind)}".`);

  if (layout === "interleaved") {
    const values = exactPrefix(
      requireView(
        requireChild(coordinateNode, 0, `${fieldName}.coordinates`).values,
        Float64Array,
        `${fieldName} coordinates`,
      ),
      coordinateNode.length * names.length,
      `${fieldName} coordinates`,
    );
    pushView(buffers, `${fieldName}.coordinates`, "geometry", fieldName, values);
  } else if (layout === "separated") {
    names.forEach((name, index) => {
      const values = exactPrefix(
        requireView(
          requireChild(coordinateNode, index, `${fieldName}.${name}`).values,
          Float64Array,
          `${fieldName}.${name}`,
        ),
        coordinateNode.length,
        `${fieldName}.${name}`,
      );
      pushView(buffers, `${fieldName}.${name}`, "geometry", fieldName, values);
    });
  } else fail("unsupported-layout", `Unsupported Arrow coordinate layout "${String(layout)}".`);
}

function fieldIndex(recordBatch: ApacheArrowRecordBatchLike, name: string): number {
  const index = recordBatch.schema.fields.findIndex((candidate) => candidate.name === name);
  if (index < 0) fail("invalid-batch", `Arrow field "${name}" is missing.`);
  return index;
}

function expectedGeometryType(metadata: Readonly<Record<string, string>>): string {
  const dimensions = metadata["honua.geoarrow.geometry.dimensions"] as GeoArrowDimensions;
  const names = dimensionNames(dimensions);
  const coordinate =
    metadata["honua.geoarrow.geometry.coordinate-layout"] === "interleaved"
      ? `FixedSizeList[${names.length}]<Float64>`
      : `Struct<{${names.map((name) => `${name}:Float64`).join(", ")}}>`;
  const kind = metadata["honua.geoarrow.geometry.kind"];
  if (kind === "point") return coordinate;
  if (kind === "linestring") return `List<${coordinate}>`;
  if (kind === "polygon") return `List<List<${coordinate}>>`;
  fail("unsupported-layout", `Unsupported Arrow GeoArrow geometry kind "${String(kind)}".`);
}

function sameRecord(
  left: Readonly<Record<string, string | number | boolean>> | undefined,
  right: Readonly<Record<string, string | number | boolean>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1])
  );
}

function assertFieldShape(actual: ColumnarFieldV1, expected: ColumnarFieldV1, label: string): void {
  if (
    actual.name !== expected.name ||
    actual.nullable !== expected.nullable ||
    actual.type.name !== expected.type.name ||
    !sameRecord(actual.type.parameters, expected.type.parameters) ||
    !sameRecord(actual.metadata, expected.metadata)
  ) {
    fail("invalid-batch", `${label} does not match the embedded normative field shape.`);
  }
  const actualChildren = actual.children ?? [];
  const expectedChildren = expected.children ?? [];
  if (actualChildren.length !== expectedChildren.length) {
    fail("invalid-batch", `${label} does not match the embedded normative child count.`);
  }
  actualChildren.forEach((child, index) => assertFieldShape(child, expectedChildren[index]!, `${label}.${child.name}`));
}

function assertArrowLeafType(field: ApacheArrowFieldLike, label: string): void {
  if (field.type.children != null && (!Array.isArray(field.type.children) || field.type.children.length !== 0)) {
    fail("invalid-batch", `${label} must not contain nested Arrow child fields.`);
  }
}

function validateArrowSchema(
  recordBatch: ApacheArrowRecordBatchLike,
  schema: ColumnarSchemaV1,
  metadata: ReadonlyMap<string, string>,
): void {
  if (
    recordBatch.schema.fields.length !== schema.fields.length ||
    recordBatch.schema.fields.some((candidate, index) => candidate.name !== schema.fields[index]?.name)
  ) {
    fail("invalid-batch", "Arrow RecordBatch fields do not match the embedded normative schema order.");
  }
  const geometryField = requiredMapValue(metadata, LAYOUT_META.geometryField);
  const temporalField = mapValue(metadata, LAYOUT_META.temporalField);
  const dictionaryField = mapValue(metadata, LAYOUT_META.dictionaryField);
  const featureIdField = mapValue(metadata, LAYOUT_META.featureIdField);
  for (let index = 0; index < schema.fields.length; index += 1) {
    const expected = schema.fields[index]!;
    const actual = recordBatch.schema.fields[index]!;
    if (actual.nullable !== expected.nullable) {
      fail("invalid-batch", `Arrow field "${expected.name}" nullability differs from the embedded schema.`);
    }
    const actualType = typeString(actual, `Arrow field "${expected.name}"`);
    let expectedType: string;
    if (expected.name === geometryField) {
      expectedType = expectedGeometryType(schema.metadata ?? {});
      const inferred = inferGeometry(actual);
      assertFieldShape(inferred.field, expected, `Arrow geometry field "${expected.name}"`);
      const actualMetadata = requireMap(actual.metadata, `recordBatch.schema.fields[${index}].metadata`);
      if (
        mapValue(actualMetadata, "ARROW:extension:name") !== expected.metadata?.["ARROW:extension:name"] ||
        mapValue(actualMetadata, "ARROW:extension:metadata") !== expected.metadata?.["ARROW:extension:metadata"]
      ) {
        fail("invalid-batch", `Arrow geometry field "${expected.name}" extension metadata has drifted.`);
      }
    } else if (expected.name === temporalField) {
      assertArrowLeafType(actual, `Arrow timestamp field "${expected.name}"`);
      const unit = String(expected.type.parameters?.unit).toUpperCase();
      const timezone = expected.type.parameters?.timezone;
      expectedType = `Timestamp<${unit}${timezone === undefined ? "" : `, ${String(timezone)}`}>`;
    } else if (expected.name === dictionaryField) {
      assertArrowLeafType(actual, `Arrow dictionary field "${expected.name}"`);
      expectedType = "Dictionary<Int32, Utf8>";
    } else if (expected.name === featureIdField) {
      assertArrowLeafType(actual, `Arrow feature id field "${expected.name}"`);
      expectedType = "Uint32";
    } else fail("invalid-batch", `Arrow field "${expected.name}" is not declared by the normative layout metadata.`);
    if (actualType !== expectedType) {
      fail("invalid-batch", `Arrow field "${expected.name}" uses ${actualType}; expected ${expectedType}.`, {
        field: expected.name,
        expected: expectedType,
        actual: actualType,
      });
    }
    if (expected.name === dictionaryField) {
      const ordered = isRecord(actual.type) ? actual.type.isOrdered : undefined;
      if (ordered !== expected.type.parameters?.ordered) {
        fail("invalid-batch", `Arrow dictionary field "${expected.name}" ordered metadata has drifted.`);
      }
    }
  }
}

/**
 * Re-wrap one contiguous Apache Arrow RecordBatch as a transferable Honua
 * batch. Supported Arrow buffers are retained by identity; sliced/shared
 * layouts fail explicitly instead of performing an implicit copy.
 */
export function fromApacheArrowRecordBatch(
  foreignRecordBatch: ApacheArrowRecordBatchLike,
  options: FromApacheArrowRecordBatchOptions = {},
): GeoArrowBatchFromApacheResult {
  const recordBatch = requireRecordBatch(foreignRecordBatch);
  const arrowMetadata = requireMap(recordBatch.schema.metadata, "recordBatch.schema.metadata");
  const limits = options.limits ?? {};
  const storedSchemaJson = mapValue(arrowMetadata, TRANSPORT_META.schema);
  const storedIdentityJson = mapValue(arrowMetadata, TRANSPORT_META.identity);
  let schema: ColumnarSchemaV1;
  let identity: ColumnarBatchIdentityV1;
  let metadata: ReadonlyMap<string, string>;
  let id: string;
  let sequence: number;
  let rowOffset: number | undefined;
  if (storedSchemaJson !== undefined || storedIdentityJson !== undefined) {
    if (storedSchemaJson === undefined || storedIdentityJson === undefined) {
      fail("invalid-batch", "Arrow RecordBatch contains incomplete Honua transport metadata.");
    }
    const storedSchema = parseJson<ColumnarSchemaV1>(storedSchemaJson, "Arrow schema", limits);
    schema = { ...storedSchema, id: options.schemaId ?? storedSchema.id };
    const storedIdentity = parseJson<ColumnarBatchIdentityV1>(storedIdentityJson, "Arrow identity", limits);
    identity = options.identity ?? storedIdentity;
    metadata = arrowMetadata;
    id = options.id ?? requiredMapValue(metadata, TRANSPORT_META.batchId);
    sequence = options.sequence ?? parseInteger(mapValue(metadata, TRANSPORT_META.sequence), 0, "batch sequence");
    rowOffset =
      options.rowOffset ??
      (mapValue(metadata, TRANSPORT_META.rowOffset) === undefined
        ? undefined
        : parseInteger(mapValue(metadata, TRANSPORT_META.rowOffset), 0, "batch rowOffset"));
  } else {
    if (options.id === undefined || options.schemaId === undefined || options.identity === undefined) {
      fail(
        "invalid-input",
        "Importing a standard GeoArrow RecordBatch requires options.id, options.schemaId, and options.identity.",
      );
    }
    if (arrowMetadata.size !== 0) {
      fail("unsupported-layout", "Standard GeoArrow import does not silently discard custom schema metadata.");
    }
    const inferred = inferStandardSchema(recordBatch, options.schemaId);
    schema = inferred.schema;
    identity = options.identity;
    metadata = inferred.metadata;
    id = options.id;
    sequence = options.sequence ?? 0;
    rowOffset = options.rowOffset;
  }
  validateArrowSchema(recordBatch, schema, metadata);
  const buffers: ColumnarBufferV1[] = [];
  const schemaMetadata = schema.metadata ?? {};
  const geometryField = requiredMapValue(metadata, LAYOUT_META.geometryField);
  geometryBuffersFromArrow(recordBatch, fieldIndex(recordBatch, geometryField), geometryField, schemaMetadata, buffers);

  const temporalField = mapValue(metadata, LAYOUT_META.temporalField);
  if (temporalField !== undefined) {
    const node = vectorData(recordBatch, fieldIndex(recordBatch, temporalField), temporalField);
    pushValidity(buffers, temporalField, node);
    pushView(
      buffers,
      `${temporalField}.values`,
      "values",
      temporalField,
      exactPrefix(
        requireView(node.values, BigInt64Array, `${temporalField} values`),
        node.length,
        `${temporalField} values`,
      ),
    );
  }

  const dictionaryField = mapValue(metadata, LAYOUT_META.dictionaryField);
  if (dictionaryField !== undefined) {
    const node = vectorData(recordBatch, fieldIndex(recordBatch, dictionaryField), dictionaryField);
    pushValidity(buffers, dictionaryField, node);
    pushView(
      buffers,
      `${dictionaryField}.indices`,
      "dictionary",
      dictionaryField,
      exactPrefix(
        requireView(node.values, Int32Array, `${dictionaryField} indices`),
        node.length,
        `${dictionaryField} indices`,
      ),
    );
    const dictionary = node.dictionary;
    if (!dictionary || !Array.isArray(dictionary.data) || dictionary.data.length !== 1) {
      fail("invalid-batch", `Arrow dictionary field "${dictionaryField}" has no contiguous dictionary vector.`);
    }
    const dictionaryNode = dictionary.data[0]!;
    if (dictionaryNode.nullBitmap !== undefined && dictionaryNode.nullBitmap.byteLength !== 0) {
      fail("unsupported-layout", `Arrow dictionary field "${dictionaryField}" contains nullable dictionary values.`);
    }
    const dictionaryOffsets = exactPrefix(
      requireView(dictionaryNode.valueOffsets, Int32Array, `${dictionaryField} dictionary offsets`),
      dictionaryNode.length + 1,
      `${dictionaryField} dictionary offsets`,
    );
    pushView(buffers, `${dictionaryField}.offsets`, "offsets", dictionaryField, dictionaryOffsets);
    const dictionaryByteLength = dictionaryOffsets[dictionaryOffsets.length - 1]!;
    pushView(
      buffers,
      `${dictionaryField}.values`,
      "dictionary",
      dictionaryField,
      exactPrefix(
        requireView(dictionaryNode.values, Uint8Array, `${dictionaryField} dictionary values`),
        dictionaryByteLength,
        `${dictionaryField} dictionary values`,
      ),
    );
  }

  const featureIdField = mapValue(metadata, LAYOUT_META.featureIdField);
  if (featureIdField !== undefined) {
    const node = vectorData(recordBatch, fieldIndex(recordBatch, featureIdField), featureIdField);
    if (node.nullBitmap !== undefined && node.nullBitmap.byteLength !== 0) {
      fail("unsupported-layout", `Arrow feature id field "${featureIdField}" contains null values.`);
    }
    pushView(
      buffers,
      `${featureIdField}.values`,
      "values",
      featureIdField,
      exactPrefix(
        requireView(node.values, Uint32Array, `${featureIdField} values`),
        node.length,
        `${featureIdField} values`,
      ),
    );
  }

  const isolated = isolateForeignBackings(buffers, limits);
  const batch = createColumnarBatch(
    {
      id,
      sequence,
      rowOffset,
      rowCount: recordBatch.numRows,
      schema,
      identity,
      buffers: isolated.buffers,
    },
    limits,
  );
  inspectGeoArrowBatch(batch, limits);
  const metrics = inspectColumnarBatch(batch, limits);
  const resultMetrics: ApacheArrowAdapterMetrics = Object.freeze({
    rows: batch.rowCount,
    backingBytes: metrics.backingBytes,
    referencedBytes: metrics.logicalBytes,
    copiedBytes: isolated.copiedBytes,
  });
  return Object.freeze({ batch, metrics: resultMetrics });
}
