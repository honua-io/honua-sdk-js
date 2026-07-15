/**
 * WMS 1.3.0 Capabilities parser. Hand-rolled, narrow-scope text-walker
 * over a `WMS_Capabilities` document. Returns a typed shape (layers,
 * styles, bbox-per-CRS, dimensions, advertised formats) that the SDK
 * can route through the canonical `Source` surface without leaking XML
 * nodes into its public API.
 *
 * The parser is closed-schema (WMS 1.3 + the ISO 19128 service-metadata
 * subset honua-server emits) and tolerates missing optional nodes
 * gracefully. Vendor-extension elements outside the named set are
 * ignored. A `HonuaWmsCapabilitiesParseError` (extends `HonuaError`) is
 * thrown when a required root or top-level node is missing.
 *
 * @module
 */

import { HonuaSdkError, withHonuaErrorClassification } from "./error-base.js";
import { decodeXmlText as decodeXmlEntities } from "./xml-text.js";

/**
 * Top-level WMS Capabilities surface.
 */
export interface WmsCapabilities {
  /** WMS protocol version. honua-server advertises `1.3.0`. */
  version: string;
  service: WmsCapabilitiesService;
  layers: ReadonlyArray<WmsCapabilityLayer>;
  formats: WmsCapabilitiesFormats;
  request: WmsCapabilitiesRequestSupport;
}

export interface WmsCapabilitiesService {
  title?: string;
  abstract?: string;
}

export interface WmsCapabilitiesFormats {
  /** Image MIME types accepted by `GetMap`. */
  map: readonly string[];
  /** Info-format MIME types accepted by `GetFeatureInfo`. */
  featureInfo: readonly string[];
  /** Image MIME types accepted by `GetLegendGraphic`. */
  legend: readonly string[];
}

export interface WmsCapabilitiesRequestSupport {
  /** Capability advertises a `GetFeatureInfo` request element. */
  getFeatureInfo: boolean;
  /** Capability advertises a `GetLegendGraphic` request element. */
  getLegendGraphic: boolean;
}

export interface WmsCapabilityLayer {
  name: string;
  title?: string;
  abstract?: string;
  /** CRS codes advertised on this layer (and inherited from ancestors). */
  crs: readonly string[];
  /** Bounding boxes per CRS. Multiple entries permitted. */
  bbox: ReadonlyArray<WmsCapabilityBoundingBox>;
  /** Styles advertised on this layer. The first entry is the default. */
  styles: ReadonlyArray<WmsCapabilityStyle>;
  /** Dimensions (`time`, `elevation`, vendor names). */
  dimensions: ReadonlyArray<WmsCapabilityDimension>;
  queryable: boolean;
  /** Sub-layers nested under this entry. */
  children: ReadonlyArray<WmsCapabilityLayer>;
}

