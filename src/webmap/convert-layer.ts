/**
 * Converts a single WebMap operational layer to Honua source(s) and layer(s).
 *
 * Orchestrates per-layer conversion: determines source type from layerType/url,
 * calls renderer/popup/label converters, applies opacity/visibility/min-maxScale.
 *
 * @module
 */

import type {
  HonuaFeatureServiceSourceSpecification,
  HonuaLayerSpecification,
  HonuaMapServiceSourceSpecification,
  HonuaSourceSpecification,
} from "../style/specification.js";
import { convertLabelingInfo } from "./convert-label.js";
import { type HonuaPopupConfig, convertPopupInfo } from "./convert-popup.js";
import { convertRenderer } from "./convert-renderer.js";
import type { WebMapOperationalLayer } from "./types.js";
import { type WarningCollector, warnUnknownProperties } from "./warnings.js";

export interface LayerConversionResult {
  sources: Record<string, HonuaSourceSpecification | { type: string; [key: string]: unknown }>;
  layers: HonuaLayerSpecification[];
  popup?: HonuaPopupConfig;
}

export function convertOperationalLayer(
  opLayer: WebMapOperationalLayer,
  index: number,
  warn: WarningCollector,
): LayerConversionResult {
  const result: LayerConversionResult = { sources: {}, layers: [] };
  const layerWarn = warn.child(`operationalLayers[${index}]`);
  warnUnknownProperties(opLayer, OPERATIONAL_LAYER_PROPERTIES, layerWarn);
  detectUnsupported3DLayerProperties(opLayer, layerWarn);

  const sourceId = opLayer.id ?? `operational-${index}`;
  const layerId = sourceId;

  // Determine source type
  const layerType = opLayer.layerType ?? "";
  const url = opLayer.url ?? "";

  if (layerType === "ArcGISFeatureLayer" || url.includes("FeatureServer")) {
    const source: HonuaFeatureServiceSourceSpecification = {
      type: "honua-feature-service",
      url,
    };
    if (opLayer.layerDefinition?.definitionExpression) {
      source.definitionExpression = opLayer.layerDefinition.definitionExpression;
    }
    result.sources[sourceId] = source;
  } else if (layerType === "ArcGISMapServiceLayer" || url.includes("MapServer")) {
    const source: HonuaMapServiceSourceSpecification = {
      type: "honua-map-service",
      url,
    };
    result.sources[sourceId] = source;
  } else if (opLayer.featureCollection) {
    layerWarn.warn("unsupported-feature-collection", "Inline feature collections are not supported");
    return result;
  } else {
    layerWarn.warn("unsupported-layer-type", `Unsupported layer type: ${layerType}`, { layerType, url });
    return result;
  }

  warnUnknownProperties(opLayer.layerDefinition, LAYER_DEFINITION_PROPERTIES, layerWarn.child("layerDefinition"));
  warnUnknownProperties(
    opLayer.layerDefinition?.drawingInfo,
    DRAWING_INFO_PROPERTIES,
    layerWarn.child("layerDefinition.drawingInfo"),
  );

  // Convert renderer
  const renderer = opLayer.layerDefinition?.drawingInfo?.renderer;
  const rendererResult = convertRenderer(renderer, layerWarn.child("layerDefinition.drawingInfo.renderer"));

  if (rendererResult) {
    const layer: HonuaLayerSpecification = {
      id: layerId,
      type: rendererResult.layerType,
      source: sourceId,
      paint: { ...rendererResult.paint },
      layout: { ...rendererResult.layout },
    };

    // Apply transparency from drawingInfo
    const transparency = opLayer.layerDefinition?.drawingInfo?.transparency;
    if (transparency != null && transparency > 0) {
      applyTransparency(layer, transparency);
    }

    // Apply layer-level opacity
    if (opLayer.opacity != null && opLayer.opacity < 1) {
      applyOpacity(layer, opLayer.opacity);
    }

    // Apply visibility
    if (opLayer.visibility === false) {
      layer.layout = { ...layer.layout, visibility: "none" };
    }

    // Apply scale constraints
    if (opLayer.minScale) layer.maxzoom = scaleToZoom(opLayer.minScale);
    if (opLayer.maxScale) layer.minzoom = scaleToZoom(opLayer.maxScale);

    // Store title in metadata
    if (opLayer.title) {
      layer.metadata = { ...layer.metadata, title: opLayer.title };
    }

    result.layers.push(layer);
  } else if (!renderer) {
    // No renderer — create a default layer so the source is referenced
    const layer: HonuaLayerSpecification = {
      id: layerId,
      type: "circle",
      source: sourceId,
      paint: { "circle-radius": 4, "circle-color": "#007cbf" },
      layout: {},
    };

    if (opLayer.visibility === false) {
      layer.layout = { visibility: "none" };
    }
    if (opLayer.minScale) layer.maxzoom = scaleToZoom(opLayer.minScale);
    if (opLayer.maxScale) layer.minzoom = scaleToZoom(opLayer.maxScale);
    if (opLayer.title) layer.metadata = { title: opLayer.title };

    result.layers.push(layer);
  }

  // Convert labels
  const labelLayers = convertLabelingInfo(
    opLayer.layerDefinition?.drawingInfo?.labelingInfo,
    sourceId,
    layerId,
    layerWarn.child("layerDefinition.drawingInfo"),
  );
  result.layers.push(...labelLayers);

  // Convert popup
  result.popup = convertPopupInfo(opLayer.popupInfo, layerWarn.child("popupInfo"));

  return result;
}

