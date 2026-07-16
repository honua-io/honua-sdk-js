import type {
  CanonicalGeometry,
  CrsDefinition,
  JsonValue,
  LogicalField,
  Position,
  SourceSchemaV2,
} from "../contract/schema.js";
import { toJsonValue } from "./canonical.js";
import {
  type NormalizedNamespaceBindings,
  bboxInDefinitionOrder,
  compiledRequestFingerprint,
  compilerEvidenceFingerprint,
  compilerField,
  fesValueReference,
  geometryInDefinitionOrder,
  normalizeIdentifierUris,
  normalizeNamespaceBindings,
  ogcAxisPlan,
  ogcCrsUri,
  ogcNumber,
  validateFesTypeName,
  xmlAttribute,
  xmlText,
} from "./ogc-compiler.js";
import { hashSemanticQuery } from "./semantic-canonical.js";
import {
  type RuntimeSemanticQuery,
  type SemanticCompilationResult,
  prepareSemanticCompilerQuery,
  runSemanticCompiler,
  semanticUnsupported,
} from "./semantic-compiler.js";
import type { QueryFilter, SemanticQuery, SourceSpatiality, TemporalLiteralNode } from "./semantic-types.js";
import { HonuaQueryPlanningError } from "./types.js";

/** Explicit WFS/FES metadata discovered for the concrete feature type. */
export interface Wfs20FilterCapabilitiesEvidence {
  /** Advertised WFS/FES version. Only the WFS 2.0 family is accepted. */
  readonly version: string;
  /** `ImplementsAdHocQuery` from `fes:Conformance`. */
  readonly implementsAdHocQuery: boolean;
  /** `ImplementsSorting` from `fes:Conformance`. */
  readonly implementsSorting: boolean;
  /** Presence of `fes:LogicalOperators` in scalar capabilities. */
  readonly logicalOperators: boolean;
  readonly comparisonOperators: readonly string[];
  readonly geometryOperands: readonly string[];
  readonly spatialOperators: readonly string[];
  readonly temporalOperands: readonly string[];
  readonly temporalOperators: readonly string[];
  /** CRS identifiers explicitly discovered as usable by spatial filter operands. */
  readonly supportedFilterCrs: readonly string[];
  /** CRS identifiers explicitly discovered as valid WFS result `srsName` values. */
  readonly supportedOutputCrs: readonly string[];
}

/** Stable WFS feature-type identity and the namespaces used by its QNames. */
export interface SemanticWfsSourceIdentity {
  readonly typeName: string;
  readonly namespaces?: Readonly<Record<string, string>>;
}

export interface SemanticWfsCompileOptions<
  TRecord = Record<string, unknown>,
  TSpatiality extends SourceSpatiality = SourceSpatiality,
> {
  readonly query: SemanticQuery<TRecord, "wfs", TSpatiality>;
  readonly schema: SourceSchemaV2;
  readonly source: SemanticWfsSourceIdentity;
  readonly capabilities: Wfs20FilterCapabilitiesEvidence;
}

/** Canonical, wire-ready WFS 2.0 GetFeature request semantics. */
export interface SemanticWfsCompiledQueryV1 {
  readonly compiler: "wfs-2.0-semantic-query-v1";
  readonly version: "2.0.0" | "2.0.2";
  readonly dialect?: "fes-2.0";
  readonly schemaFingerprint: SourceSchemaV2["fingerprint"];
  readonly queryFingerprint: `sha256:${string}`;
  readonly capabilityFingerprint: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly typeName: string;
  readonly namespaces: Readonly<Record<string, string>>;
  readonly filter?: string;
  readonly propertyName?: readonly string[];
  readonly sortBy?: string;
  readonly startIndex?: number;
  readonly count?: number;
  readonly srsName?: string;
  readonly usesNativeFilter: boolean;
}

type RuntimeWfsQuery = RuntimeSemanticQuery<"wfs">;
type RuntimeWfsFilter = QueryFilter<Record<string, unknown>, "wfs", SourceSpatiality>;
type SemanticOnlyWfsFilter = Exclude<RuntimeWfsFilter, { readonly kind: "native" }>;
type RuntimeSpatialFilter = Extract<SemanticOnlyWfsFilter, { readonly kind: "spatial" }>;

