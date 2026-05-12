/**
 * Renderer-neutral hit-test and pointer primitives.
 *
 * The helpers in this module normalize MapLibre-shaped rendered features into
 * Honua source-qualified identities without importing a renderer package.
 *
 * @module
 */

import {
  type QueryTileFeatureIdentityTarget,
  type QueryTileSourceDescriptor,
  type Source,
  loadQueryTileFeatureDetail,
  mapQueryTileFeatureIdentity,
} from "../contract/index.js";
import type { FeatureId } from "../contract/types.js";
import { sourceFeatureSelectionTarget } from "../exploration/selection.js";
import type { SourceQualifiedFeatureSelectionTarget } from "../exploration/types.js";

export interface HonuaScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface HonuaLngLat {
  readonly lng: number;
  readonly lat: number;
}

export type HonuaPointerEventType = "click" | "dblclick" | "mousemove" | "mouseenter" | "mouseleave" | "pointer";

export interface HonuaPointerInput {
  readonly type?: HonuaPointerEventType | string;
  readonly point?: HonuaScreenPoint | readonly [number, number];
  readonly lngLat?: HonuaLngLat | readonly [number, number];
  readonly originalEvent?: unknown;
}

export interface HonuaPointerEvent {
  readonly type: HonuaPointerEventType | string;
  readonly point: HonuaScreenPoint;
  readonly lngLat?: readonly [number, number];
  readonly originalEvent?: unknown;
}

export type HonuaHitTestDegradedReason =
  | "renderer-unsupported"
  | "lnglat-unavailable"
  | "geometry-unavailable"
  | "feature-id-unavailable"
  | "source-binding-unavailable"
  | "raster-value-unavailable"
  | "detail-unavailable"
  | "detail-aborted"
  | "detail-failed";

export interface HonuaHitTestDegradedState {
  readonly reason: HonuaHitTestDegradedReason;
  readonly message: string;
  readonly layerId?: string;
  readonly sourceId?: string;
  readonly featureId?: FeatureId;
  readonly cause?: unknown;
}

