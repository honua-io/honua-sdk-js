/**
 * PMTiles archive inspection for the protocol-neutral contract.
 *
 * A PMTiles archive is a single, immutable file (on object storage or any
 * static host) that stores an entire raster or vector tile pyramid. It
 * participates in the `Dataset` / `Source` model as a **tiles-only** protocol:
 * the canonical query family throws {@link HonuaCapabilityNotSupportedError}
 * (there is no feature-query surface on an archive), while archive metadata —
 * bounds, min/max zoom, and vector layer names — is inspected through
 * `Source.protocol("pmtiles").describe()`.
 *
 * This module never statically imports the `pmtiles` package. The reader is
 * pulled in lazily (`await import("pmtiles")`) the first time an archive is
 * actually described, mirroring the Cesium adapter so consumers that never
 * touch PMTiles pay zero bundle cost. A minimal `pmtiles` module slice is
 * modelled here so the wiring stays unit-testable against an injected fake
 * without a network fetch.
 *
 * @module
 */
import type { ProtocolModule, ProtocolModuleHandle } from "./protocol-module.js";
import type { Capabilities, SourceDescriptor } from "./types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "./types.js";

/**
 * Canonical tile-payload kinds a PMTiles archive can store. `mvt` is a vector
 * archive (Mapbox Vector Tiles); the rest are raster encodings. `unknown`
 * covers archives whose header tile-type byte the reader could not classify.
 */
export type PmtilesTileKind = "mvt" | "png" | "jpeg" | "webp" | "avif" | "unknown";

/**
 * One vector layer advertised in a vector archive's TileJSON-style metadata
 * (`vector_layers`). Present only for `mvt` archives; raster archives report an
 * empty {@link PmtilesArchiveDescription.vectorLayers} list.
 */
export interface PmtilesVectorLayerInfo {
  /** Layer id — the MapLibre `source-layer` name to reference in a style. */
  readonly id: string;
  /** Optional human description carried in the archive metadata. */
  readonly description?: string;
  /** Optional per-layer minimum zoom advertised in the metadata. */
  readonly minZoom?: number;
  /** Optional per-layer maximum zoom advertised in the metadata. */
  readonly maxZoom?: number;
  /** Optional field-name → type map advertised in the metadata. */
  readonly fields?: Readonly<Record<string, string>>;
}

/**
 * The archive metadata surfaced by {@link describePmtilesArchive}. Bounds are
 * `[west, south, east, north]` in degrees; `center` is `[lon, lat, zoom]`. The
 * raw metadata JSON is preserved on `metadata` for callers that need archive
 * fields beyond the normalized shape.
 */
