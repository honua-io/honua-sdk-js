/**
 * Hand-rolled XML walker for the two WFS surfaces that the canonical adapter
 * actually has to read: `wfs:WFS_Capabilities` (operation list, output formats
 * by operation, advertised feature types, filter capabilities, stored-query
 * names) and `ows:ExceptionReport` (turned into `HonuaWfsExceptionError`).
 *
 * Scope is intentionally narrow — never touches feature payloads, only
 * metadata XML — so a hand-rolled walker beats pulling in a generic XML
 * parser as a runtime dependency. The walker:
 *
 * - Refuses any document with `<!DOCTYPE …>` or `<!ENTITY …>` declarations.
 *   Stops XXE-class attacks before any property is read.
 * - Is namespace-aware in the loose sense: it matches local element names
 *   (the suffix after `:`) and ignores prefixes, since WFS 2.0 uses several
 *   different prefix conventions in the wild.
 * - Returns plain typed structs — no dependency on `xmldom`,
 *   `fast-xml-parser`, or other third-party libraries.
 *
 * @module
 */

import { HonuaWfsExceptionError } from "./errors.js";

/**
 * Feature type entry parsed out of `wfs:FeatureTypeList`. Only the fields the
 * canonical adapter consumes are surfaced — coordinate extents (the
 * `WGS84BoundingBox` element) for the no-network `queryExtent` shortcut, and
 * the type name for routing.
 */
export interface WfsCapabilitiesFeatureType {
  /** Namespace-qualified type name (e.g. `parcels:lot`). */
  readonly name: string;
  /** Optional human-readable title from `Title`. */
  readonly title?: string;
  /** Optional default CRS URI from `DefaultCRS` / `DefaultSRS`. */
  readonly defaultCrs?: string;
  /**
   * Additional CRS identifiers advertised through `OtherCRS` / `OtherSRS`.
   * Optional so snapshots constructed against the pre-#823 public shape
   * remain source-compatible; parser-produced snapshots always populate it.
   */
  readonly otherCrs?: readonly string[];
  /**
   * Namespace evidence in scope on the QName-bearing `Name` element. An empty
   * `uri` records a prefixed QName whose binding is missing or explicitly
   * undeclared, so capability consumers can fail closed without falling back
   * to an out-of-scope ancestor declaration.
   *
   * Optional for source compatibility with manually constructed snapshots;
   * consumers may fall back to the snapshot's root declarations only when
   * this element-scoped evidence is absent.
   */
  readonly namespace?: {
    readonly prefix: string;
    readonly uri: string;
  };
  /** Optional WGS84 bounding box from `ows:WGS84BoundingBox`. */
  readonly wgs84BoundingBox?: {
    readonly xmin: number;
    readonly ymin: number;
    readonly xmax: number;
    readonly ymax: number;
  };
}

/**
 * Operation metadata snapshot. The key shape we care about is "what GET /
 * POST methods does the server advertise for each operation, and which output
 * formats does it support" — that drives the canonical adapter's content-type
 * negotiation.
 */
export interface WfsCapabilitiesOperation {
  readonly name: string;
  readonly methods: ReadonlyArray<"GET" | "POST">;
  readonly outputFormats: readonly string[];
  /**
   * DCP `xlink:href` advertised for the HTTP GET binding of this operation
   * (`ows:DCP/ows:HTTP/ows:Get/@xlink:href`). Raw third-party WFS servers
   * (e.g. GeoServer mounted at `/geoserver/ows`) frequently advertise a
   * DIFFERENT operation URL (`/geoserver/wfs`); the adapter must honour it
   * rather than replay the GetCapabilities endpoint path.
   */
  readonly getUrl?: string;
  /** DCP `xlink:href` for the HTTP POST binding (`ows:Post/@xlink:href`). */
  readonly postUrl?: string;
}

/**
 * Snapshot of the parsed `wfs:WFS_Capabilities` document. Anything the adapter
 * needs to read after parsing lives here so the underlying XML can be
 * discarded.
 */
