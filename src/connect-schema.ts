/** Internal dual-read normalizers for the experimental source-schema v2 rollout. */

import type { GeoParquetGeometryPlan, GeoParquetSourceProfile } from "./connect-geoparquet.js";
import {
  type AxisOrder,
  type CrsBinding,
  type CrsDefinition,
  type FieldRole,
  type FieldValueDomain,
  type GeometryFieldSchema,
  type GeometryKind,
  type GeometryTypeKnowledge,
  type JsonObject,
  type JsonValue,
  type KeyDefinition,
  type LogicalField,
  type LogicalType,
  type MetadataProvenance,
  type NativeTypeReference,
  type SourceGeometrySchema,
  type SourceProtocol,
  type SourceSchemaV2,
  type TemporalSchema,
  createSourceSchemaV2,
  validateSourceCrsDefinition,
} from "./contract/schema.js";
import type { Protocol } from "./contract/types.js";
import {
  type HonuaOdataFieldInfo,
  type HonuaOdataMetadata,
  getOdataSourceSchemaProjectionDetails,
  getOdataSourceSchemaProjectionSafety,
} from "./core/odata.js";
import type {
  EsriGeometryType,
  HonuaFieldDomain,
  HonuaFieldInfo,
  HonuaLayerMetadata,
  HonuaSpatialReference,
} from "./core/types.js";
import { canonicalStringify, toJsonValue } from "./query-planner/canonical.js";

const MAX_NATIVE_DEFINITION_BYTES = 64 * 1024;
const MAX_FIELD_DOMAIN_BYTES = 1024 * 1024;
const MAX_CODED_DOMAIN_VALUES = 10_000;
// SourceSchemaV2 reserves one of its 32 logical-type levels for the field's
// root type, leaving 31 safe recursive adapter steps.
const MAX_DISCOVERED_TYPE_DEPTH = 31;
const SUPPORTED_CSDL_VERSIONS = new Set(["4.0", "4.01"]);

export interface SchemaNormalizationContext {
  readonly protocol: SourceProtocol;
  readonly source: string;
  readonly observedAt?: string;
  readonly validator?: MetadataProvenance["validator"];
}

/** Normalize a GeoServices layer document while leaving legacy `.schema` untouched. */
export function geoServicesSourceSchemaV2(
  metadata: HonuaLayerMetadata,
  context: SchemaNormalizationContext & {
    readonly protocol: "geoservices-feature-service" | "geoservices-map-service";
  },
): SourceSchemaV2 | undefined {
  if (!Array.isArray(metadata.fields)) return undefined;
  const declaredKey = nonEmpty(metadata.objectIdField);
  const declaredKeyField = declaredKey ? metadata.fields.find((field) => field.name === declaredKey) : undefined;
  const inferredKeys = metadata.fields.filter((field) => field.type === "esriFieldTypeOID");
  const keyField = declaredKey
    ? declaredKeyField?.type === "esriFieldTypeOID"
      ? declaredKey
      : undefined
    : inferredKeys.length === 1
      ? inferredKeys[0]!.name
      : undefined;
  const key: KeyDefinition =
    (declaredKey && !keyField) || (!declaredKey && inferredKeys.length > 1)
      ? { state: "unknown", reason: "conflicting" }
      : keyField
        ? { state: "known", fields: [keyField] }
        : { state: "none" };
  const temporal = geoServicesTemporal(metadata, metadata.fields);
  const fields = metadata.fields.map((field) =>
    geoServicesField(field, context.protocol, keyField, metadata, temporal),
  );
  if (metadata.geometryType !== undefined && !fields.some((field) => field.type.kind === "geometry")) {
    fields.push(syntheticGeoServicesGeometryField(metadata, context.protocol));
  }
  const geometry = geoServicesGeometry(metadata, fields, context.protocol);
  return createSourceSchemaV2({
    fields,
    key,
    geometry,
    temporal,
    openContent: "closed",
    provenance: [provenance(context)],
  });
}

function syntheticGeoServicesGeometryField(
  metadata: HonuaLayerMetadata,
  protocol: "geoservices-feature-service" | "geoservices-map-service",
): LogicalField {
  const occupied = new Set(metadata.fields?.map((field) => field.name) ?? []);
  // Prefer the protocol-neutral `geometry`; deterministic numeric suffixes
  // preserve an attribute with that name without changing legacy `.schema`.
  let name = "geometry";
  for (let suffix = 2; occupied.has(name); suffix++) name = `geometry_${suffix}`;
  const native = nativeReference(protocol, metadata.geometryType ?? "geometry", ["geometryType"]);
  return {
    name,
    path: [name],
    type: { kind: "geometry" },
    nullability: "unknown",
    mutability: "unknown",
    roles: ["geometry"],
    domain: { state: "none", reason: "not-applicable" },
    constraints: notReportedConstraints(),
    native: [native],
  };
}

/** Normalize one OData 4.0 entity type while preserving the old Esri-shaped projection. */
export function odataSourceSchemaV2(
  metadata: HonuaOdataMetadata,
  entitySet: string,
  context: Omit<SchemaNormalizationContext, "protocol">,
): SourceSchemaV2 | undefined {
  const typeName = metadata.entitySets[entitySet];
  if (!typeName) return undefined;
  const nativeFields = odataProjectionFields(metadata)[typeName];
  if (!nativeFields) return undefined;
  const projectionIssue = odataProjectionIssue(metadata, typeName);
  if (projectionIssue) {
    throw new TypeError(
      `OData SourceSchemaV2 cannot certify a complete entity shape: ${projectionIssue.reason} (${projectionIssue.typeName})`,
    );
  }
  const keys = [...(metadata.keys[typeName] ?? [])];
  const fieldNames = new Set(nativeFields.map((field) => field.name));
  const validKeys = keys.length > 0 && new Set(keys).size === keys.length && keys.every((key) => fieldNames.has(key));
  const key: KeyDefinition =
    keys.length === 0
      ? { state: "none" }
      : validKeys
        ? { state: "known", fields: keys as [string, ...string[]] }
        : { state: "unknown", reason: "conflicting" };
  const keySet = new Set(validKeys ? keys : []);
  const fields = nativeFields.map((field) => odataField(field, keySet, typeName, metadata));
  const geometryFields = fields.filter((field) => field.type.kind === "geometry");
  const nestedGeometryPaths = fields.flatMap((field) =>
    field.type.kind === "geometry" ? [] : descendantGeometryPaths(field.type, field.path),
  );
  const geometry: SourceGeometrySchema =
    nestedGeometryPaths.length > 0
      ? {
          state: "unknown",
          reason: "unrecognized",
          native: nativeReference("odata", "nested-spatial-properties", [typeName], {
            paths: nestedGeometryPaths,
          }),
        }
      : geometryFields.length === 0
        ? { state: "none", reason: "no-geometry-fields" }
        : {
            state: "known",
            fields: geometryFields.map((field) => {
              const native = nativeFields.find((candidate) => candidate.name === field.name);
              return {
                field: field.name,
                geometryTypes: odataGeometryType(native?.type),
                crs: odataCrs(native),
                layout: "unknown",
                allowsEmpty: "unknown",
              };
            }) as [GeometryFieldSchema, ...GeometryFieldSchema[]],
            primaryField:
              geometryFields.length === 1
                ? { state: "known", field: geometryFields[0]!.name }
                : { state: "none", reason: "no-default" },
          };
  return createSourceSchemaV2({
    fields,
    key,
    geometry,
    // A scalar date/time type does not establish a semantic time dimension.
    // OData needs an explicit protocol annotation before we assign time roles.
    temporal: { state: "none" },
    openContent:
      odataProjectionOpenTypes(metadata)?.[typeName] === true
        ? "open"
        : SUPPORTED_CSDL_VERSIONS.has(getOdataSourceSchemaProjectionSafety(metadata)?.csdlVersion ?? "")
          ? "closed"
          : "unknown",
    provenance: [provenance({ ...context, protocol: "odata" })],
  });
}

function descendantGeometryPaths(type: LogicalType, path: readonly string[]): readonly (readonly string[])[] {
  if (type.kind === "geometry") return [path];
  if (type.kind === "list") return descendantGeometryPaths(type.element, path);
  if (type.kind === "union") return type.members.flatMap((member) => descendantGeometryPaths(member, path));
  if (type.kind === "struct") {
    return type.fields.flatMap((field) => descendantGeometryPaths(field.type, field.path));
  }
  return [];
}

