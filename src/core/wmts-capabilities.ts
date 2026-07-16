/**
 * WMTS 1.0.0 Capabilities parser. Hand-rolled, narrow-scope walker over
 * the `Capabilities` document advertised by honua-server (single
 * advertised TileMatrixSet today: `WebMercatorQuad`). Yields a typed
 * `WmtsCapabilities` shape so the SDK can route through the canonical
 * `Source` surface without leaking XML.
 *
 * @module
 */

import { HonuaSdkError, withHonuaErrorClassification } from "./error-base.js";
import { decodeXmlText as decodeXmlEntities } from "./xml-text.js";

/**
 * Top-level WMTS Capabilities surface.
 */
export interface WmtsCapabilities {
  /** Protocol version. honua-server advertises `1.0.0`. */
  version: string;
  service: WmtsCapabilitiesService;
  layers: ReadonlyArray<WmtsCapabilityLayer>;
  tileMatrixSets: ReadonlyArray<WmtsCapabilityTileMatrixSet>;
}

export interface WmtsCapabilitiesService {
  title?: string;
  abstract?: string;
}

export interface WmtsCapabilityLayer {
  identifier: string;
  title?: string;
  abstract?: string;
  formats: readonly string[];
  styles: ReadonlyArray<WmtsCapabilityStyle>;
  /** TileMatrixSet identifiers the layer supports. */
  tileMatrixSetIds: readonly string[];
  /** RESTful tile templates (xlink:href) advertised by `ResourceURL@resourceType="tile"`. */
  resourceTemplates: ReadonlyArray<WmtsCapabilityResourceUrl>;
  /** RESTful FeatureInfo templates advertised by `ResourceURL@resourceType="FeatureInfo"`. */
  featureInfoTemplates: ReadonlyArray<WmtsCapabilityResourceUrl>;
  /** Geographic bounding box (WGS84) when advertised. */
  bbox?: { west: number; south: number; east: number; north: number };
}

export interface WmtsCapabilityStyle {
  identifier: string;
  title?: string;
  isDefault: boolean;
  legendUrl?: string;
}

export interface WmtsCapabilityResourceUrl {
  format: string;
  template: string;
}

export interface WmtsCapabilityTileMatrixSet {
  identifier: string;
  /** CRS supportedCRS or wellKnownScaleSet href when advertised. */
  supportedCrs?: string;
  wellKnownScaleSet?: string;
  matrices: ReadonlyArray<WmtsCapabilityTileMatrix>;
}

export interface WmtsCapabilityTileMatrix {
  identifier: string;
  scaleDenominator: number;
  matrixWidth: number;
  matrixHeight: number;
  tileWidth: number;
  tileHeight: number;
  topLeftCorner: readonly [number, number];
}

export class HonuaWmtsCapabilitiesParseError extends HonuaSdkError {
  public constructor(message: string) {
    super(
      "core.wmts-capabilities-parse",
      message,
      withHonuaErrorClassification(
        {},
        "core.wmts-capabilities-parse",
        "HonuaWmtsCapabilitiesParseError",
        "core",
        "protocol",
        false,
      ),
    );
  }
}

/**
 * Parse a `Capabilities` text body for WMTS 1.0 into the typed
 * `WmtsCapabilities` shape.
 */
export function parseWmtsCapabilities(xml: string): WmtsCapabilities {
  if (typeof xml !== "string" || xml.length === 0) {
    throw new HonuaWmtsCapabilitiesParseError("WMTS Capabilities body is empty");
  }
  const root = findElement(xml, 0, "Capabilities");
  if (!root) {
    throw new HonuaWmtsCapabilitiesParseError("missing <Capabilities> root element");
  }
  const version = readAttribute(root.openTag, "version") ?? "1.0.0";
  const service = parseServiceMetadata(root.inner);
  const contents = findElement(root.inner, 0, "Contents");
  const layers = contents ? collectLayers(contents.inner) : [];
  const tileMatrixSets = contents ? collectTileMatrixSets(contents.inner) : [];
  return { version, service, layers, tileMatrixSets };
}

function parseServiceMetadata(xml: string): WmtsCapabilitiesService {
  const node = findElement(xml, 0, "ows:ServiceIdentification") ?? findElement(xml, 0, "ServiceIdentification");
  if (!node) return {};
  const out: WmtsCapabilitiesService = {};
  const title = readTextElement(node.inner, "ows:Title") ?? readTextElement(node.inner, "Title");
  if (title !== undefined) out.title = title;
  const abstract = readTextElement(node.inner, "ows:Abstract") ?? readTextElement(node.inner, "Abstract");
  if (abstract !== undefined) out.abstract = abstract;
  return out;
}