export interface WfsCapabilitiesSnapshot {
  /** WFS version string from the root element's `version` attribute. */
  readonly version?: string;
  /** Operations by name (e.g. `GetFeature`, `Transaction`). */
  readonly operations: ReadonlyMap<string, WfsCapabilitiesOperation>;
  /** Output formats per operation using the server's exact advertised spelling. */
  readonly outputFormatsByOp: ReadonlyMap<string, readonly string[]>;
  /** Feature types in declaration order. */
  readonly featureTypes: readonly WfsCapabilitiesFeatureType[];
  /** Namespace declarations advertised on the capabilities root, keyed by prefix. */
  readonly namespaces: ReadonlyMap<string, string>;
  /** Spatial / temporal / scalar capability flags from `Filter_Capabilities`. */
  readonly filterCapabilities: WfsFilterCapabilities;
  /** Stored-query identifiers advertised through the `ListStoredQueries` op. */
  readonly storedQueryNames: readonly string[];
}

/**
 * Coarse advertisement of the FES capabilities the server supports. Real
 * filter capabilities are richer — these are the flags the adapter actually
 * reads to gate `queryExtent`, `queryAll`, and stored-query routing.
 */
export interface WfsFilterCapabilities {
  readonly spatial: readonly string[];
  readonly scalar: readonly string[];
  readonly temporal: readonly string[];
}

/**
 * Parsed `ows:ExceptionReport` payload.
 */
export interface WfsExceptionReport {
  exceptionCode: string;
  locator?: string;
  message: string;
}

/** Attributes captured for an opened element. */
type Attributes = Record<string, string>;

interface ElementNode {
  /** Local element name (suffix after `:`). */
  local: string;
  /** Original prefixed name (kept for diagnostics; not consumed by the parser). */
  qname: string;
  attributes: Attributes;
  /** Namespace declarations in scope at this exact element. */
  namespaces: Attributes;
  children: ElementNode[];
  text: string;
}

/** Fixed allocation ceilings for every WFS metadata XML document. */
export const WFS_XML_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxElements: 12_000,
  maxDepth: 32,
  maxAttributesPerElement: 64,
  maxAttributeBytesPerElement: 64 * 1024,
  maxTextBytes: 512 * 1024,
});

interface XmlBudget {
  elements: number;
  textBytes: number;
}

/**
 * Parse a WFS `GetCapabilities` document. Throws when the document declares
 * a DOCTYPE / ENTITY (XXE defense) or when the root element is not
 * `WFS_Capabilities` / not parseable.
 */