interface NormalizedWfsCapabilities {
  readonly version: "2.0.0" | "2.0.2";
  readonly implementsAdHocQuery: boolean;
  readonly implementsSorting: boolean;
  readonly logicalOperators: boolean;
  readonly comparisonOperators: readonly string[];
  readonly geometryOperands: readonly string[];
  readonly spatialOperators: readonly string[];
  readonly temporalOperands: readonly string[];
  readonly temporalOperators: readonly string[];
  readonly supportedFilterCrs: readonly string[];
  readonly supportedOutputCrs: readonly string[];
  readonly fingerprint: `sha256:${string}`;
}

interface FesCompilerState {
  readonly schema: SourceSchemaV2;
  readonly namespaces: NormalizedNamespaceBindings;
  readonly capabilities: NormalizedWfsCapabilities;
  geometryId: number;
  timeId: number;
  usesNativeFilter: boolean;
}

const WFS_CAPABILITY_FINGERPRINT_DOMAIN = "honua.wfs-2.0.filter-capabilities.v1";
const WFS_REQUEST_FINGERPRINT_DOMAIN = "honua.wfs-2.0.semantic-request.v1";
const MAX_CAPABILITY_NAMES = 256;
const MAX_CAPABILITY_NAME_BYTES = 1_024;
const TEXT_ENCODER = new TextEncoder();
const CAPABILITY_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const EXACT_INTEGER = /^-?(?:0|[1-9]\d*)$/;
const EXACT_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const XML_DATE = /^\d{4}-\d{2}-\d{2}(?:Z|[+-]\d{2}:\d{2})?$/;
const XML_DATE_TIME = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

const FES_COMPARISON = {
  eq: "PropertyIsEqualTo",
  ne: "PropertyIsNotEqualTo",
  lt: "PropertyIsLessThan",
  lte: "PropertyIsLessThanOrEqualTo",
  gt: "PropertyIsGreaterThan",
  gte: "PropertyIsGreaterThanOrEqualTo",
} as const;

const FES_SPATIAL = {
  equals: "Equals",
  intersects: "Intersects",
  within: "Within",
  contains: "Contains",
  disjoint: "Disjoint",
  touches: "Touches",
  overlaps: "Overlaps",
  crosses: "Crosses",
  "within-distance": "DWithin",
  "beyond-distance": "Beyond",
} as const;

const FES_TEMPORAL = {
  before: "Before",
  after: "After",
  during: "During",
  "time-intersects": "AnyInteracts",
} as const;

const DISTANCE_UOM = {
  metre: "m",
  kilometre: "km",
  foot: "[ft_i]",
  "us-survey-foot": "[ft_us]",
  mile: "[mi_i]",
  "nautical-mile": "[nmi_i]",
  degree: "deg",
  radian: "rad",
} as const;

/** Compile a typed semantic query using only explicit WFS 2.0/FES capability evidence. */
export function compileSemanticWfsQuery<TRecord, TSpatiality extends SourceSpatiality>(
  options: SemanticWfsCompileOptions<TRecord, TSpatiality>,
): SemanticCompilationResult<SemanticWfsCompiledQueryV1> {
  return runSemanticCompiler(() => {
    const { query, schema } = prepareSemanticCompilerQuery(options.query, options.schema, "wfs");
    const namespaces = normalizeNamespaceBindings(options.source?.namespaces, "options.source.namespaces");
    const typeName = validateFesTypeName(options.source?.typeName, namespaces, "options.source.typeName");
    const capabilities = normalizeWfsCapabilities(options.capabilities);
    if (!capabilities.implementsAdHocQuery) {
      semanticUnsupported(
        "unsupported-source",
        "options.capabilities.implementsAdHocQuery",
        "WFS semantic compilation requires explicitly advertised ad hoc query support",
      );
    }
    const state: FesCompilerState = {
      schema,
      namespaces,
      capabilities,
      geometryId: 0,
      timeId: 0,
      usesNativeFilter: false,
    };
    const filter = query.filter ? compileFesFilter(query.filter as RuntimeWfsFilter, state, "$.filter") : undefined;
    const propertyName = wfsProjection(query, state);
    const sortBy = wfsSort(query, state);
    const srsName = query.outputCrs ? wfsOutputCrs(query.outputCrs, capabilities, "$.outputCrs") : undefined;
    const queryFingerprint = hashSemanticQuery(query, { schema, protocol: "wfs" });
    const preimage = {
      compiler: "wfs-2.0-semantic-query-v1" as const,
      version: capabilities.version,
      ...(filter ? { dialect: "fes-2.0" as const } : {}),
      schemaFingerprint: schema.fingerprint,
      queryFingerprint,
      capabilityFingerprint: capabilities.fingerprint,
      typeName,
      namespaces: namespaces.bindings,
      ...(filter ? { filter } : {}),
      ...(propertyName ? { propertyName } : {}),
      ...(sortBy ? { sortBy } : {}),
      ...(query.page?.kind === "offset" ? { startIndex: query.page.offset } : {}),
      ...(query.page?.limit !== undefined ? { count: query.page.limit } : {}),
      ...(srsName ? { srsName } : {}),
      usesNativeFilter: state.usesNativeFilter,
    };
    return {
      artifact: {
        ...preimage,
        requestFingerprint: compiledRequestFingerprint(WFS_REQUEST_FINGERPRINT_DOMAIN, toJsonValue(preimage)),
      },
    };
  });
}

