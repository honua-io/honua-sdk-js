/** Internal GeoParquet / static-file metadata projection for connect(). */

import type { ConnectDiscoverySourceSnapshot, ConnectOptions, ConnectSourceSchemaProjection } from "./connect.js";
import type { DiscoveryCacheIdentity, DiscoveryCapabilityEvidence, DiscoveryProvenance } from "./contract/discovery.js";
import {
  type Capability,
  type GeoParquetGeometryEncoding as ContractGeoParquetGeometryEncoding,
  type GeoParquetGeometryExecution,
  type GeoParquetGeometryUnsupportedReason,
  type GeoParquetLocatorGeometry,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type SourceLocator,
} from "./contract/types.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError, HonuaDiscoveryError } from "./core/errors.js";

/**
 * GeoParquet's canonical adapter surface. Discovery evidence is scoped to this
 * set so `resolveDiscoveryCapabilities` intersects footer evidence against the
 * exact operations the GeoParquet `Source` adapter can implement.
 */
const GEOPARQUET_ADAPTER_SCOPE: readonly Capability[] = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES.geoparquet]);

/** Exact descriptive identity reported by a GeoParquet footer read. */
export type GeoParquetGeometryEncoding = ContractGeoParquetGeometryEncoding;

/** Detected geometry column plan from a GeoParquet footer read. */
export interface GeoParquetGeometryPlan {
  /** Geometry column name. */
  readonly column: string;
  /** How the geometry is physically stored. */
  readonly encoding: GeoParquetGeometryEncoding;
  /** Whether this is the metadata document's declared primary column. */
  readonly primary: boolean;
  /** Reviewed SQL representation available in the installed runtime. */
  readonly execution?: GeoParquetGeometryExecution;
  readonly spatialRuntimeAvailable: boolean;
  /** Stable reason the geometry is descriptive-only. */
  readonly unsupportedReason?: GeoParquetGeometryUnsupportedReason;
  readonly specVersion?: "1.0.0" | "1.1.0";
  /** Optional GeoParquet 1.1 bbox-covering struct column used for row-group pruning. */
  readonly bboxColumn?: string;
  /**
   * Whether the containing GeoParquet document passed the supported 1.0/1.1
   * structural checks. This is metadata conformance evidence only; it does not
   * assert that the current SQL runtime can execute the declared encoding.
   */
  readonly metadataState?: "valid" | "invalid" | "missing";
  /** GeoParquet `geometry_types`; an empty array explicitly means unknown. */
  readonly geometryTypes?: readonly string[];
  readonly geometryTypesState?: "valid" | "missing" | "invalid" | "conflicting";
  /** Distinguishes absent (CRS84 default), explicit null, and a declared CRS. */
  readonly crsState?: "absent" | "null" | "value" | "missing-metadata" | "invalid-metadata";
  readonly crsValue?: unknown;
  readonly coordinateEpoch?: number;
  readonly epochState?: "absent" | "valid" | "invalid";
  readonly epochValue?: unknown;
  readonly coordinateOrder?: "xy";
}

