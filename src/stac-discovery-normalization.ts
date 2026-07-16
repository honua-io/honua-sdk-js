import { normalizeDiscoveryEndpoint } from "./contract/discovery.js";
import type {
  AxisOrder,
  BoundingBox,
  CoordinateAxis,
  CrsBinding,
  CrsDefinition,
  JsonObject,
  JsonValue,
  MetadataProvenance,
  SpatialExtent,
  TemporalExtent,
} from "./contract/schema.js";
import { HonuaDiscoveryError } from "./core/errors.js";
import type { StacTransportResponse } from "./stac-discovery-transport.js";
import type { StacDocumentType, StacLicense, StacProvider } from "./stac-discovery-types.js";

export interface ParsedStacLink {
  readonly rel: string;
  readonly href: string;
  readonly mediaType?: string;
  readonly title?: string;
}

export interface ParsedStacDocument {
  readonly documentType: StacDocumentType;
  readonly id: string;
  readonly stacVersion: string;
  readonly title?: string;
  readonly description?: string;
  readonly collectionId?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly links: readonly ParsedStacLink[];
  readonly assets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly stacExtensions: readonly string[];
  readonly crs?: CrsDefinition;
  readonly extent: SpatialExtent;
  readonly temporalExtent: TemporalExtent;
  readonly license?: StacLicense;
  readonly attribution?: string;
  readonly providers: readonly StacProvider[];
  readonly provenance: readonly MetadataProvenance[];
}

const JSON_GRAPH_MAX_NODES = 50_000;
const JSON_GRAPH_MAX_DEPTH = 64;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

const LONGITUDE_LATITUDE_AXES = Object.freeze([
  Object.freeze({ name: "longitude", abbreviation: "lon", direction: "east", unit: "degree" }),
  Object.freeze({ name: "latitude", abbreviation: "lat", direction: "north", unit: "degree" }),
]) as readonly [CoordinateAxis, CoordinateAxis];

const LONGITUDE_LATITUDE_ORDER: AxisOrder = Object.freeze({
  state: "known",
  source: "encoding",
  axes: LONGITUDE_LATITUDE_AXES,
});

const UNKNOWN_AXIS_ORDER: AxisOrder = Object.freeze({ state: "unknown", reason: "missing" });

export function parseStacDocument(
  response: StacTransportResponse,
  safeUrl: string,
  observedAt: string,
): ParsedStacDocument {
  assertJsonMediaType(response.contentType);
  let text: string;
  try {
    text = TEXT_DECODER.decode(response.bytes);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC metadata is not valid UTF-8 JSON.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC metadata is not valid JSON.");
  }
  assertBoundedJson(value);
  const record = plainObject(value, "Static STAC document");
  const documentType = documentKind(record.type);
  const id = boundedText(record.id, "Static STAC document id", 512);
  const stacVersion = stacVersionValue(record.stac_version);
  const links = parseLinks(record.links);
  const assets = parseAssets(record.assets, documentType);
  const properties = documentType === "item" ? plainObject(record.properties, "STAC Item properties") : undefined;
  const collectionId =
    documentType === "collection"
      ? id
      : documentType === "item" && record.collection !== undefined
        ? boundedText(record.collection, "STAC Item collection", 512)
        : undefined;
  const provenance = Object.freeze([documentProvenance(safeUrl, observedAt, response)]);
  const crs = documentCrs(record, properties);
  const extent = documentExtent(documentType, record, provenance);
  const temporalExtent = documentTemporalExtent(documentType, record, properties, provenance);
  const license = documentLicense(record, links, safeUrl);
  const providers = parseProviders(record.providers);
  const attribution = optionalText(record.attribution, "STAC attribution", 8_192);
  return Object.freeze({
    documentType,
    id,
    stacVersion,
    ...(optionalText(record.title, "STAC title", 8_192) ? { title: String(record.title) } : {}),
    ...(optionalText(record.description, "STAC description", 64 * 1024)
      ? { description: String(record.description) }
      : {}),
    ...(collectionId ? { collectionId } : {}),
    ...(properties ? { properties } : {}),
    links,
    assets,
    stacExtensions: parseStacExtensions(record.stac_extensions),
    ...(crs ? { crs } : {}),
    extent,
    temporalExtent,
    ...(license ? { license } : {}),
    ...(attribution ? { attribution } : {}),
    providers,
    provenance,
  });
}

