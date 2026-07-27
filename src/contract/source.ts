/**
 * Built-in `Source` adapters that wrap the runtime classes in
 * `src/core/surfaces.ts` (`HonuaFeatureLayer`, `HonuaMapLayer`,
 * `HonuaOgcFeatureCollection`) and the OGC / STAC / WFS / WMS / OData
 * adapters in `src/core/`. Consumers register adapters for any other
 * protocol (MapLibre-native sources, etc.) via
 * `CreateDatasetOptions.resolveSource`.
 *
 * These adapters do not reimplement query logic — they translate the
 * canonical `Query` / `Result` envelope to and from the existing per-class
 * request and response shapes.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { HonuaCapabilityNotSupportedError, HonuaHttpError } from "../core/errors.js";
import type { HonuaOdataEncodedEntityKey, HonuaOdataEncodedWriteBody } from "../core/odata-write-codec.js";
import {
  type HonuaOdataAdvertisedCapabilities,
  type HonuaOdataBatchOperation,
  type HonuaOdataBatchOutcome,
  HonuaOdataEntitySet,
  type HonuaOdataMetadata,
  type HonuaOdataPage,
  type HonuaOdataQueryParams,
  buildOdataSpatialFilter,
  odataFieldSchema,
  rewriteWhereToOdataFilter,
} from "../core/odata.js";
import { HonuaOgcCollectionMap, HonuaOgcMaps } from "../core/ogc-maps.js";
import type { HonuaOgcProcesses } from "../core/ogc-processes.js";
import { HonuaOgcRecordCollection } from "../core/ogc-records.js";
import { HonuaOgcTiles, HonuaOgcTileset } from "../core/ogc-tiles.js";
import { trimTrailingSlashes } from "../core/path-utils.js";
import { HonuaStacStaticCatalog, type StacStaticSearchParams } from "../core/stac-static.js";
import { HonuaStacSearch } from "../core/stac.js";
import {
  HonuaFeatureLayer,
  HonuaGeometryService,
  HonuaGeoprocessingService,
  HonuaImageService,
  HonuaMapLayer,
  HonuaMapService,
  HonuaOgcFeatureCollection,
  HonuaOgcFeatures,
} from "../core/surfaces.js";
import type {
  HonuaAttachmentEditResult,
  HonuaAttachmentInfo,
  HonuaFeature,
  HonuaQueryResponse,
  HonuaRelatedRecordGroup,
  HonuaStacItemResponse,
  HonuaTypedFeature,
  HonuaTypedQueryResponse,
  OgcRecordsSearchRequest,
  StacSearchRequest,
} from "../core/types.js";
import {
  type FesNode,
  UNSUPPORTED_FES,
  compileSpatialFilter,
  compileWhere,
  geoJsonGeometryToGml,
  serializeFes,
} from "../core/wfs-filter.js";
import { HonuaWfsFeatureType, type OutputFormatChoice } from "../core/wfs.js";
import { HonuaWms, HonuaWmsLayer, parseWmsLayerNames } from "../core/wms.js";
import { HonuaWmts, HonuaWmtsLayer, HonuaWmtsTileset } from "../core/wmts.js";
import type { HonuaPmtilesArchive } from "./pmtiles.js";
import { pmtilesProtocolModule } from "./pmtiles.js";
import { addCapabilitySupport, normalizeCapabilityDescriptor } from "./source-capability-support.js";
import {
  type AdapterFor,
  type AdapterKind,
  type AggregationFn,
  type AggregationMetric,
  type AggregationSpec,
  type AttachmentAdd,
  type AttachmentApi,
  type AttachmentDelete,
  type AttachmentEditOutcome,
  type AttachmentGroup,
  type AttachmentInfo,
  type AttachmentQuery,
  type AttachmentUpdate,
  CAPABILITIES,
  type Capability,
  type CapabilityAwareSource,
  type CapabilityPolicy,
  type CreateDatasetOptions,
  type Dataset,
  type DegradedReason,
  type EditEnvelope,
  type EditOutcome,
  type EditResult,
  type FeatureId,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type Query,
  type RelatedGroup,
  type RelatedQuery,
  type RelatedResult,
  type Result,
  type Source,
  type SourceDescriptor,
  type SourceId,
  type SourceLocator,
} from "./types.js";

/**
 * Construct a protocol-neutral `Dataset` over a `HonuaClient`.
 *
 * A `Dataset` groups one or more `Source`s. Each `Source` accepts a protocol-neutral
 * `Query` and returns a protocol-neutral `Result`. The dataset is the cross-protocol
 * unit of work: a single `Dataset` can mix GeoServices FeatureServer, OGC API Features,
 * WFS, STAC, and OData sources under one capability policy.
 *
 * `Source` handles are constructed lazily, server compatibility is checked once per
 * dataset (and cached on the underlying client), and capability gaps surface as
 * {@link HonuaCapabilityNotSupportedError} under the default `"strict"` policy rather
 * than silently returning empty results.
 *
 * Operations the canonical surface does not cover stay reachable through the typed
 * `source.protocol(...)` escape hatch (e.g. ImageServer `exportImage`, GeometryServer
 * `project`, GPServer `submitJob`, WFS `LockFeature`).
 *
 * @param options - The dataset id, the `HonuaClient` to talk to, the list of
 *   `SourceDescriptor`s, and (optionally) `capabilityPolicy` and a custom
 *   `resolveSource` factory.
 *
 * @example
 * ```ts
 * import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
 * import { HonuaClient } from "@honua/sdk-js/honua";
 *
 * const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });
 *
 * const dataset = createDataset({
 *   id: "parcels",
 *   client,
 *   sources: [
 *     {
 *       id: "parcels-fs",
 *       protocol: "geoservices-feature-service",
 *       locator: { url: "https://your-honua-server.example", serviceId: "parcels", layerId: 0 },
 *       capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
 *     },
 *   ],
 * });
 *
 * const parcels = dataset.source("parcels-fs")!;
 * const result = await parcels.queryAll({
 *   outFields: ["OBJECTID", "NAME"],
 *   returnGeometry: true,
 *   pagination: { limit: 500 },
 * });
 *
 * console.log(`Loaded ${result.features.length} features`);
 * ```
 */
export function createDataset(options: CreateDatasetOptions): Dataset {
  const { id, client, sources, resolveSource } = options;
  const policy: CapabilityPolicy = options.capabilityPolicy ?? "strict";
  const descriptors = new Map<SourceId, SourceDescriptor>();
  const handles = new Map<SourceId, CapabilityAwareSource>();
  let compatibilityPromise: Promise<boolean> | undefined;

  for (const input of sources) {
    const descriptor = normalizeCapabilityDescriptor(input);
    if (descriptors.has(descriptor.id)) {
      throw new Error(`createDataset: duplicate source id "${descriptor.id}"`);
    }
    descriptors.set(descriptor.id, descriptor);
  }

  function resolve<T>(descriptor: SourceDescriptor): CapabilityAwareSource<T> {
    const cached = handles.get(descriptor.id);
    if (cached) return cached as CapabilityAwareSource<T>;

    const builtIn = buildBuiltInSource<T>(descriptor, client, policy);
    const built =
      builtIn ?? (resolveSource?.(descriptor, { client, capabilityPolicy: policy }) as Source<T> | undefined);
    if (!built) {
      throw new HonuaCapabilityNotSupportedError("query", descriptor.protocol, descriptor.id);
    }
    const source = builtIn ?? addCapabilitySupport(built, descriptor);
    handles.set(descriptor.id, source as CapabilityAwareSource);
    return source;
  }

  return {
    id,
    client,
    sourceDescriptors: [...descriptors.values()],
    source<T = Record<string, unknown>>(sourceId: SourceId): CapabilityAwareSource<T> | undefined {
      const descriptor = descriptors.get(sourceId);
      if (!descriptor) return undefined;
      return resolve<T>(descriptor);
    },
    sourceIds(): readonly SourceId[] {
      return [...descriptors.keys()];
    },
    isCompatible(): Promise<boolean> {
      if (options.skipCompatibilityCheck) return Promise.resolve(true);
      if (!compatibilityPromise) {
        compatibilityPromise = client
          .checkCompatibility()
          .then((status) => status.supported)
          .catch(() => false);
      }
      return compatibilityPromise;
    },
    supportsFeature(feature) {
      return client.supportsFeature(feature).catch(() => false);
    },
  };
}

// ── Built-in resolver ─────────────────────────────────────────

function buildBuiltInSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> | undefined {
  switch (descriptor.protocol) {
    case "grpc":
      // Honua gRPC is a transport-selectable fast path over the same
      // canonical FeatureServer semantics, not a distinct adapter: the
      // returned `HonuaFeatureLayer` transparently routes `queryFeatures`
      // over gRPC-Web when `client.transport === "grpc-web"` (see
      // `docs/protocol-capability-matrix.md`, "gRPC FeatureService"). The
      // discovered descriptor's narrower `capabilities` (verified through a
      // live gRPC parity probe in `connect-grpc.ts`) still gate execution.
      return geoServicesFeatureSource<T>(descriptor, client, policy);
    case "geoservices-feature-service":
      return geoServicesFeatureSource<T>(descriptor, client, policy);
    case "geoservices-map-service":
      return geoServicesMapServiceSource<T>(descriptor, client, policy);
    case "geoservices-image-service":
      return geoServicesImageSource<T>(descriptor, client, policy);
    case "geoservices-geometry-service":
      return geoServicesGeometryServiceSource<T>(descriptor, client, policy);
    case "geoservices-gp-service":
      return geoServicesGPServiceSource<T>(descriptor, client, policy);
    case "ogc-features":
      return ogcFeaturesSource<T>(descriptor, client, policy);
    case "ogc-tiles":
      return ogcTilesSource<T>(descriptor, client, policy);
    case "ogc-maps":
      return ogcMapsSource<T>(descriptor, client, policy);
    case "ogc-records":
      return ogcRecordsSource<T>(descriptor, client, policy);
    case "wms":
      return wmsSource<T>(descriptor, client, policy);
    case "wmts":
      return wmtsSource<T>(descriptor, client, policy);
    case "stac":
      return stacSearchSource<T>(descriptor, client, policy);
    case "wfs":
      return wfsSource<T>(descriptor, client, policy);
    case "odata":
      return odataSource<T>(descriptor, client, policy);
    case "pmtiles":
      return pmtilesSource<T>(descriptor, client, policy);
    default:
      return undefined;
  }
}

// ── GeoServices Feature Service ───────────────────────────────

/**
 * Adapter factory for a GeoServices FeatureServer layer.
 *
 * Used internally by {@link createDataset} when it sees a descriptor with
 * `protocol: "geoservices-feature-service"`. Calling it directly is rarely
 * necessary; pass the descriptor to `createDataset` instead.
 *
 * @example
 * ```ts
 * const dataset = createDataset({
 *   id: "parcels",
 *   client,
 *   sources: [{
 *     id: "parcels-fs",
 *     protocol: "geoservices-feature-service",
 *     locator: { url: "https://your-honua-server.example", serviceId: "parcels", layerId: 0 },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
 *   }],
 * });
 * const result = await dataset.source("parcels-fs")!.queryAll({
 *   outFields: ["OBJECTID", "NAME"],
 *   pagination: { limit: 500 },
 * });
 * ```
 */
export function geoServicesFeatureSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { serviceId, layerId } = requireFeatureServiceLocator(descriptor);
  const layer = new HonuaFeatureLayer<T>({ client, serviceId, layerId });
  // Indexed by the descriptor's own protocol (not hardcoded to
  // "geoservices-feature-service") so a `protocol: "grpc"` descriptor built
  // without explicit capabilities falls back to the narrower gRPC default
  // set rather than silently inheriting REST-only capabilities (`pbf`,
  // `sql`, `attachments`, `queryRelated`) the gRPC FeatureService RPC
  // surface does not support.
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES[descriptor.protocol];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "geoservices-feature-service": layer,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      const requestParams = toFeatureLayerRequest(request);
      if (request?.aggregation) {
        ensureCapability(descriptor, caps, "queryAggregate");
        const { aggregateAlias, ...aggFields } = buildAggregationFields(request.aggregation);
        return aggregateResultFromFeatureLayer(
          await layer.queryFeatures({ ...requestParams, ...aggFields }),
          aggregateAlias,
        );
      }
      const response = await layer.queryFeatures(requestParams);
      return featureLayerResultFromTyped<T>(response);
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      const params = withPagingBounds(toFeatureLayerRequest(request), request?.pagination?.limit);
      const features = await layer.queryFeaturesAll(params);
      const { features: limited, exceededTransferLimit } = applyQueryAllLimit(features, request?.pagination?.limit);
      return {
        features: limited,
        exceededTransferLimit,
        totalCount: limited.length,
      } satisfies Result<T>;
    },
    async queryAggregate(request) {
      ensureCapability(descriptor, caps, "queryAggregate");
      const requestParams = toFeatureLayerRequest(request);
      const { aggregateAlias, ...aggFields } = buildAggregationFields(request.aggregation);
      const response = await layer.queryFeatures({ ...requestParams, ...aggFields });
      return aggregateResultFromFeatureLayer(response, aggregateAlias);
    },
    async queryExtent(request) {
      ensureCapability(descriptor, caps, "queryExtent");
      const response = await layer.queryFeatures(toExtentOnlyRequest(toFeatureLayerRequest(request)));
      return extractExtentEnvelope(response);
    },
    async *stream(request) {
      ensureCapability(descriptor, caps, "stream");
      const stream = layer.queryFeaturesStream(
        withStreamPageSize(toFeatureLayerRequest(request), request?.pagination?.limit),
      );
      for await (const page of stream) {
        yield {
          features: page,
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, caps, "queryObjectIds");
      return layer.queryObjectIds(toFeatureLayerRequest(request));
    },
    async applyEdits(envelope) {
      ensureCapability(descriptor, caps, "applyEdits");
      const response = await layer.applyEdits(toApplyEditsRequest(envelope));
      return canonicalEditResult(response);
    },
    async queryRelated<R>(request: RelatedQuery) {
      ensureCapability(descriptor, caps, "queryRelated");
      const response = await layer.queryRelatedRecords(toRelatedRecordsRequest(request));
      return canonicalRelatedResult<R>(response);
    },
    attachments: featureLayerAttachmentApi(descriptor, caps, layer),
  });
}

// ── GeoServices Map Service / Map Layer ───────────────────────

/**
 * Adapter factory for a GeoServices MapServer layer.
 *
 * Reach `Source.protocol("geoservices-map-service")` for raw `exportImage` /
 * `identify` / `find` access; the canonical `query()` runs against a single
 * sublayer via the MapServer query endpoint.
 *
 * @example
 * ```ts
 * const dataset = createDataset({
 *   id: "basemap",
 *   client,
 *   sources: [{
 *     id: "states-mapserver",
 *     protocol: "geoservices-map-service",
 *     locator: { url: "https://your-honua-server.example", serviceId: "states", layerId: 0 },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-map-service"],
 *   }],
 * });
 * ```
 */
export function geoServicesMapServiceSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { serviceId, layerId } = requireMapServiceLocator(descriptor);
  const service = new HonuaMapService({ client, serviceId });
  const layer = new HonuaMapLayer({ client, serviceId, layerId });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["geoservices-map-service"];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "geoservices-map-service": service,
    "geoservices-map-layer": layer,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      const params = toFeatureLayerRequest(request);
      if (request?.aggregation) {
        ensureCapability(descriptor, caps, "queryAggregate");
        const { aggregateAlias, ...aggFields } = buildAggregationFields(request.aggregation);
        return aggregateResultFromUntyped<T>(await layer.queryFeatures({ ...params, ...aggFields }), aggregateAlias);
      }
      const response = await layer.queryFeatures(params);
      return featureLayerResultFromUntyped<T>(response);
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      const params = withPagingBounds(toFeatureLayerRequest(request), request?.pagination?.limit);
      const features = await layer.queryFeaturesAll(params);
      const typed = features.map(toTypedFeature<T>);
      const { features: limited, exceededTransferLimit } = applyQueryAllLimit(typed, request?.pagination?.limit);
      return {
        features: limited,
        exceededTransferLimit,
        totalCount: limited.length,
      } satisfies Result<T>;
    },
    async queryAggregate(request) {
      ensureCapability(descriptor, caps, "queryAggregate");
      const params = toFeatureLayerRequest(request);
      const { aggregateAlias, ...aggFields } = buildAggregationFields(request.aggregation);
      const response = await layer.queryFeatures({ ...params, ...aggFields });
      return aggregateResultFromUntyped<T>(response, aggregateAlias);
    },
    async queryExtent(request) {
      ensureCapability(descriptor, caps, "queryExtent");
      const response = await layer.queryFeatures(toExtentOnlyRequest(toFeatureLayerRequest(request)));
      return extractExtentEnvelope(response);
    },
    async *stream(request) {
      ensureCapability(descriptor, caps, "stream");
      const stream = layer.queryFeaturesStream(
        withStreamPageSize(toFeatureLayerRequest(request), request?.pagination?.limit),
      );
      for await (const page of stream) {
        yield {
          features: page.map(toTypedFeature<T>),
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, caps, "queryObjectIds");
      return layer.queryObjectIds(toFeatureLayerRequest(request));
    },
    async applyEdits() {
      // MapServer is read-only; applyEdits exists only on the FeatureServer
      // surface. Refuse rather than silently no-op so callers can branch.
      throw new HonuaCapabilityNotSupportedError("applyEdits", descriptor.protocol, descriptor.id);
    },
    async queryRelated<R>(request: RelatedQuery) {
      ensureCapability(descriptor, caps, "queryRelated");
      const response = await layer.queryRelatedRecords(toRelatedRecordsRequest(request));
      return canonicalRelatedResult<R>(response);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

// ── OGC API Features ──────────────────────────────────────────

/**
 * Adapter factory for an OGC API Features collection.
 *
 * @example
 * ```ts
 * const dataset = createDataset({
 *   id: "addresses",
 *   client,
 *   sources: [{
 *     id: "addresses-ogc",
 *     protocol: "ogc-features",
 *     locator: { url: "https://your-honua-server.example", collectionId: "addresses" },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
 *   }],
 * });
 * const result = await dataset.source("addresses-ogc")!.queryAll({
 *   pagination: { limit: 200 },
 * });
 * ```
 */
export function ogcFeaturesSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { collectionId } = requireOgcLocator(descriptor);
  const layoutMode = ogcFeaturesLayoutMode(descriptor.locator.layout);
  const collection = new HonuaOgcFeatureCollection({
    client,
    collectionId,
    ...(layoutMode ? { layout: layoutMode } : {}),
  });
  const root = new HonuaOgcFeatures({ client, ...(layoutMode ? { layout: layoutMode } : {}) });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "ogc-features": collection,
  };
  void root;

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      if (request?.aggregation) {
        // OGC has no server-side aggregation; the adapter always aggregates
        // client-side over the returned page. `queryAggregate` is therefore a
        // degradable capability here.
        ensureCapabilityOrFallback(descriptor, caps, "queryAggregate", policy);
      }
      const response = await collection.items(toOgcRequest(request));
      const features = response.features.map(toTypedFeatureFromOgc<T>);
      const totalCount = response.numberMatched;
      const degraded: DegradedReason[] = [];
      const exceededTransferLimit = totalCount !== undefined && features.length < totalCount;
      if (request?.aggregation) {
        const aggregateRows = clientSideAggregate(features, request.aggregation);
        degraded.push({
          capability: "queryAggregate",
          reason:
            "OGC API Features does not expose server-side aggregation; aggregating client-side over the returned page.",
          protocol: "ogc-features",
          sourceId: descriptor.id,
        });
        return {
          features,
          exceededTransferLimit,
          totalCount,
          aggregateRows,
          degraded,
        } satisfies Result<T>;
      }
      return {
        features,
        exceededTransferLimit,
        totalCount,
      } satisfies Result<T>;
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      const limit = request?.pagination?.limit;
      // When the caller caps the result with `pagination.limit`, request
      // `limit + 1` rows from the OGC helper (the lookahead row) so the
      // adapter can stamp `exceededTransferLimit: true` when more records
      // exist. Mirrors the GeoServices `withPagingBounds` + `applyQueryAllLimit`
      // pattern so `queryAll({ pagination: { limit } })` has the same
      // contract across protocols.
      const ogcRequest = toOgcRequest(request);
      if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
        ogcRequest.limit = limit + 1;
      }
      const all = await collection.itemsAll(withUnboundedMaxPages(ogcRequest));
      const typed = all.map(toTypedFeatureFromOgc<T>);
      const { features, exceededTransferLimit } = applyQueryAllLimit(typed, limit);
      return {
        features,
        exceededTransferLimit,
        totalCount: features.length,
      } satisfies Result<T>;
    },
    async queryAggregate(request) {
      // Always client-side (OGC has no server-side aggregation). Under `strict`
      // the descriptor must advertise `queryAggregate`; under `degraded` the
      // fallback runs unconditionally.
      ensureCapabilityOrFallback(descriptor, caps, "queryAggregate", policy);
      const all = await collection.itemsAll(withUnboundedMaxPages(toOgcMaterializedRequest(request)));
      const features = all.map(toTypedFeatureFromOgc<T>);
      return {
        features,
        exceededTransferLimit: false,
        totalCount: features.length,
        aggregateRows: clientSideAggregate(features, request.aggregation),
        degraded: [
          {
            capability: "queryAggregate",
            reason: "OGC API Features aggregation evaluated client-side over the materialized result set.",
            protocol: "ogc-features",
            sourceId: descriptor.id,
          },
        ],
      } satisfies Result<T>;
    },
    async queryExtent(request) {
      ensureCapabilityOrFallback(descriptor, caps, "queryExtent", policy);
      // Collection-wide extent (no filters): the metadata bbox is accurate
      // and avoids draining items. A filtered request must be computed
      // client-side — the collection bbox would over-report the matching
      // subset's extent. `outSr` also forces the items path so the extent
      // is expressed in the caller's requested CRS; the metadata bbox is
      // frozen in the collection's native CRS (typically CRS84) and would
      // silently mislead `queryExtent({ outSr: 3857 })` callers.
      if (!hasExtentFilter(request) && request?.outSr === undefined) {
        const meta = await collection.metadata();
        const bbox = meta.extent?.spatial?.bbox?.[0];
        if (!bbox || bbox.length < 4) return { extent: null };
        const [xmin, ymin, xmax, ymax] = bbox;
        return { extent: { xmin, ymin, xmax, ymax } };
      }
      const all = await collection.itemsAll(withUnboundedMaxPages(toOgcMaterializedRequest(request)));
      return computeExtentFromOgcFeatures(all);
    },
    async *stream(request) {
      ensureCapability(descriptor, caps, "stream");
      const stream = collection.itemsStream(withUnboundedMaxPages(toOgcRequest(request)));
      for await (const page of stream) {
        yield {
          features: page.map(toTypedFeatureFromOgc<T>),
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, caps, "queryObjectIds");
      // OGC `/items` does not expose a server-side ids-only mode; drain the
      // matching set and project the GeoJSON `id`. Callers that need a
      // bounded scan should pass `pagination.limit`.
      const all = await collection.itemsAll(withUnboundedMaxPages(toOgcRequest(request)));
      const ids: FeatureId[] = [];
      for (const feature of all) {
        if (feature.id !== undefined && feature.id !== null) {
          ids.push(feature.id as FeatureId);
        }
      }
      return ids;
    },
    async applyEdits(envelope) {
      ensureCapability(descriptor, caps, "applyEdits");
      const added: EditOutcome[] = [];
      const updated: EditOutcome[] = [];
      const deleted: EditOutcome[] = [];
      // OGC has no batch edit endpoint; edits fan out to per-item
      // createItem / replaceItem / deleteItem. The canonical envelope's
      // signal aborts every remaining request as soon as the caller
      // cancels — each item call passes the same signal through.
      const { signal } = envelope;

      for (const add of envelope.adds ?? []) {
        try {
          const created = await collection.createItem({
            feature: featureToGeoJsonFeature(add),
            ...(signal ? { signal } : {}),
          });
          added.push({ id: created.id as FeatureId | undefined, success: true });
        } catch (err) {
          added.push({ success: false, error: editErrorFromCatch(err) });
        }
      }
      for (const update of envelope.updates ?? []) {
        if (update.id === undefined || update.id === null) {
          updated.push({ success: false, error: { code: 400, description: "update.id is required" } });
          continue;
        }
        try {
          await collection.replaceItem({
            featureId: update.id,
            feature: featureToGeoJsonFeature(update),
            ...(signal ? { signal } : {}),
          });
          updated.push({ id: update.id, success: true });
        } catch (err) {
          updated.push({ id: update.id, success: false, error: editErrorFromCatch(err) });
        }
      }
      for (const id of envelope.deletes ?? []) {
        try {
          await collection.deleteItem({ featureId: id, ...(signal ? { signal } : {}) });
          deleted.push({ id, success: true });
        } catch (err) {
          deleted.push({ id, success: false, error: editErrorFromCatch(err) });
        }
      }

      return { added, updated, deleted } satisfies EditResult;
    },
    async queryRelated() {
      // OGC API Features has no related-records concept; refuse rather than
      // silently return empty groups.
      throw new HonuaCapabilityNotSupportedError("queryRelated", descriptor.protocol, descriptor.id);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

// ── GeoServices Image Service ────────────────────────────────

/**
 * Build a `Source` over an Esri-style ImageServer endpoint. The query
 * surface drives the raster catalog (each row is a raster with footprint
 * geometry); image export, identify, and tile operations live behind
 * `Source.protocol("geoservices-image-service")`.
 *
 * @example
 * ```ts
 * const dataset = createDataset({
 *   id: "imagery",
 *   client,
 *   sources: [{
 *     id: "naip",
 *     protocol: "geoservices-image-service",
 *     locator: { url: "https://your-honua-server.example", serviceId: "naip" },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-image-service"],
 *   }],
 * });
 * const img = dataset.source("naip")!.protocol("geoservices-image-service");
 * const png = await img?.exportImage({ bbox: [-158.5, 21.2, -157.6, 21.7], size: [512, 512] });
 * ```
 */
export function geoServicesImageSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { serviceId } = requireImageServiceLocator(descriptor);
  const service = new HonuaImageService({ client, serviceId });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["geoservices-image-service"];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "geoservices-image-service": service,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      requireImageServerCompatibleQuery(request);
      // ImageServer query returns the raster catalog. The GeoServices
      // request shape is identical to FeatureServer query so we reuse
      // `toFeatureLayerRequest` and dispatch through the service.
      const response = await service.queryRasterCatalog(toFeatureLayerRequest(request));
      return featureLayerResultFromUntyped<T>(response);
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      requireImageServerCompatibleQuery(request);
      const baseParams = toFeatureLayerRequest(request);
      const limit = request?.pagination?.limit;
      // ImageServer's catalog endpoint supports `resultOffset`/`resultRecordCount`
      // but the wrapper does not expose a `queryAllRasterCatalog` helper, so
      // drain pages here. Mirror `withPagingBounds` + `applyQueryAllLimit` so
      // an empty/short page or a `limit + 1` lookahead row stops the loop and
      // stamps `exceededTransferLimit` correctly.
      const startingOffset = typeof baseParams.resultOffset === "number" ? baseParams.resultOffset : 0;
      const pageSize =
        typeof limit === "number" && limit > 0
          ? Math.max(1, Math.min(limit, 2000))
          : typeof baseParams.resultRecordCount === "number" && baseParams.resultRecordCount > 0
            ? baseParams.resultRecordCount
            : 2000;
      const collected: import("../core/types.js").HonuaFeature[] = [];
      let lastFields: import("../core/types.js").HonuaFieldInfo[] | undefined;
      const target = typeof limit === "number" && limit >= 0 ? limit + 1 : Number.POSITIVE_INFINITY;
      for (let page = 0; ; page += 1) {
        const response = await service.queryRasterCatalog({
          ...baseParams,
          resultOffset: startingOffset + page * pageSize,
          resultRecordCount: pageSize,
        });
        if (response.fields) lastFields = response.fields;
        const pageFeatures = response.features ?? [];
        for (const feature of pageFeatures) {
          collected.push(feature);
          if (collected.length >= target) break;
        }
        if (collected.length >= target) break;
        if (pageFeatures.length < pageSize) break;
      }
      const typed = collected.map(toTypedFeature<T>);
      const { features: bounded, exceededTransferLimit } = applyQueryAllLimit(typed, limit);
      return {
        features: bounded,
        exceededTransferLimit,
        totalCount: bounded.length,
        ...(lastFields ? { fields: lastFields } : {}),
      } satisfies Result<T>;
    },
    async queryAggregate() {
      throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
    },
    async queryExtent(request) {
      ensureCapability(descriptor, caps, "queryExtent");
      requireImageServerCompatibleQuery(request);
      const response = await service.queryRasterCatalog(toExtentOnlyRequest(toFeatureLayerRequest(request)));
      return extractExtentEnvelope(response);
    },
    // biome-ignore lint/correctness/useYield: ImageServer has no streaming raster-catalog mode; this generator refuses iteration rather than silently emit a single page
    async *stream() {
      throw new HonuaCapabilityNotSupportedError("stream", descriptor.protocol, descriptor.id);
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, caps, "queryObjectIds");
      requireImageServerCompatibleQuery(request);
      return service.queryRasterCatalogObjectIds(toFeatureLayerRequest(request));
    },
    async applyEdits() {
      throw new HonuaCapabilityNotSupportedError("applyEdits", descriptor.protocol, descriptor.id);
    },
    async queryRelated() {
      throw new HonuaCapabilityNotSupportedError("queryRelated", descriptor.protocol, descriptor.id);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

// ── GeoServices Geometry Service ─────────────────────────────

/**
 * Build a `Source` over an Esri-style Geometry Service endpoint. Geometry
 * Service is a stateless utility — it does not host features — so the
 * query family throws `HonuaCapabilityNotSupportedError` and operations
 * (buffer, project, simplify, etc.) live behind
 * `Source.protocol("geoservices-geometry-service")`.
 *
 * @example
 * ```ts
 * const geom = dataset.source("geom")!.protocol("geoservices-geometry-service");
 * const projected = await geom?.project({
 *   inSr: 4326,
 *   outSr: 3857,
 *   geometries: [{ x: -158, y: 21 }],
 * });
 * ```
 */
export function geoServicesGeometryServiceSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const service = new HonuaGeometryService({ client });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["geoservices-geometry-service"];
  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "geoservices-geometry-service": service,
  };
  return makeSource<T>(descriptor, caps, policy, adapterRegistry, unsupportedFeatureSurface<T>(descriptor));
}

