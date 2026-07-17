/** Bounded WMTS 1.0 capabilities projection. @module */

import {
  type CapabilitiesXmlElement,
  parseCapabilitiesXml,
  xmlAttribute,
  xmlChild,
  xmlChildren,
  xmlText,
} from "./capabilities-xml.js";
import { HonuaSdkError } from "./error-envelope.js";

export interface WmtsCapabilities {
  readonly version: string;
  readonly service: WmtsCapabilitiesService;
  readonly layers: ReadonlyArray<WmtsCapabilityLayer>;
  readonly tileMatrixSets: ReadonlyArray<WmtsCapabilityTileMatrixSet>;
  readonly operations: readonly WmtsCapabilityOperation[];
  /** Optional metadata entries ignored because they were malformed. */
  readonly warnings: readonly string[];
}

export interface WmtsCapabilitiesService {
  readonly title?: string;
  readonly abstract?: string;
}

export interface WmtsCapabilityOperation {
  readonly name: string;
  readonly methods: readonly ("GET" | "POST")[];
  readonly getUrls: readonly string[];
  readonly postUrls: readonly string[];
}

export interface WmtsCapabilityLayer {
  readonly identifier: string;
  readonly title?: string;
  readonly abstract?: string;
  readonly formats: readonly string[];
  readonly infoFormats: readonly string[];
  readonly styles: ReadonlyArray<WmtsCapabilityStyle>;
  readonly dimensions: ReadonlyArray<WmtsCapabilityDimension>;
  readonly tileMatrixSetIds: readonly string[];
  readonly resourceTemplates: ReadonlyArray<WmtsCapabilityResourceUrl>;
  readonly featureInfoTemplates: ReadonlyArray<WmtsCapabilityResourceUrl>;
  readonly bbox?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number };
}

export interface WmtsCapabilityStyle {
  readonly identifier: string;
  readonly title?: string;
  readonly isDefault: boolean;
  readonly legendUrl?: string;
  readonly legendFormat?: string;
}

export interface WmtsCapabilityDimension {
  readonly identifier: string;
  readonly default?: string;
  readonly current: boolean;
  readonly values: readonly string[];
}

export interface WmtsCapabilityResourceUrl {
  readonly format: string;
  readonly template: string;
}

export interface WmtsCapabilityTileMatrixSet {
  readonly identifier: string;
  readonly supportedCrs?: string;
  readonly wellKnownScaleSet?: string;
  readonly matrices: ReadonlyArray<WmtsCapabilityTileMatrix>;
}

const incompleteTileMatrixSets = new WeakSet<WmtsCapabilityTileMatrixSet>();

export interface WmtsCapabilityTileMatrix {
  readonly identifier: string;
  readonly scaleDenominator: number;
  readonly matrixWidth: number;
  readonly matrixHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly topLeftCorner: readonly [number, number];
}

export class HonuaWmtsCapabilitiesParseError extends HonuaSdkError {
  public constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super("core.wmts-capabilities-parse", message, options);
    this.name = "HonuaWmtsCapabilitiesParseError";
  }
}

export function parseWmtsCapabilities(xml: string): WmtsCapabilities {
  try {
    const root = parseCapabilitiesXml(xml, "WMTS");
    if (root.localName !== "Capabilities") throw new Error("missing <Capabilities> root element");
    const warnings: string[] = [];
    const serviceNode = xmlChild(root, "ServiceIdentification");
    const contents = xmlChild(root, "Contents");
    const service = compactObject<WmtsCapabilitiesService>({
      title: xmlText(xmlChild(serviceNode, "Title")),
      abstract: xmlText(xmlChild(serviceNode, "Abstract")),
    });
    const layers = Object.freeze(xmlChildren(contents, "Layer").flatMap((layer) => parseLayer(layer, warnings)));
    const tileMatrixSets = Object.freeze(
      xmlChildren(contents, "TileMatrixSet").flatMap((matrixSet) => parseTileMatrixSet(matrixSet, warnings)),
    );
    const operations = Object.freeze(parseOperations(xmlChild(root, "OperationsMetadata")));
    return Object.freeze({
      version: xmlAttribute(root, "version") ?? "",
      service,
      layers,
      tileMatrixSets,
      operations,
      warnings: Object.freeze(unique(warnings)),
    });
  } catch (cause) {
    if (cause instanceof HonuaWmtsCapabilitiesParseError) throw cause;
    const message = cause instanceof Error ? cause.message : "WMTS Capabilities XML is malformed";
    throw new HonuaWmtsCapabilitiesParseError(message, { cause });
  }
}