export interface WmsCapabilityBoundingBox {
  crs: string;
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

export interface WmsCapabilityStyle {
  name: string;
  title?: string;
  /** Externally-served legend URL (`OnlineResource@xlink:href`) when advertised. */
  legendUrl?: string;
}

export interface WmsCapabilityDimension {
  name: string;
  units?: string;
  default?: string;
  /** Discrete values; for time this is typically a comma-separated list. */
  values: readonly string[];
}

/**
 * Thrown when WMS Capabilities XML is missing required root structure or
 * is otherwise malformed in a way that prevents extracting the typed
 * shape above. Recoverable per-node gaps (missing `<Title>`,
 * `<Abstract>`, etc.) are tolerated and return defaults.
 */
export class HonuaWmsCapabilitiesParseError extends HonuaSdkError {
  public constructor(message: string) {
    super("core.wms-capabilities-parse", message, withHonuaErrorClassification({}, "core", "protocol", false));
    this.name = "HonuaWmsCapabilitiesParseError";
  }
}

/**
 * Parse a `WMS_Capabilities` text body into the typed `WmsCapabilities`
 * shape. The input is the raw XML string returned by `requestText`; the
 * parser walks it once with a small named-element matcher and tolerates
 * vendor extensions (unknown elements are skipped).
 */
export function parseWmsCapabilities(xml: string): WmsCapabilities {
  if (typeof xml !== "string" || xml.length === 0) {
    throw new HonuaWmsCapabilitiesParseError("WMS Capabilities body is empty");
  }
  const root = findElement(xml, 0, "WMS_Capabilities") ?? findElement(xml, 0, "WMT_MS_Capabilities");
  if (!root) {
    throw new HonuaWmsCapabilitiesParseError(
      "missing <WMS_Capabilities> root element (received WMS Capabilities XML?)",
    );
  }
  const version = readAttribute(root.openTag, "version") ?? "1.3.0";
  const service = parseServiceMetadata(root.inner);
  const capabilityNode = findElement(root.inner, 0, "Capability");
  const requestNode = capabilityNode ? findElement(capabilityNode.inner, 0, "Request") : undefined;
  const formats = parseFormats(requestNode?.inner ?? "");
  const requestSupport: WmsCapabilitiesRequestSupport = {
    getFeatureInfo: requestNode ? findElement(requestNode.inner, 0, "GetFeatureInfo") !== undefined : false,
    getLegendGraphic: requestNode ? findElement(requestNode.inner, 0, "GetLegendGraphic") !== undefined : false,
  };
  const layers: WmsCapabilityLayer[] = [];
  if (capabilityNode) {
    for (const layer of iterChildLayers(capabilityNode.inner, [])) {
      layers.push(layer);
    }
  }
  return {
    version,
    service,
    layers,
    formats,
    request: requestSupport,
  };
}

function parseServiceMetadata(capabilityXml: string): WmsCapabilitiesService {
  const node = findElement(capabilityXml, 0, "Service");
  if (!node) return {};
  const out: WmsCapabilitiesService = {};
  const title = readTextElement(node.inner, "Title");
  if (title !== undefined) out.title = title;
  const abstract = readTextElement(node.inner, "Abstract");
  if (abstract !== undefined) out.abstract = abstract;
  return out;
}

function parseFormats(requestInnerXml: string): WmsCapabilitiesFormats {
  const map = collectFormats(requestInnerXml, "GetMap");
  const featureInfo = collectFormats(requestInnerXml, "GetFeatureInfo");
  const legend = collectFormats(requestInnerXml, "GetLegendGraphic");
  return { map, featureInfo, legend };
}

function collectFormats(requestInnerXml: string, requestName: string): readonly string[] {
  const node = findElement(requestInnerXml, 0, requestName);
  if (!node) return [];
  const formats: string[] = [];
  let cursor = 0;
  while (cursor < node.inner.length) {
    const fmt = findElement(node.inner, cursor, "Format");
    if (!fmt) break;
    const text = decodeXmlText(fmt.inner.trim());
    if (text.length > 0) formats.push(text);
    cursor = fmt.endIndex;
  }
  return formats;
}

/**
 * Walk every `<Layer>` element directly inside `parentInner`, applying
 * inherited CRS / dimension / style fields from ancestors per WMS 1.3
 * §7.2.4.6 inheritance rules. Iterative (no recursion through closures)
 * to keep the parse hot path small.
 */
function* iterChildLayers(
  parentInner: string,
  ancestors: readonly WmsCapabilityLayer[],
): Generator<WmsCapabilityLayer> {
  let cursor = 0;
  while (cursor < parentInner.length) {
    const layer = findElement(parentInner, cursor, "Layer");
    if (!layer) break;
    const queryableAttr = readAttribute(layer.openTag, "queryable");
    const inherited = mergeAncestors(ancestors);
    // Strip nested <Layer>...</Layer> subtrees from the layer's own inner so
    // descendant Name / Title / CRS / BoundingBox / Style / Dimension nodes
    // do not leak upward into the parent (and from there into siblings via
    // `mergeAncestors`). WMS 1.3 §7.2.4.6 inheritance is ancestor → descendant
    // only; without this guard, an unnamed group layer takes its first child's
    // name and bleeds the child's style across siblings.
    const ownInner = stripNestedLayers(layer.inner);
    const name = readTextElement(ownInner, "Name") ?? "";
    const title = readTextElement(ownInner, "Title");
    const abstract = readTextElement(ownInner, "Abstract");
    const localCrs = collectChildText(ownInner, "CRS");
    const localBbox = collectBoundingBoxes(ownInner);
    const localStyles = collectStyles(ownInner);
    const localDimensions = collectDimensions(ownInner);
    const mergedCrs = uniqueOrder([...inherited.crs, ...localCrs]);
    const mergedBbox = mergeBoundingBoxes(inherited.bbox, localBbox);
    const mergedStyles = mergeStyles(inherited.styles, localStyles);
    const mergedDimensions = mergeDimensions(inherited.dimensions, localDimensions);
    const queryable =
      queryableAttr === "1" || /^true$/i.test(queryableAttr ?? "")
        ? true
        : queryableAttr === "0"
          ? false
          : inherited.queryable;
    const node: WmsCapabilityLayer = {
      name,
      ...(title !== undefined ? { title } : {}),
      ...(abstract !== undefined ? { abstract } : {}),
      crs: mergedCrs,
      bbox: mergedBbox,
      styles: mergedStyles,
      dimensions: mergedDimensions,
      queryable,
      children: [],
    };
    const ancestorsForChildren = [...ancestors, node];
    const children: WmsCapabilityLayer[] = [];
    for (const child of iterChildLayers(layer.inner, ancestorsForChildren)) {
      children.push(child);
    }
    yield { ...node, children };
    cursor = layer.endIndex;
  }
}

interface MergedAncestorState {
  crs: readonly string[];
  bbox: readonly WmsCapabilityBoundingBox[];
  styles: readonly WmsCapabilityStyle[];
  dimensions: readonly WmsCapabilityDimension[];
  queryable: boolean;
}

function mergeAncestors(ancestors: readonly WmsCapabilityLayer[]): MergedAncestorState {
  if (ancestors.length === 0) {
    return { crs: [], bbox: [], styles: [], dimensions: [], queryable: false };
  }
  let crs: string[] = [];
  let bbox: WmsCapabilityBoundingBox[] = [];
  let styles: WmsCapabilityStyle[] = [];
  let dimensions: WmsCapabilityDimension[] = [];
  let queryable = false;
  for (const ancestor of ancestors) {
    crs = uniqueOrder([...crs, ...ancestor.crs]) as string[];
    bbox = mergeBoundingBoxes(bbox, ancestor.bbox) as WmsCapabilityBoundingBox[];
    styles = mergeStyles(styles, ancestor.styles) as WmsCapabilityStyle[];
    dimensions = mergeDimensions(dimensions, ancestor.dimensions) as WmsCapabilityDimension[];
    queryable = queryable || ancestor.queryable;
  }
  return { crs, bbox, styles, dimensions, queryable };
}

function uniqueOrder<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function mergeBoundingBoxes(
  parent: readonly WmsCapabilityBoundingBox[],
  local: readonly WmsCapabilityBoundingBox[],
): readonly WmsCapabilityBoundingBox[] {
  if (local.length === 0) return parent;
  const out: WmsCapabilityBoundingBox[] = [];
  const seen = new Set<string>();
  for (const bb of local) {
    seen.add(bb.crs);
    out.push(bb);
  }
  for (const bb of parent) {
    if (!seen.has(bb.crs)) out.push(bb);
  }
  return out;
}

function mergeStyles(
  parent: readonly WmsCapabilityStyle[],
  local: readonly WmsCapabilityStyle[],
): readonly WmsCapabilityStyle[] {
  if (parent.length === 0) return local;
  const seen = new Set<string>(local.map((s) => s.name));
  const out: WmsCapabilityStyle[] = [...local];
  for (const s of parent) {
    if (!seen.has(s.name)) out.push(s);
  }
  return out;
}

function mergeDimensions(
  parent: readonly WmsCapabilityDimension[],
  local: readonly WmsCapabilityDimension[],
): readonly WmsCapabilityDimension[] {
  if (parent.length === 0) return local;
  const seen = new Set<string>(local.map((d) => d.name));
  const out: WmsCapabilityDimension[] = [...local];
  for (const d of parent) {
    if (!seen.has(d.name)) out.push(d);
  }
  return out;
}

function collectBoundingBoxes(inner: string): WmsCapabilityBoundingBox[] {
  const out: WmsCapabilityBoundingBox[] = [];
  let cursor = 0;
  while (cursor < inner.length) {
    const node = findElement(inner, cursor, "BoundingBox");
    if (!node) break;
    const crs = readAttribute(node.openTag, "CRS") ?? readAttribute(node.openTag, "SRS");
    const minx = parseFloatAttr(node.openTag, "minx");
    const miny = parseFloatAttr(node.openTag, "miny");
    const maxx = parseFloatAttr(node.openTag, "maxx");
    const maxy = parseFloatAttr(node.openTag, "maxy");
    if (crs && Number.isFinite(minx) && Number.isFinite(miny) && Number.isFinite(maxx) && Number.isFinite(maxy)) {
      out.push({ crs, minx, miny, maxx, maxy });
    }
    cursor = node.endIndex;
  }
  // EX_GeographicBoundingBox is the WMS 1.3 alternative geographic bbox node
  // (always WGS84). honua-server emits both; we pull it as a CRS:84 entry
  // when the layer has not advertised one already.
  const geo = findElement(inner, 0, "EX_GeographicBoundingBox");
  if (geo) {
    const w = parseFloatText(readTextElement(geo.inner, "westBoundLongitude"));
    const e = parseFloatText(readTextElement(geo.inner, "eastBoundLongitude"));
    const s = parseFloatText(readTextElement(geo.inner, "southBoundLatitude"));
    const n = parseFloatText(readTextElement(geo.inner, "northBoundLatitude"));
    if (
      Number.isFinite(w) &&
      Number.isFinite(e) &&
      Number.isFinite(s) &&
      Number.isFinite(n) &&
      !out.some((bb) => bb.crs === "CRS:84")
    ) {
      out.push({ crs: "CRS:84", minx: w, miny: s, maxx: e, maxy: n });
    }
  }
  return out;
}

function collectStyles(inner: string): WmsCapabilityStyle[] {
  const out: WmsCapabilityStyle[] = [];
  let cursor = 0;
  while (cursor < inner.length) {
    const node = findElement(inner, cursor, "Style");
    if (!node) break;
    const name = readTextElement(node.inner, "Name") ?? "";
    const title = readTextElement(node.inner, "Title");
    const legend = findElement(node.inner, 0, "LegendURL");
    const onlineResource = legend ? findElement(legend.inner, 0, "OnlineResource") : undefined;
    const legendUrl = onlineResource ? readAttribute(onlineResource.openTag, "xlink:href") : undefined;
    if (name.length > 0) {
      const entry: WmsCapabilityStyle = { name };
      if (title !== undefined) entry.title = title;
      if (legendUrl !== undefined) entry.legendUrl = legendUrl;
      out.push(entry);
    }
    cursor = node.endIndex;
  }
  return out;
}

function collectDimensions(inner: string): WmsCapabilityDimension[] {
  const out: WmsCapabilityDimension[] = [];
  let cursor = 0;
  while (cursor < inner.length) {
    const node = findElement(inner, cursor, "Dimension");
    if (!node) break;
    const name = readAttribute(node.openTag, "name");
    if (typeof name === "string" && name.length > 0) {
      const units = readAttribute(node.openTag, "units");
      const def = readAttribute(node.openTag, "default");
      const text = decodeXmlText(node.inner.trim());
      const values: readonly string[] =
        text.length > 0
          ? text
              .split(",")
              .map((v) => v.trim())
              .filter((v) => v.length > 0)
          : [];
      const dim: WmsCapabilityDimension = { name, values };
      if (units !== undefined) dim.units = units;
      if (def !== undefined) dim.default = def;
      out.push(dim);
    }
    cursor = node.endIndex;
  }
  return out;
}

function collectChildText(inner: string, tag: string): readonly string[] {
  const out: string[] = [];
  let cursor = 0;
  while (cursor < inner.length) {
    const node = findElement(inner, cursor, tag);
    if (!node) break;
    const text = decodeXmlText(node.inner.trim());
    if (text.length > 0) out.push(text);
    cursor = node.endIndex;
  }
  return out;
}

/**
 * Return `inner` with every nested `<Layer>...</Layer>` (and self-closed
 * `<Layer .../>`) subtree elided. Used by `iterChildLayers` to read the
 * layer's *own* metadata without walking into descendant layers.
 */
function stripNestedLayers(inner: string): string {
  if (inner.indexOf("<Layer") < 0) return inner;
  let cursor = 0;
  let out = "";
  while (cursor < inner.length) {
    const node = findElement(inner, cursor, "Layer");
    if (!node) {
      out += inner.slice(cursor);
      break;
    }
    out += inner.slice(cursor, node.startIndex);
    cursor = node.endIndex;
  }
  return out;
}

// ── Tiny named-element walker ─────────────────────────────────

interface FoundElement {
  /** The opening tag including angle brackets and attributes. */
  openTag: string;
  /** Inner text/markup (between open and close tags). */
  inner: string;
  /** Index of the opening `<` of this element. */
  startIndex: number;
  /** Index immediately after the closing tag. */
  endIndex: number;
}

/**
 * Find the next `<tag …>…</tag>` (or `<tag …/>`) starting at `from`. The
 * search ignores element nesting other than the requested tag and walks
 * a balanced depth counter for the same tag so nested same-name elements
 * (`<Layer>` inside `<Layer>`) terminate against the correct close. Skips
 * XML comments (`<!-- … -->`) and CDATA sections (`<![CDATA[ … ]]>`).
 */
function findElement(xml: string, from: number, tag: string): FoundElement | undefined {
  let i = from;
  while (i < xml.length) {
    if (xml[i] !== "<") {
      i += 1;
      continue;
    }
    const next = xml[i + 1];
    if (next === "!" && xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) return undefined;
      i = end + 3;
      continue;
    }
    if (next === "!" && xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end < 0) return undefined;
      i = end + 3;
      continue;
    }
    if (next === "?" || next === "!") {
      const end = xml.indexOf(">", i);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    const isClosing = next === "/";
    const nameStart = isClosing ? i + 2 : i + 1;
    const matchesTag = xml.startsWith(tag, nameStart) && isTagBoundary(xml.charCodeAt(nameStart + tag.length));
    if (!matchesTag) {
      const close = xml.indexOf(">", i);
      if (close < 0) return undefined;
      i = close + 1;
      continue;
    }
    const close = xml.indexOf(">", i);
    if (close < 0) return undefined;
    const openTag = xml.slice(i, close + 1);
    const selfClosing = !isClosing && xml.charCodeAt(close - 1) === 47; // '/'
    if (selfClosing) {
      return { openTag, inner: "", startIndex: i, endIndex: close + 1 };
    }
    if (isClosing) {
      // unmatched closing tag at this level — caller advanced past the
      // opener. Skip past and keep searching.
      i = close + 1;
      continue;
    }
    // Walk forward looking for the matching close tag, accounting for
    // nested same-name openings.
    let depth = 1;
    let cursor = close + 1;
    while (cursor < xml.length && depth > 0) {
      const angle = xml.indexOf("<", cursor);
      if (angle < 0) break;
      const next2 = xml[angle + 1];
      if (next2 === "!" && xml.startsWith("<!--", angle)) {
        const end = xml.indexOf("-->", angle + 4);
        if (end < 0) return undefined;
        cursor = end + 3;
        continue;
      }
      if (next2 === "!" && xml.startsWith("<![CDATA[", angle)) {
        const end = xml.indexOf("]]>", angle + 9);
        if (end < 0) return undefined;
        cursor = end + 3;
        continue;
      }
      const isCloser = next2 === "/";
      const inspectStart = isCloser ? angle + 2 : angle + 1;
      const matchesSame = xml.startsWith(tag, inspectStart) && isTagBoundary(xml.charCodeAt(inspectStart + tag.length));
      const angleClose = xml.indexOf(">", angle);
      if (angleClose < 0) return undefined;
      if (matchesSame) {
        if (isCloser) {
          depth -= 1;
          if (depth === 0) {
            return {
              openTag,
              inner: xml.slice(close + 1, angle),
              startIndex: i,
              endIndex: angleClose + 1,
            };
          }
        } else {
          const innerSelfClose = xml.charCodeAt(angleClose - 1) === 47;
          if (!innerSelfClose) depth += 1;
        }
      }
      cursor = angleClose + 1;
    }
    return undefined;
  }
  return undefined;
}