// ── GeoServices GP Service ───────────────────────────────────

/**
 * Build a `Source` over an Esri-style GP (geoprocessing) service. GP
 * services run async tasks rather than hosting features; the canonical
 * feature surface throws and task submission / status / result lookup
 * live behind `Source.protocol("geoservices-gp-service")`.
 *
 * @example
 * ```ts
 * const gp = dataset.source("buffer-task")!.protocol("geoservices-gp-service");
 * const job = await gp!.submitJob({ inputs: { distance: 500 } });
 * const result = await gp!.awaitJobResult(job.jobId);
 * ```
 */
export function geoServicesGPServiceSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["geoservices-gp-service"];
  const { serviceId, taskName } = requireGPServiceLocator(descriptor, caps);
  const service = new HonuaGeoprocessingService({
    client,
    serviceId,
    taskName,
  });
  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "geoservices-gp-service": service,
  };
  return makeSource<T>(descriptor, caps, policy, adapterRegistry, unsupportedFeatureSurface<T>(descriptor));
}

// ── OGC API Tiles ─────────────────────────────────────────────

/**
 * Render-only Source adapter for OGC API Tiles. The query family throws
 * `HonuaCapabilityNotSupportedError` (the conformance class is
 * tile-fetch, not feature-query); rendering integrations consume the
 * tileset through `Source.protocol("ogc-tiles")` to reach the underlying
 * runtime class.
 *
 * @example
 * ```ts
 * const tiles = dataset.source("ogc-tileset")!.protocol("ogc-tiles");
 * const bytes = await tiles!.tile({ tileMatrix: "WebMercatorQuad", tileRow: 5, tileCol: 8 });
 * ```
 */
export function ogcTilesSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { collectionId, tileMatrixSetId } = requireOgcTilesLocator(descriptor);
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"];
  const basePath = descriptor.locator.basePath;

  // Descriptors without a tileMatrixSetId cannot construct a usable
  // HonuaOgcTileset (every tile route requires `tileMatrixSetId`). Expose
  // the root HonuaOgcTiles adapter instead so callers can discover the
  // tilesets the server advertises for the collection before binding one.
  // A `connect()`-discovered third-party root threads its basePath so tile
  // routes resolve against the advertised layout, not the `/ogc/tiles` facade.
  const adapter =
    tileMatrixSetId !== undefined && tileMatrixSetId !== ""
      ? new HonuaOgcTileset({ client, collectionId, tileMatrixSetId, ...(basePath !== undefined ? { basePath } : {}) })
      : new HonuaOgcTiles({ client, ...(basePath !== undefined ? { basePath } : {}) });

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "ogc-tiles": adapter,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, unsupportedFeatureSurface<T>(descriptor));
}

// ── PMTiles archive ───────────────────────────────────────────

/**
 * Tiles-only Source adapter for a PMTiles archive (`protocol: "pmtiles"`).
 *
 * PMTiles archives are immutable single-file tile stores, so the canonical
 * query family throws `HonuaCapabilityNotSupportedError` (there is no
 * feature-query surface on an archive). Archive metadata — bounds, min/max
 * zoom, and vector layer names — is inspected through the typed escape hatch:
 * `Source.protocol("pmtiles").describe()`. Rendering integrations register the
 * `pmtiles://` protocol on the map (see `@honua/sdk-js/runtime`) and reference
 * the archive as a MapLibre source `url`.
 *
 * `locator.url` may carry a leading `pmtiles://` scheme (the MapLibre form) or
 * be a bare archive URL; both resolve to the same archive.
 *
 * This builds the escape-hatch adapter through {@link pmtilesProtocolModule}
 * (issue #538) rather than constructing `HonuaPmtilesArchive` directly, so
 * the built-in wiring runs the same public `ProtocolModule` seam a module
 * registered through `HonuaPluginRegistry` uses
 * (`pmtilesProtocolPlugin`, `@honua/sdk-js/plugin`).
 *
 * @example
 * ```ts
 * const archive = dataset.source("basemap")!.protocol("pmtiles");
 * const info = await archive!.describe();
 * console.log(info.bounds, info.vectorLayers.map((layer) => layer.id));
 * ```
 */
export function pmtilesSource<T>(
  descriptor: SourceDescriptor,
  _client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const discovered = pmtilesProtocolModule().discover(descriptor);
  if (discovered instanceof Promise) {
    // PMTiles discovery is always synchronous (the reader opens lazily on the
    // handle's own first `describe()` call); a module that started returning
    // a promise would be a breaking change to this built-in's own contract.
    throw new Error("pmtiles: built-in source construction requires synchronous protocol-module discovery");
  }

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    pmtiles: discovered.adapter,
  };

  return makeSource<T>(
    descriptor,
    discovered.capabilities,
    policy,
    adapterRegistry,
    unsupportedFeatureSurface<T>(descriptor),
  );
}

// ── OGC API Maps ──────────────────────────────────────────────

/**
 * Render-only Source adapter for OGC API Maps. Same shape as the Tiles
 * adapter — `Source.protocol("ogc-maps")` exposes the runtime class for
 * server-rendered map images; the canonical query family throws.
 *
 * @example
 * ```ts
 * const maps = dataset.source("ogc-map")!.protocol("ogc-maps");
 * const png = await maps!.map({ bbox: [-158, 21, -157, 22], width: 512, height: 512 });
 * ```
 */
export function ogcMapsSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const basePath = descriptor.locator.basePath;
  // A `connect()`-discovered third-party root threads its basePath so render
  // routes resolve against the advertised layout, not the `/ogc/maps` facade.
  const root = new HonuaOgcMaps({ client, ...(basePath !== undefined ? { basePath } : {}) });
  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {};
  if (descriptor.locator.collectionId !== undefined) {
    adapterRegistry["ogc-maps"] = new HonuaOgcCollectionMap({
      client,
      collectionId: descriptor.locator.collectionId,
      styleId: descriptor.locator.styleId,
      ...(basePath !== undefined ? { basePath } : {}),
    });
  } else {
    adapterRegistry["ogc-maps"] = root;
  }
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["ogc-maps"];

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, unsupportedFeatureSurface<T>(descriptor));
}

// ── OGC API Records ───────────────────────────────────────────

/**
 * Metadata-catalog Source adapter for OGC API Records. The canonical query
 * family searches one catalog (`locator.collectionId`, the Records
 * collection/catalog id) and returns record documents as typed features.
 * Records-specific search affordances (`q`, `type`, `externalIds`,
 * `profile`, raw HTML/JSON access) live on `Source.protocol("ogc-records")`.
 *
 * @example
 * ```ts
 * const records = dataset.source("catalog")!;
 * const result = await records.query({ pagination: { limit: 100 } });
 * ```
 */