export function assetExtensionSnapshot(asset: Readonly<Record<string, unknown>>): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(asset).sort()) {
    if (!key.includes(":")) continue;
    out[key] = jsonSnapshot(asset[key], `STAC asset extension ${key}`);
  }
  return Object.freeze(out);
}

export function assetCrs(
  asset: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>> | undefined,
  fallback: CrsDefinition | undefined,
): CrsDefinition | undefined {
  return projectionCrs(asset) ?? (properties ? projectionCrs(properties) : undefined) ?? fallback;
}

export function assetExtent(
  asset: Readonly<Record<string, unknown>>,
  crs: CrsDefinition | undefined,
  fallback: SpatialExtent,
  provenance: readonly MetadataProvenance[],
): SpatialExtent {
  if (asset["proj:bbox"] === undefined) return fallback;
  const boxes = bboxArray(asset["proj:bbox"], false);
  if (!boxes || boxes.length !== 1 || !crs) {
    return Object.freeze({ state: "unknown", reason: "invalid", provenance: nonEmptyProvenance(provenance) });
  }
  return Object.freeze({
    state: "known",
    boxes: boxes as [BoundingBox],
    crs: crsBinding(crs, projectionCoordinateOrder(crs)),
    provenance: nonEmptyProvenance(provenance),
  });
}

export function assetTemporalExtent(
  asset: Readonly<Record<string, unknown>>,
  fallback: TemporalExtent,
  provenance: readonly MetadataProvenance[],
): TemporalExtent {
  const datetime = asset.datetime;
  const start = asset.start_datetime;
  const end = asset.end_datetime;
  if (datetime === undefined && start === undefined && end === undefined) return fallback;
  const interval = temporalInterval(datetime, start, end);
  if (!interval) {
    return Object.freeze({ state: "unknown", reason: "invalid", provenance: nonEmptyProvenance(provenance) });
  }
  return Object.freeze({
    state: "known",
    intervals: Object.freeze([Object.freeze(interval)]) as [[string | null, string | null]],
    referenceSystem: Object.freeze({ kind: "gregorian" as const }),
    provenance: nonEmptyProvenance(provenance),
  });
}

export function parseProviders(value: unknown): readonly StacProvider[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 128) return Object.freeze([]);
  const providers: StacProvider[] = [];
  for (const candidate of value) {
    if (!isPlainObject(candidate) || typeof candidate.name !== "string" || !candidate.name.trim()) continue;
    const roles = Array.isArray(candidate.roles)
      ? candidate.roles.filter((role): role is string => typeof role === "string" && role.length > 0).slice(0, 64)
      : [];
    const providerUrl = safeMetadataUrl(candidate.url);
    providers.push(
      Object.freeze({
        name: candidate.name.slice(0, 4_096),
        ...(typeof candidate.description === "string" && candidate.description.length > 0
          ? { description: candidate.description.slice(0, 16_384) }
          : {}),
        roles: Object.freeze(roles),
        ...(providerUrl ? { url: providerUrl } : {}),
      }),
    );
  }
  return Object.freeze(providers);
}

export function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, label, maximum);
}

export function stringArray(value: unknown, maximum = 64): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const values = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, maximum);
  return Object.freeze([...new Set(values)]);
}

export function safeMetadataUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return undefined;
  }
  return normalizeDiscoveryEndpoint(parsed);
}

function assertJsonMediaType(value: string | undefined): void {
  if (!value) return;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/json" || mediaType === "application/geo+json" || mediaType?.endsWith("+json")) {
    return;
  }
  throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC metadata response is not JSON.");
}

