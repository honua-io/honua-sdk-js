/**
 * Shared client contract — canonical nouns that all protocol adapters
 * (`HonuaFeatureLayer`, `HonuaMapService`, `HonuaOgcFeatureCollection`, plus
 * future WFS / WMS / OData adapters) must speak. The contract is documented
 * in `docs/shared-client-contract.md`; capability coverage by protocol is
 * documented in `docs/protocol-capability-matrix.md`.
 *
 * The runtime classes in `src/core/surfaces.ts` are not replaced — they
 * remain the implementation. The contract here wraps their request /
 * response shapes (`QueryFeaturesRequest`, `OgcItemsRequest`,
 * `HonuaTypedQueryResponse`, `HonuaOgcFeatureCollectionResponse`) so that
 * cross-protocol code can speak one vocabulary without re-litigating the
 * surface in every downstream ticket.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import type { SpatialFilter } from "../core/spatial-filter.js";
import type {
  HonuaExtent,
  HonuaFieldInfo,
  HonuaServerCompatibilityFeature,
  HonuaTypedFeature,
} from "../core/types.js";

// ── Protocol identifiers ──────────────────────────────────────

/**
 * Canonical protocol identifiers. The first six are spatial / tabular
 * protocols served behind a `Source`; the last three are MapLibre-native
 * sources composed alongside protocol sources by `HonuaMap` and `MapBinding`.
 */
export type Protocol =
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "ogc-features"
  | "wfs"
  | "wms"
  | "odata"
  | "maplibre-vector"
  | "maplibre-raster"
  | "maplibre-geojson";

/** All protocol identifiers, in declaration order. */
export const PROTOCOLS: readonly Protocol[] = [
  "geoservices-feature-service",
  "geoservices-map-service",
  "ogc-features",
  "wfs",
  "wms",
  "odata",
  "maplibre-vector",
  "maplibre-raster",
  "maplibre-geojson",
] as const;

// ── Capabilities ──────────────────────────────────────────────

/**
 * Coarse-grained operations a `Source` may expose. Keep this list aligned
 * with `docs/protocol-capability-matrix.md`. Adapters declare which
 * capabilities they support so that `ExplorationContext` and downstream
 * tickets can negotiate without protocol-specific branches.
 */
export type Capability =
  | "query"
  | "queryAggregate"
  | "queryExtent"
  | "queryObjectIds"
  | "queryRelated"
  | "applyEdits"
  | "attachments"
  | "render"
  | "tiles"
  | "sql"
  | "stream"
  | "pbf"
  | "connect";

/** All capability identifiers, in declaration order. */
export const CAPABILITIES: readonly Capability[] = [
  "query",
  "queryAggregate",
  "queryExtent",
  "queryObjectIds",
  "queryRelated",
  "applyEdits",
  "attachments",
  "render",
  "tiles",
  "sql",
  "stream",
  "pbf",
  "connect",
] as const;

/**
 * Per-source capability registry. Set membership = first-party support
 * (the adapter can fulfill the capability without client-side fallback).
 * Capabilities that require a client-side fallback should be omitted from
 * the set; callers either swap to a different protocol or opt into a
 * `degraded: true` policy at the `ExplorationContext` level.
 */
export type Capabilities = ReadonlySet<Capability>;

/**
 * Build a `Capabilities` set from a readonly array. Provided as a tiny
 * helper so callers do not need to import `Set` literals at every adapter
 * site.
 */
export function capabilities(values: readonly Capability[]): Capabilities {
  return new Set(values);
}

/**
 * Default capability sets keyed by protocol. Callers that need a narrower
 * surface for a specific source must intersect the default set themselves
 * and pass the result on `SourceDescriptor.capabilities`; the built-in
 * adapter constructors do not read service metadata today.
 *
 * The matrix here mirrors the one in `docs/protocol-capability-matrix.md`.
 * Update both together.
 */
