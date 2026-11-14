/** Vendor-neutral projection of the native descriptor contract. */
import { createSourceSchemaV2 } from "./contract/schema.js";
import type {
  CrsBinding,
  FieldValueDomain,
  GeometryFieldSchema,
  JsonValue,
  LogicalField,
  LogicalType,
  SourceGeometrySchema,
} from "./contract/schema.js";
import type {
  AttributeValue,
  FieldType as ProtoFieldType,
  GeometryType as ProtoGeometryType,
} from "./gen/geospatial/v1/common_pb.js";
import type { FieldDomain, LayerDescriptor } from "./gen/geospatial/v1/metadata_types_pb.js";

// Frozen wire enum values, checked against the generated enum member types. Keeping
// these constants local lets REST-only bundles project schemas without protobuf peers.
const FieldType = {
  UNSPECIFIED: 0,
  STRING: 1,
  INTEGER: 2,
  BIG_INTEGER: 3,
  DOUBLE: 4,
  FLOAT: 5,
  BOOLEAN: 6,
  DATE_TIME: 7,
  DATE: 8,
  TIME: 9,
  GEOMETRY: 10,
  JSON: 11,
  BINARY: 12,
  UUID: 13,
  TIMESTAMP_OFFSET: 14,
  DECIMAL: 15,
} as const satisfies { [K in keyof typeof ProtoFieldType]: (typeof ProtoFieldType)[K] };
const GeometryType = { NONE: 8 } as const satisfies Pick<typeof ProtoGeometryType, "NONE">;

export function grpcSourceSchemaV2(layer: LayerDescriptor, context: { source: string; observedAt?: string }) {
  const fields = layer.fields.map((field) => projectField(field, layer));
  const names = new Set(fields.map((field) => field.name));
  if (names.size !== fields.length) throw new Error("DescribeLayer contains duplicate field names.");
  const time = layer.timeInfo;
  if (layer.objectIdField && !names.has(layer.objectIdField))
    throw new Error("DescribeLayer references an absent key field.");
  if (time && (!names.has(time.startField) || (time.endField && !names.has(time.endField)))) {
    throw new Error("DescribeLayer references an absent temporal field.");
  }
  return createSourceSchemaV2({
    fields,
    key: layer.objectIdField
      ? { state: "known", fields: [layer.objectIdField] }
      : { state: "unknown", reason: "not-declared" },
    geometry: geometry(layer, fields),
    temporal: time
      ? time.endField
        ? { state: "interval", startField: time.startField, endField: time.endField }
        : { state: "instant", field: time.startField }
      : { state: "none" },
    openContent: "closed",
    provenance: [{ method: "declared", protocol: "grpc", ...context }],
  });
}

function projectField(field: LayerDescriptor["fields"][number], layer: LayerDescriptor): LogicalField {
  const definition = field.definition;
  if (!definition?.name.trim()) throw new Error("DescribeLayer field definition is missing a name.");
  const name = definition.name;
  const roles: LogicalField["roles"][number][] = [];
  if (name === layer.objectIdField) roles.push("primary-key", "feature-id");
  if (definition.fieldType === FieldType.GEOMETRY) roles.push("geometry");
  if (name === layer.timeInfo?.startField) roles.push(layer.timeInfo.endField ? "time-start" : "time-instant");
  if (name === layer.timeInfo?.endField) roles.push("time-end");
  if (name === layer.editingInfo?.createdAtField) roles.push("created-at");
  if (name === layer.editingInfo?.editedAtField) roles.push("updated-at");
  return {
    name,
    path: [name],
    ...(definition.alias ? { title: definition.alias } : {}),
    type: logicalType(definition.fieldType, definition.length),
    nullability: definition.nullable ? "nullable" : "non-nullable",
    mutability: field.editable === undefined ? "unknown" : field.editable ? "read-write" : "read-only",
    roles,
    ...(field.defaultValue ? { defaultValue: attributeJson(field.defaultValue, definition.fieldType) } : {}),
    domain: domain(field.domain, definition.fieldType),
    constraints: { state: "unknown", reason: "not-reported" },
    native: [{ protocol: "grpc", name: String(definition.fieldType), namespace: "geospatial.v1.FieldType" }],
  };
}

