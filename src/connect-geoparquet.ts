/** Internal GeoParquet / static-file metadata projection for connect(). */

import type { ConnectDiscoverySourceSnapshot, ConnectOptions } from "./connect.js";
import type { DiscoveryCacheIdentity, DiscoveryCapabilityEvidence, DiscoveryProvenance } from "./contract/discovery.js";
import { type Capability, PROTOCOL_DEFAULT_CAPABILITIES, type SourceLocator } from "./contract/types.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";

/**
 * GeoParquet's canonical adapter surface. Discovery evidence is scoped to this
 * set so `resolveDiscoveryCapabilities` intersects footer evidence against the
 * exact operations the GeoParquet `Source` adapter can implement.
 */
const GEOPARQUET_ADAPTER_SCOPE: readonly Capability[] = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES.geoparquet]);

/** Physical geometry encoding reported by a GeoParquet footer read. */
export type GeoParquetGeometryEncoding = "wkb" | "native" | "geojson";

/** Detected geometry column plan from a GeoParquet footer read. */
export interface GeoParquetGeometryPlan {
  /** Geometry column name. */
  readonly column: string;
  /** How the geometry is physically stored. */
  readonly encoding: GeoParquetGeometryEncoding;
  /** Optional GeoParquet 1.1 bbox-covering struct column used for row-group pruning. */
  readonly bboxColumn?: string;
}

/**
 * Reviewed footer profile the connect seam consumes.
 *
 * Declared locally (not re-exported from `@honua/sdk-js/geoparquet`) so the
 * split `@honua/sdk` package's `connect-geoparquet.d.ts` is self-contained: a
 * TS consumer of the root SDK never has to resolve `./geoparquet/metadata.js`.
 * It is structurally a subset of `GeoparquetRuntime`'s `SourceProfile`, so a
 * `GeoparquetRuntime` still satisfies {@link GeoParquetSourceProfiler}.
 */
export interface GeoParquetSourceProfile {
  /** Non-geometry columns, in file order. */
  readonly columns: readonly string[];
  /** Geometry column plan, or `undefined` for a purely tabular file. */
  readonly geometry?: GeoParquetGeometryPlan;
  /** CRS identifier, best-effort (`OGC:CRS84`, an `EPSG:####`, or a name). */
  readonly crs?: string;
  /** Footer-derived row estimate, when available. */
  readonly rowEstimate?: number;
}

/**
 * Discovery seam for reading GeoParquet footer / `geo` metadata.
 *
 * Unlike network protocols, a GeoParquet asset has no HTTP metadata document:
 * discovery must read the Parquet footer (row-group + schema + the GeoParquet
 * `geo` key-value blob), which requires either HTTP range requests or a DuckDB
 * metadata read. That heavy machinery must never enter the `connect()` static
 * graph, so the reader is injected. `GeoparquetRuntime` (from
 * `@honua/sdk-js/geoparquet`) satisfies this interface structurally via its
 * `profile()` method, so the same runtime can both discover and execute.
 */
export interface GeoParquetSourceProfiler {
  /** Read (and typically memoize) the schema + geometry plan + CRS for a source-URL set. */
  profile(sources: readonly string[], geometryColumnOverride?: string): Promise<GeoParquetSourceProfile>;
}

export interface GeoParquetDiscoveryResult {
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

/**
 * Project a GeoParquet asset's footer metadata into a single reviewed source
 * snapshot.
 *
 * Capabilities are derived exclusively from a successful footer read: a
 * readable Parquet relation always supports the canonical `query`,
 * `queryAggregate`, and bounded `stream` operations over DuckDB
 * `read_parquet(...)`, so their availability is positive metadata evidence.
 * A detected geometry column (from GeoParquet `geo` metadata, a Parquet-native
 * `GEOMETRY`/`GEOGRAPHY` column, or an explicit override) is retained on the
 * locator so spatial predicate pushdown and geometry projection resolve without
 * a second profiling round-trip; a purely tabular Parquet file still discovers
 * the same three capabilities (spatial filters simply throw at query time).
 */
export async function discoverGeoParquetSources(
  profiler: GeoParquetSourceProfiler,
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
): Promise<GeoParquetDiscoveryResult> {
  const endpoint = identity.endpoint;
  const geometryColumnOverride = options.geoparquet?.geometryColumn;
  const additionalUrls = normalizeAdditionalUrls(options.geoparquet?.urls);
  const sources = [endpoint, ...additionalUrls];

  const profile = await profiler.profile(sources, geometryColumnOverride);
  throwIfAborted(options.signal);
  if (!profile || !Array.isArray(profile.columns)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoParquet metadata reader returned no readable schema.");
  }

  const retrievedAt = new Date().toISOString();
  const provenance: readonly DiscoveryProvenance[] = Object.freeze([
    Object.freeze({ source: `${endpoint} (parquet footer)`, retrievedAt }),
  ]);

  // A readable Parquet relation supports every canonical operation the adapter
  // implements. The evidence is scoped to the adapter surface so
  // resolveDiscoveryCapabilities intersects exactly those operations.
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: GEOPARQUET_ADAPTER_SCOPE,
      scope: GEOPARQUET_ADAPTER_SCOPE,
      provenance,
    }),
  ]);

  const geometry = profile.geometry;
  const geoparquetLocator: NonNullable<SourceLocator["geoparquet"]> = {
    ...(additionalUrls.length > 0 ? { urls: Object.freeze([...additionalUrls]) } : {}),
    ...(geometry ? { geometryColumn: geometry.column, geometryEncoding: geometry.encoding } : {}),
    ...(geometry?.bboxColumn ? { bboxColumn: geometry.bboxColumn } : {}),
  };
  const locator: SourceLocator = Object.freeze({
    url: endpoint,
    ...(Object.keys(geoparquetLocator).length > 0 ? { geoparquet: Object.freeze(geoparquetLocator) } : {}),
  });

  const source: ConnectDiscoverySourceSnapshot = Object.freeze({
    id: geoParquetSourceId(endpoint),
    locator,
    ...(profile.crs ? { crs: Object.freeze([profile.crs]) } : {}),
    evidence,
  });

  return Object.freeze({ retrievedAt, evidence: Object.freeze([]), sources: Object.freeze([source]) });
}

function normalizeAdditionalUrls(urls: readonly string[] | undefined): readonly string[] {
  if (urls === undefined) return [];
  if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string" || url.trim() === "")) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoParquet additional urls must be non-empty strings.");
  }
  return urls;
}

/**
 * Derive a stable, human-meaningful source id from the asset URL: the final
 * path segment without its extension (e.g. `.../places.parquet` → `places`),
 * falling back to `geoparquet` for globs / extension-less prefixes.
 */
function geoParquetSourceId(endpoint: string): string {
  let pathname: string;
  try {
    pathname = new URL(endpoint).pathname;
  } catch {
    pathname = endpoint;
  }
  const segments = pathname.split("/").filter((segment) => segment.length > 0 && !segment.includes("*"));
  const last = segments.at(-1);
  if (!last) return "geoparquet";
  const withoutExtension = last.replace(/\.[^.]+$/, "");
  const slug = withoutExtension.trim();
  return slug.length > 0 ? slug : "geoparquet";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