export function ogcRecordsSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { collectionId } = requireOgcRecordsLocator(descriptor);
  const basePath = descriptor.locator.basePath;
  const collection = new HonuaOgcRecordCollection({
    client,
    collectionId,
    ...(basePath !== undefined ? { basePath } : {}),
  });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["ogc-records"];

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "ogc-records": collection,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      if (request?.aggregation) {
        throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
      }
      const response = await collection.search(toOgcRecordsRequest(request));
      const features = (response.features ?? []).map(toTypedFeatureFromOgcRecord<T>);
      const totalCount = response.numberMatched;
      return {
        features,
        exceededTransferLimit: totalCount !== undefined && features.length < totalCount,
        ...(totalCount !== undefined ? { totalCount } : {}),
      } satisfies Result<T>;
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      const limit = request?.pagination?.limit;
      const records = await collection.searchAll({
        ...toOgcRecordsRequest(request),
        ...withPagingBounds({}, limit),
      });
      const typed = records.map(toTypedFeatureFromOgcRecord<T>);
      const { features, exceededTransferLimit } = applyQueryAllLimit(typed, limit);
      return {
        features,
        exceededTransferLimit,
        totalCount: features.length,
      } satisfies Result<T>;
    },
    async queryAggregate() {
      throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
    },
    async queryExtent() {
      throw new HonuaCapabilityNotSupportedError("queryExtent", descriptor.protocol, descriptor.id);
    },
    async *stream(request) {
      ensureCapability(descriptor, caps, "stream");
      const limit = request?.pagination?.limit;
      const stream = collection.searchStream({
        ...toOgcRecordsRequest(request),
        pageSize: limit !== undefined ? Math.max(1, limit) : undefined,
        maxPages: Number.MAX_SAFE_INTEGER,
      });
      for await (const page of stream) {
        yield {
          features: page.map(toTypedFeatureFromOgcRecord<T>),
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, caps, "queryObjectIds");
      const limit = request?.pagination?.limit;
      const records = await collection.searchAll({
        ...toOgcRecordsRequest(request),
        ...withPagingBounds({}, limit),
      });
      const ids: FeatureId[] = [];
      for (const record of records) {
        if (record.id !== undefined && record.id !== null) {
          ids.push(record.id as FeatureId);
        }
      }
      if (typeof limit === "number" && limit >= 0 && ids.length > limit) {
        return ids.slice(0, limit);
      }
      return ids;
    },
    async applyEdits() {
      throw new HonuaCapabilityNotSupportedError("applyEdits", descriptor.protocol, descriptor.id);
    },
    async queryRelated() {
      throw new HonuaCapabilityNotSupportedError("queryRelated", descriptor.protocol, descriptor.id);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

// ── WMS 1.3 ───────────────────────────────────────────────────

/**
 * `Source` adapter for first-party WMS 1.3.0 services. The render path
 * routes through `HonuaWms` / `HonuaWmsLayer` (both of which sit
 * behind the canonical `Source.protocol("wms" | "wms-layer")` escape
 * hatch); `Source.query()` translates a point spatial filter into a
 * `GetFeatureInfo` call. Non-point queries throw
 * `HonuaCapabilityNotSupportedError` so the canonical query envelope
 * stays honest — multi-pixel feature info lives on
 * `Source.protocol("wms").featureInfo()`.
 */
/**
 * Adapter factory for a WMS 1.3.0 endpoint.
 *
 * The canonical `Source.query()` is implemented through point-only
 * `GetFeatureInfo`. Reach `Source.protocol("wms")` for raw `GetMap` /
 * `GetLegendGraphic` access (with TIME / ELEVATION dimension handling and
 * CRS axis-order swap per WMS 1.3 §6.7.3.2).
 *
 * @example
 * ```ts
 * const wms = dataset.source("usgs-imagery")!.protocol("wms");
 * const png = await wms!.getMap({
 *   layers: ["topo"], bbox: [-158, 21, -157, 22], crs: "EPSG:4326",
 *   width: 512, height: 512,
 * });
 * ```
 */
export function wmsSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const advertisedCaps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.wms;
  if (typeof descriptor.locator.serviceId !== "string" || descriptor.locator.serviceId.length === 0) {
    if (descriptor.locator.raster?.kind !== "wms-kvp") requireWmsLocator(descriptor);
    // Raw third-party discovery is renderable through the existing descriptor
    // → MapLibre raster projection. The existing canonical FeatureInfo adapter
    // is Honua-service-id based, so keep that surface fail-closed here.
    const caps = new Set([...advertisedCaps].filter((capability) => capability !== "query"));
    descriptor = { ...descriptor, capabilities: caps };
    return makeSource<T>(descriptor, caps, policy, {}, unsupportedFeatureSurface<T>(descriptor));
  }
  const { serviceId } = requireWmsLocator(descriptor);
  const layerName = descriptor.locator.typeName;
  const styleId = descriptor.locator.styleId;
  const root = new HonuaWms({ client, serviceId });
  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = { wms: root };
  // `HonuaWmsLayer` is a single-layer handle (its `describe()` resolves
  // exactly one `<Layer>` from the parsed Capabilities). Multi-layer
  // composites (`LAYERS=a,b`) must stay on the service-level `wms`
  // handle and use `featureInfo()` directly; registering them as a
  // `wms-layer` would silently mis-route `describe()` / `stylesIn()` /
  // `legend()` to a single layer name that does not exist on the wire.
  const parsedLayers = parseWmsLayerNames(layerName);
  if (parsedLayers.length === 1) {
    const layerOpts: { client: HonuaClient; serviceId: string; layerName: string; defaultStyleId?: string } = {
      client,
      serviceId,
      layerName: parsedLayers[0]!,
    };
    if (typeof styleId === "string") layerOpts.defaultStyleId = styleId;
    adapterRegistry["wms-layer"] = new HonuaWmsLayer(layerOpts);
  }
  const caps = advertisedCaps;

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      requireWmsCompatibleQuery(descriptor, request);
      const layers = wmsRequireLayers(descriptor, layerName);
      const { x: px, y: py, crs } = wmsExtractPointFromQuery(request, descriptor);
      const bboxRadius = 0.0001; // tiny envelope around the point keeps the request a 1×1 image.
      const widthHeight = 1;
      const featureCount = request?.pagination?.limit;
      const response = await client.getWmsFeatureInfo<T>({
        serviceId,
        layers,
        ...(styleId !== undefined ? { styles: [styleId] } : {}),
        queryLayers: layers,
        crs,
        bbox: [px - bboxRadius, py - bboxRadius, px + bboxRadius, py + bboxRadius],
        width: widthHeight,
        height: widthHeight,
        i: 0,
        j: 0,
        infoFormat: "application/json",
        ...(featureCount !== undefined ? { featureCount } : {}),
        ...(request?.signal ? { signal: request.signal } : {}),
      });
      return {
        features: response.features ?? [],
        exceededTransferLimit: false,
      } satisfies Result<T>;
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      // GetFeatureInfo returns a single response set; queryAll degenerates
      // to query() because there is no paging on the wire.
      const result = await this.query(request);
      return result;
    },
    async queryAggregate() {
      throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
    },
    async queryExtent() {
      throw new HonuaCapabilityNotSupportedError("queryExtent", descriptor.protocol, descriptor.id);
    },
    // biome-ignore lint/correctness/useYield: WMS exposes only single-shot GetFeatureInfo, which is delivered through query()
    async *stream() {
      throw new HonuaCapabilityNotSupportedError("stream", descriptor.protocol, descriptor.id);
    },
    async queryObjectIds() {
      throw new HonuaCapabilityNotSupportedError("queryObjectIds", descriptor.protocol, descriptor.id);
    },
    async applyEdits() {
      throw new HonuaCapabilityNotSupportedError("applyEdits", descriptor.protocol, descriptor.id);
    },
    async queryRelated() {
      throw new HonuaCapabilityNotSupportedError("queryRelated", descriptor.protocol, descriptor.id);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

// ── WMTS 1.0 ──────────────────────────────────────────────────

/**
 * Render-only `Source` adapter for first-party WMTS 1.0.0 services.
 * `Source.query()` throws because WMTS GetFeatureInfo is keyed on tile
 * pixels (not a canonical spatial filter); raw access lives on
 * `Source.protocol("wmts" | "wmts-layer" | "wmts-tileset")`.
 */
/**
 * Adapter factory for a WMTS 1.0.0 endpoint. Render-only; `Source.query()`
 * throws `HonuaCapabilityNotSupportedError`. Reach `Source.protocol("wmts")`
 * for RESTful + KVP tile fetch and capabilities.
 *
 * @example
 * ```ts
 * const wmts = dataset.source("basemap-tiles")!.protocol("wmts");
 * const tile = await wmts!.tile({ tileMatrixSet: "WebMercatorQuad", tileMatrix: "8", tileRow: 5, tileCol: 8 });
 * ```
 */
export function wmtsSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.wmts;
  if (typeof descriptor.locator.serviceId !== "string" || descriptor.locator.serviceId.length === 0) {
    if (descriptor.locator.raster?.kind !== "wmts-kvp" && descriptor.locator.raster?.kind !== "wmts-template") {
      requireWmtsLocator(descriptor);
    }
    // Raw WMTS sources use the validated descriptor binding in the existing
    // MapLibre projection; no second protocol wire adapter is introduced.
    return makeSource<T>(descriptor, caps, policy, {}, unsupportedFeatureSurface<T>(descriptor));
  }
  const { serviceId } = requireWmtsLocator(descriptor);
  const layerName = descriptor.locator.typeName;
  const tileMatrixSetId = descriptor.locator.tileMatrixSetId ?? "WebMercatorQuad";
  const styleId = descriptor.locator.styleId ?? "default";
  const root = new HonuaWmts({ client, serviceId });
  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = { wmts: root };
  if (typeof layerName === "string" && layerName.length > 0) {
    adapterRegistry["wmts-layer"] = new HonuaWmtsLayer({
      client,
      serviceId,
      layerName,
      defaultStyleId: styleId,
      defaultTileMatrixSetId: tileMatrixSetId,
    });
    adapterRegistry["wmts-tileset"] = new HonuaWmtsTileset({
      client,
      serviceId,
      layerName,
      styleId,
      tileMatrixSetId,
    });
  }
  return makeSource<T>(descriptor, caps, policy, adapterRegistry, unsupportedFeatureSurface<T>(descriptor));
}

// ── STAC API ──────────────────────────────────────────────────

/**
 * Adapter factory for a STAC API search endpoint.
 *
 * The canonical `Source.query()` runs a `POST /search` against the STAC root,
 * with `Query.spatialFilter` (e.g. an `envelope(...)` bounding box) translated
 * into STAC's `bbox` parameter. The deprecated source-native `Query.where`
 * migration member maps to STAC `datetime` / `filter` parameters.
 *
 * @example
 * ```ts
 * import { envelope } from "@honua/sdk-js";
 *
 * const dataset = createDataset({
 *   id: "imagery",
 *   client,
 *   sources: [{
 *     id: "stac-search",
 *     protocol: "stac",
 *     locator: { url: "https://your-honua-server.example/stac" },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
 *   }],
 * });
 * const result = await dataset.source("stac-search")!.query({
 *   spatialFilter: envelope(-158.5, 21.2, -157.6, 21.7),
 *   pagination: { limit: 100 },
 * });
 * ```
 */
export function stacSearchSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  // Endpoint-layout selection. `stac-api` treats `locator.url` as a raw STAC
  // API root (search / collections mounted directly under it) rather than the
  // Honua `/stac` facade. `stac-static` reads a static catalog.json tree with
  // no search endpoint. Omitted / `honua-facade` keeps the `/stac` facade.
  const layout = descriptor.locator.layout;
  const stacBasePath = layout === "stac-api" ? "" : undefined;
  const stac = new HonuaStacSearch({ client, ...(stacBasePath !== undefined ? { basePath: stacBasePath } : {}) });
  const staticCatalog =
    layout === "stac-static"
      ? new HonuaStacStaticCatalog(client, descriptor.locator.url, descriptor.locator.stacStatic)
      : undefined;
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.stac;
  const collectionScope = descriptor.locator.collectionId;
  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    stac,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      if (request?.aggregation) {
        throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
      }
      const stacRequest = toStacRequest(request, collectionScope);
      const response = staticCatalog
        ? await staticCatalog.search(toStacStaticParams(stacRequest))
        : await stac.search(stacRequest);
      const features = (response.features ?? []).map(toTypedFeatureFromStac<T>);
      const totalCount = response.numberMatched ?? response.context?.matched;
      const exceededTransferLimit = totalCount !== undefined && features.length < totalCount;
      return {
        features,
        exceededTransferLimit,
        totalCount,
      } satisfies Result<T>;
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      const limit = request?.pagination?.limit;
      if (staticCatalog) {
        const response = await staticCatalog.search(toStacStaticParams(toStacRequest(request, collectionScope)));
        const typed = (response.features ?? []).map(toTypedFeatureFromStac<T>);
        const { features, exceededTransferLimit } = applyQueryAllLimit(typed, limit);
        return { features, exceededTransferLimit, totalCount: features.length } satisfies Result<T>;
      }
      const items = await stac.searchAll({
        ...toStacRequest(request, collectionScope),
        ...withPagingBounds({}, limit),
      });
      const typed = items.map(toTypedFeatureFromStac<T>);
      const { features, exceededTransferLimit } = applyQueryAllLimit(typed, limit);
      return {
        features,
        exceededTransferLimit,
        totalCount: features.length,
      } satisfies Result<T>;
    },
    async queryAggregate() {
      throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
    },
    async queryExtent() {
      throw new HonuaCapabilityNotSupportedError("queryExtent", descriptor.protocol, descriptor.id);
    },
    async *stream(request) {
      ensureCapability(descriptor, caps, "stream");
      const limit = request?.pagination?.limit;
      if (staticCatalog) {
        // A static catalog has no server-side paging; yield the whole
        // filtered set as one page.
        const response = await staticCatalog.search(toStacStaticParams(toStacRequest(request, collectionScope)));
        yield {
          features: (response.features ?? []).map(toTypedFeatureFromStac<T>),
          exceededTransferLimit: false,
        } satisfies Result<T>;
        return;
      }
      const stream = stac.searchStream({
        ...toStacRequest(request, collectionScope),
        pageSize: limit !== undefined ? Math.max(1, limit) : undefined,
        maxPages: Number.MAX_SAFE_INTEGER,
      });
      for await (const page of stream) {
        yield {
          features: page.map(toTypedFeatureFromStac<T>),
          exceededTransferLimit: false,
        } satisfies Result<T>;
      }
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, caps, "queryObjectIds");
      // STAC `/search` does not expose a server-side ids-only mode; drain
      // the matching items and project the GeoJSON `id`. `pagination.limit`
      // routes through `withPagingBounds` so the underlying searchAll
      // fetches at most `limit + 1` rows, never a full-catalog scan.
      const limit = request?.pagination?.limit;
      const items = staticCatalog
        ? ((await staticCatalog.search(toStacStaticParams(toStacRequest(request, collectionScope)))).features ?? [])
        : await stac.searchAll({
            ...toStacRequest(request, collectionScope),
            ...withPagingBounds({}, limit),
          });
      const ids: FeatureId[] = [];
      for (const item of items) {
        if (item.id !== undefined && item.id !== null) {
          ids.push(item.id as FeatureId);
        }
      }
      if (typeof limit === "number" && limit >= 0 && ids.length > limit) {
        return ids.slice(0, limit);
      }
      return ids;
    },
    async applyEdits() {
      throw new HonuaCapabilityNotSupportedError("applyEdits", descriptor.protocol, descriptor.id);
    },
    async queryRelated() {
      throw new HonuaCapabilityNotSupportedError("queryRelated", descriptor.protocol, descriptor.id);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

// ── WFS 2.0 ───────────────────────────────────────────────────

/**
 * Threshold above which the WFS adapter switches to POST GetFeature with a
 * `<fes:Filter>` body. URL budget under 7000 chars stays GET-friendly; longer
 * filters are routed through POST so we do not stress middleboxes that
 * trim long query strings. The threshold is intentionally a single
 * constant we can revise after telemetry lands.
 */
const WFS_GET_FILTER_BUDGET = 7000;

const DEFAULT_WFS_GEOMETRY_PROPERTY = "the_geom";

/**
 * Adapter factory for a WFS 2.0 endpoint.
 *
 * `Query.spatialFilter` and the deprecated source-native `Query.where`
 * migration member compile to FES 2.0; GeoJSON is preferred over GML via
 * `OperationsMetadata` negotiation. `applyEdits()` builds
 * `<wfs:Transaction>` bodies. Reach `Source.protocol("wfs")` for raw GML /
 * `LockFeature` / stored-query access.
 *
 * @example
 * ```ts
 * const dataset = createDataset({
 *   id: "wfs-parcels",
 *   client,
 *   sources: [{
 *     id: "parcels",
 *     protocol: "wfs",
 *     locator: { url: "https://your-honua-server.example/wfs", typeName: "ns:Parcels" },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
 *   }],
 * });
 * const result = await dataset.source("parcels")!.queryAll({
 *   pagination: { limit: 500 },
 * });
 * ```
 */
export function wfsSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { url, typeName, featureNamespace, srsName: wfsSrsName } = requireWfsLocator(descriptor);
  const root = client.wfs(url);
  const featureType = new HonuaWfsFeatureType({ root, typeName });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.wfs;
  void policy;

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    wfs: featureType,
  };

  /**
   * Negotiated output format cache. Populated lazily on the first
   * capability-gated call so a no-op `createDataset({ sources: [...wfs] })`
   * does not issue network traffic.
   */
  let cachedFormat: OutputFormatChoice | undefined;
  async function negotiateJsonOrThrow(): Promise<OutputFormatChoice> {
    if (cachedFormat) return cachedFormat;
    const snapshot = await root.capabilities();
    const choice = root.negotiateOutputFormat(snapshot);
    if (!choice) {
      throw new HonuaCapabilityNotSupportedError("query", descriptor.protocol, descriptor.id);
    }
    if (choice.kind !== "json") {
      throw new HonuaCapabilityNotSupportedError(
        "query",
        descriptor.protocol,
        `${descriptor.id} (server advertises only ${choice.format}; reach raw GML through Source.protocol("wfs"))`,
      );
    }
    cachedFormat = choice;
    return choice;
  }

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, caps, "query");
      if (request?.aggregation) {
        // WFS 2.0 has no server-side aggregation; refuse rather than ship a
        // silent partial result.
        throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
      }
      // `pagination.limit === 0` is an explicit zero cap, not "unbounded";
      // short-circuit before the wire call so we do not silently widen to the
      // server's default page size.
      if (request?.pagination?.limit === 0) {
        return { features: [], exceededTransferLimit: false } satisfies Result<T>;
      }
      const choice = await negotiateJsonOrThrow();
      const json = await runGetFeatureJson(featureType, typeName, choice, request, request?.pagination?.limit);
      return resultFromGeoJson<T>(json);
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      const choice = await negotiateJsonOrThrow();
      const limit = request?.pagination?.limit;
      const target = typeof limit === "number" && limit >= 0 ? limit + 1 : Number.POSITIVE_INFINITY;
      const collected: HonuaTypedFeature<T>[] = [];
      let totalCount: number | undefined;
      let offset = request?.pagination?.offset ?? 0;
      // Mirror `withPagingBounds`: a finite limit (including 0) sets the
      // lookahead page size to `limit + 1` so we can stamp
      // `exceededTransferLimit` without overfetching a full default page.
      const pageSize = typeof limit === "number" && limit >= 0 ? Math.max(1, Math.min(limit + 1, 2000)) : 2000;
      while (collected.length < target) {
        const pageRequest: Query<T> = {
          ...(request ?? {}),
          pagination: { offset, limit: pageSize },
        };
        const json = await runGetFeatureJson(featureType, typeName, choice, pageRequest, pageSize);
        const result = resultFromGeoJson<T>(json);
        if (result.totalCount !== undefined) totalCount = result.totalCount;
        collected.push(...result.features);
        if (result.features.length < pageSize) break;
        offset += result.features.length;
      }
      const { features, exceededTransferLimit } = applyQueryAllLimit(collected, limit);
      return {
        features,
        exceededTransferLimit,
        totalCount: totalCount ?? features.length,
      } satisfies Result<T>;
    },
    async queryAggregate() {
      throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
    },
    async queryExtent(request) {
      ensureCapability(descriptor, caps, "queryExtent");
      // Unfiltered queryExtent: prefer the per-feature-type WGS84BoundingBox
      // from GetCapabilities so we avoid an extra HTTP request entirely.
      if (!hasExtentFilter(request) && request?.outSr === undefined) {
        const snapshot = await root.capabilities();
        const ft = snapshot.featureTypes.find((entry) => entry.name === typeName);
        if (ft?.wgs84BoundingBox) {
          return { extent: { ...ft.wgs84BoundingBox } };
        }
      }
      // Filtered request: drain every matching page so the returned extent
      // covers all features the filter resolves to, not just the first
      // server-default page. Caller pagination is intentionally ignored —
      // queryExtent is a "what bbox holds the matching set" question.
      const choice = await negotiateJsonOrThrow();
      const drainPageSize = 2000;
      const extentRequest = toWfsExtentDrainRequest(request);
      let xmin = Number.POSITIVE_INFINITY;
      let ymin = Number.POSITIVE_INFINITY;
      let xmax = Number.NEGATIVE_INFINITY;
      let ymax = Number.NEGATIVE_INFINITY;
      let saw = false;
      let count = 0;
      let offset = 0;
      while (true) {
        const pageRequest: Query<T> = {
          ...extentRequest,
          pagination: { offset, limit: drainPageSize },
        };
        const json = await runGetFeatureJson(featureType, typeName, choice, pageRequest, drainPageSize);
        const page = computeExtentFromFeatureCollection(json);
        count += page.count;
        if (page.extent) {
          if (page.extent.xmin < xmin) xmin = page.extent.xmin;
          if (page.extent.ymin < ymin) ymin = page.extent.ymin;
          if (page.extent.xmax > xmax) xmax = page.extent.xmax;
          if (page.extent.ymax > ymax) ymax = page.extent.ymax;
          saw = true;
        }
        if (page.count < drainPageSize) break;
        offset += page.count;
      }
      return saw ? { extent: { xmin, ymin, xmax, ymax }, count } : { extent: null, count };
    },
    async *stream(request) {
      ensureCapability(descriptor, caps, "stream");
      // WFS 2.0 has no native streaming verb; iterate pages over GetFeature
      // and yield each as a Result. Reuses the same negotiation as `query`.
      const limit = request?.pagination?.limit;
      // `pagination.limit === 0` is an explicit zero cap; yield nothing
      // rather than silently fall back to the default 2000-row page size.
      if (limit === 0) return;
      const choice = await negotiateJsonOrThrow();
      const pageSize = typeof limit === "number" && limit > 0 ? Math.max(1, limit) : 2000;
      let offset = request?.pagination?.offset ?? 0;
      while (true) {
        const pageRequest: Query<T> = {
          ...(request ?? {}),
          pagination: { offset, limit: pageSize },
        };
        const json = await runGetFeatureJson(featureType, typeName, choice, pageRequest, pageSize);
        const result = resultFromGeoJson<T>(json);
        if (result.features.length === 0) break;
        yield {
          features: result.features,
          exceededTransferLimit: false,
        } satisfies Result<T>;
        if (result.features.length < pageSize) break;
        offset += result.features.length;
      }
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, caps, "queryObjectIds");
      // WFS does not expose a server-side ids-only mode that interoperates
      // across implementations; drain the matching set across pages and
      // project the GeoJSON `id`. `Query.pagination.limit` bounds the scan
      // as a global cap (not a per-page count) so callers can stop the drain
      // without learning the server's default page size. A finite limit
      // (including 0) is honored as a real cap; only `undefined` / negative
      // means "drain everything".
      const requestedLimit = request?.pagination?.limit;
      if (requestedLimit === 0) return [];
      const choice = await negotiateJsonOrThrow();
      const limitCap = typeof requestedLimit === "number" && requestedLimit > 0 ? requestedLimit : undefined;
      const drainPageSize = 2000;
      const ids: FeatureId[] = [];
      let offset = request?.pagination?.offset ?? 0;
      const idsRequest = toWfsObjectIdsDrainRequest(request);
      while (true) {
        const remainingCap = limitCap !== undefined ? Math.max(0, limitCap - ids.length) : undefined;
        if (remainingCap === 0) break;
        const pageSize = remainingCap !== undefined ? Math.min(drainPageSize, remainingCap) : drainPageSize;
        const pageRequest: Query<T> = {
          ...idsRequest,
          pagination: { offset, limit: pageSize },
        };
        const json = await runGetFeatureJson(featureType, typeName, choice, pageRequest, pageSize);
        const collection = json as { features?: ReadonlyArray<{ id?: unknown }> };
        const features = collection.features ?? [];
        for (const feature of features) {
          if (feature.id !== undefined && feature.id !== null) {
            ids.push(feature.id as FeatureId);
            if (limitCap !== undefined && ids.length >= limitCap) break;
          }
        }
        if (limitCap !== undefined && ids.length >= limitCap) break;
        if (features.length < pageSize) break;
        offset += features.length;
      }
      return ids;
    },
    async applyEdits(envelope) {
      ensureCapability(descriptor, caps, "applyEdits");
      // CanonicalFeature.id is required for updates because each <wfs:Update>
      // is filtered by `<fes:ResourceId>`; without an id the block would
      // mass-update every feature in the type. Mirror the OGC adapter's
      // per-item guard: push a failure outcome for each malformed update and
      // build the transaction with only the valid ones.
      const malformedUpdateIndices = new Set<number>();
      const validUpdates: Array<NonNullable<typeof envelope.updates>[number]> = [];
      for (const [idx, update] of (envelope.updates ?? []).entries()) {
        if (update.id === undefined || update.id === null) {
          malformedUpdateIndices.add(idx);
        } else {
          validUpdates.push(update);
        }
      }
      const adds = envelope.adds ?? [];
      const deletes = envelope.deletes ?? [];
      let summary: import("../core/wfs-capabilities.js").WfsTransactionSummary;
      if (adds.length === 0 && validUpdates.length === 0 && deletes.length === 0) {
        // Nothing to send — every operation was either absent or malformed.
        // Skip the wire round-trip entirely so the server never sees an
        // unaddressed transaction.
        summary = { totalInserted: 0, totalUpdated: 0, totalDeleted: 0, insertResults: [] };
      } else {
        // Ensure a caller-cache hit still resolves the advertised Transaction
        // POST URL before sending edits. Fresh connect discovery reuses this
        // same root, so the capabilities promise is already settled there.
        await root.capabilities(envelope.signal ? { signal: envelope.signal } : undefined);
        const filtered: EditEnvelope<T> = { ...envelope, updates: validUpdates };
        const body = buildTransactionBody(typeName, filtered, featureNamespace, wfsSrsName);
        const transactionOptions: { body: string; signal?: AbortSignal } = { body };
        if (envelope.signal) transactionOptions.signal = envelope.signal;
        summary = await featureType.transaction(transactionOptions);
      }
      return canonicalEditResultFromTransaction(envelope, summary, malformedUpdateIndices);
    },
    async queryRelated() {
      throw new HonuaCapabilityNotSupportedError("queryRelated", descriptor.protocol, descriptor.id);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

function requireWfsLocator(descriptor: SourceDescriptor): {
  url: string;
  typeName: string;
  featureNamespace: string | undefined;
  srsName: string | undefined;
} {
  const { url, typeName, featureNamespace, srsName } = descriptor.locator;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`createDataset: source "${descriptor.id}" (wfs) requires locator.url`);
  }
  if (typeof typeName !== "string" || typeName.length === 0) {
    throw new Error(`createDataset: source "${descriptor.id}" (wfs) requires locator.typeName`);
  }
  if (featureNamespace !== undefined && (typeof featureNamespace !== "string" || featureNamespace.length === 0)) {
    throw new Error(
      `createDataset: source "${descriptor.id}" (wfs) locator.featureNamespace must be a non-empty string`,
    );
  }
  return {
    url,
    typeName,
    featureNamespace: typeof featureNamespace === "string" ? featureNamespace : undefined,
    srsName: wfsSrsNameFromOutSr(srsName),
  };
}

function toWfsExtentDrainRequest<T>(request: Query<T> | undefined): Query<T> {
  // The drain computes a bbox over geometries, so a caller-supplied
  // `returnGeometry: false` would suppress geometry on every page and
  // leave the extent empty. Strip it alongside `outFields` and
  // `pagination` so the drain always sees the full geometry-bearing
  // response regardless of the caller's projection / paging / geometry
  // intent.
  const {
    outFields: _outFields,
    pagination: _pagination,
    returnGeometry: _returnGeometry,
    ...extentRequest
  } = request ?? {};
  void _outFields;
  void _pagination;
  void _returnGeometry;
  return extentRequest;
}

/**
 * `queryObjectIds` reads the GeoJSON `id` from each drained feature, so
 * neither `outFields` nor `returnGeometry` affects the result. Strip
 * both before issuing each `GetFeature` page so a caller-supplied
 * `returnGeometry: false` cannot throw the runGetFeatureJson guard
 * (which refuses to suppress geometry without an explicit `outFields`)
 * and so the drain's `propertyName=` does not balloon with the
 * geometry property the caller never asked for.
 */
function toWfsObjectIdsDrainRequest<T>(request: Query<T> | undefined): Query<T> {
  const {
    outFields: _outFields,
    returnGeometry: _returnGeometry,
    pagination: _pagination,
    ...idsRequest
  } = request ?? {};
  void _outFields;
  void _returnGeometry;
  void _pagination;
  return idsRequest;
}

/**
 * Compile `Query.spatialFilter` and the deprecated source-native
 * `Query.where` migration member into a (possibly empty) FES filter and route
 * the request through GET or POST GetFeature based on the URL budget. Returns
 * the decoded GeoJSON FeatureCollection.
 */
