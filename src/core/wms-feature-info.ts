/**
 * Capabilities-driven WMS 1.3 `GetFeatureInfo` execution.
 *
 * The first-party path in `wms.ts` addresses Honua Server's
 * `/rest/services/{id}/MapServer/WMS` alias by service id. This module
 * generalizes the same wire request so it can also be issued against the
 * DCP operation URL a third-party `GetCapabilities` advertises, reusing the
 * shared KVP serializer (and therefore the shared WMS 1.3 axis-order rule)
 * rather than restating it.
 *
 * Everything here is fail-closed. A format the canonical `Result` contract
 * cannot represent is never selected, a CRS whose WMS 1.3 axis order the SDK
 * cannot prove is never sent, and a response body that does not decode into
 * features raises `HonuaCapabilityNotSupportedError` instead of degrading into
 * a silently empty result.
 *
 * @module
 */

import { parseCapabilitiesXml } from "./capabilities-xml.js";
import type { CapabilitiesXmlElement } from "./capabilities-xml.js";
import { HonuaCapabilityNotSupportedError } from "./errors.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type { HonuaTypedFeature } from "./types.js";
import { parseEpsgCode } from "./wms-axis.js";
import type { WmsFeatureInfoRequest } from "./wms-types.js";
import { serializeWmsFeatureInfoParams } from "./wms.js";

/**
 * Response ceiling for a point `GetFeatureInfo`. The request renders a 1×1
 * image, so a conformant answer is small; the bound keeps a hostile or
 * misconfigured server from turning identify-on-click into an unbounded read.
 */
export const WMS_FEATURE_INFO_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * `INFO_FORMAT` values the canonical adapter can project into
 * `Result.features`, most preferred first. GeoJSON/JSON keeps geometry and
 * typed attribute values; GML is the interoperable fallback that MapServer and
 * GeoServer deployments advertise when JSON output is not installed.
 *
 * Unstructured `text/plain` and `text/html` are deliberately absent: their
 * bodies are template-defined per deployment, so projecting them into canonical
 * features would mean inventing structure. Sources whose only advertised info
 * formats are unstructured keep `query` disabled and stay reachable through the
 * protocol escape hatch.
 */
const WMS_FEATURE_INFO_JSON_FORMATS: readonly string[] = [
  "application/geo+json",
  "application/vnd.geo+json",
  "application/json",
  "application/json;subtype=geojson",
  "geojson",
  "json",
];

const WMS_FEATURE_INFO_GML_FORMATS: readonly string[] = [
  "application/vnd.ogc.gml",
  "application/vnd.ogc.gml/3.1.1",
  "application/gml+xml",
  "application/gml+xml;version=3.2",
  "text/xml;subtype=gml/3.1.1",
  "text/xml;subtype=gml/3.2",
  "text/xml;subtype=gml/3.2.1",
  "text/xml",
  "application/xml",
  "gml",
];

/** Negotiated `INFO_FORMAT` plus the decoder family it selects. */
export interface WmsFeatureInfoFormatChoice {
  readonly kind: "json" | "gml";
  /** Exact spelling the service advertised, sent verbatim on the wire. */
  readonly format: string;
}