export function parseWfsCapabilities(xml: string): WfsCapabilitiesSnapshot {
  const root = parseXml(xml);
  if (root.local !== "WFS_Capabilities") {
    if (root.local === "ExceptionReport") {
      const report = parseExceptionFromRoot(root);
      throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
    }
    throw new Error(`WFS GetCapabilities: expected <WFS_Capabilities>, got <${root.qname}>`);
  }

  const version = root.attributes.version;
  const operationsList = findChild(root, "OperationsMetadata")
    ? findChildren(findChildOrThrow(root, "OperationsMetadata"), "Operation")
    : [];
  const operations = new Map<string, WfsCapabilitiesOperation>();
  const outputFormatsByOp = new Map<string, readonly string[]>();
  for (const op of operationsList) {
    const name = op.attributes.name;
    if (!name) continue;
    const methods: Array<"GET" | "POST"> = [];
    let getUrl: string | undefined;
    let postUrl: string | undefined;
    for (const dcp of findChildren(op, "DCP")) {
      const http = findChild(dcp, "HTTP");
      if (!http) continue;
      for (const method of http.children) {
        // The XML walker strips the `xlink:` prefix, so the href attribute
        // is keyed as `href`.
        if (method.local === "Get") {
          methods.push("GET");
          if (getUrl === undefined && method.attributes.href) getUrl = method.attributes.href;
        }
        if (method.local === "Post") {
          methods.push("POST");
          if (postUrl === undefined && method.attributes.href) postUrl = method.attributes.href;
        }
      }
    }
    const outputFormats: string[] = [];
    for (const param of findChildren(op, "Parameter")) {
      if (param.attributes.name?.toLowerCase() !== "outputformat") continue;
      for (const allowed of findChildren(param, "AllowedValues")) {
        for (const value of findChildren(allowed, "Value")) {
          const text = value.text.trim();
          if (text) outputFormats.push(text);
        }
      }
      // Older WFS servers advertise output formats as direct <Value> children
      // of <Parameter> instead of nested in <AllowedValues>.
      for (const value of findChildren(param, "Value")) {
        const text = value.text.trim();
        if (text) outputFormats.push(text);
      }
    }
    const immutableMethods = Object.freeze([...new Set(methods)] as Array<"GET" | "POST">);
    const immutableOutputFormats = Object.freeze([...outputFormats]);
    operations.set(
      name,
      Object.freeze({
        name,
        methods: immutableMethods,
        outputFormats: immutableOutputFormats,
        ...(getUrl !== undefined ? { getUrl } : {}),
        ...(postUrl !== undefined ? { postUrl } : {}),
      }),
    );
    outputFormatsByOp.set(name, immutableOutputFormats);
  }

  const featureTypeList = findChild(root, "FeatureTypeList");
  const featureTypes: WfsCapabilitiesFeatureType[] = [];
  if (featureTypeList) {
    for (const ft of findChildren(featureTypeList, "FeatureType")) {
      const nameNode = findChild(ft, "Name");
      const titleNode = findChild(ft, "Title");
      const defaultCrsNode = findChild(ft, "DefaultCRS") ?? findChild(ft, "DefaultSRS");
      const otherCrs = [
        ...findChildren(ft, "OtherCRS").map((node) => node.text.trim()),
        ...findChildren(ft, "OtherSRS").map((node) => node.text.trim()),
      ].filter((value) => value.length > 0);
      const bboxNode = findChild(ft, "WGS84BoundingBox");
      const lowerCorner = bboxNode ? findChild(bboxNode, "LowerCorner") : undefined;
      const upperCorner = bboxNode ? findChild(bboxNode, "UpperCorner") : undefined;
      const namespace = nameNode ? namespaceBindingForQName(nameNode, nameNode.text.trim()) : undefined;
      const entry: {
        name: string;
        title?: string;
        defaultCrs?: string;
        otherCrs: readonly string[];
        namespace?: { readonly prefix: string; readonly uri: string };
        wgs84BoundingBox?: {
          readonly xmin: number;
          readonly ymin: number;
          readonly xmax: number;
          readonly ymax: number;
        };
      } = {
        name: nameNode?.text.trim() ?? "",
        otherCrs: Object.freeze([...otherCrs]),
        ...(namespace ? { namespace } : {}),
      };
      if (titleNode?.text) entry.title = titleNode.text.trim();
      if (defaultCrsNode?.text) entry.defaultCrs = defaultCrsNode.text.trim();
      if (lowerCorner && upperCorner) {
        const [xmin, ymin] = lowerCorner.text.trim().split(/\s+/).map(Number);
        const [xmax, ymax] = upperCorner.text.trim().split(/\s+/).map(Number);
        if (Number.isFinite(xmin) && Number.isFinite(ymin) && Number.isFinite(xmax) && Number.isFinite(ymax)) {
          entry.wgs84BoundingBox = Object.freeze({ xmin, ymin, xmax, ymax });
        }
      }
      if (entry.name) featureTypes.push(Object.freeze(entry));
    }
  }

  const filterCapabilities = parseFilterCapabilities(findChild(root, "Filter_Capabilities"));
  const storedQueryNames = parseStoredQueryNames(root);
  const namespaces = new Map<string, string>();
  for (const [name, value] of Object.entries(root.attributes)) {
    if (name.startsWith("xmlns:") && value) namespaces.set(name.slice("xmlns:".length), value);
  }

  return Object.freeze({
    ...(version ? { version } : {}),
    operations: immutableMap(operations),
    outputFormatsByOp: immutableMap(outputFormatsByOp),
    featureTypes: Object.freeze([...featureTypes]),
    namespaces: immutableMap(namespaces),
    filterCapabilities: immutableFilterCapabilities(filterCapabilities),
    storedQueryNames: Object.freeze([...storedQueryNames]),
  });
}