function normalizeWfsCapabilities(value: Wfs20FilterCapabilitiesEvidence): NormalizedWfsCapabilities {
  if (!value || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", "options.capabilities is invalid");
  }
  if (value.version !== "2.0.0" && value.version !== "2.0.2") {
    semanticUnsupported("unsupported-source", "options.capabilities.version", "FES compilation requires WFS 2.0");
  }
  const version: "2.0.0" | "2.0.2" = value.version;
  for (const key of ["implementsAdHocQuery", "implementsSorting", "logicalOperators"] as const) {
    if (typeof value[key] !== "boolean") {
      throw new HonuaQueryPlanningError("invalid-query", `options.capabilities.${key} must be boolean`);
    }
  }
  const normalized = {
    version,
    implementsAdHocQuery: value.implementsAdHocQuery,
    implementsSorting: value.implementsSorting,
    logicalOperators: value.logicalOperators,
    comparisonOperators: normalizeCapabilityNames(
      value.comparisonOperators,
      "options.capabilities.comparisonOperators",
    ),
    geometryOperands: normalizeCapabilityNames(value.geometryOperands, "options.capabilities.geometryOperands"),
    spatialOperators: normalizeCapabilityNames(value.spatialOperators, "options.capabilities.spatialOperators"),
    temporalOperands: normalizeCapabilityNames(value.temporalOperands, "options.capabilities.temporalOperands"),
    temporalOperators: normalizeCapabilityNames(value.temporalOperators, "options.capabilities.temporalOperators"),
    supportedFilterCrs: normalizeIdentifierUris(value.supportedFilterCrs, "options.capabilities.supportedFilterCrs"),
    supportedOutputCrs: normalizeIdentifierUris(value.supportedOutputCrs, "options.capabilities.supportedOutputCrs"),
  };
  return {
    ...normalized,
    fingerprint: compilerEvidenceFingerprint(WFS_CAPABILITY_FINGERPRINT_DOMAIN, toJsonValue(normalized)),
  };
}

function normalizeCapabilityNames(value: readonly string[], path: string): readonly string[] {
  if (!Array.isArray(value)) throw new HonuaQueryPlanningError("invalid-query", `${path} must be an array`);
  if (value.length > MAX_CAPABILITY_NAMES) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `${path} exceeds the ${MAX_CAPABILITY_NAMES}-entry capability bound`,
    );
  }
  const normalized = value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      !CAPABILITY_NAME.test(entry) ||
      TEXT_ENCODER.encode(entry).byteLength > MAX_CAPABILITY_NAME_BYTES
    ) {
      throw new HonuaQueryPlanningError("invalid-query", `${path}[${index}] is not a safe capability name`);
    }
    return entry;
  });
  normalized.sort(compareUtf8);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      throw new HonuaQueryPlanningError("invalid-query", `${path} contains duplicate capability name`);
    }
  }
  return Object.freeze(normalized);
}

function compileFesFilter(filter: RuntimeWfsFilter, state: FesCompilerState, path: string): string {
  if (filter.kind === "native") {
    if (filter.dialect !== "fes-2.0" || filter.payload.format !== "xml") {
      semanticUnsupported(
        "unsupported-native-filter",
        `${path}.dialect`,
        "WFS accepts only a matching fes-2.0 XML native filter",
      );
    }
    if (filter.payload.text.trim().length === 0) {
      semanticUnsupported("unsupported-native-filter", `${path}.payload.text`, "native FES XML cannot be empty");
    }
    xmlText(filter.payload.text, `${path}.payload.text`);
    state.usesNativeFilter = true;
    return filter.payload.text;
  }
  const declarations = [
    'xmlns:fes="http://www.opengis.net/fes/2.0"',
    'xmlns:gml="http://www.opengis.net/gml/3.2"',
    'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
    ...state.namespaces.ordered.map(
      ([prefix, uri]) => `xmlns:${prefix}="${xmlAttribute(uri, `options.source.namespaces.${prefix}`)}"`,
    ),
  ];
  return `<fes:Filter ${declarations.join(" ")}>${compileFesNode(filter, state, path)}</fes:Filter>`;
}

