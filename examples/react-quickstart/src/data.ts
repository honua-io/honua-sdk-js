import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import type { SourceDescriptor } from "@honua/sdk-js/contract";
import { HONUA_MAP_PACKAGE_FORMAT_V1 } from "@honua/sdk-js/runtime";
import type { HonuaMapPackage } from "@honua/sdk-js/runtime";

import type { ReactQuickstartConfig } from "./config.js";

/** Feature-service source descriptor the quickstart queries through. */
export function buildDescriptors(config: ReactQuickstartConfig): SourceDescriptor[] {
  return [
    {
      id: config.serviceId,
      protocol: "geoservices-feature-service",
      locator: { url: config.baseUrl, serviceId: config.serviceId, layerId: config.layerId },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    },
  ];
}

/** Static demo overlay so the map has something to inspect offline. */
export const SITES_GEOJSON = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { name: "Kaka'ako corridor", status: "Ready" },
      geometry: { type: "Point" as const, coordinates: [-157.858, 21.297] },
    },
    {
      type: "Feature" as const,
      properties: { name: "Harbor response district", status: "Standby" },
      geometry: { type: "Point" as const, coordinates: [-157.867, 21.307] },
    },
    {
      type: "Feature" as const,
      properties: { name: "Manoa watershed", status: "Ready" },
      geometry: { type: "Point" as const, coordinates: [-157.8, 21.32] },
    },
  ],
};

/**
 * Minimal, offline-safe `MapPackage`: a background basemap plus an initial
 * view. `HonuaMap` composes this onto MapLibre; the `HonuaLayer` /
 * `HonuaPopup` children add the interactive overlay on top.
 */
export const QUICKSTART_MAP_PACKAGE: HonuaMapPackage = {
  mapPackageId: "react-quickstart",
  format: HONUA_MAP_PACKAGE_FORMAT_V1,
  sourceBindings: [],
  mapSpec: {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#0b1021" } }],
  },
  initialView: { center: [-157.84, 21.31], zoom: 10.5 },
};
