/**
 * Bounded WMS capabilities projection.
 *
 * The parser accepts the metadata subset needed by discovery and the WMS
 * runtime, rejects malformed/active XML, and returns plain immutable-friendly
 * records. Unknown vendor extensions are ignored; required structural drift is
 * surfaced through {@link HonuaWmsCapabilitiesParseError}.
 *
 * @module
 */

import {
  type CapabilitiesXmlElement,
  parseCapabilitiesXml,
  xmlAttribute,
  xmlChild,
  xmlChildren,
  xmlText,
} from "./capabilities-xml.js";
import { HonuaSdkError } from "./error-envelope.js";

export interface WmsCapabilities {
  readonly version: string;
  readonly service: WmsCapabilitiesService;
  readonly layers: ReadonlyArray<WmsCapabilityLayer>;
  readonly formats: WmsCapabilitiesFormats;
  readonly request: WmsCapabilitiesRequestSupport;
  /** Optional metadata entries ignored because they were malformed. */
  readonly warnings: readonly string[];
}

export interface WmsCapabilitiesService {
  readonly title?: string;
  readonly abstract?: string;
}

export interface WmsCapabilitiesFormats {
  readonly map: readonly string[];
  readonly featureInfo: readonly string[];
  readonly legend: readonly string[];
}

export type WmsOperationName = "GetCapabilities" | "GetMap" | "GetFeatureInfo" | "GetLegendGraphic";

export interface WmsCapabilityOperation {
  readonly name: WmsOperationName;
  readonly formats: readonly string[];
  readonly methods: readonly ("GET" | "POST")[];
  readonly getUrls: readonly string[];
  readonly postUrls: readonly string[];
}

export interface WmsCapabilitiesRequestSupport {
  readonly getMap: boolean;
  readonly getFeatureInfo: boolean;
  readonly getLegendGraphic: boolean;
  readonly operations: readonly WmsCapabilityOperation[];
}

export interface WmsCapabilityLayer {
  readonly name: string;
  readonly title?: string;
  readonly abstract?: string;
  readonly crs: readonly string[];
  readonly bbox: ReadonlyArray<WmsCapabilityBoundingBox>;
  readonly styles: ReadonlyArray<WmsCapabilityStyle>;
  readonly dimensions: ReadonlyArray<WmsCapabilityDimension>;
  readonly queryable: boolean;
  readonly children: ReadonlyArray<WmsCapabilityLayer>;
}

export interface WmsCapabilityBoundingBox {
  readonly crs: string;
  readonly minx: number;
  readonly miny: number;
  readonly maxx: number;
  readonly maxy: number;
}

export interface WmsCapabilityStyle {
  readonly name: string;
  readonly title?: string;
  readonly legendUrl?: string;
  readonly legendFormat?: string;
}

export interface WmsCapabilityDimension {
  readonly name: string;
  readonly units?: string;
  readonly default?: string;
  readonly values: readonly string[];
}

export class HonuaWmsCapabilitiesParseError extends HonuaSdkError {
  public constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super("core.wms-capabilities-parse", message, options);
    this.name = "HonuaWmsCapabilitiesParseError";
  }
}

export function parseWmsCapabilities(xml: string): WmsCapabilities {
  try {
    const root = parseCapabilitiesXml(xml, "WMS");
    if (root.localName !== "WMS_Capabilities" && root.localName !== "WMT_MS_Capabilities") {
      throw new Error("missing <WMS_Capabilities> root element (received WMS Capabilities XML?)");
    }
    const version = xmlAttribute(root, "version") ?? "";
    const warnings: string[] = [];
    const serviceNode = xmlChild(root, "Service");
    const service = compactObject<WmsCapabilitiesService>({
      title: xmlText(xmlChild(serviceNode, "Title")),
      abstract: xmlText(xmlChild(serviceNode, "Abstract")),
    });
    const capability = xmlChild(root, "Capability");
    const requestNode = xmlChild(capability, "Request");
    const operations = parseOperations(requestNode);
    const operation = (name: WmsOperationName) => operations.find((candidate) => candidate.name === name);
    const formats: WmsCapabilitiesFormats = Object.freeze({
      map: operation("GetMap")?.formats ?? Object.freeze([]),
      featureInfo: operation("GetFeatureInfo")?.formats ?? Object.freeze([]),
      legend: operation("GetLegendGraphic")?.formats ?? Object.freeze([]),
    });
    const request: WmsCapabilitiesRequestSupport = Object.freeze({
      getMap: operation("GetMap") !== undefined,
      getFeatureInfo: operation("GetFeatureInfo") !== undefined,
      getLegendGraphic: operation("GetLegendGraphic") !== undefined,
      operations,
    });
    const layers = Object.freeze(
      xmlChildren(capability, "Layer").map((layer) => parseLayer(layer, emptyInheritance(), 0, warnings)),
    );
    return Object.freeze({ version, service, layers, formats, request, warnings: Object.freeze(unique(warnings)) });
  } catch (cause) {
    if (cause instanceof HonuaWmsCapabilitiesParseError) throw cause;
    const message = cause instanceof Error ? cause.message : "WMS Capabilities XML is malformed";
    throw new HonuaWmsCapabilitiesParseError(message, { cause });
  }
}