export interface HonuaHitTestRasterSample {
  readonly value?: unknown;
  readonly band?: number | string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaHitFeature {
  readonly layerId?: string;
  readonly sourceId?: string;
  readonly sourceLayer?: string;
  readonly featureId?: FeatureId;
  readonly selectionTarget?: SourceQualifiedFeatureSelectionTarget;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
  readonly raster?: HonuaHitTestRasterSample;
  readonly detail?: unknown;
  readonly rawFeature: unknown;
  readonly degraded: readonly HonuaHitTestDegradedState[];
}

export interface HonuaHitTestResult {
  readonly point: HonuaScreenPoint;
  readonly lngLat?: readonly [number, number];
  readonly features: readonly HonuaHitFeature[];
  readonly degraded: readonly HonuaHitTestDegradedState[];
  readonly rawFeatures?: readonly unknown[];
}

export interface HonuaRenderedFeatureContext {
  readonly layerId?: string;
  readonly layerType?: string;
  readonly sourceId?: string;
  readonly sourceLayer?: string;
  readonly protocol?: string;
  readonly queryTileDescriptor?: QueryTileSourceDescriptor;
}

export interface HonuaHitTestFeatureOptions {
  readonly featureIdProperty?: string;
  readonly resolveFeatureId?: (feature: unknown, context: HonuaRenderedFeatureContext) => FeatureId | undefined;
  readonly resolveFeatureContext?: (feature: unknown) => HonuaRenderedFeatureContext | undefined;
  readonly queryTileSources?: Readonly<Record<string, QueryTileSourceDescriptor>>;
}

export interface HonuaHitTestOptions extends HonuaHitTestFeatureOptions {
  readonly layers?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceLayers?: readonly string[];
  readonly tolerance?: number;
  readonly maxResults?: number;
  readonly loadDetails?: boolean;
  readonly signal?: AbortSignal;
}

export interface HonuaHitTestMap {
  queryRenderedFeatures?(
    geometry?: HonuaScreenPoint | readonly [HonuaScreenPoint, HonuaScreenPoint],
    options?: { layers?: readonly string[] },
  ): readonly unknown[];
  unproject?(point: HonuaScreenPoint | readonly [number, number]): HonuaLngLat | readonly [number, number];
}

export interface HonuaHitTestDetailContext extends HonuaRenderedFeatureContext {
  readonly target: QueryTileFeatureIdentityTarget;
  readonly hit: HonuaHitFeature;
}

export type HonuaHitTestDetailLoader = (
  context: HonuaHitTestDetailContext,
  options: { readonly signal?: AbortSignal },
) => Promise<unknown>;

export interface HonuaNormalizeHitTestOptions extends HonuaHitTestOptions {
  readonly featureContexts?: Readonly<Record<string, HonuaRenderedFeatureContext>>;
  readonly detailLoader?: HonuaHitTestDetailLoader;
}

export async function hitTestMap(
  map: HonuaHitTestMap,
  input: HonuaPointerInput,
  options: HonuaNormalizeHitTestOptions = {},
): Promise<HonuaHitTestResult> {
  const pointer = normalizePointerEvent(input, map);
  const degraded = pointer.lngLat
    ? []
    : [
        {
          reason: "lnglat-unavailable" as const,
          message: "The renderer did not provide lngLat and cannot unproject screen coordinates.",
        },
      ];

  if (!map.queryRenderedFeatures) {
    return {
      point: pointer.point,
      lngLat: pointer.lngLat,
      features: [],
      degraded: [
        ...degraded,
        { reason: "renderer-unsupported", message: "The renderer does not support queryRenderedFeatures." },
      ],
      rawFeatures: [],
    };
  }

  const rawFeatures = map.queryRenderedFeatures(queryGeometry(pointer.point, options.tolerance), {
    ...(options.layers ? { layers: options.layers } : {}),
  });
  const normalized = normalizeHitTestFeatures(rawFeatures, options);
  const withDetails = options.loadDetails ? await loadHitDetails(normalized, options) : normalized;
  return {
    point: pointer.point,
    lngLat: pointer.lngLat,
    features: withDetails,
    degraded,
    rawFeatures,
  };
}

export function normalizePointerEvent(
  input: HonuaPointerInput | unknown,
  map?: Pick<HonuaHitTestMap, "unproject">,
): HonuaPointerEvent {
  const event = isRecord(input) ? input : {};
  const point = normalizePoint(event.point) ?? normalizePoint(event) ?? clientPoint(event) ?? { x: 0, y: 0 };
  const lngLat = normalizeLngLat(event.lngLat) ?? (map?.unproject ? normalizeLngLat(map.unproject(point)) : undefined);
  return {
    type: typeof event.type === "string" ? event.type : "pointer",
    point,
    ...(lngLat ? { lngLat } : {}),
    originalEvent: input,
  };
}

export function normalizeHitTestFeatures(
  features: readonly unknown[],
  options: HonuaNormalizeHitTestOptions = {},
): HonuaHitFeature[] {
  if (options.maxResults !== undefined && options.maxResults <= 0) return [];
  const out: HonuaHitFeature[] = [];
  for (const feature of features) {
    const context = featureContext(feature, options);
    const hit = normalizeHitFeature(feature, context, options);
    if (options.sourceIds && (!hit.sourceId || !options.sourceIds.includes(hit.sourceId))) continue;
    if (options.sourceLayers && (!hit.sourceLayer || !options.sourceLayers.includes(hit.sourceLayer))) continue;
    out.push(hit);
    if (options.maxResults !== undefined && out.length >= options.maxResults) break;
  }
  return out;
}

export function normalizeHitFeature(
  feature: unknown,
  context: HonuaRenderedFeatureContext,
  options: HonuaHitTestFeatureOptions = {},
): HonuaHitFeature {
  const properties = featureProperties(feature);
  const queryTileDescriptor = context.queryTileDescriptor ?? queryTileDescriptorForContext(context, options);
  const queryTileIdentity = queryTileDescriptor ? mapQueryTileFeatureIdentity(queryTileDescriptor, feature) : undefined;
  const sourceId = queryTileIdentity?.sourceId ?? context.sourceId;
  const sourceLayer = queryTileIdentity?.sourceLayer ?? context.sourceLayer;
  const featureId =
    queryTileIdentity?.id ??
    options.resolveFeatureId?.(feature, context) ??
    featureIdFromFeature(feature, properties, options.featureIdProperty);
  const geometry = featureGeometry(feature);
  const raster = rasterSample(feature);
  const degraded: HonuaHitTestDegradedState[] = [];

  if (!sourceId) {
    degraded.push({ reason: "source-binding-unavailable", message: "Rendered feature has no Honua source binding." });
  }
  if (featureId === undefined) {
    degraded.push({
      reason: "feature-id-unavailable",
      message: "Rendered feature has no stable feature id.",
      layerId: context.layerId,
      sourceId,
    });
  }
  if (geometry === undefined) {
    degraded.push({
      reason: "geometry-unavailable",
      message: "Rendered feature did not include geometry.",
      layerId: context.layerId,
      sourceId,
      featureId,
    });
  }
  if (context.layerType === "raster" && raster?.value === undefined) {
    degraded.push({
      reason: "raster-value-unavailable",
      message: "Rendered raster hit did not include a sample value.",
      layerId: context.layerId,
      sourceId,
      featureId,
    });
  }

  return {
    layerId: context.layerId,
    sourceId,
    sourceLayer,
    featureId,
    ...(sourceId && featureId !== undefined
      ? { selectionTarget: sourceFeatureSelectionTarget(sourceId, featureId, { sourceLayer }) }
      : {}),
    properties,
    geometry,
    raster,
    rawFeature: feature,
    degraded,
  };
}

export function createQueryTileDetailLoader(
  sources: Readonly<Record<string, Source>>,
  descriptors: Readonly<Record<string, QueryTileSourceDescriptor>>,
): HonuaHitTestDetailLoader {
  return async (context, options) => {
    const descriptor = descriptors[context.target.sourceId] ?? descriptors[context.sourceId ?? ""];
    const source = sources[context.target.sourceId] ?? (context.sourceId ? sources[context.sourceId] : undefined);
    if (!descriptor || !source) return undefined;
    return loadQueryTileFeatureDetail({
      source,
      descriptor,
      target: context.target,
      signal: options.signal,
    });
  };
}

async function loadHitDetails(
  features: readonly HonuaHitFeature[],
  options: HonuaNormalizeHitTestOptions,
): Promise<HonuaHitFeature[]> {
  if (!options.detailLoader) {
    return features.map((hit) => ({
      ...hit,
      degraded: [
        ...hit.degraded,
        { reason: "detail-unavailable", message: "No hit-test detail loader was configured.", sourceId: hit.sourceId },
      ],
    }));
  }

  const out: HonuaHitFeature[] = [];
  for (const hit of features) {
    if (options.signal?.aborted) {
      out.push(withDegraded(hit, "detail-aborted", "Hit-test detail loading was aborted."));
      continue;
    }
    if (!hit.sourceId || hit.featureId === undefined) {
      out.push(withDegraded(hit, "detail-unavailable", "Hit-test detail requires a source id and feature id."));
      continue;
    }
    try {
      const target: QueryTileFeatureIdentityTarget = {
        sourceId: hit.sourceId,
        id: hit.featureId,
        ...(hit.sourceLayer ? { sourceLayer: hit.sourceLayer } : {}),
        properties: hit.properties,
        feature: hit.rawFeature,
      };
      const detail = await options.detailLoader({ ...hit, target, hit }, { signal: options.signal });
      out.push(
        detail === undefined ? withDegraded(hit, "detail-unavailable", "No detail was available.") : { ...hit, detail },
      );
    } catch (cause) {
      out.push(
        withDegraded(
          hit,
          options.signal?.aborted ? "detail-aborted" : "detail-failed",
          options.signal?.aborted ? "Hit-test detail loading was aborted." : "Hit-test detail loading failed.",
          cause,
        ),
      );
    }
  }
  return out;
}

function withDegraded(
  hit: HonuaHitFeature,
  reason: HonuaHitTestDegradedReason,
  message: string,
  cause?: unknown,
): HonuaHitFeature {
  return {
    ...hit,
    degraded: [
      ...hit.degraded,
      { reason, message, layerId: hit.layerId, sourceId: hit.sourceId, featureId: hit.featureId, cause },
    ],
  };
}

function queryGeometry(
  point: HonuaScreenPoint,
  tolerance: number | undefined,
): HonuaScreenPoint | readonly [HonuaScreenPoint, HonuaScreenPoint] {
  const hitTolerance = tolerance ?? 0;
  if (hitTolerance <= 0) return point;
  return [
    { x: point.x - hitTolerance, y: point.y - hitTolerance },
    { x: point.x + hitTolerance, y: point.y + hitTolerance },
  ];
}

function featureContext(feature: unknown, options: HonuaNormalizeHitTestOptions): HonuaRenderedFeatureContext {
  const explicit = options.resolveFeatureContext?.(feature);
  if (explicit) return explicit;
  const layerId = featureLayerId(feature);
  return {
    ...(layerId ? { layerId } : {}),
    ...(layerId && options.featureContexts?.[layerId] ? options.featureContexts[layerId] : {}),
    ...featureNativeSourceContext(feature),
  };
}

function queryTileDescriptorForContext(
  context: HonuaRenderedFeatureContext,
  options: HonuaHitTestFeatureOptions,
): QueryTileSourceDescriptor | undefined {
  if (!context.sourceId) return undefined;
  return options.queryTileSources?.[context.sourceId];
}

function normalizePoint(value: unknown): HonuaScreenPoint | undefined {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") {
    return { x: value[0], y: value[1] };
  }
  if (isRecord(value) && typeof value.x === "number" && typeof value.y === "number") {
    return { x: value.x, y: value.y };
  }
  return undefined;
}