async function runGetFeatureJson<T>(
  featureType: HonuaWfsFeatureType,
  typeName: string,
  choice: OutputFormatChoice,
  request: Query<T> | undefined,
  pageSize: number | undefined,
): Promise<unknown> {
  const filterNodes: FesNode[] = [];
  let needsPostBody = false;
  let bbox: string | undefined;
  if (request?.where !== undefined && request.where !== "") {
    const compiled = compileWhere(request.where);
    if (compiled === UNSUPPORTED_FES) {
      throw new HonuaCapabilityNotSupportedError(
        "query",
        "wfs",
        `where clause is not expressible in FES; route the request through Source.protocol("wfs") to emit a custom filter`,
      );
    }
    if (compiled.kind !== "and" || compiled.operands.length > 0) {
      filterNodes.push(compiled);
    }
  }
  if (request?.spatialFilter) {
    const spatialRel = request.spatialFilter.spatialRel;
    // The `bbox=` KVP and `<fes:BBOX>` both encode envelope-intersects
    // semantics (OGC 09-026r2). Only take the bbox shortcut when the caller
    // wants intersects (default), envelope-intersects, or did not specify.
    // Anything else (Contains, Within, Crosses, Overlaps, Touches) needs an
    // FES predicate that preserves the requested relation, which means
    // routing the envelope through compileSpatialFilter so the geometry is
    // serialized as a polygon under the correct spatial op.
    const isEnvelopeIntersects =
      spatialRel === undefined ||
      spatialRel === "esriSpatialRelIntersects" ||
      spatialRel === "esriSpatialRelEnvelopeIntersects";
    if (
      request.spatialFilter.geometryType === "esriGeometryEnvelope" &&
      isEnvelopeIntersects &&
      filterNodes.length === 0 &&
      request.where === undefined
    ) {
      // BBox-only requests are short and travel safely as a `bbox=` KVP, no
      // FES emission required. Saves a round-trip through XML serialization
      // and keeps the URL human-debuggable.
      const env = request.spatialFilter.geometry as { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
      if (
        typeof env.xmin === "number" &&
        typeof env.ymin === "number" &&
        typeof env.xmax === "number" &&
        typeof env.ymax === "number"
      ) {
        bbox = `${env.xmin},${env.ymin},${env.xmax},${env.ymax}`;
      }
    } else {
      const filterSrsName = wfsSrsNameFromOutSr(request.outSr);
      const compiled = compileSpatialFilter(request.spatialFilter, {
        geometryProperty: DEFAULT_WFS_GEOMETRY_PROPERTY,
        ...(filterSrsName !== undefined ? { srsName: filterSrsName } : {}),
      });
      if (compiled === UNSUPPORTED_FES) {
        throw new HonuaCapabilityNotSupportedError(
          "query",
          "wfs",
          `spatial filter (geometryType=${request.spatialFilter.geometryType}, spatialRel=${request.spatialFilter.spatialRel ?? "default"}) is not expressible in FES; reach the wire through Source.protocol("wfs")`,
        );
      }
      filterNodes.push(compiled);
    }
  }

  const filterXml = filterNodes.length > 0 ? serializeFes(filterNodes, { typeName }) : undefined;
  if (filterXml !== undefined) {
    const encoded = encodeURIComponent(filterXml);
    if (encoded.length > WFS_GET_FILTER_BUDGET) needsPostBody = true;
  }

  const params: Parameters<HonuaWfsFeatureType["getFeature"]>[0] = {};
  if (bbox !== undefined) params.bbox = bbox;
  if (filterXml !== undefined && !needsPostBody) params.filter = filterXml;
  // WFS `propertyName=` drops every property the caller does not list,
  // including the geometry column. Honor the canonical contract: when
  // `outFields` is set and `returnGeometry !== false`, append the
  // geometry property so geometry is preserved; when
  // `returnGeometry === false`, omit the geometry property; when
  // `returnGeometry === false` is asked without an `outFields` list,
  // refuse the request because WFS cannot suppress geometry without
  // enumerating every non-geometry property — silently widening to
  // "geometry included" would break the canonical contract.
  const callerOutFields = request?.outFields && request.outFields.length > 0 ? request.outFields : undefined;
  const wantsGeometry = request?.returnGeometry !== false;
  let propertyNames: readonly string[] | undefined;
  if (callerOutFields !== undefined) {
    if (wantsGeometry) {
      const merged = [...callerOutFields];
      if (!merged.includes(DEFAULT_WFS_GEOMETRY_PROPERTY)) merged.push(DEFAULT_WFS_GEOMETRY_PROPERTY);
      propertyNames = merged;
    } else {
      propertyNames = [...callerOutFields];
    }
  } else if (request?.returnGeometry === false) {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "wfs",
      `returnGeometry=false requires an explicit outFields list (WFS propertyName cannot suppress geometry without enumerating non-geometry properties); set Query.outFields or reach the wire through Source.protocol("wfs")`,
    );
  }
  if (propertyNames) params.propertyName = [...propertyNames];
  const sortBy =
    request?.orderBy && request.orderBy.length > 0
      ? request.orderBy.map((s) => `${s.field}${s.direction === "desc" ? " D" : " A"}`).join(",")
      : undefined;
  if (sortBy !== undefined) params.sortBy = sortBy;
  if (typeof pageSize === "number" && pageSize > 0) {
    params.count = pageSize;
  } else if (typeof request?.pagination?.limit === "number" && request.pagination.limit > 0) {
    params.count = request.pagination.limit;
  }
  if (typeof request?.pagination?.offset === "number" && request.pagination.offset > 0) {
    params.startIndex = request.pagination.offset;
  }
  const srsName = wfsSrsNameFromOutSr(request?.outSr);
  if (srsName !== undefined) params.srsName = srsName;
  params.outputFormat = choice.format;
  if (request?.signal) params.signal = request.signal;

  if (needsPostBody && filterXml !== undefined) {
    params.method = "POST";
    const postOptions: Parameters<typeof buildPostGetFeatureBody>[0] = {
      typeName,
      filter: filterXml,
      count: params.count,
      startIndex: params.startIndex,
      outputFormat: choice.format,
    };
    if (propertyNames) postOptions.propertyNames = propertyNames;
    if (sortBy !== undefined) postOptions.sortBy = sortBy;
    if (srsName !== undefined) postOptions.srsName = srsName;
    params.body = buildPostGetFeatureBody(postOptions);
  }

  const response = await featureType.getFeature(params);
  if (response.kind !== "json") {
    throw new HonuaCapabilityNotSupportedError(
      "query",
      "wfs",
      `WFS GetFeature returned ${response.contentType}; canonical surface only carries JSON. Reach raw output through Source.protocol("wfs")`,
    );
  }
  return response.data;
}

function buildPostGetFeatureBody(options: {
  typeName: string;
  filter: string;
  count: number | undefined;
  startIndex: number | undefined;
  outputFormat: string;
  propertyNames?: readonly string[];
  sortBy?: string;
  srsName?: string;
}): string {
  const countAttr = typeof options.count === "number" ? ` count="${options.count}"` : "";
  const startAttr = typeof options.startIndex === "number" ? ` startIndex="${options.startIndex}"` : "";
  const outputAttr = ` outputFormat="${escapeXmlAttr(options.outputFormat)}"`;
  const queryAttrs = options.srsName !== undefined ? ` srsName="${escapeXmlAttr(options.srsName)}"` : "";
  const propertyXml =
    options.propertyNames && options.propertyNames.length > 0
      ? options.propertyNames.map((name) => `<wfs:PropertyName>${escapeXmlText(name)}</wfs:PropertyName>`).join("")
      : "";
  const sortByXml = options.sortBy !== undefined ? buildSortByXml(options.sortBy) : "";
  return `<wfs:GetFeature xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0" service="WFS" version="2.0.0"${outputAttr}${countAttr}${startAttr}><wfs:Query typeNames="${escapeXmlAttr(options.typeName)}"${queryAttrs}>${propertyXml}${options.filter}${sortByXml}</wfs:Query></wfs:GetFeature>`;
}

/**
 * Build a `<fes:SortBy>` block from the same comma-separated `sortBy` string
 * the GET path emits (`FIELD A,OTHER D`). Empty entries are skipped.
 */
function buildSortByXml(sortBy: string): string {
  const entries = sortBy
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return "";
  const properties = entries.map((entry) => {
    const parts = entry.split(/\s+/);
    const field = parts[0];
    const direction = parts[1]?.toUpperCase() === "D" ? "DESC" : "ASC";
    return `<fes:SortProperty><fes:ValueReference>${escapeXmlText(field)}</fes:ValueReference><fes:SortOrder>${direction}</fes:SortOrder></fes:SortProperty>`;
  });
  return `<fes:SortBy>${properties.join("")}</fes:SortBy>`;
}

/**
 * Translate a canonical `Query.outSr` (string CRS URI / EPSG token, or numeric
 * WKID) into the WFS `srsName` form. Numeric WKIDs become the OGC URN form
 * `urn:ogc:def:crs:EPSG::<wkid>` so cross-server interop matches the format
 * advertised in `OperationsMetadata` / `Filter_Capabilities`.
 */
function wfsSrsNameFromOutSr(outSr: string | number | undefined): string | undefined {
  if (typeof outSr === "string") return outSr.length > 0 ? outSr : undefined;
  if (typeof outSr === "number" && Number.isFinite(outSr)) return `urn:ogc:def:crs:EPSG::${outSr}`;
  return undefined;
}

function escapeXmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resultFromGeoJson<T>(data: unknown): Result<T> {
  if (typeof data !== "object" || data === null) {
    return { features: [], exceededTransferLimit: false };
  }
  const collection = data as {
    features?: ReadonlyArray<{ id?: unknown; properties?: Record<string, unknown>; geometry?: unknown }>;
    numberMatched?: unknown;
  };
  const features: HonuaTypedFeature<T>[] = (collection.features ?? []).map((f) => ({
    attributes: (f.properties ?? {}) as T,
    geometry: f.geometry as Record<string, unknown> | null,
  }));
  const totalCount =
    typeof collection.numberMatched === "number" && Number.isFinite(collection.numberMatched)
      ? collection.numberMatched
      : undefined;
  const exceededTransferLimit = totalCount !== undefined && features.length < totalCount;
  const out: Result<T> = {
    features,
    exceededTransferLimit,
  };
  if (totalCount !== undefined) out.totalCount = totalCount;
  return out;
}

function computeExtentFromFeatureCollection(data: unknown): {
  extent: import("../core/types.js").HonuaExtent | null;
  count: number;
} {
  if (typeof data !== "object" || data === null) return { extent: null, count: 0 };
  const collection = data as { features?: ReadonlyArray<{ geometry?: unknown }> };
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  let saw = false;
  let count = 0;
  for (const feature of collection.features ?? []) {
    count += 1;
    visitGeometryCoords(feature.geometry, (x, y) => {
      if (x < xmin) xmin = x;
      if (y < ymin) ymin = y;
      if (x > xmax) xmax = x;
      if (y > ymax) ymax = y;
      saw = true;
    });
  }
  if (!saw) return { extent: null, count };
  return { extent: { xmin, ymin, xmax, ymax }, count };
}

function buildTransactionBody<T>(
  typeName: string,
  envelope: EditEnvelope<T>,
  featureNamespace: string | undefined,
  srsName: string | undefined,
): string {
  const releaseAction = envelope.rollbackOnFailure ? "ALL" : "SOME";
  const { prefix } = splitTypeName(typeName);
  // Bind the feature-namespace prefix on the Transaction root so prefixed
  // feature elements inside <wfs:Insert> and prefixed `typeName=` attribute
  // references on <wfs:Update>/<wfs:Delete> resolve. When the descriptor's
  // locator does not advertise `featureNamespace`, fall back to a synthetic
  // URN so the document is at least well-formed XML; strict servers will
  // reject the unknown URI with a diagnostic ExceptionReport that the caller
  // can resolve by setting `locator.featureNamespace`.
  const featureNs = prefix ? (featureNamespace ?? syntheticFeatureNamespace(prefix)) : undefined;
  const featureNsAttr = prefix && featureNs ? ` xmlns:${prefix}="${escapeXmlAttr(featureNs)}"` : "";
  const blocks: string[] = [];
  // Insert handles are read back in `canonicalEditResultFromTransaction`
  // to map server-echoed `<wfs:Feature handle="…">` entries inside
  // `<wfs:InsertResults>` onto the originating `envelope.adds[i]`. The
  // shared scheme lives in `wfsInsertHandle` so the build side and the
  // result-mapping side cannot drift.
  const adds = envelope.adds ?? [];
  for (let i = 0; i < adds.length; i += 1) {
    blocks.push(buildInsertBlock(typeName, adds[i], wfsInsertHandle(i), srsName));
  }
  let handleCounter = adds.length;
  for (const update of envelope.updates ?? []) {
    handleCounter += 1;
    blocks.push(buildUpdateBlock(typeName, update, `upd-${handleCounter}`, srsName));
  }
  for (const id of envelope.deletes ?? []) {
    handleCounter += 1;
    blocks.push(buildDeleteBlock(typeName, id, `del-${handleCounter}`));
  }
  return `<wfs:Transaction xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"${featureNsAttr} service="WFS" version="2.0.0" releaseAction="${releaseAction}">${blocks.join("")}</wfs:Transaction>`;
}

/**
 * Split a namespace-qualified WFS type name like `parcels:lot` into its
 * prefix and local components. Returns `{ prefix: undefined, local: typeName }`
 * for unprefixed names.
 */
function splitTypeName(typeName: string): { prefix: string | undefined; local: string } {
  const colon = typeName.indexOf(":");
  if (colon < 0) return { prefix: undefined, local: typeName };
  return { prefix: typeName.slice(0, colon), local: typeName.slice(colon + 1) };
}

/**
 * Deterministic stub URI used when the locator does not declare a
 * `featureNamespace`. Servers that perform strict schema validation will
 * reject this URI with an `<ows:ExceptionReport>` rather than silently
 * accept the body — the message names the prefix so callers know which
 * `featureNamespace` to set on the descriptor.
 */
function syntheticFeatureNamespace(prefix: string): string {
  return `urn:honua:wfs:feature-namespace:${prefix}`;
}

function buildInsertBlock<T>(
  typeName: string,
  feature: { attributes: T; geometry?: Record<string, unknown> | null },
  handle: string,
  srsName: string | undefined,
): string {
  const attributes = feature.attributes as Record<string, unknown>;
  const propertyXml = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) => `<${escapeXmlElement(key)}>${escapeXmlText(formatLiteral(value))}</${escapeXmlElement(key)}>`,
    )
    .join("");
  const geometryXml = feature.geometry ? (geoJsonGeometryToGml(feature.geometry, srsName) ?? "") : "";
  const geometryProperty = escapeXmlElement(DEFAULT_WFS_GEOMETRY_PROPERTY);
  const featureXml = `<${escapeXmlElement(typeName)}>${propertyXml}${geometryXml ? `<${geometryProperty}>${geometryXml}</${geometryProperty}>` : ""}</${escapeXmlElement(typeName)}>`;
  return `<wfs:Insert handle="${handle}">${featureXml}</wfs:Insert>`;
}

function buildUpdateBlock<T>(
  typeName: string,
  feature: { id?: FeatureId; attributes: T; geometry?: Record<string, unknown> | null },
  handle: string,
  srsName: string | undefined,
): string {
  const attributes = feature.attributes as Record<string, unknown>;
  const properties = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `<wfs:Property><wfs:ValueReference>${escapeXmlText(key)}</wfs:ValueReference><wfs:Value>${escapeXmlText(formatLiteral(value))}</wfs:Value></wfs:Property>`,
    )
    .join("");
  const geometryProperty = feature.geometry
    ? `<wfs:Property><wfs:ValueReference>${escapeXmlText(DEFAULT_WFS_GEOMETRY_PROPERTY)}</wfs:ValueReference><wfs:Value>${geoJsonGeometryToGml(feature.geometry, srsName) ?? ""}</wfs:Value></wfs:Property>`
    : "";
  const filter =
    feature.id !== undefined
      ? `<fes:Filter><fes:ResourceId rid="${escapeXmlAttr(String(feature.id))}"/></fes:Filter>`
      : "";
  return `<wfs:Update handle="${handle}" typeName="${escapeXmlAttr(typeName)}">${properties}${geometryProperty}${filter}</wfs:Update>`;
}

function buildDeleteBlock(typeName: string, id: FeatureId, handle: string): string {
  return `<wfs:Delete handle="${handle}" typeName="${escapeXmlAttr(typeName)}"><fes:Filter><fes:ResourceId rid="${escapeXmlAttr(String(id))}"/></fes:Filter></wfs:Delete>`;
}

function formatLiteral(value: unknown): string {
  if (value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value);
}

function escapeXmlElement(name: string): string {
  // Element names in WFS are namespace-qualified, but we treat the typeName
  // as a single token so callers may include `:` or `_`. Disallow anything
  // that could break the document.
  return name.replace(/[^A-Za-z0-9_:.-]/g, "_");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Stable handle scheme for `<wfs:Insert>` blocks. The server is expected
 * (but not required by WFS 2.0) to echo this on the matching
 * `<wfs:Feature handle="…">` element inside `<wfs:InsertResults>`, which
 * lets `canonicalEditResultFromTransaction` map returned ResourceIds back
 * onto `envelope.adds[i]` even when the server reorders the buckets or
 * omits failed inserts under `releaseAction="SOME"`.
 */
function wfsInsertHandle(idx: number): string {
  return `add-${idx + 1}`;
}

function canonicalEditResultFromTransaction<T>(
  envelope: EditEnvelope<T>,
  summary: import("../core/wfs-capabilities.js").WfsTransactionSummary,
  malformedUpdateIndices: ReadonlySet<number> = new Set(),
): EditResult {
  // Index `<wfs:InsertResults>` by the handle the server echoed so that
  // server-side reordering or `releaseAction="SOME"` partial failures do
  // not misassign ResourceIds to the wrong `envelope.adds[i]`. The
  // handle attribute is informational in the WFS 2.0 spec, so when the
  // server omits it on every `<wfs:Feature>` we fall back to the legacy
  // positional pairing rather than dropping every insert id silently.
  let anyHandleEchoed = false;
  const insertByHandle = new Map<string, ReadonlyArray<string>>();
  for (const bucket of summary.insertResults) {
    if (bucket.handle !== undefined) {
      anyHandleEchoed = true;
      insertByHandle.set(bucket.handle, bucket.ids);
    }
  }
  const added: EditOutcome[] = (envelope.adds ?? []).map((_, idx) => {
    const matchedIds = anyHandleEchoed ? insertByHandle.get(wfsInsertHandle(idx)) : summary.insertResults[idx]?.ids;
    const insertedId = matchedIds?.[0];
    // When handles are echoed, presence in `InsertResults` is the
    // authoritative per-insert success signal (the server only emits a
    // bucket for the inserts that actually committed). Without handles
    // we fall back to the legacy "first N succeeded" heuristic anchored
    // on `totalInserted`.
    const ok = anyHandleEchoed ? matchedIds !== undefined : idx < summary.totalInserted;
    const out: EditOutcome = { success: ok };
    if (insertedId !== undefined) out.id = insertedId;
    return out;
  });
  // Updates that were skipped because they had no id never went on the wire;
  // their outcome is a deterministic 400. The remaining indices align with
  // the transaction summary in the order the body sent them.
  const updated: EditOutcome[] = [];
  let validUpdateIdx = 0;
  for (const [idx, update] of (envelope.updates ?? []).entries()) {
    if (malformedUpdateIndices.has(idx)) {
      updated.push({ success: false, error: { code: 400, description: "update.id is required" } });
      continue;
    }
    const out: EditOutcome = { success: validUpdateIdx < summary.totalUpdated };
    if (update.id !== undefined) out.id = update.id;
    updated.push(out);
    validUpdateIdx += 1;
  }
  const deleted: EditOutcome[] = (envelope.deletes ?? []).map((id, idx) => ({
    id,
    success: idx < summary.totalDeleted,
  }));
  return { added, updated, deleted };
}

// ── OData entity set ──────────────────────────────────────────

/**
 * Build a `Source` over an OData v4 entity set. The `Query` translation
 * lowers `where` / `outFields` / `orderBy` / pagination / spatial filter
 * onto OData's `$`-prefixed query options. Dialect-specific operations
 * (`$batch`, `$apply`, `$search`, `$deltatoken`) live behind
 * `Source.protocol("odata")` on the returned `HonuaOdataEntitySet`.
 *
 * `$metadata` is fetched lazily on the first call that needs it and
 * cached on the entity-set instance. The fetched capability annotations
 * are intersected with the descriptor's declared `Capabilities` set the
 * first time a capability-gated method is invoked — this is the
 * precedent for the metadata-driven downgrade pattern referenced in
 * `docs/shared-client-contract.md`.
 */
/** JSON write policy for the canonical OData source adapter. */
export type OdataWriteEncoding = "legacy" | "lossless-json";

/** Options for {@link odataSource}. */
export interface OdataSourceOptions {
  /**
   * Opt into metadata-driven exact EDM body and key encoding. `Edm.Int64`
   * and `Edm.Decimal` values become validated JSON strings and request media
   * types receive `IEEE754Compatible=true` only when required. Defaults to
   * `legacy`, preserving the original JSON bytes and key formatting.
   */
  readonly writeEncoding?: OdataWriteEncoding;
}

type OdataWriteCodec = typeof import("../core/odata-write-codec.js");

let odataWriteCodecPromise: Promise<OdataWriteCodec> | undefined;

/** Load the opt-in codec once; legacy sources never evaluate this import. */
function loadOdataWriteCodec(): Promise<OdataWriteCodec> {
  odataWriteCodecPromise ??= import("../core/odata-write-codec.js");
  return odataWriteCodecPromise;
}

/**
 * Adapter factory for an OData v4 entity set.
 *
 * The deprecated source-native `Query.where` migration member compiles to
 * OData `$filter`, `Query.outFields` becomes `$select`, `Query.orderBy`
 * becomes `$orderby`, and `Query.pagination` becomes `$top`/`$skip`.
 * Geospatial filters translate to OData's `geo.intersects` /
 * `geo.distance` family.
 *
 * @example
 * ```ts
 * const dataset = createDataset({
 *   id: "incidents",
 *   client,
 *   sources: [{
 *     id: "incidents",
 *     protocol: "odata",
 *     locator: { url: "https://your-honua-server.example/odata", entitySet: "Incidents" },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
 *   }],
 * });
 * const result = await dataset.source("incidents")!.queryAll({
 *   orderBy: [{ field: "ReportedAt", direction: "desc" }],
 *   pagination: { limit: 100 },
 * });
 * ```
 */
export function odataSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
  options: OdataSourceOptions = {},
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const { entitySet, basePath } = requireOdataLocator(descriptor);
  const entity = new HonuaOdataEntitySet({ client, entitySet, basePath });
  const declaredCaps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.odata;
  const negotiation = new OdataCapabilityNegotiator(entity, declaredCaps);
  const writeEncoding = options.writeEncoding ?? "legacy";
  if (writeEncoding !== "legacy" && writeEncoding !== "lossless-json") {
    throw new TypeError('odata: writeEncoding must be "legacy" or "lossless-json"');
  }

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    odata: entity,
  };

  return makeSource<T>(descriptor, declaredCaps, policy, adapterRegistry, {
    async query(request) {
      ensureCapability(descriptor, declaredCaps, "query");
      await negotiation.ensureAdvertised(descriptor, "query");
      const geomColumn = await resolveOdataGeometryColumn(entity, descriptor);
      const params = await buildOdataParams(entity, descriptor, request, { count: true, geomColumn });
      const page = await entity.query<Record<string, unknown>>(params);
      return odataResultFromPage<T>(
        descriptor,
        page,
        await negotiation.fieldsFor(descriptor.id),
        request?.returnGeometry,
        geomColumn,
      );
    },
    async queryAll(request) {
      ensureCapability(descriptor, declaredCaps, "query");
      await negotiation.ensureAdvertised(descriptor, "query");
      const geomColumn = await resolveOdataGeometryColumn(entity, descriptor);
      const params = await buildOdataParams(entity, descriptor, request, { count: true, geomColumn });
      const limit = request?.pagination?.limit;
      // Lookahead row: ask the server for `limit + 1` so we can prove
      // truncation by collecting more than `limit` rows even when the
      // response carries no `@odata.nextLink`. Mirrors the GeoServices
      // and OGC `queryAll` truncation pattern.
      if (typeof limit === "number" && limit >= 0) {
        params.top = limit + 1;
      }
      const drained = await entity.queryAll<Record<string, unknown>>(params);
      const allFeatures = drained.rows.map((row) =>
        odataRowToFeature<T>(row, descriptor, request?.returnGeometry, geomColumn),
      );
      const { features: limited, exceededTransferLimit: collectedExceeded } = applyQueryAllLimit(allFeatures, limit);
      // Belt-and-braces: if the server respected `$top` exactly but
      // reports `@odata.count > limited.length`, that also proves
      // truncation. Either signal sets the flag.
      const countExceeded =
        typeof drained.totalCount === "number" && typeof limit === "number" && drained.totalCount > limited.length;
      const exceededTransferLimit = collectedExceeded || countExceeded;
      const fields = await negotiation.fieldsFor(descriptor.id);
      return {
        features: limited,
        exceededTransferLimit,
        ...(typeof drained.totalCount === "number"
          ? { totalCount: drained.totalCount }
          : { totalCount: limited.length }),
        ...(fields.length > 0 ? { fields } : {}),
      } satisfies Result<T>;
    },
    async queryAggregate() {
      // OData aggregation is dialect-specific (`$apply` pipeline). The
      // canonical surface refuses; callers reach the typed escape hatch
      // (`Source.protocol("odata").apply(...)`) for the dialect surface.
      throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
    },
    async queryExtent() {
      // OData does not expose an extent endpoint; computing one client-side
      // would require draining every matching row, which the canonical
      // surface refuses to do silently. Mirrors the OGC `attachments` /
      // `queryRelated` posture: refuse rather than ship a degraded path.
      throw new HonuaCapabilityNotSupportedError("queryExtent", descriptor.protocol, descriptor.id);
    },
    async *stream(request) {
      ensureCapability(descriptor, declaredCaps, "stream");
      await negotiation.ensureAdvertised(descriptor, "query");
      const geomColumn = await resolveOdataGeometryColumn(entity, descriptor);
      const params = await buildOdataParams(entity, descriptor, request, { count: false, geomColumn });
      const fields = await negotiation.fieldsFor(descriptor.id);
      const stream = entity.queryStream<Record<string, unknown>>(params);
      for await (const page of stream) {
        yield odataResultFromPage<T>(descriptor, page, fields, request?.returnGeometry, geomColumn);
      }
    },
    async queryObjectIds(request) {
      ensureCapability(descriptor, declaredCaps, "queryObjectIds");
      await negotiation.ensureAdvertised(descriptor, "query");
      const keyField = await negotiation.keyField(descriptor.id);
      const geomColumn = await resolveOdataGeometryColumn(entity, descriptor);
      const params = await buildOdataParams(entity, descriptor, request, { count: false, geomColumn });
      params.select = [keyField];
      // `queryObjectIds` projects only the key field, so `out.expand`
      // built from dotted `outFields` is irrelevant; clear it so a
      // caller-supplied projection cannot inflate the wire request.
      delete params.expand;
      // `entity.queryAll` respects `top` exactly. The canonical
      // `queryObjectIds` honors `Query.pagination.limit` as a hard cap
      // and slices the projection to it (mirrors the STAC adapter at
      // line 825). No lookahead row is needed because the result is
      // ids, not features — there is no `exceededTransferLimit` flag
      // to stamp.
      const limit = request?.pagination?.limit;
      const drained = await entity.queryAll<Record<string, unknown>>(params);
      const ids: FeatureId[] = [];
      for (const row of drained.rows) {
        const value = row[keyField];
        if (value === undefined || value === null) continue;
        ids.push(typeof value === "number" ? value : String(value));
      }
      if (typeof limit === "number" && limit >= 0 && ids.length > limit) {
        return ids.slice(0, limit);
      }
      return ids;
    },
    async applyEdits(envelope) {
      ensureCapability(descriptor, declaredCaps, "applyEdits");
      await negotiation.ensureAdvertised(descriptor, "applyEdits");
      const keyFields = await negotiation.keyFields(descriptor.id);
      const prepared =
        writeEncoding === "lossless-json"
          ? prepareLosslessOdataEdits(
              entity,
              envelope,
              keyFields,
              await negotiation.metadata(),
              await loadOdataWriteCodec(),
            )
          : undefined;

      // Atomic path: when the caller asks for rollback-on-failure AND the
      // service advertises `$batch`, collapse the envelope into a single
      // OData batch with a shared `atomicityGroup` so a later failure
      // tears down earlier edits server-side. When `$batch` is not
      // advertised the rollback contract cannot be honored — degrade to
      // the per-call path and stamp `degraded[]` so downstream views can
      // flag the result.
      if (envelope.rollbackOnFailure === true) {
        const batchAdvertised = await negotiation.batchAdvertised();
        if (batchAdvertised) {
          return atomicOdataApplyEdits(entity, envelope, keyFields, descriptor, prepared);
        }
        const result = await perCallOdataApplyEdits(entity, envelope, keyFields, prepared);
        return {
          ...result,
          degraded: [
            ...(result.degraded ?? []),
            {
              capability: "applyEdits",
              protocol: descriptor.protocol,
              reason:
                "rollbackOnFailure was requested but the OData service does not advertise $batch; edits ran per-call without atomicity.",
              sourceId: descriptor.id,
            },
          ],
        } satisfies EditResult;
      }

      return perCallOdataApplyEdits(entity, envelope, keyFields, prepared);
    },
    async queryRelated() {
      // OData has no canonical related-records surface; navigation
      // properties live behind the typed escape hatch (`$expand` via
      // `protocol("odata").raw(...)` or `apply()` for cross-set joins).
      throw new HonuaCapabilityNotSupportedError("queryRelated", descriptor.protocol, descriptor.id);
    },
    attachments: unsupportedAttachmentApi(descriptor),
  });
}

