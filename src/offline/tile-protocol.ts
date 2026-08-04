import {
  type OfflineRegionTileReadV1,
  type ReadOfflineRegionTileOptions,
  readOfflineRegionTile,
} from "./read-resource.js";
import { OFFLINE_REGION_DEFAULT_TILE_MATRIX_SET, OFFLINE_REGION_PROTOCOL } from "./selection.js";
import { HonuaOfflineRegionError, type OfflineRegionManifestV1 } from "./types.js";

/**
 * Binding persisted tiles to the map runtime's existing protocol seam.
 *
 * The SDK already registers custom URL protocols with MapLibre through a
 * `addProtocol(scheme, handler)` registrar (`src/runtime/pmtiles-protocol.ts`),
 * so offline tiles reuse that seam rather than introducing a second tile
 * pipeline: a style names `offline-region://…/{z}/{x}/{y}` tiles, and the handler
 * answers each one from the persisted region under the full read discipline. A
 * tile the region does not hold rejects with its typed reason — nothing falls
 * back to the network, and nothing renders bytes the region never stored.
 *
 * Registration stays application-owned. The runtime does not yet auto-register
 * this protocol or rewrite a style's tile URLs onto it.
 *
 * @experimental
 */

/** URL scheme a style uses to address tiles inside a persisted region. */
export const OFFLINE_REGION_TILE_SCHEME = OFFLINE_REGION_PROTOCOL;

const SCHEME_PREFIX = `${OFFLINE_REGION_TILE_SCHEME}://`;

/** One parsed `offline-region://` tile address. */
export interface OfflineRegionTileAddressV1 {
  readonly tileMatrixSetId: string;
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Request shape MapLibre hands a protocol handler.
 *
 * Declared structurally so `@honua/sdk-js/offline` never imports the map runtime
 * or the `maplibre-gl` peer; it is the same shape the runtime's own registrar
 * already passes.
 */
export interface OfflineRegionProtocolRequest {
  readonly url: string;
}

export interface OfflineRegionProtocolResponse {
  readonly data: ArrayBuffer;
  readonly cacheControl?: string;
  readonly expires?: string;
}

export type OfflineRegionProtocolHandler = (
  request: OfflineRegionProtocolRequest,
  abortController?: AbortController,
) => Promise<OfflineRegionProtocolResponse>;

/** The `addProtocol`/`removeProtocol` pair the map runtime already speaks. */
export interface OfflineRegionProtocolRegistrar {
  addProtocol(scheme: string, handler: OfflineRegionProtocolHandler): void;
  removeProtocol?(scheme: string): void;
}

export interface CreateOfflineRegionTileProtocolOptions
  extends Omit<ReadOfflineRegionTileOptions, "tile" | "scheme" | "tileMatrixSetId" | "signal"> {
  readonly manifest: OfflineRegionManifestV1;
  /** Observe every tile served, for diagnostics. Exceptions are ignored. */
  readonly onTile?: (read: OfflineRegionTileReadV1) => void;
}

/** Build the tile-URL template a MapLibre source uses to address a region. */
export function buildOfflineRegionTileUrlTemplate(options: { readonly tileMatrixSetId?: string } = {}): string {
  const set = options.tileMatrixSetId ?? OFFLINE_REGION_DEFAULT_TILE_MATRIX_SET;
  if (typeof set !== "string" || set.length === 0 || set.includes("/")) {
    throw new HonuaOfflineRegionError("invalid-manifest", "tileMatrixSetId must be a non-empty path segment.", {
      path: "tileMatrixSetId",
    });
  }
  return `${SCHEME_PREFIX}${set}/{z}/{x}/{y}`;
}

/**
 * Parse an `offline-region://` tile URL.
 *
 * Parsing is a bounded segment split with no regular expression, and a URL
 * carrying a query or fragment is refused outright: a tile address is an
 * identity, and anything that could smuggle a token into one is not a tile
 * address.
 */
export function parseOfflineRegionTileUrl(url: string): OfflineRegionTileAddressV1 {
  if (typeof url !== "string" || !url.startsWith(SCHEME_PREFIX)) {
    throw invalid(`Tile URL must start with "${SCHEME_PREFIX}".`);
  }
  const rest = url.slice(SCHEME_PREFIX.length);
  if (rest.includes("?") || rest.includes("#") || rest.includes("@")) {
    throw invalid("Tile URL must not carry a query, fragment, or user information.");
  }
  const segments = rest.split("/");
  if (segments.length !== 4) throw invalid("Tile URL must be <tileMatrixSetId>/<z>/<x>/<y>.");
  const [set, z, x, rawY] = segments as [string, string, string, string];
  if (set.length === 0) throw invalid("Tile URL must name a tile matrix set.");
  const dot = rawY.lastIndexOf(".");
  const y = dot > 0 ? rawY.slice(0, dot) : rawY;
  return { tileMatrixSetId: set, z: segment(z, "z"), x: segment(x, "x"), y: segment(y, "y") };
}

/**
 * Create a MapLibre protocol handler that serves tiles from a persisted region.
 *
 * Register it with the same registrar the runtime uses for other custom schemes:
 * `registrar.addProtocol(OFFLINE_REGION_TILE_SCHEME, handler)`.
 */
export function createOfflineRegionTileProtocol(
  options: CreateOfflineRegionTileProtocolOptions,
): OfflineRegionProtocolHandler {
  if (!options?.manifest) throw new TypeError("An offline region manifest is required.");
  if (!options.store) throw new TypeError("An offline region store is required.");
  const { manifest, onTile, ...read } = options;
  return async (request, abortController) => {
    if (typeof request?.url !== "string") throw new TypeError("request.url must be a string.");
    const address = parseOfflineRegionTileUrl(request.url);
    const tileRead = await readOfflineRegionTile(manifest, {
      ...read,
      tile: { z: address.z, x: address.x, y: address.y },
      tileMatrixSetId: address.tileMatrixSetId,
      ...(abortController ? { signal: abortController.signal } : {}),
    } as ReadOfflineRegionTileOptions);
    try {
      onTile?.(tileRead);
    } catch {
      // Diagnostics are observational and never change what the map renders.
    }
    const bytes = tileRead.bytes;
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    // The region is the cache. Declining a second layer of renderer caching keeps
    // eviction, freshness, and provenance answerable from one place.
    return { data, cacheControl: "no-store" };
  };
}

/**
 * Register the offline tile protocol and return its disposer.
 *
 * The registrar is the application's — usually `maplibre-gl` itself — so the SDK
 * neither imports the peer nor decides when a map should read from a region.
 */
export function registerOfflineRegionTileProtocol(
  registrar: OfflineRegionProtocolRegistrar,
  options: CreateOfflineRegionTileProtocolOptions,
): () => void {
  if (typeof registrar?.addProtocol !== "function") {
    throw new TypeError("A MapLibre-style protocol registrar with addProtocol is required.");
  }
  registrar.addProtocol(OFFLINE_REGION_TILE_SCHEME, createOfflineRegionTileProtocol(options));
  return () => registrar.removeProtocol?.(OFFLINE_REGION_TILE_SCHEME);
}

function segment(value: string, path: string): number {
  if (value.length === 0 || value.length > 12) throw invalid(`Tile URL ${path} is not an integer.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) throw invalid(`Tile URL ${path} is not an integer.`);
  }
  return Number(value);
}

function invalid(message: string): HonuaOfflineRegionError {
  return new HonuaOfflineRegionError("invalid-manifest", message, { path: "url" });
}