function odataProjectionIssue(
  metadata: HonuaOdataMetadata,
  typeName: string,
  visited: Set<string> = new Set(),
  depth = 0,
): { readonly typeName: string; readonly reason: string } | undefined {
  if (depth >= MAX_DISCOVERED_TYPE_DEPTH) {
    return { typeName: "nested type", reason: `type nesting exceeds ${MAX_DISCOVERED_TYPE_DEPTH} levels` };
  }
  const safety = getOdataSourceSchemaProjectionSafety(metadata);
  if (!safety) return undefined;
  if (safety.csdlVersion !== undefined && !SUPPORTED_CSDL_VERSIONS.has(safety.csdlVersion)) {
    return {
      typeName,
      reason: `unsupported or missing CSDL version ${safety.csdlVersion ?? "unknown"}`,
    };
  }
  const collection = unwrapOdataCollection(typeName);
  if (collection !== undefined) return odataProjectionIssue(metadata, collection, visited, depth + 1);
  const nativeTypeName = typeName;
  if (nativeTypeName.startsWith("Edm.")) return undefined;
  const localName = stripOdataNamespace(nativeTypeName);
  if (visited.has(localName)) return undefined;
  visited.add(localName);
  if (safety.ambiguousTypeNames.includes(localName)) {
    return { typeName: localName, reason: "ambiguous qualified type name" };
  }
  if (safety.unqualifiedTypeNames.includes(localName)) {
    return { typeName: localName, reason: "type declared without a CSDL namespace" };
  }
  if (safety.inheritedTypeNames.includes(localName)) {
    return { typeName: localName, reason: "BaseType inheritance is not projected" };
  }
  if (safety.openComplexTypeNames.includes(localName)) {
    return { typeName: localName, reason: "open complex types are not projected" };
  }
  const referencedFields =
    odataProjectionFields(metadata)[localName] ?? odataProjectionComplexTypes(metadata)?.[localName];
  for (const field of referencedFields ?? []) {
    const issue = odataProjectionIssue(metadata, field.type, visited, depth + 1);
    if (issue) return issue;
  }
  return undefined;
}

function odataProjectionFields(metadata: HonuaOdataMetadata): Readonly<Record<string, readonly HonuaOdataFieldInfo[]>> {
  return getOdataSourceSchemaProjectionDetails(metadata)?.fields ?? metadata.fields;
}

function odataProjectionComplexTypes(metadata: HonuaOdataMetadata): HonuaOdataMetadata["complexTypes"] {
  return getOdataSourceSchemaProjectionDetails(metadata)?.complexTypes ?? metadata.complexTypes;
}

function odataProjectionEnumTypes(metadata: HonuaOdataMetadata): HonuaOdataMetadata["enumTypes"] {
  return getOdataSourceSchemaProjectionDetails(metadata)?.enumTypes ?? metadata.enumTypes;
}

function odataProjectionOpenTypes(metadata: HonuaOdataMetadata): HonuaOdataMetadata["openTypes"] {
  return getOdataSourceSchemaProjectionDetails(metadata)?.openTypes ?? metadata.openTypes;
}

function unwrapOdataCollection(value: string): string | undefined {
  const prefix = "Collection(";
  if (!value.startsWith(prefix) || !value.endsWith(")")) return undefined;
  const inner = value.slice(prefix.length, -1);
  return inner === "" ? undefined : inner;
}

/** Normalize a GeoParquet footer/DESCRIBE profile. Unknown native types stay unknown. */
export function geoParquetSourceSchemaV2(
  profile: GeoParquetSourceProfile,
  context: Omit<SchemaNormalizationContext, "protocol">,
): SourceSchemaV2 {
  const geometries = geoParquetGeometryPlans(profile);
  const geometryColumns = new Set(geometries.map((geometry) => geometry.column));
  const profiledFields = geoParquetProfileFields(profile);
  const fields = profiledFields.map((field) => geoParquetField(field, geometryColumns));
  const geometry = geoParquetGeometry(profile, fields, geometries);
  return createSourceSchemaV2({
    fields,
    key: { state: "none" },
    geometry,
    // Physical DATE/TIMESTAMP columns are not necessarily the dataset's
    // semantic time dimension. GeoParquet metadata currently has no such hint.
    temporal: { state: "none" },
    openContent: "closed",
    provenance: [provenance({ ...context, protocol: "geoparquet" })],
  });
}

function geoServicesField(
  field: HonuaFieldInfo,
  protocol: "geoservices-feature-service" | "geoservices-map-service",
  keyField: string | undefined,
  metadata: HonuaLayerMetadata,
  temporal: TemporalSchema,
): LogicalField {
  const native = nativeReference(protocol, field.type, ["fields", field.name], {
    ...(field.length === undefined ? {} : { length: field.length }),
    ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
    ...(field.editable === undefined ? {} : { editable: field.editable }),
    ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    ...(field.domain === undefined ? {} : { domain: field.domain }),
  });
  const type = geoServicesLogicalType(field, native);
  const roles: FieldRole[] = [];
  if (field.name === keyField) roles.push("primary-key", "feature-id");
  if (field.name === metadata.globalIdField && !roles.includes("feature-id")) roles.push("feature-id");
  if (field.type === "esriFieldTypeGeometry") roles.push("geometry");
  if (temporal.state === "instant" && temporal.field === field.name) roles.push("time-instant");
  if (temporal.state === "interval") {
    if (temporal.startField === field.name) roles.push("time-start");
    if (temporal.endField === field.name) roles.push("time-end");
  }
  return {
    name: field.name,
    path: [field.name],
    ...(nonEmpty(field.alias) ? { title: field.alias } : {}),
    type,
    nullability:
      field.name === keyField
        ? field.nullable === true
          ? "nullable"
          : "non-nullable"
        : field.nullable === true
          ? "nullable"
          : field.nullable === false
            ? "non-nullable"
            : "unknown",
    mutability: field.editable === true ? "read-write" : field.editable === false ? "read-only" : "unknown",
    roles,
    ...(field.defaultValue === undefined ? {} : normalizedDefault(field.defaultValue, type, field.nullable === false)),
    domain: geoServicesDomain(field.domain, native, type),
    constraints: notReportedConstraints(),
    native: [native],
  };
}