function collectLayers(contentsInner: string): WmtsCapabilityLayer[] {
  const out: WmtsCapabilityLayer[] = [];
  let cursor = 0;
  while (cursor < contentsInner.length) {
    const node = findElement(contentsInner, cursor, "Layer");
    if (!node) break;
    const identifier = readTextElement(node.inner, "Identifier") ?? readTextElement(node.inner, "ows:Identifier") ?? "";
    if (identifier.length > 0) {
      const title = readTextElement(node.inner, "Title") ?? readTextElement(node.inner, "ows:Title");
      const abstract = readTextElement(node.inner, "Abstract") ?? readTextElement(node.inner, "ows:Abstract");
      const formats = collectChildText(node.inner, "Format");
      const styles = collectStyles(node.inner);
      const tileMatrixSetIds = collectTileMatrixSetLinks(node.inner);
      const resources = collectResources(node.inner, "tile");
      const featureInfoResources = collectResources(node.inner, "FeatureInfo");
      const bbox = readWgs84BoundingBox(node.inner);
      const layer: WmtsCapabilityLayer = {
        identifier,
        formats,
        styles,
        tileMatrixSetIds,
        resourceTemplates: resources,
        featureInfoTemplates: featureInfoResources,
      };
      if (title !== undefined) layer.title = title;
      if (abstract !== undefined) layer.abstract = abstract;
      if (bbox !== undefined) layer.bbox = bbox;
      out.push(layer);
    }
    cursor = node.endIndex;
  }
  return out;
}

function collectStyles(layerInner: string): WmtsCapabilityStyle[] {
  const out: WmtsCapabilityStyle[] = [];
  let cursor = 0;
  while (cursor < layerInner.length) {
    const node = findElement(layerInner, cursor, "Style");
    if (!node) break;
    const identifier = readTextElement(node.inner, "Identifier") ?? readTextElement(node.inner, "ows:Identifier") ?? "";
    if (identifier.length > 0) {
      const title = readTextElement(node.inner, "Title") ?? readTextElement(node.inner, "ows:Title");
      const isDefault = readAttribute(node.openTag, "isDefault") === "true";
      const legend = findElement(node.inner, 0, "LegendURL");
      const legendUrl = legend ? readAttribute(legend.openTag, "xlink:href") : undefined;
      const style: WmtsCapabilityStyle = { identifier, isDefault };
      if (title !== undefined) style.title = title;
      if (legendUrl !== undefined) style.legendUrl = legendUrl;
      out.push(style);
    }
    cursor = node.endIndex;
  }
  return out;
}

function collectTileMatrixSetLinks(layerInner: string): readonly string[] {
  const out: string[] = [];
  let cursor = 0;
  while (cursor < layerInner.length) {
    const node = findElement(layerInner, cursor, "TileMatrixSetLink");
    if (!node) break;
    const tms = readTextElement(node.inner, "TileMatrixSet") ?? readTextElement(node.inner, "ows:TileMatrixSet");
    if (tms !== undefined && tms.length > 0) out.push(tms);
    cursor = node.endIndex;
  }
  return out;
}

function collectResources(layerInner: string, resourceType: string): WmtsCapabilityResourceUrl[] {
  const out: WmtsCapabilityResourceUrl[] = [];
  let cursor = 0;
  while (cursor < layerInner.length) {
    const node = findElement(layerInner, cursor, "ResourceURL");
    if (!node) break;
    const type = readAttribute(node.openTag, "resourceType");
    if (type === resourceType) {
      const format = readAttribute(node.openTag, "format") ?? "";
      const template = readAttribute(node.openTag, "template") ?? "";
      if (template.length > 0) {
        out.push({ format, template });
      }
    }
    cursor = node.endIndex;
  }
  return out;
}

function readWgs84BoundingBox(
  layerInner: string,
): { west: number; south: number; east: number; north: number } | undefined {
  const node = findElement(layerInner, 0, "WGS84BoundingBox") ?? findElement(layerInner, 0, "ows:WGS84BoundingBox");
  if (!node) return undefined;
  const lower = readTextElement(node.inner, "LowerCorner") ?? readTextElement(node.inner, "ows:LowerCorner") ?? "";
  const upper = readTextElement(node.inner, "UpperCorner") ?? readTextElement(node.inner, "ows:UpperCorner") ?? "";
  const lowerParts = lower.trim().split(/\s+/).map(Number);
  const upperParts = upper.trim().split(/\s+/).map(Number);
  if (
    lowerParts.length !== 2 ||
    upperParts.length !== 2 ||
    !Number.isFinite(lowerParts[0]) ||
    !Number.isFinite(lowerParts[1]) ||
    !Number.isFinite(upperParts[0]) ||
    !Number.isFinite(upperParts[1])
  ) {
    return undefined;
  }
  return {
    west: lowerParts[0]!,
    south: lowerParts[1]!,
    east: upperParts[0]!,
    north: upperParts[1]!,
  };
}