export const PROTOCOL_DEFAULT_CAPABILITIES: Readonly<Record<Protocol, Capabilities>> = {
  "geoservices-feature-service": capabilities([
    "query",
    "queryAggregate",
    "queryExtent",
    "queryObjectIds",
    "queryRelated",
    "applyEdits",
    "attachments",
    "sql",
    "stream",
    "pbf",
    "connect",
  ]),
  "geoservices-map-service": capabilities([
    "query",
    "queryAggregate",
    "queryExtent",
    "queryObjectIds",
    "queryRelated",
    "render",
    "tiles",
    "sql",
    "stream",
  ]),
  "ogc-features": capabilities(["query", "queryObjectIds", "applyEdits", "stream"]),
  wfs: capabilities(["query", "queryExtent", "queryObjectIds", "applyEdits"]),
  wms: capabilities(["render", "tiles"]),
  odata: capabilities(["query", "queryObjectIds"]),
  "maplibre-vector": capabilities(["render", "tiles"]),
  "maplibre-raster": capabilities(["render", "tiles"]),
  "maplibre-geojson": capabilities(["render"]),
};

// ── Source identity ───────────────────────────────────────────

export type SourceId = string;
export type DatasetId = string;
export type FeatureId = number | string;

/**
 * Protocol-specific endpoint information. Field-compatible with the server
 * `SourceBinding.locator` shape documented in
 * `docs/source-binding-alignment.md` (a Honua SDK `SourceDescriptor` may be
 * exported into a server `SourceBinding` without re-shaping the locator).
 */
export interface SourceLocator {
  /** Fully qualified URL to the protocol endpoint. */
  url: string;
  /** GeoServices service identifier (FeatureServer / MapServer parent). */
  serviceId?: string;
  /** GeoServices layer identifier within the service. */
  layerId?: number;
  /** OGC API Features collection identifier. */
  collectionId?: string | number;
  /** WFS / WMS type-name identifier. */
  typeName?: string;
  /** OData entity-set identifier. */
  entitySet?: string;
}

/** Optional schema description; mirrors `HonuaLayerMetadata.fields`. */
export interface SourceSchema {
  fields?: readonly HonuaFieldInfo[];
  primaryKey?: string;
  /** Hint that the source's records carry temporal validity. */
  timeField?: string;
}

/**
 * Canonical descriptor for one protocol-backed data source. Carries
 * everything required to construct a `Source`, negotiate capabilities, and
 * project the source onto a server `SourceBinding`.
 */
export interface SourceDescriptor {
  id: SourceId;
  protocol: Protocol;
  locator: SourceLocator;
  capabilities: Capabilities;
  schema?: SourceSchema;
  attribution?: string;
}

// ── Query envelope ────────────────────────────────────────────

export interface PaginationSpec {
  /** Zero-based offset of the first record. */
  offset?: number;
  /** Maximum records per page. Implementation may clamp. */
  limit?: number;
}

export interface SortSpec {
  field: string;
  direction?: "asc" | "desc";
}

export type AggregationFn = "count" | "sum" | "avg" | "min" | "max" | "stddev" | "var";

export interface AggregationSpec {
  /** Optional grouping fields. Empty / omitted = single-row aggregate. */
  groupBy?: readonly string[];
  /** Aggregation expressions. */
  metrics: readonly AggregationMetric[];
}

export interface AggregationMetric {
  fn: AggregationFn;
  field: string;
  alias?: string;
}

/**
 * Protocol-neutral query intent. `Source.query()` adapters translate this
 * into a `QueryFeaturesRequest`, `MapLayerQueryRequest`, `OgcItemsRequest`,
 * or the corresponding WFS / OData request.
 */
export interface Query<_T = Record<string, unknown>> {
  /** Logical filter expression. SQL-92 WHERE for GeoServices, CQL2 for OGC. */
  where?: string;
  /** Spatial constraint. Reuses `core/spatial-filter.ts`. */
  spatialFilter?: SpatialFilter;
  /** Subset of fields to return. Adapters default to all when omitted. */
  outFields?: readonly string[];
  /** Sort order. */
  orderBy?: readonly SortSpec[];
  /** Pagination. */
  pagination?: PaginationSpec;
  /** Aggregation request; if present the `Result` contains aggregate rows. */
  aggregation?: AggregationSpec;
  /** Whether the result envelope should include geometry. */
  returnGeometry?: boolean;
  /** Output spatial reference (WKID, "auto", or full reference object). */
  outSr?: string | number;
  /** Caller-supplied cancellation. */
  signal?: AbortSignal;
}

