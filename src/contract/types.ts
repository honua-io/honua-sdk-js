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
import type { HonuaExtent, HonuaFieldInfo, HonuaServerCompatibilityFeature, HonuaTypedFeature } from "../core/types.js";

// ── Protocol identifiers ──────────────────────────────────────

/**
 * Canonical protocol identifiers. Spatial / tabular protocols served
 * behind a `Source` come first, then the render-only OGC tile and map
 * adapters (reachable through `Source.protocol()`), then the STAC API
 * search adapter, the WFS / WMS / OData adapters, and finally the
 * MapLibre-native sources composed alongside protocol sources by
 * `HonuaMap` and `MapBinding`.
 *
 * The five GeoServices identifiers correspond to the five Esri service
 * types Honua Server publishes: FeatureServer, MapServer, ImageServer,
 * Geometry Service, and GP Service. Geometry and GP services do not host
 * features, so their `Source` instances expose only the typed `protocol()`
 * escape hatch — every cross-protocol request shape goes through one
 * vocabulary even when the underlying protocol is utility-only.
 */
export type Protocol =
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-image-service"
  | "geoservices-geometry-service"
  | "geoservices-gp-service"
  | "ogc-features"
  | "ogc-tiles"
  | "ogc-maps"
  | "stac"
  | "wfs"
  | "wms"
  | "wmts"
  | "odata"
  | "maplibre-vector"
  | "maplibre-raster"
  | "maplibre-geojson";

/** All protocol identifiers, in declaration order. */
export const PROTOCOLS: readonly Protocol[] = [
  "geoservices-feature-service",
  "geoservices-map-service",
  "geoservices-image-service",
  "geoservices-geometry-service",
  "geoservices-gp-service",
  "ogc-features",
  "ogc-tiles",
  "ogc-maps",
  "stac",
  "wfs",
  "wms",
  "wmts",
  "odata",
  "maplibre-vector",
  "maplibre-raster",
  "maplibre-geojson",
] as const;

// ── Capabilities ──────────────────────────────────────────────

/**
 * Coarse-grained protocol capabilities negotiated across the canonical
 * `Source` methods and the typed `Source.adapter()` escape hatch. This
 * ticket intentionally standardizes only the query-family subset on
 * `Source`; capabilities such as `render`, `tiles`, `sql`, and
 * `queryObjectIds` stay in the shared registry so downstream adapter
 * tickets can reuse one vocabulary without widening the top-level API.
 *
 * Keep this list aligned with `docs/protocol-capability-matrix.md`.
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
  | "connect"
  | "image"
  | "geometry"
  | "geoprocess"
  | "processes";

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
  "image",
  "geometry",
  "geoprocess",
  "processes",
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
  "geoservices-image-service": capabilities([
    "query",
    "queryExtent",
    "queryObjectIds",
    "image",
    "render",
    "tiles",
    "connect",
  ]),
  "geoservices-geometry-service": capabilities(["geometry", "connect"]),
  "geoservices-gp-service": capabilities(["geoprocess", "connect"]),
  "ogc-features": capabilities(["query", "queryObjectIds", "applyEdits", "stream"]),
  "ogc-tiles": capabilities(["render", "tiles"]),
  "ogc-maps": capabilities(["render"]),
  stac: capabilities(["query", "queryObjectIds", "stream"]),
  wfs: capabilities(["query", "queryExtent", "queryObjectIds", "applyEdits", "stream"]),
  wms: capabilities(["render", "tiles", "query"]),
  wmts: capabilities(["render", "tiles"]),
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
  /** GeoServices service identifier (FeatureServer / MapServer / ImageServer / Geometry / GP). */
  serviceId?: string;
  /** GeoServices layer identifier within the service. */
  layerId?: number;
  /** OGC API Features / Tiles / Maps collection identifier. */
  collectionId?: string | number;
  /** OGC API Tiles tile-matrix-set identifier (e.g. `WebMercatorQuad`). */
  tileMatrixSetId?: string;
  /** OGC API Maps / Tiles style identifier for styled-output endpoints. */
  styleId?: string;
  /** WFS / WMS type-name identifier. */
  typeName?: string;
  /** OData entity-set identifier. */
  entitySet?: string;
  /** GP Service task identifier (for `geoservices-gp-service`). */
  taskName?: string;
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

