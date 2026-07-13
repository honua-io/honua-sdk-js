import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import type { SourceDescriptor } from "@honua/sdk-js/contract";

import type { ReactQuickstartConfig } from "./config.js";

/**
 * Feature-service source descriptor the quickstart queries through. The
 * `schema.primaryKey` gives the data-to-map bridge stable feature ids
 * (`promoteId`), which hover/selection feature-state requires.
 */
export function buildDescriptors(config: ReactQuickstartConfig): SourceDescriptor[] {
  return [
    {
      id: config.serviceId,
      protocol: "geoservices-feature-service",
      locator: { url: config.baseUrl, serviceId: config.serviceId, layerId: config.layerId },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      schema: { primaryKey: "OBJECTID" },
    },
  ];
}

/** MapLibre source id `HonuaSourceLayer` mounts under (shared with the sidebar). */
export const QUICKSTART_SOURCE_ID = "quickstart-features";

/**
 * Minimal, offline-safe MapLibre style for the externally-created map: the
 * app (not Honua) owns this map, exactly like a `@vis.gl/react-maplibre`
 * `<Map>` would.
 */
export const BACKGROUND_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [{ id: "background", type: "background" as const, paint: { "background-color": "#0b1021" } }],
};

/** Initial camera over the fixture data. */
export const INITIAL_VIEW = { center: [-157.86, 21.3] as [number, number], zoom: 11.4 };

/**
 * Selection/hover-aware renderer for the mounted layers. The selection
 * binding mirrors the shared selection onto `feature-state` (`selected`),
 * and the bridge's hover option toggles `hover`; these expressions make both
 * states visible.
 */
export const QUICKSTART_RENDERER = {
  paint: {
    polygon: {
      "fill-color": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        "#f59e0b",
        ["boolean", ["feature-state", "hover"], false],
        "#38bdf8",
        "#2dd4bf",
      ],
      "fill-opacity": 0.45,
    },
    polygonOutline: {
      "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#fbbf24", "#0e7490"],
      "line-width": 2,
    },
    point: {
      "circle-radius": 7,
      "circle-color": ["case", ["boolean", ["feature-state", "selected"], false], "#f59e0b", "#38bdf8"],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#0b1021",
    },
  },
} as const;