function assertBoundedJson(root: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > JSON_GRAPH_MAX_NODES || current.depth > JSON_GRAPH_MAX_DEPTH) {
      throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC JSON exceeds structural safety limits.");
    }
    if (current.value === null || typeof current.value !== "object") {
      if (typeof current.value === "number" && !Number.isFinite(current.value)) {
        throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC JSON contains a non-finite number.");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isPlainObject(current.value)) {
      throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC JSON contains a non-plain object.");
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC JSON contains an unsafe object key.");
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function documentKind(value: unknown): StacDocumentType {
  if (value === "Catalog") return "catalog";
  if (value === "Collection") return "collection";
  if (value === "Feature") return "item";
  throw new HonuaDiscoveryError(
    "invalid-endpoint",
    "Static STAC root must be a Catalog, Collection, or Item document.",
  );
}

function stacVersionValue(value: unknown): string {
  const version = boundedText(value, "STAC version", 32);
  if (!/^1\.(?:0|1)\.\d+$/.test(version)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC discovery supports STAC 1.0.x and 1.1.x.");
  }
  return version;
}

function parseLinks(value: unknown): readonly ParsedStacLink[] {
  if (!Array.isArray(value)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC document links must be an array.");
  }
  const links: ParsedStacLink[] = [];
  for (const candidate of value) {
    if (!isPlainObject(candidate) || typeof candidate.rel !== "string" || typeof candidate.href !== "string") {
      continue;
    }
    if (!candidate.rel.trim() || !candidate.href.trim() || candidate.href.length > 16_384) continue;
    links.push(
      Object.freeze({
        rel: candidate.rel.toLowerCase(),
        href: candidate.href,
        ...(typeof candidate.type === "string" && candidate.type.length > 0 ? { mediaType: candidate.type } : {}),
        ...(typeof candidate.title === "string" && candidate.title.length > 0
          ? { title: candidate.title.slice(0, 8_192) }
          : {}),
      }),
    );
  }
  return Object.freeze(links);
}

function parseAssets(
  value: unknown,
  documentType: StacDocumentType,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  if (value === undefined && documentType !== "item") return Object.freeze({});
  if (!isPlainObject(value)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC document assets must be an object.");
  }
  const assets: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const key of Object.keys(value).sort()) {
    const asset = value[key];
    if (!key || key.length > 512 || !isPlainObject(asset)) continue;
    assets[key] = asset;
  }
  return Object.freeze(assets);
}

function parseStacExtensions(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 128) {
    throw new HonuaDiscoveryError("invalid-endpoint", "STAC extensions must be a bounded array.");
  }
  const extensions = value.map((entry) => boundedText(entry, "STAC extension", 4_096));
  return Object.freeze([...new Set(extensions)].sort());
}

function documentProvenance(safeUrl: string, observedAt: string, response: StacTransportResponse): MetadataProvenance {
  const validator = response.etag
    ? { kind: "etag" as const, value: response.etag }
    : response.lastModified
      ? { kind: "last-modified" as const, value: response.lastModified }
      : undefined;
  return Object.freeze({
    method: "observed" as const,
    protocol: "stac" as const,
    source: safeUrl,
    observedAt,
    ...(validator ? { validator: Object.freeze(validator) } : {}),
  });
}

function documentCrs(
  record: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>> | undefined,
): CrsDefinition | undefined {
  return projectionCrs(record) ?? (properties ? projectionCrs(properties) : undefined);
}