function namespaceBindingForQName(
  node: ElementNode,
  qname: string,
): { readonly prefix: string; readonly uri: string } | undefined {
  const separator = qname.indexOf(":");
  if (separator <= 0 || separator === qname.length - 1 || qname.indexOf(":", separator + 1) !== -1) {
    return undefined;
  }
  const prefix = qname.slice(0, separator);
  return Object.freeze({ prefix, uri: node.namespaces[prefix] ?? "" });
}

function immutableMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const owned = new Map(source);
  const view: ReadonlyMap<K, V> = {
    get size(): number {
      return owned.size;
    },
    get(key: K): V | undefined {
      return owned.get(key);
    },
    has(key: K): boolean {
      return owned.has(key);
    },
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
      for (const [key, value] of owned) callbackfn.call(thisArg, value, key, view);
    },
    entries(): MapIterator<[K, V]> {
      return owned.entries();
    },
    keys(): MapIterator<K> {
      return owned.keys();
    },
    values(): MapIterator<V> {
      return owned.values();
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return owned[Symbol.iterator]();
    },
  };
  return Object.freeze(view);
}

function immutableFilterCapabilities(value: WfsFilterCapabilities): WfsFilterCapabilities {
  return Object.freeze({
    spatial: Object.freeze([...value.spatial]),
    scalar: Object.freeze([...value.scalar]),
    temporal: Object.freeze([...value.temporal]),
  });
}

/**
 * Parse an `ows:ExceptionReport` document into structured fields. Used when
 * the client sees a non-200 response carrying an XML body or when a
 * GetCapabilities call returns an ExceptionReport.
 */
export function parseWfsExceptionReport(xml: string): WfsExceptionReport {
  const root = parseXml(xml);
  if (root.local !== "ExceptionReport") {
    throw new Error(`WFS ExceptionReport: expected <ExceptionReport>, got <${root.qname}>`);
  }
  return parseExceptionFromRoot(root);
}

function parseExceptionFromRoot(root: ElementNode): WfsExceptionReport {
  const exception = findChild(root, "Exception");
  if (!exception) {
    return { exceptionCode: "UnknownException", message: "ExceptionReport without <Exception>" };
  }
  const code = exception.attributes.exceptionCode ?? "UnknownException";
  const locator = exception.attributes.locator;
  const text = findChild(exception, "ExceptionText");
  const message = text ? text.text.trim() : "";
  const out: WfsExceptionReport = {
    exceptionCode: code,
    message: message || code,
  };
  if (locator) out.locator = locator;
  return out;
}

function parseFilterCapabilities(node: ElementNode | undefined): WfsFilterCapabilities {
  if (!node) {
    return { spatial: [], scalar: [], temporal: [] };
  }
  const spatial: string[] = [];
  const scalar: string[] = [];
  const temporal: string[] = [];
  const spatialOps = findChild(findChild(node, "Spatial_Capabilities"), "SpatialOperators");
  if (spatialOps) {
    for (const op of findChildren(spatialOps, "SpatialOperator")) {
      if (op.attributes.name) spatial.push(op.attributes.name);
    }
  }
  const scalarOps = findChild(findChild(node, "Scalar_Capabilities"), "ComparisonOperators");
  if (scalarOps) {
    for (const op of findChildren(scalarOps, "ComparisonOperator")) {
      const text = op.text.trim();
      if (text) scalar.push(text);
    }
  }
  const temporalOps = findChild(findChild(node, "Temporal_Capabilities"), "TemporalOperators");
  if (temporalOps) {
    for (const op of findChildren(temporalOps, "TemporalOperator")) {
      if (op.attributes.name) temporal.push(op.attributes.name);
    }
  }
  return { spatial, scalar, temporal };
}