interface PreparedOdataBody {
  readonly body: Record<string, unknown>;
  readonly contentType: string;
}

interface PreparedOdataUpdate extends PreparedOdataBody {
  readonly key: HonuaOdataEncodedEntityKey;
}

interface PreparedOdataDelete {
  readonly key: HonuaOdataEncodedEntityKey;
}

interface PreparedOdataEdits {
  readonly adds: readonly PreparedOdataBody[];
  readonly updates: readonly PreparedOdataUpdate[];
  readonly deletes: readonly PreparedOdataDelete[];
}

/**
 * Preflight the complete opted-in envelope against one cached metadata
 * snapshot. Both direct and atomic execution consume this projection, so a
 * local encoding failure cannot leak a partial request or take a different
 * branch-specific coercion path.
 */
function prepareLosslessOdataEdits<T>(
  entity: HonuaOdataEntitySet,
  envelope: EditEnvelope<T>,
  keyFields: ReadonlyArray<string>,
  metadata: HonuaOdataMetadata,
  codec: OdataWriteCodec,
): PreparedOdataEdits {
  const urlKeys = urlKeyFields(entity.entitySet, keyFields);
  const adds = (envelope.adds ?? []).map((add) => preparedOdataBody(metadata, entity.entitySet, add, codec));
  const updates = (envelope.updates ?? []).map((update) => {
    const prepared = preparedOdataBody(metadata, entity.entitySet, update, codec);
    const key = preparedOdataUpdateKey(metadata, entity.entitySet, update.id, prepared.body, urlKeys, codec);
    return { ...prepared, key };
  });
  const deletes = (envelope.deletes ?? []).map((id) => {
    if (urlKeys.length > 1) {
      // The generic contract carries only a scalar FeatureId. Lossless
      // composite addressing requires named components, so do not interpret
      // an ad-hoc string expression or risk targeting a different entity.
      throw new codec.HonuaOdataEdmEncodingError("missing-key", "$.key");
    }
    return {
      key: codec.encodeOdataEntityKey(metadata, entity.entitySet, id, {
        keyFields: urlKeys,
      }),
    };
  });
  return { adds, updates, deletes };
}

function preparedOdataBody<T>(
  metadata: HonuaOdataMetadata,
  entitySet: string,
  feature: { attributes: T; geometry?: Record<string, unknown> | null },
  codec: OdataWriteCodec,
): PreparedOdataBody {
  const attributes = codec.encodeOdataWriteBody(
    metadata,
    entitySet,
    feature.attributes as Readonly<Record<string, unknown>>,
  );
  let encoded: HonuaOdataEncodedWriteBody = attributes;
  if (
    feature.geometry !== undefined &&
    feature.geometry !== null &&
    !Object.hasOwn(attributes.body, "Geometry") &&
    !Object.hasOwn(attributes.body, "geometry")
  ) {
    const geometry = codec.encodeOdataWriteBody(metadata, entitySet, { Geometry: feature.geometry });
    encoded = {
      body: { ...attributes.body, ...geometry.body },
      requiresIeee754Compatible: attributes.requiresIeee754Compatible || geometry.requiresIeee754Compatible,
    };
  }
  return {
    body: encoded.body,
    contentType: encoded.requiresIeee754Compatible ? "application/json;IEEE754Compatible=true" : "application/json",
  };
}

function preparedOdataUpdateKey(
  metadata: HonuaOdataMetadata,
  entitySet: string,
  id: FeatureId | undefined,
  attributes: Readonly<Record<string, unknown>>,
  keyFields: ReadonlyArray<string>,
  codec: OdataWriteCodec,
): HonuaOdataEncodedEntityKey {
  if (keyFields.length === 1) {
    const field = keyFields[0]!;
    const attributeValue = ownPreparedValue(attributes, field);
    const attributeKey =
      attributeValue === undefined || attributeValue === null
        ? undefined
        : codec.encodeOdataEntityKey(metadata, entitySet, attributeValue, { keyFields });
    const idKey =
      id === undefined || id === null ? undefined : codec.encodeOdataEntityKey(metadata, entitySet, id, { keyFields });
    if (
      attributeKey &&
      idKey &&
      (attributeKey.literal !== idKey.literal || attributeKey.pathSegment !== idKey.pathSegment)
    ) {
      throw new codec.HonuaOdataEdmEncodingError("invalid-value", "$.key");
    }
    return attributeKey ?? idKey ?? codec.encodeOdataEntityKey(metadata, entitySet, undefined, { keyFields });
  }
  if (keyFields.length === 0) {
    return codec.encodeOdataEntityKey(metadata, entitySet, id, { keyFields });
  }
  if (id !== undefined && id !== null) {
    // A scalar generic id cannot prove equivalence to a named composite key.
    // Reject it even when the body carries all components so the adapter never
    // targets one identity while reporting another.
    throw new codec.HonuaOdataEdmEncodingError("invalid-value", "$.key");
  }
  const key: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of keyFields) {
    const value = ownPreparedValue(attributes, field);
    if (value === undefined || value === null) continue;
    Object.defineProperty(key, field, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  return codec.encodeOdataEntityKey(metadata, entitySet, key, { keyFields });
}

function ownPreparedValue(attributes: Readonly<Record<string, unknown>>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(attributes, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Per-call OData edits — issues independent POST/PATCH/DELETE requests
 * and collects per-row outcomes. This is the non-atomic fallback used
 * when `rollbackOnFailure` is unset or the server does not advertise
 * `$batch`.
 */
async function perCallOdataApplyEdits<T>(
  entity: HonuaOdataEntitySet,
  envelope: EditEnvelope<T>,
  keyFields: ReadonlyArray<string>,
  prepared?: PreparedOdataEdits,
): Promise<EditResult> {
  const added: EditOutcome[] = [];
  const updated: EditOutcome[] = [];
  const deleted: EditOutcome[] = [];
  const { signal } = envelope;

  const adds = envelope.adds ?? [];
  for (let index = 0; index < adds.length; index += 1) {
    const add = adds[index];
    const encoded = prepared?.adds[index];
    try {
      const created = await entity.add<Record<string, unknown>>(encoded?.body ?? featureToOdataBody(add), {
        ...(signal ? { signal } : {}),
        ...(encoded ? { contentType: encoded.contentType } : {}),
      });
      const id = readKey(created, keyFields, add.id);
      added.push(id !== undefined ? { id, success: true } : { success: true });
    } catch (err) {
      added.push({ success: false, error: editErrorFromCatch(err) });
    }
  }
  // Layer-scoped paths like `Layers(<n>)/Features` carry the parent key
  // (`LayerId`) in the URL itself, so the entity-set key parens only
  // need the non-parent components. `readKey` / `readKeyFromBody` keep
  // using the full `keyFields` because the response body still carries
  // every key.
  const urlKeys = urlKeyFields(entity.entitySet, keyFields);
  const updates = envelope.updates ?? [];
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const encoded = prepared?.updates[index];
    const key = encoded?.key.literal ?? canonicalKeyToOdata(update, urlKeys);
    if (key === undefined) {
      updated.push({ success: false, error: { code: 400, description: "update.id is required" } });
      continue;
    }
    try {
      await entity.update(key, encoded?.body ?? featureToOdataBody(update), {
        ...(signal ? { signal } : {}),
        ...(encoded ? { contentType: encoded.contentType } : {}),
      });
      updated.push({ id: update.id ?? readKeyFromBody(update.attributes, keyFields), success: true });
    } catch (err) {
      updated.push({ id: update.id, success: false, error: editErrorFromCatch(err) });
    }
  }
  const deletes = envelope.deletes ?? [];
  for (let index = 0; index < deletes.length; index += 1) {
    const id = deletes[index];
    const key = prepared?.deletes[index]?.key.literal ?? canonicalKeyToOdata({ id, attributes: {} }, urlKeys);
    if (key === undefined) {
      deleted.push({ success: false, error: { code: 400, description: "delete id is required" } });
      continue;
    }
    try {
      await entity.delete(key, { ...(signal ? { signal } : {}) });
      deleted.push({ id, success: true });
    } catch (err) {
      deleted.push({ id, success: false, error: editErrorFromCatch(err) });
    }
  }

  return { added, updated, deleted } satisfies EditResult;
}

/**
 * Atomic OData edits — collapses the envelope into a single
 * `$batch` request whose change-set wraps every operation in the same
 * `atomicityGroup`. Honua Server's `ODataBatchHandler` rolls back the
 * entire group when any operation fails. The batch responses are
 * threaded back into per-row `EditOutcome` entries in the original
 * order so callers see the same shape regardless of transport.
 */
async function atomicOdataApplyEdits<T>(
  entity: HonuaOdataEntitySet,
  envelope: EditEnvelope<T>,
  keyFields: ReadonlyArray<string>,
  descriptor: SourceDescriptor,
  prepared?: PreparedOdataEdits,
): Promise<EditResult> {
  const operations: HonuaOdataBatchOperation[] = [];
  // Track which bucket each operation belongs to so the response loop
  // can fan the outcomes back into added / updated / deleted in the
  // original order.
  type BucketKind = "add" | "update" | "delete";
  const plan: Array<{ kind: BucketKind; id?: FeatureId; key?: string }> = [];
  const bucketIndices: Record<BucketKind, number[]> = { add: [], update: [], delete: [] };

  // Layer-scoped paths like `Layers(<n>)/Features` carry the parent key
  // (`LayerId`) in the URL itself, so the entity-set key parens only
  // need the non-parent components.
  const urlKeys = urlKeyFields(entity.entitySet, keyFields);

  // Sequence ids deterministically so the response shape is predictable
  // and the test surface stays small.
  let seq = 1;
  const adds = envelope.adds ?? [];
  for (let index = 0; index < adds.length; index += 1) {
    const add = adds[index];
    const encoded = prepared?.adds[index];
    const id = String(seq++);
    operations.push({
      id,
      method: "POST",
      url: stripLeadingSlashLocal(entity.entitySet),
      body: encoded?.body ?? featureToOdataBody(add),
      ...(encoded ? { headers: { "Content-Type": encoded.contentType } } : {}),
    });
    bucketIndices.add.push(plan.length);
    plan.push({ kind: "add", id: add.id });
  }
  const updates = envelope.updates ?? [];
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const encoded = prepared?.updates[index];
    const id = String(seq++);
    const key = encoded?.key.literal ?? canonicalKeyToOdata(update, urlKeys);
    if (key === undefined) {
      bucketIndices.update.push(plan.length);
      plan.push({ kind: "update", id: update.id });
      continue;
    }
    operations.push({
      id,
      method: "PATCH",
      url: `${entity.entitySet}(${encoded?.key.pathSegment ?? key})`,
      body: encoded?.body ?? featureToOdataBody(update),
      ...(encoded ? { headers: { "Content-Type": encoded.contentType } } : {}),
    });
    bucketIndices.update.push(plan.length);
    plan.push({ kind: "update", id: update.id, key });
  }
  const deletes = envelope.deletes ?? [];
  for (let index = 0; index < deletes.length; index += 1) {
    const rawId = deletes[index];
    const encoded = prepared?.deletes[index];
    const id = String(seq++);
    const key = encoded?.key.literal ?? canonicalKeyToOdata({ id: rawId, attributes: {} }, urlKeys);
    if (key === undefined) {
      bucketIndices.delete.push(plan.length);
      plan.push({ kind: "delete", id: rawId });
      continue;
    }
    operations.push({
      id,
      method: "DELETE",
      url: `${entity.entitySet}(${encoded?.key.pathSegment ?? key})`,
    });
    bucketIndices.delete.push(plan.length);
    plan.push({ kind: "delete", id: rawId, key });
  }

  // Items with `key === undefined` were never added to operations; mark
  // their outcome here without consulting the response.
  const added: EditOutcome[] = new Array(adds.length);
  const updated: EditOutcome[] = new Array(updates.length);
  const deleted: EditOutcome[] = new Array(deletes.length);
  for (let i = 0; i < updates.length; i += 1) {
    const planIdx = bucketIndices.update[i];
    if (plan[planIdx].key === undefined) {
      updated[i] = { success: false, error: { code: 400, description: "update.id is required" } };
    }
  }
  for (let i = 0; i < deletes.length; i += 1) {
    const planIdx = bucketIndices.delete[i];
    if (plan[planIdx].key === undefined) {
      deleted[i] = { success: false, error: { code: 400, description: "delete id is required" } };
    }
  }

  if (operations.length === 0) {
    // Every requested edit was malformed — return the validation outcomes
    // rather than send an empty batch.
    return { added, updated, deleted } satisfies EditResult;
  }

  let batchOutcomes: ReadonlyArray<HonuaOdataBatchOutcome>;
  try {
    const batchResult = await entity.batch(operations, {
      atomicity: "all",
      ...(envelope.signal ? { signal: envelope.signal } : {}),
    });
    batchOutcomes = batchResult.responses;
  } catch (err) {
    // Whole-batch failure (network/auth/etc.). Apply the same error to
    // every requested row so the caller sees a uniform rollback signal.
    const error = editErrorFromCatch(err);
    for (let i = 0; i < adds.length; i += 1) added[i] = { success: false, error };
    for (let i = 0; i < updates.length; i += 1) {
      if (!updated[i]) updated[i] = { id: updates[i].id, success: false, error };
    }
    for (let i = 0; i < deletes.length; i += 1) {
      if (!deleted[i]) deleted[i] = { id: deletes[i], success: false, error };
    }
    return { added, updated, deleted } satisfies EditResult;
  }

  // Index outcomes by id for O(1) lookup.
  const byId = new Map<string, HonuaOdataBatchOutcome>();
  for (const r of batchOutcomes) byId.set(String(r.id), r);

  // Walk the operations in submission order so outcome indices line up
  // with adds/updates/deletes positions.
  let opCursor = 0;
  for (let i = 0; i < adds.length; i += 1) {
    const id = operations[opCursor].id ?? String(opCursor + 1);
    opCursor += 1;
    const outcome = byId.get(String(id));
    added[i] = batchOutcomeToEdit(outcome, adds[i].id, keyFields);
  }
  for (let i = 0; i < updates.length; i += 1) {
    if (updated[i]) continue; // skipped (no key)
    const id = operations[opCursor].id ?? String(opCursor + 1);
    opCursor += 1;
    const outcome = byId.get(String(id));
    updated[i] = batchOutcomeToEdit(outcome, updates[i].id, keyFields);
  }
  for (let i = 0; i < deletes.length; i += 1) {
    if (deleted[i]) continue;
    const id = operations[opCursor].id ?? String(opCursor + 1);
    opCursor += 1;
    const outcome = byId.get(String(id));
    deleted[i] = batchOutcomeToEdit(outcome, deletes[i], keyFields);
  }

  void descriptor;
  return { added, updated, deleted } satisfies EditResult;
}

function batchOutcomeToEdit(
  outcome: HonuaOdataBatchOutcome | undefined,
  fallbackId: FeatureId | undefined,
  keyFields: ReadonlyArray<string>,
): EditOutcome {
  if (!outcome) {
    return {
      ...(fallbackId !== undefined ? { id: fallbackId } : {}),
      success: false,
      error: { code: 0, description: "missing batch response" },
    };
  }
  if (outcome.status >= 200 && outcome.status < 300) {
    const body =
      outcome.body && typeof outcome.body === "object" ? (outcome.body as Record<string, unknown>) : undefined;
    const id = body ? readKey(body, keyFields, fallbackId) : fallbackId;
    return id !== undefined ? { id, success: true } : { success: true };
  }
  const description = describeBatchError(outcome.body, outcome.status);
  return {
    ...(fallbackId !== undefined ? { id: fallbackId } : {}),
    success: false,
    error: { code: outcome.status, description },
  };
}

function describeBatchError(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return `HTTP ${status}`;
}

function stripLeadingSlashLocal(url: string): string {
  return url.startsWith("/") ? url.slice(1) : url;
}

function requireOdataLocator(descriptor: SourceDescriptor): { entitySet: string; basePath: string } {
  const { entitySet, url, layerId } = descriptor.locator;
  // Resolve the entity-set token. Honua Server's `SourceLocator` only
  // carries `url`, `serviceId`, and `layerId`, so server-produced OData
  // bindings arrive without `entitySet`. The canonical server route is
  // layer-scoped — `/odata/Layers(<layerId>)/Features` — so derive that
  // path when only `layerId` is provided. SDK callers that already pass
  // `entitySet` (the historical path) continue to win.
  let resolvedEntitySet: string | undefined;
  if (typeof entitySet === "string" && entitySet !== "") {
    resolvedEntitySet = entitySet;
  } else if (typeof layerId === "number" && Number.isFinite(layerId)) {
    resolvedEntitySet = `Layers(${layerId})/Features`;
  }
  if (resolvedEntitySet === undefined) {
    throw new Error(`createDataset: source "${descriptor.id}" (odata) requires locator.entitySet or locator.layerId`);
  }
  // `locator.url` is informational on the canonical surface; the request
  // path is built from `basePath/<entitySet>`. When `locator.url` carries
  // a path, treat its trailing path component as the basePath so a
  // descriptor pointing at `https://srv/odata/v4` still resolves correctly.
  const basePath = url ? extractOdataBasePath(url) : "/odata";
  return { entitySet: resolvedEntitySet, basePath };
}

function extractOdataBasePath(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = trimTrailingSlashes(parsed.pathname);
    return pathname === "" ? "/odata" : pathname;
  } catch {
    // Relative URL: take it as the basePath verbatim.
    return url.startsWith("/") ? trimTrailingSlashes(url) || "/odata" : `/${trimTrailingSlashes(url)}`;
  }
}