function geoServicesLogicalType(field: HonuaFieldInfo, native: NativeTypeReference): LogicalType {
  switch (field.type) {
    case "esriFieldTypeString":
      return { kind: "string", ...(validLength(field.length) ? { maxLength: field.length } : {}) };
    case "esriFieldTypeSmallInteger":
      return { kind: "integer", bits: 16, signed: true, jsonEncoding: "number" };
    case "esriFieldTypeInteger":
      return { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" };
    case "esriFieldTypeBigInteger":
      return { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" };
    case "esriFieldTypeOID":
      return field.length !== undefined && field.length >= 8
        ? { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" }
        : { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" };
    case "esriFieldTypeSingle":
      return { kind: "float", bits: 32 };
    case "esriFieldTypeDouble":
      return { kind: "float", bits: 64 };
    case "esriFieldTypeDate":
      return { kind: "timestamp", unit: "millisecond", timezone: "utc" };
    case "esriFieldTypeGUID":
    case "esriFieldTypeGlobalID":
      return { kind: "uuid" };
    case "esriFieldTypeBlob":
      return { kind: "binary", encoding: "base64" };
    case "esriFieldTypeXML":
      return { kind: "string", encoding: "xml" };
    case "esriFieldTypeGeometry":
      return { kind: "geometry" };
    default:
      return { kind: "unknown", reason: "unrecognized", native };
  }
}

function geoServicesDomain(
  domain: HonuaFieldDomain | null | undefined,
  native: NativeTypeReference,
  type: LogicalType,
): FieldValueDomain {
  if (domainInapplicable(type)) return { state: "none", reason: "not-applicable" };
  if (domain === undefined) return notReportedDomain();
  if (domain === null) return { state: "none", reason: "unconstrained" };
  if (domain.type === "codedValue") {
    const values = domain.codedValues;
    if (!Array.isArray(values)) return { state: "unknown", reason: "unrecognized", native };
    if (values.length > MAX_CODED_DOMAIN_VALUES) return { state: "unknown", reason: "limit-exceeded", native };
    if (values.length === 0) return { state: "unknown", reason: "conflicting", native };
    const seen = new Set<string>();
    const mapped = [] as Array<{ value: string | number | boolean; label?: string }>;
    for (const coded of values) {
      if (!coded) return { state: "unknown", reason: "unrecognized", native };
      const value = normalizeAdapterScalar(coded.code, type);
      if (value === undefined) return { state: "unknown", reason: "unrecognized", native };
      const identity = canonicalStringify(toJsonValue(value));
      if (seen.has(identity)) return { state: "unknown", reason: "conflicting", native };
      seen.add(identity);
      mapped.push({ value, ...(nonEmpty(coded.name) ? { label: coded.name } : {}) });
    }
    const candidate: FieldValueDomain = {
      state: "coded",
      values: mapped as [{ value: string | number | boolean }, ...Array<{ value: string | number | boolean }>],
      openness: "closed",
    };
    return boundedDomain(candidate, native);
  }
  if (domain.type === "range") {
    if (!adapterRangeType(type)) return { state: "unknown", reason: "unrecognized", native };
    const range = domain.range;
    if (!Array.isArray(range) || range.length !== 2) {
      return { state: "unknown", reason: "unrecognized", native };
    }
    const minimum = normalizeAdapterOrderedScalar(range[0], type);
    const maximum = normalizeAdapterOrderedScalar(range[1], type);
    if (minimum === undefined || maximum === undefined) {
      return { state: "unknown", reason: "unrecognized", native };
    }
    if (typeof minimum !== typeof maximum || compareAdapterOrderedValues(minimum, maximum, type) > 0) {
      return { state: "unknown", reason: "conflicting", native };
    }
    return boundedDomain(
      {
        state: "range",
        minimum: { value: minimum, inclusive: true },
        maximum: { value: maximum, inclusive: true },
      },
      native,
    );
  }
  return { state: "unknown", reason: "unrecognized", native };
}

function geoServicesGeometry(
  metadata: HonuaLayerMetadata,
  fields: readonly LogicalField[],
  protocol: "geoservices-feature-service" | "geoservices-map-service",
): SourceGeometrySchema {
  const geometryFields = fields.filter((field) => field.type.kind === "geometry");
  if (geometryFields.length === 0) return { state: "none", reason: "no-geometry-fields" };
  const crs = geoServicesCrs(metadata.spatialReference ?? metadata.extent?.spatialReference, protocol);
  return {
    state: "known",
    fields: geometryFields.map((field) => ({
      field: field.name,
      geometryTypes: geoServicesGeometryType(metadata.geometryType, protocol),
      crs,
      layout: geoServicesCoordinateLayout(metadata),
      allowsEmpty: "unknown",
    })) as [GeometryFieldSchema, ...GeometryFieldSchema[]],
    primaryField:
      geometryFields.length === 1
        ? { state: "known", field: geometryFields[0]!.name }
        : { state: "unknown", reason: "conflicting" },
  };
}

function geoServicesGeometryType(
  type: EsriGeometryType | undefined,
  protocol: "geoservices-feature-service" | "geoservices-map-service",
): GeometryTypeKnowledge {
  switch (type) {
    case "esriGeometryPoint":
      return { state: "known", type: "Point" };
    case "esriGeometryMultipoint":
      return { state: "known", type: "MultiPoint" };
    case "esriGeometryPolyline":
      return { state: "mixed", types: ["LineString", "MultiLineString"] };
    case "esriGeometryPolygon":
      return { state: "mixed", types: ["MultiPolygon", "Polygon"] };
    case undefined:
      return { state: "unknown", reason: "missing" };
    default:
      return {
        state: "unknown",
        reason: type === "esriGeometryEnvelope" ? "unsupported" : "unrecognized",
        native: nativeReference(protocol, type, ["geometryType"]),
      };
  }
}

function geoServicesTemporal(metadata: HonuaLayerMetadata, fields: readonly HonuaFieldInfo[]): TemporalSchema {
  if (!metadata.timeInfo) return { state: "none" };
  const start = nonEmpty(metadata.timeInfo?.startTimeField);
  const end = nonEmpty(metadata.timeInfo?.endTimeField);
  const temporalFields = new Set(
    fields.filter((field) => field.type === "esriFieldTypeDate").map((field) => field.name),
  );
  if ((start && !temporalFields.has(start)) || (end && !temporalFields.has(end))) {
    return { state: "unknown", reason: "conflicting" };
  }
  if (start && end && start !== end) {
    return { state: "interval", startField: start, endField: end };
  }
  const instant = start ?? end;
  if (instant) return { state: "instant", field: instant };
  return { state: "unknown", reason: "conflicting" };
}

function geoServicesCoordinateLayout(metadata: HonuaLayerMetadata): GeometryFieldSchema["layout"] {
  if (metadata.hasZ === true && metadata.hasM === true) return "xyzm";
  if (metadata.hasZ === true) return "xyz";
  if (metadata.hasM === true) return "xym";
  if (metadata.hasZ === false && metadata.hasM === false) return "xy";
  return "unknown";
}

function odataField(
  field: HonuaOdataFieldInfo,
  keys: ReadonlySet<string>,
  typeName: string,
  metadata: HonuaOdataMetadata,
): LogicalField {
  const enumType = odataProjectionEnumTypes(metadata)?.[stripOdataNamespace(field.type)];
  const native = nativeReference("odata", field.type, [typeName, field.name], {
    ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    ...(field.precision === undefined ? {} : { precision: field.precision }),
    ...(field.scale === undefined ? {} : { scale: field.scale }),
    ...(field.srid === undefined ? {} : { srid: field.srid }),
    ...(enumType === undefined ? {} : { enumType }),
  });
  const type = odataLogicalType(field, native, metadata, [field.name], new Set());
  const roles: FieldRole[] = [];
  if (keys.has(field.name)) roles.push("primary-key", "feature-id");
  if (type.kind === "geometry") roles.push("geometry");
  return {
    name: field.name,
    path: [field.name],
    type,
    // CSDL key properties are non-nullable even when Nullable is omitted.
    // Preserve an explicit contradiction so contract validation fails closed.
    nullability: keys.has(field.name)
      ? field.nullable === true
        ? "nullable"
        : "non-nullable"
      : field.nullable === false
        ? "non-nullable"
        : "nullable",
    mutability: "unknown",
    roles,
    domain: odataDomain(field, metadata, native, type),
    constraints: notReportedConstraints(),
    native: [native],
  };
}

function odataLogicalType(
  field: HonuaOdataFieldInfo,
  native: NativeTypeReference,
  metadata: HonuaOdataMetadata,
  path: readonly [string, ...string[]],
  ancestors: ReadonlySet<string>,
  depth = 0,
): LogicalType {
  if (depth >= MAX_DISCOVERED_TYPE_DEPTH) return { kind: "unknown", reason: "unsupported", native };
  const collection = unwrapOdataCollection(field.type);
  if (collection !== undefined) {
    return {
      kind: "list",
      element: odataLogicalType({ ...field, type: collection }, native, metadata, path, ancestors, depth + 1),
    };
  }
  const typeName = stripOdataNamespace(field.type);
  const enumType = odataProjectionEnumTypes(metadata)?.[typeName];
  if (enumType) {
    return enumType.isFlags ? { kind: "unknown", reason: "unsupported", native } : { kind: "string" };
  }
  const complex = odataProjectionComplexTypes(metadata)?.[typeName];
  if (complex) {
    if (ancestors.has(typeName)) return { kind: "unknown", reason: "unsupported", native };
    const nestedAncestors = new Set(ancestors);
    nestedAncestors.add(typeName);
    return {
      kind: "struct",
      fields: complex.map((child) => {
        const childPath: [string, ...string[]] = [path[0], ...path.slice(1), child.name];
        const childEnumType = odataProjectionEnumTypes(metadata)?.[stripOdataNamespace(child.type)];
        const childNative = nativeReference("odata", child.type, [typeName, ...childPath], {
          ...(child.nullable === undefined ? {} : { nullable: child.nullable }),
          ...(child.maxLength === undefined ? {} : { maxLength: child.maxLength }),
          ...(child.precision === undefined ? {} : { precision: child.precision }),
          ...(child.scale === undefined ? {} : { scale: child.scale }),
          ...(childEnumType === undefined ? {} : { enumType: childEnumType }),
        });
        const childType = odataLogicalType(child, childNative, metadata, childPath, nestedAncestors, depth + 1);
        const roles: FieldRole[] = [];
        if (childType.kind === "geometry") roles.push("geometry");
        return {
          name: child.name,
          path: childPath,
          type: childType,
          nullability: child.nullable === false ? "non-nullable" : "nullable",
          mutability: "unknown",
          roles,
          domain: odataDomain(child, metadata, childNative, childType),
          constraints: notReportedConstraints(),
          native: [childNative],
        };
      }),
    };
  }
  switch (field.type) {
    case "Edm.Boolean":
      return { kind: "boolean" };
    case "Edm.Byte":
      return { kind: "integer", bits: 8, signed: false, jsonEncoding: "number" };
    case "Edm.SByte":
      return { kind: "integer", bits: 8, signed: true, jsonEncoding: "number" };
    case "Edm.Int16":
      return { kind: "integer", bits: 16, signed: true, jsonEncoding: "number" };
    case "Edm.Int32":
      return { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" };
    case "Edm.Int64":
      return { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" };
    case "Edm.Single":
      return odataFloatType(32);
    case "Edm.Double":
      return odataFloatType(64);
    case "Edm.Decimal":
      if (field.precision !== undefined && field.precision === 0) {
        return { kind: "unknown", reason: "unrecognized", native };
      }
      return {
        kind: "decimal",
        ...(field.precision === undefined ? {} : { precision: field.precision }),
        ...(field.scale === undefined ? { scale: 0 } : typeof field.scale === "number" ? { scale: field.scale } : {}),
        jsonEncoding: "string",
      };
    case "Edm.String":
      return { kind: "string", ...(typeof field.maxLength === "number" ? { maxLength: field.maxLength } : {}) };
    case "Edm.Binary":
      // OData uses unpadded base64url. The current contract has no dedicated
      // base64url discriminator, so retain the exact native type and avoid
      // falsely validating it as RFC 4648 base64 with `+`, `/`, and padding.
      return { kind: "binary", encoding: "opaque" };
    case "Edm.Guid":
      return { kind: "uuid" };
    case "Edm.Date":
      return { kind: "date" };
    case "Edm.TimeOfDay":
      return odataTemporalType("time", field.precision, native);
    case "Edm.DateTimeOffset":
      return odataTemporalType("timestamp", field.precision, native);
    case "Edm.Duration":
      return odataTemporalType("duration", field.precision, native);
    case "Edm.Stream":
      return { kind: "binary", encoding: "url" };
    default:
      return field.isSpatial || field.type.startsWith("Edm.Geography") || field.type.startsWith("Edm.Geometry")
        ? { kind: "geometry" }
        : { kind: "unknown", reason: "unrecognized", native };
  }
}

function odataFloatType(bits: 32 | 64): LogicalType {
  return {
    kind: "union",
    members: [
      { kind: "float", bits },
      { kind: "string", encoding: "odata-special-float" },
    ],
  };
}

function odataTemporalType(
  kind: "time" | "timestamp" | "duration",
  precision: number | undefined,
  native: NativeTypeReference,
): LogicalType {
  const digits = precision ?? 0;
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 12) {
    return { kind: "unknown", reason: "unrecognized", native };
  }
  if (digits > 9) return { kind: "unknown", reason: "unsupported", native };
  const unit = digits === 0 ? "second" : digits <= 3 ? "millisecond" : digits <= 6 ? "microsecond" : "nanosecond";
  if (kind === "timestamp") return { kind, unit, timezone: "offset" };
  return { kind, unit };
}

function odataDomain(
  field: HonuaOdataFieldInfo,
  metadata: HonuaOdataMetadata,
  native: NativeTypeReference,
  type: LogicalType,
): FieldValueDomain {
  const enumType = odataProjectionEnumTypes(metadata)?.[stripOdataNamespace(field.type)];
  if (!enumType) return domainInapplicable(type) ? { state: "none", reason: "not-applicable" } : notReportedDomain();
  if (type.kind !== "string") return { state: "unknown", reason: "unrecognized", native };
  if (enumType.declaration?.state === "invalid") {
    return { state: "unknown", reason: "unrecognized", native };
  }
  if (enumType.isFlags || enumType.members.length === 0) {
    return { state: "unknown", reason: enumType.isFlags ? "unrecognized" : "conflicting", native };
  }
  if (enumType.members.length > MAX_CODED_DOMAIN_VALUES) return { state: "unknown", reason: "limit-exceeded", native };
  const underlying = odataEnumUnderlyingType(enumType.underlyingType);
  if (!underlying) return { state: "unknown", reason: "unrecognized", native };
  const seen = new Set<string>();
  const values = [] as Array<{ value: string; label: string }>;
  for (const member of enumType.members) {
    if (!nonEmpty(member.name) || normalizeAdapterScalar(member.value, underlying) === undefined) {
      return { state: "unknown", reason: "unrecognized", native };
    }
    if (seen.has(member.name)) return { state: "unknown", reason: "conflicting", native };
    seen.add(member.name);
    values.push({ value: member.name, label: member.name });
  }
  return boundedDomain(
    {
      state: "coded",
      values: values as [{ value: string; label: string }, ...Array<{ value: string; label: string }>],
      openness: "closed",
    },
    native,
  );
}

function odataEnumUnderlyingType(type: string): LogicalType | undefined {
  switch (type) {
    case "Edm.Byte":
      return { kind: "integer", bits: 8, signed: false, jsonEncoding: "number" };
    case "Edm.SByte":
      return { kind: "integer", bits: 8, signed: true, jsonEncoding: "number" };
    case "Edm.Int16":
      return { kind: "integer", bits: 16, signed: true, jsonEncoding: "number" };
    case "Edm.Int32":
      return { kind: "integer", bits: 32, signed: true, jsonEncoding: "number" };
    case "Edm.Int64":
      return { kind: "integer", bits: 64, signed: true, jsonEncoding: "string" };
    default:
      return undefined;
  }
}

function odataGeometryType(type: string | undefined): GeometryTypeKnowledge {
  const suffix = type?.replace(/^Edm\.(?:Geography|Geometry)/, "");
  const mapped: Record<string, GeometryKind> = {
    Point: "Point",
    MultiPoint: "MultiPoint",
    LineString: "LineString",
    MultiLineString: "MultiLineString",
    Polygon: "Polygon",
    MultiPolygon: "MultiPolygon",
    Collection: "GeometryCollection",
  };
  if (suffix && mapped[suffix]) return { state: "known", type: mapped[suffix] };
  return suffix === "" ? { state: "unknown", reason: "missing" } : { state: "unknown", reason: "unrecognized" };
}

function odataCrs(field: HonuaOdataFieldInfo | undefined): CrsBinding {
  const geography = field?.type.startsWith("Edm.Geography") === true;
  const geometry = field?.type.startsWith("Edm.Geometry") === true;
  const standardDefault = field?.srid === undefined && (geography || geometry);
  const srid = field?.srid === undefined ? (geography ? 4326 : geometry ? 0 : undefined) : field.srid;
  const native = nativeReference("odata", field?.type ?? "spatial", [field?.name ?? "geometry"], {
    ...(srid === undefined ? {} : { srid }),
    ...(standardDefault ? { standardDefault: true } : {}),
  });
  const definition =
    typeof srid === "number" && srid > 0
      ? authorityDefinition("EPSG", String(srid))
      : ({
          kind: "unknown",
          reason: srid === undefined || srid === 0 ? "missing" : "unrecognized",
          native,
        } as const);
  return {
    definition,
    // OData 4.0 spatial JSON uses GeoJSON coordinate arrays. Definition-axis
    // order remains separate; unresolved CRS semantics still have x then y on
    // the wire.
    coordinateOrder: coordinateOrderOrConservativeXy(definition, "encoding"),
    provenance: {
      method: standardDefault ? "standard-default" : "metadata",
      native,
    },
  };
}

function geoParquetField(
  field: { readonly name: string; readonly type: string; readonly nullable?: boolean },
  geometryColumns: ReadonlySet<string>,
): LogicalField {
  const native = nativeReference("geoparquet", field.type || "unknown", [field.name]);
  const geometry = geometryColumns.has(field.name);
  const type = geometry ? ({ kind: "geometry" } as const) : duckDbLogicalType(field.type, native, [field.name]);
  const roles: FieldRole[] = [];
  if (geometry) roles.push("geometry");
  return {
    name: field.name,
    path: [field.name],
    type,
    nullability: field.nullable === true ? "nullable" : field.nullable === false ? "non-nullable" : "unknown",
    mutability: "unknown",
    roles,
    domain: domainInapplicable(type) ? { state: "none", reason: "not-applicable" } : notReportedDomain(),
    constraints: notReportedConstraints(),
    native: [native],
  };
}

function geoParquetProfileFields(
  profile: GeoParquetSourceProfile,
): Array<{ readonly name: string; readonly type: string }> {
  const fields = profile.fields ? [...profile.fields] : profile.columns.map((name) => ({ name, type: "" }));
  for (const geometry of geoParquetGeometryPlans(profile)) {
    if (!fields.some((field) => field.name === geometry.column)) {
      fields.push({
        name: geometry.column,
        type:
          geometry.execution === "duckdb-native"
            ? "GEOMETRY"
            : geometry.encoding === "geojson-compat"
              ? "VARCHAR"
              : geometry.encoding.startsWith("geoparquet-1.1-native-")
                ? "GEOPARQUET_NATIVE"
                : "BLOB",
      });
    }
  }
  return fields;
}

function duckDbLogicalType(
  rawType: string,
  native: NativeTypeReference,
  parentPath: readonly [string, ...string[]],
  depth = 0,
): LogicalType {
  if (depth >= MAX_DISCOVERED_TYPE_DEPTH) return { kind: "unknown", reason: "unsupported", native };
  const type = rawType.trim();
  if (!type) return { kind: "unknown", reason: "missing", native };
  const upper = type.toUpperCase();
  if (upper.endsWith("[]")) {
    return { kind: "list", element: duckDbLogicalType(type.slice(0, -2), native, parentPath, depth + 1) };
  }
  const list = /^LIST\((.*)\)$/i.exec(type);
  if (list) return { kind: "list", element: duckDbLogicalType(list[1]!, native, parentPath, depth + 1) };
  const struct = /^STRUCT\((.*)\)$/i.exec(type);
  if (struct) {
    const members: Array<LogicalField | undefined> = splitTopLevel(struct[1]!).map((member, index) => {
      const match = /^(?:"((?:[^"]|"")+)"|([^\s]+))\s+(.+)$/.exec(member.trim());
      if (!match) return undefined;
      const name = (match[1]?.replace(/""/g, '"') ?? match[2] ?? `field_${index}`).trim();
      const childPath: [string, ...string[]] = [parentPath[0], ...parentPath.slice(1), name];
      const childNative = nativeReference("geoparquet", match[3]!, childPath);
      const childType = duckDbLogicalType(match[3]!, childNative, childPath, depth + 1);
      return {
        name,
        path: childPath,
        type: childType,
        nullability: "unknown" as const,
        mutability: "unknown" as const,
        roles: [] as FieldRole[],
        domain: domainInapplicable(childType)
          ? ({ state: "none", reason: "not-applicable" } as const)
          : notReportedDomain(),
        constraints: notReportedConstraints(),
        native: [childNative],
      };
    });
    return members.every((member): member is LogicalField => member !== undefined)
      ? { kind: "struct", fields: members }
      : { kind: "unknown", reason: "unrecognized", native };
  }
  if (upper === "BOOLEAN" || upper === "BOOL") return { kind: "boolean" };
  if (upper === "TINYINT" || upper === "INT1") return integer(8, true);
  if (upper === "UTINYINT") return integer(8, false);
  if (upper === "SMALLINT" || upper === "INT2" || upper === "SHORT") return integer(16, true);
  if (upper === "USMALLINT") return integer(16, false);
  if (upper === "INTEGER" || upper === "INT" || upper === "INT4" || upper === "SIGNED") return integer(32, true);
  if (upper === "UINTEGER") return integer(32, false);
  if (upper === "BIGINT" || upper === "INT8" || upper === "LONG") return integer(64, true);
  if (upper === "UBIGINT") return integer(64, false);
  if (upper === "REAL" || upper === "FLOAT4" || upper === "FLOAT") return { kind: "float", bits: 32 };
  if (upper === "DOUBLE" || upper === "FLOAT8") return { kind: "float", bits: 64 };
  const decimal = /^(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(type);
  if (decimal) {
    return {
      kind: "decimal",
      precision: Number(decimal[1]),
      scale: Number(decimal[2]),
      jsonEncoding: "string",
    };
  }
  if (/^(?:DECIMAL|NUMERIC)$/i.test(type)) return { kind: "decimal", jsonEncoding: "string" };
  const varchar = /^(?:VARCHAR|CHAR|BPCHAR)\s*\(\s*(\d+)\s*\)$/i.exec(type);
  if (varchar) return { kind: "string", maxLength: Number(varchar[1]) };
  if (/^(?:VARCHAR|CHAR|BPCHAR|TEXT|STRING)$/i.test(type)) return { kind: "string" };
  if (/^(?:BLOB|BYTEA|BINARY|VARBINARY)$/i.test(type)) return { kind: "binary", encoding: "base64" };
  if (upper === "UUID") return { kind: "uuid" };
  if (upper === "DATE") return { kind: "date" };
  if (upper === "TIMETZ" || upper.includes("TIME WITH TIME ZONE")) {
    return { kind: "unknown", reason: "unsupported", native };
  }
  if (upper.startsWith("TIME") && !upper.startsWith("TIMESTAMP"))
    return { kind: "time", unit: duckTemporalUnit(upper) };
  if (upper.startsWith("TIMESTAMP")) {
    if (upper.includes("_NS")) return { kind: "unknown", reason: "unsupported", native };
    return {
      kind: "timestamp",
      unit: duckTemporalUnit(upper),
      timezone: /(?:TZ|WITH TIME ZONE)$/.test(upper) ? "utc" : "local",
    };
  }
  if (upper === "INTERVAL") return { kind: "unknown", reason: "unsupported", native };
  if (upper === "JSON") return { kind: "json" };
  if (upper.includes("GEOMETRY") || upper.includes("GEOGRAPHY")) return { kind: "geometry" };
  return {
    kind: "unknown",
    reason: /^(?:HUGEINT|UHUGEINT|MAP|UNION)/.test(upper) ? "unsupported" : "unrecognized",
    native,
  };
}

function geoParquetGeometry(
  profile: GeoParquetSourceProfile,
  fields: readonly LogicalField[],
  geometries: readonly GeoParquetGeometryPlan[],
): SourceGeometrySchema {
  if (geometries.length === 0) return { state: "none", reason: "no-geometry-fields" };
  const invalid = geometries.find(
    (geometry) => !fields.some((field) => field.name === geometry.column && field.type.kind === "geometry"),
  );
  if (invalid) {
    return {
      state: "unknown",
      reason: "conflicting",
      native: nativeReference("geoparquet", invalid.column, ["geo", "columns", invalid.column]),
    };
  }
  const primary = profile.geometry;
  return {
    state: "known",
    fields: geometries.map((geometry) => {
      const parsed = geoParquetGeometryTypes(
        geometry.column,
        geometry.geometryTypes,
        geometry.geometryTypesState,
        geometry.metadataState,
      );
      return {
        field: geometry.column,
        geometryTypes: parsed.knowledge,
        crs: geoParquetCrs(profile, geometry),
        layout: parsed.layout,
        allowsEmpty: "unknown",
      };
    }) as [GeometryFieldSchema, ...GeometryFieldSchema[]],
    primaryField: primary ? { state: "known", field: primary.column } : { state: "none", reason: "no-default" },
  };
}

function geoParquetGeometryTypes(
  column: string,
  values: readonly string[] | undefined,
  state: "valid" | "missing" | "invalid" | "conflicting" | undefined,
  metadataState: "valid" | "invalid" | "missing" | undefined,
): { knowledge: GeometryTypeKnowledge; layout: "xy" | "xyz" | "unknown" } {
  const native = nativeReference("geoparquet", "geometry_types", ["geo", "columns", column, "geometry_types"], values);
  if (metadataState !== "valid") {
    return {
      knowledge: {
        state: "unknown",
        reason:
          state === "conflicting"
            ? "conflicting"
            : state === "invalid"
              ? "unrecognized"
              : metadataState === "invalid"
                ? "conflicting"
                : "missing",
        native,
      },
      layout: "unknown",
    };
  }
  if (state === "invalid")
    return { knowledge: { state: "unknown", reason: "unrecognized", native }, layout: "unknown" };
  if (state === "conflicting" || (values && new Set(values).size !== values.length)) {
    return { knowledge: { state: "unknown", reason: "conflicting", native }, layout: "unknown" };
  }
  if (!values || values.length === 0)
    return { knowledge: { state: "unknown", reason: "missing", native }, layout: "unknown" };
  const kinds: GeometryKind[] = [];
  const layouts = new Set<"xy" | "xyz">();
  for (const value of values) {
    const match = /^(Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection)(?: Z)?$/.exec(
      value,
    );
    if (!match) return { knowledge: { state: "unknown", reason: "unrecognized", native }, layout: "unknown" };
    const canonical = geometryKindCase(match[1]!);
    if (!canonical) return { knowledge: { state: "unknown", reason: "unrecognized", native }, layout: "unknown" };
    kinds.push(canonical);
    layouts.add(value.endsWith(" Z") ? "xyz" : "xy");
  }
  const uniqueKinds = [...new Set(kinds)].sort();
  const knowledge: GeometryTypeKnowledge =
    uniqueKinds.length === 1
      ? { state: "known", type: uniqueKinds[0]! }
      : { state: "mixed", types: uniqueKinds as [GeometryKind, GeometryKind, ...GeometryKind[]] };
  return { knowledge, layout: layouts.size === 1 ? [...layouts][0]! : "unknown" };
}

function geoParquetCrs(profile: GeoParquetSourceProfile, geometry: GeoParquetGeometryPlan): CrsBinding {
  const native = nativeReference("geoparquet", "crs", ["geo", "columns", geometry?.column ?? "geometry", "crs"], {
    metadataState: geometry.metadataState ?? "missing",
    crsState: geometry.crsState ?? "missing-metadata",
    ...(geometry.crsValue === undefined ? {} : { crs: geometry.crsValue }),
    ...(geometry.epochState === undefined ? {} : { epochState: geometry.epochState }),
    ...(geometry.epochValue === undefined ? {} : { epoch: geometry.epochValue }),
  });
  let definition: CrsDefinition;
  let method: "metadata" | "standard-default" = "metadata";
  const invalidEpoch =
    geometry.epochState === "invalid" ||
    (geometry.coordinateEpoch !== undefined && !Number.isFinite(geometry.coordinateEpoch));
  if (invalidEpoch || geometry.metadataState === "invalid" || geometry.crsState === "invalid-metadata") {
    definition = { kind: "unknown", reason: "conflicting", native };
  } else if (geometry?.crsState === "absent" && geometry.metadataState === "valid") {
    definition = authorityDefinition("OGC", "CRS84", "http://www.opengis.net/def/crs/OGC/1.3/CRS84");
    method = "standard-default";
  } else if (geometry?.crsState === "null" || geometry?.crsState === "missing-metadata") {
    definition = { kind: "unknown", reason: "missing", native };
  } else if (geometry?.crsState === "value") {
    definition = crsFromGeoParquetValue(geometry.crsValue, native);
  } else if (profile.geometry?.column === geometry.column && profile.crs) {
    definition = crsFromValue(profile.crs, native);
  } else {
    definition = { kind: "unknown", reason: "missing", native };
  }
  const coordinateEpoch =
    !invalidEpoch &&
    geometry.metadataState === "valid" &&
    geometry.coordinateEpoch !== undefined &&
    (geometry.epochState === undefined || geometry.epochState === "valid")
      ? geometry.coordinateEpoch
      : undefined;
  const conformingGeoParquetEncoding =
    geometry.metadataState === "valid" &&
    (geometry.crsState === "absent" || geometry.crsState === "null" || geometry.crsState === "value");
  return {
    definition,
    coordinateOrder: invalidEpoch
      ? { state: "unknown", reason: "conflicting", native }
      : geoParquetCoordinateOrder(definition, native, conformingGeoParquetEncoding),
    ...(coordinateEpoch === undefined ? {} : { coordinateEpoch }),
    provenance: { method, native },
  };
}

function geoParquetCoordinateOrder(
  definition: CrsDefinition,
  native: NativeTypeReference,
  conformingMetadata: boolean,
): AxisOrder {
  const conservativeXyOrder = (): AxisOrder => ({
    state: "known",
    source: "encoding",
    axes: [
      { name: "x", direction: "other", unit: "unknown" },
      { name: "y", direction: "other", unit: "unknown" },
    ],
  });
  if (definition.kind === "projjson" && definition.definitionAxisOrder.state === "known") {
    const axes = definition.definitionAxisOrder.axes;
    const eastWest = axes.filter((axis) => axis.direction === "east" || axis.direction === "west");
    const northSouth = axes.filter((axis) => axis.direction === "north" || axis.direction === "south");
    if (eastWest.length === 1 && northSouth.length === 1) {
      const x = eastWest[0]!;
      const y = northSouth[0]!;
      return {
        state: "known",
        source: "encoding",
        axes: [x, y, ...axes.filter((axis) => axis !== x && axis !== y)],
      };
    }
    if (conformingMetadata) return conservativeXyOrder();
  }
  const order = coordinateOrderFor(definition, "encoding");
  if (order.state === "known") return order;
  if (conformingMetadata) return conservativeXyOrder();
  return { ...order, native };
}

function geoParquetGeometryPlans(profile: GeoParquetSourceProfile): readonly GeoParquetGeometryPlan[] {
  return profile.geometries ?? (profile.geometry ? [profile.geometry] : []);
}

function geoServicesCrs(
  spatialReference: HonuaSpatialReference | undefined,
  protocol: "geoservices-feature-service" | "geoservices-map-service",
): CrsBinding {
  const native = nativeReference(protocol, "spatialReference", ["spatialReference"], spatialReference);
  let definition: CrsDefinition;
  const declaredWkt = nonEmpty(spatialReference?.wkt);
  if (declaredWkt) {
    const wkt = declaredWkt;
    const dialect = recognizedWktDialect(wkt);
    definition = dialect
      ? {
          kind: "wkt",
          wkt,
          dialect,
          validation: "unverified",
          definitionAxisOrder: { state: "unknown", reason: "unrecognized", native },
        }
      : { kind: "unknown", reason: "unrecognized", native };
  } else {
    const declaredWkid =
      Number.isSafeInteger(spatialReference?.wkid) && spatialReference!.wkid! > 0 ? spatialReference!.wkid! : undefined;
    const latestWkid =
      Number.isSafeInteger(spatialReference?.latestWkid) && spatialReference!.latestWkid! > 0
        ? spatialReference!.latestWkid!
        : undefined;
    const canonicalDeclaredWkid = canonicalGeoServicesWkid(declaredWkid);
    const canonicalLatestWkid = canonicalGeoServicesWkid(latestWkid);
    const conflictingPair =
      canonicalDeclaredWkid !== undefined &&
      canonicalLatestWkid !== undefined &&
      canonicalDeclaredWkid !== canonicalLatestWkid &&
      recognizedGeoServicesAuthorityWkid(canonicalDeclaredWkid) &&
      recognizedGeoServicesAuthorityWkid(canonicalLatestWkid);
    // Esri defines latestWkid as the current identifier for the same spatial
    // reference. Prefer it when present; only call a pair contradictory when
    // both identifiers independently resolve to different reviewed CRSs.
    const wkid = conflictingPair ? undefined : (canonicalLatestWkid ?? canonicalDeclaredWkid);
    if (wkid === undefined) {
      definition = {
        kind: "unknown",
        reason: conflictingPair
          ? "conflicting"
          : declaredWkid === undefined && latestWkid === undefined
            ? "missing"
            : "unrecognized",
        native,
      };
    } else if (wkid === 4326 || wkid === 3857) {
      definition = authorityDefinition("EPSG", String(wkid));
    } else {
      definition = { kind: "unknown", reason: "unrecognized", native };
    }
  }
  return {
    definition,
    // GeoServices point arrays and every vertex encode x at index 0 and y at
    // index 1, independently of the spatial-reference definition axis order.
    coordinateOrder: coordinateOrderOrConservativeXy(definition, "encoding"),
    provenance: { method: "metadata", native },
  };
}

function recognizedWktDialect(value: string): "wkt1" | "wkt2" | undefined {
  const root = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*([[(])/.exec(value);
  if (!root || !balancedWktDelimiters(value.slice(root[0].length - 1))) return undefined;
  const name = root[1]!.toUpperCase();
  const body = value.slice(root[0].length);
  if (name === "BOUNDCRS") {
    if (!/^\s*SOURCECRS\s*[[(]/i.test(body) || !/\bTARGETCRS\s*[[(]/i.test(body)) return undefined;
  } else if (!/^\s*"(?:[^"]|"")+"\s*(?:,|[\])])/.test(body)) {
    return undefined;
  }
  if (new Set(["GEOGCS", "PROJCS", "GEOCCS", "VERT_CS", "LOCAL_CS", "COMPD_CS", "FITTED_CS"]).has(name)) {
    return "wkt1";
  }
  if (
    new Set([
      "GEODCRS",
      "GEOGCRS",
      "PROJCRS",
      "VERTCRS",
      "ENGCRS",
      "PARAMETRICCRS",
      "TIMECRS",
      "COMPOUNDCRS",
      "BOUNDCRS",
      "DERIVEDPROJCRS",
    ]).has(name)
  ) {
    return "wkt2";
  }
  return undefined;
}

function balancedWktDelimiters(value: string): boolean {
  const delimiters: string[] = [];
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '"') {
      if (quoted && value[index + 1] === '"') index++;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "[" || character === "(") delimiters.push(character);
    else if (character === "]" || character === ")") {
      const opening = delimiters.pop();
      if ((character === "]" && opening !== "[") || (character === ")" && opening !== "(")) return false;
      if (delimiters.length === 0) return value.slice(index + 1).trim() === "";
    }
  }
  return false;
}

function canonicalGeoServicesWkid(value: number | undefined): number | undefined {
  return value === 102100 || value === 102113 ? 3857 : value;
}

function recognizedGeoServicesAuthorityWkid(value: number): boolean {
  return value === 4326 || value === 3857;
}

function crsFromValue(value: unknown, native: NativeTypeReference): CrsDefinition {
  if (typeof value === "string") {
    const authority = /^([A-Za-z][A-Za-z0-9_-]*):([^\s:]+)$/.exec(value);
    if (authority) return authorityDefinition(authority[1]!.toUpperCase(), authority[2]!);
    try {
      return {
        kind: "uri",
        uri: new URL(value).toString(),
        definitionAxisOrder: { state: "unknown", reason: "unrecognized", native },
      };
    } catch {
      return { kind: "unknown", reason: "unrecognized", native };
    }
  }
  const json = boundedJson(value);
  if (json && !Array.isArray(json) && typeof json === "object") {
    const projjson = json as JsonObject;
    if (typeof projjson.type === "string") {
      const axis = projJsonAxisOrder(projjson, native);
      try {
        return validateSourceCrsDefinition({
          kind: "projjson",
          projjson,
          ...(typeof projjson.name === "string" ? { name: projjson.name } : {}),
          definitionAxisOrder: axis,
        });
      } catch {
        return { kind: "unknown", reason: "unrecognized", native };
      }
    }
  }
  return { kind: "unknown", reason: value === null || value === undefined ? "missing" : "unrecognized", native };
}

function crsFromGeoParquetValue(value: unknown, native: NativeTypeReference): CrsDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "unknown", reason: value === null || value === undefined ? "missing" : "unrecognized", native };
  }
  return crsFromValue(value, native);
}

function authorityDefinition(authority: string, code: string, uri?: string): CrsDefinition {
  const definitionAxisOrder = authorityAxisOrder(authority, code);
  return { kind: "authority", authority, code, ...(uri ? { uri } : {}), definitionAxisOrder };
}

function authorityAxisOrder(authority: string, code: string): AxisOrder {
  if (authority === "EPSG" && code === "4326") {
    return {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "geodetic latitude", direction: "north", unit: "degree" },
        { name: "geodetic longitude", direction: "east", unit: "degree" },
      ],
    };
  }
  if (authority === "EPSG" && code === "3857") {
    return {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "easting", direction: "east", unit: "metre" },
        { name: "northing", direction: "north", unit: "metre" },
      ],
    };
  }
  if (authority === "OGC" && code === "CRS84") {
    return {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "longitude", direction: "east", unit: "degree" },
        { name: "latitude", direction: "north", unit: "degree" },
      ],
    };
  }
  return { state: "unknown", reason: "unrecognized" };
}