function compileFesNode(filter: SemanticOnlyWfsFilter, state: FesCompilerState, path: string): string {
  switch (filter.kind) {
    case "comparison": {
      const operator = FES_COMPARISON[filter.operator];
      requireComparison(state, operator, path);
      const field = compilerField(state.schema, filter.left.name, `${path}.left.name`);
      return `<fes:${operator} matchCase="true">${valueReference(
        state,
        filter.left.name,
        `${path}.left.name`,
      )}${fesLiteral(filter.right.value, field, `${path}.right.value`)}</fes:${operator}>`;
    }
    case "boolean": {
      if (filter.args.length === 1)
        return compileFesNode(filter.args[0] as SemanticOnlyWfsFilter, state, `${path}.args[0]`);
      requireLogical(state, path);
      const operator = filter.operator === "and" ? "And" : "Or";
      return `<fes:${operator}>${filter.args
        .map((entry, index) => compileFesNode(entry, state, `${path}.args[${index}]`))
        .join("")}</fes:${operator}>`;
    }
    case "not":
      requireLogical(state, path);
      return `<fes:Not>${compileFesNode(filter.arg, state, `${path}.arg`)}</fes:Not>`;
    case "null": {
      requireComparison(state, "PropertyIsNull", path);
      const node = `<fes:PropertyIsNull>${valueReference(
        state,
        filter.operand.name,
        `${path}.operand.name`,
      )}</fes:PropertyIsNull>`;
      if (filter.operator === "is-null") return node;
      requireLogical(state, path);
      return `<fes:Not>${node}</fes:Not>`;
    }
    case "list": {
      requireComparison(state, "PropertyIsEqualTo", path);
      const field = compilerField(state.schema, filter.operand.name, `${path}.operand.name`);
      const nodes = filter.values.map(
        (entry, index) =>
          `<fes:PropertyIsEqualTo matchCase="true">${valueReference(
            state,
            filter.operand.name,
            `${path}.operand.name`,
          )}${fesLiteral(entry.value, field, `${path}.values[${index}].value`)}</fes:PropertyIsEqualTo>`,
      );
      if (nodes.length === 1) return nodes[0] as string;
      requireLogical(state, path);
      return `<fes:Or>${nodes.join("")}</fes:Or>`;
    }
    case "range": {
      requireComparison(state, "PropertyIsBetween", path);
      const field = compilerField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `<fes:PropertyIsBetween>${valueReference(
        state,
        filter.operand.name,
        `${path}.operand.name`,
      )}<fes:LowerBoundary>${fesLiteral(
        filter.lower.value,
        field,
        `${path}.lower.value`,
      )}</fes:LowerBoundary><fes:UpperBoundary>${fesLiteral(
        filter.upper.value,
        field,
        `${path}.upper.value`,
      )}</fes:UpperBoundary></fes:PropertyIsBetween>`;
    }
    case "pattern": {
      requireComparison(state, "PropertyIsLike", path);
      const matchCase = filter.caseSensitive === false ? "false" : "true";
      return `<fes:PropertyIsLike wildCard="%" singleChar="_" escapeChar="\\" matchCase="${matchCase}">${valueReference(
        state,
        filter.operand.name,
        `${path}.operand.name`,
      )}<fes:Literal type="xs:string">${xmlText(filter.pattern, `${path}.pattern`)}</fes:Literal></fes:PropertyIsLike>`;
    }
    case "spatial":
      return compileFesSpatial(filter, state, path);
    case "temporal": {
      if (filter.operator === "time-intersects") {
        semanticUnsupported(
          "unsupported-node",
          `${path}.operator`,
          "FES AnyInteracts requires a period-valued property, but semantic temporal fields are instant-valued",
        );
      }
      const operator = FES_TEMPORAL[filter.operator];
      requireTemporal(state, operator, path);
      const operand = filter.value.valueType === "interval" ? "gml:TimePeriod" : "gml:TimeInstant";
      requireTemporalOperand(state, operand, `${path}.value`);
      return `<fes:${operator}>${valueReference(
        state,
        filter.operand.name,
        `${path}.operand.name`,
      )}${fesTemporalLiteral(filter.value, state, `${path}.value`)}</fes:${operator}>`;
    }
  }
}