function parseStoredQueryNames(root: ElementNode): readonly string[] {
  // `wfs:WFS_Capabilities` itself does not carry stored queries; they come
  // back through a separate `ListStoredQueries` operation. Some servers do
  // include a sibling `<wfs:StoredQueries>` block as an extension; capture
  // names if present, otherwise return empty.
  const stored = findChild(root, "StoredQueries");
  if (!stored) return [];
  const ids: string[] = [];
  for (const sq of findChildren(stored, "StoredQuery")) {
    if (sq.attributes.id) ids.push(sq.attributes.id);
  }
  return ids;
}

/**
 * Parse the `ListStoredQueriesResponse` body — a flat list of
 * `<wfs:StoredQuery id="...">` elements. Returned by `HonuaWfs.storedQueries()`.
 */
export function parseListStoredQueriesResponse(xml: string): readonly string[] {
  const root = parseXml(xml);
  if (root.local !== "ListStoredQueriesResponse") {
    if (root.local === "ExceptionReport") {
      const report = parseExceptionFromRoot(root);
      throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
    }
    throw new Error(`WFS ListStoredQueries: expected <ListStoredQueriesResponse>, got <${root.qname}>`);
  }
  const ids: string[] = [];
  for (const sq of findChildren(root, "StoredQuery")) {
    if (sq.attributes.id) ids.push(sq.attributes.id);
  }
  return ids;
}

/**
 * GML property types that carry a geometry value. A `DescribeFeatureType`
 * XSD names the feature type's geometry property through one of these, so the
 * set is what lets the adapter resolve the real property name per server
 * (`the_geom` on PostGIS-via-GeoServer, `msGeometry` on MapServer, arbitrary
 * per-schema names elsewhere) instead of assuming one vendor default.
 */
const GML_GEOMETRY_PROPERTY_TYPES = new Set([
  "GeometryPropertyType",
  "GeometryAssociationType",
  "GeometryArrayPropertyType",
  "MultiGeometryPropertyType",
  "AbstractGeometryType",
  "PointPropertyType",
  "MultiPointPropertyType",
  "LineStringPropertyType",
  "MultiLineStringPropertyType",
  "CurvePropertyType",
  "MultiCurvePropertyType",
  "PolygonPropertyType",
  "MultiPolygonPropertyType",
  "SurfacePropertyType",
  "MultiSurfacePropertyType",
  "SolidPropertyType",
  "MultiSolidPropertyType",
]);

/** GML namespace prefixes bind to a URI under this root in every GML version. */
const GML_NAMESPACE_ROOT = "http://www.opengis.net/gml";

/**
 * Parse a `DescribeFeatureType` XSD and return the geometry property names
 * declared for `typeName`, in schema declaration order. Empty when the schema
 * declares no GML geometry property (schema-less / non-spatial types) — the
 * caller fails closed rather than guessing a vendor default.
 *
 * Only the requested feature type's own complex type is walked, so a schema
 * carrying several types cannot leak another type's geometry property.
 */
export function parseWfsDescribeFeatureTypeGeometry(xml: string, typeName: string): readonly string[] {
  const root = parseXml(xml);
  if (root.local !== "schema") {
    if (root.local === "ExceptionReport") {
      const report = parseExceptionFromRoot(root);
      throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
    }
    throw new Error(`WFS DescribeFeatureType: expected <schema>, got <${root.qname}>`);
  }
  const declaration = findFeatureTypeDeclaration(root, stripPrefix(typeName));
  if (!declaration) return Object.freeze([]);
  const names: string[] = [];
  collectGeometryPropertyNames(declaration, names);
  return Object.freeze(names);
}

/**
 * Locate the complex type that declares one feature type's properties. Servers
 * spell this three ways: a global `<element name="lot" type="ns:lotType"/>`
 * pointing at a named `<complexType>`, an inline anonymous `<complexType>` on
 * that element, or (single-type responses) just the one complex type in the
 * document.
 */
function findFeatureTypeDeclaration(root: ElementNode, localTypeName: string): ElementNode | undefined {
  const complexTypes = findChildren(root, "complexType");
  const element = findChildren(root, "element").find((node) => node.attributes.name === localTypeName);
  if (element) {
    const typeRef = element.attributes.type;
    const named = typeRef
      ? complexTypes.find((node) => node.attributes.name === stripPrefix(typeRef))
      : findChild(element, "complexType");
    if (named) return named;
  }
  const conventional = complexTypes.find((node) => node.attributes.name === `${localTypeName}Type`);
  if (conventional) return conventional;
  return complexTypes.length === 1 ? complexTypes[0] : undefined;
}

