import type { PublicationBounds, PublicationField, PublicationFieldType, PublicationGeometry } from "./descriptor.js";
import { HonuaPublicationError } from "./errors.js";

/** The Portolan specification version this reader follows (STAC 1.1 profile). */
export const PORTOLAN_SCHEMA = "https://schemas.portolan-sdi.org/portolan/v0.3.0/schema.json";
/** The `honua:` STAC extension: identity, capture and public-field facts of a Honua Export. */
export const HONUA_STAC_EXTENSION = "https://schemas.honua.io/stac/honua/v1.0.0/schema.json";

export const PARQUET_MEDIA_TYPE = "application/vnd.apache.parquet";
export const PMTILES_MEDIA_TYPE = "application/vnd.pmtiles";
export const COG_MEDIA_TYPE = "image/tiff; application=geotiff; profile=cloud-optimized";

/** One asset of an Export collection, its href resolved against the document URL. */
export interface ExportAsset {
  readonly key: string;
  readonly url: string;
  readonly type: string;
  readonly roles: readonly string[];
  readonly title?: string;
  /** `file:size`: lets range reads start without a HEAD request. */
  readonly bytes?: number;
  /** `file:checksum` multihash. */
  readonly checksum?: string;
}

/** Identity, capture and field facts that only a Honua Export carries (`honua:` extension). */
export interface ExportHonuaFacts {
  readonly captureId: string;
  readonly capturedAt: string;
  readonly sourceRevision: string;
  readonly identity: {
    readonly field: string;
    readonly pmtilesProperty: string;
    readonly geoparquetColumn: string;
  };
  readonly geometry: PublicationGeometry;
  readonly publicFields: readonly string[];
}

/** A validated Portolan STAC collection, as the SDK reads it. */
export interface ExportCollection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly license: string;
  readonly updated?: string;
  readonly version?: string;
  readonly bounds: PublicationBounds;
  readonly attribution?: string;
  readonly fields: readonly PublicationField[];
  readonly data: ExportAsset;
  readonly visual?: ExportAsset;
  readonly styles: readonly ExportAsset[];
  readonly thumbnail?: ExportAsset;
  /** PMTiles registered through `rel: pmtiles`, with its vector layers. */
  readonly pmtiles?: { readonly url: string; readonly layers: readonly string[] };
  readonly honua?: ExportHonuaFacts;
  /** The raw document, as fetched. */
  readonly document: Readonly<Record<string, unknown>>;
}

type JsonObject = Readonly<Record<string, unknown>>;

const GEOMETRY_ENCODINGS = new Set<PublicationGeometry["encoding"]>([
  "wkb",
  "geoarrow-point",
  "geoarrow-linestring",
  "geoarrow-polygon",
  "geoarrow-multipoint",
  "geoarrow-multilinestring",
  "geoarrow-multipolygon",
]);

/** STAC table column types (table extension) to SDK field types. */
const TABLE_TYPES: Readonly<Record<string, PublicationFieldType>> = {
  string: "string",
  int8: "integer",
  int16: "integer",
  int32: "integer",
  int64: "integer",
  uint8: "integer",
  uint16: "integer",
  uint32: "integer",
  uint64: "integer",
  float: "number",
  double: "number",
  decimal: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  timestamp: "datetime",
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): never {
  throw new HonuaPublicationError("invalid-descriptor", `Export collection ${path} ${message}.`, {
    detail: { path },
  });
}

function text(document: JsonObject, key: string, path = key): string {
  const value = document[key];
  if (typeof value !== "string" || value.trim() === "") invalid(path, "must be a non-empty string");
  return value;
}

function optionalText(document: JsonObject, key: string, path = key): string | undefined {
  return document[key] === undefined ? undefined : text(document, key, path);
}

function stringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry)) {
    invalid(path, "must be a non-empty list of strings");
  }
  return Object.freeze([...(value as string[])]);
}

function bounds(document: JsonObject): PublicationBounds {
  const spatial = isObject(document.extent) && isObject(document.extent.spatial) ? document.extent.spatial : undefined;
  const first = Array.isArray(spatial?.bbox) ? (spatial.bbox[0] as unknown) : undefined;
  const valid = Array.isArray(first) && (first.length === 4 || first.length === 6);
  if (!valid || first.some((value) => !Number.isFinite(value))) {
    invalid("extent.spatial.bbox[0]", "must be four (or six, with heights) finite WGS84 numbers");
  }
  const [west, south, east, north] = first.length === 6 ? [first[0], first[1], first[3], first[4]] : first;
  if (south! > north! || west! < -180 || east! > 180 || south! < -90 || north! > 90) {
    invalid("extent.spatial.bbox[0]", "must lie within WGS84 with south <= north");
  }
  return Object.freeze([west!, south!, east!, north!] as const);
}