export interface PmtilesArchiveDescription {
  /** Archive URL the description was read from. */
  readonly url: string;
  /** Tile payload kind stored in the archive. */
  readonly tileKind: PmtilesTileKind;
  /** Geographic bounds `[west, south, east, north]` in degrees. */
  readonly bounds: readonly [number, number, number, number];
  /** Lowest zoom level present in the archive. */
  readonly minZoom: number;
  /** Highest zoom level present in the archive. */
  readonly maxZoom: number;
  /** Suggested view center `[lon, lat, zoom]`. */
  readonly center: readonly [number, number, number];
  /** Vector layer definitions (empty for raster archives). */
  readonly vectorLayers: readonly PmtilesVectorLayerInfo[];
  /** Attribution string advertised in the archive metadata, when present. */
  readonly attribution?: string;
  /** The raw, parsed archive metadata JSON. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ── Minimal `pmtiles` module slice (kept mock-injectable) ────────

/** A byte-range response from a {@link PmtilesSourceLike}. */
export interface PmtilesRangeResponse {
  readonly data: ArrayBuffer;
  readonly etag?: string;
}

/**
 * The `pmtiles` `Source` surface — a byte-range reader over the archive. A
 * remote archive uses the reader's own `FetchSource`; a local fixture (tests)
 * supplies a buffer-backed implementation.
 */
export interface PmtilesSourceLike {
  getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<PmtilesRangeResponse>;
  getKey(): string;
}

/** The `Header` fields this module reads (a subset of `pmtiles.Header`). */
export interface PmtilesHeaderLike {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
  readonly centerZoom: number;
  readonly centerLon: number;
  readonly centerLat: number;
  readonly tileType: number;
}

/** The `PMTiles` reader surface this module drives. */
export interface PmtilesArchiveLike {
  getHeader(): Promise<PmtilesHeaderLike>;
  getMetadata(): Promise<unknown>;
}

/** The minimal slice of `typeof import("pmtiles")` the describe path needs. */
export interface PmtilesModuleLike {
  new (source: PmtilesSourceLike | string): PmtilesArchiveLike;
}

/** Injectable dependencies for {@link describePmtilesArchive} (test seams). */
export interface DescribePmtilesArchiveDeps {
  /** Override the lazily-imported `pmtiles.PMTiles` constructor. */
  readonly PMTiles?: PmtilesModuleLike;
  /** Read from a local/in-memory source instead of fetching `url`. */
  readonly source?: PmtilesSourceLike;
}

/**
 * Lazily import the `pmtiles` reader. Kept in its own function so the dynamic
 * `import("pmtiles")` is the only reference to the package in `src/`, which is
 * what keeps PMTiles out of every bundle that never inspects an archive.
 */
async function loadPmtilesCtor(): Promise<PmtilesModuleLike> {
  const mod = (await import("pmtiles")) as unknown as { PMTiles: PmtilesModuleLike };
  return mod.PMTiles;
}

/**
 * The `pmtiles` `TileType` enum values (spec v3). Duplicated here as a plain
 * map so classification does not force a value import of the package.
 */
const TILE_KIND_BY_TYPE: Readonly<Record<number, PmtilesTileKind>> = {
  0: "unknown",
  1: "mvt",
  2: "png",
  3: "jpeg",
  4: "webp",
  5: "avif",
};

function tileKindFromHeader(tileType: number): PmtilesTileKind {
  return TILE_KIND_BY_TYPE[tileType] ?? "unknown";
}

function readVectorLayers(metadata: Record<string, unknown>): PmtilesVectorLayerInfo[] {
  const raw = metadata.vector_layers;
  if (!Array.isArray(raw)) return [];
  const layers: PmtilesVectorLayerInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id === "") continue;
    const info: {
      id: string;
      description?: string;
      minZoom?: number;
      maxZoom?: number;
      fields?: Record<string, string>;
    } = { id };
    if (typeof record.description === "string") info.description = record.description;
    if (typeof record.minzoom === "number") info.minZoom = record.minzoom;
    if (typeof record.maxzoom === "number") info.maxZoom = record.maxzoom;
    if (record.fields && typeof record.fields === "object") {
      info.fields = record.fields as Record<string, string>;
    }
    layers.push(info);
  }
  return layers;
}

function asMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
}

/**
 * Inspect a PMTiles archive and return its normalized metadata (bounds, min/max
 * zoom, suggested center, and vector layer names). The `pmtiles` reader is
 * imported lazily on first use.
 *
 * Pass {@link DescribePmtilesArchiveDeps.source} to read a local archive (the
 * unit-test path) or {@link DescribePmtilesArchiveDeps.PMTiles} to inject a fake
 * reader; both default to fetching `url` through the real reader.
 *
 * @example
 * ```ts
 * const info = await describePmtilesArchive("https://example.com/basemap.pmtiles");
 * console.log(info.bounds, info.minZoom, info.maxZoom);
 * for (const layer of info.vectorLayers) console.log(layer.id);
 * ```
 */