function compileFesSpatial(filter: RuntimeSpatialFilter, state: FesCompilerState, path: string): string {
  const property = spatialProperty(filter, state.schema, path);
  if (filter.operator === "bbox-intersects") {
    requireSpatial(state, "BBOX", path);
    requireGeometryOperand(state, "gml:Envelope", `${path}.bbox`);
    const bounds = bboxInDefinitionOrder(filter.bbox, `${path}.bbox`);
    const dimensions = filter.bbox.box.layout === "xy" ? 2 : 3;
    const srsName = requiredFilterCrs(filter.bbox.crs, dimensions, state.capabilities, `${path}.bbox`);
    const lower = bounds
      .slice(0, dimensions)
      .map((value, index) => ogcNumber(value, `${path}.bbox.box.bounds[${index}]`));
    const upper = bounds
      .slice(dimensions)
      .map((value, index) => ogcNumber(value, `${path}.bbox.box.bounds[${dimensions + index}]`));
    return `<fes:BBOX>${valueReference(state, property, `${path}.property.name`)}<gml:Envelope srsName="${xmlAttribute(
      srsName,
      `${path}.bbox.crs`,
    )}" srsDimension="${dimensions}"><gml:lowerCorner>${lower.join(" ")}</gml:lowerCorner><gml:upperCorner>${upper.join(
      " ",
    )}</gml:upperCorner></gml:Envelope></fes:BBOX>`;
  }
  const operator = FES_SPATIAL[filter.operator];
  requireSpatial(state, operator, path);
  const distanceOperand =
    filter.operator === "within-distance" || filter.operator === "beyond-distance" ? filter.distance : undefined;
  if (distanceOperand?.mode === "geodesic") {
    semanticUnsupported(
      "unsupported-distance",
      `${path}.distance.mode`,
      "FES 2.0 distance operators do not encode geodesic-versus-planar execution mode",
    );
  }
  const geometry = geometryInDefinitionOrder(filter.geometry, `${path}.geometry`);
  const dimensions = filter.geometry.layout === "xy" ? 2 : 3;
  const srsName = requiredFilterCrs(filter.geometry.crs, dimensions, state.capabilities, `${path}.geometry`);
  requireGeometryOperand(state, gmlOperand(geometry), `${path}.geometry.geometry`);
  const gml = geometryToGml(geometry, dimensions, srsName, state, `${path}.geometry.geometry`);
  const distance = distanceOperand
    ? `<fes:Distance uom="${xmlAttribute(DISTANCE_UOM[distanceOperand.unit], `${path}.distance.unit`)}">${ogcNumber(
        distanceOperand.value,
        `${path}.distance.value`,
      )}</fes:Distance>`
    : "";
  return `<fes:${operator}>${valueReference(state, property, `${path}.property.name`)}${gml}${distance}</fes:${operator}>`;
}

function fesLiteral(value: JsonValue, field: LogicalField, path: string): string {
  if (value === null || Array.isArray(value) || typeof value === "object") {
    semanticUnsupported("unsupported-field-type", path, "FES scalar literals must be string, number, or boolean");
  }
  let lexical: string;
  let type: string;
  switch (field.type.kind) {
    case "boolean":
      if (typeof value !== "boolean") return incompatibleFesLiteral(field, path);
      lexical = value ? "true" : "false";
      type = "xs:boolean";
      break;
    case "integer":
      lexical = exactInteger(value, path);
      type = "xs:integer";
      break;
    case "float":
      if (typeof value !== "number") return incompatibleFesLiteral(field, path);
      lexical = ogcNumber(value, path);
      type = "xs:double";
      break;
    case "decimal":
      lexical = exactDecimal(value, path);
      type = "xs:decimal";
      break;
    case "date":
      if (typeof value !== "string" || !XML_DATE.test(value)) return incompatibleFesLiteral(field, path);
      lexical = value;
      type = "xs:date";
      break;
    case "time":
      if (typeof value !== "string") return incompatibleFesLiteral(field, path);
      lexical = value;
      type = "xs:time";
      break;
    case "timestamp":
      if (typeof value !== "string" || !XML_DATE_TIME.test(value)) return incompatibleFesLiteral(field, path);
      lexical = value;
      type = "xs:dateTime";
      break;
    case "duration":
      if (typeof value !== "string") return incompatibleFesLiteral(field, path);
      lexical = value;
      type = "xs:duration";
      break;
    case "binary":
      if (field.type.encoding !== "base64" || typeof value !== "string") {
        semanticUnsupported(
          "unsupported-field-type",
          path,
          `FES cannot type ${field.type.encoding} binary literals exactly`,
        );
      }
      lexical = value;
      type = "xs:base64Binary";
      break;
    case "string":
    case "uuid":
      if (typeof value !== "string") return incompatibleFesLiteral(field, path);
      lexical = value;
      type = "xs:string";
      break;
    default:
      semanticUnsupported(
        "unsupported-field-type",
        path,
        `FES cannot encode ${field.type.kind} literals as exact scalar XML values`,
      );
  }
  return `<fes:Literal type="${type}">${xmlText(lexical, path)}</fes:Literal>`;
}