function isTagBoundary(code: number): boolean {
  // Whitespace, '/', or '>' terminate a tag name.
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 47 || code === 62;
}

function readAttribute(openTag: string, name: string): string | undefined {
  // Match `name="value"` or `name='value'`. Tolerates leading whitespace
  // and case-sensitive name match (WMS attribute names are case-sensitive).
  const idx = findAttributeIndex(openTag, name);
  if (idx < 0) return undefined;
  const after = openTag.slice(idx + name.length);
  const eq = after.indexOf("=");
  if (eq < 0) return undefined;
  let cursor = eq + 1;
  while (cursor < after.length && /\s/.test(after[cursor]!)) cursor += 1;
  const quote = after[cursor];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = after.indexOf(quote, cursor + 1);
  if (end < 0) return undefined;
  return decodeXmlText(after.slice(cursor + 1, end));
}

function findAttributeIndex(openTag: string, name: string): number {
  let i = 0;
  while (i < openTag.length) {
    const found = openTag.indexOf(name, i);
    if (found < 0) return -1;
    const before = openTag.charCodeAt(found - 1);
    const isBoundaryStart = found === 0 || before === 32 || before === 9 || before === 10 || before === 13;
    const after = openTag.charCodeAt(found + name.length);
    const isBoundaryEnd = after === 61 || after === 32 || after === 9 || after === 10 || after === 13;
    if (isBoundaryStart && isBoundaryEnd) {
      return found;
    }
    i = found + 1;
  }
  return -1;
}