function collectGeometryPropertyNames(node: ElementNode, out: string[]): void {
  for (const child of node.children) {
    if (child.local === "element") {
      const name = child.attributes.name;
      const type = child.attributes.type;
      if (name && type && isGmlGeometryPropertyType(child, type)) {
        out.push(name);
        continue;
      }
    }
    collectGeometryPropertyNames(child, out);
  }
}

function isGmlGeometryPropertyType(node: ElementNode, type: string): boolean {
  const colon = type.indexOf(":");
  const prefix = colon > 0 ? type.slice(0, colon) : undefined;
  if (!GML_GEOMETRY_PROPERTY_TYPES.has(stripPrefix(type))) return false;
  // A prefix that resolves to a non-GML namespace is a same-named schema type
  // from another vocabulary, not a geometry property. An unresolvable prefix
  // is accepted: servers routinely omit the binding from the fragment we read.
  const uri = prefix === undefined ? undefined : node.namespaces[prefix];
  return uri === undefined || uri.startsWith(GML_NAMESPACE_ROOT);
}

/**
 * Parse the response of a `Transaction` request. Returns the per-bucket
 * counts plus any insert handles surfaced in `<wfs:InsertResults>`.
 */
export interface WfsTransactionSummary {
  totalInserted: number;
  totalUpdated: number;
  totalDeleted: number;
  insertResults: ReadonlyArray<{ handle?: string; ids: readonly string[] }>;
}

export function parseWfsTransactionResponse(xml: string): WfsTransactionSummary {
  const root = parseXml(xml);
  if (root.local !== "TransactionResponse") {
    if (root.local === "ExceptionReport") {
      const report = parseExceptionFromRoot(root);
      throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
    }
    throw new Error(`WFS Transaction: expected <TransactionResponse>, got <${root.qname}>`);
  }
  const summary = findChild(root, "TransactionSummary");
  const totalInserted = summary ? parseIntOrZero(findChild(summary, "totalInserted")?.text) : 0;
  const totalUpdated = summary ? parseIntOrZero(findChild(summary, "totalUpdated")?.text) : 0;
  const totalDeleted = summary ? parseIntOrZero(findChild(summary, "totalDeleted")?.text) : 0;
  const insertResultsNode = findChild(root, "InsertResults");
  const insertResults: Array<{ handle?: string; ids: string[] }> = [];
  if (insertResultsNode) {
    for (const feature of findChildren(insertResultsNode, "Feature")) {
      const handle = feature.attributes.handle;
      const ids: string[] = [];
      for (const ref of findChildren(feature, "ResourceId")) {
        if (ref.attributes.rid) ids.push(ref.attributes.rid);
      }
      // Older WFS implementations used `<ogc:FeatureId fid="...">`.
      for (const ref of findChildren(feature, "FeatureId")) {
        if (ref.attributes.fid) ids.push(ref.attributes.fid);
      }
      const entry: { handle?: string; ids: string[] } = { ids };
      if (handle) entry.handle = handle;
      insertResults.push(entry);
    }
  }
  return { totalInserted, totalUpdated, totalDeleted, insertResults };
}