function collectTileMatrixSets(contentsInner: string): WmtsCapabilityTileMatrixSet[] {
  const out: WmtsCapabilityTileMatrixSet[] = [];
  let cursor = 0;
  while (cursor < contentsInner.length) {
    const node = findElement(contentsInner, cursor, "TileMatrixSet");
    if (!node) break;
    const identifier = readTextElement(node.inner, "Identifier") ?? readTextElement(node.inner, "ows:Identifier");
    // Skip the per-layer `TileMatrixSet` reference inside `TileMatrixSetLink`
    // (those carry only an identifier and no nested `TileMatrix` children).
    const matrices = collectTileMatrices(node.inner);
    if (identifier !== undefined && identifier.length > 0 && matrices.length > 0) {
      const supportedCrs =
        readTextElement(node.inner, "SupportedCRS") ?? readTextElement(node.inner, "ows:SupportedCRS");
      const wellKnown =
        readTextElement(node.inner, "WellKnownScaleSet") ?? readTextElement(node.inner, "ows:WellKnownScaleSet");
      const tms: WmtsCapabilityTileMatrixSet = {
        identifier,
        matrices,
      };
      if (supportedCrs !== undefined) tms.supportedCrs = supportedCrs;
      if (wellKnown !== undefined) tms.wellKnownScaleSet = wellKnown;
      out.push(tms);
    }
    cursor = node.endIndex;
  }
  return out;
}

function collectTileMatrices(tmsInner: string): WmtsCapabilityTileMatrix[] {
  const out: WmtsCapabilityTileMatrix[] = [];
  let cursor = 0;
  while (cursor < tmsInner.length) {
    const node = findElement(tmsInner, cursor, "TileMatrix");
    if (!node) break;
    const identifier = readTextElement(node.inner, "Identifier") ?? readTextElement(node.inner, "ows:Identifier") ?? "";
    const scale = Number.parseFloat(readTextElement(node.inner, "ScaleDenominator") ?? "");
    const topLeft = (readTextElement(node.inner, "TopLeftCorner") ?? "").trim().split(/\s+/).map(Number);
    const tileWidth = Number.parseFloat(readTextElement(node.inner, "TileWidth") ?? "");
    const tileHeight = Number.parseFloat(readTextElement(node.inner, "TileHeight") ?? "");
    const matrixWidth = Number.parseFloat(readTextElement(node.inner, "MatrixWidth") ?? "");
    const matrixHeight = Number.parseFloat(readTextElement(node.inner, "MatrixHeight") ?? "");
    if (
      identifier.length > 0 &&
      Number.isFinite(scale) &&
      Number.isFinite(tileWidth) &&
      Number.isFinite(tileHeight) &&
      Number.isFinite(matrixWidth) &&
      Number.isFinite(matrixHeight) &&
      topLeft.length === 2 &&
      Number.isFinite(topLeft[0]) &&
      Number.isFinite(topLeft[1])
    ) {
      out.push({
        identifier,
        scaleDenominator: scale,
        tileWidth,
        tileHeight,
        matrixWidth,
        matrixHeight,
        topLeftCorner: [topLeft[0]!, topLeft[1]!],
      });
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

// ── Tiny named-element walker (shared logic with wms-capabilities.ts) ──

interface FoundElement {
  openTag: string;
  inner: string;
  endIndex: number;
}

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
    const selfClosing = !isClosing && xml.charCodeAt(close - 1) === 47;
    if (selfClosing) return { openTag, inner: "", endIndex: close + 1 };
    if (isClosing) {
      i = close + 1;
      continue;
    }
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
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 47 || code === 62;
}

function readAttribute(openTag: string, name: string): string | undefined {
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
  return decodeXmlText(node.inner.trim());
}

function decodeXmlText(text: string): string {
  if (text.indexOf("&") < 0 && text.indexOf("<![CDATA[") < 0) return text;
  return decodeXmlEntities(text);
}

/** Find a layer by identifier in a parsed `WmtsCapabilities`. */
export function findWmtsLayer(capabilities: WmtsCapabilities, identifier: string): WmtsCapabilityLayer | undefined {
  return capabilities.layers.find((l) => l.identifier === identifier);
}

/** Find a tile-matrix-set by identifier. */
export function findWmtsTileMatrixSet(
  capabilities: WmtsCapabilities,
  identifier: string,
): WmtsCapabilityTileMatrixSet | undefined {
  return capabilities.tileMatrixSets.find((t) => t.identifier === identifier);
}