function readTextElement(xml: string, tag: string): string | undefined {
  const node = findElement(xml, 0, tag);
  if (!node) return undefined;
  const decoded = decodeXmlText(node.inner.trim());
  return decoded;
}

function parseFloatAttr(openTag: string, name: string): number {
  const value = readAttribute(openTag, name);
  if (value === undefined) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseFloatText(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function decodeXmlText(text: string): string {
  if (text.indexOf("&") < 0 && text.indexOf("<![CDATA[") < 0) return text;
  return decodeXmlEntities(text);
}

/**
 * Walk a parsed `WmsCapabilities` tree and yield every named layer
 * (skipping container layers without a `name`). Useful for descriptor
 * resolution: callers want to bind a `LAYER` name without re-walking
 * the parent hierarchy.
 */
export function* iterateWmsLayers(capabilities: WmsCapabilities): Generator<WmsCapabilityLayer> {
  const stack: WmsCapabilityLayer[] = [...capabilities.layers];
  while (stack.length > 0) {
    const next = stack.shift();
    if (!next) break;
    if (next.name.length > 0) yield next;
    for (const child of next.children) {
      stack.push(child);
    }
  }
}

/**
 * Find the first named layer with a matching name, or `undefined` if the
 * capabilities document does not advertise it. Walks both root layers and
 * children. Intended for the `HonuaWms.layer(name)` resolver path.
 */
export function findWmsLayer(capabilities: WmsCapabilities, name: string): WmsCapabilityLayer | undefined {
  for (const layer of iterateWmsLayers(capabilities)) {
    if (layer.name === name) return layer;
  }
  return undefined;
}