function coordinateOrderFor(definition: CrsDefinition, source: "encoding" | "protocol"): AxisOrder {
  if (definition.kind === "authority" && definition.authority === "EPSG" && definition.code === "4326") {
    return {
      state: "known",
      source,
      axes: [
        { name: "longitude", direction: "east", unit: "degree" },
        { name: "latitude", direction: "north", unit: "degree" },
      ],
    };
  }
  if (definition.kind === "authority" && definition.authority === "OGC" && definition.code === "CRS84") {
    return {
      state: "known",
      source,
      axes: [
        { name: "longitude", direction: "east", unit: "degree" },
        { name: "latitude", direction: "north", unit: "degree" },
      ],
    };
  }
  if (definition.kind === "authority" && definition.authority === "EPSG" && definition.code === "3857") {
    return {
      state: "known",
      source,
      axes: [
        { name: "easting", direction: "east", unit: "metre" },
        { name: "northing", direction: "north", unit: "metre" },
      ],
    };
  }
  if (definition.kind === "projjson" && definition.definitionAxisOrder.state === "known") {
    return { ...definition.definitionAxisOrder, source };
  }
  return { state: "unknown", reason: definition.kind === "unknown" ? definition.reason : "unrecognized" };
}

function coordinateOrderOrConservativeXy(definition: CrsDefinition, source: "encoding" | "protocol"): AxisOrder {
  const resolved = coordinateOrderFor(definition, source);
  return resolved.state === "known" ? resolved : conservativeEncodedXyOrder();
}

