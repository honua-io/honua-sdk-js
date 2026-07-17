/**
 * Translates `MapPackage.sourceBindings[]` (server shape) into SDK-side
 * `SourceDescriptor[]` consumed by `createDataset`, and keeps a parallel
 * record of MapLibre-native source entries that flow straight into the
 * composed style.
 *
 * Contract:
 *  - Protocol-backed bindings (`geoservices_*`, `ogc_features`, `wfs`,
 *    `wms`, `odata`) produce a `SourceDescriptor` whose locator mirrors
 *    the server's field shape verbatim per `docs/source-binding-alignment.md`.
 *  - MapLibre-native bindings (`vector_tile`, `raster_tile`) skip the
 *    contract pipeline and surface as MapLibre source entries.
 *  - `ogc_maps` / `ogc_tiles` project onto MapLibre-native sources
 *    (raster or vector) since the SDK does not model them as first-party
 *    data protocols.
 *  - `workspace_artifact` is deferred (no adapter); load fails with a
 *    clear `HonuaMapPackageError` stage="source-bind" so callers can
 *    detect missing server artifacts.
 *
 * @module
 */

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type SourceDescriptor,
  type SourceLocator,
} from "../contract/index.js";
import {
  buildWmsRasterSourceSpec as buildMapWmsRasterSourceSpec,
  buildWmtsRasterSourceSpec as buildMapWmtsRasterSourceSpec,
} from "../map/raster-source-spec.js";
import { HonuaMapPackageError } from "./errors.js";
import type { HonuaMapPackageLocator, HonuaMapPackageProtocol, HonuaMapPackageSourceBinding } from "./map-package.js";

/** One MapLibre-native source entry derived from a binding. */
export interface NativeMapLibreSourceEntry {
  sourceId: string;
  spec: { type: string; [key: string]: unknown };
  attribution?: string;
}

/** Result of projecting a package's source bindings. */
export interface SourceBridgeProjection {
  /** Protocol-backed descriptors destined for `createDataset`. */
  descriptors: SourceDescriptor[];
  /**
   * MapLibre-native source entries keyed by sourceId. These flow straight
   * into the composed style's `sources` map without going through
   * `Dataset`.
   */
  nativeSources: NativeMapLibreSourceEntry[];
  /** Binding filter expressions captured per source id. */
  filtersBySourceId: Map<string, string>;
}

/**
 * Project the bindings on a MapPackage into SDK contract descriptors and
 * MapLibre-native source entries. Throws `HonuaMapPackageError` for
 * bindings the runtime cannot route (unknown protocol, missing locator,
 * deferred `workspace_artifact`).
 */
export function projectSourceBindings(
  packageId: string | undefined,
  bindings: readonly HonuaMapPackageSourceBinding[],
): SourceBridgeProjection {
  const descriptors: SourceDescriptor[] = [];
  const nativeSources: NativeMapLibreSourceEntry[] = [];
  const filtersBySourceId = new Map<string, string>();
  const seen = new Set<string>();

  for (const binding of bindings) {
    if (seen.has(binding.sourceId)) {
      throw new HonuaMapPackageError(`duplicate sourceBinding id "${binding.sourceId}"`, {
        packageId,
        stage: "source-bind",
        detail: { sourceId: binding.sourceId },
      });
    }
    seen.add(binding.sourceId);

    if (binding.filter) {
      filtersBySourceId.set(binding.sourceId, binding.filter);
    }

    const mlNative = toMapLibreNativeSource(binding);
    if (mlNative) {
      nativeSources.push(mlNative);
      continue;
    }

    const sdkProtocol = toSdkProtocol(binding.protocol);
    if (!sdkProtocol) {
      throw new HonuaMapPackageError(
        `unsupported SourceBinding protocol "${binding.protocol}" on source "${binding.sourceId}"`,
        { packageId, stage: "source-bind", detail: { sourceId: binding.sourceId, protocol: binding.protocol } },
      );
    }

    descriptors.push({
      id: binding.sourceId,
      protocol: sdkProtocol,
      locator: toSourceLocator(packageId, binding, sdkProtocol),
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES[sdkProtocol],
      attribution: binding.attribution,
    });
  }

  return { descriptors, nativeSources, filtersBySourceId };
}