/**
 * Resolve the OData geometry column for a descriptor. Prefers
 * `descriptor.schema.fields` (where a field of type
 * `esriFieldTypeGeometry` names the column), then falls back to the
 * lazy `$metadata` probe (the first property typed `Edm.Geography` /
 * `Edm.Geometry` per CSDL parsing). Returns `undefined` when neither
 * declares one — callers fall back to the canonical name guesses
 * (`Geometry` / `Geography` / `Shape`) where the column name is
 * needed for client-side filtering only (never for emitting a
 * spatial filter, which throws when the column cannot be resolved).
 */
async function resolveOdataGeometryColumn(
  entity: HonuaOdataEntitySet,
  descriptor: SourceDescriptor,
): Promise<string | undefined> {
  const schemaCol = descriptor.schema?.fields?.find((f) => f.type === "esriFieldTypeGeometry")?.name;
  if (schemaCol) return schemaCol;
  try {
    const meta = await entity.metadata();
    const typeName = meta.entitySets[entity.entitySetName];
    const fields = (typeName ? meta.fields[typeName] : undefined) ?? [];
    return fields.find((f) => f.isSpatial)?.name;
  } catch {
    return undefined;
  }
}

/**
 * Split a list of canonical `outFields` into a root `$select` list and
 * an OData `$expand` argument. Plain field names go into `$select`.
 * Dotted field paths (e.g. `Owner.name`) are translated to OData
 * navigation expands such as `Owner($select=name)`. Multi-level paths
 * (e.g. `Owner.address.street`) nest as
 * `Owner($expand=address($select=street))`. Multiple fields under the
 * same navigation share one expand entry
 * (`Owner($select=name,email)`) so the URL stays compact.
 */
function splitOdataOutFields(outFields: ReadonlyArray<string>): { select: string[]; expand: string[] } {
  type Node = { select: string[]; children: Map<string, Node> };
  const root: Node = { select: [], children: new Map() };
  for (const field of outFields) {
    const segments = field.split(".");
    if (segments.length === 1) {
      root.select.push(segments[0]);
      continue;
    }
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      let child = cursor.children.get(seg);
      if (!child) {
        child = { select: [], children: new Map() };
        cursor.children.set(seg, child);
      }
      cursor = child;
    }
    cursor.select.push(segments[segments.length - 1]);
  }
  function serialize(node: Node): string {
    const parts: string[] = [];
    if (node.select.length > 0) parts.push(`$select=${node.select.join(",")}`);
    if (node.children.size > 0) {
      const segs: string[] = [];
      for (const [name, child] of node.children) {
        const inner = serialize(child);
        segs.push(inner === "" ? name : `${name}(${inner})`);
      }
      parts.push(`$expand=${segs.join(",")}`);
    }
    return parts.join(";");
  }
  const expand: string[] = [];
  for (const [name, child] of root.children) {
    const inner = serialize(child);
    expand.push(inner === "" ? name : `${name}(${inner})`);
  }
  return { select: root.select, expand };
}

/**
 * Decide whether a candidate root `outFields` entry refers to the
 * geometry column. When the resolver supplied a column name (from
 * descriptor schema or metadata), match against it directly. The
 * canonical name guesses (`geometry`, `geography`, `shape`) are
 * preserved as a fallback so a server that emits a hard-coded geometry
 * field still drops out of `$select` even when neither schema nor
 * metadata declares one.
 */
function isOdataGeometryFieldName(field: string, resolved: string | undefined): boolean {
  if (resolved && field === resolved) return true;
  if (resolved) return false;
  const lower = field.toLowerCase();
  return lower === "geometry" || lower === "geography" || lower === "shape";
}

/**
 * Build the OData query params for a canonical `Query`. Materializes
 * `$metadata` through the negotiator only when a translation rule needs
 * a geometry column or the key field — otherwise the request stays
 * metadata-free.
 */
async function buildOdataParams<T>(
  entity: HonuaOdataEntitySet,
  descriptor: SourceDescriptor,
  request: Query<T> | undefined,
  options: { count: boolean; geomColumn?: string },
): Promise<HonuaOdataQueryParams> {
  const out: HonuaOdataQueryParams = {};
  if (options.count) out.count = true;
  if (!request) return out;
  const filterParts: string[] = [];
  if (request.where !== undefined && request.where !== "") {
    const rewritten = rewriteWhereToOdataFilter(request.where);
    if (rewritten !== "") filterParts.push(rewritten);
  }
  if (request.spatialFilter) {
    // `$metadata` is advisory here — it only refines the geometry column
    // and SRID context. When it is missing or failing, fall back to the
    // descriptor-derived `geomColumn` and column defaults instead of
    // rejecting the query (same degradation as `resolveOdataGeometryColumn`).
    const meta = await entity.metadata().catch(() => undefined);
    const typeName = meta ? meta.entitySets[entity.entitySetName] : undefined;
    const spatialFields = (typeName && meta ? meta.fields[typeName] : undefined) ?? [];
    // The WKT SRID stamps the **input** literal's coordinate system, not
    // the desired output SR (`Query.outSr` controls the response geometry
    // SR via column-side projection on the server). Derive the input SRID
    // from `spatialFilter.geometry.spatialReference` and fall back to the
    // metadata-declared column SRID; if neither is available, omit the
    // SRID prefix and let the column default apply. The geometry column
    // itself is preferred from `options.geomColumn` (descriptor schema
    // first, then metadata isSpatial) so a schema-declared column named
    // anything other than `Geometry`/`Geography`/`Shape` is honored.
    const ctx: import("../core/odata.js").OdataSpatialFilterContext = {
      ...(options.geomColumn ? { geometryColumn: options.geomColumn } : {}),
      ...(spatialFields.length > 0 ? { geometryFields: spatialFields } : {}),
    };
    filterParts.push(buildOdataSpatialFilter(request.spatialFilter, ctx));
  }
  if (filterParts.length > 0) out.filter = filterParts.join(" and ");
  if (request.outFields && request.outFields.length > 0) {
    const split = splitOdataOutFields(request.outFields);
    let rootSelect = split.select;
    if (request.returnGeometry === false) {
      rootSelect = rootSelect.filter((f) => !isOdataGeometryFieldName(f, options.geomColumn));
    } else if (options.geomColumn && !rootSelect.includes(options.geomColumn)) {
      // OData `$select` is exclusive: once callers project attributes the
      // service omits every unlisted property. Preserve canonical
      // `returnGeometry` (default true) by explicitly retaining the resolved
      // geometry column.
      rootSelect = [...rootSelect, options.geomColumn];
    }
    if (rootSelect.length > 0) out.select = rootSelect;
    if (split.expand.length > 0) out.expand = split.expand;
  } else if (request.returnGeometry === false) {
    // No outFields supplied — derive `$select` from metadata so the
    // geometry column never reaches the wire. Falls through silently
    // when metadata is unavailable; the result-side dropper still
    // strips the geometry from the canonical Result.
    const meta = await entity.metadata().catch(() => undefined);
    if (meta) {
      const typeName = meta.entitySets[entity.entitySetName];
      const allFields = (typeName ? meta.fields[typeName] : undefined) ?? [];
      const nonSpatial = allFields
        .filter((f) => !f.isSpatial && (options.geomColumn === undefined || f.name !== options.geomColumn))
        .map((f) => f.name);
      if (nonSpatial.length > 0) out.select = nonSpatial;
    }
  }
  if (request.orderBy && request.orderBy.length > 0) {
    out.orderBy = request.orderBy.map((s) => (s.direction === "desc" ? `${s.field} desc` : s.field));
  }
  if (request.pagination?.limit !== undefined) out.top = request.pagination.limit;
  if (request.pagination?.offset !== undefined && request.pagination.offset > 0) {
    out.skip = request.pagination.offset;
  }
  if (request.signal) out.signal = request.signal;
  void descriptor;
  return out;
}

function odataResultFromPage<T>(
  descriptor: SourceDescriptor,
  page: HonuaOdataPage<Record<string, unknown>>,
  fields: ReadonlyArray<import("../core/types.js").HonuaFieldInfo>,
  returnGeometry: boolean | undefined,
  geomColumn: string | undefined,
): Result<T> {
  const features = page.rows.map((row) => odataRowToFeature<T>(row, descriptor, returnGeometry, geomColumn));
  const exceededTransferLimit =
    typeof page.totalCount === "number" ? features.length < page.totalCount : Boolean(page.nextLink);
  return {
    features,
    exceededTransferLimit,
    ...(typeof page.totalCount === "number" ? { totalCount: page.totalCount } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };
}

/**
 * Convert one OData JSON row into a canonical `HonuaTypedFeature`. The
 * geometry column (when the row carries one as GeoJSON via Honua Server's
 * spatial encoding) is split out from the attributes envelope. When
 * `returnGeometry === false`, the geometry column is dropped from both
 * the attributes envelope and the `geometry` field — defensive against
 * servers that ignore the `$select` exclusion (or callers that bypassed
 * metadata-derived selects). The geometry column is sourced from the
 * caller-resolved `geomColumn` (descriptor schema → metadata
 * `isSpatial`) and falls back to the canonical name guesses on the
 * row keys when neither declares one.
 */
function odataRowToFeature<T>(
  row: Record<string, unknown>,
  descriptor: SourceDescriptor,
  returnGeometry: boolean | undefined,
  geomColumn: string | undefined,
): import("../core/types.js").HonuaTypedFeature<T> {
  const geometryKey =
    geomColumn ??
    descriptor.schema?.fields?.find((f) => f.type === "esriFieldTypeGeometry")?.name ??
    findGeometryKey(row);
  if (geometryKey && row[geometryKey] !== undefined) {
    const { [geometryKey]: geometry, ...rest } = row;
    return {
      attributes: rest as T,
      geometry: returnGeometry === false ? null : ((geometry ?? null) as Record<string, unknown> | null),
    };
  }
  return { attributes: row as T, geometry: null };
}

function findGeometryKey(row: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(row)) {
    const lower = key.toLowerCase();
    if (lower === "geometry" || lower === "geography" || lower === "shape") return key;
  }
  return undefined;
}

function featureToOdataBody<T>(feature: {
  id?: FeatureId;
  attributes: T;
  geometry?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(feature.attributes as Record<string, unknown>) };
  if (feature.geometry !== undefined && feature.geometry !== null) {
    if (body.Geometry === undefined && body.geometry === undefined) {
      body.Geometry = feature.geometry;
    }
  }
  return body;
}

function readKey(
  body: Record<string, unknown>,
  keyFields: ReadonlyArray<string>,
  fallback: FeatureId | undefined,
): FeatureId | undefined {
  if (keyFields.length === 1) {
    const value = body[keyFields[0]];
    if (typeof value === "number" || typeof value === "string") return value;
  }
  if (keyFields.length > 1) {
    // Composite key: surface as `Field=value,Field=value`. Numeric fallback
    // is preferred when only one of the key parts is OBJECTID-like to keep
    // the EditOutcome.id readable.
    const objectId = body.ObjectId ?? body.objectId ?? body.OBJECTID;
    if (typeof objectId === "number" || typeof objectId === "string") return objectId;
  }
  return fallback;
}

function readKeyFromBody(attributes: unknown, keyFields: ReadonlyArray<string>): FeatureId | undefined {
  if (typeof attributes !== "object" || attributes === null) return undefined;
  return readKey(attributes as Record<string, unknown>, keyFields, undefined);
}

/**
 * For OData navigation paths like `Layers(<n>)/Features`, the parent key
 * (`LayerId`) is already encoded in the URL path — the entity-set key
 * parens should only carry the non-parent components of the composite
 * key. Returns the metadata key fields with the parent-key field removed
 * when the path is layer-scoped, so a caller addressing a row by its
 * bare ObjectId still produces a valid `Features(<objectId>)` URL.
 *
 * Direct paths (e.g. `Parcels`) return the input key fields unchanged.
 */
function urlKeyFields(entitySetPath: string, keyFields: ReadonlyArray<string>): ReadonlyArray<string> {
  if (!/^Layers\(\d+\)\/Features$/i.test(entitySetPath)) return keyFields;
  const filtered = keyFields.filter((f) => f.toLowerCase() !== "layerid");
  // Defense in depth: if filtering eliminates every key field (the
  // metadata declared LayerId-only) fall back to the original list so
  // the formatter at least has something to work with.
  return filtered.length === 0 ? keyFields : filtered;
}

function canonicalKeyToOdata<T>(
  feature: { id?: FeatureId; attributes: T },
  keyFields: ReadonlyArray<string>,
): string | undefined {
  if (keyFields.length === 0) {
    if (feature.id === undefined || feature.id === null) return undefined;
    return formatOdataKeyValue(feature.id);
  }
  if (keyFields.length === 1) {
    const fieldName = keyFields[0];
    const value = (feature.attributes as Record<string, unknown> | undefined)?.[fieldName] ?? feature.id;
    if (value === undefined || value === null) return undefined;
    return formatOdataKeyValue(value as FeatureId);
  }
  // Composite key — prefer attribute-derived components. When `feature.id`
  // is a pre-formatted key expression (`LayerId=1,ObjectId=3` or the bare
  // `1,3` tuple), use it verbatim so callers that address composite-key
  // rows on the canonical `deletes: FeatureId[]` envelope still work.
  if (typeof feature.id === "string" && (feature.id.includes("=") || feature.id.includes(","))) {
    return feature.id;
  }
  const parts: string[] = [];
  for (const fieldName of keyFields) {
    const value = (feature.attributes as Record<string, unknown> | undefined)?.[fieldName];
    if (value === undefined || value === null) {
      // Allow a single-value `feature.id` to fill the ObjectId component
      // when the key is the conventional Honua (LayerId, ObjectId) pair
      // and the caller addressed the row by its bare ObjectId.
      if (fieldName === "ObjectId" && (typeof feature.id === "number" || typeof feature.id === "string")) {
        parts.push(`${fieldName}=${formatOdataKeyValue(feature.id)}`);
        continue;
      }
      return undefined;
    }
    parts.push(`${fieldName}=${formatOdataKeyValue(value as FeatureId)}`);
  }
  return parts.join(",");
}

function formatOdataKeyValue(value: FeatureId): string {
  if (typeof value === "number") return String(value);
  // Strings are quoted; numeric strings stay as numbers because OData's
  // key syntax accepts both for Edm.Int* keys.
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(numeric) === value) return String(numeric);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Lazy, per-source negotiator that fetches `$metadata` exactly once and
 * intersects the declared capability set with what the service actually
 * advertises through `Capabilities.*` annotations. The intersection is
 * surfaced as `HonuaCapabilityNotSupportedError` on the first call that
 * needs the missing capability.
 */
class OdataCapabilityNegotiator {
  private readonly entity: HonuaOdataEntitySet;
  private readonly declared: ReadonlyArray<Capability>;
  private metaPromise: Promise<HonuaOdataMetadata> | undefined;
  private fieldsCache: ReadonlyArray<import("../core/types.js").HonuaFieldInfo> | undefined;

  public constructor(entity: HonuaOdataEntitySet, declared: ReadonlySet<Capability>) {
    this.entity = entity;
    this.declared = [...declared];
  }

  public async ensureAdvertised(descriptor: SourceDescriptor, capability: Capability): Promise<void> {
    // Only check capabilities the descriptor declares — caller-passed
    // narrower sets short-circuit through `ensureCapability` before this
    // is reached.
    if (!this.declared.includes(capability)) return;
    // A missing or failing `$metadata` endpoint is allowed at runtime —
    // degrade to the descriptor's declared capability set instead of
    // rejecting the canonical call, mirroring `fieldsFor` / `keyFields` /
    // `batchAdvertised`. Errors from the data request itself still
    // surface from `query`.
    const meta = await this.materialize().catch(() => undefined);
    if (!meta) return;
    const advertised: HonuaOdataAdvertisedCapabilities = meta.capabilities[this.entity.entitySetName] ?? {};
    const flag = advertisedFlag(advertised, capability);
    if (flag === false) {
      throw new HonuaCapabilityNotSupportedError(capability, descriptor.protocol, descriptor.id);
    }
  }

  public async fieldsFor(_sourceId: SourceId): Promise<ReadonlyArray<import("../core/types.js").HonuaFieldInfo>> {
    void _sourceId;
    if (this.fieldsCache) return this.fieldsCache;
    try {
      const meta = await this.materialize();
      const fields = odataFieldSchema(meta, this.entity.entitySetName);
      this.fieldsCache = fields;
      return fields;
    } catch {
      // A missing `$metadata` endpoint is allowed at runtime — the
      // canonical surface still works, just without the schema in the
      // result envelope. Errors are surfaced from `query` itself so the
      // adapter does not double-throw.
      this.fieldsCache = [];
      return this.fieldsCache;
    }
  }

  public async keyFields(_sourceId: SourceId): Promise<ReadonlyArray<string>> {
    void _sourceId;
    const meta = await this.materialize().catch(() => undefined);
    if (!meta) return [];
    const typeName = meta.entitySets[this.entity.entitySetName];
    if (!typeName) return [];
    return meta.keys[typeName] ?? [];
  }

  /** Return the same single-flight snapshot used by every capability probe. */
  public metadata(): Promise<HonuaOdataMetadata> {
    return this.materialize();
  }

  public async keyField(sourceId: SourceId): Promise<string> {
    const keys = await this.keyFields(sourceId);
    if (keys.length === 1) return keys[0];
    // Composite key: prefer the conventional Honua `ObjectId` field for
    // `queryObjectIds()` so the canonical surface returns a flat
    // `FeatureId[]` instead of composite-key strings.
    if (keys.includes("ObjectId")) return "ObjectId";
    if (keys.length > 0) return keys[0];
    return "ObjectId";
  }

  /**
   * Returns true when the entity-set's `Capabilities.BatchSupported`
   * annotation is `true`, false when explicitly `false`, and true by
   * default when the metadata is unavailable (the OData spec defaults
   * `$batch` to supported when the annotation is absent).
   */
  public async batchAdvertised(): Promise<boolean> {
    const meta = await this.materialize().catch(() => undefined);
    if (!meta) return true;
    const flag = meta.capabilities[this.entity.entitySetName]?.batch;
    return flag !== false;
  }

  private materialize(): Promise<HonuaOdataMetadata> {
    if (!this.metaPromise) {
      this.metaPromise = this.entity.metadata();
    }
    return this.metaPromise;
  }
}

function advertisedFlag(advertised: HonuaOdataAdvertisedCapabilities, capability: Capability): boolean | undefined {
  switch (capability) {
    case "query":
      return advertised.query;
    case "stream":
      return advertised.query;
    case "queryObjectIds":
      return advertised.query;
    case "applyEdits":
      // Treat the union as the canonical "applyEdits" gate — adapters
      // refuse only when every relevant flag is explicitly false.
      if (advertised.insert === false && advertised.update === false && advertised.delete === false) {
        return false;
      }
      return undefined;
    default:
      return undefined;
  }
}

// ── Internal helpers ──────────────────────────────────────────

interface SourceImplementation<T> {
  query(request?: Query<T>): Promise<Result<T>>;
  queryAll(request?: Query<T>): Promise<Result<T>>;
  queryAggregate(request: Query<T> & { aggregation: AggregationSpec }): Promise<Result<T>>;
  queryExtent(request?: Query<T>): Promise<{ extent: import("../core/types.js").HonuaExtent | null; count?: number }>;
  stream(request?: Query<T>): AsyncGenerator<Result<T>, void, undefined>;
  queryObjectIds(request?: Query<T>): Promise<readonly FeatureId[]>;
  applyEdits(envelope: EditEnvelope<T>): Promise<EditResult>;
  queryRelated<R>(request: RelatedQuery): Promise<RelatedResult<R>>;
  attachments: AttachmentApi;
}

function makeSource<T>(
  descriptor: SourceDescriptor,
  caps: ReadonlySet<Capability>,
  _policy: CapabilityPolicy,
  adapters: Partial<Record<AdapterKind, unknown>>,
  impl: SourceImplementation<T>,
): CapabilityAwareSource<T> {
  function lookupAdapter<K extends AdapterKind>(kind: K): AdapterFor<K> | undefined {
    return adapters[kind] as AdapterFor<K> | undefined;
  }
  const source: Source<T> = {
    descriptor: { ...descriptor, capabilities: caps },
    capabilities: caps,
    query: impl.query.bind(impl),
    queryAll: impl.queryAll.bind(impl),
    queryAggregate: impl.queryAggregate.bind(impl),
    queryExtent: impl.queryExtent.bind(impl),
    stream: impl.stream.bind(impl),
    queryObjectIds: impl.queryObjectIds.bind(impl),
    applyEdits: impl.applyEdits.bind(impl),
    queryRelated: impl.queryRelated.bind(impl),
    attachments: impl.attachments,
    protocol: lookupAdapter,
    adapter: lookupAdapter,
  };
  return addCapabilitySupport(source, source.descriptor);
}

/**
 * Helper: build a no-attachment-support `AttachmentApi` whose every method
 * throws `HonuaCapabilityNotSupportedError` for the descriptor. Used by
 * adapters that do not advertise `attachments` so the namespace property
 * is present (callers can always read `source.attachments`) but the calls
 * themselves participate in capability negotiation.
 */
function unsupportedAttachmentApi(descriptor: SourceDescriptor): AttachmentApi {
  const fail = (): never => {
    throw new HonuaCapabilityNotSupportedError("attachments", descriptor.protocol, descriptor.id);
  };
  return {
    async query() {
      return fail();
    },
    async list() {
      return fail();
    },
    async add() {
      return fail();
    },
    async update() {
      return fail();
    },
    async delete() {
      return fail();
    },
  };
}

/**
 * Build a `SourceImplementation` skeleton whose every method throws
 * `HonuaCapabilityNotSupportedError`. Used by the geometry- and gp-service
 * sources, which do not host features and only surface protocol-specific
 * operations through `Source.protocol()`.
 */