function parseIntOrZero(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ── XML walker ───────────────────────────────────────────────

/**
 * Parse a small, well-formed XML document into an in-memory tree. The walker
 * intentionally does not try to be a full XML 1.0 parser — it covers the
 * subset that WFS / OWS ExceptionReport / ListStoredQueries / Transaction
 * documents actually emit.
 *
 * Hard-fail on `<!DOCTYPE` / `<!ENTITY` / `<!--` declarations involving
 * external IDs to defend against XXE.
 */
export function parseXml(xml: string): ElementNode {
  if (typeof xml !== "string" || xml.length === 0) {
    throw new Error("WFS XML parser: empty document");
  }
  if (utf8Length(xml) > WFS_XML_LIMITS.maxBytes) {
    throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxBytes}-byte limit`);
  }

  // XXE / external-entity defense: refuse documents that declare a DOCTYPE
  // (which is the only way to introduce ENTITY declarations in XML 1.0).
  // This is intentionally strict — Honua's WFS surfaces never emit a
  // DOCTYPE, and doing so on third-party servers does not unlock anything
  // we want to read here.
  const lower = xml.toLowerCase();
  if (lower.includes("<!doctype") || lower.includes("<!entity")) {
    throw new Error("WFS XML parser: DOCTYPE / ENTITY declarations are rejected");
  }

  const stripped = stripPrologAndComments(xml);
  const len = stripped.length;
  let i = 0;
  const stack: ElementNode[] = [];
  let root: ElementNode | undefined;
  const budget: XmlBudget = { elements: 0, textBytes: 0 };

  while (i < len) {
    if (stripped[i] === "<") {
      if (stripped.startsWith("<?", i)) {
        const end = stripped.indexOf("?>", i + 2);
        if (end === -1) throw new Error("WFS XML parser: unterminated processing instruction");
        i = end + 2;
        continue;
      }
      if (stripped.startsWith("<!--", i)) {
        const end = stripped.indexOf("-->", i + 4);
        if (end === -1) throw new Error("WFS XML parser: unterminated comment");
        i = end + 3;
        continue;
      }
      if (stripped.startsWith("<![CDATA[", i)) {
        const end = stripped.indexOf("]]>", i + 9);
        if (end === -1) throw new Error("WFS XML parser: unterminated CDATA");
        const text = stripped.slice(i + 9, end);
        const top = stack[stack.length - 1];
        if (top) appendXmlText(top, text, budget);
        i = end + 3;
        continue;
      }
      // Closing tag.
      if (stripped[i + 1] === "/") {
        const end = stripped.indexOf(">", i + 2);
        if (end === -1) throw new Error("WFS XML parser: unterminated closing tag");
        const closing = stripped.slice(i + 2, end).trim();
        const top = stack[stack.length - 1];
        if (!top) throw new Error(`WFS XML parser: stray closing tag </${closing}>`);
        if (top.qname !== closing) {
          throw new Error(`WFS XML parser: mismatched closing tag </${closing}> (expected </${top.qname}>)`);
        }
        stack.pop();
        i = end + 1;
        continue;
      }
      // Opening (or self-closing) tag.
      const end = findTagEnd(stripped, i);
      if (end === -1) throw new Error("WFS XML parser: unterminated opening tag");
      const inner = stripped.slice(i + 1, end);
      const selfClosing = inner.endsWith("/");
      const tagBody = selfClosing ? inner.slice(0, -1).trim() : inner.trim();
      const { name, attributes } = parseTagBody(tagBody);
      budget.elements += 1;
      if (budget.elements > WFS_XML_LIMITS.maxElements) {
        throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxElements}-element limit`);
      }
      if (stack.length + 1 > WFS_XML_LIMITS.maxDepth) {
        throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxDepth}-level depth limit`);
      }
      const local = stripPrefix(name);
      const parent = stack[stack.length - 1];
      const namespaces = Object.assign(Object.create(null) as Attributes, parent?.namespaces);
      for (const [attributeName, value] of Object.entries(attributes)) {
        if (attributeName === "xmlns") namespaces[""] = value;
        else if (attributeName.startsWith("xmlns:")) namespaces[attributeName.slice("xmlns:".length)] = value;
      }
      const node: ElementNode = {
        local,
        qname: name,
        attributes,
        namespaces,
        children: [],
        text: "",
      };
      if (parent) parent.children.push(node);
      else if (root) {
        throw new Error("WFS XML parser: multiple root elements");
      } else {
        root = node;
      }
      if (!selfClosing) stack.push(node);
      i = end + 1;
      continue;
    }
    // Text node — accumulate against the current top, decoding entities.
    const next = stripped.indexOf("<", i);
    const text = stripped.slice(i, next === -1 ? len : next);
    const top = stack[stack.length - 1];
    if (top) appendXmlText(top, decodeXmlEntities(text), budget);
    i = next === -1 ? len : next;
  }

  if (stack.length > 0) {
    throw new Error(`WFS XML parser: unclosed element <${stack[stack.length - 1].qname}>`);
  }
  if (!root) {
    throw new Error("WFS XML parser: no root element");
  }
  return root;
}

function stripPrologAndComments(xml: string): string {
  // Trim BOM and leading whitespace.
  let out = xml;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out.trim();
}

function findTagEnd(xml: string, start: number): number {
  // The tag body may contain attributes whose values are double- or single-quoted
  // and could legitimately contain `>` characters. Track quote state.
  let i = start + 1;
  let quote: "'" | '"' | undefined;
  while (i < xml.length) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
    i += 1;
  }
  return -1;
}

function parseTagBody(body: string): { name: string; attributes: Attributes } {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("WFS XML parser: empty tag");
  // Tag name runs to the first whitespace; attributes follow.
  let i = 0;
  while (i < trimmed.length && !/\s/.test(trimmed[i])) i += 1;
  const name = trimmed.slice(0, i);
  if (!name) throw new Error("WFS XML parser: missing tag name");
  const attributes = Object.create(null) as Attributes;
  let attributeCount = 0;
  let attributeBytes = 0;
  let j = i;
  while (j < trimmed.length) {
    while (j < trimmed.length && /\s/.test(trimmed[j])) j += 1;
    if (j >= trimmed.length) break;
    const eq = trimmed.indexOf("=", j);
    if (eq === -1) throw new Error("WFS XML parser: attribute lacks '='");
    const attrName = trimmed.slice(j, eq).trim();
    if (attrName.length === 0 || /\s/.test(attrName)) {
      throw new Error("WFS XML parser: invalid attribute name");
    }
    attributeCount += 1;
    if (attributeCount > WFS_XML_LIMITS.maxAttributesPerElement) {
      throw new Error("WFS XML parser: element exceeds the bounded attribute count");
    }
    let k = eq + 1;
    while (k < trimmed.length && /\s/.test(trimmed[k])) k += 1;
    const quote = trimmed[k];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`WFS XML parser: attribute "${attrName}" must be quoted`);
    }
    const close = trimmed.indexOf(quote, k + 1);
    if (close === -1) throw new Error(`WFS XML parser: unterminated attribute value for "${attrName}"`);
    const rawValue = trimmed.slice(k + 1, close);
    const normalizedName = attrName.startsWith("xmlns:") ? attrName : stripPrefix(attrName);
    const value = decodeXmlEntities(rawValue);
    attributeBytes += utf8Length(attrName) + utf8Length(value);
    if (attributeBytes > WFS_XML_LIMITS.maxAttributeBytesPerElement) {
      throw new Error("WFS XML parser: element exceeds the bounded attribute-byte limit");
    }
    if (Object.hasOwn(attributes, normalizedName)) {
      throw new Error(`WFS XML parser: repeated attribute "${normalizedName}"`);
    }
    attributes[normalizedName] = value;
    j = close + 1;
  }
  return { name, attributes };
}

function appendXmlText(node: ElementNode, value: string, budget: XmlBudget): void {
  if (value.length === 0) return;
  budget.textBytes += utf8Length(value);
  if (budget.textBytes > WFS_XML_LIMITS.maxTextBytes) {
    throw new Error(`WFS XML parser: document exceeds the ${WFS_XML_LIMITS.maxTextBytes}-byte text limit`);
  }
  node.text += value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stripPrefix(name: string): string {
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(idx + 1);
}

function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function findChild(node: ElementNode | undefined, local: string): ElementNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (child.local === local) return child;
  }
  return undefined;
}

function findChildOrThrow(node: ElementNode, local: string): ElementNode {
  const found = findChild(node, local);
  if (!found) throw new Error(`WFS XML parser: missing child <${local}> on <${node.qname}>`);
  return found;
}

function findChildren(node: ElementNode | undefined, local: string): readonly ElementNode[] {
  if (!node) return [];
  return node.children.filter((c) => c.local === local);
}