function parseOperations(request: CapabilitiesXmlElement | undefined): readonly WmsCapabilityOperation[] {
  const names: readonly WmsOperationName[] = ["GetCapabilities", "GetMap", "GetFeatureInfo", "GetLegendGraphic"];
  return Object.freeze(
    names.flatMap((name) => {
      const node = xmlChild(request, name);
      if (!node) return [];
      const formats = unique(xmlChildren(node, "Format").flatMap((entry) => xmlText(entry) ?? []));
      const methods: ("GET" | "POST")[] = [];
      const getUrls: string[] = [];
      const postUrls: string[] = [];
      for (const dcp of xmlChildren(node, "DCPType")) {
        const http = xmlChild(dcp, "HTTP");
        for (const method of http?.children ?? []) {
          if (method.localName !== "Get" && method.localName !== "Post") continue;
          const online = xmlChild(method, "OnlineResource") ?? method;
          const href = xmlAttribute(online, "href");
          const normalizedMethod = method.localName === "Get" ? "GET" : "POST";
          if (!methods.includes(normalizedMethod)) methods.push(normalizedMethod);
          if (href) (normalizedMethod === "GET" ? getUrls : postUrls).push(href);
        }
      }
      return [
        Object.freeze({
          name,
          formats: Object.freeze(formats),
          methods: Object.freeze(methods),
          getUrls: Object.freeze(unique(getUrls)),
          postUrls: Object.freeze(unique(postUrls)),
        }),
      ];
    }),
  );
}

interface LayerInheritance {
  readonly crs: readonly string[];
  readonly bbox: readonly WmsCapabilityBoundingBox[];
  readonly styles: readonly WmsCapabilityStyle[];
  readonly dimensions: readonly WmsCapabilityDimension[];
  readonly queryable: boolean;
}

function emptyInheritance(): LayerInheritance {
  return Object.freeze({
    crs: Object.freeze([]),
    bbox: Object.freeze([]),
    styles: Object.freeze([]),
    dimensions: Object.freeze([]),
    queryable: false,
  });
}

function parseLayer(
  node: CapabilitiesXmlElement,
  inherited: LayerInheritance,
  depth: number,
  warnings: string[],
): WmsCapabilityLayer {
  // The shared XML reader already enforces 32 document levels. This separate
  // semantic limit keeps a capabilities document from constructing a deeper
  // recursive public layer object through wrapper elements.
  if (depth >= 24) throw new Error("WMS Capabilities exceeds the 24-level layer hierarchy limit");
  const localCrs = xmlChildren(node, "CRS")
    .concat(xmlChildren(node, "SRS"))
    .flatMap((candidate) => xmlText(candidate)?.split(/\s+/).filter(Boolean) ?? []);
  const crs = Object.freeze(unique([...inherited.crs, ...localCrs]));
  const bbox = Object.freeze(mergeByKey(inherited.bbox, parseBoundingBoxes(node, warnings), (entry) => entry.crs));
  const styles = Object.freeze(mergeByKey(inherited.styles, parseStyles(node, warnings), (entry) => entry.name));
  const dimensions = Object.freeze(
    mergeByKey(inherited.dimensions, parseDimensions(node, warnings), (entry) => entry.name),
  );
  const queryableValue = xmlAttribute(node, "queryable")?.toLowerCase();
  if (queryableValue !== undefined && !["0", "1", "false", "true"].includes(queryableValue)) {
    warnings.push("WMS layer queryable metadata was malformed and inherited conservatively.");
  }
  const queryable =
    queryableValue === "1" || queryableValue === "true"
      ? true
      : queryableValue === "0" || queryableValue === "false"
        ? false
        : inherited.queryable;
  const next: LayerInheritance = { crs, bbox, styles, dimensions, queryable };
  const children = Object.freeze(
    xmlChildren(node, "Layer").map((child) => parseLayer(child, next, depth + 1, warnings)),
  );
  return Object.freeze({
    name: xmlText(xmlChild(node, "Name")) ?? "",
    ...optional("title", xmlText(xmlChild(node, "Title"))),
    ...optional("abstract", xmlText(xmlChild(node, "Abstract"))),
    crs,
    bbox,
    styles,
    dimensions,
    queryable,
    children,
  });
}

