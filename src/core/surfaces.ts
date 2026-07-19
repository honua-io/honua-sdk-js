import { HonuaJobPollTimeoutError, isJobTerminal } from "../contract/jobs.js";
import type {
  IJobRun,
  JobError,
  JobProgress,
  JobResult,
  JobResultsOptions,
  JobSnapshot,
  JobSnapshotListener,
  JobStatus,
} from "../contract/jobs.js";
import {
  FEATURE_SERVER_H3_SPATIAL_AGGREGATION_INDEX_MODEL_ID,
  SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION,
  SPATIAL_AGGREGATION_SCHEMA_VERSION,
  assertFeatureServerH3SpatialAggregationRequest,
  spatialAggregationWidgets,
} from "../contract/spatial-aggregation.js";
import type {
  SpatialAggregationCell,
  SpatialAggregationRequest,
  SpatialAggregationResult,
  SpatialAggregationSummaryBag,
  SpatialAggregationSummaryMetadata,
  SpatialAggregationSummarySpec,
  SpatialAggregationSummaryValue,
} from "../contract/spatial-aggregation.js";
import type { SourceId } from "../contract/types.js";
import type { HonuaMetadataRequestOptions } from "./cache-state.js";
import type { HonuaClient } from "./client.js";
import { HonuaCapabilityNotSupportedError } from "./errors.js";
import type { OgcApiLayoutMode } from "./ogc-endpoint-layout.js";
import { encodeServiceIdPath } from "./path-utils.js";
import type {
  ApplyEditsRequest,
  ExportMapRequest,
  HonuaAddAttachmentResponse,
  HonuaApplyEditsResponse,
  HonuaAttachmentListResponse,
  HonuaDeleteAttachmentsResponse,
  HonuaExportMapResponse,
  HonuaExtent,
  HonuaFeature,
  HonuaFindResponse,
  HonuaIdentifyResponse,
  HonuaLayerMetadata,
  HonuaLegendResponse,
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcFeatureCollectionResponse,
  HonuaOgcFeatureResponse,
  HonuaOgcLandingResponse,
  HonuaOgcQueryablesResponse,
  HonuaQueryAttachmentsResponse,
  HonuaQueryResponse,
  HonuaRawRequest,
  HonuaRelatedRecordsResponse,
  HonuaServiceMetadata,
  HonuaTypedFeature,
  HonuaTypedQueryResponse,
  HonuaUpdateAttachmentResponse,
  MapFindRequest,
  MapIdentifyRequest,
  MapLayerQueryRequest,
  MapLegendRequest,
  MapRelatedRecordsRequest,
  OgcCollectionRequest,
  OgcCreateItemRequest,
  OgcDeleteItemRequest,
  OgcEndpointLayout,
  OgcItemRequest,
  OgcItemsRequest,
  OgcMetadataRequest,
  OgcPatchItemRequest,
  OgcReplaceItemRequest,
  QueryFeaturesRequest,
  QueryMethod,
  QueryRelatedRecordsRequest,
} from "./types.js";
import { responseExceededTransferLimit } from "./wire-shared.js";

export interface HonuaServiceOptions {
  client: HonuaClient;
  serviceId: string;
}

export type HonuaServiceRequest = Omit<HonuaRawRequest, "path"> & {
  path: string;
};

export type HonuaFeatureLayerQueryRequest = Omit<QueryFeaturesRequest, "serviceId" | "layerId">;
export type HonuaFeatureLayerQueryAllRequest = HonuaFeatureLayerQueryRequest & {
  pageSize?: number;
  maxPages?: number;
};
export type HonuaFeatureLayerQueryCountRequest = Pick<QueryFeaturesRequest, "where" | "method"> & {
  extraParams?: Record<string, string | number | boolean>;
};
export type HonuaFeatureLayerQueryObjectIdsRequest = HonuaFeatureLayerQueryRequest;
export type HonuaFeatureLayerQueryExtentRequest = HonuaFeatureLayerQueryCountRequest;
export type HonuaFeatureLayerSpatialAggregationRequest = Omit<SpatialAggregationRequest, "sourceId"> & {
  sourceId?: SourceId;
  method?: Extract<QueryMethod, "GET" | "POST">;
  responseFormat?: "json" | "pjson";
  kRingDistance?: number;
};
export type HonuaFeatureLayerQueryRelatedRecordsRequest = Omit<QueryRelatedRecordsRequest, "serviceId" | "layerId">;
export type HonuaFeatureLayerApplyEditsRequest = Omit<ApplyEditsRequest, "serviceId" | "layerId">;
export interface HonuaFeatureLayerQueryExtentResponse {
  extent: HonuaExtent | null;
  count?: number;
}
export interface HonuaFeatureLayerQueryAttachmentsRequest {
  objectIds?: readonly number[] | string;
  where?: string;
  method?: QueryMethod;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}
export interface HonuaFeatureLayerListAttachmentsRequest {
  objectId: number | string;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}
export interface HonuaFeatureLayerDeleteAttachmentsRequest {
  objectId: number | string;
  attachmentIds: readonly number[] | string;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}
export type HonuaFeatureLayerAttachmentData = Blob | File | string;
export interface HonuaFeatureLayerAddAttachmentRequest {
  objectId: number | string;
  attachment: HonuaFeatureLayerAttachmentData;
  name?: string;
  contentType?: string;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}
export interface HonuaFeatureLayerUpdateAttachmentRequest extends HonuaFeatureLayerAddAttachmentRequest {
  attachmentId: number | string;
}
export type HonuaFeatureLayerRequest = Omit<HonuaRawRequest, "path"> & {
  path: string;
};
export type HonuaMapServiceExportMapRequest = Omit<ExportMapRequest, "serviceId">;
export type HonuaMapServiceLegendRequest = Omit<MapLegendRequest, "serviceId">;
export type HonuaMapServiceIdentifyRequest = Omit<MapIdentifyRequest, "serviceId">;
export type HonuaMapServiceFindRequest = Omit<MapFindRequest, "serviceId">;
export type HonuaMapServiceRequest = Omit<HonuaRawRequest, "path"> & {
  path: string;
};
export type HonuaMapServiceQueryLayerRequest = Omit<MapLayerQueryRequest, "serviceId">;
export type HonuaMapServiceQueryLayerAllRequest = HonuaMapServiceQueryLayerRequest & {
  pageSize?: number;
  maxPages?: number;
};
export type HonuaMapServiceQueryLayerRelatedRecordsRequest = Omit<MapRelatedRecordsRequest, "serviceId">;
export type HonuaMapServiceQueryLayerCountRequest = Pick<MapLayerQueryRequest, "layerId" | "where" | "method"> & {
  extraParams?: Record<string, string | number | boolean>;
};
export type HonuaMapServiceQueryLayerObjectIdsRequest = Pick<MapLayerQueryRequest, "layerId" | "where" | "method"> & {
  extraParams?: Record<string, string | number | boolean>;
};
export type HonuaMapServiceQueryLayerExtentRequest = HonuaMapServiceQueryLayerCountRequest;
export interface HonuaMapServiceQueryLayerExtentResponse {
  extent: HonuaExtent | null;
  count?: number;
}
export type HonuaMapLayerQueryRequest = Omit<MapLayerQueryRequest, "serviceId" | "layerId">;
export type HonuaMapLayerQueryAllRequest = HonuaMapLayerQueryRequest & {
  pageSize?: number;
  maxPages?: number;
};
export type HonuaMapLayerQueryRelatedRecordsRequest = Omit<MapRelatedRecordsRequest, "serviceId" | "layerId">;
export type HonuaMapLayerQueryCountRequest = Pick<MapLayerQueryRequest, "where" | "method"> & {
  extraParams?: Record<string, string | number | boolean>;
};
export type HonuaMapLayerQueryObjectIdsRequest = HonuaMapLayerQueryRequest;
export type HonuaMapLayerQueryExtentRequest = HonuaMapLayerQueryCountRequest;
export interface HonuaMapLayerQueryExtentResponse {
  extent: HonuaExtent | null;
  count?: number;
}
export type HonuaMapLayerRequest = Omit<HonuaRawRequest, "path"> & {
  path: string;
};
export type HonuaOgcMetadataRequest = OgcMetadataRequest;
export type HonuaOgcCollectionRequest = OgcCollectionRequest;
export type HonuaOgcItemsRequest = OgcItemsRequest;
export type HonuaOgcItemRequest = OgcItemRequest;
export type HonuaOgcCreateItemRequest = OgcCreateItemRequest;
export type HonuaOgcReplaceItemRequest = OgcReplaceItemRequest;
export type HonuaOgcPatchItemRequest = OgcPatchItemRequest;
export type HonuaOgcDeleteItemRequest = OgcDeleteItemRequest;
export type HonuaOgcCollectionItemsRequest = Omit<OgcItemsRequest, "collectionId">;
export type HonuaOgcItemsAllRequest = HonuaOgcItemsRequest & {
  pageSize?: number;
  maxPages?: number;
};
export type HonuaOgcCollectionItemsAllRequest = HonuaOgcCollectionItemsRequest & {
  pageSize?: number;
  maxPages?: number;
};
export type HonuaOgcCollectionItemRequest = Omit<OgcItemRequest, "collectionId">;
export type HonuaOgcCollectionCreateItemRequest = Omit<OgcCreateItemRequest, "collectionId">;
export type HonuaOgcCollectionReplaceItemRequest = Omit<OgcReplaceItemRequest, "collectionId">;
export type HonuaOgcCollectionPatchItemRequest = Omit<OgcPatchItemRequest, "collectionId">;
export type HonuaOgcCollectionDeleteItemRequest = Omit<OgcDeleteItemRequest, "collectionId">;

export class HonuaService {
  public readonly client: HonuaClient;
  public readonly serviceId: string;

  public constructor(options: HonuaServiceOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
  }

  public featureLayer<T = Record<string, unknown>>(layerId: number): HonuaFeatureLayer<T> {
    return new HonuaFeatureLayer<T>({
      client: this.client,
      serviceId: this.serviceId,
      layerId,
    });
  }

  public layer<T = Record<string, unknown>>(layerId: number): HonuaFeatureLayer<T> {
    return this.featureLayer<T>(layerId);
  }

  public async featureServiceMetadata(options: HonuaMetadataRequestOptions = {}): Promise<HonuaServiceMetadata> {
    return this.client.getFeatureServiceMetadata(this.serviceId, options);
  }

  public async mapServiceMetadata(options: HonuaMetadataRequestOptions = {}): Promise<HonuaServiceMetadata> {
    return this.client.getMapServiceMetadata(this.serviceId, options);
  }

  public async featureLayerIds(): Promise<number[]> {
    const metadata = await this.featureServiceMetadata();
    return extractLayerIds(metadata);
  }

  public async featureLayers(): Promise<HonuaFeatureLayer[]> {
    const ids = await this.featureLayerIds();
    return ids.map(
      (layerId) =>
        new HonuaFeatureLayer({
          client: this.client,
          serviceId: this.serviceId,
          layerId,
        }),
    );
  }