function logicalType(type: number, length: number): LogicalType {
  switch (type) {
    case FieldType.STRING:
      return { kind: "string", ...(length > 0 ? { maxLength: length } : {}) };
    case FieldType.INTEGER:
      return { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" };
    case FieldType.BIG_INTEGER:
      return { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" };
    case FieldType.DOUBLE:
      return { kind: "float", bits: 64 };
    case FieldType.FLOAT:
      return { kind: "float", bits: 32 };
    case FieldType.BOOLEAN:
      return { kind: "boolean" };
    case FieldType.DATE_TIME:
      return { kind: "timestamp", unit: "millisecond", timezone: "utc" };
    case FieldType.DATE:
      return { kind: "date" };
    case FieldType.TIME:
      return { kind: "time", unit: "millisecond" };
    case FieldType.GEOMETRY:
      return { kind: "geometry" };
    case FieldType.JSON:
      return { kind: "json" };
    case FieldType.BINARY:
      return { kind: "binary", encoding: "base64" };
    case FieldType.UUID:
      return { kind: "uuid" };
    default:
      return { kind: "unknown", reason: type === FieldType.UNSPECIFIED ? "missing" : "unrecognized" };
  }
}

function attributeJson(attribute: AttributeValue, fieldType: ProtoFieldType): JsonValue {
  const value = attribute.value;
  switch (value.case) {
    case "int64Value":
      return fieldType === FieldType.INTEGER || fieldType === FieldType.DOUBLE || fieldType === FieldType.FLOAT
        ? Number(value.value)
        : value.value.toString();
    case "int32Value":
      return fieldType === FieldType.BIG_INTEGER ? value.value.toString() : value.value;
    case "datetimeValue":
      return new Date(Number(value.value)).toISOString();
    case "nullValue":
      return null;
    case "bytesValue": {
      let binary = "";
      for (const byte of value.value) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
    case undefined:
      throw new Error("Descriptor contains an unset attribute value.");
    default:
      return value.value;
  }
}

function domain(value: FieldDomain | undefined, fieldType: ProtoFieldType): FieldValueDomain {
  if (!value) return { state: "none", reason: "unconstrained" };
  const constraint = value.constraint;
  if (constraint.case === "codedValues") {
    const values = constraint.value.values.map((entry) => {
      if (!entry.code) throw new Error("Descriptor coded domain has no code.");
      const code = attributeJson(entry.code, fieldType);
      if (code === null || typeof code === "object") throw new Error("Descriptor coded domain has an invalid code.");
      return { value: code, label: entry.name, ...(entry.description ? { description: entry.description } : {}) };
    });
    if (!values.length) return { state: "unknown", reason: "unrecognized" };
    return { state: "coded", openness: "closed", values: [values[0]!, ...values.slice(1)] };
  }
  if (constraint.case === "range") {
    const minimum = constraint.value.minimum ? attributeJson(constraint.value.minimum, fieldType) : undefined;
    const maximum = constraint.value.maximum ? attributeJson(constraint.value.maximum, fieldType) : undefined;
    if (
      (typeof minimum === "number" || typeof minimum === "string") &&
      (typeof maximum === "number" || typeof maximum === "string")
    ) {
      return {
        state: "range",
        minimum: { value: minimum, inclusive: true },
        maximum: { value: maximum, inclusive: true },
      };
    }
  }
  return { state: "unknown", reason: "unrecognized" };
}

function geometry(layer: LayerDescriptor, fields: readonly LogicalField[]): SourceGeometrySchema {
  if (layer.geometryType === GeometryType.NONE) return { state: "none", reason: "declared-non-spatial" };
  const geometryFields = fields.filter((field) => field.type.kind === "geometry");
  if (!geometryFields.length) return { state: "unknown", reason: "missing" };
  const types = [
    undefined,
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
  ] as const;
  const type = types[layer.geometryType];
  const geometryField = (field: LogicalField): GeometryFieldSchema => ({
    field: field.name,
    geometryTypes: type ? { state: "known", type } : { state: "unknown", reason: "unrecognized" },
    crs: descriptorCrs(layer),
    layout: layer.hasZ ? (layer.hasM ? "xyzm" : "xyz") : layer.hasM ? "xym" : "xy",
    allowsEmpty: "unknown",
  });
  return {
    state: "known",
    fields: [geometryField(geometryFields[0]!), ...geometryFields.slice(1).map(geometryField)],
    primaryField:
      geometryFields.length === 1
        ? { state: "known", field: geometryFields[0]!.name }
        : { state: "unknown", reason: "metadata-unavailable" },
  };
}

function descriptorCrs(layer: LayerDescriptor): CrsBinding {
  const sr = layer.spatialReference;
  const definition: CrsBinding["definition"] = sr?.wkid
    ? {
        kind: "authority",
        authority: "EPSG",
        code: String(sr.wkid),
        definitionAxisOrder: { state: "unknown", reason: "missing" },
      }
    : sr?.wkt
      ? {
          kind: "wkt",
          wkt: sr.wkt,
          dialect: "unknown",
          validation: "unverified",
          definitionAxisOrder: { state: "unknown", reason: "missing" },
        }
      : { kind: "unknown", reason: "missing" };
  return {
    definition,
    coordinateOrder: { state: "unknown", reason: "missing" },
    provenance: { method: "metadata" },
  };
}
