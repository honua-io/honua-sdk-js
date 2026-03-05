/**
 * Converts Esri WebMap baseMap to Honua sources and layers.
 *
 * @module
 */

import type { HonuaLayerSpecification, HonuaMapServiceSourceSpecification } from "../style/specification.js";
import type { WebMapBaseMap, WebMapBaseMapLayer } from "./types.js";
import { warnUnknownProperties, type WarningCollector } from "./warnings.js";

export interface BasemapConversionResult {
  sources: Record<string, HonuaMapServiceSourceSpecification | { type: string; [key: string]: unknown }>;
  layers: HonuaLayerSpecification[];
}

export function convertBasemap(baseMap: WebMapBaseMap | undefined, warn: WarningCollector): BasemapConversionResult {
  const result: BasemapConversionResult = { sources: {}, layers: [] };
  if (!baseMap?.baseMapLayers) return result;

  warnUnknownProperties(baseMap, BASEMAP_PROPERTIES, warn);

  const bmLayers = baseMap.baseMapLayers;
  for (let i = 0; i < bmLayers.length; i++) {
    const bml: WebMapBaseMapLayer = bmLayers[i];
    const bmlWarn = warn.child(`baseMapLayers[${i}]`);
    warnUnknownProperties(bml, BASEMAP_LAYER_PROPERTIES, bmlWarn);
    const sourceId = bml.id ?? `basemap-${i}`;
    const layerId = `${sourceId}-layer`;

    const layerType = bml.layerType ?? "";

    if (layerType === "ArcGISTiledMapServiceLayer" && bml.url) {
      result.sources[sourceId] = {
        type: "honua-map-service",
        url: bml.url,
      };

      const layer: HonuaLayerSpecification = {
        id: layerId,
        type: "raster",
        source: sourceId,
        layout: {},
        paint: {},
      };

      if (bml.visibility === false) {
        layer.layout = { visibility: "none" };
      }
      if (bml.opacity != null && bml.opacity < 1) {
        (layer.paint as Record<string, unknown>)["raster-opacity"] = bml.opacity;
      }

      result.layers.push(layer);
    } else if (layerType === "VectorTileLayer") {
      // Partial support: note styleUrl in metadata
      if (bml.url) {
        result.sources[sourceId] = {
          type: "vector",
          url: bml.url,
        };
      } else {
        bmlWarn.warn("missing-url", "VectorTileLayer missing url");
        continue;
      }

      const layer: HonuaLayerSpecification = {
        id: layerId,
        type: "background",
        source: sourceId,
        layout: {},
        paint: {},
        metadata: {
          ...(bml.styleUrl ? { esriStyleUrl: bml.styleUrl } : {}),
          note: "VectorTileLayer requires style resolution; using placeholder background layer",
        },
      };

      if (bml.visibility === false) {
        layer.layout = { visibility: "none" };
      }

      bmlWarn.warn("vector-tile-partial", "VectorTileLayer support is partial; style must be resolved separately", {
        styleUrl: bml.styleUrl,
      });

      result.layers.push(layer);
    } else {
      bmlWarn.warn("unsupported-basemap-type", `Unsupported basemap layer type: ${layerType}`, { layerType });
    }
  }

  return result;
}

const BASEMAP_PROPERTIES = ["title", "baseMapLayers"] as const;
const BASEMAP_LAYER_PROPERTIES = ["id", "title", "url", "layerType", "visibility", "opacity", "styleUrl"] as const;