// ── Result envelope ───────────────────────────────────────────

/**
 * Reasons that a `Source` may have fulfilled a `Query` with a degraded
 * strategy. Surfaced in `Result.degraded`. Downstream views should check
 * this field before reporting numbers as authoritative.
 */
export interface DegradedReason {
  /** The capability that was missing or partially supported. */
  capability: Capability;
  /** Human-readable explanation. */
  reason: string;
  /** Which protocol the degradation was relative to. */
  protocol?: Protocol;
}

/**
 * Unified query result envelope. Wraps (does not replace)
 * `HonuaTypedQueryResponse<T>` and `HonuaOgcFeatureCollectionResponse`;
 * adapters fill the optional fields that their underlying response carries
 * and leave the rest undefined.
 */
export interface Result<T = Record<string, unknown>> {
  /** Returned features. Empty array (not undefined) when nothing matched. */
  features: readonly HonuaTypedFeature<T>[];
  /** True if the server signalled that more records exist than were returned. */
  exceededTransferLimit: boolean;
  /** Total count when known (counts request, OGC `numberMatched`). */
  totalCount?: number;
  /** Aggregated rows when the query carried an `aggregation` spec. */
  aggregateRows?: ReadonlyArray<Record<string, unknown>>;
  /** Spatial extent of the returned features (extent-only query response). */
  extent?: HonuaExtent;
  /** Field schema as returned by the protocol, when the response carried one. */
  fields?: readonly HonuaFieldInfo[];
  /** Degradation flags emitted by the source while serving this query. */
  degraded?: readonly DegradedReason[];
}

// ── Map binding ───────────────────────────────────────────────

/**
 * Formalizes the `HonuaMap.addSource` / `addLayer` binding. A `MapBinding`
 * names the source that backs one or more rendering layers and carries an
 * optional partial style block. `MapBinding` arrays serialize to
 * `MapPackage.sourceBindings` + `MapPackage.mapSpec` on the server side.
 */
export interface MapBinding {
  /** ID of the `Source` whose data backs the layers. */
  sourceId: SourceId;
  /** Layer ids consuming the source. */
  layerIds: readonly string[];
  /** Style overrides; merged with the source-driven defaults. */
  style?: Record<string, unknown>;
  /** Optional minimum zoom for visibility (forwarded to layer specs). */
  minzoom?: number;
  /** Optional maximum zoom for visibility (forwarded to layer specs). */
  maxzoom?: number;
}

// ── Source handle ─────────────────────────────────────────────

/**
 * Discriminated union of the runtime adapter classes that implement
 * `Source`. `Source.adapter()` narrows the typed escape hatch to one of
 * these without forcing callers to cast through `unknown`.
 */
export type AdapterKind =
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-map-layer"
  | "ogc-features"
  | "wfs"
  | "wms"
  | "odata";

/**
 * Compile-time map from `AdapterKind` → underlying class instance. Adapter
 * tickets extend this map by augmenting the `AdapterTypeMap` interface in
 * their own module so `Source.adapter("wfs")` returns the right type
 * without a cast. The interface ships empty by design — built-in adapters
 * augment it from `src/contract/source.ts`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merging seam for adapter tickets
export interface AdapterTypeMap {}

export type AdapterFor<K extends AdapterKind> = K extends keyof AdapterTypeMap ? AdapterTypeMap[K] : unknown;

/**
 * Protocol-neutral data-source handle. Adapters returned by
 * `Dataset.source()` implement this interface directly; the existing
 * `HonuaFeatureLayer`, `HonuaMapService`, and `HonuaOgcFeatureCollection`
 * classes are reachable through the typed `adapter()` escape hatch.
 *
 * Per the design brief, the `query()` family is intentionally narrow:
 * downstream tickets must consume `Query` / `Result` rather than invent
 * parallel request shapes.
 */