  public async mapLayerIds(): Promise<number[]> {
    const metadata = await this.mapServiceMetadata();
    return extractLayerIds(metadata);
  }

  public async mapLayers(): Promise<HonuaMapLayer[]> {
    const ids = await this.mapLayerIds();
    return ids.map(
      (layerId) =>
        new HonuaMapLayer({
          client: this.client,
          serviceId: this.serviceId,
          layerId,
        }),
    );
  }

  public async request<T = unknown>(request: HonuaServiceRequest): Promise<T> {
    return this.client.request<T>({
      ...request,
      path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/${normalizeServicePath(request.path)}`,
    });
  }

  public mapService(): HonuaMapService {
    return new HonuaMapService({
      client: this.client,
      serviceId: this.serviceId,
    });
  }

  public mapLayer(layerId: number): HonuaMapLayer {
    return new HonuaMapLayer({
      client: this.client,
      serviceId: this.serviceId,
      layerId,
    });
  }
}

export interface HonuaFeatureLayerOptions {
  client: HonuaClient;
  serviceId: string;
  layerId: number;
}

export class HonuaFeatureLayer<T = Record<string, unknown>> {
  public readonly client: HonuaClient;
  public readonly serviceId: string;
  public readonly layerId: number;

  public constructor(options: HonuaFeatureLayerOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
    this.layerId = options.layerId;
  }

  public async metadata(options: HonuaMetadataRequestOptions = {}): Promise<HonuaLayerMetadata> {
    return this.client.getLayerMetadata(this.serviceId, this.layerId, options);
  }

  public createQuery(): HonuaFeatureLayerQueryRequest {
    return {
      where: "1=1",
      outFields: ["*"],
      returnGeometry: true,
    };
  }

  public async queryFeatures(request: HonuaFeatureLayerQueryRequest = {}): Promise<HonuaTypedQueryResponse<T>> {
    return this.client.queryFeatures({
      serviceId: this.serviceId,
      layerId: this.layerId,
      ...request,
    }) as Promise<HonuaTypedQueryResponse<T>>;
  }

  public async queryFeaturesAll(request: HonuaFeatureLayerQueryAllRequest = {}): Promise<HonuaTypedFeature<T>[]> {
    const pageSize =
      typeof request.pageSize === "number" && Number.isFinite(request.pageSize)
        ? Math.max(1, Math.trunc(request.pageSize))
        : 2000;
    const maxPages =
      typeof request.maxPages === "number" && Number.isFinite(request.maxPages)
        ? Math.max(1, Math.trunc(request.maxPages))
        : 100;
    const startingOffset = normalizeOffset(request.resultOffset);

    const features: HonuaTypedFeature<T>[] = [];
    let offset = startingOffset;
    // Advance the page cursor through the top-level `resultOffset` /
    // `resultRecordCount` fields on `QueryFeaturesRequest`, not
    // `extraParams`. The REST mapper (`queryFeaturesRest`) honors both
    // identically, but the gRPC-web request mapper (`toProtoQueryRequest`)
    // only ever reads the top-level fields; nesting the cursor under
    // `extraParams` silently dropped it on the gRPC transport and made every
    // page repeat page one for a full/exact-page result set (issue #663).
    let previousPageSignature: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        // Strip any caller-supplied `extraParams.resultOffset` /
        // `resultRecordCount` so it cannot silently win over the computed
        // top-level cursor on the wire (`appendQueryExtraParams` applies
        // `extraParams` after the top-level fields on the REST transport).
        extraParams: withoutPagingExtraParams(request.extraParams),
        resultOffset: offset,
        resultRecordCount: pageSize,
      });

      const pageFeatures = response.features ?? [];
      if (pageFeatures.length === 0) {
        break;
      }

      if (this.client.isGrpcWeb) {
        // Defense in depth (REQ-002): even with the cursor now threaded
        // through the field the gRPC mapper actually reads, fail closed
        // rather than loop if a server implementation still returns an
        // identical page after the offset advanced (e.g. a nonconforming
        // gRPC facade that ignores `resultOffset`). Looping here previously
        // meant an unbounded repeat of the first page for exact-page-boundary
        // result sets.
        const signature = grpcPageOffsetSignature(response, pageFeatures);
        if (previousPageSignature !== undefined && signature === previousPageSignature) {
          throw new HonuaCapabilityNotSupportedError("queryAll", "grpc", `${this.serviceId}/${this.layerId}`, {
            context: {
              reason:
                "gRPC transport returned an identical page after resultOffset advanced; gRPC-aware pagination cannot be honored for this request.",
              resultOffset: offset,
            },
          });
        }
        previousPageSignature = signature;
      }

      features.push(...pageFeatures);
      offset += pageFeatures.length;
      if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) {
        break;
      }
    }

    return features;
  }

  public async *queryFeaturesStream(
    request: HonuaFeatureLayerQueryAllRequest = {},
  ): AsyncGenerator<HonuaTypedFeature<T>[], void, undefined> {
    const pageSize =
      typeof request.pageSize === "number" && Number.isFinite(request.pageSize)
        ? Math.max(1, Math.trunc(request.pageSize))
        : 2000;
    const maxPages =
      typeof request.maxPages === "number" && Number.isFinite(request.maxPages)
        ? Math.max(1, Math.trunc(request.maxPages))
        : 100;
    const startingOffset = normalizeOffset(request.resultOffset);

    // Use server streaming RPC when gRPC-Web transport is active
    if (this.client.isGrpcWeb) {
      const { pageSize: _pageSize, maxPages: _maxPages, ...queryRequest } = request;
      let pageCount = 0;
      const stream = this.client.queryFeaturesStream({
        serviceId: this.serviceId,
        layerId: this.layerId,
        ...queryRequest,
        resultRecordCount: queryRequest.resultRecordCount ?? pageSize,
      }) as AsyncGenerator<HonuaTypedFeature<T>[], void, undefined>;

      for await (const page of stream) {
        yield page;
        pageCount += 1;
        if (pageCount >= maxPages) {
          break;
        }
      }
      return;
    }

    let offset = startingOffset;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: offset,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = response.features ?? [];
      if (pageFeatures.length === 0) {
        break;
      }

      yield pageFeatures;
      offset += pageFeatures.length;
      if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) {
        break;
      }
    }
  }

  public async queryFeatureCount(request: HonuaFeatureLayerQueryCountRequest = {}): Promise<number> {
    const response = await this.client.queryFeatures({
      serviceId: this.serviceId,
      layerId: this.layerId,
      where: request.where ?? "1=1",
      returnGeometry: false,
      outFields: "OBJECTID",
      method: request.method,
      extraParams: {
        returnCountOnly: true,
        ...request.extraParams,
      },
    });

    if (isObject(response) && typeof response.count === "number" && Number.isFinite(response.count)) {
      return response.count;
    }
    if (isObject(response) && Array.isArray(response.features)) {
      return response.features.length;
    }
    return 0;
  }

  public async queryObjectIds(request: HonuaFeatureLayerQueryObjectIdsRequest = {}): Promise<number[]> {
    const response = await this.client.queryFeatures({
      ...request,
      serviceId: this.serviceId,
      layerId: this.layerId,
      where: request.where ?? "1=1",
      returnGeometry: false,
      outFields: request.outFields ?? "OBJECTID",
      extraParams: {
        returnIdsOnly: true,
        ...request.extraParams,
      },
    });

    if (isObject(response) && Array.isArray(response.objectIds)) {
      return response.objectIds
        .map((value) => Number(value))
        .filter((value): value is number => Number.isFinite(value));
    }
    return [];
  }

  public async queryExtent(
    request: HonuaFeatureLayerQueryExtentRequest = {},
  ): Promise<HonuaFeatureLayerQueryExtentResponse> {
    const response = await this.client.queryFeatures({
      serviceId: this.serviceId,
      layerId: this.layerId,
      where: request.where ?? "1=1",
      returnGeometry: false,
      method: request.method,
      extraParams: {
        returnExtentOnly: true,
        ...request.extraParams,
      },
    });

    return extractExtentFromResponse(response);
  }

  public async querySpatialAggregation(
    request: HonuaFeatureLayerSpatialAggregationRequest,
  ): Promise<SpatialAggregationResult> {
    const sourceId = request.sourceId ?? defaultFeatureLayerSourceId(this.serviceId, this.layerId);
    const normalizedRequest: SpatialAggregationRequest = {
      ...request,
      sourceId,
    };
    assertFeatureServerH3SpatialAggregationRequest(normalizedRequest);

    const plan = createFeatureServerH3AggregationPlan(normalizedRequest, request.kRingDistance);
    const path = `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/queryH3`;
    const method = request.method ?? "POST";
    const response =
      method === "GET"
        ? await this.client.request<HonuaQueryResponse>({
            method,
            path,
            responseFormat: request.responseFormat ?? "json",
            query: plan.params,
            signal: request.signal,
          })
        : await this.client.request<HonuaQueryResponse>({
            method,
            path,
            responseFormat: request.responseFormat ?? "json",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: toFormBody(plan.params),
            signal: request.signal,
          });

    return featureServerH3AggregationResultFromResponse(response, normalizedRequest, plan);
  }

  public async queryRelatedRecords(
    request: HonuaFeatureLayerQueryRelatedRecordsRequest,
  ): Promise<HonuaRelatedRecordsResponse> {
    return this.client.queryRelatedRecords({
      serviceId: this.serviceId,
      layerId: this.layerId,
      ...request,
    });
  }

  public async queryRelatedFeatures(
    request: HonuaFeatureLayerQueryRelatedRecordsRequest,
  ): Promise<HonuaRelatedRecordsResponse> {
    return this.queryRelatedRecords(request);
  }

  public async applyEdits(request: HonuaFeatureLayerApplyEditsRequest): Promise<HonuaApplyEditsResponse> {
    return this.client.applyEdits({
      serviceId: this.serviceId,
      layerId: this.layerId,
      ...request,
    });
  }

  public async queryAttachments(
    request: HonuaFeatureLayerQueryAttachmentsRequest = {},
  ): Promise<HonuaQueryAttachmentsResponse> {
    const method: QueryMethod = request.method ?? "GET";
    const path =
      `/rest/services/${encodeServiceIdPath(this.serviceId)}` + `/FeatureServer/${this.layerId}/queryAttachments`;
    const query = {
      ...(request.objectIds === undefined
        ? {}
        : {
            objectIds: normalizeObjectIds(request.objectIds),
          }),
      ...(request.where === undefined ? {} : { where: request.where }),
      ...(request.extraParams ?? {}),
    };

    if (method === "GET") {
      return this.client.request({
        method: "GET",
        path,
        responseFormat: request.responseFormat ?? "json",
        query,
        signal: request.signal,
      }) as Promise<HonuaQueryAttachmentsResponse>;
    }

    const body = toFormBody({
      f: request.responseFormat ?? "json",
      ...query,
    });
    return this.client.request({
      method: "POST",
      path,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: request.signal,
    }) as Promise<HonuaQueryAttachmentsResponse>;
  }

  public async listAttachments(request: HonuaFeatureLayerListAttachmentsRequest): Promise<HonuaAttachmentListResponse> {
    return this.client.request({
      method: "GET",
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/FeatureServer/${this.layerId}/${request.objectId}/attachments`,
      responseFormat: request.responseFormat ?? "json",
      query: request.extraParams,
      signal: request.signal,
    }) as Promise<HonuaAttachmentListResponse>;
  }