function normalizeFormat(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * Classify one advertised `INFO_FORMAT`. Returns `undefined` when the format
 * carries no structure the canonical contract can project.
 */
export function classifyWmsFeatureInfoFormat(format: string): "json" | "gml" | undefined {
  const normalized = normalizeFormat(format);
  if (WMS_FEATURE_INFO_JSON_FORMATS.includes(normalized)) return "json";
  if (WMS_FEATURE_INFO_GML_FORMATS.includes(normalized)) return "gml";
  return undefined;
}

/**
 * Pick the `INFO_FORMAT` the canonical adapter should request from the formats
 * a service advertises for `GetFeatureInfo`. JSON families win over GML; within
 * a family the SDK's preference order decides, not the server's ordering, so
 * the selection is deterministic across deployments.
 */
export function selectWmsFeatureInfoFormat(advertised: readonly string[]): WmsFeatureInfoFormatChoice | undefined {
  for (const [kind, preference] of [
    ["json", WMS_FEATURE_INFO_JSON_FORMATS],
    ["gml", WMS_FEATURE_INFO_GML_FORMATS],
  ] as const) {
    for (const candidate of preference) {
      const match = advertised.find((value) => normalizeFormat(value) === candidate);
      if (match) return Object.freeze({ kind, format: match });
    }
  }
  return undefined;
}

/**
 * CRS families the point envelope may be expressed in. Each entry has a WMS
 * 1.3.0 axis order the SDK can prove, so `BBOX` is always emitted in the
 * authority-defined order.
 */
type WmsQueryCrsKind = "crs84" | "epsg4326" | "epsg3857";

function classifyWmsQueryCrs(code: string): WmsQueryCrsKind | undefined {
  const upper = code.toUpperCase();
  if (upper === "CRS:84" || upper.includes("CRS84")) return "crs84";
  const epsg = parseEpsgCode(code);
  if (epsg === 4326) return "epsg4326";
  if (epsg === 3857) return "epsg3857";
  return undefined;
}

/**
 * Filter a layer's advertised CRS list down to the identifiers a point
 * `GetFeatureInfo` may use, preserving the advertised spelling and order.
 */
export function reviewedWmsQueryCrs(advertised: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const reviewed: string[] = [];
  for (const code of advertised) {
    if (seen.has(code) || classifyWmsQueryCrs(code) === undefined) continue;
    seen.add(code);
    reviewed.push(code);
  }
  return Object.freeze(reviewed);
}

/**
 * Resolve the CRS a canonical query should put on the wire.
 *
 * The requested code comes from the spatial filter geometry (defaulting to
 * `CRS:84`). An exact advertised spelling always wins. `CRS:84` and `EPSG:4326`
 * are interchangeable *inputs* — both describe the same canonical `(x, y)` =
 * `(lon, lat)` point and differ only in the wire axis order, which the shared
 * serializer applies for whichever spelling is chosen — so a request in one is
 * satisfied by the other when only that one is advertised. Anything else
 * returns `undefined` so the caller can fail closed.
 */
export function resolveWmsQueryCrs(reviewed: readonly string[], requested: string): string | undefined {
  const requestedKind = classifyWmsQueryCrs(requested);
  if (requestedKind === undefined) return undefined;
  const exact = reviewed.find((code) => code.toUpperCase() === requested.toUpperCase());
  if (exact) return exact;
  const sameKind = reviewed.find((code) => classifyWmsQueryCrs(code) === requestedKind);
  if (sameKind) return sameKind;
  if (requestedKind === "crs84" || requestedKind === "epsg4326") {
    const interchangeable = requestedKind === "crs84" ? "epsg4326" : "crs84";
    return reviewed.find((code) => classifyWmsQueryCrs(code) === interchangeable);
  }
  return undefined;
}

/** Reviewed, same-origin `GetFeatureInfo` operation binding. */
export interface WmsFeatureInfoBinding {
  /** Absolute operation URL advertised by `GetCapabilities`. */
  readonly url: string;
  /** Negotiated `INFO_FORMAT`. */
  readonly format: string;
}

export interface ExecuteWmsFeatureInfoOptions {
  readonly binding: WmsFeatureInfoBinding;
  readonly request: WmsFeatureInfoRequest;
  /** Source id used for capability errors raised on an unprojectable response. */
  readonly sourceId: string;
}

/**
 * Issue a `GetFeatureInfo` against the capabilities-advertised operation URL
 * and project the response into canonical typed features.
 *
 * Vendor query state already present on the advertised URL (tenant selectors,
 * map identifiers) is preserved; the WMS KVP names are overwritten so a
 * capabilities document cannot pin a stale `BBOX` or `INFO_FORMAT`.
 */
export async function executeWmsFeatureInfo<T = Record<string, unknown>>(
  transport: Pick<HonuaProtocolTransport, "requestText">,
  options: ExecuteWmsFeatureInfoOptions,
): Promise<ReadonlyArray<HonuaTypedFeature<T>>> {
  const infoFormat = options.request.infoFormat ?? options.binding.format;
  const kind = classifyWmsFeatureInfoFormat(infoFormat);
  if (kind === undefined) {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "wms",
      `${options.sourceId} (GetFeatureInfo format "${infoFormat}" cannot be projected into canonical features)`,
    );
  }
  const url = new URL(options.binding.url);
  for (const [name, value] of serializeWmsFeatureInfoParams({ ...options.request, infoFormat })) {
    url.searchParams.set(name, value);
  }
  const { text, contentType } = await transport.requestText("GET", url.toString(), {
    accept: infoFormat,
    maxResponseBytes: WMS_FEATURE_INFO_MAX_RESPONSE_BYTES,
    ...(options.request.signal ? { signal: options.request.signal } : {}),
  });
  return decodeWmsFeatureInfoBody<T>(text, contentType, kind, options.sourceId);
}

/**
 * Project a decoded `GetFeatureInfo` body into canonical typed features.
 * `kind` is the negotiated decoder family; the observed `contentType` only
 * narrows a JSON negotiation that the server answered with XML (a common
 * shape for OGC `ServiceExceptionReport` bodies returned with HTTP 200).
 */