function conservativeEncodedXyOrder(): AxisOrder {
  return {
    state: "known",
    source: "encoding",
    axes: [
      { name: "x", direction: "other", unit: "unknown" },
      { name: "y", direction: "other", unit: "unknown" },
    ],
  };
}

function projJsonAxisOrder(projjson: JsonObject, native: NativeTypeReference): AxisOrder {
  const coordinateSystem = projjson.coordinate_system;
  if (!isJsonRecord(coordinateSystem)) {
    return { state: "unknown", reason: "missing", native };
  }
  const axes = coordinateSystem.axis;
  if (!Array.isArray(axes) || axes.length < 2) return { state: "unknown", reason: "missing", native };
  const mapped = axes.map((axis) => {
    if (!axis || Array.isArray(axis) || typeof axis !== "object") return undefined;
    const direction = axis.direction;
    const unit = axis.unit;
    if (typeof direction !== "string" || typeof unit !== "string") return undefined;
    const normalizedDirection = direction.toLowerCase();
    const allowed = ["east", "west", "north", "south", "up", "down", "future", "past", "other"] as const;
    if (!allowed.includes(normalizedDirection as (typeof allowed)[number])) return undefined;
    return {
      name: typeof axis.name === "string" ? axis.name : direction,
      ...(typeof axis.abbreviation === "string" ? { abbreviation: axis.abbreviation } : {}),
      direction: normalizedDirection as (typeof allowed)[number],
      unit,
    };
  });
  if (mapped.some((axis) => axis === undefined)) return { state: "unknown", reason: "unrecognized", native };
  return {
    state: "known",
    source: "crs-definition",
    axes: mapped as [
      NonNullable<(typeof mapped)[number]>,
      NonNullable<(typeof mapped)[number]>,
      ...NonNullable<(typeof mapped)[number]>[],
    ],
  };
}