function projectionCrs(record: Readonly<Record<string, unknown>>): CrsDefinition | undefined {
  const code = record["proj:code"];
  const epsg = record["proj:epsg"];
  const wkt = record["proj:wkt2"];
  const projjson = record["proj:projjson"];
  const authorityCodes: string[] = [];
  if (typeof code === "string" && code.trim()) authorityCodes.push(code.trim());
  if (typeof epsg === "number" && Number.isSafeInteger(epsg) && epsg > 0) authorityCodes.push(`EPSG:${epsg}`);
  if (new Set(authorityCodes).size > 1) {
    return Object.freeze({ kind: "unknown", reason: "conflicting" as const });
  }
  if (projjson !== undefined) {
    if (!isPlainObject(projjson)) return Object.freeze({ kind: "unknown", reason: "unrecognized" as const });
    const snapshot = jsonSnapshot(projjson, "STAC proj:projjson") as JsonObject;
    return Object.freeze({
      kind: "projjson" as const,
      projjson: snapshot,
      ...(typeof projjson.name === "string" && projjson.name.length > 0 ? { name: projjson.name } : {}),
      definitionAxisOrder: projjsonAxisOrder(projjson),
    });
  }
  if (authorityCodes[0]) return crsFromCode(authorityCodes[0]);
  if (wkt !== undefined) {
    if (typeof wkt !== "string" || !wkt.trim() || wkt.length > 64 * 1024) {
      return Object.freeze({ kind: "unknown", reason: "unrecognized" as const });
    }
    return Object.freeze({
      kind: "wkt" as const,
      wkt,
      dialect: "wkt2" as const,
      validation: "unverified" as const,
      definitionAxisOrder: UNKNOWN_AXIS_ORDER,
    });
  }
  return undefined;
}

function crsFromCode(code: string): CrsDefinition {
  if (/^https?:\/\//i.test(code)) {
    return Object.freeze({ kind: "uri" as const, uri: code, definitionAxisOrder: UNKNOWN_AXIS_ORDER });
  }
  const urn = /^urn:ogc:def:crs:([^:]+):(?::([^:]*))?:(.+)$/i.exec(code);
  const pair = /^([^:]+):(.+)$/.exec(code);
  if (urn) {
    return Object.freeze({
      kind: "authority" as const,
      authority: urn[1]!,
      code: urn[3]!,
      ...(urn[2] ? { version: urn[2] } : {}),
      uri: code,
      definitionAxisOrder: UNKNOWN_AXIS_ORDER,
    });
  }
  if (pair) {
    return Object.freeze({
      kind: "authority" as const,
      authority: pair[1]!,
      code: pair[2]!,
      definitionAxisOrder: UNKNOWN_AXIS_ORDER,
    });
  }
  return Object.freeze({ kind: "unknown" as const, reason: "unrecognized" as const });
}

function projjsonAxisOrder(value: Readonly<Record<string, unknown>>): AxisOrder {
  const coordinateSystem = value.coordinate_system;
  if (!isPlainObject(coordinateSystem) || !Array.isArray(coordinateSystem.axis) || coordinateSystem.axis.length < 2) {
    return UNKNOWN_AXIS_ORDER;
  }
  const axes: Array<{
    name: string;
    abbreviation?: string;
    direction: "east" | "west" | "north" | "south" | "up" | "down" | "future" | "past" | "other";
    unit: string;
  }> = [];
  for (const candidate of coordinateSystem.axis) {
    if (!isPlainObject(candidate) || typeof candidate.name !== "string" || typeof candidate.unit !== "string") {
      return UNKNOWN_AXIS_ORDER;
    }
    const direction = axisDirection(candidate.direction);
    axes.push({
      name: candidate.name,
      ...(typeof candidate.abbreviation === "string" ? { abbreviation: candidate.abbreviation } : {}),
      direction,
      unit: candidate.unit,
    });
  }
  return Object.freeze({
    state: "known" as const,
    source: "crs-definition" as const,
    axes: Object.freeze(axes) as [(typeof axes)[number], (typeof axes)[number], ...typeof axes],
  });
}

function axisDirection(
  value: unknown,
): "east" | "west" | "north" | "south" | "up" | "down" | "future" | "past" | "other" {
  return value === "east" ||
    value === "west" ||
    value === "north" ||
    value === "south" ||
    value === "up" ||
    value === "down" ||
    value === "future" ||
    value === "past"
    ? value
    : "other";
}

