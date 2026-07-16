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
    const serviceNode = xmlChild(root, "ServiceIdentification");
    const contents = xmlChild(root, "Contents");
    const service = compactObject<WmtsCapabilitiesService>({
      title: xmlText(xmlChild(serviceNode, "Title")),
      abstract: xmlText(xmlChild(serviceNode, "Abstract")),
    });
    const layers = Object.freeze(xmlChildren(contents, "Layer").flatMap(parseLayer));
    const tileMatrixSets = Object.freeze(xmlChildren(contents, "TileMatrixSet").flatMap(parseTileMatrixSet));
    const operations = Object.freeze(parseOperations(xmlChild(root, "OperationsMetadata")));
    return Object.freeze({
      version: xmlAttribute(root, "version") ?? "1.0.0",
      service,
      layers,
      tileMatrixSets,
      operations,
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

function parseLayer(node: CapabilitiesXmlElement): WmtsCapabilityLayer[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  if (!identifier) return [];
  const bbox = parseWgs84BoundingBox(xmlChild(node, "WGS84BoundingBox"));
  return [
    Object.freeze({
      identifier,
      ...optional("title", xmlText(xmlChild(node, "Title"))),
      ...optional("abstract", xmlText(xmlChild(node, "Abstract"))),
      formats: Object.freeze(unique(xmlChildren(node, "Format").flatMap((entry) => xmlText(entry) ?? []))),
      infoFormats: Object.freeze(unique(xmlChildren(node, "InfoFormat").flatMap((entry) => xmlText(entry) ?? []))),
      styles: Object.freeze(xmlChildren(node, "Style").flatMap(parseStyle)),
      dimensions: Object.freeze(xmlChildren(node, "Dimension").flatMap(parseDimension)),
      tileMatrixSetIds: Object.freeze(
        unique(
          xmlChildren(node, "TileMatrixSetLink").flatMap((link) => xmlText(xmlChild(link, "TileMatrixSet")) ?? []),
        ),
      ),
      resourceTemplates: Object.freeze(parseResources(node, "tile")),
      featureInfoTemplates: Object.freeze(parseResources(node, "FeatureInfo")),
      ...(bbox ? { bbox } : {}),
    }),
  ];
}

function parseStyle(node: CapabilitiesXmlElement): WmtsCapabilityStyle[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  if (!identifier) return [];
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

function parseDimension(node: CapabilitiesXmlElement): WmtsCapabilityDimension[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  if (!identifier) return [];
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

function parseResources(node: CapabilitiesXmlElement, resourceType: "tile" | "FeatureInfo"): WmtsCapabilityResourceUrl[] {
  return xmlChildren(node, "ResourceURL").flatMap((resource) => {
    if (xmlAttribute(resource, "resourceType")?.toLowerCase() !== resourceType.toLowerCase()) return [];
    const template = xmlAttribute(resource, "template");
    if (!template) return [];
    return [Object.freeze({ format: xmlAttribute(resource, "format") ?? "", template })];
  });
}

function parseWgs84BoundingBox(
  node: CapabilitiesXmlElement | undefined,
): { readonly west: number; readonly south: number; readonly east: number; readonly north: number } | undefined {
  const lower = coordinatePair(xmlText(xmlChild(node, "LowerCorner")));
  const upper = coordinatePair(xmlText(xmlChild(node, "UpperCorner")));
  if (!lower || !upper || lower[0] > upper[0] || lower[1] > upper[1]) return undefined;
  return Object.freeze({ west: lower[0], south: lower[1], east: upper[0], north: upper[1] });
}

function parseTileMatrixSet(node: CapabilitiesXmlElement): WmtsCapabilityTileMatrixSet[] {
  const identifier = xmlText(xmlChild(node, "Identifier"));
  const matrices = Object.freeze(xmlChildren(node, "TileMatrix").flatMap(parseTileMatrix));
  if (!identifier || matrices.length === 0) return [];
  return [
    Object.freeze({
      identifier,
      ...optional("supportedCrs", xmlText(xmlChild(node, "SupportedCRS"))),
      ...optional("wellKnownScaleSet", xmlText(xmlChild(node, "WellKnownScaleSet"))),
      matrices,
    }),
  ];
}

function parseTileMatrix(node: CapabilitiesXmlElement): WmtsCapabilityTileMatrix[] {
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