export function decodeWmsFeatureInfoBody<T = Record<string, unknown>>(
  text: string,
  contentType: string,
  kind: "json" | "gml",
  sourceId: string,
): ReadonlyArray<HonuaTypedFeature<T>> {
  const body = text.trim();
  if (body.length === 0) return Object.freeze([]);
  if (kind === "json" && !/xml/i.test(contentType)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw unprojectableResponse(sourceId, "the JSON body could not be parsed");
    }
    return extractJsonFeatureInfoFeatures<T>(parsed);
  }
  return extractGmlFeatureInfoFeatures<T>(body, sourceId);
}

function unprojectableResponse(sourceId: string, detail: string): HonuaCapabilityNotSupportedError {
  return new HonuaCapabilityNotSupportedError("query", "wms", `${sourceId} (GetFeatureInfo returned ${detail})`);
}

/**
 * Decode a GeoJSON `FeatureCollection` or a Honua `FeatureInfoResponse`
 * envelope. Mirrors the first-party JSON decoder so both wire paths produce the
 * same canonical shape.
 */
function extractJsonFeatureInfoFeatures<T>(parsed: unknown): ReadonlyArray<HonuaTypedFeature<T>> {
  if (!parsed || typeof parsed !== "object") return Object.freeze([]);
  const raw = (parsed as { features?: unknown }).features;
  const features = Array.isArray(raw) ? raw : [];
  const out: HonuaTypedFeature<T>[] = [];
  for (const entry of features) {
    if (!entry || typeof entry !== "object") continue;
    const feature = entry as Record<string, unknown>;
    out.push({
      attributes: (feature.attributes ?? feature.properties ?? {}) as T,
      geometry: (feature.geometry as Record<string, unknown> | null | undefined) ?? null,
    });
  }
  return Object.freeze(out);
}

/** Property elements every GML feature carries that are not user attributes. */
const GML_NON_ATTRIBUTE_PROPERTIES = new Set(["boundedBy", "extent"]);

/**
 * Project a GML `GetFeatureInfo` body into canonical typed features.
 *
 * Only the two container shapes the specification and the dominant server
 * implementations produce are recognized: `gml:featureMember` /
 * `gml:featureMembers` (GeoServer, deegree, QGIS Server) and MapServer's
 * `msGMLOutput` layer wrapper. Each feature contributes its leaf property
 * elements as attributes; complex properties (geometry, nested objects) are
 * skipped rather than flattened, and `geometry` stays `null` because
 * GetFeatureInfo answers a point the caller already holds.
 */
function extractGmlFeatureInfoFeatures<T>(xml: string, sourceId: string): ReadonlyArray<HonuaTypedFeature<T>> {
  let root: CapabilitiesXmlElement;
  try {
    root = parseCapabilitiesXml(xml, "WMS");
  } catch {
    throw unprojectableResponse(sourceId, "a GML body that is not well-formed XML");
  }
  if (root.localName === "ServiceExceptionReport" || root.localName === "ExceptionReport") {
    throw unprojectableResponse(sourceId, "an OGC exception report");
  }
  const featureNodes = collectGmlFeatureNodes(root);
  if (featureNodes === undefined) {
    throw unprojectableResponse(sourceId, "a GML body with no recognized feature container");
  }
  return Object.freeze(featureNodes.map((node) => ({ attributes: gmlFeatureAttributes(node) as T, geometry: null })));
}

function collectGmlFeatureNodes(root: CapabilitiesXmlElement): readonly CapabilitiesXmlElement[] | undefined {
  const members: CapabilitiesXmlElement[] = [];
  let sawContainer = false;
  const stack: CapabilitiesXmlElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.localName === "featureMember" || node.localName === "featureMembers") {
      sawContainer = true;
      members.push(...node.children);
      continue;
    }
    stack.push(...node.children);
  }
  if (sawContainer) return members;
  if (root.localName === "msGMLOutput") {
    // MapServer wraps each queried layer in `<{layer}_layer>` and each hit in
    // `<{layer}_feature>`.
    return root.children.flatMap((layer) => layer.children.filter((child) => child.localName.endsWith("_feature")));
  }
  return undefined;
}

function gmlFeatureAttributes(feature: CapabilitiesXmlElement): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const property of feature.children) {
    if (GML_NON_ATTRIBUTE_PROPERTIES.has(property.localName)) continue;
    if (property.children.length > 0) continue;
    const value = property.text.trim();
    if (Object.hasOwn(attributes, property.localName)) continue;
    attributes[property.localName] = value;
  }
  return attributes;
}