function nativeReference(
  protocol: SourceProtocol,
  name: string,
  path: readonly string[],
  definition?: unknown,
): NativeTypeReference {
  const safe = definition === undefined ? undefined : boundedJson(definition);
  return { protocol, name: name || "unknown", path, ...(safe === undefined ? {} : { definition: safe }) };
}

function boundedJson(value: unknown): JsonValue | undefined {
  try {
    const json = toJsonValue(value) as JsonValue;
    return new TextEncoder().encode(canonicalStringify(json)).byteLength <= MAX_NATIVE_DEFINITION_BYTES
      ? json
      : undefined;
  } catch {
    return undefined;
  }
}

function provenance(context: SchemaNormalizationContext): MetadataProvenance {
  return {
    method: "observed",
    protocol: context.protocol,
    source: context.source,
    ...(context.observedAt ? { observedAt: context.observedAt } : {}),
    ...(context.validator ? { validator: context.validator } : {}),
  };
}

function normalizedDefault(
  value: unknown,
  type: LogicalType,
  nonNullable: boolean,
): { readonly defaultValue: JsonValue } | Record<string, never> {
  if (value === null) return nonNullable ? {} : { defaultValue: null };
  const scalar = normalizeAdapterScalar(value, type);
  if (scalar !== undefined) return { defaultValue: scalar };
  if (type.kind !== "json" && type.kind !== "unknown" && type.kind !== "geometry") return {};
  const safe = boundedJson(value);
  if (safe === undefined) return {};
  if (type.kind === "geometry" && !canonicalGeometryValue(safe)) return {};
  return { defaultValue: safe };
}

