import descriptorSchema from "../../config/publication-descriptor.v1.schema.json" with { type: "json" };
import { HonuaPublicationError } from "./errors.js";

export type PublicationFieldType = "string" | "integer" | "number" | "boolean" | "date" | "datetime";
export type PublicationBounds = readonly [west: number, south: number, east: number, north: number];

export interface PublicationField {
  readonly name: string;
  readonly type: PublicationFieldType;
  readonly public: boolean;
  readonly title?: string;
  readonly description?: string;
}

export interface PublicationArtifact {
  readonly href: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly captureId: string;
  readonly fields: readonly string[];
}

export interface PublicationPmtilesArtifact extends PublicationArtifact {
  readonly vectorLayer: string;
  readonly minzoom: number;
  readonly maxzoom: number;
}

export interface PublicationGeoParquetArtifact extends PublicationArtifact {
  readonly rowGroups?: number;
  readonly sortedBy?: string;
}

export interface PublicationIdentity {
  readonly field: string;
  readonly type: "string";
  readonly pmtilesProperty: string;
  readonly geoparquetColumn: string;
}

export interface PublicationGeometry {
  readonly column: string;
  readonly encoding:
    | "wkb"
    | "geoarrow-point"
    | "geoarrow-linestring"
    | "geoarrow-polygon"
    | "geoarrow-multipoint"
    | "geoarrow-multilinestring"
    | "geoarrow-multipolygon";
  readonly types: readonly string[];
  readonly bboxColumn?: string;
}

/** A paired PMTiles + GeoParquet publication, as published by Honua (descriptor v1). */
export interface PublicationDescriptorV1 {
  readonly $schema?: string;
  readonly descriptorVersion: "1.0";
  readonly publicationId: string;
  readonly version: string;
  readonly title?: string;
  readonly publishedAt: string;
  readonly sourceLayer: {
    readonly service: string;
    readonly layer: string;
    readonly title?: string;
    readonly href?: string;
  };
  readonly capture: {
    readonly captureId: string;
    readonly capturedAt: string;
    readonly sourceRevision: string;
    readonly featureCount: number;
    readonly filter?: { readonly bbox?: PublicationBounds; readonly where?: string };
  };
  readonly bounds: PublicationBounds;
  readonly crs: { readonly source: string; readonly geoparquet: string; readonly pmtiles: "EPSG:3857" };
  readonly fields: readonly PublicationField[];
  readonly identity: PublicationIdentity;
  readonly geometry: PublicationGeometry;
  readonly artifacts: {
    readonly pmtiles: PublicationPmtilesArtifact;
    readonly geoparquet: PublicationGeoParquetArtifact;
    readonly [role: string]: PublicationArtifact;
  };
  readonly validation: {
    readonly status: "passed" | "failed";
    readonly validatedAt: string;
    readonly checks: readonly {
      readonly name: string;
      readonly status: "passed" | "failed" | "unavailable";
      readonly detail?: string;
    }[];
  };
  readonly links: { readonly stac: string; readonly self?: string; readonly source?: string };
  readonly provenance?: { readonly publisher?: string; readonly license?: string; readonly attribution?: string };
}

/** One reason a descriptor is invalid: `schema` for a schema violation, otherwise the cross-field rule. */
export interface PublicationDescriptorIssue {
  readonly rule: "schema" | PublicationDescriptorRule;
  readonly path: string;
  readonly message: string;
}

export type PublicationDescriptorRule =
  | "capture-id"
  | "unique-field-names"
  | "public-fields-only"
  | "identity-mapping"
  | "bounds-order"
  | "zoom-order";

type JsonSchema = { readonly [keyword: string]: unknown };
type JsonObject = { readonly [key: string]: unknown };

