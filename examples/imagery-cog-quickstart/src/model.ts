import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor } from "@honua/sdk-js/contract";
import { type HonuaClient, type HonuaExportMapResponse, HonuaImageService } from "@honua/sdk-js/honua";
import { buildWmsRasterSourceSpec } from "@honua/sdk-js/runtime";

import { createFixtureImageryCogDataset } from "./fixtures.js";
import type {
  ImageryAccessPath,
  ImageryAuditRow,
  ImageryCogDataset,
  ImageryExtent,
  ImageryLayerDefinition,
  ImageryLayerState,
  ImageryRenderPlan,
  RasterSourceSpec,
} from "./types.js";

export function createDefaultImageryDataset(): ImageryCogDataset {
  return createFixtureImageryCogDataset();
}

export function createImageryRenderPlan(dataset: ImageryCogDataset, client: HonuaClient): ImageryRenderPlan {
  const layers = dataset.layers.map((layer) => createLayerState(layer, client));
  return {
    dataset,
    layers,
    auditRows: layers.map(toAuditRow),
  };
}

export async function hydrateImageryLayerState(
  state: ImageryLayerState,
  client: HonuaClient,
): Promise<ImageryLayerState> {
  try {
    if (state.layer.accessPath === "wms-getmap") {
      const capabilities = await client.wms(state.layer.serviceId).capabilities();
      return {
        ...state,
        metadata: {
          serviceDescription: capabilities.service.title ?? state.layer.title,
          layers: capabilities.layers.map((layer, index) => ({ id: index, name: layer.name })),
        },
      };
    }

    const imageService = new HonuaImageService({ client, serviceId: state.layer.serviceId });
    const [metadata, legendResponse, exportPreview] = await Promise.all([
      imageService.metadata(),
      imageService.legend(),
      state.layer.accessPath === "image-server-export"
        ? imageService.exportImage({
            bbox: extentTuple(state.layer.extent),
            size: [512, 512],
            format: "png",
            extraParams: { renderingPreset: state.layer.bandPreset },
          })
        : Promise.resolve<HonuaExportMapResponse | undefined>(undefined),
    ]);

    return { ...state, metadata, legendResponse, exportPreview };
  } catch (error) {
    return {
      ...state,
      error: error instanceof Error ? error.message : "Unknown imagery capability load failure",
    };
  }
}

export async function hydrateImageryRenderPlan(
  plan: ImageryRenderPlan,
  client: HonuaClient,
): Promise<ImageryRenderPlan> {
  const layers = await Promise.all(plan.layers.map((layer) => hydrateImageryLayerState(layer, client)));
  return {
    ...plan,
    layers,
    auditRows: layers.map(toAuditRow),
  };
}

export function buildImageServerTileUrlTemplate(
  imageService: HonuaImageService,
  format: "png" | "jpg" | "jpeg" | "tif" | "tiff" = "png",
): string {
  const levelSentinel = 98765;
  const rowSentinel = 54321;
  const colSentinel = 12345;
  return imageService
    .tileUrl(levelSentinel, rowSentinel, colSentinel, format)
    .replace(`/${levelSentinel}/${rowSentinel}/${colSentinel}`, "/{z}/{y}/{x}");
}

/**
 * Bridge the SDK helper's legacy WMS placeholders to the tokens MapLibre
 * actually expands. Keep this visible until the runtime helper itself emits
 * `{bbox-epsg-3857}` and concrete image dimensions (#620).
 */
export function normalizeSdkWmsTemplateForMapLibre(source: RasterSourceSpec): RasterSourceSpec {
  const tileSize = String(source.tileSize);
  return {
    ...source,
    tiles: source.tiles.map((template) =>
      template
        .replaceAll("{bbox-epsg3857}", "{bbox-epsg-3857}")
        .replaceAll("{width}", tileSize)
        .replaceAll("{height}", tileSize),
    ),
  };
}

export function summarizeImageryCache(dataset: ImageryCogDataset): string {
  const ready = dataset.layers.filter((layer) => layer.cache.status === "ready").length;
  const stale = dataset.layers.filter((layer) => layer.cache.status === "stale").length;
  const bypass = dataset.layers.filter((layer) => layer.cache.status === "bypass").length;
  return `${ready} ready / ${stale} stale / ${bypass} bypass`;
}

