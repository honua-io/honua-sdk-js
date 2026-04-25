/**
 * Built-in `Source` adapters that wrap the runtime classes in
 * `src/core/surfaces.ts` (`HonuaFeatureLayer`, `HonuaMapLayer`,
 * `HonuaOgcFeatureCollection`). Downstream tickets supply WFS / WMS /
 * OData adapters via `CreateDatasetOptions.resolveSource`.
 *
 * These adapters do not reimplement query logic — they translate the
 * canonical `Query` / `Result` envelope to and from the existing per-class
 * request and response shapes.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { HonuaCapabilityNotSupportedError, HonuaHttpError } from "../core/errors.js";
import { HonuaOgcMaps, HonuaOgcCollectionMap } from "../core/ogc-maps.js";
import type { HonuaOgcProcesses } from "../core/ogc-processes.js";
import { HonuaOgcTiles, HonuaOgcTileset } from "../core/ogc-tiles.js";
import { HonuaStacSearch } from "../core/stac.js";
import {
  HonuaFeatureLayer,
  HonuaImageService,
  HonuaGeometryService,
  HonuaGeoprocessingService,
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
  StacSearchRequest,
} from "../core/types.js";
import {
  CAPABILITIES,
  PROTOCOL_DEFAULT_CAPABILITIES,
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
  type Capability,
  type CapabilityPolicy,
  type CreateDatasetOptions,
  type Dataset,
  type DegradedReason,
  type EditEnvelope,
  type EditOutcome,
  type EditResult,
  type FeatureId,
  type Protocol,
  type Query,
  type RelatedGroup,
  type RelatedQuery,
  type RelatedResult,
  type Result,
  type Source,
  type SourceDescriptor,
  type SourceId,
} from "./types.js";

/**
 * Construct a `Dataset` over one `HonuaClient`. Compatibility is checked
 * once and cached on the client. `Source` handles are constructed lazily.
 */
export function createDataset(options: CreateDatasetOptions): Dataset {
  const { id, client, sources, resolveSource } = options;
  const policy: CapabilityPolicy = options.capabilityPolicy ?? "strict";
  const descriptors = new Map<SourceId, SourceDescriptor>();
  const handles = new Map<SourceId, Source>();
  let compatibilityPromise: Promise<boolean> | undefined;

  for (const descriptor of sources) {
    if (descriptors.has(descriptor.id)) {
      throw new Error(`createDataset: duplicate source id "${descriptor.id}"`);
    }
    descriptors.set(descriptor.id, descriptor);
  }

  function resolve<T>(descriptor: SourceDescriptor): Source<T> {
    const cached = handles.get(descriptor.id);
    if (cached) return cached as Source<T>;

    const built = buildBuiltInSource<T>(descriptor, client, policy)
      ?? resolveSource?.(descriptor, { client, capabilityPolicy: policy }) as Source<T> | undefined;
    if (!built) {
      throw new HonuaCapabilityNotSupportedError(
        "query",
        descriptor.protocol,
        descriptor.id,
      );
    }
    handles.set(descriptor.id, built as Source);
    return built;
  }

  return {
    id,
    client,
    sourceDescriptors: [...descriptors.values()],
    source<T = Record<string, unknown>>(sourceId: SourceId): Source<T> | undefined {
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
        compatibilityPromise = client.checkCompatibility().then((status) => status.supported).catch(() => false);
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
): Source<T> | undefined {
  switch (descriptor.protocol) {
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
    case "stac":
      return stacSearchSource<T>(descriptor, client, policy);
    default:
      return undefined;
  }
}

// ── GeoServices Feature Service ───────────────────────────────

export function geoServicesFeatureSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const { serviceId, layerId } = requireFeatureServiceLocator(descriptor);
  const layer = new HonuaFeatureLayer<T>({ client, serviceId, layerId });
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"];

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
      const stream = layer.queryFeaturesStream(withStreamPageSize(toFeatureLayerRequest(request), request?.pagination?.limit));
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

export function geoServicesMapServiceSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
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
      const stream = layer.queryFeaturesStream(withStreamPageSize(toFeatureLayerRequest(request), request?.pagination?.limit));
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

export function ogcFeaturesSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const { collectionId } = requireOgcLocator(descriptor);
  const collection = new HonuaOgcFeatureCollection({ client, collectionId });
  const root = new HonuaOgcFeatures({ client });
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
          reason: "OGC API Features does not expose server-side aggregation; aggregating client-side over the returned page.",
          protocol: "ogc-features",
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
 */
export function geoServicesImageSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
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
      const response = await service.queryRasterCatalog(
        toExtentOnlyRequest(toFeatureLayerRequest(request)),
      );
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
 */
export function geoServicesGeometryServiceSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
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
 */
export function geoServicesGPServiceSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
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
 */
export function ogcTilesSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const { collectionId, tileMatrixSetId } = requireOgcTilesLocator(descriptor);
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"];

  // Descriptors without a tileMatrixSetId cannot construct a usable
  // HonuaOgcTileset (every tile route requires `tileMatrixSetId`). Expose
  // the root HonuaOgcTiles adapter instead so callers can discover the
  // tilesets the server advertises for the collection before binding one.
  const adapter =
    tileMatrixSetId !== undefined && tileMatrixSetId !== ""
      ? new HonuaOgcTileset({ client, collectionId, tileMatrixSetId })
      : new HonuaOgcTiles({ client });

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {
    "ogc-tiles": adapter,
  };

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, unsupportedFeatureSurface<T>(descriptor));
}

// ── OGC API Maps ──────────────────────────────────────────────

/**
 * Render-only Source adapter for OGC API Maps. Same shape as the Tiles
 * adapter — `Source.protocol("ogc-maps")` exposes the runtime class for
 * server-rendered map images; the canonical query family throws.
 */