function documentExtent(
  kind: StacDocumentType,
  record: Readonly<Record<string, unknown>>,
  provenance: readonly MetadataProvenance[],
): SpatialExtent {
  const raw =
    kind === "item"
      ? record.bbox
      : kind === "collection" && isPlainObject(record.extent) && isPlainObject(record.extent.spatial)
        ? record.extent.spatial.bbox
        : undefined;
  if (raw === undefined) {
    return Object.freeze({ state: "unknown", reason: "not-reported", provenance: nonEmptyProvenance(provenance) });
  }
  const boxes = bboxArray(raw, kind === "collection");
  if (!boxes || boxes.length === 0) {
    return Object.freeze({ state: "unknown", reason: "invalid", provenance: nonEmptyProvenance(provenance) });
  }
  const crs =
    kind === "collection" &&
    isPlainObject(record.extent) &&
    isPlainObject(record.extent.spatial) &&
    typeof record.extent.spatial.crs === "string"
      ? crsFromCode(record.extent.spatial.crs)
      : crs84Definition();
  return Object.freeze({
    state: "known",
    boxes: Object.freeze(boxes) as [BoundingBox, ...BoundingBox[]],
    crs: crsBinding(
      crs,
      crs.kind === "authority" && crs.authority === "OGC" ? LONGITUDE_LATITUDE_ORDER : UNKNOWN_AXIS_ORDER,
    ),
    provenance: nonEmptyProvenance(provenance),
  });
}

function bboxArray(value: unknown, nested: boolean): BoundingBox[] | undefined {
  const candidates = nested ? value : [value];
  if (!Array.isArray(candidates) || candidates.length > 1_024) return undefined;
  const boxes: BoundingBox[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || (candidate.length !== 4 && candidate.length !== 6)) return undefined;
    if (candidate.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) return undefined;
    const values = candidate as number[];
    const half = values.length / 2;
    for (let index = 0; index < half; index += 1) {
      if (values[index]! > values[index + half]!) return undefined;
    }
    boxes.push(
      values.length === 4
        ? Object.freeze({
            layout: "xy" as const,
            bounds: Object.freeze([...values]) as [number, number, number, number],
          })
        : Object.freeze({
            layout: "xyz" as const,
            bounds: Object.freeze([...values]) as [number, number, number, number, number, number],
          }),
    );
  }
  return boxes;
}

function documentTemporalExtent(
  kind: StacDocumentType,
  record: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, unknown>> | undefined,
  provenance: readonly MetadataProvenance[],
): TemporalExtent {
  if (kind === "catalog") {
    return Object.freeze({ state: "unknown", reason: "not-reported", provenance: nonEmptyProvenance(provenance) });
  }
  if (kind === "item") {
    const interval = temporalInterval(properties?.datetime, properties?.start_datetime, properties?.end_datetime);
    if (!interval) {
      return Object.freeze({ state: "unknown", reason: "invalid", provenance: nonEmptyProvenance(provenance) });
    }
    return Object.freeze({
      state: "known",
      intervals: Object.freeze([Object.freeze(interval)]) as [[string | null, string | null]],
      referenceSystem: Object.freeze({ kind: "gregorian" as const }),
      provenance: nonEmptyProvenance(provenance),
    });
  }
  const intervalValue =
    isPlainObject(record.extent) && isPlainObject(record.extent.temporal) ? record.extent.temporal.interval : undefined;
  if (!Array.isArray(intervalValue)) {
    return Object.freeze({ state: "unknown", reason: "not-reported", provenance: nonEmptyProvenance(provenance) });
  }
  if (intervalValue.length === 0) {
    return Object.freeze({
      state: "empty",
      reason: "no-temporal-values",
      referenceSystem: Object.freeze({ kind: "gregorian" as const }),
      provenance: nonEmptyProvenance(provenance),
    });
  }
  const intervals: Array<readonly [string | null, string | null]> = [];
  for (const candidate of intervalValue) {
    if (!Array.isArray(candidate) || candidate.length !== 2) {
      return Object.freeze({ state: "unknown", reason: "invalid", provenance: nonEmptyProvenance(provenance) });
    }
    const start = temporalPosition(candidate[0]);
    const end = temporalPosition(candidate[1]);
    if (start === undefined || end === undefined || (start && end && Date.parse(start) > Date.parse(end))) {
      return Object.freeze({ state: "unknown", reason: "invalid", provenance: nonEmptyProvenance(provenance) });
    }
    intervals.push(Object.freeze([start, end]));
  }
  return Object.freeze({
    state: "known",
    intervals: Object.freeze(intervals) as [[string | null, string | null], ...Array<[string | null, string | null]>],
    referenceSystem: Object.freeze({ kind: "gregorian" as const }),
    provenance: nonEmptyProvenance(provenance),
  });
}