/**
 * Build the Honua custom-source spec (to be inserted into `style.sources`)
 * for a protocol-backed descriptor.
 */
export function toHonuaSourceSpec(
  descriptor: SourceDescriptor,
  filter?: string,
): { type: string; [key: string]: unknown } {
  switch (descriptor.protocol) {
    case "geoservices-feature-service": {
      const url = requireLocatorUrl(descriptor);
      return {
        type: "honua-feature-service",
        url,
        ...(filter ? { definitionExpression: filter } : {}),
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
    }
    case "geoservices-map-service": {
      const url = requireLocatorUrl(descriptor);
      return {
        type: "honua-map-service",
        url,
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
    }
    case "ogc-features": {
      const url = requireLocatorUrl(descriptor);
      return {
        type: "honua-ogc-features",
        url,
        ...(descriptor.locator.collectionId !== undefined
          ? { collectionId: String(descriptor.locator.collectionId) }
          : {}),
        ...(filter ? { filter } : {}),
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
    }
    case "wms": {
      const url = requireLocatorUrl(descriptor);
      const out: { type: string; [key: string]: unknown } = {
        type: "honua-wms",
        url,
      };
      if (descriptor.locator.serviceId !== undefined) out.serviceId = descriptor.locator.serviceId;
      if (descriptor.locator.typeName !== undefined) out.layers = descriptor.locator.typeName;
      if (descriptor.locator.styleId !== undefined) out.styles = descriptor.locator.styleId;
      if (descriptor.attribution !== undefined) out.attribution = descriptor.attribution;
      return out;
    }
    case "wmts": {
      const url = requireLocatorUrl(descriptor);
      const out: { type: string; [key: string]: unknown } = {
        type: "honua-wmts",
        url,
      };
      if (descriptor.locator.serviceId !== undefined) out.serviceId = descriptor.locator.serviceId;
      if (descriptor.locator.typeName !== undefined) out.layer = descriptor.locator.typeName;
      if (descriptor.locator.styleId !== undefined) out.style = descriptor.locator.styleId;
      if (descriptor.locator.tileMatrixSetId !== undefined) {
        out.tileMatrixSet = descriptor.locator.tileMatrixSetId;
      }
      if (descriptor.attribution !== undefined) out.attribution = descriptor.attribution;
      return out;
    }
    default:
      return {
        type: `honua-${descriptor.protocol}`,
        ...descriptor.locator,
        ...(filter ? { filter } : {}),
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
  }
}

/**
 * Build a MapLibre `raster` source spec for a WMS descriptor. The
 * `tiles` template uses MapLibre's exact `{bbox-epsg-3857}` runtime
 * placeholder plus validated (1–4096) literal WIDTH / HEIGHT values
 * equal to `tileSize`, so each tile request is a pre-baked KVP URL —
 * consumers do not have to hand-assemble GetMap URLs themselves.
 */
export function buildWmsRasterSourceSpec(
  descriptor: SourceDescriptor,
  options: { tileSize?: number; format?: string; transparent?: boolean } = {},
): { type: "raster"; tiles: string[]; tileSize: number; attribution?: string } {
  const spec = buildMapWmsRasterSourceSpec(descriptor, options);
  return { ...spec, tiles: [...spec.tiles] };
}

/**
 * Build a MapLibre `raster` source spec for a WMTS descriptor using the
 * RESTful tile route. The template expands `{z}/{y}/{x}` at runtime
 * (MapLibre's standard tile placeholders).
 */
export function buildWmtsRasterSourceSpec(
  descriptor: SourceDescriptor,
  options: { tileSize?: number; format?: string; minzoom?: number; maxzoom?: number } = {},
): {
  type: "raster";
  tiles: string[];
  tileSize: number;
  scheme?: string;
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
} {
  const spec = buildMapWmtsRasterSourceSpec(descriptor, options);
  return { ...spec, tiles: [...spec.tiles] };
}

function toSdkProtocol(protocol: HonuaMapPackageProtocol): Protocol | undefined {
  switch (protocol) {
    case "geoservices_feature_service":
      return "geoservices-feature-service";
    case "geoservices_map_service":
      return "geoservices-map-service";
    case "ogc_features":
      return "ogc-features";
    case "wfs":
      return "wfs";
    case "wms":
      return "wms";
    case "wmts":
      return "wmts";
    case "odata":
      return "odata";
    default:
      return undefined;
  }
}

function toMapLibreNativeSource(binding: HonuaMapPackageSourceBinding): NativeMapLibreSourceEntry | undefined {
  switch (binding.protocol) {
    case "vector_tile":
    case "ogc_tiles":
      return {
        sourceId: binding.sourceId,
        attribution: binding.attribution,
        spec: {
          type: "vector",
          ...(binding.locator.url ? { tiles: [binding.locator.url] } : {}),
          ...(binding.attribution ? { attribution: binding.attribution } : {}),
        },
      };
    case "raster_tile":
    case "ogc_maps":
      return {
        sourceId: binding.sourceId,
        attribution: binding.attribution,
        spec: {
          type: "raster",
          ...(binding.locator.url ? { tiles: [binding.locator.url] } : {}),
          ...(binding.attribution ? { attribution: binding.attribution } : {}),
        },
      };
    case "pmtiles":
      return toPmtilesNativeSource(binding);
    default:
      return undefined;
  }
}

/**
 * Project a PMTiles binding onto a MapLibre-native source. A PMTiles archive is
 * a single immutable file addressed by MapLibre as a `pmtiles://<archive-url>`
 * source `url` (the `pmtiles://` protocol is auto-registered by the runtime on
 * map attach). Whether the archive is vector or raster comes from the binding's
 * `locator.sourceType` hint (`"vector"` | `"raster"`), defaulting to vector —
 * the common PMTiles basemap case.
 */
function toPmtilesNativeSource(binding: HonuaMapPackageSourceBinding): NativeMapLibreSourceEntry | undefined {
  const url = binding.locator.url;
  if (typeof url !== "string" || url.length === 0) return undefined;
  const sourceUrl = url.startsWith("pmtiles://") ? url : `pmtiles://${url}`;
  const hint = binding.locator.sourceType;
  const type = hint === "raster" ? "raster" : "vector";
  return {
    sourceId: binding.sourceId,
    attribution: binding.attribution,
    spec: {
      type,
      url: sourceUrl,
      ...(binding.attribution ? { attribution: binding.attribution } : {}),
    },
  };
}

function toSourceLocator(
  packageId: string | undefined,
  binding: HonuaMapPackageSourceBinding,
  sdkProtocol: Protocol,
): SourceLocator {
  const loc = binding.locator;
  if (binding.protocol === "workspace_artifact") {
    throw new HonuaMapPackageError(
      `"workspace_artifact" binding on source "${binding.sourceId}" requires a server-side artifact resolver that is not yet wired`,
      { packageId, stage: "source-bind", detail: { sourceId: binding.sourceId, protocol: binding.protocol } },
    );
  }

  if (typeof loc.url !== "string" || loc.url.length === 0) {
    throw new HonuaMapPackageError(`SourceBinding "${binding.sourceId}" is missing locator.url`, {
      packageId,
      stage: "source-bind",
      detail: { sourceId: binding.sourceId, protocol: binding.protocol },
    });
  }

  const locator: SourceLocator = { url: loc.url };
  if (loc.serviceId !== undefined) locator.serviceId = loc.serviceId;
  const normalizedLayerId = normalizeLayerId(loc.layerId);
  if (normalizedLayerId !== undefined) locator.layerId = normalizedLayerId;
  if (loc.collectionId !== undefined) locator.collectionId = loc.collectionId;
  if (loc.typeName !== undefined) locator.typeName = loc.typeName;
  if (loc.entitySet !== undefined) locator.entitySet = loc.entitySet;
  if (typeof (loc as { styleId?: unknown }).styleId === "string") {
    locator.styleId = (loc as { styleId: string }).styleId;
  }
  if (typeof (loc as { tileMatrixSetId?: unknown }).tileMatrixSetId === "string") {
    locator.tileMatrixSetId = (loc as { tileMatrixSetId: string }).tileMatrixSetId;
  }

  // Backfill protocol-specific fields from the URL when the server ships
  // only `locator.url`. The built-in GeoServices and OGC adapters require
  // `serviceId` + `layerId` / `collectionId`, so projection must fill them
  // in here rather than failing later inside `createDataset`.
  if (sdkProtocol === "geoservices-feature-service" || sdkProtocol === "geoservices-map-service") {
    const parsed = parseGeoServicesUrl(loc.url);
    if (parsed) {
      if (locator.serviceId === undefined && parsed.serviceId !== undefined) {
        locator.serviceId = parsed.serviceId;
      }
      if (locator.layerId === undefined && parsed.layerId !== undefined) {
        locator.layerId = parsed.layerId;
      }
    }
  } else if (sdkProtocol === "ogc-features") {
    if (locator.collectionId === undefined) {
      const parsedCollectionId = parseOgcCollectionId(loc.url);
      if (parsedCollectionId !== undefined) locator.collectionId = parsedCollectionId;
    }
  } else if (sdkProtocol === "wms" || sdkProtocol === "wmts") {
    if (locator.serviceId === undefined) {
      const parsedServiceId = parseWmsServiceId(loc.url);
      if (parsedServiceId !== undefined) locator.serviceId = parsedServiceId;
    }
  }
  return locator;
}

/**
 * Coerce `layerId` to a number when the server wire format serialises it
 * as a numeric string (the C# mirror declares it as a string so the
 * JSON wire may arrive as `"0"`). Non-numeric strings are left as-is so
 * the built-in adapters can surface a typed validation error.
 */
function normalizeLayerId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.length > 0) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (!/^-?\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const GEOSERVICES_URL_RE = /\/rest\/services\/([^/?#]+)\/(?:FeatureServer|MapServer)(?:\/(\d+))?/i;

function parseGeoServicesUrl(url: string): { serviceId?: string; layerId?: number } | undefined {
  const match = GEOSERVICES_URL_RE.exec(url);
  if (!match) return undefined;
  const result: { serviceId?: string; layerId?: number } = {};
  if (match[1]) {
    try {
      result.serviceId = decodeURIComponent(match[1]);
    } catch {
      result.serviceId = match[1];
    }
  }
  if (match[2]) {
    const parsed = Number(match[2]);
    if (Number.isFinite(parsed)) result.layerId = parsed;
  }
  return result;
}

const OGC_COLLECTION_URL_RE = /\/collections\/([^/?#]+)/i;

function parseOgcCollectionId(url: string): string | undefined {
  const match = OGC_COLLECTION_URL_RE.exec(url);
  if (!match || !match[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const WMS_SERVICE_URL_RE =
  /\/(?:rest\/services\/([^/?#]+)\/MapServer\/(?:WMS|WMTS)|ogc\/services\/([^/?#]+)\/(?:wms|wmts))/i;

function parseWmsServiceId(url: string): string | undefined {
  const match = WMS_SERVICE_URL_RE.exec(url);
  if (!match) return undefined;
  const id = match[1] ?? match[2];
  if (!id) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function requireLocatorUrl(descriptor: SourceDescriptor): string {
  const url = descriptor.locator.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new HonuaMapPackageError(`descriptor for "${descriptor.id}" is missing locator.url`, {
      stage: "source-bind",
      detail: { sourceId: descriptor.id, protocol: descriptor.protocol },
    });
  }
  return url;
}

/** Re-export the server-shape locator type so callers do not import a deep path. */
export type { HonuaMapPackageLocator };