export function ogcMapsSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const root = new HonuaOgcMaps({ client });
  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = {};
  if (descriptor.locator.collectionId !== undefined) {
    adapterRegistry["ogc-maps"] = new HonuaOgcCollectionMap({
      client,
      collectionId: descriptor.locator.collectionId,
      styleId: descriptor.locator.styleId,
    });
  } else {
    adapterRegistry["ogc-maps"] = root;
  }
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES["ogc-maps"];

  return makeSource<T>(descriptor, caps, policy, adapterRegistry, unsupportedFeatureSurface<T>(descriptor));
}

// ── STAC API ──────────────────────────────────────────────────

export function stacSearchSource<T>(
  descriptor: SourceDescriptor,
  client: HonuaClient,
  policy: CapabilityPolicy,
): Source<T> {
  const stac = new HonuaStacSearch({ client });
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
      const response = await stac.search(stacRequest);
      const features = (response.features ?? []).map(toTypedFeatureFromStac<T>);
      const totalCount = response.numberMatched ?? response.context?.matched;
      const exceededTransferLimit =
        totalCount !== undefined && features.length < totalCount;
      return {
        features,
        exceededTransferLimit,
        totalCount,
      } satisfies Result<T>;
    },
    async queryAll(request) {
      ensureCapability(descriptor, caps, "query");
      const limit = request?.pagination?.limit;
      const items = await stac.searchAll({
        ...toStacRequest(request, collectionScope),
        pageSize: limit !== undefined ? Math.max(1, limit) : undefined,
        maxPages: Number.MAX_SAFE_INTEGER,
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
      // the matching items and project the GeoJSON `id`. Callers that need
      // a bounded scan should pass `pagination.limit`.
      const limit = request?.pagination?.limit;
      const items = await stac.searchAll({
        ...toStacRequest(request, collectionScope),
        pageSize: limit !== undefined ? Math.max(1, limit) : undefined,
        maxPages: Number.MAX_SAFE_INTEGER,
      });
      const ids: FeatureId[] = [];
      for (const item of items) {
        if (item.id !== undefined && item.id !== null) {
          ids.push(item.id as FeatureId);
        }
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
): Source<T> {
  function lookupAdapter<K extends AdapterKind>(kind: K): AdapterFor<K> | undefined {
    return adapters[kind] as AdapterFor<K> | undefined;
  }
  return {
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

function ensureCapability(
  descriptor: SourceDescriptor,
  caps: ReadonlySet<Capability>,
  capability: Capability,
): void {
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

function requireImageServiceLocator(descriptor: SourceDescriptor): { serviceId: string } {
  const { serviceId } = descriptor.locator;
  if (typeof serviceId !== "string") {
    throw new Error(
      `createDataset: source "${descriptor.id}" (geoservices-image-service) requires locator.serviceId`,
    );
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
      "geoservices-image-service: Query.spatialFilter is not supported on the raster catalog; the ImageServer catalog endpoint does not accept geometry / geometryType / spatialRel filters. Use Query.where to constrain the catalog or call protocol().identify() / exportImage() on the typed escape hatch.",
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
    throw new Error(
      `createDataset: source "${descriptor.id}" (geoservices-gp-service) requires locator.serviceId`,
    );
  }
  // Honua Server publishes submitJob / jobs / cancel / results only under
  // /rest/services/<serviceId>/GPServer/<taskName>/..., so descriptors that
  // advertise the `geoprocess` capability must carry a task name. Without
  // one the lifecycle routes resolve to non-existent paths on the server.
  // Descriptors with only `connect` (service-root metadata probe) may omit
  // taskName.
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

function toTypedFeatureFromStac<T>(feature: HonuaStacItemResponse): HonuaTypedFeature<T> {
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
    out.orderByFields = request.orderBy
      .map((s) => `${s.field}${s.direction === "desc" ? " DESC" : ""}`)
      .join(",");
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

function computeExtentFromOgcFeatures(
  features: ReadonlyArray<import("../core/types.js").HonuaOgcFeatureResponse>,
): { extent: import("../core/types.js").HonuaExtent | null; count: number } {
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
  if (request.where !== undefined) out.filter = request.where;
  if (request.outFields && request.outFields.length > 0) out.properties = [...request.outFields];
  if (request.outSr !== undefined) out.crs = String(request.outSr);
  if (request.pagination) {
    if (request.pagination.limit !== undefined) out.limit = request.pagination.limit;
    if (request.pagination.offset !== undefined) out.offset = request.pagination.offset;
  }
  if (request.orderBy && request.orderBy.length > 0) {
    out.sortby = request.orderBy
      .map((s) => `${s.direction === "desc" ? "-" : ""}${s.field}`)
      .join(",");
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
    out.adds = envelope.adds.map((f) => canonicalToHonuaFeature(f));
  }
  if (envelope.updates && envelope.updates.length > 0) {
    out.updates = envelope.updates.map((f) => canonicalToHonuaFeature(f));
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

function canonicalToHonuaFeature<T>(feature: { id?: FeatureId; attributes: T; geometry?: Record<string, unknown> | null }): HonuaFeature {
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

function featureToGeoJsonFeature<T>(feature: { id?: FeatureId; attributes: T; geometry?: Record<string, unknown> | null }): {
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
        ...(request?.parentIds ? { objectIds: request.parentIds.map(toAttachmentNumericId).filter(isFiniteNumberStrict) } : {}),
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
        attachmentIds: numericIds.length === request.attachmentIds.length ? numericIds : request.attachmentIds.map(String).join(","),
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
 * tickets (WFS / WMS / OData) add their own augmentations in their own
 * modules.
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
    "ogc-processes": HonuaOgcProcesses;
    stac: HonuaStacSearch;
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
  "stac",
] as const);