function unsupportedFeatureSurface<T>(descriptor: SourceDescriptor): SourceImplementation<T> {
  const fail = (capability: Capability): never => {
    throw new HonuaCapabilityNotSupportedError(capability, descriptor.protocol, descriptor.id);
  };
  return {
    async query() {
      return fail("query");
    },
    async queryAll() {
      return fail("query");
    },
    async queryAggregate() {
      return fail("queryAggregate");
    },
    async queryExtent() {
      return fail("queryExtent");
    },
    // biome-ignore lint/correctness/useYield: utility-only services (Geometry, GP) do not host features; this generator refuses iteration rather than silently complete with no pages
    async *stream() {
      fail("stream");
    },
    async queryObjectIds() {
      return fail("queryObjectIds");
    },
    async applyEdits() {
      return fail("applyEdits");
    },
    async queryRelated() {
      return fail("queryRelated");
    },
    attachments: unsupportedAttachmentApi(descriptor),
  };
}

function ensureCapability(descriptor: SourceDescriptor, caps: ReadonlySet<Capability>, capability: Capability): void {
  if (caps.has(capability)) return;
  throw new HonuaCapabilityNotSupportedError(capability, descriptor.protocol, descriptor.id);
}

// `degraded` may only bypass a missing capability when the call site immediately
// takes a defined fallback path. Returns true when the descriptor advertises the
// capability (use the native path), false when policy is `degraded` and a
// fallback will execute, and throws under `strict` when missing.
function ensureCapabilityOrFallback(
  descriptor: SourceDescriptor,
  caps: ReadonlySet<Capability>,
  capability: Capability,
  policy: CapabilityPolicy,
): boolean {
  if (caps.has(capability)) return true;
  if (policy === "strict") {
    throw new HonuaCapabilityNotSupportedError(capability, descriptor.protocol, descriptor.id);
  }
  return false;
}

function requireFeatureServiceLocator(descriptor: SourceDescriptor): { serviceId: string; layerId: number } {
  const { serviceId, layerId } = descriptor.locator;
  if (typeof serviceId !== "string" || typeof layerId !== "number") {
    throw new Error(
      `createDataset: source "${descriptor.id}" (geoservices-feature-service) requires locator.serviceId and locator.layerId`,
    );
  }
  return { serviceId, layerId };
}

function requireMapServiceLocator(descriptor: SourceDescriptor): { serviceId: string; layerId: number } {
  const { serviceId, layerId } = descriptor.locator;
  if (typeof serviceId !== "string" || typeof layerId !== "number") {
    throw new Error(
      `createDataset: source "${descriptor.id}" (geoservices-map-service) requires locator.serviceId and locator.layerId`,
    );
  }
  return { serviceId, layerId };
}

function requireOgcLocator(descriptor: SourceDescriptor): { collectionId: string | number } {
  const { collectionId } = descriptor.locator;
  if (collectionId === undefined || collectionId === null || collectionId === "") {
    throw new Error(`createDataset: source "${descriptor.id}" (ogc-features) requires locator.collectionId`);
  }
  return { collectionId };
}

/**
 * Map a `SourceLocator.layout` hint onto the OGC API Features endpoint
 * discovery mode. `undefined` / `honua-facade` keep the fixed facade fast
 * path; `ogc-api` and `auto` enable spec-driven landing-page discovery.
 * The STAC-specific modes are not applicable to Features and fall back to
 * the facade.
 */
function ogcFeaturesLayoutMode(layout: SourceLocator["layout"]): "ogc-api" | "auto" | undefined {
  if (layout === "ogc-api") return "ogc-api";
  if (layout === "auto") return "auto";
  return undefined;
}

function requireOgcRecordsLocator(descriptor: SourceDescriptor): { collectionId: string | number } {
  const { collectionId } = descriptor.locator;
  if (collectionId === undefined || collectionId === null || collectionId === "") {
    throw new Error(`createDataset: source "${descriptor.id}" (ogc-records) requires locator.collectionId`);
  }
  return { collectionId };
}

function requireImageServiceLocator(descriptor: SourceDescriptor): { serviceId: string } {
  const { serviceId } = descriptor.locator;
  if (typeof serviceId !== "string") {
    throw new Error(`createDataset: source "${descriptor.id}" (geoservices-image-service) requires locator.serviceId`);
  }
  return { serviceId };
}

/**
 * Reject canonical `Query` fields the ImageServer catalog endpoint cannot
 * honor. The Honua Server catalog handler reads `where` / `objectIds` /
 * `outSR` / `resultOffset` / `resultRecordCount` / `returnGeometry` and
 * silently ignores `outFields`, `geometry` / `geometryType` / `spatialRel`,
 * and `orderByFields`. Refusing the request explicitly prevents callers
 * from receiving an unfiltered, unsorted, or wider result that looks like
 * a silent data quality bug. Mirrors the OGC adapter's spatialFilter /
 * spatialRel guards.
 */
function requireImageServerCompatibleQuery<T>(request?: Query<T>): void {
  if (!request) return;
  if (request.spatialFilter) {
    throw new Error(
      "geoservices-image-service: Query.spatialFilter is not supported on the raster catalog; the ImageServer catalog endpoint does not accept geometry / geometryType / spatialRel filters. During migration, the deprecated source-native Query.where member can constrain the catalog; otherwise call protocol().identify() / exportImage() on the typed escape hatch.",
    );
  }
  if (request.orderBy && request.orderBy.length > 0) {
    throw new Error(
      "geoservices-image-service: Query.orderBy is not supported on the raster catalog; the ImageServer catalog endpoint does not honor orderByFields. Drop orderBy or sort client-side.",
    );
  }
  if (request.outFields && request.outFields.length > 0) {
    throw new Error(
      "geoservices-image-service: Query.outFields is not supported on the raster catalog; the ImageServer catalog endpoint always returns the full catalog row schema. Drop outFields or project client-side.",
    );
  }
}

function requireGPServiceLocator(
  descriptor: SourceDescriptor,
  caps: ReadonlySet<Capability>,
): { serviceId: string; taskName: string | undefined } {
  const { serviceId, taskName } = descriptor.locator;
  if (typeof serviceId !== "string") {
    throw new Error(`createDataset: source "${descriptor.id}" (geoservices-gp-service) requires locator.serviceId`);
  }
  // Honua Server publishes submitJob / jobs / cancel / results only under
  // /rest/services/<serviceId>/GPServer/<taskName>/..., so descriptors that
  // advertise the `geoprocess` capability must carry a task name. Without
  // one the lifecycle routes resolve to non-existent paths on the server.
  if (caps.has("geoprocess") && (typeof taskName !== "string" || taskName.length === 0)) {
    throw new Error(
      `createDataset: source "${descriptor.id}" (geoservices-gp-service) advertises "geoprocess" but locator.taskName is missing; GP lifecycle routes require /GPServer/<taskName>/...`,
    );
  }
  return { serviceId, taskName };
}

function requireOgcTilesLocator(descriptor: SourceDescriptor): {
  collectionId: string | number;
  tileMatrixSetId: string | undefined;
} {
  const { collectionId, tileMatrixSetId } = descriptor.locator;
  if (collectionId === undefined || collectionId === null || collectionId === "") {
    throw new Error(`createDataset: source "${descriptor.id}" (ogc-tiles) requires locator.collectionId`);
  }
  return { collectionId, tileMatrixSetId };
}

function requireWmsLocator(descriptor: SourceDescriptor): { serviceId: string } {
  const { serviceId } = descriptor.locator;
  if (typeof serviceId !== "string" || serviceId.length === 0) {
    throw new Error(`createDataset: source "${descriptor.id}" (wms) requires locator.serviceId`);
  }
  return { serviceId };
}

function requireWmtsLocator(descriptor: SourceDescriptor): { serviceId: string } {
  const { serviceId } = descriptor.locator;
  if (typeof serviceId !== "string" || serviceId.length === 0) {
    throw new Error(`createDataset: source "${descriptor.id}" (wmts) requires locator.serviceId`);
  }
  return { serviceId };
}

function wmsRequireLayers(descriptor: SourceDescriptor, locatorTypeName: string | undefined): readonly string[] {
  const parsed = parseWmsLayerNames(locatorTypeName);
  if (parsed.length === 0) {
    throw new Error(
      `createDataset: source "${descriptor.id}" (wms) requires locator.typeName (the WMS LAYER name) for canonical query()`,
    );
  }
  return parsed;
}

/**
 * Reject canonical `Query` fields that WMS GetFeatureInfo cannot honor so a
 * mixed-source caller does not silently receive an unfiltered, reprojected,
 * or differently-shaped result. WMS GetFeatureInfo only consumes the
 * (i, j) pixel pair plus the rendered envelope; there is no SQL/CQL filter,
 * no field projection, no order, no offset paging, no geometry toggle, and
 * no separate output-SR knob on the wire — honua-server projects the
 * response in the request CRS itself. `aggregation` is mapped to
 * `queryAggregate` so the error carries the same capability vocabulary as
 * the rest of the contract. `pagination.limit` is honored (it maps to
 * `FEATURE_COUNT`).
 */
function requireWmsCompatibleQuery<T>(descriptor: SourceDescriptor, request: Query<T> | undefined): void {
  if (!request) return;
  if (request.aggregation) {
    throw new HonuaCapabilityNotSupportedError("queryAggregate", descriptor.protocol, descriptor.id);
  }
  if (typeof request.where === "string" && request.where.length > 0) {
    throw new Error(
      `wms: Query.where is not supported on GetFeatureInfo for source "${descriptor.id}"; WMS has no SQL/CQL filter on the wire. Pre-filter via Query.spatialFilter (point) or use a tabular protocol.`,
    );
  }
  if (request.outFields && request.outFields.length > 0) {
    throw new Error(
      `wms: Query.outFields is not supported on GetFeatureInfo for source "${descriptor.id}"; the server returns the layer's full attribute schema. Project client-side after the result lands.`,
    );
  }
  if (request.orderBy && request.orderBy.length > 0) {
    throw new Error(
      `wms: Query.orderBy is not supported on GetFeatureInfo for source "${descriptor.id}"; the server has no sort surface. Sort client-side after the result lands.`,
    );
  }
  if (typeof request.pagination?.offset === "number" && request.pagination.offset > 0) {
    throw new Error(
      `wms: Query.pagination.offset is not supported on GetFeatureInfo for source "${descriptor.id}"; the request returns at most FEATURE_COUNT records and does not paginate. Drop pagination.offset.`,
    );
  }
  if (request.returnGeometry === false) {
    throw new Error(
      `wms: Query.returnGeometry=false is not supported on GetFeatureInfo for source "${descriptor.id}"; the server controls geometry inclusion via INFO_FORMAT and the layer template. Drop returnGeometry or strip geometry client-side.`,
    );
  }
  if (request.outSr !== undefined) {
    throw new Error(
      `wms: Query.outSr is not supported on GetFeatureInfo for source "${descriptor.id}"; honua-server projects the response in the request CRS and has no separate output-SR knob. Stamp the spatial filter geometry's spatialReference with the desired CRS instead, or reproject the result client-side.`,
    );
  }
}

/**
 * Extract `(x, y)` and the WMS CRS from `Query.spatialFilter`. WMS only
 * exposes feature-info on a pixel coordinate, so the canonical
 * `Source.query()` is restricted to point spatial filters. The CRS is
 * derived from the geometry's `spatialReference` (`wkid` / `latestWkid` /
 * `wkt`) and falls back to `CRS:84` — the WMS 1.3.0 longitude/latitude
 * code that preserves the canonical `(x, y)` axis order — when the
 * caller did not stamp the geometry with a spatial reference. Non-point
 * geometries throw `HonuaCapabilityNotSupportedError`. `Query.outSr` is
 * intentionally not consulted here: it is the **output** spatial
 * reference for projected results, not the input CRS for the
 * GetFeatureInfo wire request.
 */
function wmsExtractPointFromQuery<T>(
  request: Query<T> | undefined,
  descriptor: SourceDescriptor,
): { x: number; y: number; crs: string } {
  const filter = request?.spatialFilter;
  if (!filter) {
    throw new HonuaCapabilityNotSupportedError("query", descriptor.protocol, descriptor.id);
  }
  const geom = filter.geometry as
    | { x?: unknown; y?: unknown; coordinates?: unknown; spatialReference?: unknown }
    | undefined;
  if (filter.geometryType !== "esriGeometryPoint") {
    throw new HonuaCapabilityNotSupportedError("query", descriptor.protocol, descriptor.id);
  }
  const crs = wmsCrsFromGeometrySpatialReference(geom?.spatialReference);
  if (geom && typeof geom.x === "number" && typeof geom.y === "number") {
    return { x: geom.x, y: geom.y, crs };
  }
  if (geom && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    const [x, y] = geom.coordinates as readonly unknown[];
    if (typeof x === "number" && typeof y === "number") return { x, y, crs };
  }
  throw new HonuaCapabilityNotSupportedError("query", descriptor.protocol, descriptor.id);
}

/**
 * Translate a geometry's `spatialReference` (Esri-style `{ wkid?,
 * latestWkid?, wkt? }`) into a WMS-compatible CRS code. `wkid` /
 * `latestWkid` map to `EPSG:N`. A non-empty `wkt` is passed through
 * verbatim — the server validates it. When no recognizable hint is
 * present the function returns `CRS:84` so the canonical (x, y) axis
 * order is preserved on the wire.
 */
function wmsCrsFromGeometrySpatialReference(spatialReference: unknown): string {
  if (spatialReference && typeof spatialReference === "object") {
    const sr = spatialReference as { wkid?: unknown; latestWkid?: unknown; wkt?: unknown };
    if (typeof sr.latestWkid === "number" && Number.isFinite(sr.latestWkid)) {
      return `EPSG:${sr.latestWkid}`;
    }
    if (typeof sr.wkid === "number" && Number.isFinite(sr.wkid)) {
      return `EPSG:${sr.wkid}`;
    }
    if (typeof sr.wkt === "string" && sr.wkt.trim().length > 0) {
      return sr.wkt.trim();
    }
  }
  return "CRS:84";
}

function toStacRequest<T>(
  request: Query<T> | undefined,
  collectionScope: string | number | undefined,
): StacSearchRequest {
  const out: StacSearchRequest = {};
  if (request?.where !== undefined) {
    out.filter = request.where;
    out.filterLang = "cql2-text";
  }
  if (request?.outFields && request.outFields.length > 0) {
    out.fields = { include: [...request.outFields] };
  }
  if (request?.pagination?.limit !== undefined) out.limit = request.pagination.limit;
  if (request?.pagination?.offset !== undefined) out.offset = request.pagination.offset;
  if (request?.orderBy && request.orderBy.length > 0) {
    out.sortby = request.orderBy.map((s) => `${s.direction === "desc" ? "-" : ""}${s.field}`).join(",");
  }
  if (request?.spatialFilter) {
    if (request.spatialFilter.geometryType !== "esriGeometryEnvelope") {
      throw new Error(
        `stac: spatialFilter.geometryType "${request.spatialFilter.geometryType}" is not supported; only "esriGeometryEnvelope" translates to STAC bbox.`,
      );
    }
    const env = request.spatialFilter.geometry as { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
    if (
      typeof env.xmin === "number" &&
      typeof env.ymin === "number" &&
      typeof env.xmax === "number" &&
      typeof env.ymax === "number"
    ) {
      out.bbox = [env.xmin, env.ymin, env.xmax, env.ymax];
    }
  }
  if (collectionScope !== undefined && collectionScope !== "") {
    out.collections = [String(collectionScope)];
  }
  if (request?.signal) out.signal = request.signal;
  return out;
}

/**
 * Project a STAC API search request onto the client-side filter params a
 * static catalog traversal applies (it has no server-side query grammar).
 */
function toStacStaticParams(request: StacSearchRequest): StacStaticSearchParams {
  const out: StacStaticSearchParams = {};
  if (request.collections && request.collections.length > 0) out.collections = request.collections;
  if (request.bbox) out.bbox = request.bbox;
  if (request.datetime !== undefined) out.datetime = request.datetime;
  if (request.limit !== undefined) out.limit = request.limit;
  if (request.signal) out.signal = request.signal;
  return out;
}

function toTypedFeatureFromStac<T>(feature: HonuaStacItemResponse): HonuaTypedFeature<T> {
  return {
    attributes: (feature.properties ?? {}) as T,
    geometry: feature.geometry as Record<string, unknown> | null,
  };
}

function toOgcRecordsRequest<T>(request?: Query<T>): Omit<OgcRecordsSearchRequest, "collectionId"> {
  if (!request) return {};
  const out: Omit<OgcRecordsSearchRequest, "collectionId"> = {};
  if (request.where !== undefined) {
    out.filter = request.where;
    out.filterLang = "cql2-text";
  }
  if (request.outFields && request.outFields.length > 0) out.properties = [...request.outFields];
  if (request.pagination) {
    if (request.pagination.limit !== undefined) out.limit = request.pagination.limit;
    if (request.pagination.offset !== undefined) out.offset = request.pagination.offset;
  }
  if (request.orderBy && request.orderBy.length > 0) {
    out.sortby = request.orderBy.map((s) => `${s.direction === "desc" ? "-" : ""}${s.field}`).join(",");
  }
  if (request.spatialFilter) {
    if (request.spatialFilter.geometryType !== "esriGeometryEnvelope") {
      throw new Error(
        `ogc-records: spatialFilter.geometryType "${request.spatialFilter.geometryType}" is not supported; only "esriGeometryEnvelope" translates to Records bbox.`,
      );
    }
    const rel = request.spatialFilter.spatialRel;
    if (rel !== undefined && rel !== "esriSpatialRelIntersects" && rel !== "esriSpatialRelEnvelopeIntersects") {
      throw new Error(
        `ogc-records: spatialFilter.spatialRel "${rel}" is not supported; the Records bbox parameter only expresses envelope-intersects.`,
      );
    }
    const env = request.spatialFilter.geometry as { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
    if (
      typeof env.xmin === "number" &&
      typeof env.ymin === "number" &&
      typeof env.xmax === "number" &&
      typeof env.ymax === "number"
    ) {
      out.bbox = [env.xmin, env.ymin, env.xmax, env.ymax];
    }
  }
  if (request.signal) out.signal = request.signal;
  return out;
}

function toTypedFeatureFromOgcRecord<T>(
  feature: import("../core/types.js").HonuaOgcRecordResponse,
): HonuaTypedFeature<T> {
  return {
    attributes: (feature.properties ?? {}) as T,
    geometry: feature.geometry as Record<string, unknown> | null,
  };
}

/**
 * The core paging helpers default `maxPages` to 100, which would silently
 * truncate the canonical `queryAll()` / `stream()` whose contract is to
 * drain until the source is exhausted. Override with
 * `Number.MAX_SAFE_INTEGER` so the helper loop only terminates on an empty
 * page or short page.
 *
 * `normalizeMaxPages` / the inline GeoServices checks require a finite
 * integer, so `Infinity` cannot be used as the sentinel.
 */
function withUnboundedMaxPages<R extends object>(params: R): R & { maxPages: number } {
  return { ...params, maxPages: Number.MAX_SAFE_INTEGER };
}

/**
 * `HonuaFeatureLayer.queryFeaturesAll` / `HonuaMapLayer.queryFeaturesAll` only
 * stop on an empty or short page — they have no total-row cap. When the
 * canonical `Query.pagination.limit` supplies a cap, derive the per-page size
 * *and* `maxPages` from it so the paging loop fetches at most `limit + 1`
 * rows (the extra row lets `applyQueryAllLimit` stamp `exceededTransferLimit`
 * when more records exist). Without this, `queryAll({ pagination: { limit: 1 } })`
 * would keep issuing `resultOffset=0,1,2,…` until the source is drained.
 */
function withPagingBounds<R extends object>(
  params: R,
  limit: number | undefined,
): R & { pageSize?: number; maxPages: number } {
  if (typeof limit !== "number" || limit < 0) {
    return { ...params, maxPages: Number.MAX_SAFE_INTEGER };
  }
  const pageSize = Math.max(1, Math.min(Math.max(limit, 1), 2000));
  const target = limit + 1;
  const maxPages = Math.max(1, Math.ceil(target / pageSize));
  return { ...params, pageSize, maxPages };
}

/**
 * `HonuaFeatureLayer.queryFeaturesStream` / `HonuaMapLayer.queryFeaturesStream`
 * derive per-page size from `pageSize` and default to 2000 when it is
 * omitted. `toFeatureLayerRequest` maps `pagination.limit` to
 * `resultRecordCount`, which the stream helper then overwrites with its own
 * `pageSize`. Without this bridge `source.stream({ pagination: { limit: 10 } })`
 * would still fetch 2000-row pages. Treat `pagination.limit` as the caller's
 * per-batch budget in streaming mode (it carries the same meaning as
 * `resultRecordCount` for a single-page `query()`).
 */
function withStreamPageSize<R extends object>(
  params: R,
  limit: number | undefined,
): R & { pageSize?: number; maxPages: number } {
  const base = { ...params, maxPages: Number.MAX_SAFE_INTEGER };
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return base;
  }
  return { ...base, pageSize: Math.max(1, Math.trunc(limit)) };
}

function applyQueryAllLimit<F>(
  features: readonly F[],
  limit: number | undefined,
): { features: readonly F[]; exceededTransferLimit: boolean } {
  if (typeof limit !== "number" || limit < 0) {
    return { features, exceededTransferLimit: false };
  }
  if (features.length <= limit) {
    return { features, exceededTransferLimit: false };
  }
  return { features: features.slice(0, limit), exceededTransferLimit: true };
}

function toFeatureLayerRequest<T>(request?: Query<T>): {
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  outSr?: string | number;
  orderByFields?: string;
  geometry?: Record<string, unknown>;
  geometryType?: import("../core/types.js").EsriGeometryType;
  spatialRel?: import("../core/types.js").EsriSpatialRel;
  resultOffset?: number;
  resultRecordCount?: number;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  method?: import("../core/types.js").QueryMethod;
} {
  if (!request) return {};
  const out: Record<string, unknown> = {};
  if (request.where !== undefined) out.where = request.where;
  if (request.outFields && request.outFields.length > 0) out.outFields = [...request.outFields];
  if (request.returnGeometry !== undefined) out.returnGeometry = request.returnGeometry;
  if (request.outSr !== undefined) out.outSr = request.outSr;
  if (request.orderBy && request.orderBy.length > 0) {
    out.orderByFields = request.orderBy.map((s) => `${s.field}${s.direction === "desc" ? " DESC" : ""}`).join(",");
  }
  if (request.spatialFilter) {
    out.geometry = request.spatialFilter.geometry;
    out.geometryType = request.spatialFilter.geometryType;
    if (request.spatialFilter.spatialRel) out.spatialRel = request.spatialFilter.spatialRel;
  }
  if (request.pagination) {
    if (request.pagination.offset !== undefined) out.resultOffset = request.pagination.offset;
    if (request.pagination.limit !== undefined) out.resultRecordCount = request.pagination.limit;
  }
  if (request.signal) out.signal = request.signal;
  return out;
}

/**
 * Convert a translated GeoServices request into an extent-only variant. The
 * caller's spatial filter / outSr / signal / orderByFields must survive; only
 * paging and geometry-return are dropped, and `returnExtentOnly=true` is
 * stamped via `extraParams`. The returnCountOnly/ExtentOnly/IdsOnly side
 * channel lives in the untyped `extraParams` bag because it sits outside
 * `QueryFeaturesRequest`.
 */
function toExtentOnlyRequest(
  params: ReturnType<typeof toFeatureLayerRequest>,
): ReturnType<typeof toFeatureLayerRequest> & { returnGeometry: false } {
  const { resultOffset: _offset, resultRecordCount: _count, outFields: _outFields, ...rest } = params;
  void _offset;
  void _count;
  void _outFields;
  return {
    ...rest,
    returnGeometry: false,
    extraParams: {
      ...(rest.extraParams ?? {}),
      returnExtentOnly: true,
    },
  };
}

/**
 * True when the canonical `Query` carries constraints that restrict which
 * records count towards the extent. Used by the degraded OGC fallback to
 * decide whether the collection metadata bbox (unfiltered) is a safe
 * shortcut or whether the extent must be computed client-side over the
 * matching records.
 */
function hasExtentFilter<T>(request?: Query<T>): boolean {
  if (!request) return false;
  if (request.where !== undefined && request.where !== "") return true;
  if (request.spatialFilter) return true;
  return false;
}

function computeExtentFromOgcFeatures(features: ReadonlyArray<import("../core/types.js").HonuaOgcFeatureResponse>): {
  extent: import("../core/types.js").HonuaExtent | null;
  count: number;
} {
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  let saw = false;
  for (const feature of features) {
    visitGeometryCoords(feature.geometry, (x, y) => {
      if (x < xmin) xmin = x;
      if (y < ymin) ymin = y;
      if (x > xmax) xmax = x;
      if (y > ymax) ymax = y;
      saw = true;
    });
  }
  if (!saw) return { extent: null, count: features.length };
  return { extent: { xmin, ymin, xmax, ymax }, count: features.length };
}

function visitGeometryCoords(geometry: unknown, visit: (x: number, y: number) => void): void {
  if (typeof geometry !== "object" || geometry === null) return;
  const geom = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (Array.isArray(geom.geometries)) {
    for (const inner of geom.geometries) visitGeometryCoords(inner, visit);
    return;
  }
  visitCoordinates(geom.coordinates, visit);
}

function visitCoordinates(coords: unknown, visit: (x: number, y: number) => void): void {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    visit(coords[0], coords[1]);
    return;
  }
  for (const inner of coords) visitCoordinates(inner, visit);
}