  public async deleteAttachments(
    request: HonuaFeatureLayerDeleteAttachmentsRequest,
  ): Promise<HonuaDeleteAttachmentsResponse> {
    const body = toFormBody({
      f: request.responseFormat ?? "json",
      attachmentIds: normalizeObjectIds(request.attachmentIds),
      ...(request.extraParams ?? {}),
    });
    return this.client.request<HonuaDeleteAttachmentsResponse>({
      method: "POST",
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/FeatureServer/${this.layerId}/${request.objectId}/deleteAttachments`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: request.signal,
    });
  }

  public async addAttachment(request: HonuaFeatureLayerAddAttachmentRequest): Promise<HonuaAddAttachmentResponse> {
    const form = buildAttachmentFormData(request);
    return this.client.request<HonuaAddAttachmentResponse>({
      method: "POST",
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/FeatureServer/${this.layerId}/${request.objectId}/addAttachment`,
      responseFormat: request.responseFormat ?? "json",
      query: request.extraParams,
      body: form,
      signal: request.signal,
    });
  }

  public async updateAttachment(
    request: HonuaFeatureLayerUpdateAttachmentRequest,
  ): Promise<HonuaUpdateAttachmentResponse> {
    const form = buildAttachmentFormData(request);
    form.set("attachmentId", String(request.attachmentId));
    return this.client.request<HonuaUpdateAttachmentResponse>({
      method: "POST",
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/FeatureServer/${this.layerId}/${request.objectId}/updateAttachment`,
      responseFormat: request.responseFormat ?? "json",
      query: request.extraParams,
      body: form,
      signal: request.signal,
    });
  }

  public async request<T = unknown>(request: HonuaFeatureLayerRequest): Promise<T> {
    return this.client.request<T>({
      ...request,
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/FeatureServer/${this.layerId}/${normalizeLayerPath(request.path)}`,
    });
  }
}

export interface HonuaMapServiceOptions {
  client: HonuaClient;
  serviceId: string;
}

export class HonuaMapService {
  public readonly client: HonuaClient;
  public readonly serviceId: string;

  public constructor(options: HonuaMapServiceOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
  }

  public async metadata(options: HonuaMetadataRequestOptions = {}): Promise<HonuaServiceMetadata> {
    return this.client.getMapServiceMetadata(this.serviceId, options);
  }

  public layer(layerId: number): HonuaMapLayer {
    return new HonuaMapLayer({
      client: this.client,
      serviceId: this.serviceId,
      layerId,
    });
  }

  public async layerIds(): Promise<number[]> {
    const metadata = await this.metadata();
    return extractLayerIds(metadata);
  }

  public async layers(): Promise<HonuaMapLayer[]> {
    const ids = await this.layerIds();
    return ids.map(
      (layerId) =>
        new HonuaMapLayer({
          client: this.client,
          serviceId: this.serviceId,
          layerId,
        }),
    );
  }

  public async exportMap(request: HonuaMapServiceExportMapRequest): Promise<HonuaExportMapResponse> {
    return this.client.exportMap({
      serviceId: this.serviceId,
      ...request,
    });
  }

  public async legend(request: HonuaMapServiceLegendRequest = {}): Promise<HonuaLegendResponse> {
    return this.client.getMapLegend({
      serviceId: this.serviceId,
      ...request,
    });
  }

  public async getLegend(request: HonuaMapServiceLegendRequest = {}): Promise<HonuaLegendResponse> {
    return this.legend(request);
  }

  public async identify(request: HonuaMapServiceIdentifyRequest): Promise<HonuaIdentifyResponse> {
    return this.client.identifyMap({
      serviceId: this.serviceId,
      ...request,
    });
  }

  public async find(request: HonuaMapServiceFindRequest): Promise<HonuaFindResponse> {
    return this.client.findMap({
      serviceId: this.serviceId,
      ...request,
    });
  }

  public async queryLayer(request: HonuaMapServiceQueryLayerRequest): Promise<HonuaQueryResponse> {
    return this.client.queryMapLayer({
      serviceId: this.serviceId,
      ...request,
    });
  }

  public async queryLayerRelatedRecords(
    request: HonuaMapServiceQueryLayerRelatedRecordsRequest,
  ): Promise<HonuaRelatedRecordsResponse> {
    return this.client.queryMapRelatedRecords({
      serviceId: this.serviceId,
      ...request,
    });
  }

  public async queryLayerRelatedFeatures(
    request: HonuaMapServiceQueryLayerRelatedRecordsRequest,
  ): Promise<HonuaRelatedRecordsResponse> {
    return this.queryLayerRelatedRecords(request);
  }

  public async queryLayerFeaturesAll(request: HonuaMapServiceQueryLayerAllRequest): Promise<HonuaFeature[]> {
    const pageSize =
      typeof request.pageSize === "number" && Number.isFinite(request.pageSize)
        ? Math.max(1, Math.trunc(request.pageSize))
        : 2000;
    const maxPages =
      typeof request.maxPages === "number" && Number.isFinite(request.maxPages)
        ? Math.max(1, Math.trunc(request.maxPages))
        : 100;

    const features: HonuaFeature[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryLayer({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: offset,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      features.push(...pageFeatures);
      offset += pageFeatures.length;
      if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) {
        break;
      }
    }

    return features;
  }

  public async *queryLayerFeaturesStream(
    request: HonuaMapServiceQueryLayerAllRequest,
  ): AsyncGenerator<HonuaFeature[], void, undefined> {
    const pageSize =
      typeof request.pageSize === "number" && Number.isFinite(request.pageSize)
        ? Math.max(1, Math.trunc(request.pageSize))
        : 2000;
    const maxPages =
      typeof request.maxPages === "number" && Number.isFinite(request.maxPages)
        ? Math.max(1, Math.trunc(request.maxPages))
        : 100;

    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryLayer({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: offset,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      yield pageFeatures;
      offset += pageFeatures.length;
      if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) {
        break;
      }
    }
  }

  public async queryLayerFeatureCount(request: HonuaMapServiceQueryLayerCountRequest): Promise<number> {
    const response = await this.queryLayer({
      layerId: request.layerId,
      where: request.where ?? "1=1",
      returnGeometry: false,
      outFields: "OBJECTID",
      method: request.method,
      extraParams: {
        returnCountOnly: true,
        ...request.extraParams,
      },
    });
    return extractFeatureCountFromResponse(response);
  }

  public async queryLayerObjectIds(request: HonuaMapServiceQueryLayerObjectIdsRequest): Promise<number[]> {
    const response = await this.queryLayer({
      layerId: request.layerId,
      where: request.where ?? "1=1",
      returnGeometry: false,
      outFields: "OBJECTID",
      method: request.method,
      extraParams: {
        returnIdsOnly: true,
        ...request.extraParams,
      },
    });
    return extractObjectIdsFromResponse(response);
  }

  public async queryLayerExtent(
    request: HonuaMapServiceQueryLayerExtentRequest,
  ): Promise<HonuaMapServiceQueryLayerExtentResponse> {
    const response = await this.queryLayer({
      layerId: request.layerId,
      where: request.where ?? "1=1",
      returnGeometry: false,
      method: request.method,
      extraParams: {
        returnExtentOnly: true,
        ...request.extraParams,
      },
    });
    return extractExtentFromResponse(response);
  }

  public async exportImage(request: HonuaMapServiceExportMapRequest): Promise<HonuaExportMapResponse> {
    return this.exportMap(request);
  }

  public async request<T = unknown>(request: HonuaMapServiceRequest): Promise<T> {
    return this.client.request<T>({
      ...request,
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` + `/MapServer/${normalizeServicePath(request.path)}`,
    });
  }
}

export interface HonuaMapLayerOptions {
  client: HonuaClient;
  serviceId: string;
  layerId: number;
}

export class HonuaMapLayer {
  public readonly client: HonuaClient;
  public readonly serviceId: string;
  public readonly layerId: number;

  public constructor(options: HonuaMapLayerOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
    this.layerId = options.layerId;
  }

  public async metadata(options: HonuaMetadataRequestOptions = {}): Promise<HonuaLayerMetadata> {
    return this.client.getMapLayerMetadata(this.serviceId, this.layerId, options);
  }

  public createQuery(): HonuaMapLayerQueryRequest {
    return {
      where: "1=1",
      outFields: ["*"],
      returnGeometry: true,
    };
  }

  public async queryFeatures(request: HonuaMapLayerQueryRequest = {}): Promise<HonuaQueryResponse> {
    return this.client.queryMapLayer({
      serviceId: this.serviceId,
      layerId: this.layerId,
      ...request,
    });
  }

  public async queryRelatedRecords(
    request: HonuaMapLayerQueryRelatedRecordsRequest,
  ): Promise<HonuaRelatedRecordsResponse> {
    return this.client.queryMapRelatedRecords({
      serviceId: this.serviceId,
      layerId: this.layerId,
      ...request,
    });
  }

  public async queryRelatedFeatures(
    request: HonuaMapLayerQueryRelatedRecordsRequest,
  ): Promise<HonuaRelatedRecordsResponse> {
    return this.queryRelatedRecords(request);
  }

  public async queryFeaturesAll(request: HonuaMapLayerQueryAllRequest = {}): Promise<HonuaFeature[]> {
    const pageSize =
      typeof request.pageSize === "number" && Number.isFinite(request.pageSize)
        ? Math.max(1, Math.trunc(request.pageSize))
        : 2000;
    const maxPages =
      typeof request.maxPages === "number" && Number.isFinite(request.maxPages)
        ? Math.max(1, Math.trunc(request.maxPages))
        : 100;
    const startingOffset = normalizeOffset(request.resultOffset);

    const features: HonuaFeature[] = [];
    let offset = startingOffset;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: offset,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      features.push(...pageFeatures);
      offset += pageFeatures.length;
      if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) {
        break;
      }
    }

    return features;
  }

  public async *queryFeaturesStream(
    request: HonuaMapLayerQueryAllRequest = {},
  ): AsyncGenerator<HonuaFeature[], void, undefined> {
    const pageSize =
      typeof request.pageSize === "number" && Number.isFinite(request.pageSize)
        ? Math.max(1, Math.trunc(request.pageSize))
        : 2000;
    const maxPages =
      typeof request.maxPages === "number" && Number.isFinite(request.maxPages)
        ? Math.max(1, Math.trunc(request.maxPages))
        : 100;
    const startingOffset = normalizeOffset(request.resultOffset);

    let offset = startingOffset;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: offset,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      yield pageFeatures;
      offset += pageFeatures.length;
      if (!responseExceededTransferLimit(response) && pageFeatures.length < pageSize) {
        break;
      }
    }
  }

  public async queryFeatureCount(request: HonuaMapLayerQueryCountRequest = {}): Promise<number> {
    const response = await this.queryFeatures({
      where: request.where ?? "1=1",
      returnGeometry: false,
      outFields: "OBJECTID",
      method: request.method,
      extraParams: {
        returnCountOnly: true,
        ...request.extraParams,
      },
    });
    return extractFeatureCountFromResponse(response);
  }

  public async queryObjectIds(request: HonuaMapLayerQueryObjectIdsRequest = {}): Promise<number[]> {
    const response = await this.queryFeatures({
      ...request,
      where: request.where ?? "1=1",
      returnGeometry: false,
      outFields: request.outFields ?? "OBJECTID",
      extraParams: {
        returnIdsOnly: true,
        ...request.extraParams,
      },
    });
    return extractObjectIdsFromResponse(response);
  }

  public async queryExtent(request: HonuaMapLayerQueryExtentRequest = {}): Promise<HonuaMapLayerQueryExtentResponse> {
    const response = await this.queryFeatures({
      where: request.where ?? "1=1",
      returnGeometry: false,
      method: request.method,
      extraParams: {
        returnExtentOnly: true,
        ...request.extraParams,
      },
    });
    return extractExtentFromResponse(response);
  }

  public async request<T = unknown>(request: HonuaMapLayerRequest): Promise<T> {
    return this.client.request<T>({
      ...request,
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/MapServer/${this.layerId}/${normalizeLayerPath(request.path)}`,
    });
  }
}

export interface HonuaOgcFeaturesOptions {
  client: HonuaClient;
  /**
   * Endpoint-layout discovery mode. `honua-facade` (default) uses the fixed
   * `/ogc/features/...` fast path; `ogc-api` / `auto` discover the layout
   * from the server landing page so the surface works against raw pygeoapi
   * / ldproxy / GeoServer OGC API endpoints.
   */
  layout?: OgcApiLayoutMode;
}

export interface HonuaOgcFeatureCollectionOptions {
  client: HonuaClient;
  collectionId: string | number;
  layout?: OgcApiLayoutMode;
}

/**
 * Resolve the layout to inject onto a request. Returns `undefined` for the
 * facade fast path so the wire layer keeps its zero-round-trip default.
 */
async function resolveInjectedLayout(
  client: HonuaClient,
  mode: OgcApiLayoutMode | undefined,
): Promise<OgcEndpointLayout | undefined> {
  if (mode === undefined || mode === "honua-facade") return undefined;
  return client.resolveOgcFeaturesLayout(mode);
}

export class HonuaOgcFeatures {
  public readonly client: HonuaClient;
  private readonly layoutMode: OgcApiLayoutMode | undefined;