/** Resolve `href` against the document URL; only http(s) locations are read. */
export function resolveHref(href: string, base: string, path: string): string {
  let resolved: URL;
  try {
    resolved = new URL(href, base);
  } catch {
    invalid(path, `does not resolve to a URL against ${base}`);
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") invalid(path, "must be an http(s) URL");
  return resolved.href;
}

/** Roles whose assets the SDK reads; other assets may omit `type` and `roles`, as STAC allows. */
const READ_ROLES = ["data", "visual", "style", "thumbnail"];

function asset(key: string, value: unknown, base: string): ExportAsset | undefined {
  const path = `assets.${key}`;
  if (!isObject(value)) invalid(path, "must be an object");
  const roles = Array.isArray(value.roles) ? value.roles : [];
  if (!roles.some((role) => READ_ROLES.includes(role as string))) return undefined;
  const href = text(value, "href", `${path}.href`);
  const size = value["file:size"];
  if (size !== undefined && !(Number.isSafeInteger(size) && (size as number) > 0)) {
    invalid(`${path}.file:size`, "must be a positive integer");
  }
  const checksum = optionalText(value, "file:checksum", `${path}.file:checksum`);
  if (checksum !== undefined && !/^[0-9a-f]{4,}$/i.test(checksum))
    invalid(`${path}.file:checksum`, "must be a multihash");
  const title = optionalText(value, "title", `${path}.title`);
  return Object.freeze({
    key,
    url: resolveHref(href, base, `${path}.href`),
    type: text(value, "type", `${path}.type`),
    roles: stringList(value.roles, `${path}.roles`),
    ...(title ? { title } : {}),
    ...(size !== undefined ? { bytes: size as number } : {}),
    ...(checksum ? { checksum } : {}),
  });
}

function pmtilesLink(document: JsonObject, base: string): ExportCollection["pmtiles"] {
  const links = Array.isArray(document.links) ? document.links : invalid("links", "must be a list");
  const link = links.find((entry): entry is JsonObject => isObject(entry) && entry.rel === "pmtiles");
  if (!link) return undefined;
  const layers = link["pmtiles:layers"];
  return Object.freeze({
    url: resolveHref(text(link, "href", "links[rel=pmtiles].href"), base, "links[rel=pmtiles].href"),
    // Raster archives have no vector layers; the web-map-links extension requires them for vector tiles only.
    layers: layers === undefined ? Object.freeze([]) : stringList(layers, "links[rel=pmtiles].pmtiles:layers"),
  });
}

function tableFields(document: JsonObject, publicNames: ReadonlySet<string> | undefined): readonly PublicationField[] {
  const columns = document["table:columns"];
  if (columns === undefined) return Object.freeze([]);
  if (!Array.isArray(columns)) invalid("table:columns", "must be a list");
  const fields: PublicationField[] = [];
  columns.forEach((column, index) => {
    const path = `table:columns[${index}]`;
    if (!isObject(column)) invalid(path, "must be an object");
    const type = TABLE_TYPES[text(column, "type", `${path}.type`)];
    if (!type) return; // geometry and other binary columns are not attribute fields
    const description = optionalText(column, "description", `${path}.description`);
    const name = text(column, "name", `${path}.name`);
    fields.push(
      Object.freeze({
        name,
        type,
        public: publicNames ? publicNames.has(name) : true,
        ...(description ? { description } : {}),
      }),
    );
  });
  return Object.freeze(fields);
}

function honuaFacts(document: JsonObject): ExportHonuaFacts | undefined {
  const keys = Object.keys(document).filter((key) => key.startsWith("honua:"));
  if (keys.length === 0) return undefined;
  const extensions = document.stac_extensions as readonly unknown[];
  if (!extensions.includes(HONUA_STAC_EXTENSION)) invalid("stac_extensions", `must declare ${HONUA_STAC_EXTENSION}`);
  const identity = document["honua:identity"];
  const geometry = document["honua:geometry"];
  if (!isObject(identity)) invalid("honua:identity", "must be an object");
  if (!isObject(geometry)) invalid("honua:geometry", "must be an object");
  const encoding = text(geometry, "encoding", "honua:geometry.encoding") as PublicationGeometry["encoding"];
  if (!GEOMETRY_ENCODINGS.has(encoding)) invalid("honua:geometry.encoding", "must be wkb or a geoarrow encoding");
  const bboxColumn = optionalText(geometry, "bbox_column", "honua:geometry.bbox_column");
  const facts: ExportHonuaFacts = {
    captureId: text(document, "honua:capture_id"),
    capturedAt: text(document, "honua:captured_at"),
    sourceRevision: text(document, "honua:source_revision"),
    identity: Object.freeze({
      field: text(identity, "field", "honua:identity.field"),
      pmtilesProperty: text(identity, "pmtiles_property", "honua:identity.pmtiles_property"),
      geoparquetColumn: text(identity, "geoparquet_column", "honua:identity.geoparquet_column"),
    }),
    geometry: Object.freeze({
      column: text(geometry, "column", "honua:geometry.column"),
      encoding,
      types: Object.freeze([]),
      ...(bboxColumn ? { bboxColumn } : {}),
    }),
    publicFields: stringList(document["honua:public_fields"], "honua:public_fields"),
  };
  if (!facts.publicFields.includes(facts.identity.field)) {
    invalid("honua:public_fields", `must include the identity field ${facts.identity.field}`);
  }
  assertTextIdentity(document, facts.identity.field);
  return Object.freeze(facts);
}

/** Lookups compare identities as text, so a numeric identity column would silently match nothing. */
function assertTextIdentity(document: JsonObject, field: string): void {
  const columns = Array.isArray(document["table:columns"]) ? document["table:columns"] : [];
  const column = columns.find((entry): entry is JsonObject => isObject(entry) && entry.name === field);
  if (column && column.type !== "string")
    invalid("honua:identity.field", `must name a string column (${field} is ${String(column.type)})`);
}

function rolesOf(assets: readonly ExportAsset[], role: string): ExportAsset[] {
  return assets.filter((entry) => entry.roles.includes(role));
}

function attributionOf(document: JsonObject): string | undefined {
  const providers = Array.isArray(document.providers) ? document.providers : [];
  const names = providers
    .filter((provider): provider is JsonObject => isObject(provider) && Array.isArray(provider.roles))
    .filter((provider) => (provider.roles as unknown[]).some((role) => role === "producer" || role === "licensor"))
    .map((provider) => provider.name)
    .filter((name): name is string => typeof name === "string" && name !== "");
  return names.length > 0 ? [...new Set(names)].join(", ") : undefined;
}

function assetsByRole(document: JsonObject, url: string) {
  if (!isObject(document.assets)) invalid("assets", "must be an object");
  const assets = Object.entries(document.assets)
    .map(([key, value]) => asset(key, value, url))
    .filter((entry): entry is ExportAsset => entry !== undefined);
  const data = rolesOf(assets, "data");
  if (data.length !== 1) invalid("assets", `must have exactly one data asset (found ${data.length})`);
  const isDefault = (entry: ExportAsset) => Number(entry.roles.includes("default"));
  return {
    data: data[0]!,
    visual: rolesOf(assets, "visual").find((entry) => entry.type === PMTILES_MEDIA_TYPE),
    styles: Object.freeze(rolesOf(assets, "style").sort((left, right) => isDefault(right) - isDefault(left))),
    thumbnail: rolesOf(assets, "thumbnail")[0],
  };
}

/**
 * Validate a Portolan STAC collection document (STAC 1.1) and read the facts
 * the SDK needs: the `data` asset, the `visual` / `style` / `thumbnail` assets,
 * the `rel: pmtiles` link and, on a Honua Export, the `honua:` extension.
 * Asset hrefs resolve against `url`, so the same document works wherever it is served.
 */
export function readExportCollection(document: unknown, url: string): ExportCollection {
  if (!isObject(document)) invalid("document", "must be a JSON object");
  if (document.type !== "Collection") invalid("type", 'must be "Collection"');
  if (typeof document.stac_version !== "string" || !document.stac_version.startsWith("1.")) {
    invalid("stac_version", "must be a STAC 1.x version");
  }
  const extensions = Array.isArray(document.stac_extensions) ? document.stac_extensions : [];
  if (!extensions.includes(PORTOLAN_SCHEMA)) invalid("stac_extensions", `must declare ${PORTOLAN_SCHEMA}`);
  const { data, visual, styles, thumbnail } = assetsByRole(document, url);
  const honua = honuaFacts(document);
  const updated = optionalText(document, "updated");
  const version = optionalText(document, "version");
  const attribution = attributionOf(document);
  const pmtiles = pmtilesLink(document, url);
  return Object.freeze({
    id: text(document, "id"),
    title: text(document, "title"),
    description: text(document, "description"),
    license: text(document, "license"),
    ...(updated ? { updated } : {}),
    ...(version ? { version } : {}),
    bounds: bounds(document),
    ...(attribution ? { attribution } : {}),
    fields: tableFields(document, honua ? new Set(honua.publicFields) : undefined),
    data,
    ...(visual ? { visual } : {}),
    styles,
    ...(thumbnail ? { thumbnail } : {}),
    ...(pmtiles ? { pmtiles } : {}),
    ...(honua ? { honua } : {}),
    document,
  });
}