function parseOperations(node: CapabilitiesXmlElement | undefined): WmtsCapabilityOperation[] {
  return xmlChildren(node, "Operation").flatMap((operation) => {
    const name = xmlAttribute(operation, "name");
    if (!name) return [];
    const methods: ("GET" | "POST")[] = [];
    const getUrls: string[] = [];
    const postUrls: string[] = [];
    for (const dcp of xmlChildren(operation, "DCP")) {
      const http = xmlChild(dcp, "HTTP");
      for (const method of http?.children ?? []) {
        if (method.localName !== "Get" && method.localName !== "Post") continue;
        const normalized = method.localName === "Get" ? "GET" : "POST";
        if (!methods.includes(normalized)) methods.push(normalized);
        const href = xmlAttribute(method, "href");
        if (href) (normalized === "GET" ? getUrls : postUrls).push(href);
      }
    }
    return [
      Object.freeze({
        name,
        methods: Object.freeze(methods),
        getUrls: Object.freeze(unique(getUrls)),
        postUrls: Object.freeze(unique(postUrls)),
      }),
    ];
  });
}

function parseLayer(node: CapabilitiesXmlElement, warnings: string[]): WmtsCapabilityLayer[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  if (!identifier) {
    warnings.push("WMTS Layer metadata without an identifier was ignored.");
    return [];
  }
  const bbox = parseWgs84BoundingBox(xmlChild(node, "WGS84BoundingBox"), warnings);
  return [
    Object.freeze({
      identifier,
      ...optional("title", xmlText(xmlChild(node, "Title"))),
      ...optional("abstract", xmlText(xmlChild(node, "Abstract"))),
      formats: Object.freeze(unique(xmlChildren(node, "Format").flatMap((entry) => xmlText(entry) ?? []))),
      infoFormats: Object.freeze(unique(xmlChildren(node, "InfoFormat").flatMap((entry) => xmlText(entry) ?? []))),
      styles: Object.freeze(xmlChildren(node, "Style").flatMap((style) => parseStyle(style, warnings))),
      dimensions: Object.freeze(
        xmlChildren(node, "Dimension").flatMap((dimension) => parseDimension(dimension, warnings)),
      ),
      tileMatrixSetIds: Object.freeze(
        unique(
          xmlChildren(node, "TileMatrixSetLink").flatMap((link) => xmlText(xmlChild(link, "TileMatrixSet")) ?? []),
        ),
      ),
      resourceTemplates: Object.freeze(parseResources(node, "tile", warnings)),
      featureInfoTemplates: Object.freeze(parseResources(node, "FeatureInfo", warnings)),
      ...(bbox ? { bbox } : {}),
    }),
  ];
}

function parseStyle(node: CapabilitiesXmlElement, warnings: string[]): WmtsCapabilityStyle[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  if (!identifier) {
    warnings.push("WMTS Style metadata without an identifier was ignored.");
    return [];
  }
  const legend = xmlChild(node, "LegendURL");
  const isDefault = xmlAttribute(node, "isDefault")?.toLowerCase();
  return [
    Object.freeze({
      identifier,
      ...optional("title", xmlText(xmlChild(node, "Title"))),
      isDefault: isDefault === "true" || isDefault === "1",
      ...optional("legendUrl", legend ? xmlAttribute(legend, "href") : undefined),
      ...optional("legendFormat", legend ? xmlAttribute(legend, "format") : undefined),
    }),
  ];
}

function parseDimension(node: CapabilitiesXmlElement, warnings: string[]): WmtsCapabilityDimension[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  if (!identifier) {
    warnings.push("WMTS Dimension metadata without an identifier was ignored.");
    return [];
  }
  const current = xmlText(xmlChild(node, "Current"))?.toLowerCase();
  return [
    Object.freeze({
      identifier,
      ...optional("default", xmlText(xmlChild(node, "Default"))),
      current: current === "true" || current === "1",
      values: Object.freeze(unique(xmlChildren(node, "Value").flatMap((entry) => xmlText(entry) ?? []))),
    }),
  ];
}

function parseResources(
  node: CapabilitiesXmlElement,
  resourceType: "tile" | "FeatureInfo",
  warnings: string[],
): WmtsCapabilityResourceUrl[] {
  return xmlChildren(node, "ResourceURL").flatMap((resource) => {
    if (xmlAttribute(resource, "resourceType")?.toLowerCase() !== resourceType.toLowerCase()) return [];
    const template = xmlAttribute(resource, "template");
    const format = xmlAttribute(resource, "format");
    if (!template || !format) {
      warnings.push(`WMTS ${resourceType} ResourceURL metadata without a format or template was ignored.`);
      return [];
    }
    return [Object.freeze({ format, template })];
  });
}