export async function describePmtilesArchive(
  url: string,
  deps: DescribePmtilesArchiveDeps = {},
): Promise<PmtilesArchiveDescription> {
  const PMTiles = deps.PMTiles ?? (await loadPmtilesCtor());
  const archive: PmtilesArchiveLike = deps.source ? new PMTiles(deps.source) : new PMTiles(url);
  const [header, rawMetadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
  const metadata = asMetadataRecord(rawMetadata);
  const attribution = typeof metadata.attribution === "string" ? metadata.attribution : undefined;

  return {
    url,
    tileKind: tileKindFromHeader(header.tileType),
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    center: [header.centerLon, header.centerLat, header.centerZoom],
    vectorLayers: readVectorLayers(metadata),
    ...(attribution ? { attribution } : {}),
    metadata,
  };
}

/**
 * Typed adapter handle for a PMTiles archive, reachable through
 * `Source.protocol("pmtiles")`. Provides the archive-metadata inspection
 * surface ({@link HonuaPmtilesArchive.describe}) that the tiles-only PMTiles
 * `Source` uses to participate in the Dataset model honestly. The first
 * `describe()` call is cached so repeated inspection does not re-open the
 * archive.
 */
export class HonuaPmtilesArchive {
  /** The `pmtiles://`-free archive URL this handle inspects. */
  public readonly url: string;
  readonly #deps: DescribePmtilesArchiveDeps;
  #description: Promise<PmtilesArchiveDescription> | undefined;

  public constructor(url: string, deps: DescribePmtilesArchiveDeps = {}) {
    this.url = url;
    this.#deps = deps;
  }

  /**
   * Inspect the archive and return its normalized metadata. Cached after the
   * first successful call; a failed inspection is not cached so a transient
   * fetch error can be retried.
   */
  public describe(): Promise<PmtilesArchiveDescription> {
    if (!this.#description) {
      this.#description = describePmtilesArchive(this.url, this.#deps).catch((error: unknown) => {
        this.#description = undefined;
        throw error;
      });
    }
    return this.#description;
  }
}

/**
 * Strip a leading `pmtiles://` scheme from an archive URL, if present. MapLibre
 * style sources address PMTiles archives as `pmtiles://https://…`; the reader
 * (and this contract's describe path) want the bare archive URL.
 */
export function stripPmtilesScheme(url: string): string {
  return url.startsWith("pmtiles://") ? url.slice("pmtiles://".length) : url;
}

/**
 * Add the `pmtiles://` scheme to a bare archive URL if it is not already
 * present. The inverse of {@link stripPmtilesScheme}; use it when composing a
 * MapLibre source `url` from a plain archive locator.
 */
export function toPmtilesSourceUrl(url: string): string {
  return url.startsWith("pmtiles://") ? url : `pmtiles://${url}`;
}

function requirePmtilesModuleLocator(descriptor: SourceDescriptor): string {
  const { url } = descriptor.locator;
  if (typeof url !== "string" || url === "") {
    throw new Error(`createDataset: source "${descriptor.id}" (pmtiles) requires locator.url`);
  }
  return url;
}

/**
 * The first-party PMTiles {@link ProtocolModule} (issue #538).
 *
 * `pmtilesSource()` (`src/contract/source.ts`) builds its
 * `Source.protocol("pmtiles")` escape hatch through this exact factory
 * instead of constructing {@link HonuaPmtilesArchive} directly, and
 * `pmtilesProtocolPlugin` (`@honua/sdk-js/plugin`) packages the same factory
 * as a `HonuaPluginFactory<"protocol">` for `HonuaPluginRegistry`. Both
 * callers run the identical construction path, which is what proves the
 * built-in adapter carries no special registry privilege.
 *
 * `discover()` is synchronous: PMTiles opens its reader lazily on the
 * returned handle's own first `describe()` call, so no I/O happens before a
 * caller actually asks for archive metadata (REQ-003, issue #538).
 *
 * @example
 * ```ts
 * const module = pmtilesProtocolModule();
 * const handle = module.discover({
 *   id: "basemap",
 *   protocol: "pmtiles",
 *   locator: { url: "https://example.com/basemap.pmtiles" },
 * });
 * if (!(handle instanceof Promise)) {
 *   const info = await handle.adapter.describe();
 *   console.log(info.bounds);
 * }
 * ```
 */
export function pmtilesProtocolModule(
  deps: DescribePmtilesArchiveDeps = {},
): ProtocolModule<"pmtiles", HonuaPmtilesArchive> {
  return Object.freeze({
    kind: "pmtiles" as const,
    environments: Object.freeze(["browser", "node", "worker"] as const),
    capabilities(descriptor: SourceDescriptor): Capabilities {
      return descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.pmtiles;
    },
    discover(descriptor: SourceDescriptor): ProtocolModuleHandle<HonuaPmtilesArchive> {
      const url = stripPmtilesScheme(requirePmtilesModuleLocator(descriptor));
      const archive = new HonuaPmtilesArchive(url, deps);
      return Object.freeze({
        descriptor,
        capabilities: descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
        adapter: archive,
        diagnostics: Object.freeze([]),
        dispose(): void {
          // The archive holds no open handles between describe() calls;
          // disposal is deterministic and synchronous with nothing to release.
        },
      });
    },
  });
}