function incompatibleFesLiteral(field: LogicalField, path: string): never {
  semanticUnsupported(
    "unsupported-field-type",
    path,
    `FES literal is incompatible with ${field.name}:${field.type.kind}`,
  );
}

function exactInteger(value: JsonValue, path: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && EXACT_INTEGER.test(value)) return value;
  semanticUnsupported("unsupported-field-type", path, "FES integer literal is not an exact integer token");
}

function exactDecimal(value: JsonValue, path: string): string {
  const lexical = typeof value === "number" ? ogcNumber(value, path) : value;
  if (typeof lexical === "string" && EXACT_DECIMAL.test(lexical)) return lexical;
  semanticUnsupported("unsupported-field-type", path, "FES decimal literal is not an exact decimal token");
}

function fesTemporalLiteral(value: TemporalLiteralNode, state: FesCompilerState, path: string): string {
  if (value.valueType !== "interval") {
    const id = nextTimeId(state);
    return `<gml:TimeInstant gml:id="${id}"><gml:timePosition>${xmlText(
      value.value,
      `${path}.value`,
    )}</gml:timePosition></gml:TimeInstant>`;
  }
  const periodId = nextTimeId(state);
  const beginId = nextTimeId(state);
  const endId = nextTimeId(state);
  return `<gml:TimePeriod gml:id="${periodId}"><gml:begin><gml:TimeInstant gml:id="${beginId}"><gml:timePosition>${xmlText(
    value.value[0],
    `${path}.value[0]`,
  )}</gml:timePosition></gml:TimeInstant></gml:begin><gml:end><gml:TimeInstant gml:id="${endId}"><gml:timePosition>${xmlText(
    value.value[1],
    `${path}.value[1]`,
  )}</gml:timePosition></gml:TimeInstant></gml:end></gml:TimePeriod>`;
}

function geometryToGml(
  geometry: CanonicalGeometry,
  dimensions: 2 | 3,
  srsName: string,
  state: FesCompilerState,
  path: string,
): string {
  const id = nextGeometryId(state);
  const attributes = `gml:id="${id}" srsName="${xmlAttribute(srsName, `${path}.crs`)}" srsDimension="${dimensions}"`;
  const position = (value: Position, valuePath: string) =>
    value.map((ordinate, index) => ogcNumber(ordinate, `${valuePath}[${index}]`)).join(" ");
  const posList = (values: readonly Position[], valuePath: string) =>
    values.map((value, index) => position(value, `${valuePath}[${index}]`)).join(" ");
  const ring = (values: readonly Position[], valuePath: string, exterior: boolean) => {
    const boundary = exterior ? "exterior" : "interior";
    return `<gml:${boundary}><gml:LinearRing><gml:posList srsDimension="${dimensions}">${posList(
      values,
      valuePath,
    )}</gml:posList></gml:LinearRing></gml:${boundary}>`;
  };
  const polygonBody = (rings: readonly (readonly Position[])[], valuePath: string) =>
    rings.map((value, index) => ring(value, `${valuePath}[${index}]`, index === 0)).join("");
  switch (geometry.type) {
    case "Point":
      return `<gml:Point ${attributes}><gml:pos>${position(
        geometry.coordinates,
        `${path}.coordinates`,
      )}</gml:pos></gml:Point>`;
    case "LineString":
      return `<gml:LineString ${attributes}><gml:posList srsDimension="${dimensions}">${posList(
        geometry.coordinates,
        `${path}.coordinates`,
      )}</gml:posList></gml:LineString>`;
    case "Polygon":
      return `<gml:Polygon ${attributes}>${polygonBody(geometry.coordinates, `${path}.coordinates`)}</gml:Polygon>`;
    case "MultiPoint":
      return `<gml:MultiPoint ${attributes}>${geometry.coordinates
        .map(
          (value, index) =>
            `<gml:pointMember>${geometryToGml(
              { type: "Point", coordinates: value },
              dimensions,
              srsName,
              state,
              `${path}.coordinates[${index}]`,
            )}</gml:pointMember>`,
        )
        .join("")}</gml:MultiPoint>`;
    case "MultiLineString":
      return `<gml:MultiCurve ${attributes}>${geometry.coordinates
        .map(
          (value, index) =>
            `<gml:curveMember>${geometryToGml(
              { type: "LineString", coordinates: value },
              dimensions,
              srsName,
              state,
              `${path}.coordinates[${index}]`,
            )}</gml:curveMember>`,
        )
        .join("")}</gml:MultiCurve>`;
    case "MultiPolygon":
      return `<gml:MultiSurface ${attributes}>${geometry.coordinates
        .map(
          (value, index) =>
            `<gml:surfaceMember>${geometryToGml(
              { type: "Polygon", coordinates: value },
              dimensions,
              srsName,
              state,
              `${path}.coordinates[${index}]`,
            )}</gml:surfaceMember>`,
        )
        .join("")}</gml:MultiSurface>`;
    case "GeometryCollection":
      return `<gml:MultiGeometry ${attributes}>${geometry.geometries
        .map(
          (value, index) =>
            `<gml:geometryMember>${geometryToGml(
              value,
              dimensions,
              srsName,
              state,
              `${path}.geometries[${index}]`,
            )}</gml:geometryMember>`,
        )
        .join("")}</gml:MultiGeometry>`;
  }
}