export function summarizeImageryCapabilities(plan: ImageryRenderPlan): string {
  const paths = new Set(plan.layers.map((state) => accessPathLabel(state.layer.accessPath)));
  return Array.from(paths).join(", ");
}

export function setImageryLayerVisibility(
  plan: ImageryRenderPlan,
  layerId: string,
  visible: boolean,
): ImageryRenderPlan {
  return {
    ...plan,
    layers: plan.layers.map((state) => (state.layer.id === layerId ? { ...state, visible } : state)),
  };
}

export function setImageryLayerOpacity(plan: ImageryRenderPlan, layerId: string, opacity: number): ImageryRenderPlan {
  const nextOpacity = Math.max(0, Math.min(1, opacity));
  return {
    ...plan,
    layers: plan.layers.map((state) => (state.layer.id === layerId ? { ...state, opacity: nextOpacity } : state)),
  };
}

export function activeImageryLayerCount(plan: ImageryRenderPlan): number {
  return plan.layers.filter((state) => state.visible).length;
}

function createLayerState(layer: ImageryLayerDefinition, client: HonuaClient): ImageryLayerState {
  const mapSourceId = `${layer.id}-source`;
  const mapLayerId = `${layer.id}-layer`;
  const descriptor = sourceDescriptorForLayer(layer, client);
  return {
    layer,
    mapSourceId,
    mapLayerId,
    sourceSpec: sourceSpecForLayer(layer, client, descriptor),
    ...(descriptor ? { descriptor } : {}),
    visible: layer.visible,
    opacity: layer.defaultOpacity,
  };
}

function sourceDescriptorForLayer(layer: ImageryLayerDefinition, client: HonuaClient): SourceDescriptor | undefined {
  if (layer.accessPath !== "wms-getmap") return undefined;
  return {
    id: layer.id,
    protocol: "wms",
    locator: {
      url: `${client.serverBaseUrl}${layer.endpointPath}`,
      serviceId: layer.serviceId,
      typeName: layer.layerName,
      styleId: "default",
    },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
    attribution: "Honua fixture imagery",
  };
}

function sourceSpecForLayer(
  layer: ImageryLayerDefinition,
  client: HonuaClient,
  descriptor: SourceDescriptor | undefined,
): RasterSourceSpec {
  if (layer.accessPath === "wms-getmap") {
    if (!descriptor) throw new Error(`Missing WMS descriptor for layer ${layer.id}`);
    return normalizeSdkWmsTemplateForMapLibre(
      buildWmsRasterSourceSpec(descriptor, { tileSize: 256, transparent: true }),
    );
  }

  const imageService = new HonuaImageService({ client, serviceId: layer.serviceId });
  return {
    type: "raster",
    tiles: [buildImageServerTileUrlTemplate(imageService, "png")],
    tileSize: 256,
    scheme: "xyz",
    attribution: "Honua fixture imagery",
  };
}

function toAuditRow(state: ImageryLayerState): ImageryAuditRow {
  return {
    capability: state.layer.auditCapability,
    sampleLayer: state.layer.title,
    sdkSurface:
      state.layer.accessPath === "wms-getmap"
        ? "client.wms().capabilities + buildWmsRasterSourceSpec + MapLibre token normalization"
        : state.layer.accessPath === "image-server-export"
          ? "HonuaImageService.exportImage"
          : "HonuaImageService.tileUrl",
    endpoint: state.layer.endpointPath,
    cachePolicy:
      state.layer.cache.source === "not-cached"
        ? "Ad hoc image export is not cached"
        : `Metadata cache ${state.layer.cache.status}`,
  };
}

function extentTuple(extent: ImageryExtent): [number, number, number, number] {
  return [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
}

function accessPathLabel(path: ImageryAccessPath): string {
  switch (path) {
    case "wms-getmap":
      return "WMS GetMap";
    case "image-server-tile":
      return "ImageServer tile";
    case "image-server-export":
      return "ImageServer export";
  }
}