// ── Edit, related, attachment envelopes ──────────────────────

/**
 * Canonical feature shape used by edit envelopes. Mirrors the canonical
 * `HonuaTypedFeature<T>` (attributes + optional geometry) so the same value
 * an adapter returns from `query()` may be fed back into `applyEdits()`.
 */
export interface CanonicalFeature<T = Record<string, unknown>> {
  /** Optional row identity. Required for updates and deletes. */
  id?: FeatureId;
  attributes: T;
  geometry?: Record<string, unknown> | null;
}

/**
 * Single-source edit envelope. Adapters that do not advertise `applyEdits`
 * throw `HonuaCapabilityNotSupportedError` rather than dropping records.
 */
export interface EditEnvelope<T = Record<string, unknown>> {
  adds?: ReadonlyArray<CanonicalFeature<T>>;
  updates?: ReadonlyArray<CanonicalFeature<T>>;
  deletes?: ReadonlyArray<FeatureId>;
  /** When true (and the protocol honors it) the edit batch is atomic. */
  rollbackOnFailure?: boolean;
  /** Caller-supplied cancellation. */
  signal?: AbortSignal;
}

/** Per-feature edit outcome. */
export interface EditOutcome {
  id?: FeatureId;
  success: boolean;
  error?: { code: number; description: string };
}

/** Canonical edit response. Buckets mirror `EditEnvelope`. */
export interface EditResult {
  added: ReadonlyArray<EditOutcome>;
  updated: ReadonlyArray<EditOutcome>;
  deleted: ReadonlyArray<EditOutcome>;
  /** Degradation flags for partial-success or fallback paths. */
  degraded?: readonly DegradedReason[];
}

/**
 * Canonical related-records request. The `relationshipId` is protocol-specific
 * (GeoServices uses numeric ids; OData uses navigation property names) so
 * adapters that lack relationships throw `HonuaCapabilityNotSupportedError`
 * rather than silently dropping the request.
 */
export interface RelatedQuery {
  relationshipId: number;
  /** Source feature ids whose related records to return. */
  sourceIds: ReadonlyArray<FeatureId>;
  where?: string;
  outFields?: readonly string[];
  returnGeometry?: boolean;
  signal?: AbortSignal;
}

/** One source feature plus its related records. */
export interface RelatedGroup<T = Record<string, unknown>> {
  sourceId: FeatureId;
  features: ReadonlyArray<HonuaTypedFeature<T>>;
}

/** Canonical related-records response. */
export interface RelatedResult<T = Record<string, unknown>> {
  groups: ReadonlyArray<RelatedGroup<T>>;
  fields?: readonly HonuaFieldInfo[];
  degraded?: readonly DegradedReason[];
}

/** Metadata for a single attachment on a feature. */
export interface AttachmentInfo {
  id: FeatureId;
  parentId: FeatureId;
  name?: string;
  contentType?: string;
  size?: number;
}

/** Canonical attachment-query envelope. */
export interface AttachmentQuery {
  /** Optional caller-supplied parent ids. Empty = all matching `where`. */
  parentIds?: ReadonlyArray<FeatureId>;
  where?: string;
  signal?: AbortSignal;
}

/** Group of attachments for a single parent feature. */
export interface AttachmentGroup {
  parentId: FeatureId;
  attachments: ReadonlyArray<AttachmentInfo>;
}

/** Add-attachment request. `attachment` accepts `Blob`, `File`, or string. */
export interface AttachmentAdd {
  parentId: FeatureId;
  attachment: Blob | File | string;
  name?: string;
  contentType?: string;
  signal?: AbortSignal;
}