function temporalInterval(
  datetimeValue: unknown,
  startValue: unknown,
  endValue: unknown,
): [string | null, string | null] | undefined {
  if (typeof datetimeValue === "string") {
    const datetime = temporalPosition(datetimeValue);
    return datetime ? [datetime, datetime] : undefined;
  }
  if (datetimeValue !== null && datetimeValue !== undefined) return undefined;
  const start = temporalPosition(startValue);
  const end = temporalPosition(endValue);
  if (start === undefined || end === undefined || (start && end && Date.parse(start) > Date.parse(end)))
    return undefined;
  if (start === null && end === null) return undefined;
  return [start, end];
}

function temporalPosition(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value === null ? null : undefined;
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function documentLicense(
  record: Readonly<Record<string, unknown>>,
  links: readonly ParsedStacLink[],
  baseUrl: string,
): StacLicense | undefined {
  if (typeof record.license !== "string" || !record.license.trim() || record.license.length > 4_096) return undefined;
  const hrefs: string[] = [];
  for (const link of links) {
    if (link.rel !== "license") continue;
    try {
      const resolved = new URL(link.href, baseUrl);
      const safe = safeMetadataUrl(resolved.toString());
      if (safe) hrefs.push(safe);
    } catch {
      // An invalid optional license link does not invalidate the STAC object.
    }
  }
  return Object.freeze({ expression: record.license, links: Object.freeze([...new Set(hrefs)].sort()) });
}

function crs84Definition(): CrsDefinition {
  return Object.freeze({
    kind: "authority" as const,
    authority: "OGC",
    code: "CRS84",
    uri: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
    definitionAxisOrder: LONGITUDE_LATITUDE_ORDER,
  });
}

function crsBinding(definition: CrsDefinition, coordinateOrder: AxisOrder): CrsBinding {
  return Object.freeze({
    definition,
    coordinateOrder,
    provenance: Object.freeze({
      method:
        definition.kind === "authority" && definition.authority === "OGC"
          ? ("standard-default" as const)
          : ("metadata" as const),
    }),
  });
}

function projectionCoordinateOrder(definition: CrsDefinition): AxisOrder {
  if (definition.kind === "unknown") return UNKNOWN_AXIS_ORDER;
  return definition.definitionAxisOrder.state === "known" ? definition.definitionAxisOrder : UNKNOWN_AXIS_ORDER;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be non-empty bounded text.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new HonuaDiscoveryError("invalid-endpoint", `${label} must not contain control characters.`);
    }
  }
  return value;
}

function plainObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be an object.`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonSnapshot(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => jsonSnapshot(entry, label)));
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new HonuaDiscoveryError("invalid-endpoint", `${label} is unsafe.`);
      out[key] = jsonSnapshot(value[key], label);
    }
    return Object.freeze(out);
  }
  throw new HonuaDiscoveryError("invalid-endpoint", `${label} is not JSON data.`);
}

function nonEmptyProvenance(value: readonly MetadataProvenance[]): [MetadataProvenance, ...MetadataProvenance[]] {
  if (value.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC extent provenance is missing.");
  }
  return Object.freeze([...value]) as [MetadataProvenance, ...MetadataProvenance[]];
}