function wfsProjection(query: RuntimeWfsQuery, state: FesCompilerState): readonly string[] | undefined {
  if (query.kind === "aggregate") {
    semanticUnsupported("unsupported-node", "$.kind", "WFS 2.0 has no portable remote aggregation");
  }
  const geometryField = requestedGeometryField(query, state.schema);
  if (!query.select) {
    if (query.geometry !== "omit" && onlyRequestedGeometryIsReturned(geometryField, state.schema)) return undefined;
    if (state.schema.openContent !== "closed") {
      semanticUnsupported(
        "unsupported-projection",
        "$.geometry",
        "WFS property projection requires a closed schema to exclude geometry without dropping unknown attributes",
      );
    }
  }
  const selected = query.select
    ? [...query.select]
    : state.schema.fields.filter((field) => field.type.kind !== "geometry").map((field) => field.name);
  if (query.geometry === "omit") {
    selected.forEach((name, index) => {
      if (compilerField(state.schema, name, `$.select[${index}]`).type.kind === "geometry") {
        semanticUnsupported(
          "unsupported-projection",
          `$.select[${index}]`,
          "WFS cannot select a geometry property while geometry projection is omitted",
        );
      }
    });
  }
  if (geometryField && !selected.includes(geometryField)) selected.push(geometryField);
  const propertyName = selected.map((name, index) =>
    fesValueReference(state.schema, name, state.namespaces, `$.select[${index}]`),
  );
  if (propertyName.length === 0) {
    semanticUnsupported("unsupported-projection", "$.select", "WFS cannot represent an empty property projection");
  }
  return Object.freeze(propertyName);
}

function requestedGeometryField(query: RuntimeWfsQuery, schema: SourceSchemaV2): string | undefined {
  if (query.kind === "aggregate" || query.geometry === "omit") return undefined;
  if (query.geometry && typeof query.geometry === "object") return query.geometry.field;
  if (schema.geometry.state === "none") return undefined;
  if (schema.geometry.state === "known" && schema.geometry.primaryField.state === "known") {
    return schema.geometry.primaryField.field;
  }
  semanticUnsupported(
    "unsupported-projection",
    "$.geometry",
    "WFS geometry inclusion requires a known primary geometry field or an explicit geometry field",
  );
}

function onlyRequestedGeometryIsReturned(geometryField: string | undefined, schema: SourceSchemaV2): boolean {
  if (!geometryField || schema.geometry.state !== "known") return geometryField === undefined;
  return schema.geometry.fields.length === 1 && schema.geometry.fields[0]?.field === geometryField;
}