export interface GeoParquetFieldProfile {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
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
  /** Typed footer/DESCRIBE fields. Optional for compatibility with existing injected profilers. */
  readonly fields?: readonly GeoParquetFieldProfile[];
  /** Geometry column plan, or `undefined` for a purely tabular file. */
  readonly geometry?: GeoParquetGeometryPlan;
  /** All GeoParquet geometry columns; `geometry` selects the primary runtime column. */
  readonly geometries?: readonly GeoParquetGeometryPlan[];
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
  sourceSchemaProjection?: ConnectSourceSchemaProjection,
): Promise<GeoParquetDiscoveryResult> {
  const endpoint = identity.endpoint;
  const geometryColumnOverride = options.geoparquet?.geometryColumn;
  const additionalUrls = normalizeAdditionalUrls(options.geoparquet?.urls);
  const sources = [endpoint, ...additionalUrls];

  let profile: GeoParquetSourceProfile;
  try {
    profile = await profiler.profile(sources, geometryColumnOverride);
  } catch (cause) {
    throwIfAborted(options.signal);
    if (cause instanceof HonuaAbortError) throw cause;
    const reason =
      cause instanceof HonuaCapabilityNotSupportedError && cause.context.reason === "runtime-peer-unavailable"
        ? "runtime-peer-unavailable"
        : undefined;
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoParquet metadata could not be read with the configured runtime.",
      reason ? { reason } : undefined,
    );
  }
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

  const geometries = profile.geometries ?? (profile.geometry ? [profile.geometry] : []);
  const declaredPrimaries = geometries.filter((geometry) => geometry.primary);
  if (
    geometries.length > 0 &&
    (!profile.geometry ||
      declaredPrimaries.length !== 1 ||
      !samePrimaryGeometry(declaredPrimaries[0]!, profile.geometry))
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoParquet metadata does not declare one deterministic primary geometry.",
      {
        reason: "metadata-invalid",
      },
    );
  }
  const unsupported = geometries.find((geometry) => !geometry.execution || geometry.unsupportedReason !== undefined);
  if (unsupported) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoParquet geometry is not executable by the configured runtime.",
      { reason: unsupported.unsupportedReason ?? "layout-unsupported" },
    );
  }
  const geometry = profile.geometry;
  const locatorGeometries = geometries.map(locatorGeometry);
  const geoparquetLocator: NonNullable<SourceLocator["geoparquet"]> = {
    ...(additionalUrls.length > 0 ? { urls: Object.freeze([...additionalUrls]) } : {}),
    ...(geometry
      ? {
          geometryColumn: geometry.column,
          geometryEncoding: geometry.encoding,
          geometryExecution: geometry.execution,
          geometrySpatialRuntimeAvailable: geometry.spatialRuntimeAvailable,
        }
      : {}),
    ...(geometry?.bboxColumn ? { bboxColumn: geometry.bboxColumn } : {}),
    ...(locatorGeometries.length > 0 ? { geometries: Object.freeze(locatorGeometries) } : {}),
  };
  const locator: SourceLocator = Object.freeze({
    url: endpoint,
    ...(Object.keys(geoparquetLocator).length > 0 ? { geoparquet: Object.freeze(geoparquetLocator) } : {}),
  });
  const schemaV2 = sourceSchemaProjection?.geoParquet(profile, {
    source: `${endpoint} (parquet footer)`,
    observedAt: retrievedAt,
  });

  const source: ConnectDiscoverySourceSnapshot = Object.freeze({
    id: geoParquetSourceId(endpoint),
    locator,
    ...(profile.crs ? { crs: Object.freeze([profile.crs]) } : {}),
    ...(schemaV2 ? { schemaV2 } : {}),
    evidence,
  });

  return Object.freeze({ retrievedAt, evidence: Object.freeze([]), sources: Object.freeze([source]) });
}

function samePrimaryGeometry(left: GeoParquetGeometryPlan, right: GeoParquetGeometryPlan): boolean {
  return (
    left.column === right.column &&
    left.encoding === right.encoding &&
    left.execution === right.execution &&
    left.spatialRuntimeAvailable === right.spatialRuntimeAvailable &&
    left.unsupportedReason === right.unsupportedReason &&
    left.bboxColumn === right.bboxColumn
  );
}

function locatorGeometry(geometry: GeoParquetGeometryPlan): GeoParquetLocatorGeometry {
  return Object.freeze({
    column: geometry.column,
    primary: geometry.primary,
    encoding: geometry.encoding,
    ...(geometry.execution ? { execution: geometry.execution } : {}),
    spatialRuntimeAvailable: geometry.spatialRuntimeAvailable,
    ...(geometry.unsupportedReason ? { unsupportedReason: geometry.unsupportedReason } : {}),
    ...(geometry.specVersion ? { specVersion: geometry.specVersion } : {}),
    ...(geometry.bboxColumn ? { bboxColumn: geometry.bboxColumn } : {}),
    ...(geometry.geometryTypes ? { geometryTypes: Object.freeze([...geometry.geometryTypes]) } : {}),
    ...(geometry.crsState ? { crsState: geometry.crsState } : {}),
    ...(geometry.crsValue === undefined ? {} : { crsValue: geometry.crsValue }),
    ...(geometry.coordinateEpoch === undefined ? {} : { coordinateEpoch: geometry.coordinateEpoch }),
    ...(geometry.coordinateOrder ? { coordinateOrder: geometry.coordinateOrder } : {}),
  });
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