function applyTransparency(layer: HonuaLayerSpecification, transparency: number): void {
  const opacity = 1 - transparency / 100;
  applyOpacity(layer, opacity);
}

function applyOpacity(layer: HonuaLayerSpecification, opacity: number): void {
  const paint = layer.paint as Record<string, unknown>;
  switch (layer.type) {
    case "fill":
      paint["fill-opacity"] = opacity;
      break;
    case "line":
      paint["line-opacity"] = opacity;
      break;
    case "circle":
      paint["circle-opacity"] = opacity;
      break;
    case "symbol":
      paint["icon-opacity"] = opacity;
      paint["text-opacity"] = opacity;
      break;
    case "raster":
      paint["raster-opacity"] = opacity;
      break;
  }
}

function scaleToZoom(scale: number): number {
  if (scale <= 0) return 0;
  return Math.round(Math.log2(559082264 / scale) * 100) / 100;
}

const OPERATIONAL_LAYER_PROPERTIES = [
  "id",
  "title",
  "url",
  "layerType",
  "itemId",
  "visibility",
  "opacity",
  "minScale",
  "maxScale",
  "layerDefinition",
  "popupInfo",
  "featureCollection",
  "layers",
  "mode",
] as const;

const LAYER_DEFINITION_PROPERTIES = ["drawingInfo", "definitionExpression", "minScale", "maxScale"] as const;

const DRAWING_INFO_PROPERTIES = ["renderer", "labelingInfo", "transparency"] as const;

const LAYER_3D_PROPERTIES = ["elevationInfo", "heightInfo", "sceneProperties"] as const;

function detectUnsupported3DLayerProperties(opLayer: WebMapOperationalLayer, warn: WarningCollector): void {
  const layerType = typeof opLayer.layerType === "string" ? opLayer.layerType : "";
  if (layerType.toLowerCase().includes("scene")) {
    warn.warn("unsupported-3d-property", `Layer type '${layerType}' is 3D and not supported`, { layerType });
  }

  for (const key of LAYER_3D_PROPERTIES) {
    if (Object.prototype.hasOwnProperty.call(opLayer, key)) {
      warn.warn("unsupported-3d-property", `Layer property '${key}' is not supported`, { property: key });
    }
  }
}
