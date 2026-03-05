/**
 * Top-level WebMap JSON → HonuaStyleSpecification parser.
 *
 * @module
 */

import type { HonuaStyleSpecification } from "../style/specification.js";
import type { WebMapJson, WebMapBookmark, WebMapOperationalLayer } from "./types.js";
import {
  createWarningCollector,
  type WarningCollector,
  type WebMapWarning,
  warnUnknownProperties,
} from "./warnings.js";
import { convertBasemap } from "./convert-basemap.js";
import { convertExtent, convertInitialViewpoint } from "./convert-extent.js";
import { convertOperationalLayer } from "./convert-layer.js";
import type { HonuaPopupConfig } from "./convert-popup.js";

export interface ParseWebMapOptions {
  /** If true, include basemap layers. Defaults to true. */
  includeBasemap?: boolean;
}

export interface ParseWebMapResult {
  /** The converted style specification. */
  style: HonuaStyleSpecification;
  /** Non-fatal warnings encountered during conversion. */
  warnings: WebMapWarning[];
  /** Bookmarks from the WebMap, if any. */
  bookmarks: WebMapBookmark[];
  /** Popup configurations keyed by layer ID. */
  popups: Record<string, HonuaPopupConfig>;
}

export function parseWebMap(input: WebMapJson, options?: ParseWebMapOptions): ParseWebMapResult {
  const warn = createWarningCollector();
  const includeBasemap = options?.includeBasemap !== false;

  warnUnknownProperties(input, WEBMAP_TOP_LEVEL_PROPERTIES, warn);
  detectVersionWarnings(input, warn);
  detectUnsupported3DProperties(input, warn);

  const sources: HonuaStyleSpecification["sources"] = {};
  const layers: HonuaStyleSpecification["layers"] = [];
  const popups: Record<string, HonuaPopupConfig> = {};

  // Convert basemap
  if (includeBasemap && input.baseMap) {
    const basemapResult = convertBasemap(input.baseMap, warn.child("baseMap"));
    Object.assign(sources, basemapResult.sources);
    layers.push(...basemapResult.layers);
  }

  // Convert operational layers
  if (input.operationalLayers) {
    const opLayers = input.operationalLayers;
    for (let i = 0; i < opLayers.length; i++) {
      const opLayer: WebMapOperationalLayer = opLayers[i];
      const layerResult = convertOperationalLayer(opLayer, i, warn);
      Object.assign(sources, layerResult.sources);
      layers.push(...layerResult.layers);
      if (layerResult.popup) {
        const layerId = opLayer.id ?? `operational-${i}`;
        popups[layerId] = layerResult.popup;
      }
    }
  }

  // Convert initial viewpoint (preferred over initialExtent for WebMap 2.x)
  const viewpointResult = convertInitialViewpoint(
    input.initialViewpoint ?? input.initialState?.viewpoint,
    warn.child("initialViewpoint"),
  );
  const extentResult = viewpointResult ?? convertExtent(input.initialExtent, warn.child("initialExtent"));

  const style: HonuaStyleSpecification = {
    version: 8,
    sources,
    layers,
    ...(extentResult ? { center: extentResult.center, zoom: extentResult.zoom } : {}),
  };

  // Bookmarks
  const bookmarks = input.bookmarks ?? [];

  return { style, warnings: warn.warnings, bookmarks, popups };
}

const WEBMAP_TOP_LEVEL_PROPERTIES = [
  "version",
  "authoringApp",
  "authoringAppVersion",
  "operationalLayers",
  "baseMap",
  "initialExtent",
  "initialViewpoint",
  "initialState",
  "bookmarks",
  "spatialReference",
  "tables",
] as const;

const THREE_D_TOP_LEVEL_PROPERTIES = new Set(["ground", "heightModelInfo", "viewingMode", "camera"]);

function detectVersionWarnings(input: WebMapJson, warn: WarningCollector): void {
  if (typeof input.version === "string" && !input.version.startsWith("2.")) {
    warn.warn(
      "unsupported-webmap-version",
      `WebMap version '${input.version}' is outside the 2.x compatibility target`,
      { version: input.version },
    );
  }
}

function detectUnsupported3DProperties(input: WebMapJson, warn: WarningCollector): void {
  for (const key of THREE_D_TOP_LEVEL_PROPERTIES) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      warn.warn("unsupported-3d-property", `Top-level 3D property '${key}' is not supported`, { property: key });
    }
  }
}