function extractExtentEnvelope(response: unknown): {
  extent: import("../core/types.js").HonuaExtent | null;
  count?: number;
} {
  if (typeof response !== "object" || response === null) return { extent: null };
  const obj = response as { extent?: unknown; count?: unknown };
  const extent =
    typeof obj.extent === "object" && obj.extent !== null
      ? (obj.extent as import("../core/types.js").HonuaExtent)
      : null;
  const count = typeof obj.count === "number" && Number.isFinite(obj.count) ? obj.count : undefined;
  return { extent, count };
}

function toOgcRequest<T>(request?: Query<T>): Record<string, unknown> {
  if (!request) return {};
  const out: Record<string, unknown> = {};
  if (request.where !== undefined) {
    out.filter = request.where;
    out.filterLang = "cql2-text";
  }
  if (request.outFields && request.outFields.length > 0) out.properties = [...request.outFields];
  if (request.outSr !== undefined) out.crs = String(request.outSr);
  if (request.pagination) {
    if (request.pagination.limit !== undefined) out.limit = request.pagination.limit;
    if (request.pagination.offset !== undefined) out.offset = request.pagination.offset;
  }
  if (request.orderBy && request.orderBy.length > 0) {
    out.sortby = request.orderBy.map((s) => `${s.direction === "desc" ? "-" : ""}${s.field}`).join(",");
  }
  if (request.spatialFilter) {
    // OGC API Features only exposes bbox at /items; arbitrary geometry types
    // would need CQL2 (which this adapter does not yet emit). Refuse the
    // request explicitly instead of silently dropping the constraint and
    // returning unfiltered features, which would look like a silent data
    // quality bug to the caller.
    if (request.spatialFilter.geometryType !== "esriGeometryEnvelope") {
      throw new Error(
        `ogc-features: spatialFilter.geometryType "${request.spatialFilter.geometryType}" is not supported; only "esriGeometryEnvelope" translates to OGC bbox. Convert the geometry to an envelope or use a GeoServices source.`,
      );
    }
    // The OGC bbox parameter is defined as an envelope-intersects predicate
    // (OGC 17-069r4 §7.15.3). `contains`, `within`, `crosses`, etc. would
    // require CQL2 which this adapter does not yet emit. Refuse the request
    // rather than fall back to bbox semantics — a "within" request that
    // silently returns every intersecting feature is a correctness bug.
    const rel = request.spatialFilter.spatialRel;
    if (rel !== undefined && rel !== "esriSpatialRelIntersects" && rel !== "esriSpatialRelEnvelopeIntersects") {
      throw new Error(
        `ogc-features: spatialFilter.spatialRel "${rel}" is not supported; the OGC bbox parameter only expresses envelope-intersects. Use a GeoServices source or convert to an intersects predicate.`,
      );
    }
    const env = request.spatialFilter.geometry as { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
    if (
      typeof env.xmin === "number" &&
      typeof env.ymin === "number" &&
      typeof env.xmax === "number" &&
      typeof env.ymax === "number"
    ) {
      out.bbox = `${env.xmin},${env.ymin},${env.xmax},${env.ymax}`;
    }
  }
  if (request.signal) out.signal = request.signal;
  return out;
}

/**
 * OGC operations that must inspect the full matching record set (`queryAggregate`
 * and degraded `queryExtent`) cannot inherit caller pagination. `limit` /
 * `offset` would silently materialize only a window of the match set and break
 * the whole-result contract those methods promise.
 */
function toOgcMaterializedRequest<T>(request?: Query<T>): Record<string, unknown> {
  const { limit: _limit, offset: _offset, ...out } = toOgcRequest(request);
  void _limit;
  void _offset;
  return out;
}

function featureLayerResultFromTyped<T>(response: HonuaTypedQueryResponse<T>): Result<T> {
  return {
    features: response.features ?? [],
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    fields: response.fields,
  };
}

function featureLayerResultFromUntyped<T>(response: HonuaQueryResponse): Result<T> {
  const features = (response.features ?? []).map(toTypedFeature<T>);
  return {
    features,
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    fields: response.fields,
  };
}

function toTypedFeature<T>(feature: HonuaFeature): HonuaTypedFeature<T> {
  return {
    attributes: feature.attributes as T,
    geometry: feature.geometry,
  };
}

function toTypedFeatureFromOgc<T>(feature: import("../core/types.js").HonuaOgcFeatureResponse): HonuaTypedFeature<T> {
  return {
    attributes: (feature.properties ?? {}) as T,
    geometry: feature.geometry as Record<string, unknown> | null,
  };
}

/**
 * Build the GeoServices aggregation fields that must live on the top-level
 * `QueryFeaturesRequest` / `MapLayerQueryRequest`. Both the REST serializer
 * (`client.ts`) and the gRPC adapter (`grpc-adapter.ts`) read `outStatistics`
 * and `groupByFieldsForStatistics` from the request root; stashing them in
 * `extraParams` would be silently dropped by the gRPC path.
 */
function buildAggregationFields(aggregation: AggregationSpec): {
  outStatistics: ReadonlyArray<Record<string, unknown>>;
  groupByFieldsForStatistics?: string;
  returnGeometry: false;
  aggregateAlias: string | undefined;
} {
  const stats = aggregation.metrics.map((m) => ({
    statisticType: toGeoServicesStatisticType(m.fn),
    onStatisticField: m.field,
    outStatisticFieldName: m.alias ?? `${m.fn}_${m.field}`,
  }));
  const out: {
    outStatistics: ReadonlyArray<Record<string, unknown>>;
    groupByFieldsForStatistics?: string;
    returnGeometry: false;
    aggregateAlias: string | undefined;
  } = {
    outStatistics: stats,
    returnGeometry: false,
    aggregateAlias: stats[0]?.outStatisticFieldName,
  };
  if (aggregation.groupBy && aggregation.groupBy.length > 0) {
    out.groupByFieldsForStatistics = aggregation.groupBy.join(",");
  }
  return out;
}

function toGeoServicesStatisticType(fn: AggregationFn): string {
  switch (fn) {
    case "stddev":
      return "stddev";
    case "var":
      return "var";
    default:
      return fn;
  }
}

function aggregateResultFromFeatureLayer<T>(
  response: HonuaTypedQueryResponse<T>,
  _aggregateAlias: string | undefined,
): Result<T> {
  const aggregateRows = (response.features ?? []).map((f) => f.attributes as Record<string, unknown>);
  return {
    features: [],
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    aggregateRows,
    fields: response.fields,
  };
}

function aggregateResultFromUntyped<T>(response: HonuaQueryResponse, _alias: string | undefined): Result<T> {
  const aggregateRows = (response.features ?? []).map((f) => f.attributes);
  return {
    features: [],
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    aggregateRows,
    fields: response.fields,
  };
}

function clientSideAggregate<T>(
  features: ReadonlyArray<HonuaTypedFeature<T>>,
  aggregation: AggregationSpec,
): Array<Record<string, unknown>> {
  const groupKeys = aggregation.groupBy ?? [];
  if (groupKeys.length === 0) {
    return [computeMetrics(features, aggregation.metrics)];
  }
  const groups = new Map<string, HonuaTypedFeature<T>[]>();
  for (const feature of features) {
    const key = groupKeys.map((field) => String(readField(feature.attributes, field) ?? "")).join("\u0000");
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(feature);
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const bucket of groups.values()) {
    const head = bucket[0];
    const row: Record<string, unknown> = {};
    for (const field of groupKeys) {
      row[field] = readField(head.attributes, field);
    }
    Object.assign(row, computeMetrics(bucket, aggregation.metrics));
    rows.push(row);
  }
  return rows;
}

function computeMetrics<T>(
  features: ReadonlyArray<HonuaTypedFeature<T>>,
  metrics: ReadonlyArray<AggregationMetric>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const metric of metrics) {
    const alias = metric.alias ?? `${metric.fn}_${metric.field}`;
    const values = features
      .map((f) => readField(f.attributes, metric.field))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    out[alias] = applyAggregation(metric.fn, values, features.length);
  }
  return out;
}

function applyAggregation(fn: AggregationFn, values: readonly number[], totalLength: number): number {
  if (fn === "count") return totalLength;
  if (values.length === 0) return 0;
  switch (fn) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "stddev":
    case "var": {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      return fn === "var" ? variance : Math.sqrt(variance);
    }
    default:
      return 0;
  }
}

function readField(attributes: unknown, field: string): unknown {
  if (typeof attributes !== "object" || attributes === null) return undefined;
  return (attributes as Record<string, unknown>)[field];
}

// ── Edit / related / attachment translators ───────────────────

function toApplyEditsRequest<T>(envelope: EditEnvelope<T>): {
  adds?: HonuaFeature[];
  updates?: HonuaFeature[];
  deletes?: number[] | string;
  rollbackOnFailure?: boolean;
  signal?: AbortSignal;
} {
  const out: {
    adds?: HonuaFeature[];
    updates?: HonuaFeature[];
    deletes?: number[] | string;
    rollbackOnFailure?: boolean;
    signal?: AbortSignal;
  } = {};
  if (envelope.adds && envelope.adds.length > 0) {
    out.adds = envelope.adds.map(canonicalToHonuaFeature);
  }
  if (envelope.updates && envelope.updates.length > 0) {
    out.updates = envelope.updates.map(canonicalToHonuaFeature);
  }
  if (envelope.deletes && envelope.deletes.length > 0) {
    const numericIds: number[] = [];
    let allNumeric = true;
    for (const id of envelope.deletes) {
      const parsed = Number(id);
      if (Number.isFinite(parsed)) {
        numericIds.push(parsed);
      } else {
        allNumeric = false;
        break;
      }
    }
    out.deletes = allNumeric ? numericIds : envelope.deletes.map(String).join(",");
  }
  if (envelope.rollbackOnFailure !== undefined) {
    out.rollbackOnFailure = envelope.rollbackOnFailure;
  }
  if (envelope.signal) {
    out.signal = envelope.signal;
  }
  return out;
}

function canonicalToHonuaFeature<T>(feature: {
  id?: FeatureId;
  attributes: T;
  geometry?: Record<string, unknown> | null;
}): HonuaFeature {
  const attributes = { ...(feature.attributes as Record<string, unknown>) };
  // GeoServices addresses updates by `OBJECTID` inside attributes; populate it
  // from the canonical `id` when the caller supplied one but did not embed it
  // in attributes themselves. Skip when an OBJECTID is already present so a
  // mismatch surfaces as a server-side validation error rather than being
  // silently overwritten.
  if (feature.id !== undefined && feature.id !== null && attributes.OBJECTID === undefined) {
    attributes.OBJECTID = feature.id;
  }
  const out: HonuaFeature = { attributes };
  if (feature.geometry !== undefined) {
    out.geometry = feature.geometry;
  }
  return out;
}

function canonicalEditResult(response: import("../core/types.js").HonuaApplyEditsResponse): EditResult {
  return {
    added: (response.addResults ?? []).map(toEditOutcome),
    updated: (response.updateResults ?? []).map(toEditOutcome),
    deleted: (response.deleteResults ?? []).map(toEditOutcome),
  };
}

function toEditOutcome(result: import("../core/types.js").HonuaEditResult): EditOutcome {
  const out: EditOutcome = { success: result.success };
  if (typeof result.objectId === "number" && Number.isFinite(result.objectId)) {
    out.id = result.objectId;
  }
  if (result.error) {
    out.error = { code: result.error.code, description: result.error.description };
  }
  return out;
}

function toRelatedRecordsRequest(request: RelatedQuery): {
  relationshipId: number;
  objectIds?: number[] | string;
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  signal?: AbortSignal;
} {
  const out: {
    relationshipId: number;
    objectIds?: number[] | string;
    where?: string;
    outFields?: string | string[];
    returnGeometry?: boolean;
    signal?: AbortSignal;
  } = { relationshipId: request.relationshipId };
  if (request.sourceIds.length > 0) {
    const numeric: number[] = [];
    let allNumeric = true;
    for (const id of request.sourceIds) {
      const parsed = Number(id);
      if (Number.isFinite(parsed)) numeric.push(parsed);
      else {
        allNumeric = false;
        break;
      }
    }
    out.objectIds = allNumeric ? numeric : request.sourceIds.map(String).join(",");
  }
  if (request.where !== undefined) out.where = request.where;
  if (request.outFields && request.outFields.length > 0) out.outFields = [...request.outFields];
  if (request.returnGeometry !== undefined) out.returnGeometry = request.returnGeometry;
  if (request.signal) out.signal = request.signal;
  return out;
}

function canonicalRelatedResult<R>(response: import("../core/types.js").HonuaRelatedRecordsResponse): RelatedResult<R> {
  const groups: RelatedGroup<R>[] = (response.relatedRecordGroups ?? []).map((g: HonuaRelatedRecordGroup) => ({
    sourceId: g.objectId,
    features: (g.relatedRecords ?? []).map((f) => ({
      attributes: f.attributes as R,
      geometry: f.geometry ?? null,
    })),
  }));
  const out: RelatedResult<R> = { groups };
  if (response.fields) out.fields = response.fields;
  return out;
}

function featureToGeoJsonFeature<T>(feature: {
  id?: FeatureId;
  attributes: T;
  geometry?: Record<string, unknown> | null;
}): {
  type: "Feature";
  id?: FeatureId;
  geometry: Record<string, unknown> | null;
  properties: Record<string, unknown>;
} {
  const out: {
    type: "Feature";
    id?: FeatureId;
    geometry: Record<string, unknown> | null;
    properties: Record<string, unknown>;
  } = {
    type: "Feature",
    geometry: feature.geometry ?? null,
    properties: { ...(feature.attributes as Record<string, unknown>) },
  };
  if (feature.id !== undefined && feature.id !== null) {
    out.id = feature.id;
  }
  return out;
}

function editErrorFromCatch(err: unknown): { code: number; description: string } {
  if (err instanceof HonuaHttpError) {
    return { code: err.statusCode, description: err.message };
  }
  if (err instanceof Error) {
    // Fall back to ad-hoc `status` / `code` / `statusCode` shapes that
    // third-party errors might carry; default to 500 when nothing fits so
    // the per-item EditOutcome still surfaces a numeric code.
    const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown };
    const code =
      typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : typeof candidate.status === "number"
          ? candidate.status
          : typeof candidate.code === "number"
            ? candidate.code
            : 500;
    return { code, description: err.message };
  }
  return { code: 500, description: String(err) };
}

function featureLayerAttachmentApi<T>(
  descriptor: SourceDescriptor,
  caps: ReadonlySet<Capability>,
  layer: HonuaFeatureLayer<T>,
): AttachmentApi {
  function ensureAttachments(): void {
    if (!caps.has("attachments")) {
      throw new HonuaCapabilityNotSupportedError("attachments", descriptor.protocol, descriptor.id);
    }
  }
  return {
    async query(request) {
      ensureAttachments();
      const response = await layer.queryAttachments({
        ...(request?.parentIds
          ? { objectIds: request.parentIds.map(toAttachmentNumericId).filter(isFiniteNumberStrict) }
          : {}),
        ...(request?.where !== undefined ? { where: request.where } : {}),
        ...(request?.signal ? { signal: request.signal } : {}),
      });
      return (response.attachmentGroups ?? []).map((group) => ({
        parentId: group.parentObjectId,
        attachments: (group.attachmentInfos ?? []).map(toAttachmentInfo(group.parentObjectId)),
      })) satisfies ReadonlyArray<AttachmentGroup>;
    },
    async list(parentId, options) {
      ensureAttachments();
      const response = await layer.listAttachments({
        objectId: parentId,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const numericParent = Number(parentId);
      return (response.attachmentInfos ?? []).map(
        toAttachmentInfo(Number.isFinite(numericParent) ? numericParent : (parentId as FeatureId)),
      );
    },
    async add(request) {
      ensureAttachments();
      const response = await layer.addAttachment({
        objectId: request.parentId,
        attachment: request.attachment,
        ...(request.name ? { name: request.name } : {}),
        ...(request.contentType ? { contentType: request.contentType } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return toAttachmentEditOutcome(response.addAttachmentResult, request.parentId);
    },
    async update(request) {
      ensureAttachments();
      const response = await layer.updateAttachment({
        objectId: request.parentId,
        attachmentId: request.attachmentId,
        attachment: request.attachment,
        ...(request.name ? { name: request.name } : {}),
        ...(request.contentType ? { contentType: request.contentType } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return toAttachmentEditOutcome(response.updateAttachmentResult, request.parentId);
    },
    async delete(request) {
      ensureAttachments();
      const numericIds = request.attachmentIds.map(toAttachmentNumericId).filter(isFiniteNumberStrict);
      const response = await layer.deleteAttachments({
        objectId: request.parentId,
        attachmentIds:
          numericIds.length === request.attachmentIds.length ? numericIds : request.attachmentIds.map(String).join(","),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return (response.deleteAttachmentResults ?? []).map((r) => toAttachmentEditOutcome(r, request.parentId));
    },
  };
}

function toAttachmentInfo(parentId: FeatureId): (info: HonuaAttachmentInfo) => AttachmentInfo {
  return (info) => {
    const out: AttachmentInfo = {
      id: info.id,
      parentId: info.parentObjectId ?? parentId,
    };
    if (info.name !== undefined) out.name = info.name;
    if (info.contentType !== undefined) out.contentType = info.contentType;
    if (info.size !== undefined) out.size = info.size;
    return out;
  };
}

function toAttachmentEditOutcome(result: HonuaAttachmentEditResult, parentId?: FeatureId): AttachmentEditOutcome {
  const out: AttachmentEditOutcome = { success: result.success };
  if (parentId !== undefined) out.parentId = parentId;
  if (typeof result.objectId === "number" && Number.isFinite(result.objectId)) {
    out.attachmentId = result.objectId;
  }
  if (result.error) {
    out.error = { code: result.error.code, description: result.error.description };
  }
  return out;
}

function toAttachmentNumericId(id: FeatureId): number {
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isFiniteNumberStrict(n: number): n is number {
  return Number.isFinite(n);
}

// ── Built-in AdapterTypeMap augmentation ──────────────────────

/**
 * Declare the shipped adapter → runtime-class bindings so
 * `Source.adapter("geoservices-feature-service")` et al. narrow to the
 * right class instead of collapsing to `unknown`. Downstream adapter
 * tickets that ship outside this module add their own augmentations in
 * their own modules.
 */
declare module "./types.js" {
  interface AdapterTypeMap {
    "geoservices-feature-service": HonuaFeatureLayer;
    "geoservices-map-service": HonuaMapService;
    "geoservices-map-layer": HonuaMapLayer;
    "geoservices-image-service": HonuaImageService;
    "geoservices-geometry-service": HonuaGeometryService;
    "geoservices-gp-service": HonuaGeoprocessingService;
    "ogc-features": HonuaOgcFeatureCollection;
    "ogc-tiles": HonuaOgcTileset | HonuaOgcTiles;
    "ogc-maps": HonuaOgcMaps | HonuaOgcCollectionMap;
    "ogc-records": HonuaOgcRecordCollection;
    "ogc-processes": HonuaOgcProcesses;
    stac: HonuaStacSearch;
    wfs: HonuaWfsFeatureType;
    wms: HonuaWms;
    "wms-layer": HonuaWmsLayer;
    wmts: HonuaWmts;
    "wmts-layer": HonuaWmtsLayer;
    "wmts-tileset": HonuaWmtsTileset;
    odata: HonuaOdataEntitySet;
    pmtiles: HonuaPmtilesArchive;
  }
}

// ── Re-exports for downstream tickets ─────────────────────────

/** Sentinel: `Capabilities` set that contains every defined capability. */
export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

/** Tag a `Protocol` as "first-party-supported by this build". */
export const FIRST_PARTY_PROTOCOLS: ReadonlySet<Protocol> = new Set([
  "geoservices-feature-service",
  "geoservices-map-service",
  "geoservices-image-service",
  "geoservices-geometry-service",
  "geoservices-gp-service",
  "ogc-features",
  "ogc-tiles",
  "ogc-maps",
  "ogc-records",
  "stac",
  "wfs",
  "wms",
  "wmts",
  "pmtiles",
] as const);