function normalizeLngLat(value: unknown): readonly [number, number] | undefined {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") return [value[0], value[1]];
  if (isRecord(value) && typeof value.lng === "number" && typeof value.lat === "number") return [value.lng, value.lat];
  return undefined;
}

function clientPoint(value: Record<string, unknown>): HonuaScreenPoint | undefined {
  return typeof value.clientX === "number" && typeof value.clientY === "number"
    ? { x: value.clientX, y: value.clientY }
    : undefined;
}

function featureIdFromFeature(
  feature: unknown,
  properties: Readonly<Record<string, unknown>>,
  featureIdProperty: string | undefined,
): FeatureId | undefined {
  if (isRecord(feature) && (typeof feature.id === "string" || typeof feature.id === "number")) return feature.id;
  const propertyId =
    (featureIdProperty ? properties[featureIdProperty] : undefined) ??
    properties.OBJECTID ??
    properties.objectid ??
    properties.ObjectID ??
    properties.id;
  return typeof propertyId === "string" || typeof propertyId === "number" ? propertyId : undefined;
}

function featureProperties(feature: unknown): Readonly<Record<string, unknown>> {
  return isRecord(feature) && isRecord(feature.properties) ? feature.properties : {};
}

function featureGeometry(feature: unknown): unknown {
  return isRecord(feature) && "geometry" in feature ? feature.geometry : undefined;
}