  public constructor(options: HonuaOgcFeaturesOptions) {
    this.client = options.client;
    this.layoutMode = options.layout;
  }

  private layout(): Promise<OgcEndpointLayout | undefined> {
    return resolveInjectedLayout(this.client, this.layoutMode);
  }

  public collection(collectionId: string | number): HonuaOgcFeatureCollection {
    return new HonuaOgcFeatureCollection({
      client: this.client,
      collectionId,
      ...(this.layoutMode ? { layout: this.layoutMode } : {}),
    });
  }

  public async landing(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    const layout = await this.layout();
    return this.client.getOgcFeaturesLanding({ ...request, ...(layout ? { layout } : {}) });
  }

  public async conformance(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    const layout = await this.layout();
    return this.client.getOgcFeaturesConformance({ ...request, ...(layout ? { layout } : {}) });
  }

  public async collections(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    const layout = await this.layout();
    return this.client.listOgcCollections({ ...request, ...(layout ? { layout } : {}) });
  }

  public async getCollection(request: HonuaOgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    const layout = await this.layout();
    return this.client.getOgcCollection({ ...request, ...(layout ? { layout } : {}) });
  }

  public async queryables(request: HonuaOgcCollectionRequest): Promise<HonuaOgcQueryablesResponse> {
    const layout = await this.layout();
    return this.client.getOgcQueryables({ ...request, ...(layout ? { layout } : {}) });
  }

  public async items(request: HonuaOgcItemsRequest): Promise<HonuaOgcFeatureCollectionResponse> {
    const layout = await this.layout();
    return this.client.listOgcItems({ ...request, ...(layout ? { layout } : {}) });
  }

  public async itemsAll(request: HonuaOgcItemsAllRequest): Promise<HonuaOgcFeatureResponse[]> {
    const pageSize = normalizePageSize(request.pageSize, request.limit);
    const maxPages = normalizeMaxPages(request.maxPages);
    const offset = normalizeOffset(request.offset);
    const totalLimit = normalizeTotalLimit(request.limit);
    const features: HonuaOgcFeatureResponse[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      if (totalLimit !== undefined && features.length >= totalLimit) {
        break;
      }
      const remainingLimit = totalLimit === undefined ? pageSize : Math.max(0, totalLimit - features.length);
      if (remainingLimit < 1) {
        break;
      }

      const limit = Math.min(pageSize, remainingLimit);
      const response = await this.items({
        ...request,
        limit,
        offset: offset + page * pageSize,
      });
      const pageFeatures = extractOgcFeatures(response);
      if (pageFeatures.length === 0) {
        break;
      }

      features.push(...pageFeatures);
      if (pageFeatures.length < limit) {
        break;
      }
    }

    if (totalLimit !== undefined && features.length > totalLimit) {
      return features.slice(0, totalLimit);
    }
    return features;
  }

  public async item(request: HonuaOgcItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.getOgcItem({ ...request, ...(layout ? { layout } : {}) });
  }

  public async createItem(request: HonuaOgcCreateItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.createOgcItem({ ...request, ...(layout ? { layout } : {}) });
  }

  public async replaceItem(request: HonuaOgcReplaceItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.replaceOgcItem({ ...request, ...(layout ? { layout } : {}) });
  }

  public async patchItem(request: HonuaOgcPatchItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.patchOgcItem({ ...request, ...(layout ? { layout } : {}) });
  }

  public async deleteItem(request: HonuaOgcDeleteItemRequest): Promise<void> {
    const layout = await this.layout();
    return this.client.deleteOgcItem({ ...request, ...(layout ? { layout } : {}) });
  }
}

export class HonuaOgcFeatureCollection {
  public readonly client: HonuaClient;
  public readonly collectionId: string | number;
  private readonly layoutMode: OgcApiLayoutMode | undefined;

  public constructor(options: HonuaOgcFeatureCollectionOptions) {
    this.client = options.client;
    this.collectionId = options.collectionId;
    this.layoutMode = options.layout;
  }

  private layout(): Promise<OgcEndpointLayout | undefined> {
    return resolveInjectedLayout(this.client, this.layoutMode);
  }