/** Update an existing attachment in place. */
export interface AttachmentUpdate extends AttachmentAdd {
  attachmentId: FeatureId;
}

/** Delete one or more attachments from a parent feature. */
export interface AttachmentDelete {
  parentId: FeatureId;
  attachmentIds: ReadonlyArray<FeatureId>;
  signal?: AbortSignal;
}

/** Outcome envelope for add / update / delete operations. */
export interface AttachmentEditOutcome {
  parentId?: FeatureId;
  attachmentId?: FeatureId;
  success: boolean;
  error?: { code: number; description: string };
}

/**
 * Namespace returned by `Source.attachments`. Adapters that do not advertise
 * the `attachments` capability throw `HonuaCapabilityNotSupportedError`
 * from each method rather than ship a `null`-ish placeholder.
 */
export interface AttachmentApi {
  query(request?: AttachmentQuery): Promise<ReadonlyArray<AttachmentGroup>>;
  list(parentId: FeatureId, options?: { signal?: AbortSignal }): Promise<ReadonlyArray<AttachmentInfo>>;
  add(request: AttachmentAdd): Promise<AttachmentEditOutcome>;
  update(request: AttachmentUpdate): Promise<AttachmentEditOutcome>;
  delete(request: AttachmentDelete): Promise<ReadonlyArray<AttachmentEditOutcome>>;
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
 * `Source`. `Source.protocol()` (and the legacy `Source.adapter()` alias)
 * narrows the typed escape hatch to one of these without forcing callers
 * to cast through `unknown`.
 */
export type AdapterKind =
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-map-layer"
  | "geoservices-image-service"
  | "geoservices-geometry-service"
  | "geoservices-gp-service"
  | "ogc-features"
  | "ogc-tiles"
  | "ogc-maps"
  | "ogc-processes"
  | "stac"
  | "wfs"
  | "wms"
  | "wms-layer"
  | "wmts"
  | "wmts-layer"
  | "wmts-tileset"
  | "odata";

/**
 * Compile-time map from `AdapterKind` → underlying class instance. Adapter
 * tickets extend this map by augmenting the `AdapterTypeMap` interface in
 * their own module so `Source.protocol("wfs")` returns the right type
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
 * classes are reachable through the typed `protocol()` escape hatch
 * (alias `adapter()`).
 *
 * The canonical surface covers the query family plus edit / related /
 * attachment operations. Operations that are protocol-specific (raw
 * `where`, raw `outFields`, GeoServices `calculate` / `validateSQL` /
 * `replica` etc.) live behind `protocol()` so the top-level API stays
 * free of ArcGIS-typed structures.
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

  /** Object ids of the records matching `request`. */
  queryObjectIds(request?: Query<T>): Promise<readonly FeatureId[]>;
  /** Apply add / update / delete edits to the source. */
  applyEdits(envelope: EditEnvelope<T>): Promise<EditResult>;
  /** Pull related records for the addressed source ids. */
  queryRelated<R = Record<string, unknown>>(request: RelatedQuery): Promise<RelatedResult<R>>;
  /** Attachment operations namespace; methods throw if `attachments` is missing. */
  readonly attachments: AttachmentApi;

  /**
   * Typed escape hatch to the underlying protocol-specific class. Use this
   * when a caller needs raw protocol semantics (e.g. raw `where`, raw
   * `outFields`, GeoServices `calculate` / `validateSQL` / replica /
   * `queryBins` / `getEstimates`) that the canonical surface intentionally
   * does not expose.
   */
  protocol<K extends AdapterKind>(kind: K): AdapterFor<K> | undefined;
  /**
   * Legacy alias of {@link Source.protocol}. Retained for callers written
   * against the original ticket-23 surface; new code should prefer
   * `protocol()` because the name reflects the design intent of
   * protocol-namespaced escape hatches.
   */
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
export type SourceResolver = (descriptor: SourceDescriptor, ctx: ResolveSourceContext) => Source | undefined;

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