function parseWgs84BoundingBox(
  node: CapabilitiesXmlElement | undefined,
  warnings: string[],
): { readonly west: number; readonly south: number; readonly east: number; readonly north: number } | undefined {
  if (!node) return undefined;
  const lower = coordinatePair(xmlText(xmlChild(node, "LowerCorner")));
  const upper = coordinatePair(xmlText(xmlChild(node, "UpperCorner")));
  if (!lower || !upper || lower[0] > upper[0] || lower[1] > upper[1]) {
    warnings.push("WMTS WGS84BoundingBox metadata was malformed and ignored.");
    return undefined;
  }
  return Object.freeze({ west: lower[0], south: lower[1], east: upper[0], north: upper[1] });
}

function parseTileMatrixSet(node: CapabilitiesXmlElement, warnings: string[]): WmtsCapabilityTileMatrixSet[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  const matrixNodes = xmlChildren(node, "TileMatrix");
  const matrices = Object.freeze(matrixNodes.flatMap((matrix) => parseTileMatrix(matrix, warnings)));
  if (!identifier || matrices.length === 0) {
    warnings.push("WMTS TileMatrixSet metadata without an identifier or valid matrices was ignored.");
    return [];
  }
  const matrixSet = Object.freeze({
    identifier,
    ...optional("supportedCrs", xmlText(xmlChild(node, "SupportedCRS"))),
    ...optional("wellKnownScaleSet", xmlText(xmlChild(node, "WellKnownScaleSet"))),
    matrices,
  });
  if (matrices.length !== matrixNodes.length) incompleteTileMatrixSets.add(matrixSet);
  return [matrixSet];
}

/** @internal Whether every matrix advertised by this parsed set was structurally valid. */
export function isWmtsCapabilityTileMatrixSetComplete(matrixSet: WmtsCapabilityTileMatrixSet): boolean {
  return !incompleteTileMatrixSets.has(matrixSet);
}

function parseTileMatrix(node: CapabilitiesXmlElement, warnings: string[]): WmtsCapabilityTileMatrix[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  const scaleDenominator = positiveNumber(xmlText(xmlChild(node, "ScaleDenominator")));
  const tileWidth = positiveSafeInteger(xmlText(xmlChild(node, "TileWidth")));
  const tileHeight = positiveSafeInteger(xmlText(xmlChild(node, "TileHeight")));
  const matrixWidth = positiveSafeInteger(xmlText(xmlChild(node, "MatrixWidth")));
  const matrixHeight = positiveSafeInteger(xmlText(xmlChild(node, "MatrixHeight")));
  const topLeftCorner = coordinatePair(xmlText(xmlChild(node, "TopLeftCorner")));
  if (
    !identifier ||
    scaleDenominator === undefined ||
    tileWidth === undefined ||
    tileHeight === undefined ||
    matrixWidth === undefined ||
    matrixHeight === undefined ||
    !topLeftCorner
  ) {
    warnings.push("WMTS TileMatrix metadata with invalid numeric fields was ignored.");
    return [];
  }
  return [
    Object.freeze({
      identifier,
      scaleDenominator,
      tileWidth,
      tileHeight,
      matrixWidth,
      matrixHeight,
      topLeftCorner: Object.freeze(topLeftCorner),
    }),
  ];
}

function coordinatePair(value: string | undefined): [number, number] | undefined {
  if (!value) return undefined;
  const values = value.trim().split(/\s+/).map(Number);
  return values.length === 2 && values.every(Number.isFinite) ? [values[0]!, values[1]!] : undefined;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveSafeInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function optional<K extends string, T>(key: K, value: T | undefined): { readonly [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: T });
}

function compactObject<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))) as T;
}

export function findWmtsLayer(capabilities: WmtsCapabilities, identifier: string): WmtsCapabilityLayer | undefined {
  return capabilities.layers.find((layer) => layer.identifier === identifier);
}

export function findWmtsTileMatrixSet(
  capabilities: WmtsCapabilities,
  identifier: string,
): WmtsCapabilityTileMatrixSet | undefined {
  return capabilities.tileMatrixSets.find((tileMatrixSet) => tileMatrixSet.identifier === identifier);
}