function normalizeAdapterOrderedScalar(value: unknown, type: LogicalType): string | number | undefined {
  const normalized = normalizeAdapterScalar(value, type);
  return typeof normalized === "string" || typeof normalized === "number" ? normalized : undefined;
}

/** Normalize protocol scalars into the contract's declared JSON encoding. */
function normalizeAdapterScalar(value: unknown, type: LogicalType): string | number | boolean | undefined {
  switch (type.kind) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "integer": {
      if (type.jsonEncoding === "string") {
        if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
        if (typeof value !== "string" || !canonicalInteger(value, type.bits, type.signed)) return undefined;
        return value;
      }
      if (typeof value === "string" && canonicalInteger(value, type.bits, type.signed)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
      }
      return typeof value === "number" && Number.isSafeInteger(value) && integerFits(value, type.bits, type.signed)
        ? value
        : undefined;
    }
    case "float":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "decimal":
      return type.jsonEncoding === "string"
        ? typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
          ? value
          : undefined
        : typeof value === "number" && Number.isFinite(value)
          ? value
          : undefined;
    case "string":
      return typeof value === "string" && (type.maxLength === undefined || value.length <= type.maxLength)
        ? value
        : undefined;
    case "binary":
      return typeof value === "string" &&
        (type.encoding === "opaque" ||
          (type.encoding === "base64" &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) ||
          (type.encoding === "url" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)))
        ? value
        : undefined;
    case "uuid": {
      if (typeof value !== "string") return undefined;
      const normalized = value.replace(/^\{(.+)\}$/, "$1").toLowerCase();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized) ? normalized : undefined;
    }
    case "timestamp": {
      if (type.timezone !== "utc") return typeof value === "string" ? value : undefined;
      if (typeof value === "string") return normalizeUtcMillisecondTimestamp(value);
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
      try {
        return new Date(value).toISOString();
      } catch {
        return undefined;
      }
    }
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
    case "time":
      return typeof value === "string" && /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value : undefined;
    case "duration":
      return typeof value === "string" && /^-?P/.test(value) ? value : undefined;
    case "json":
    case "unknown":
      return typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
        ? value
        : undefined;
    case "union": {
      const values = type.members
        .map((member) => normalizeAdapterScalar(value, member))
        .filter((candidate): candidate is string | number | boolean => candidate !== undefined);
      if (values.length === 0) return undefined;
      const identities = new Set(values.map((candidate) => canonicalStringify(toJsonValue(candidate))));
      return identities.size === 1 ? values[0] : undefined;
    }
    case "geometry":
    case "list":
    case "struct":
      return undefined;
  }
}