function wfsSort(query: RuntimeWfsQuery, state: FesCompilerState): string | undefined {
  if (!query.sort || query.sort.length === 0) return undefined;
  if (!state.capabilities.implementsSorting) {
    semanticUnsupported("unsupported-sort", "$.sort", "WFS sorting was not present in explicit discovered conformance");
  }
  return query.sort
    .map((sort, index) => {
      if (sort.nulls !== undefined && sort.nulls !== "native") {
        semanticUnsupported(
          "unsupported-sort",
          `$.sort[${index}].nulls`,
          "WFS SortBy cannot request explicit null placement",
        );
      }
      const property = fesValueReference(state.schema, sort.field, state.namespaces, `$.sort[${index}].field`);
      return `${property} ${sort.direction === "desc" ? "DESC" : "ASC"}`;
    })
    .join(",");
}

function wfsOutputCrs(definition: CrsDefinition, capabilities: NormalizedWfsCapabilities, path: string): string {
  const uri = ogcCrsUri(definition, path);
  if (!capabilities.supportedOutputCrs.includes(uri)) {
    semanticUnsupported("unsupported-crs", path, `output CRS ${uri} was not present in discovered source metadata`);
  }
  return uri;
}

function requiredFilterCrs(
  binding: Parameters<typeof ogcAxisPlan>[0],
  dimensions: 2 | 3,
  capabilities: NormalizedWfsCapabilities,
  path: string,
): string {
  const uri = ogcAxisPlan(binding, dimensions, `${path}.crs`).srsName;
  if (!capabilities.supportedFilterCrs.includes(uri)) {
    semanticUnsupported(
      "unsupported-crs",
      `${path}.crs`,
      `filter CRS ${uri} was not present in discovered source metadata`,
    );
  }
  return uri;
}

function spatialProperty(filter: RuntimeSpatialFilter, schema: SourceSchemaV2, path: string): string {
  if (filter.property) return filter.property.name;
  if (schema.geometry.state === "known" && schema.geometry.primaryField.state === "known") {
    return schema.geometry.primaryField.field;
  }
  semanticUnsupported(
    "unsupported-source",
    `${path}.property`,
    "implicit spatial property requires a known primary geometry field",
  );
}

function valueReference(state: FesCompilerState, name: string, path: string): string {
  return `<fes:ValueReference>${xmlText(
    fesValueReference(state.schema, name, state.namespaces, path),
    path,
  )}</fes:ValueReference>`;
}

function requireComparison(state: FesCompilerState, operator: string, path: string): void {
  if (!state.capabilities.comparisonOperators.includes(operator)) {
    semanticUnsupported("unsupported-node", path, `${operator} was not present in discovered FES capabilities`);
  }
}

function requireLogical(state: FesCompilerState, path: string): void {
  if (!state.capabilities.logicalOperators) {
    semanticUnsupported("unsupported-node", path, "logical operators were not present in discovered FES capabilities");
  }
}

function requireSpatial(state: FesCompilerState, operator: string, path: string): void {
  if (!state.capabilities.spatialOperators.includes(operator)) {
    semanticUnsupported("unsupported-node", path, `${operator} was not present in discovered FES capabilities`);
  }
}

function requireGeometryOperand(state: FesCompilerState, operand: string, path: string): void {
  if (!state.capabilities.geometryOperands.includes(operand)) {
    semanticUnsupported("unsupported-geometry", path, `${operand} was not present in discovered FES capabilities`);
  }
}

function requireTemporal(state: FesCompilerState, operator: string, path: string): void {
  if (!state.capabilities.temporalOperators.includes(operator)) {
    semanticUnsupported("unsupported-node", path, `${operator} was not present in discovered FES capabilities`);
  }
}

function requireTemporalOperand(state: FesCompilerState, operand: string, path: string): void {
  if (!state.capabilities.temporalOperands.includes(operand)) {
    semanticUnsupported("unsupported-node", path, `${operand} was not present in discovered FES capabilities`);
  }
}

function gmlOperand(geometry: CanonicalGeometry): string {
  switch (geometry.type) {
    case "MultiLineString":
      return "gml:MultiCurve";
    case "MultiPolygon":
      return "gml:MultiSurface";
    case "GeometryCollection":
      return "gml:MultiGeometry";
    default:
      return `gml:${geometry.type}`;
  }
}

function nextGeometryId(state: FesCompilerState): string {
  const id = `honua-g${state.geometryId}`;
  state.geometryId += 1;
  return id;
}

function nextTimeId(state: FesCompilerState): string {
  const id = `honua-t${state.timeId}`;
  state.timeId += 1;
  return id;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = TEXT_ENCODER.encode(left);
  const rightBytes = TEXT_ENCODER.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] as number) - (rightBytes[index] as number);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
