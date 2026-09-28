import { HonuaClient } from "../core/client.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import { encodeServiceIdPath } from "../core/path-utils.js";
import type {
  ApplyEditsRequest,
  HonuaAddAttachmentResponse,
  HonuaApplyEditsResponse,
  HonuaAttachmentListResponse,
  HonuaDeleteAttachmentsResponse,
  HonuaExtent,
  HonuaFeature,
  HonuaFieldInfo,
  HonuaQueryAttachmentsResponse,
  HonuaQueryResponse,
  HonuaRelatedRecordsResponse,
  HonuaUpdateAttachmentResponse,
  QueryMethod,
} from "../core/types.js";
import { responseExceededTransferLimit } from "../core/wire-shared.js";
import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import { parseFeatureLayerUrl } from "./url.js";

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface FeatureLayerCompatOptions {
  /** Service layer URL. Omit when {@link source} holds the features in memory. */
  url?: string;
  /** In-memory graphics. When set without {@link url}, the layer does not call a service. */
  source?: readonly unknown[];
  fields?: readonly unknown[];
  objectIdField?: string;
  geometryType?: string;
  id?: string;
  title?: string;
  outFields?: string | string[];
  definitionExpression?: string;
  renderer?: unknown;
  popupTemplate?: unknown;
  labelingInfo?: unknown[] | unknown;
  labelsVisible?: boolean;
  opacity?: number;
  visible?: boolean;
  minScale?: number;
  maxScale?: number;
  legendEnabled?: boolean;
  listMode?: string;
  maxAttachmentBytes?: number;
  client?: HonuaClient;
  eventBus?: CompatEventBus;
  /** Esri options the codemod leaves on the constructor, such as fieldConfigurations. */
  [extra: string]: unknown;
}

export interface FeatureLayerQueryOptions {
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  /** Abort the in-flight query when the owning view or workflow is disposed. */
  signal?: AbortSignal;
}

export type FeatureLayerQueryAllOptions = FeatureLayerQueryOptions & {
  pageSize?: number;
  maxPages?: number;
};

export interface FeatureLayerEditsOptions {
  adds?: unknown[];
  /** Esri `FeatureLayer.applyEdits` name for {@link adds}. */
  addFeatures?: unknown[];
  updates?: unknown[];
  /** Esri `FeatureLayer.applyEdits` name for {@link updates}. */
  updateFeatures?: unknown[];
  deletes?: number[] | string | readonly { objectId?: number }[];
  /** Esri `FeatureLayer.applyEdits` name for {@link deletes}. */
  deleteFeatures?: readonly unknown[];
  rollbackOnFailure?: boolean;
}

export interface FeatureLayerCreateQueryResult {
  where: string;
  outFields: string[];
  returnGeometry: boolean;
}

export interface FeatureLayerQueryCountOptions {
  where?: string;
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
}

export interface FeatureLayerQueryRelatedFeaturesOptions {
  relationshipId: number;
  objectIds?: number[] | string;
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
}

export interface FeatureLayerQueryAttachmentsOptions {
  objectIds?: number[] | string;
  where?: string;
  method?: QueryMethod;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
}

export interface FeatureLayerListAttachmentsOptions {
  objectId: number;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
}

export interface FeatureLayerDeleteAttachmentsOptions {
  objectId: number;
  attachmentIds: number[] | string;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
}

export type FeatureLayerAttachmentData = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string;

export interface FeatureLayerAddAttachmentOptions {
  objectId: number;
  attachment: FeatureLayerAttachmentData;
  name?: string;
  contentType?: string;
  maxAttachmentBytes?: number;
  responseFormat?: "json" | "pjson";
  extraParams?: Record<string, string | number | boolean>;
}

export interface FeatureLayerUpdateAttachmentOptions extends FeatureLayerAddAttachmentOptions {
  attachmentId: number;
}

export interface FeatureLayerQueryExtentResult {
  extent: HonuaExtent | null;
  count?: number;
}

export type FeatureLayerLoadStatusCompat = "not-loaded" | "loading" | "loaded" | "failed";

export interface FeatureLayerHandleCompat {
  remove(): void;
}

export class FeatureLayerCompat {
  public readonly url: string | undefined;
  public readonly source: readonly unknown[] | undefined;
  public readonly fields: readonly unknown[] | undefined;
  public readonly objectIdField: string | undefined;
  public readonly geometryType: string | undefined;
  public id: string;
  public title: string | undefined;
  public readonly serviceId: string;
  public readonly layerId: number;
  public outFields: string[] | undefined;
  public definitionExpression: string | undefined;
  public renderer: unknown;
  public popupTemplate: unknown;
  public labelingInfo: unknown[];
  public labelsVisible: boolean;
  public opacity: number;
  public visible: boolean;
  public minScale: number;
  public maxScale: number;
  public legendEnabled: boolean;
  public listMode: string;
  /** Populated from layer metadata `extent` when {@link load} succeeds. */
  public fullExtent: HonuaExtent | undefined;
  public loaded: boolean;
  public loadStatus: FeatureLayerLoadStatusCompat;
  public metadata: unknown;
  public timeExtent: { start: Date; end: Date } | undefined;
  public readonly eventBus: CompatEventBus;