export interface Source<T = Record<string, unknown>> {
  readonly descriptor: SourceDescriptor;
  readonly capabilities: Capabilities;

  /** Single-page query. */
  query(request?: Query<T>): Promise<Result<T>>;
  /** Drain all pages into a single result. Honors `Query.pagination.limit`. */
  queryAll(request?: Query<T>): Promise<Result<T>>;
  /** Server-side aggregation; falls back to client-side under `degraded` policy. */
  queryAggregate(request: Query<T> & { aggregation: AggregationSpec }): Promise<Result<T>>;
  /** Extent of the records that match `request`. */
  queryExtent(request?: Query<T>): Promise<{ extent: HonuaExtent | null; count?: number }>;
  /** Async-generator paging stream. */
  stream(request?: Query<T>): AsyncGenerator<Result<T>, void, undefined>;

  /** Typed escape hatch to the underlying protocol-specific class. */
  adapter<K extends AdapterKind>(kind: K): AdapterFor<K> | undefined;
}

// ── Dataset ───────────────────────────────────────────────────

/**
 * Logical grouping of one or more sources sharing identity and (optionally)
 * a field schema. `Dataset` is the canonical entry point: `createDataset`
 * gates the compatibility check and caches it per `HonuaClient`.
 */
export interface Dataset {
  readonly id: DatasetId;
  readonly client: HonuaClient;
  readonly sourceDescriptors: ReadonlyArray<SourceDescriptor>;

  /** Get a `Source` handle by id. Returns `undefined` if not registered. */
  source<T = Record<string, unknown>>(id: SourceId): Source<T> | undefined;
  /** Iterate registered source ids, in registration order. */
  sourceIds(): readonly SourceId[];
  /**
   * Returns `true` when `client.checkCompatibility()` reported a supported
   * server. The dataset caches the negotiation per `HonuaClient` instance.
   */
  isCompatible(): Promise<boolean>;
  /** Server-feature gate that mirrors `HonuaClient.supportsFeature`. */
  supportsFeature(feature: HonuaServerCompatibilityFeature): Promise<boolean>;
}

export type CapabilityPolicy = "strict" | "degraded";

/**
 * Context passed to a `SourceResolver`. Carries the active `HonuaClient`
 * and the dataset's capability policy so adapters can react to either.
 */
export interface ResolveSourceContext {
  readonly client: HonuaClient;
  readonly capabilityPolicy: CapabilityPolicy;
}

/**
 * Adapter factory invoked for descriptors the built-in resolvers cannot
 * handle (today: `wfs`, `wms`, `odata`, MapLibre-native sources). Downstream
 * tickets register their adapters by passing one through
 * `CreateDatasetOptions.resolveSource`.
 */
export type SourceResolver = (
  descriptor: SourceDescriptor,
  ctx: ResolveSourceContext,
) => Source | undefined;

export interface CreateDatasetOptions {
  id: DatasetId;
  client: HonuaClient;
  /** Source descriptors; `Source` instances are constructed lazily. */
  sources: ReadonlyArray<SourceDescriptor>;
  /**
   * Capability policy. `"strict"` (default) refuses to construct a `Source`
   * whose required capability is missing. `"degraded"` allows client-side
   * fallback paths that report via `Result.degraded`.
   */
  capabilityPolicy?: CapabilityPolicy;
  /**
   * When `true`, skips the `client.checkCompatibility()` gate. Reserved for
   * test fixtures and conformance suites; production code should leave this
   * unset.
   */
  skipCompatibilityCheck?: boolean;
  /**
   * Resolver invoked for descriptors the built-in resolvers do not know how
   * to handle. Built-in coverage today is `geoservices-feature-service`,
   * `geoservices-map-service`, `ogc-features`. Downstream WFS / WMS / OData
   * tickets supply their adapter here.
   */
  resolveSource?: SourceResolver;
}