function parseBoundingBoxes(node: CapabilitiesXmlElement, warnings: string[]): readonly WmsCapabilityBoundingBox[] {
  const out: WmsCapabilityBoundingBox[] = [];
  for (const bbox of xmlChildren(node, "BoundingBox")) {
    const crs = xmlAttribute(bbox, "CRS") ?? xmlAttribute(bbox, "SRS");
    const minx = finiteNumber(xmlAttribute(bbox, "minx"));
    const miny = finiteNumber(xmlAttribute(bbox, "miny"));
    const maxx = finiteNumber(xmlAttribute(bbox, "maxx"));
    const maxy = finiteNumber(xmlAttribute(bbox, "maxy"));
    if (
      crs &&
      minx !== undefined &&
      miny !== undefined &&
      maxx !== undefined &&
      maxy !== undefined &&
      minx <= maxx &&
      miny <= maxy
    ) {
      out.push(Object.freeze({ crs, minx, miny, maxx, maxy }));
    } else {
      warnings.push("WMS BoundingBox metadata was malformed and ignored.");
    }
  }
  const geographic = xmlChild(node, "EX_GeographicBoundingBox");
  if (geographic && !out.some((entry) => entry.crs === "CRS:84")) {
    const minx = finiteNumber(xmlText(xmlChild(geographic, "westBoundLongitude")));
    const miny = finiteNumber(xmlText(xmlChild(geographic, "southBoundLatitude")));
    const maxx = finiteNumber(xmlText(xmlChild(geographic, "eastBoundLongitude")));
    const maxy = finiteNumber(xmlText(xmlChild(geographic, "northBoundLatitude")));
    if (
      minx !== undefined &&
      miny !== undefined &&
      maxx !== undefined &&
      maxy !== undefined &&
      minx <= maxx &&
      miny <= maxy
    ) {
      out.push(Object.freeze({ crs: "CRS:84", minx, miny, maxx, maxy }));
    } else {
      warnings.push("WMS EX_GeographicBoundingBox metadata was malformed and ignored.");
    }
  }
  return out;
}

function parseStyles(node: CapabilitiesXmlElement, warnings: string[]): readonly WmsCapabilityStyle[] {
  return xmlChildren(node, "Style").flatMap((style) => {
    const name = xmlText(xmlChild(style, "Name"));
    if (!name) {
      warnings.push("WMS Style metadata without a name was ignored.");
      return [];
    }
    const legend = xmlChild(style, "LegendURL");
    const resource = xmlChild(legend, "OnlineResource");
    return [
      Object.freeze({
        name,
        ...optional("title", xmlText(xmlChild(style, "Title"))),
        ...optional("legendUrl", resource ? xmlAttribute(resource, "href") : undefined),
        ...optional("legendFormat", xmlText(xmlChild(legend, "Format"))),
      }),
    ];
  });
}

function parseDimensions(node: CapabilitiesXmlElement, warnings: string[]): readonly WmsCapabilityDimension[] {
  const candidates = [...xmlChildren(node, "Dimension"), ...xmlChildren(node, "Extent")];
  return candidates.flatMap((dimension) => {
    const name = xmlAttribute(dimension, "name");
    if (!name) {
      warnings.push("WMS Dimension metadata without a name was ignored.");
      return [];
    }
    const raw = xmlText(dimension);
    const values = raw
      ? raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    return [
      Object.freeze({
        name,
        ...optional("units", xmlAttribute(dimension, "units")),
        ...optional("default", xmlAttribute(dimension, "default")),
        values: Object.freeze(unique(values)),
      }),
    ];
  });
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function mergeByKey<T>(parent: readonly T[], local: readonly T[], key: (value: T) => string): T[] {
  const localKeys = new Set(local.map(key));
  return [...local, ...parent.filter((entry) => !localKeys.has(key(entry)))];
}

function optional<K extends string, T>(key: K, value: T | undefined): { readonly [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: T });
}

function compactObject<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))) as T;
}

export function* iterateWmsLayers(capabilities: WmsCapabilities): Generator<WmsCapabilityLayer> {
  const stack = [...capabilities.layers];
  while (stack.length > 0) {
    const next = stack.shift()!;
    if (next.name.length > 0) yield next;
    stack.unshift(...next.children);
  }
}

export function findWmsLayer(capabilities: WmsCapabilities, name: string): WmsCapabilityLayer | undefined {
  for (const layer of iterateWmsLayers(capabilities)) if (layer.name === name) return layer;
  return undefined;
}