  private readonly client: HonuaClient;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly eventListeners: Map<string, Set<(event: unknown) => void>>;
  private readonly maxAttachmentBytes: number;

  public constructor(options: FeatureLayerCompatOptions) {
    const inMemory = options.source !== undefined && options.url === undefined;
    const parsed = inMemory ? undefined : parseFeatureLayerUrl(options.url ?? "");
    this.url = options.url;
    this.source = options.source === undefined ? undefined : [...options.source];
    this.fields = options.fields === undefined ? undefined : [...options.fields];
    this.objectIdField = options.objectIdField;
    this.geometryType = options.geometryType;
    this.serviceId = parsed?.serviceId ?? "memory";
    this.layerId = parsed?.layerId ?? 0;
    this.id = options.id ?? (parsed ? `${this.serviceId}-${this.layerId}` : "memory-feature-layer");
    this.title = options.title;
    this.outFields =
      options.outFields === undefined
        ? undefined
        : Array.isArray(options.outFields)
          ? [...options.outFields]
          : [options.outFields];
    this.definitionExpression = options.definitionExpression;
    this.renderer = options.renderer;
    this.popupTemplate = options.popupTemplate;
    this.labelingInfo = Array.isArray(options.labelingInfo)
      ? [...options.labelingInfo]
      : options.labelingInfo === undefined
        ? []
        : [options.labelingInfo];
    this.labelsVisible = options.labelsVisible ?? true;
    this.opacity = normalizeOpacity(options.opacity ?? 1);
    this.visible = options.visible ?? true;
    this.minScale = normalizeScale(options.minScale);
    this.maxScale = normalizeScale(options.maxScale);
    this.legendEnabled = options.legendEnabled ?? true;
    this.fullExtent = undefined;
    this.listMode = options.listMode ?? "show";
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.metadata = undefined;
    this.timeExtent = undefined;
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.client) ?? new CompatEventBus();
    this.client = options.client ?? new HonuaClient({ baseUrl: parsed?.baseUrl ?? "https://memory.invalid" });
    this.watchListeners = new Map();
    this.eventListeners = new Map();
    this.maxAttachmentBytes = normalizeAttachmentSizeLimit(options.maxAttachmentBytes);
  }

  public async load(): Promise<FeatureLayerCompat> {
    if (!this.loaded) {
      this.loadStatus = "loading";
      this.notifyWatchers("loadStatus", this.loadStatus);
      this.eventBus.emit(
        "feature-layer.loading",
        { serviceId: this.serviceId, layerId: this.layerId, id: this.id },
        this,
      );
      try {
        this.metadata = this.isInMemory
          ? { fields: this.fields ?? [] }
          : await this.client.getLayerMetadata(this.serviceId, this.layerId);
        this.notifyWatchers("metadata", this.metadata);
        this.fullExtent = extentFromMetadata(this.metadata);
        this.notifyWatchers("fullExtent", this.fullExtent);
        this.loaded = true;
        this.notifyWatchers("loaded", this.loaded);
        this.loadStatus = "loaded";
        this.notifyWatchers("loadStatus", this.loadStatus);
        this.eventBus.emit(
          "feature-layer.loaded",
          { serviceId: this.serviceId, layerId: this.layerId, id: this.id },
          this,
        );
      } catch (error) {
        this.metadata = undefined;
        this.notifyWatchers("metadata", this.metadata);
        this.fullExtent = undefined;
        this.notifyWatchers("fullExtent", this.fullExtent);
        this.loaded = false;
        this.notifyWatchers("loaded", this.loaded);
        this.loadStatus = "failed";
        this.notifyWatchers("loadStatus", this.loadStatus);
        this.eventBus.emit(
          "feature-layer.failed",
          { serviceId: this.serviceId, layerId: this.layerId, id: this.id, error },
          this,
        );
        throw error;
      }
    }
    return this;
  }

  public async when(callback?: (layer: FeatureLayerCompat) => void): Promise<FeatureLayerCompat> {
    const layer = await this.load();
    if (callback) {
      callback(layer);
    }

    return layer;
  }

  public refresh(): void {
    this.loaded = false;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "not-loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.metadata = undefined;
    this.notifyWatchers("metadata", this.metadata);
    this.fullExtent = undefined;
    this.notifyWatchers("fullExtent", this.fullExtent);
    this.eventBus.emit(
      "feature-layer.refreshed",
      { serviceId: this.serviceId, layerId: this.layerId, id: this.id },
      this,
    );
  }

  public watch(
    propertyName: "visible" | "loaded" | "labelsVisible" | "legendEnabled",
    listener: (value: boolean) => void,
  ): FeatureLayerHandleCompat;
  public watch(
    propertyName: "opacity" | "minScale" | "maxScale",
    listener: (value: number) => void,
  ): FeatureLayerHandleCompat;
  public watch(
    propertyName: "loadStatus",
    listener: (value: FeatureLayerLoadStatusCompat) => void,
  ): FeatureLayerHandleCompat;
  public watch(propertyName: string, listener: (value: unknown) => void): FeatureLayerHandleCompat;
  public watch(propertyName: string, listener: (value: never) => void): FeatureLayerHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener as (value: unknown) => void);

    return {
      remove: () => {
        listeners?.delete(listener as (value: unknown) => void);
      },
    };
  }

  public setVisibility(visible: boolean): void {
    this.visible = visible;
    this.notifyWatchers("visible", this.visible);
    this.eventBus.emit(
      "layer.visibility-changed",
      { layerId: this.id, serviceId: this.serviceId, sublayerId: this.layerId, visible },
      this,
    );
  }

  public setOpacity(opacity: number): void {
    this.opacity = normalizeOpacity(opacity);
    this.notifyWatchers("opacity", this.opacity);
    this.eventBus.emit(
      "layer.opacity-changed",
      { layerId: this.id, serviceId: this.serviceId, sublayerId: this.layerId, opacity: this.opacity },
      this,
    );
  }

  public setRenderer(renderer: unknown): void {
    this.renderer = renderer;
    this.notifyWatchers("renderer", this.renderer);
    this.eventBus.emit("feature-layer.renderer-changed", { layerId: this.id }, this);
  }

  public setPopupTemplate(popupTemplate: unknown): void {
    this.popupTemplate = popupTemplate;
    this.notifyWatchers("popupTemplate", this.popupTemplate);
    this.eventBus.emit("feature-layer.popup-template-changed", { layerId: this.id }, this);
  }

  public setLabelingInfo(labelingInfo: readonly unknown[]): void {
    this.labelingInfo = [...labelingInfo];
    this.notifyWatchers("labelingInfo", this.labelingInfo);
    this.eventBus.emit("feature-layer.labeling-changed", { layerId: this.id }, this);
  }

  public setDefinitionExpression(definitionExpression: string | undefined): void {
    this.definitionExpression = definitionExpression;
    this.notifyWatchers("definitionExpression", this.definitionExpression);
    this.eventBus.emit("feature-layer.definition-expression-changed", { layerId: this.id, definitionExpression }, this);
  }

  public setOutFields(outFields: string | readonly string[] | undefined): void {
    this.outFields = outFields === undefined ? undefined : Array.isArray(outFields) ? [...outFields] : [outFields];
    this.notifyWatchers("outFields", this.outFields);
    this.eventBus.emit("feature-layer.out-fields-changed", { layerId: this.id, outFields: this.outFields }, this);
  }

  public setLabelsVisible(labelsVisible: boolean): void {
    this.labelsVisible = labelsVisible;
    this.notifyWatchers("labelsVisible", this.labelsVisible);
    this.eventBus.emit("feature-layer.labels-visible-changed", { layerId: this.id, labelsVisible }, this);
  }

  public setScaleRange(minScale: number | undefined, maxScale: number | undefined): void {
    this.minScale = normalizeScale(minScale);
    this.maxScale = normalizeScale(maxScale);
    this.notifyWatchers("minScale", this.minScale);
    this.notifyWatchers("maxScale", this.maxScale);
    this.eventBus.emit(
      "feature-layer.scale-range-changed",
      { layerId: this.id, minScale: this.minScale, maxScale: this.maxScale },
      this,
    );
  }

  public setLegendEnabled(legendEnabled: boolean): void {
    this.legendEnabled = legendEnabled;
    this.notifyWatchers("legendEnabled", this.legendEnabled);
    this.eventBus.emit("feature-layer.legend-enabled-changed", { layerId: this.id, legendEnabled }, this);
  }

  public setTimeExtent(extent: { start: Date; end: Date } | undefined): void {
    this.timeExtent = extent
      ? { start: new Date(extent.start.getTime()), end: new Date(extent.end.getTime()) }
      : undefined;
    this.notifyWatchers("timeExtent", this.timeExtent);
    this.eventBus.emit("feature-layer.time-extent-change", { layerId: this.id, timeExtent: this.timeExtent }, this);
  }

  public destroy(): void {
    this.watchListeners.clear();
    this.eventListeners.clear();
    this.eventBus.emit("feature-layer.destroyed", { id: this.id }, this);
  }

  public on(eventName: string, listener: (event: unknown) => void): FeatureLayerHandleCompat {
    const namespacedEvent = `feature-layer.${eventName}`;
    let listeners = this.eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(eventName, listeners);
    }
    listeners.add(listener);

    const subscription = this.eventBus.on(namespacedEvent, (event) => {
      safeInvokeCompatListener(listener, event.payload);
    });

    return {
      remove: () => {
        listeners?.delete(listener);
        subscription.remove();
      },
    };
  }

  public listFields(): readonly HonuaFieldInfo[] {
    return extractFieldDefinitions(this.isInMemory ? { fields: this.fields } : this.metadata);
  }

  public getField(fieldName: string): HonuaFieldInfo | undefined {
    const normalizedFieldName = fieldName.trim();
    if (normalizedFieldName.length === 0) {
      return undefined;
    }

    return this.listFields().find((field) => {
      return field.name.trim() === normalizedFieldName;
    });
  }

  public hasField(fieldName: string): boolean {
    return this.getField(fieldName) !== undefined;
  }

  public createQuery(): FeatureLayerCreateQueryResult {
    return {
      where: this.definitionExpression ?? "1=1",
      outFields: this.outFields ? [...this.outFields] : ["*"],
      returnGeometry: true,
    };
  }

  private get isInMemory(): boolean {
    return this.source !== undefined && this.url === undefined;
  }

  private assertSupportedMemoryWhere(where: string | undefined): void {
    if (where === undefined) {
      return;
    }
    const clause = where.trim();
    if (clause.length === 0 || /^\s*1\s*=\s*1\s*$/.test(clause)) {
      return;
    }
    for (const part of splitWhereAnd(clause)) {
      if (!isSupportedWhereComparison(part)) {
        throw new HonuaCapabilityNotSupportedError("where", "in-memory", this.id);
      }
    }
  }

  private async queryMemory(options: FeatureLayerQueryOptions): Promise<HonuaQueryResponse> {
    options.signal?.throwIfAborted();
    this.assertSupportedMemoryWhere(this.definitionExpression);
    this.assertSupportedMemoryWhere(options.where);
    if (this.timeExtent) throw new HonuaCapabilityNotSupportedError("time", "in-memory", this.id);
    for (const key of Object.keys(options.extraParams ?? {})) {
      if (key !== "resultOffset" && key !== "resultRecordCount") {
        throw new HonuaCapabilityNotSupportedError(key, "in-memory", this.id);
      }
    }
    const source = ((this.source ?? []) as readonly HonuaFeature[]).filter(
      (feature) =>
        featureMatchesWhere(feature, this.definitionExpression) && featureMatchesWhere(feature, options.where),
    );
    const offset = Number(options.extraParams?.resultOffset ?? 0);
    const count = Number(options.extraParams?.resultRecordCount ?? source.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("In-memory pagination requires nonnegative safe integers");
    }
    const requestedFields = options.outFields ?? this.outFields ?? ["*"];
    const fields = (Array.isArray(requestedFields) ? requestedFields : requestedFields.split(",")).map((f) => f.trim());
    return {
      objectIdFieldName: this.objectIdField,
      features: source.slice(offset, offset + count).map((feature) => ({
        attributes: Object.fromEntries(
          Object.entries(feature.attributes).filter(([key]) => fields.includes("*") || fields.includes(key)),
        ),
        ...(options.returnGeometry === false ? {} : { geometry: feature.geometry }),
      })),
      exceededTransferLimit: offset + count < source.length,
    };
  }

  public queryFeatures(options: FeatureLayerQueryOptions = {}): Promise<HonuaQueryResponse> {
    if (this.isInMemory) return this.queryMemory(options);
    const timeParam = buildTimeParam(this.timeExtent, options.extraParams);
    return this.client.queryFeatures({
      serviceId: this.serviceId,
      layerId: this.layerId,
      where: options.where ?? this.definitionExpression,
      outFields: options.outFields ?? this.outFields,
      returnGeometry: options.returnGeometry,
      method: options.method,
      signal: options.signal,
      extraParams: timeParam ? { ...(options.extraParams ?? {}), time: timeParam } : options.extraParams,
    });
  }

  public async queryFeaturesAll(options: FeatureLayerQueryAllOptions = {}): Promise<HonuaFeature[]> {
    const { pageSize: requestedPageSize, maxPages: requestedMaxPages, ...queryOptions } = options;
    const pageSize =
      typeof requestedPageSize === "number" && Number.isFinite(requestedPageSize)
        ? Math.max(1, Math.trunc(requestedPageSize))
        : 2000;
    const maxPages =
      typeof requestedMaxPages === "number" && Number.isFinite(requestedMaxPages)
        ? Math.max(1, Math.trunc(requestedMaxPages))
        : 100;

    const features: HonuaFeature[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...queryOptions,
        extraParams: {
          ...(queryOptions.extraParams ?? {}),
          resultOffset: offset,
          resultRecordCount: pageSize,
        },
      });

      const pageFeatures = response.features ?? [];
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
    options: FeatureLayerQueryAllOptions = {},
  ): AsyncGenerator<HonuaFeature[], void, undefined> {
    const { pageSize: requestedPageSize, maxPages: requestedMaxPages, ...queryOptions } = options;
    const pageSize =
      typeof requestedPageSize === "number" && Number.isFinite(requestedPageSize)
        ? Math.max(1, Math.trunc(requestedPageSize))
        : 2000;
    const maxPages =
      typeof requestedMaxPages === "number" && Number.isFinite(requestedMaxPages)
        ? Math.max(1, Math.trunc(requestedMaxPages))
        : 100;

    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.queryFeatures({
        ...queryOptions,
        extraParams: {
          ...(queryOptions.extraParams ?? {}),
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

  public async queryObjectIds(options: FeatureLayerQueryCountOptions = {}): Promise<number[]> {
    if (this.isInMemory) {
      const { features = [] } = await this.queryMemory({ ...options, outFields: ["*"], returnGeometry: false });
      return features
        .map((feature) =>
          this.objectIdField ? Number(feature.attributes[this.objectIdField]) : extractObjectId(feature),
        )
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    }
    const response = (await this.client.queryFeatures({
      serviceId: this.serviceId,
      layerId: this.layerId,
      where: options.where ?? this.definitionExpression,
      returnGeometry: false,
      method: options.method,
      extraParams: {
        ...options.extraParams,
        returnIdsOnly: true,
      },
    })) as HonuaQueryResponse & { objectIds?: unknown[] };

    if (Array.isArray(response.objectIds)) {
      return response.objectIds.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    }

    const features = response.features;
    if (!features) {
      return [];
    }

    return features.map((feature) => extractObjectId(feature)).filter((value): value is number => value !== undefined);
  }

  public async queryFeatureCount(options: FeatureLayerQueryCountOptions = {}): Promise<number> {
    if (this.isInMemory) return (await this.queryMemory(options)).features?.length ?? 0;
    const response = (await this.client.queryFeatures({
      serviceId: this.serviceId,
      layerId: this.layerId,
      where: options.where ?? this.definitionExpression,
      returnGeometry: false,
      method: options.method,
      extraParams: {
        ...options.extraParams,
        returnCountOnly: true,
      },
    })) as HonuaQueryResponse & { count?: number };

    if (typeof response.count === "number" && Number.isFinite(response.count)) {
      return response.count;
    }

    return response.features?.length ?? 0;
  }

  public async queryExtent(options: FeatureLayerQueryCountOptions = {}): Promise<FeatureLayerQueryExtentResult> {
    if (this.isInMemory) {
      const { features = [] } = await this.queryMemory(options);
      let extent: HonuaExtent | null = null;
      for (const { geometry } of features) {
        if (!geometry) continue;
        const g = geometry as Record<string, unknown>;
        const coordinates =
          typeof g.x === "number"
            ? [[g.x, g.y]]
            : typeof g.xmin === "number"
              ? [
                  [g.xmin, g.ymin],
                  [g.xmax, g.ymax],
                ]
              : Array.isArray(g.points)
                ? g.points
                : Array.isArray(g.paths)
                  ? g.paths.flat()
                  : Array.isArray(g.rings)
                    ? g.rings.flat()
                    : undefined;
        if (!coordinates) throw new HonuaCapabilityNotSupportedError("geometry extent", "in-memory", this.id);
        for (const [x, y] of coordinates) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("Invalid in-memory coordinates");
          if (!extent)
            extent = {
              xmin: x,
              ymin: y,
              xmax: x,
              ymax: y,
              spatialReference: geometry.spatialReference as HonuaExtent["spatialReference"],
            };
          extent.xmin = Math.min(extent.xmin, x);
          extent.ymin = Math.min(extent.ymin, y);
          extent.xmax = Math.max(extent.xmax, x);
          extent.ymax = Math.max(extent.ymax, y);
        }
      }
      return { extent, count: features.length };
    }
    const response = (await this.client.queryFeatures({
      serviceId: this.serviceId,
      layerId: this.layerId,
      where: options.where ?? this.definitionExpression,
      returnGeometry: false,
      method: options.method,
      extraParams: {
        ...options.extraParams,
        returnExtentOnly: true,
      },
    })) as HonuaQueryResponse & { extent?: HonuaExtent | null; count?: number };

    const count = typeof response.count === "number" && Number.isFinite(response.count) ? response.count : undefined;
    return {
      extent: response.extent ?? null,
      count,
    };
  }

  public async applyEdits(options: FeatureLayerEditsOptions): Promise<HonuaApplyEditsResponse> {
    const adds = options.adds ?? options.addFeatures;
    const updates = options.updates ?? options.updateFeatures;
    const deletes = normalizeEditDeletes(options.deletes ?? options.deleteFeatures, this.objectIdField);
    if (this.isInMemory) {
      const result = withEsriEditNames(
        applyMemoryEdits(this.source as unknown[], this.objectIdField, adds, updates, deletes),
      );
      this.eventBus.emit("feature-layer.edits", { result, layerId: this.id }, this);
      return result;
    }
    const result = withEsriEditNames(
      await this.client.applyEdits({
        serviceId: this.serviceId,
        layerId: this.layerId,
        adds: adds as ApplyEditsRequest["adds"],
        updates: updates as ApplyEditsRequest["updates"],
        deletes,
        rollbackOnFailure: options.rollbackOnFailure,
      }),
    );
    this.eventBus.emit("feature-layer.edits", { result, layerId: this.id }, this);
    return result;
  }

  public queryRelatedFeatures(options: FeatureLayerQueryRelatedFeaturesOptions): Promise<HonuaRelatedRecordsResponse> {
    return this.client.queryRelatedRecords({
      serviceId: this.serviceId,
      layerId: this.layerId,
      relationshipId: options.relationshipId,
      objectIds: options.objectIds,
      where: options.where ?? this.definitionExpression,
      outFields: options.outFields ?? this.outFields,
      returnGeometry: options.returnGeometry,
      method: options.method,
      extraParams: options.extraParams,
    });
  }

  public queryRelatedRecords(options: FeatureLayerQueryRelatedFeaturesOptions): Promise<HonuaRelatedRecordsResponse> {
    return this.queryRelatedFeatures(options);
  }

  public queryAttachments(options: FeatureLayerQueryAttachmentsOptions = {}): Promise<HonuaQueryAttachmentsResponse> {
    return this.client.request({
      method: options.method ?? "GET",
      path: `/rest/services/${encodeServiceIdPath(this.serviceId)}/FeatureServer/${this.layerId}/queryAttachments`,
      responseFormat: options.responseFormat ?? "json",
      query: {
        ...(options.objectIds === undefined
          ? {}
          : {
              objectIds: Array.isArray(options.objectIds) ? options.objectIds.join(",") : options.objectIds,
            }),
        ...(options.where === undefined ? {} : { where: options.where }),
        ...(options.extraParams ?? {}),
      },
    });
  }

  public listAttachments(options: FeatureLayerListAttachmentsOptions): Promise<HonuaAttachmentListResponse> {
    return this.client.request({
      method: "GET",
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/FeatureServer/${this.layerId}/${options.objectId}/attachments`,
      responseFormat: options.responseFormat ?? "json",
      query: options.extraParams,
    });
  }

  public deleteAttachments(options: FeatureLayerDeleteAttachmentsOptions): Promise<HonuaDeleteAttachmentsResponse> {
    const params = new URLSearchParams();
    params.set("f", options.responseFormat ?? "json");
    params.set(
      "attachmentIds",
      Array.isArray(options.attachmentIds) ? options.attachmentIds.join(",") : String(options.attachmentIds),
    );
    if (options.extraParams) {
      for (const [key, value] of Object.entries(options.extraParams)) {
        params.set(key, String(value));
      }
    }

    return this.client.request({
      method: "POST",
      path:
        `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
        `/FeatureServer/${this.layerId}/${options.objectId}/deleteAttachments`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  }

  public addAttachment(options: FeatureLayerAddAttachmentOptions): Promise<HonuaAddAttachmentResponse> {
    const maxAttachmentBytes = options.maxAttachmentBytes ?? this.maxAttachmentBytes;
    enforceAttachmentSizeLimit(options.attachment, maxAttachmentBytes);
    const formOrPromise = buildAttachmentFormData({
      ...options,
      maxAttachmentBytes,
    });
    const sendForm = (form: FormData): Promise<HonuaAddAttachmentResponse> =>
      this.client.request({
        method: "POST",
        path:
          `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
          `/FeatureServer/${this.layerId}/${options.objectId}/addAttachment`,
        responseFormat: options.responseFormat ?? "json",
        query: options.extraParams,
        body: form,
      });
    if (formOrPromise instanceof Promise) {
      return formOrPromise.then(sendForm);
    }
    return sendForm(formOrPromise);
  }

  public updateAttachment(options: FeatureLayerUpdateAttachmentOptions): Promise<HonuaUpdateAttachmentResponse> {
    const maxAttachmentBytes = options.maxAttachmentBytes ?? this.maxAttachmentBytes;
    enforceAttachmentSizeLimit(options.attachment, maxAttachmentBytes);
    const formOrPromise = buildAttachmentFormData({
      ...options,
      maxAttachmentBytes,
    });
    const sendForm = (form: FormData): Promise<HonuaUpdateAttachmentResponse> => {
      form.set("attachmentId", String(options.attachmentId));
      return this.client.request({
        method: "POST",
        path:
          `/rest/services/${encodeServiceIdPath(this.serviceId)}` +
          `/FeatureServer/${this.layerId}/${options.objectId}/updateAttachment`,
        responseFormat: options.responseFormat ?? "json",
        query: options.extraParams,
        body: form,
      });
    };
    if (formOrPromise instanceof Promise) {
      return formOrPromise.then(sendForm);
    }
    return sendForm(formOrPromise);
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

function extentFromMetadata(metadata: unknown): HonuaExtent | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.extent)) {
    return undefined;
  }
  const { xmin, ymin, xmax, ymax } = metadata.extent;
  if (![xmin, ymin, xmax, ymax].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return undefined;
  }
  const spatialReference = isRecord(metadata.extent.spatialReference) ? metadata.extent.spatialReference : undefined;
  const wkid = spatialReference && typeof spatialReference.wkid === "number" ? spatialReference.wkid : undefined;
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    ...(wkid === undefined ? {} : { spatialReference: { wkid } }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) {
    return 1;
  }
  return Math.min(Math.max(opacity, 0), 1);
}

function normalizeScale(scale: number | undefined): number {
  if (scale === undefined || !Number.isFinite(scale)) {
    return 0;
  }
  return Math.max(0, Math.trunc(scale));
}

function extractObjectId(feature: unknown): number | undefined {
  if (!isRecord(feature)) {
    return undefined;
  }

  const attributes = feature.attributes;
  if (!isRecord(attributes)) {
    return undefined;
  }

  for (const key of ["objectid", "OBJECTID", "id"]) {
    const raw = attributes[key];
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function extractFieldDefinitions(metadata: unknown): HonuaFieldInfo[] {
  if (!isRecord(metadata)) {
    return [];
  }

  const fields = metadata.fields;
  if (!Array.isArray(fields)) {
    return [];
  }

  const records: HonuaFieldInfo[] = [];
  for (const field of fields) {
    if (!isRecord(field) || typeof field.name !== "string" || typeof field.type !== "string") {
      continue;
    }
    records.push(field as unknown as HonuaFieldInfo);
  }
  return records;
}

function buildAttachmentFormData(options: {
  attachment: FeatureLayerAttachmentData;
  name?: string;
  contentType?: string;
  maxAttachmentBytes: number;
}): FormData | Promise<FormData> {
  const attachmentName = resolveAttachmentName(options.attachment, options.name);
  const blobOrPromise = normalizeAttachmentData(options.attachment, options.contentType, options.maxAttachmentBytes);

  const buildForm = (blob: Blob): FormData => {
    const form = new FormData();
    if (options.name) {
      form.set("name", options.name);
    }
    form.set("attachment", blob, attachmentName);
    return form;
  };

  if (blobOrPromise instanceof Promise) {
    return blobOrPromise.then(buildForm);
  }
  return buildForm(blobOrPromise);
}

function normalizeAttachmentSizeLimit(maxAttachmentBytes: number | undefined): number {
  if (typeof maxAttachmentBytes !== "number" || !Number.isFinite(maxAttachmentBytes)) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  return Math.max(1, Math.trunc(maxAttachmentBytes));
}

function enforceAttachmentSizeLimit(attachment: FeatureLayerAttachmentData, maxAttachmentBytes: number): void {
  const sizeBytes = estimateAttachmentSizeBytes(attachment);
  if (sizeBytes === undefined || sizeBytes <= maxAttachmentBytes) {
    return;
  }
  throw new Error(`Attachment payload exceeds maxAttachmentBytes (${sizeBytes} > ${maxAttachmentBytes}).`);
}

function estimateAttachmentSizeBytes(attachment: FeatureLayerAttachmentData): number | undefined {
  if (attachment instanceof Blob) {
    return attachment.size;
  }

  if (typeof attachment === "string") {
    return new TextEncoder().encode(attachment).byteLength;
  }

  if (attachment instanceof ArrayBuffer) {
    return attachment.byteLength;
  }

  if (isReadableStream(attachment)) {
    return undefined;
  }

  return (attachment as ArrayBufferView).byteLength;
}

function resolveAttachmentName(attachment: FeatureLayerAttachmentData, explicitName?: string): string {
  if (explicitName && explicitName.trim().length > 0) {
    return explicitName.trim();
  }

  if (isRecord(attachment)) {
    const inferredName = attachment.name;
    if (typeof inferredName === "string" && inferredName.trim().length > 0) {
      return inferredName.trim();
    }
  }

  return "attachment.bin";
}

function buildTimeParam(
  timeExtent: { start: Date; end: Date } | undefined,
  extraParams?: Record<string, string | number | boolean>,
): string | undefined {
  if (!timeExtent) {
    return undefined;
  }
  if (extraParams && "time" in extraParams) {
    return undefined;
  }
  return `${timeExtent.start.getTime()},${timeExtent.end.getTime()}`;
}

function normalizeAttachmentData(
  attachment: FeatureLayerAttachmentData,
  contentType: string | undefined,
  maxAttachmentBytes: number,
): Blob | Promise<Blob> {
  if (attachment instanceof Blob) {
    return attachment;
  }

  if (typeof attachment === "string") {
    return new Blob([attachment], {
      type: contentType ?? "text/plain",
    });
  }

  if (attachment instanceof ArrayBuffer) {
    return new Blob([attachment], {
      type: contentType ?? "application/octet-stream",
    });
  }

  if (isReadableStream(attachment)) {
    return collectStreamToBlob(attachment, contentType ?? "application/octet-stream", maxAttachmentBytes);
  }

  if (ArrayBuffer.isView(attachment)) {
    const source = new Uint8Array(attachment.buffer, attachment.byteOffset, attachment.byteLength);
    const copy = Uint8Array.from(source);
    return new Blob([copy], {
      type: contentType ?? "application/octet-stream",
    });
  }

  throw new Error("Unsupported attachment payload type.");
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof (value as Record<string, unknown>).getReader === "function"
  );
}

async function collectStreamToBlob(
  stream: ReadableStream<Uint8Array>,
  contentType: string,
  maxAttachmentBytes: number,
): Promise<Blob> {
  const reader = stream.getReader();
  const chunks: ArrayBuffer[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxAttachmentBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors; size-limit failure is the primary error.
          }
          throw new Error(`Attachment payload exceeds maxAttachmentBytes (${totalBytes} > ${maxAttachmentBytes}).`);
        }
        chunks.push(copyToArrayBuffer(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: contentType });
}

function copyToArrayBuffer(chunk: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy.buffer;
}

function featureAttributes(feature: unknown): Record<string, unknown> {
  if (!feature || typeof feature !== "object") {
    return {};
  }
  const attributes = (feature as { attributes?: unknown }).attributes;
  return attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
}

function featureObjectId(feature: unknown, objectIdField: string | undefined): number | undefined {
  const attributes = featureAttributes(feature);
  const raw = attributes[objectIdField ?? "OBJECTID"] ?? attributes.OBJECTID ?? attributes.objectId;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function featureMatchesWhere(feature: unknown, where: string | undefined): boolean {
  const clause = (where ?? "1=1").trim();
  if (clause.length === 0 || clause === "1=1" || clause.replace(/\s+/g, "").toLowerCase() === "1=1") {
    return true;
  }
  return splitWhereAnd(clause).every((part) => featureMatchesComparison(feature, part));
}

function splitWhereAnd(where: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < where.length; index += 1) {
    const char = where[index] ?? "";
    if (quote) {
      current += char;
      if (char === quote) {
        if (where[index + 1] === quote) {
          current += quote;
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (where.slice(index, index + 5).toLowerCase() === " and ") {
      parts.push(current.trim());
      current = "";
      index += 4;
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

function isSupportedWhereComparison(comparison: string): boolean {
  return /^([A-Za-z_][\w.]*)\s*(=|like)\s*('(?:[^']|'')*'|"(?:[^"]|"")*"|-?\d+(?:\.\d+)?)$/i.test(comparison.trim());
}

function featureMatchesComparison(feature: unknown, comparison: string): boolean {
  const match = /^([A-Za-z_][\w.]*)\s*(=|like)\s*('(?:[^']|'')*'|"(?:[^"]|"")*"|-?\d+(?:\.\d+)?)$/i.exec(
    comparison.trim(),
  );
  if (!match) {
    return false;
  }
  const field = match[1] ?? "";
  const operator = (match[2] ?? "").toLowerCase();
  const expected = unquoteWhereLiteral(match[3] ?? "");
  const attributes = featureAttributes(feature);
  const actual = Object.entries(attributes).find(([name]) => name.toLowerCase() === field.toLowerCase())?.[1];
  const actualText = actual === undefined || actual === null ? "" : String(actual);
  if (operator === "like") {
    const pattern = expected
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/%/g, ".*")
      .replace(/_/g, ".");
    return new RegExp(`^${pattern}$`, "i").test(actualText);
  }
  return (
    actualText === expected ||
    (expected !== "" && Number(actualText) === Number(expected) && Number.isFinite(Number(expected)))
  );
}

function unquoteWhereLiteral(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "'" || quote === '"') && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll(`${quote}${quote}`, quote);
  }
  return trimmed;
}

function normalizeEditDeletes(
  deletes: FeatureLayerEditsOptions["deletes"] | FeatureLayerEditsOptions["deleteFeatures"],
  objectIdField: string | undefined,
): number[] | string | undefined {
  if (deletes === undefined) {
    return undefined;
  }
  if (typeof deletes === "string") {
    return deletes;
  }
  return deletes
    .map((entry) => objectIdFromEditEntry(entry, objectIdField))
    .filter((value): value is number => value !== undefined);
}

function objectIdFromEditEntry(entry: unknown, objectIdField: string | undefined): number | undefined {
  if (typeof entry === "number" && Number.isFinite(entry)) {
    return entry;
  }
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const record = entry as { objectId?: unknown; attributes?: Record<string, unknown> };
  if (typeof record.objectId === "number" && Number.isFinite(record.objectId)) {
    return record.objectId;
  }
  const attributes = record.attributes;
  if (!attributes) {
    return undefined;
  }
  const raw = attributes[objectIdField ?? "OBJECTID"] ?? attributes.OBJECTID ?? attributes.objectId;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function withEsriEditNames(result: HonuaApplyEditsResponse): HonuaApplyEditsResponse {
  return {
    ...result,
    addFeatureResults: result.addResults,
    updateFeatureResults: result.updateResults,
    deleteFeatureResults: result.deleteResults,
  };
}

function applyMemoryEdits(
  features: unknown[],
  objectIdField: string | undefined,
  adds: readonly unknown[] | undefined,
  updates: readonly unknown[] | undefined,
  deletes: number[] | string | undefined,
): HonuaApplyEditsResponse {
  const deleteIds = new Set(Array.isArray(deletes) ? deletes : []);
  const deleteResults = [...deleteIds].map((objectId) => {
    const index = features.findIndex((feature) => featureObjectId(feature, objectIdField) === objectId);
    if (index >= 0) {
      features.splice(index, 1);
    }
    return { objectId, success: index >= 0 };
  });
  let nextId = 0;
  for (const feature of features) {
    nextId = Math.max(nextId, featureObjectId(feature, objectIdField) ?? 0);
  }
  const addResults = (adds ?? []).map((feature) => {
    const existing = featureObjectId(feature, objectIdField);
    const objectId = existing ?? ++nextId;
    if (existing === undefined && feature && typeof feature === "object") {
      const record = feature as { attributes?: Record<string, unknown> };
      record.attributes = { ...(record.attributes ?? {}), [objectIdField ?? "OBJECTID"]: objectId };
    }
    features.push(feature);
    return { objectId, success: true };
  });
  const updateResults = (updates ?? []).map((feature) => {
    const objectId = featureObjectId(feature, objectIdField);
    if (objectId === undefined) {
      return { objectId: -1, success: false, error: { code: 400, description: "Update is missing an object id." } };
    }
    const index = features.findIndex((candidate) => featureObjectId(candidate, objectIdField) === objectId);
    if (index < 0) {
      return {
        objectId,
        success: false,
        error: { code: 404, description: "Feature was not in the in-memory source." },
      };
    }
    features[index] = feature;
    return { objectId, success: true };
  });
  return { addResults, updateResults, deleteResults };
}