const ROOT_SCHEMA = descriptorSchema as JsonSchema;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveReference(reference: string): JsonSchema {
  if (!reference.startsWith("#/")) throw new Error(`Unsupported schema reference ${reference}`);
  let target: unknown = ROOT_SCHEMA;
  for (const segment of reference.slice(2).split("/")) target = (target as JsonObject)[segment];
  return target as JsonSchema;
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function formatMatches(format: unknown, value: string): boolean {
  if (format === "date-time") return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
  if (format === "uri") return URL.canParse(value);
  if (format === "uri-reference") return !/[\s\\<>"{}|^`]/.test(value);
  return true;
}

class SchemaWalk {
  readonly issues: PublicationDescriptorIssue[] = [];

  validate(schema: JsonSchema, value: unknown, path: string): Set<string> {
    const evaluated = new Set<string>();
    if (typeof schema.$ref === "string") {
      for (const key of this.validate(resolveReference(schema.$ref), value, path)) evaluated.add(key);
    }
    if (Array.isArray(schema.allOf)) {
      for (const part of schema.allOf as JsonSchema[]) {
        for (const key of this.validate(part, value, path)) evaluated.add(key);
      }
    }
    if (schema.type !== undefined && !typeMatches(schema.type, value)) {
      this.fail(path, `must be ${String(schema.type)}`);
      return evaluated;
    }
    this.checkValue(schema, value, path);
    if (typeof value === "string") this.checkString(schema, value, path);
    if (Array.isArray(value)) this.checkArray(schema, value, path);
    if (isObject(value)) {
      for (const key of this.checkObject(schema, value, path)) evaluated.add(key);
      if (schema.unevaluatedProperties === false) this.rejectUnevaluated(value, evaluated, path);
    }
    return evaluated;
  }

  private fail(path: string, message: string): void {
    this.issues.push({ rule: "schema", path: path || "/", message });
  }

  private checkValue(schema: JsonSchema, value: unknown, path: string): void {
    if ("const" in schema && value !== schema.const) this.fail(path, `must equal ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      this.fail(path, `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
    }
    if (typeof value !== "number") return;
    if (typeof schema.minimum === "number" && value < schema.minimum) this.fail(path, `must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) this.fail(path, `must be <= ${schema.maximum}`);
  }

  private checkString(schema: JsonSchema, value: string, path: string): void {
    const codePoints = [...value].length;
    if (typeof schema.minLength === "number" && codePoints < schema.minLength) this.fail(path, "is too short");
    if (typeof schema.maxLength === "number" && codePoints > schema.maxLength) this.fail(path, "is too long");
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      this.fail(path, `must match ${schema.pattern}`);
    }
    if (!formatMatches(schema.format, value)) this.fail(path, `must be a ${String(schema.format)}`);
  }

  private checkArray(schema: JsonSchema, value: readonly unknown[], path: string): void {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) this.fail(path, "has too few items");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) this.fail(path, "has too many items");
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      this.fail(path, "must not repeat items");
    }
    const prefix = Array.isArray(schema.prefixItems) ? (schema.prefixItems as JsonSchema[]) : [];
    value.forEach((item, index) => {
      const itemSchema = prefix[index] ?? (isObject(schema.items) ? (schema.items as JsonSchema) : undefined);
      if (itemSchema) this.validate(itemSchema, item, `${path}/${index}`);
    });
  }

  private checkObject(schema: JsonSchema, value: JsonObject, path: string): Set<string> {
    const properties = isObject(schema.properties) ? (schema.properties as { [key: string]: JsonSchema }) : {};
    const evaluated = new Set<string>();
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(value, key)) this.fail(path, `is missing required property ${key}`);
    }
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
      this.fail(path, "has too few properties");
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        this.validate(properties[key] as JsonSchema, item, `${path}/${key}`);
        evaluated.add(key);
      } else if (schema.additionalProperties === false) {
        this.fail(`${path}/${key}`, "is not allowed");
      } else if (isObject(schema.additionalProperties)) {
        this.validate(schema.additionalProperties as JsonSchema, item, `${path}/${key}`);
        evaluated.add(key);
      }
    }
    return evaluated;
  }

  private rejectUnevaluated(value: JsonObject, evaluated: ReadonlySet<string>, path: string): void {
    for (const key of Object.keys(value)) {
      if (!evaluated.has(key)) this.fail(`${path}/${key}`, "is not allowed");
    }
  }
}

function ruleIssues(descriptor: PublicationDescriptorV1): PublicationDescriptorIssue[] {
  const issues: PublicationDescriptorIssue[] = [];
  const fail = (rule: PublicationDescriptorRule, path: string, message: string) => issues.push({ rule, path, message });
  const publicFields = new Set(descriptor.fields.filter((field) => field.public).map((field) => field.name));
  const artifacts = Object.entries(descriptor.artifacts);

  for (const [role, artifact] of artifacts) {
    if (artifact.captureId !== descriptor.capture.captureId) {
      fail(
        "capture-id",
        `/artifacts/${role}/captureId`,
        "must equal capture.captureId; both artifacts come from one capture",
      );
    }
    for (const name of artifact.fields) {
      if (!publicFields.has(name))
        fail("public-fields-only", `/artifacts/${role}/fields`, `${name} is not a public field`);
    }
  }
  if (new Set(descriptor.fields.map((field) => field.name)).size !== descriptor.fields.length) {
    fail("unique-field-names", "/fields", "field names must be unique");
  }
  const { identity } = descriptor;
  const identityField = descriptor.fields.find((field) => field.name === identity.field);
  if (
    identityField?.type !== "string" ||
    !identityField.public ||
    identity.pmtilesProperty !== identity.field ||
    identity.geoparquetColumn !== identity.field ||
    !descriptor.artifacts.pmtiles.fields.includes(identity.field) ||
    !descriptor.artifacts.geoparquet.fields.includes(identity.field)
  ) {
    fail("identity-mapping", "/identity", "identity must name one public string field present in both artifacts");
  }
  const inverted = ([west, south, east, north]: PublicationBounds) => west >= east || south >= north;
  if (inverted(descriptor.bounds)) fail("bounds-order", "/bounds", "must be [west, south, east, north]");
  const filterBounds = descriptor.capture.filter?.bbox;
  if (filterBounds && inverted(filterBounds)) {
    fail("bounds-order", "/capture/filter/bbox", "must be [west, south, east, north]");
  }
  if (descriptor.artifacts.pmtiles.minzoom > descriptor.artifacts.pmtiles.maxzoom) {
    fail("zoom-order", "/artifacts/pmtiles", "minzoom must not exceed maxzoom");
  }
  return issues;
}

/** Every reason `value` is not a valid publication descriptor v1; empty when it is valid. */
export function publicationDescriptorIssues(value: unknown): readonly PublicationDescriptorIssue[] {
  const walk = new SchemaWalk();
  walk.validate(ROOT_SCHEMA, value, "");
  if (walk.issues.length > 0) return walk.issues;
  return ruleIssues(value as PublicationDescriptorV1);
}

/** Validates `value` against descriptor v1 and returns it typed; refuses descriptors that did not pass validation. */
export function validatePublicationDescriptor(value: unknown): PublicationDescriptorV1 {
  const issues = publicationDescriptorIssues(value);
  if (issues.length > 0) {
    const summary = issues
      .slice(0, 3)
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("; ");
    throw new HonuaPublicationError("invalid-descriptor", `Publication descriptor is invalid: ${summary}`, {
      detail: { issues },
    });
  }
  const descriptor = value as PublicationDescriptorV1;
  if (descriptor.validation.status !== "passed") {
    throw new HonuaPublicationError(
      "invalid-descriptor",
      `Publication ${descriptor.publicationId} version ${descriptor.version} did not pass validation and cannot be opened.`,
    );
  }
  return descriptor;
}