function featureLayerId(feature: unknown): string | undefined {
  if (!isRecord(feature)) return undefined;
  const layer = feature.layer;
  return isRecord(layer) && typeof layer.id === "string" ? layer.id : undefined;
}

function featureNativeSourceContext(feature: unknown): HonuaRenderedFeatureContext {
  if (!isRecord(feature)) return {};
  const layer = isRecord(feature.layer) ? feature.layer : {};
  const sourceId =
    typeof feature.source === "string" ? feature.source : typeof layer.source === "string" ? layer.source : undefined;
  const sourceLayer =
    typeof feature.sourceLayer === "string"
      ? feature.sourceLayer
      : typeof feature.sourceLayer === "number"
        ? String(feature.sourceLayer)
        : typeof layer["source-layer"] === "string"
          ? layer["source-layer"]
          : undefined;
  return {
    ...(typeof layer.id === "string" ? { layerId: layer.id } : {}),
    ...(typeof layer.type === "string" ? { layerType: layer.type } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(sourceLayer ? { sourceLayer } : {}),
  };
}

function rasterSample(feature: unknown): HonuaHitTestRasterSample | undefined {
  if (!isRecord(feature)) return undefined;
  const sample = feature.raster ?? feature.sample;
  if (!isRecord(sample)) return undefined;
  return {
    value: sample.value,
    band: typeof sample.band === "number" || typeof sample.band === "string" ? sample.band : undefined,
    metadata: isRecord(sample.metadata) ? sample.metadata : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