  public async metadata(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcCollectionMetadata> {
    const layout = await this.layout();
    return this.client.getOgcCollection({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }

  public async queryables(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcQueryablesResponse> {
    const layout = await this.layout();
    return this.client.getOgcQueryables({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }

  public async items(request: HonuaOgcCollectionItemsRequest = {}): Promise<HonuaOgcFeatureCollectionResponse> {
    const layout = await this.layout();
    return this.client.listOgcItems({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }

  public async itemsAll(request: HonuaOgcCollectionItemsAllRequest = {}): Promise<HonuaOgcFeatureResponse[]> {
    const pageSize = normalizePageSize(request.pageSize, request.limit);
    const maxPages = normalizeMaxPages(request.maxPages);
    const offset = normalizeOffset(request.offset);
    const totalLimit = normalizeTotalLimit(request.limit);
    const features: HonuaOgcFeatureResponse[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      if (totalLimit !== undefined && features.length >= totalLimit) {
        break;
      }
      const remainingLimit = totalLimit === undefined ? pageSize : Math.max(0, totalLimit - features.length);
      if (remainingLimit < 1) {
        break;
      }

      const limit = Math.min(pageSize, remainingLimit);
      const response = await this.items({
        ...request,
        limit,
        offset: offset + page * pageSize,
      });
      const pageFeatures = extractOgcFeatures(response);
      if (pageFeatures.length === 0) {
        break;
      }

      features.push(...pageFeatures);
      if (pageFeatures.length < limit) {
        break;
      }
    }

    if (totalLimit !== undefined && features.length > totalLimit) {
      return features.slice(0, totalLimit);
    }
    return features;
  }

  public async *itemsStream(
    request: HonuaOgcCollectionItemsAllRequest = {},
  ): AsyncGenerator<HonuaOgcFeatureResponse[], void, undefined> {
    const pageSize = normalizePageSize(request.pageSize, request.limit);
    const maxPages = normalizeMaxPages(request.maxPages);
    const offset = normalizeOffset(request.offset);

    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.items({
        ...request,
        limit: pageSize,
        offset: offset + page * pageSize,
      });
      const pageFeatures = extractOgcFeatures(response);
      if (pageFeatures.length === 0) {
        break;
      }

      yield pageFeatures;
      if (pageFeatures.length < pageSize) {
        break;
      }
    }
  }

  public async item(request: HonuaOgcCollectionItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.getOgcItem({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }

  public async createItem(request: HonuaOgcCollectionCreateItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.createOgcItem({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }

  public async replaceItem(request: HonuaOgcCollectionReplaceItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.replaceOgcItem({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }

  public async patchItem(request: HonuaOgcCollectionPatchItemRequest): Promise<HonuaOgcFeatureResponse> {
    const layout = await this.layout();
    return this.client.patchOgcItem({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }

  public async deleteItem(request: HonuaOgcCollectionDeleteItemRequest): Promise<void> {
    const layout = await this.layout();
    return this.client.deleteOgcItem({
      ...request,
      collectionId: this.collectionId,
      ...(layout ? { layout } : {}),
    });
  }
}

export function createHonuaService(client: HonuaClient, serviceId: string): HonuaService {
  return new HonuaService({
    client,
    serviceId,
  });
}

export function createHonuaOgcFeatures(client: HonuaClient): HonuaOgcFeatures {
  return new HonuaOgcFeatures({
    client,
  });
}

// ── ImageServer ───────────────────────────────

export interface HonuaImageServiceOptions {
  client: HonuaClient;
  serviceId: string;
}

export type HonuaImageServiceQueryRequest = HonuaFeatureLayerQueryRequest;

/** Optional ImageServer raster export. Mirrors Esri `exportImage` parameters. */
export interface HonuaImageServiceExportRequest {
  bbox?: string | [number, number, number, number];
  size?: string | [number, number];
  format?: string;
  pixelType?: string;
  noData?: number | string;
  interpolation?: string;
  compressionQuality?: number;
  bandIds?: readonly number[] | string;
  mosaicRule?: Record<string, unknown> | string;
  renderingRule?: Record<string, unknown> | string;
  imageSr?: string | number;
  bboxSr?: string | number;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export interface HonuaImageServiceIdentifyRequest {
  geometry: string | Record<string, unknown>;
  geometryType?: string;
  sr?: string | number;
  mosaicRule?: Record<string, unknown> | string;
  renderingRule?: Record<string, unknown> | string;
  pixelSize?: string | [number, number];
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/**
 * Wrapper over a Honua ImageServer endpoint. Each operation maps to the
 * server route published in
 * `honua-server/docs/gis/image-server-matrix.md`. The wrapper does not
 * downgrade to a generic raw call: it carries a typed request shape so
 * the contract layer can negotiate capabilities and the server can
 * branch on a stable method name.
 */
export class HonuaImageService {
  public readonly client: HonuaClient;
  public readonly serviceId: string;

  public constructor(options: HonuaImageServiceOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
  }

  public async metadata(): Promise<HonuaServiceMetadata> {
    return this.client.request<HonuaServiceMetadata>({
      method: "GET",
      path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer`,
      responseFormat: "json",
    });
  }

  public async queryRasterCatalog(request: HonuaImageServiceQueryRequest = {}): Promise<HonuaQueryResponse> {
    return this.dispatch<HonuaQueryResponse>("query", request, imageQueryParams(request));
  }

  public async queryRasterCatalogObjectIds(request: HonuaImageServiceQueryRequest = {}): Promise<number[]> {
    const response = await this.dispatch<{ objectIds?: Array<number | string> }>("query", request, {
      ...imageQueryParams(request),
      where: request.where ?? "1=1",
      returnIdsOnly: true,
    });
    if (!Array.isArray(response.objectIds)) return [];
    return response.objectIds.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  }

  public async exportImage(request: HonuaImageServiceExportRequest): Promise<HonuaExportMapResponse> {
    return this.dispatch<HonuaExportMapResponse>("exportImage", request, imageExportParams(request));
  }

  public async identify(request: HonuaImageServiceIdentifyRequest): Promise<HonuaIdentifyResponse> {
    return this.dispatch<HonuaIdentifyResponse>("identify", request, imageIdentifyParams(request));
  }

  /**
   * Dispatch an ImageServer operation. POST mode sends params as a
   * form-encoded body so the server's `TryReadRequestValuesAsync` parser
   * finds them (returns "Request body is required" otherwise); GET mode
   * keeps params in the query string. Both encodings are accepted by
   * Honua Server per its ImageServer endpoint registration.
   */
  private async dispatch<R>(
    op: "query" | "exportImage" | "identify",
    request: { method?: QueryMethod; responseFormat?: "json" | "pjson"; signal?: AbortSignal },
    params: Record<string, string | number | boolean>,
  ): Promise<R> {
    const method: QueryMethod = request.method ?? "GET";
    const path = `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer/${op}`;
    const responseFormat = request.responseFormat ?? "json";
    if (method === "GET") {
      return this.client.request<R>({ method: "GET", path, responseFormat, query: params, signal: request.signal });
    }
    return this.client.request<R>({
      method: "POST",
      path,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormBody({ f: responseFormat, ...params }),
      signal: request.signal,
    });
  }

  public tileUrl(
    level: number,
    row: number,
    col: number,
    format: "png" | "jpg" | "jpeg" | "tif" | "tiff" = "png",
  ): string {
    const path = `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer/tile/${level}/${row}/${col}`;
    return `${this.client.serverBaseUrl}${path}?f=${format}`;
  }

  public async legend(): Promise<HonuaLegendResponse> {
    return this.client.request<HonuaLegendResponse>({
      method: "GET",
      path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/ImageServer/legend`,
      responseFormat: "json",
    });
  }
}

function imageQueryParams(request: HonuaImageServiceQueryRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  if (request.where !== undefined) params.where = request.where;
  if (request.outFields !== undefined) {
    params.outFields = Array.isArray(request.outFields) ? request.outFields.join(",") : String(request.outFields);
  }
  if (request.objectIds !== undefined) {
    params.objectIds = Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds);
  }
  if (request.returnGeometry !== undefined) params.returnGeometry = request.returnGeometry;
  if (request.outSr !== undefined) params.outSR = String(request.outSr);
  if (request.resultOffset !== undefined) params.resultOffset = request.resultOffset;
  if (request.resultRecordCount !== undefined) params.resultRecordCount = request.resultRecordCount;
  if (request.geometry !== undefined) params.geometry = JSON.stringify(request.geometry);
  if (request.geometryType !== undefined) params.geometryType = String(request.geometryType);
  if (request.spatialRel !== undefined) params.spatialRel = String(request.spatialRel);
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function imageExportParams(request: HonuaImageServiceExportRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  if (request.bbox !== undefined) {
    params.bbox = Array.isArray(request.bbox) ? request.bbox.join(",") : request.bbox;
  }
  if (request.size !== undefined) {
    params.size = Array.isArray(request.size) ? request.size.join(",") : request.size;
  }
  if (request.format !== undefined) params.format = request.format;
  if (request.pixelType !== undefined) params.pixelType = request.pixelType;
  if (request.noData !== undefined) params.noData = request.noData;
  if (request.interpolation !== undefined) params.interpolation = request.interpolation;
  if (request.compressionQuality !== undefined) params.compressionQuality = request.compressionQuality;
  if (request.bandIds !== undefined) {
    params.bandIds = Array.isArray(request.bandIds) ? request.bandIds.join(",") : String(request.bandIds);
  }
  if (request.mosaicRule !== undefined) {
    params.mosaicRule =
      typeof request.mosaicRule === "string" ? request.mosaicRule : JSON.stringify(request.mosaicRule);
  }
  if (request.renderingRule !== undefined) {
    params.renderingRule =
      typeof request.renderingRule === "string" ? request.renderingRule : JSON.stringify(request.renderingRule);
  }
  if (request.imageSr !== undefined) params.imageSR = String(request.imageSr);
  if (request.bboxSr !== undefined) params.bboxSR = String(request.bboxSr);
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function imageIdentifyParams(request: HonuaImageServiceIdentifyRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  params.geometry = typeof request.geometry === "string" ? request.geometry : JSON.stringify(request.geometry);
  if (request.geometryType !== undefined) params.geometryType = request.geometryType;
  if (request.sr !== undefined) params.sr = String(request.sr);
  if (request.mosaicRule !== undefined) {
    params.mosaicRule =
      typeof request.mosaicRule === "string" ? request.mosaicRule : JSON.stringify(request.mosaicRule);
  }
  if (request.renderingRule !== undefined) {
    params.renderingRule =
      typeof request.renderingRule === "string" ? request.renderingRule : JSON.stringify(request.renderingRule);
  }
  if (request.pixelSize !== undefined) {
    params.pixelSize = Array.isArray(request.pixelSize) ? request.pixelSize.join(",") : request.pixelSize;
  }
  Object.assign(params, request.extraParams ?? {});
  return params;
}

// ── Geometry Service ──────────────────────────

export interface HonuaGeometryServiceOptions {
  client: HonuaClient;
}

export interface HonuaGeometryProjectRequest {
  geometries: { geometryType: string; geometries: ReadonlyArray<Record<string, unknown>> } | string;
  inSr: string | number | Record<string, unknown>;
  outSr: string | number | Record<string, unknown>;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export interface HonuaGeometryBufferRequest {
  geometries: { geometryType: string; geometries: ReadonlyArray<Record<string, unknown>> } | string;
  distances: readonly number[] | string;
  unit?: string | number;
  inSr?: string | number | Record<string, unknown>;
  outSr?: string | number | Record<string, unknown>;
  bufferSr?: string | number | Record<string, unknown>;
  unionResults?: boolean;
  geodesic?: boolean;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export interface HonuaGeometrySimplifyRequest {
  geometries: { geometryType: string; geometries: ReadonlyArray<Record<string, unknown>> } | string;
  sr?: string | number | Record<string, unknown>;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/**
 * Shared request shape for the binary GeometryServer operations
 * (`intersect`, `clip`, `difference`). Honua Server reads `geometries` as
 * the input set, `geometry` as the comparison operand, and `sr` as the
 * shared spatial reference (see
 * `Honua.Server/Features/Protocols/GeoServices/GeometryService/Services/GeometryServiceHandler.cs`
 * `HandleBinaryGeometryOperationAsync`).
 */
export interface HonuaGeometryBinaryOperationRequest {
  geometries: { geometryType: string; geometries: ReadonlyArray<Record<string, unknown>> } | string;
  geometry: Record<string, unknown> | string;
  sr: string | number | Record<string, unknown>;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export type HonuaGeometryIntersectRequest = HonuaGeometryBinaryOperationRequest;
export type HonuaGeometryClipRequest = HonuaGeometryBinaryOperationRequest;
export type HonuaGeometryDifferenceRequest = HonuaGeometryBinaryOperationRequest;

export interface HonuaGeometryUnionRequest {
  geometries: { geometryType: string; geometries: ReadonlyArray<Record<string, unknown>> } | string;
  sr: string | number | Record<string, unknown>;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export interface HonuaGeometryOperationResponse {
  geometries?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Wrapper over a Honua Geometry Service endpoint. Routes match the
 * canonical paths published by Honua Server's `EndpointRegistry`
 * (`/rest/services/Utilities/Geometry/GeometryServer/<op>`; see
 * `honua-server/docs/gis/geometry-service-matrix.md`). Wraps the
 * server-supported operations: `project`, `buffer`, `simplify`,
 * `intersect`, `union`, `clip`, `difference`. Operations not
 * implemented in Honua Server (autoComplete, convexHull, cut,
 * areasAndLengths/lengths measurement helpers, etc.) intentionally have
 * no wrapper — callers that need them go through the raw `request()`
 * escape hatch and handle 404s themselves.
 *
 * POST mode submits form-encoded bodies so the server's
 * `TryReadRequestValuesAsync` parser finds the parameters. GET mode keeps
 * params in the query string (the server accepts both).
 */
const GEOMETRY_SERVICE_ROOT = "/rest/services/Utilities/Geometry/GeometryServer";

export class HonuaGeometryService {
  public readonly client: HonuaClient;

  public constructor(options: HonuaGeometryServiceOptions) {
    this.client = options.client;
  }

  public async project(request: HonuaGeometryProjectRequest): Promise<HonuaGeometryOperationResponse> {
    return this.dispatch<HonuaGeometryOperationResponse>("project", request, geometryProjectParams(request));
  }

  public async buffer(request: HonuaGeometryBufferRequest): Promise<HonuaGeometryOperationResponse> {
    return this.dispatch<HonuaGeometryOperationResponse>("buffer", request, geometryBufferParams(request));
  }

  public async simplify(request: HonuaGeometrySimplifyRequest): Promise<HonuaGeometryOperationResponse> {
    return this.dispatch<HonuaGeometryOperationResponse>("simplify", request, geometrySimplifyParams(request));
  }

  public async intersect(request: HonuaGeometryIntersectRequest): Promise<HonuaGeometryOperationResponse> {
    return this.dispatch<HonuaGeometryOperationResponse>("intersect", request, geometryBinaryParams(request));
  }

  public async union(request: HonuaGeometryUnionRequest): Promise<HonuaGeometryOperationResponse> {
    return this.dispatch<HonuaGeometryOperationResponse>("union", request, geometryUnionParams(request));
  }

  public async clip(request: HonuaGeometryClipRequest): Promise<HonuaGeometryOperationResponse> {
    return this.dispatch<HonuaGeometryOperationResponse>("clip", request, geometryBinaryParams(request));
  }

  public async difference(request: HonuaGeometryDifferenceRequest): Promise<HonuaGeometryOperationResponse> {
    return this.dispatch<HonuaGeometryOperationResponse>("difference", request, geometryBinaryParams(request));
  }

  private async dispatch<R>(
    op: "project" | "buffer" | "simplify" | "intersect" | "union" | "clip" | "difference",
    request: { method?: QueryMethod; responseFormat?: "json" | "pjson"; signal?: AbortSignal },
    params: Record<string, string | number | boolean>,
  ): Promise<R> {
    const method: QueryMethod = request.method ?? "POST";
    const path = `${GEOMETRY_SERVICE_ROOT}/${op}`;
    const responseFormat = request.responseFormat ?? "json";
    if (method === "GET") {
      return this.client.request<R>({ method: "GET", path, responseFormat, query: params, signal: request.signal });
    }
    return this.client.request<R>({
      method: "POST",
      path,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormBody({ f: responseFormat, ...params }),
      signal: request.signal,
    });
  }
}

function geometryProjectParams(request: HonuaGeometryProjectRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
    inSR:
      typeof request.inSr === "string" || typeof request.inSr === "number"
        ? String(request.inSr)
        : JSON.stringify(request.inSr),
    outSR:
      typeof request.outSr === "string" || typeof request.outSr === "number"
        ? String(request.outSr)
        : JSON.stringify(request.outSr),
  };
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function geometryBufferParams(request: HonuaGeometryBufferRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
    distances: Array.isArray(request.distances) ? request.distances.join(",") : String(request.distances),
  };
  if (request.unit !== undefined) params.unit = request.unit;
  if (request.inSr !== undefined)
    params.inSR = typeof request.inSr === "object" ? JSON.stringify(request.inSr) : String(request.inSr);
  if (request.outSr !== undefined)
    params.outSR = typeof request.outSr === "object" ? JSON.stringify(request.outSr) : String(request.outSr);
  if (request.bufferSr !== undefined)
    params.bufferSR =
      typeof request.bufferSr === "object" ? JSON.stringify(request.bufferSr) : String(request.bufferSr);
  if (request.unionResults !== undefined) params.unionResults = request.unionResults;
  if (request.geodesic !== undefined) params.geodesic = request.geodesic;
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function geometrySimplifyParams(request: HonuaGeometrySimplifyRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
  };
  if (request.sr !== undefined)
    params.sr = typeof request.sr === "object" ? JSON.stringify(request.sr) : String(request.sr);
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function geometryBinaryParams(request: HonuaGeometryBinaryOperationRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
    geometry: typeof request.geometry === "string" ? request.geometry : JSON.stringify(request.geometry),
    sr: typeof request.sr === "object" ? JSON.stringify(request.sr) : String(request.sr),
  };
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function geometryUnionParams(request: HonuaGeometryUnionRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
    sr: typeof request.sr === "object" ? JSON.stringify(request.sr) : String(request.sr),
  };
  Object.assign(params, request.extraParams ?? {});
  return params;
}

// ── GP Service ────────────────────────────────

export interface HonuaGeoprocessingServiceOptions {
  client: HonuaClient;
  serviceId: string;
  taskName?: string;
}

export interface HonuaGeoprocessingSubmitRequest {
  parameters: Record<string, unknown>;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export interface HonuaGeoprocessingJobRunRequestOptions {
  /** Result parameter ids to fetch when the job succeeds. */
  resultNames?: readonly string[];
  /** Default `pollIntervalMs` for `IJobRun.results()`. */
  pollIntervalMs?: number;
}

export interface HonuaGeoprocessingJob {
  jobId: string;
  jobStatus: string;
  results?: Record<string, unknown>;
  messages?: ReadonlyArray<{ type: string; description: string }>;
}

export interface HonuaGeoprocessingJobRunOptions extends HonuaGeoprocessingJobRunRequestOptions {
  client: HonuaClient;
  serviceId: string;
  taskName?: string;
  jobId: string;
  initialJob?: HonuaGeoprocessingJob;
  pollFn?: (jobId: string, signal?: AbortSignal) => Promise<HonuaGeoprocessingJob>;
  resultFn?: (jobId: string, resultName: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  cancelFn?: (jobId: string, signal?: AbortSignal) => Promise<HonuaGeoprocessingJob>;
}

/**
 * Wrapper over a Honua GP Service task. Mirrors the routes published in
 * `honua-server/docs/gis/geoprocess-framework-analysis.md`: `submitJob`,
 * `jobs/{jobId}` (status), `jobs/{jobId}/cancel`, and per-result lookup
 * (currently registered route, output delivery still depends on the
 * execution engine — see the parity matrix).
 */
export class HonuaGeoprocessingService {
  public readonly client: HonuaClient;
  public readonly serviceId: string;
  public readonly taskName: string | undefined;

  public constructor(options: HonuaGeoprocessingServiceOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
    this.taskName = options.taskName;
  }

  public async submitJob(request: HonuaGeoprocessingSubmitRequest): Promise<HonuaGeoprocessingJob> {
    return this.client.request<HonuaGeoprocessingJob>({
      method: request.method ?? "POST",
      path: this.taskPath("submitJob"),
      responseFormat: request.responseFormat ?? "json",
      query: gpSubmitParams(request),
      signal: request.signal,
    });
  }

  /**
   * Submit a GeoServices GP job and expose it through the canonical
   * async-operation surface. This keeps GPServer tasks interoperable with
   * OGC Processes jobs, app-workspace job state, and any future job-aware
   * UI components.
   */
  public async submit<T = unknown>(
    request: HonuaGeoprocessingSubmitRequest,
    options: HonuaGeoprocessingJobRunRequestOptions = {},
  ): Promise<IJobRun<T>> {
    const accepted = await this.submitJob(request);
    return new HonuaGeoprocessingJobRun<T>({
      client: this.client,
      serviceId: this.serviceId,
      taskName: this.taskName,
      jobId: accepted.jobId,
      initialJob: accepted,
      resultNames: options.resultNames,
      pollIntervalMs: options.pollIntervalMs,
    });
  }

  /** Adopt an existing GP job by id after navigation or reconnect. */
  public job<T = unknown>(jobId: string, options: HonuaGeoprocessingJobRunRequestOptions = {}): IJobRun<T> {
    return new HonuaGeoprocessingJobRun<T>({
      client: this.client,
      serviceId: this.serviceId,
      taskName: this.taskName,
      jobId,
      resultNames: options.resultNames,
      pollIntervalMs: options.pollIntervalMs,
    });
  }

  public async jobStatus(jobId: string, options: { signal?: AbortSignal } = {}): Promise<HonuaGeoprocessingJob> {
    return this.client.request<HonuaGeoprocessingJob>({
      method: "GET",
      path: `${this.taskPath("jobs")}/${encodeURIComponent(jobId)}`,
      responseFormat: "json",
      signal: options.signal,
    });
  }

  public async cancelJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<HonuaGeoprocessingJob> {
    return this.client.request<HonuaGeoprocessingJob>({
      method: "POST",
      path: `${this.taskPath("jobs")}/${encodeURIComponent(jobId)}/cancel`,
      responseFormat: "json",
      signal: options.signal,
    });
  }

  public async jobResult(
    jobId: string,
    resultName: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: "GET",
      path: `${this.taskPath("jobs")}/${encodeURIComponent(jobId)}/results/${encodeURIComponent(resultName)}`,
      responseFormat: "json",
      signal: options.signal,
    });
  }

  private taskPath(suffix: string): string {
    const taskSegment = this.taskName ? `/${encodeURIComponent(this.taskName)}` : "";
    return `/rest/services/${encodeServiceIdPath(this.serviceId)}/GPServer${taskSegment}/${suffix}`;
  }
}

const DEFAULT_GP_POLL_INTERVAL_MS = 1_000;

export class HonuaGeoprocessingJobRun<T = unknown> implements IJobRun<T> {
  public readonly id: string;
  public readonly type: string;

  private readonly client: HonuaClient;
  private readonly serviceId: string;
  private readonly taskName: string | undefined;
  private readonly resultNames: readonly string[];
  private readonly pollIntervalMs: number;
  private readonly pollFn: (jobId: string, signal?: AbortSignal) => Promise<HonuaGeoprocessingJob>;
  private readonly resultFn: (
    jobId: string,
    resultName: string,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  private readonly cancelFn: (jobId: string, signal?: AbortSignal) => Promise<HonuaGeoprocessingJob>;
  private currentStatus: JobStatus;
  private currentProgress: JobProgress | undefined;
  private terminalSnapshot: JobSnapshot<T> | undefined;
  private terminalPromise: Promise<JobResult<T>> | undefined;
  private readonly listeners = new Set<JobSnapshotListener<T>>();

  public constructor(options: HonuaGeoprocessingJobRunOptions) {
    this.client = options.client;
    this.serviceId = options.serviceId;
    this.taskName = options.taskName;
    this.id = options.jobId;
    this.type = options.taskName ? `${options.serviceId}/${options.taskName}` : options.serviceId;
    this.resultNames = options.resultNames ?? [];
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_GP_POLL_INTERVAL_MS;
    this.pollFn =
      options.pollFn ??
      ((jobId, signal) =>
        new HonuaGeoprocessingService({
          client: this.client,
          serviceId: this.serviceId,
          taskName: this.taskName,
        }).jobStatus(jobId, { signal }));
    this.resultFn =
      options.resultFn ??
      ((jobId, resultName, signal) =>
        new HonuaGeoprocessingService({
          client: this.client,
          serviceId: this.serviceId,
          taskName: this.taskName,
        }).jobResult(jobId, resultName, { signal }));
    this.cancelFn =
      options.cancelFn ??
      ((jobId, signal) =>
        new HonuaGeoprocessingService({
          client: this.client,
          serviceId: this.serviceId,
          taskName: this.taskName,
        }).cancelJob(jobId, { signal }));
    this.currentStatus = geoprocessingStatusToJobStatus(options.initialJob?.jobStatus);
    this.currentProgress = progressFromGeoprocessingJob(options.initialJob);
  }

  public get status(): JobStatus {
    return this.currentStatus;
  }

  public get progress(): JobProgress | undefined {
    return this.currentProgress;
  }

  public async poll(): Promise<JobSnapshot<T>> {
    if (this.terminalSnapshot) return this.terminalSnapshot;
    const job = await this.pollFn(this.id);
    return this.handleGeoprocessingJob(job);
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async results(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    if (!this.terminalPromise) {
      // Reset the cached promise if the poll loop rejects (abort / deadline /
      // attempt cap / transient poll error) so a later results() call can retry
      // rather than being permanently poisoned while the job may still be
      // running and pollable.
      this.terminalPromise = this.runUntilTerminal(options).catch((error) => {
        this.terminalPromise = undefined;
        throw error;
      });
    }
    return this.terminalPromise;
  }

  public async cancel(): Promise<JobStatus> {
    if (this.terminalSnapshot) return this.currentStatus;
    const cancelled = await this.cancelFn(this.id);
    const snapshot = await this.handleGeoprocessingJob(cancelled);
    return snapshot.status;
  }

  private async runUntilTerminal(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    const { signal } = options;
    const baseIntervalMs = options.pollIntervalMs ?? this.pollIntervalMs;
    const maxIntervalMs = options.maxPollIntervalMs ?? Math.max(baseIntervalMs, 30_000);
    const startedAt = Date.now();
    let attempts = 0;

    while (!this.terminalSnapshot) {
      if (signal?.aborted) {
        throw new HonuaJobPollTimeoutError(`Job ${this.id} poll aborted`, "aborted", this.id, this.currentStatus);
      }
      if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) {
        throw new HonuaJobPollTimeoutError(
          `Job ${this.id} did not reach a terminal state within ${options.maxAttempts} poll attempt(s)`,
          "max-attempts",
          this.id,
          this.currentStatus,
        );
      }

      let job: HonuaGeoprocessingJob;
      try {
        job = await this.pollFn(this.id, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw new HonuaJobPollTimeoutError(`Job ${this.id} poll aborted`, "aborted", this.id, this.currentStatus);
        }
        throw error;
      }
      attempts += 1;
      await this.handleGeoprocessingJob(job);
      if (this.terminalSnapshot) break;

      if (options.deadlineMs !== undefined && Date.now() - startedAt >= options.deadlineMs) {
        throw new HonuaJobPollTimeoutError(
          `Job ${this.id} did not reach a terminal state within ${options.deadlineMs}ms`,
          "deadline",
          this.id,
          this.currentStatus,
        );
      }

      // Capped exponential backoff instead of a fixed interval, matching the
      // OGC Processes and geospatial-grpc job pollers.
      const intervalMs = Math.min(maxIntervalMs, baseIntervalMs * 2 ** (attempts - 1));
      if (intervalMs > 0) await gpDelay(intervalMs, signal);
    }
    if (this.terminalSnapshot.status === "successful" && this.terminalSnapshot.result) {
      return this.terminalSnapshot.result;
    }
    const error = this.terminalSnapshot.error;
    throw new Error(error?.message ?? `GeoServices GP job ended in ${this.terminalSnapshot.status}`);
  }

  private async handleGeoprocessingJob(job: HonuaGeoprocessingJob | undefined): Promise<JobSnapshot<T>> {
    const status = geoprocessingStatusToJobStatus(job?.jobStatus);
    const progress = progressFromGeoprocessingJob(job);
    this.currentStatus = status;
    this.currentProgress = progress;

    if (status === "successful") {
      const outputs = await this.resolveOutputs(job);
      const snapshot: JobSnapshot<T> = {
        status,
        progress,
        result: { outputs },
      };
      this.terminalSnapshot = snapshot;
      this.notify(snapshot);
      return snapshot;
    }

    if (status === "failed" || status === "dismissed") {
      const error = geoprocessingJobError(status, job);
      const snapshot: JobSnapshot<T> = {
        status,
        progress,
        ...(error ? { error } : {}),
      };
      this.terminalSnapshot = snapshot;
      this.notify(snapshot);
      return snapshot;
    }

    const snapshot: JobSnapshot<T> = { status, progress };
    this.notify(snapshot);
    return snapshot;
  }

  private async resolveOutputs(job: HonuaGeoprocessingJob | undefined): Promise<Record<string, T>> {
    if (this.resultNames.length === 0) {
      return (job?.results ?? {}) as Record<string, T>;
    }

    const outputs: Record<string, T> = {};
    for (const resultName of this.resultNames) {
      outputs[resultName] = (await this.resultFn(this.id, resultName)) as T;
    }
    return outputs;
  }

  private notify(snapshot: JobSnapshot<T>): void {
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function gpSubmitParams(request: HonuaGeoprocessingSubmitRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(request.parameters)) {
    params[key] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function geoprocessingStatusToJobStatus(value: string | undefined): JobStatus {
  const normalized = (value ?? "esriJobSubmitted").toLowerCase();
  if (normalized.includes("succeeded") || normalized === "successful") return "successful";
  if (normalized.includes("cancelled") || normalized.includes("canceled") || normalized.includes("dismissed")) {
    return "dismissed";
  }
  if (normalized.includes("failed") || normalized.includes("timedout") || normalized.includes("timed out")) {
    return "failed";
  }
  if (normalized.includes("submitted") || normalized.includes("waiting") || normalized.includes("accepted")) {
    return "accepted";
  }
  if (isJobTerminal(normalized as JobStatus)) return normalized as JobStatus;
  return "running";
}

function progressFromGeoprocessingJob(job: HonuaGeoprocessingJob | undefined): JobProgress | undefined {
  if (!job) return undefined;
  const message = job.messages?.at(-1)?.description;
  const status = geoprocessingStatusToJobStatus(job.jobStatus);
  const percent = status === "successful" ? 100 : status === "accepted" ? 5 : status === "running" ? 50 : undefined;
  if (percent === undefined && message === undefined) return undefined;
  return { ...(percent !== undefined ? { percent } : {}), ...(message !== undefined ? { message } : {}) };
}

function geoprocessingJobError(status: JobStatus, job: HonuaGeoprocessingJob | undefined): JobError | undefined {
  const message =
    job?.messages?.find((entry) => /error|failed|cancel/i.test(entry.type))?.description ??
    job?.messages?.at(-1)?.description;
  if (!message) {
    return status === "dismissed"
      ? { code: "GeoServicesJobDismissed", message: "GeoServices GP job was dismissed." }
      : { code: "GeoServicesJobFailed", message: "GeoServices GP job failed." };
  }
  return {
    code: status === "dismissed" ? "GeoServicesJobDismissed" : "GeoServicesJobFailed",
    message,
  };
}

function gpDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

interface FeatureServerH3AggregationSummaryBinding {
  readonly summary: SpatialAggregationSummarySpec;
  readonly responseField: string;
}

interface FeatureServerH3AggregationPlan {
  readonly params: Record<string, string | number | boolean>;
  readonly resolution: number;
  readonly summaryBindings: readonly FeatureServerH3AggregationSummaryBinding[];
}

function defaultFeatureLayerSourceId(serviceId: string, layerId: number): SourceId {
  return `geoservices-feature-service:${serviceId}/${layerId}`;
}

function createFeatureServerH3AggregationPlan(
  request: SpatialAggregationRequest,
  kRingDistance: number | undefined,
): FeatureServerH3AggregationPlan {
  const resolution = request.resolution?.indexResolution;
  if (resolution === undefined) {
    throw new Error("FeatureServer queryH3 requires resolution.indexResolution");
  }

  const params: Record<string, string | number | boolean> = {
    resolution,
  };
  if (request.where !== undefined) {
    params.where = request.where;
  }

  const normalizedKRingDistance = normalizeH3KRingDistance(kRingDistance);
  if (normalizedKRingDistance !== undefined) {
    params.kRingDistance = normalizedKRingDistance;
  }

  const firstSummary = request.summaries[0];
  const usesServerDefaultCount =
    request.summaries.length === 1 && firstSummary?.kind === "count" && firstSummary.field === undefined;

  if (usesServerDefaultCount) {
    return {
      params,
      resolution,
      summaryBindings: [{ summary: firstSummary, responseField: "count" }],
    };
  }

  const outStatistics: Array<Record<string, string>> = [];
  const summaryBindings = request.summaries.map((summary, index) => {
    const responseField = outStatisticFieldName(summary, index);
    const onStatisticField = statisticInputField(summary);
    outStatistics.push({
      statisticType: summary.kind,
      onStatisticField,
      outStatisticFieldName: responseField,
    });
    return { summary, responseField };
  });

  params.outStatistics = JSON.stringify(outStatistics);
  return {
    params,
    resolution,
    summaryBindings,
  };
}

function featureServerH3AggregationResultFromResponse(
  response: HonuaQueryResponse,
  request: SpatialAggregationRequest,
  plan: FeatureServerH3AggregationPlan,
): SpatialAggregationResult {
  const cells = extractFeaturesFromResponse(response).map((feature) =>
    featureServerH3CellFromFeature(feature, request, plan),
  );
  const extent = mergeExtents(
    cells.map((cell) => cell.extent).filter((value): value is HonuaExtent => value !== undefined),
  );
  const indexModel = {
    id: request.index?.modelId ?? FEATURE_SERVER_H3_SPATIAL_AGGREGATION_INDEX_MODEL_ID,
    title: "FeatureServer indexed cells",
    family: FEATURE_SERVER_H3_SPATIAL_AGGREGATION_INDEX_MODEL_ID,
    cellIdEncoding: "string" as const,
    minResolution: 0,
    maxResolution: 15,
    supportedGeometry: ["none", "extent", "boundary"] as const,
    hierarchy: "parent-child" as const,
    spatialReference: response.spatialReference ?? extent?.spatialReference ?? { wkid: 4326 },
  };
  const summaries = request.summaries.map(spatialAggregationSummaryMetadataFromSpec);
  const progressive = {
    status: response.exceededTransferLimit === true ? ("partial" as const) : ("complete" as const),
    refinement: response.exceededTransferLimit === true ? ("append" as const) : undefined,
    loadedCellCount: cells.length,
  };
  const metadata = {
    schemaVersion: SPATIAL_AGGREGATION_METADATA_SCHEMA_VERSION,
    sourceId: request.sourceId,
    indexModels: [indexModel],
    summaries,
    progressive,
    cache: {
      metadataCacheable: true,
      resultCacheable: false,
      cacheKeyParts: [
        "geoservices-feature-service",
        request.sourceId,
        "queryH3",
        `resolution=${plan.resolution}`,
        `where=${request.where ?? ""}`,
      ],
    },
  };

  return {
    schemaVersion: SPATIAL_AGGREGATION_SCHEMA_VERSION,
    requestId: request.requestId,
    sourceId: request.sourceId,
    index: {
      model: indexModel,
      resolution: plan.resolution,
      requestedResolution: request.resolution,
      cellCount: cells.length,
      extent,
    },
    metadata: {
      ...metadata,
      widgets: spatialAggregationWidgets(metadata),
    },
    cells,
    page:
      response.exceededTransferLimit === true
        ? {
            loadedCellCount: cells.length,
          }
        : undefined,
    degraded:
      response.exceededTransferLimit === true
        ? [
            {
              capability: "spatialAggregate",
              protocol: "geoservices-feature-service",
              sourceId: request.sourceId,
              reason:
                "FeatureServer queryH3 response exceeded the server transfer limit; returned cells may be partial.",
            },
          ]
        : undefined,
  };
}

function featureServerH3CellFromFeature(
  feature: HonuaFeature,
  request: SpatialAggregationRequest,
  plan: FeatureServerH3AggregationPlan,
): SpatialAggregationCell {
  const attributes = feature.attributes ?? {};
  const id = cellIdFromAttributes(attributes);
  const extent = extentFromGeometry(feature.geometry);
  const geometryMode = request.index?.geometry ?? "boundary";
  const cell: SpatialAggregationCell = {
    id,
    resolution: plan.resolution,
    extent,
    summaries: spatialAggregationSummariesFromAttributes(attributes, plan),
  };

  if (geometryMode === "boundary" && isObject(feature.geometry)) {
    return {
      ...cell,
      geometry: feature.geometry,
    };
  }

  return cell;
}

function spatialAggregationSummariesFromAttributes(
  attributes: Record<string, unknown>,
  plan: FeatureServerH3AggregationPlan,
): SpatialAggregationSummaryBag {
  const summaries: Record<string, SpatialAggregationSummaryValue> = {};
  for (const binding of plan.summaryBindings) {
    summaries[binding.summary.id] = spatialAggregationSummaryValueFromAttribute(
      binding.summary,
      attributes[binding.responseField],
    );
  }
  return summaries;
}

function spatialAggregationSummaryValueFromAttribute(
  summary: SpatialAggregationSummarySpec,
  value: unknown,
): SpatialAggregationSummaryValue {
  if (summary.kind === "count") {
    return {
      kind: "count",
      value: Math.max(0, finiteNumberOr(value, 0)),
    };
  }

  if (summary.kind === "sum" || summary.kind === "avg" || summary.kind === "min" || summary.kind === "max") {
    return {
      kind: summary.kind,
      value: finiteNumberOrNull(value),
      unit: summary.unit,
    };
  }

  throw new Error(`FeatureServer queryH3 does not support ${summary.kind} summaries.`);
}

function spatialAggregationSummaryMetadataFromSpec(
  summary: SpatialAggregationSummarySpec,
): SpatialAggregationSummaryMetadata {
  return {
    id: summary.id,
    kind: summary.kind,
    title: summary.title,
    field: summary.field,
    valueType: summary.valueType ?? (summary.kind === "count" ? "number" : undefined),
    unit: summary.unit,
  };
}

function statisticInputField(summary: SpatialAggregationSummarySpec): string {
  if (summary.kind === "count") {
    if (summary.field === undefined) {
      throw new Error("count summaries require a field when queryH3 uses outStatistics.");
    }
    return summary.field;
  }
  if (summary.kind === "sum" || summary.kind === "avg" || summary.kind === "min" || summary.kind === "max") {
    return summary.field;
  }
  throw new Error(`FeatureServer queryH3 does not support ${summary.kind} summaries.`);
}

function outStatisticFieldName(summary: SpatialAggregationSummarySpec, index: number): string {
  const safeId = summary.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
  return `honua_${index + 1}_${safeId || "summary"}`.slice(0, 63);
}

function normalizeH3KRingDistance(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new Error("FeatureServer queryH3 kRingDistance must be an integer between 0 and 20.");
  }
  return value;
}

function cellIdFromAttributes(attributes: Record<string, unknown>): string {
  for (const key of ["cellIndex", "cell_index", "h3Index", "h3_index"]) {
    const value = attributes[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }
  }
  throw new Error("FeatureServer queryH3 response is missing a cellIndex attribute.");
}

function extentFromGeometry(geometry: unknown): HonuaExtent | undefined {
  if (!isObject(geometry)) {
    return undefined;
  }
  if (
    isFiniteNumber(geometry.xmin) &&
    isFiniteNumber(geometry.ymin) &&
    isFiniteNumber(geometry.xmax) &&
    isFiniteNumber(geometry.ymax)
  ) {
    return {
      xmin: geometry.xmin,
      ymin: geometry.ymin,
      xmax: geometry.xmax,
      ymax: geometry.ymax,
      spatialReference: isObject(geometry.spatialReference)
        ? (geometry.spatialReference as HonuaExtent["spatialReference"])
        : undefined,
    };
  }

  const coordinates: Array<readonly [number, number]> = [];
  collectCoordinatePairs(geometry.rings, coordinates);
  collectCoordinatePairs(geometry.paths, coordinates);
  collectCoordinatePairs(geometry.points, coordinates);
  if (isFiniteNumber(geometry.x) && isFiniteNumber(geometry.y)) {
    coordinates.push([geometry.x, geometry.y]);
  }
  if (coordinates.length === 0) {
    return undefined;
  }

  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  for (const [x, y] of coordinates) {
    xmin = Math.min(xmin, x);
    ymin = Math.min(ymin, y);
    xmax = Math.max(xmax, x);
    ymax = Math.max(ymax, y);
  }

  return {
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference: isObject(geometry.spatialReference)
      ? (geometry.spatialReference as HonuaExtent["spatialReference"])
      : undefined,
  };
}

function collectCoordinatePairs(value: unknown, coordinates: Array<readonly [number, number]>): void {
  if (!Array.isArray(value)) {
    return;
  }
  if (isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
    coordinates.push([value[0], value[1]]);
    return;
  }
  for (const child of value) {
    collectCoordinatePairs(child, coordinates);
  }
}

function mergeExtents(extents: readonly HonuaExtent[]): HonuaExtent | undefined {
  if (extents.length === 0) {
    return undefined;
  }
  const [first, ...rest] = extents;
  return rest.reduce<HonuaExtent>(
    (merged, extent) => ({
      xmin: Math.min(merged.xmin, extent.xmin),
      ymin: Math.min(merged.ymin, extent.ymin),
      xmax: Math.max(merged.xmax, extent.xmax),
      ymax: Math.max(merged.ymax, extent.ymax),
      spatialReference: merged.spatialReference ?? extent.spatialReference,
    }),
    first,
  );
}

function finiteNumberOr(value: unknown, fallback: number): number {
  const numeric = finiteNumberOrNull(value);
  return numeric ?? fallback;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (isFiniteNumber(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractFeatureCountFromResponse(response: unknown): number {
  if (isObject(response) && typeof response.count === "number" && Number.isFinite(response.count)) {
    return response.count;
  }
  if (isObject(response) && Array.isArray(response.features)) {
    return response.features.length;
  }
  return 0;
}

function extractFeaturesFromResponse(response: unknown): HonuaFeature[] {
  if (!isObject(response) || !Array.isArray(response.features)) {
    return [];
  }
  return response.features as HonuaFeature[];
}

function extractObjectIdsFromResponse(response: unknown): number[] {
  if (!isObject(response) || !Array.isArray(response.objectIds)) {
    return [];
  }
  return response.objectIds.map((value) => Number(value)).filter((value): value is number => Number.isFinite(value));
}

function extractExtentFromResponse(response: unknown): { extent: HonuaExtent | null; count?: number } {
  if (!isObject(response)) {
    return { extent: null };
  }
  const count = isFiniteNumber(response.count) ? response.count : undefined;
  const extent = isObject(response.extent) ? (response.extent as unknown as HonuaExtent) : null;
  return { extent, count };
}

function normalizeObjectIds(ids: readonly number[] | string): string {
  return Array.isArray(ids) ? ids.join(",") : String(ids);
}

function toFormBody(values: Record<string, string | number | boolean>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    params.set(key, String(value));
  }
  return params.toString();
}

function normalizeLayerPath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function normalizeServicePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function normalizePageSize(pageSize: number | undefined, limit: number | undefined): number {
  if (isFinitePositiveInteger(pageSize)) {
    return pageSize;
  }
  if (isFinitePositiveInteger(limit)) {
    return limit;
  }
  return 100;
}

function normalizeMaxPages(maxPages: number | undefined): number {
  if (isFinitePositiveInteger(maxPages)) {
    return maxPages;
  }
  return 100;
}

function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset));
}

/**
 * Returns `extraParams` with `resultOffset` / `resultRecordCount` removed, so
 * a caller-supplied `extraParams` cannot be applied after (and therefore
 * override) the paging cursor `queryFeaturesAll` computes for each page. The
 * REST wire mapper (`appendQueryExtraParams`) applies `extraParams` after the
 * top-level query fields, so leaving these keys in place would let a stray
 * `extraParams.resultOffset` silently win over the loop's own cursor.
 */
function withoutPagingExtraParams(
  extraParams: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!extraParams) {
    return undefined;
  }
  const { resultOffset: _resultOffset, resultRecordCount: _resultRecordCount, ...rest } = extraParams;
  return rest;
}

/**
 * Produces a cheap identity signature for a query page so
 * `HonuaFeatureLayer.queryFeaturesAll` can detect a gRPC transport that
 * returns the same page again after the `resultOffset` cursor advanced
 * (REQ-002 of issue #663: fail closed rather than loop or silently repeat a
 * page). Prefers the response's declared object-id field, present on every
 * GeoServices-shaped feature response; falls back to serializing the raw
 * attributes when the id field is unavailable.
 */
function grpcPageOffsetSignature(
  response: { objectIdFieldName?: string },
  features: readonly { attributes: unknown }[],
): string {
  const idField = response.objectIdFieldName;
  if (idField) {
    const objectIds = features.map((feature) => (feature.attributes as Record<string, unknown> | undefined)?.[idField]);
    if (objectIds.every((objectId) => objectId !== undefined && objectId !== null)) {
      return JSON.stringify(objectIds);
    }
  }
  return JSON.stringify(features);
}

function normalizeTotalLimit(limit: number | undefined): number | undefined {
  if (!isFinitePositiveInteger(limit)) {
    return undefined;
  }
  return limit;
}

function isFinitePositiveInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.trunc(value) > 0;
}

function buildAttachmentFormData(request: {
  attachment: HonuaFeatureLayerAttachmentData;
  name?: string;
  contentType?: string;
}): FormData {
  const form = new FormData();
  if (request.attachment instanceof Blob) {
    const blob = ensureBlobType(request.attachment, request.contentType);
    const fileName = request.name ?? resolveBlobName(request.attachment);
    form.set("attachment", blob, fileName);
    return form;
  }

  const blob = new Blob([request.attachment], {
    type: request.contentType ?? "application/octet-stream",
  });
  form.set("attachment", blob, request.name ?? "attachment.txt");
  return form;
}

function resolveBlobName(blob: Blob): string {
  if ("name" in blob && typeof (blob as File).name === "string" && (blob as File).name.length > 0) {
    return (blob as File).name;
  }
  return "attachment.bin";
}

function ensureBlobType(blob: Blob, contentType: string | undefined): Blob {
  if (!contentType || blob.type === contentType) {
    return blob;
  }
  return new Blob([blob], { type: contentType });
}

function extractLayerIds(metadata: unknown): number[] {
  if (!isObject(metadata) || !Array.isArray(metadata.layers)) {
    return [];
  }
  const ids: number[] = [];
  for (const layer of metadata.layers) {
    if (!isObject(layer)) {
      continue;
    }
    const parsed = Number(layer.id);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    ids.push(Math.trunc(parsed));
  }
  return ids;
}

function extractOgcFeatures(response: unknown): HonuaOgcFeatureResponse[] {
  if (!isObject(response) || !Array.isArray(response.features)) {
    return [];
  }
  return response.features as HonuaOgcFeatureResponse[];
}
