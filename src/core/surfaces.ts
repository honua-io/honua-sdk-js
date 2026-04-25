import type { HonuaClient } from "./client.js";
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
  OgcItemRequest,
  OgcItemsRequest,
  OgcMetadataRequest,
  OgcPatchItemRequest,
  OgcReplaceItemRequest,
  QueryFeaturesRequest,
  QueryMethod,
  QueryRelatedRecordsRequest,
} from "./types.js";

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

  public async featureServiceMetadata(): Promise<HonuaServiceMetadata> {
    return this.client.getFeatureServiceMetadata(this.serviceId);
  }

  public async mapServiceMetadata(): Promise<HonuaServiceMetadata> {
    return this.client.getMapServiceMetadata(this.serviceId);
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
      path: `/rest/services/${encodeURIComponent(this.serviceId)}/${normalizeServicePath(request.path)}`,
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

  public async metadata(): Promise<HonuaLayerMetadata> {
    return this.client.getLayerMetadata(this.serviceId, this.layerId);
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
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: startingOffset + page * pageSize,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = response.features ?? [];
      if (pageFeatures.length === 0) {
        break;
      }

      features.push(...pageFeatures);
      if (pageFeatures.length < pageSize) {
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

    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: startingOffset + page * pageSize,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = response.features ?? [];
      if (pageFeatures.length === 0) {
        break;
      }

      yield pageFeatures;
      if (pageFeatures.length < pageSize) {
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
      `/rest/services/${encodeURIComponent(this.serviceId)}` + `/FeatureServer/${this.layerId}/queryAttachments`;
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
        `/rest/services/${encodeURIComponent(this.serviceId)}` +
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
        `/rest/services/${encodeURIComponent(this.serviceId)}` +
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
        `/rest/services/${encodeURIComponent(this.serviceId)}` +
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
        `/rest/services/${encodeURIComponent(this.serviceId)}` +
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
        `/rest/services/${encodeURIComponent(this.serviceId)}` +
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

  public async metadata(): Promise<HonuaServiceMetadata> {
    return this.client.getMapServiceMetadata(this.serviceId);
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
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryLayer({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: page * pageSize,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      features.push(...pageFeatures);
      if (pageFeatures.length < pageSize) {
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

    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryLayer({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: page * pageSize,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      yield pageFeatures;
      if (pageFeatures.length < pageSize) {
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
      path: `/rest/services/${encodeURIComponent(this.serviceId)}` + `/MapServer/${normalizeServicePath(request.path)}`,
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

  public async metadata(): Promise<HonuaLayerMetadata> {
    return this.client.request({
      method: "GET",
      path: `/rest/services/${encodeURIComponent(this.serviceId)}` + `/MapServer/${this.layerId}`,
    }) as Promise<HonuaLayerMetadata>;
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
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: startingOffset + page * pageSize,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      features.push(...pageFeatures);
      if (pageFeatures.length < pageSize) {
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

    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...request,
        extraParams: {
          ...(request.extraParams ?? {}),
          resultOffset: startingOffset + page * pageSize,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = extractFeaturesFromResponse(response);
      if (pageFeatures.length === 0) {
        break;
      }

      yield pageFeatures;
      if (pageFeatures.length < pageSize) {
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
        `/rest/services/${encodeURIComponent(this.serviceId)}` +
        `/MapServer/${this.layerId}/${normalizeLayerPath(request.path)}`,
    });
  }
}

export interface HonuaOgcFeaturesOptions {
  client: HonuaClient;
}

export interface HonuaOgcFeatureCollectionOptions {
  client: HonuaClient;
  collectionId: string | number;
}

export class HonuaOgcFeatures {
  public readonly client: HonuaClient;

  public constructor(options: HonuaOgcFeaturesOptions) {
    this.client = options.client;
  }

  public collection(collectionId: string | number): HonuaOgcFeatureCollection {
    return new HonuaOgcFeatureCollection({
      client: this.client,
      collectionId,
    });
  }

  public async landing(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcFeaturesLanding(request);
  }

  public async conformance(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return this.client.getOgcFeaturesConformance(request);
  }

  public async collections(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    return this.client.listOgcCollections(request);
  }

  public async getCollection(request: HonuaOgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    return this.client.getOgcCollection(request);
  }

  public async queryables(request: HonuaOgcCollectionRequest): Promise<HonuaOgcQueryablesResponse> {
    return this.client.getOgcQueryables(request);
  }

  public async items(request: HonuaOgcItemsRequest): Promise<HonuaOgcFeatureCollectionResponse> {
    return this.client.listOgcItems(request);
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
    return this.client.getOgcItem(request);
  }

  public async createItem(request: HonuaOgcCreateItemRequest): Promise<HonuaOgcFeatureResponse> {
    return this.client.createOgcItem(request);
  }

  public async replaceItem(request: HonuaOgcReplaceItemRequest): Promise<HonuaOgcFeatureResponse> {
    return this.client.replaceOgcItem(request);
  }

  public async patchItem(request: HonuaOgcPatchItemRequest): Promise<HonuaOgcFeatureResponse> {
    return this.client.patchOgcItem(request);
  }

  public async deleteItem(request: HonuaOgcDeleteItemRequest): Promise<void> {
    return this.client.deleteOgcItem(request);
  }
}

export class HonuaOgcFeatureCollection {
  public readonly client: HonuaClient;
  public readonly collectionId: string | number;

  public constructor(options: HonuaOgcFeatureCollectionOptions) {
    this.client = options.client;
    this.collectionId = options.collectionId;
  }

  public async metadata(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcCollectionMetadata> {
    return this.client.getOgcCollection({
      ...request,
      collectionId: this.collectionId,
    });
  }

  public async queryables(request: HonuaOgcMetadataRequest = {}): Promise<HonuaOgcQueryablesResponse> {
    return this.client.getOgcQueryables({
      ...request,
      collectionId: this.collectionId,
    });
  }

  public async items(request: HonuaOgcCollectionItemsRequest = {}): Promise<HonuaOgcFeatureCollectionResponse> {
    return this.client.listOgcItems({
      ...request,
      collectionId: this.collectionId,
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
    return this.client.getOgcItem({
      ...request,
      collectionId: this.collectionId,
    });
  }

  public async createItem(request: HonuaOgcCollectionCreateItemRequest): Promise<HonuaOgcFeatureResponse> {
    return this.client.createOgcItem({
      ...request,
      collectionId: this.collectionId,
    });
  }

  public async replaceItem(request: HonuaOgcCollectionReplaceItemRequest): Promise<HonuaOgcFeatureResponse> {
    return this.client.replaceOgcItem({
      ...request,
      collectionId: this.collectionId,
    });
  }

  public async patchItem(request: HonuaOgcCollectionPatchItemRequest): Promise<HonuaOgcFeatureResponse> {
    return this.client.patchOgcItem({
      ...request,
      collectionId: this.collectionId,
    });
  }

  public async deleteItem(request: HonuaOgcCollectionDeleteItemRequest): Promise<void> {
    return this.client.deleteOgcItem({
      ...request,
      collectionId: this.collectionId,
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
      path: `/rest/services/${encodeURIComponent(this.serviceId)}/ImageServer`,
      responseFormat: "json",
    });
  }

  public async queryRasterCatalog(request: HonuaImageServiceQueryRequest = {}): Promise<HonuaQueryResponse> {
    return this.client.request<HonuaQueryResponse>({
      method: request.method ?? "GET",
      path: `/rest/services/${encodeURIComponent(this.serviceId)}/ImageServer/query`,
      responseFormat: "json",
      query: imageQueryParams(request),
      signal: request.signal,
    });
  }

  public async queryRasterCatalogObjectIds(request: HonuaImageServiceQueryRequest = {}): Promise<number[]> {
    const response = await this.client.request<{ objectIds?: Array<number | string> }>({
      method: request.method ?? "GET",
      path: `/rest/services/${encodeURIComponent(this.serviceId)}/ImageServer/query`,
      responseFormat: "json",
      query: { ...imageQueryParams(request), where: request.where ?? "1=1", returnIdsOnly: true },
      signal: request.signal,
    });
    if (!Array.isArray(response.objectIds)) return [];
    return response.objectIds.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  }

  public async exportImage(request: HonuaImageServiceExportRequest): Promise<HonuaExportMapResponse> {
    return this.client.request<HonuaExportMapResponse>({
      method: request.method ?? "GET",
      path: `/rest/services/${encodeURIComponent(this.serviceId)}/ImageServer/exportImage`,
      responseFormat: request.responseFormat ?? "json",
      query: imageExportParams(request),
      signal: request.signal,
    });
  }

  public async identify(request: HonuaImageServiceIdentifyRequest): Promise<HonuaIdentifyResponse> {
    return this.client.request<HonuaIdentifyResponse>({
      method: request.method ?? "GET",
      path: `/rest/services/${encodeURIComponent(this.serviceId)}/ImageServer/identify`,
      responseFormat: request.responseFormat ?? "json",
      query: imageIdentifyParams(request),
      signal: request.signal,
    });
  }

  public tileUrl(level: number, row: number, col: number, format: "png" | "jpg" | "jpeg" | "tif" | "tiff" = "png"): string {
    const path = `/rest/services/${encodeURIComponent(this.serviceId)}/ImageServer/tile/${level}/${row}/${col}`;
    return `${path}?f=${format}`;
  }

  public async legend(): Promise<HonuaLegendResponse> {
    return this.client.request<HonuaLegendResponse>({
      method: "GET",
      path: `/rest/services/${encodeURIComponent(this.serviceId)}/ImageServer/legend`,
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
    params.mosaicRule = typeof request.mosaicRule === "string" ? request.mosaicRule : JSON.stringify(request.mosaicRule);
  }
  if (request.renderingRule !== undefined) {
    params.renderingRule = typeof request.renderingRule === "string" ? request.renderingRule : JSON.stringify(request.renderingRule);
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
    params.mosaicRule = typeof request.mosaicRule === "string" ? request.mosaicRule : JSON.stringify(request.mosaicRule);
  }
  if (request.renderingRule !== undefined) {
    params.renderingRule = typeof request.renderingRule === "string" ? request.renderingRule : JSON.stringify(request.renderingRule);
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

export interface HonuaGeometryOperationResponse {
  geometries?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Wrapper over a Honua Geometry Service endpoint. Routes match the
 * canonical paths in `honua-server/docs/gis/geometry-service-matrix.md`
 * (`/rest/services/geometry/<op>`). Operations not implemented in
 * Honua Server (autoComplete, convexHull, cut, etc.) intentionally have
 * no wrapper — callers that need them go through the raw `request()`
 * escape hatch and handle 404s themselves.
 */
export class HonuaGeometryService {
  public readonly client: HonuaClient;

  public constructor(options: HonuaGeometryServiceOptions) {
    this.client = options.client;
  }

  public async project(request: HonuaGeometryProjectRequest): Promise<HonuaGeometryOperationResponse> {
    return this.client.request<HonuaGeometryOperationResponse>({
      method: request.method ?? "POST",
      path: "/rest/services/geometry/project",
      responseFormat: request.responseFormat ?? "json",
      query: geometryProjectParams(request),
      signal: request.signal,
    });
  }

  public async buffer(request: HonuaGeometryBufferRequest): Promise<HonuaGeometryOperationResponse> {
    return this.client.request<HonuaGeometryOperationResponse>({
      method: request.method ?? "POST",
      path: "/rest/services/geometry/buffer",
      responseFormat: request.responseFormat ?? "json",
      query: geometryBufferParams(request),
      signal: request.signal,
    });
  }

  public async simplify(request: HonuaGeometrySimplifyRequest): Promise<HonuaGeometryOperationResponse> {
    return this.client.request<HonuaGeometryOperationResponse>({
      method: request.method ?? "POST",
      path: "/rest/services/geometry/simplify",
      responseFormat: request.responseFormat ?? "json",
      query: geometrySimplifyParams(request),
      signal: request.signal,
    });
  }
}

function geometryProjectParams(request: HonuaGeometryProjectRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
    inSR: typeof request.inSr === "string" || typeof request.inSr === "number" ? String(request.inSr) : JSON.stringify(request.inSr),
    outSR: typeof request.outSr === "string" || typeof request.outSr === "number" ? String(request.outSr) : JSON.stringify(request.outSr),
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
  if (request.inSr !== undefined) params.inSR = typeof request.inSr === "object" ? JSON.stringify(request.inSr) : String(request.inSr);
  if (request.outSr !== undefined) params.outSR = typeof request.outSr === "object" ? JSON.stringify(request.outSr) : String(request.outSr);
  if (request.bufferSr !== undefined) params.bufferSR = typeof request.bufferSr === "object" ? JSON.stringify(request.bufferSr) : String(request.bufferSr);
  if (request.unionResults !== undefined) params.unionResults = request.unionResults;
  if (request.geodesic !== undefined) params.geodesic = request.geodesic;
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function geometrySimplifyParams(request: HonuaGeometrySimplifyRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    geometries: typeof request.geometries === "string" ? request.geometries : JSON.stringify(request.geometries),
  };
  if (request.sr !== undefined) params.sr = typeof request.sr === "object" ? JSON.stringify(request.sr) : String(request.sr);
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

export interface HonuaGeoprocessingJob {
  jobId: string;
  jobStatus: string;
  results?: Record<string, unknown>;
  messages?: ReadonlyArray<{ type: string; description: string }>;
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
    return `/rest/services/${encodeURIComponent(this.serviceId)}/GPServer${taskSegment}/${suffix}`;
  }
}

function gpSubmitParams(request: HonuaGeoprocessingSubmitRequest): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(request.parameters)) {
    params[key] = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value);
  }
  Object.assign(params, request.extraParams ?? {});
  return params;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