function adapterRangeType(type: LogicalType): boolean {
  return (
    type.kind === "integer" ||
    type.kind === "float" ||
    type.kind === "decimal" ||
    type.kind === "string" ||
    type.kind === "date" ||
    type.kind === "time" ||
    type.kind === "timestamp" ||
    type.kind === "unknown"
  );
}

function normalizeUtcMillisecondTimestamp(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? "").padEnd(3, "0")}Z`;
}

function canonicalInteger(value: string, bits: 8 | 16 | 32 | 64, signed: boolean): boolean {
  if (value.length > 20) return false;
  if (!(signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value) || value === "-0") return false;
  try {
    return integerBigIntFits(BigInt(value), bits, signed);
  } catch {
    return false;
  }
}

function integerFits(value: number, bits: 8 | 16 | 32 | 64, signed: boolean): boolean {
  return Number.isSafeInteger(value) && integerBigIntFits(BigInt(value), bits, signed);
}

function integerBigIntFits(value: bigint, bits: 8 | 16 | 32 | 64, signed: boolean): boolean {
  const width = BigInt(bits);
  const minimum = signed ? -(1n << (width - 1n)) : 0n;
  const maximum = signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
  return value >= minimum && value <= maximum;
}

function compareAdapterOrderedValues(left: string | number, right: string | number, type: LogicalType): number {
  if (typeof left === "number" && typeof right === "number") return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left !== "string" || typeof right !== "string") return 0;
  if (type.kind === "integer") {
    const leftInteger = BigInt(left);
    const rightInteger = BigInt(right);
    return leftInteger === rightInteger ? 0 : leftInteger < rightInteger ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function boundedDomain(domain: FieldValueDomain, native: NativeTypeReference): FieldValueDomain {
  try {
    const bytes = new TextEncoder().encode(
      canonicalStringify(toJsonValue({ domain, constraints: notReportedConstraints() })),
    ).byteLength;
    return bytes <= MAX_FIELD_DOMAIN_BYTES ? domain : { state: "unknown", reason: "limit-exceeded", native };
  } catch {
    return { state: "unknown", reason: "unrecognized", native };
  }
}

function canonicalGeometryValue(value: JsonValue): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const record = value as JsonObject;
  if (typeof record.type !== "string") return false;
  if (record.type === "GeometryCollection") {
    return (
      Object.keys(record).length === 2 &&
      Array.isArray(record.geometries) &&
      record.geometries.length > 0 &&
      record.geometries.every(canonicalGeometryValue)
    );
  }
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "coordinates")) return false;
  const position = (candidate: JsonValue): boolean =>
    Array.isArray(candidate) &&
    candidate.length >= 2 &&
    candidate.length <= 4 &&
    candidate.every((ordinate) => typeof ordinate === "number" && Number.isFinite(ordinate));
  const positions = (candidate: JsonValue, minimum: number): boolean =>
    Array.isArray(candidate) && candidate.length >= minimum && candidate.every(position);
  const rings = (candidate: JsonValue): boolean =>
    Array.isArray(candidate) && candidate.length > 0 && candidate.every((ring) => positions(ring, 4));
  switch (record.type) {
    case "Point":
      return position(record.coordinates!);
    case "MultiPoint":
      return positions(record.coordinates!, 1);
    case "LineString":
      return positions(record.coordinates!, 2);
    case "MultiLineString":
      return (
        Array.isArray(record.coordinates) &&
        record.coordinates.length > 0 &&
        record.coordinates.every((line) => positions(line, 2))
      );
    case "Polygon":
      return rings(record.coordinates!);
    case "MultiPolygon":
      return Array.isArray(record.coordinates) && record.coordinates.length > 0 && record.coordinates.every(rings);
    default:
      return false;
  }
}

function integer(bits: 8 | 16 | 32 | 64, signed: boolean): LogicalType {
  return { kind: "integer", bits, signed, jsonEncoding: bits === 64 ? "string" : "number" };
}

function duckTemporalUnit(type: string): "second" | "millisecond" | "microsecond" | "nanosecond" {
  if (/(?:_S\b|\(0\))/.test(type)) return "second";
  if (/(?:_MS\b|\(3\))/.test(type)) return "millisecond";
  if (/(?:_NS\b|\(9\))/.test(type)) return "nanosecond";
  return "microsecond";
}

function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && character === "(") depth++;
    else if (!quoted && character === ")") depth--;
    else if (!quoted && depth === 0 && character === ",") {
      out.push(value.slice(start, index));
      start = index + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function geometryKindCase(value: string): GeometryKind | undefined {
  const normalized = value.toLowerCase();
  return geometryKinds[normalized as keyof typeof geometryKinds];
}

const geometryKinds = {
  point: "Point",
  multipoint: "MultiPoint",
  linestring: "LineString",
  multilinestring: "MultiLineString",
  polygon: "Polygon",
  multipolygon: "MultiPolygon",
  geometrycollection: "GeometryCollection",
} as const;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validLength(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function domainInapplicable(type: LogicalType): boolean {
  return type.kind === "geometry" || type.kind === "list" || type.kind === "struct";
}

function notReportedDomain(): FieldValueDomain {
  return { state: "unknown", reason: "not-reported" };
}

function notReportedConstraints(): LogicalField["constraints"] {
  return { state: "unknown", reason: "not-reported" };
}

function orderedValue(value: unknown): value is string | number {
  return (typeof value === "string" && value !== "") || (typeof value === "number" && Number.isFinite(value));
}

function stripOdataNamespace(value: string): string {
  const index = value.lastIndexOf(".");
  return index === -1 ? value : value.slice(index + 1);
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}
