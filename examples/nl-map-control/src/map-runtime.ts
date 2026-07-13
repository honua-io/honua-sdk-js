import type maplibregl from "maplibre-gl";

import type {
  HonuaAgentLayerSummary,
  HonuaAgentRuntime,
  HonuaAgentSourceSummary,
  HonuaAgentViewport,
  HonuaAgentWidgetQueryRequest,
  HonuaAgentWidgetQueryResult,
} from "@honua/sdk-js/agent-tools";
import type { FeatureSelectionTarget, FilterClause } from "@honua/sdk-js/exploration";

export interface IncidentFeature {
  readonly id: number;
  readonly status: "open" | "closed";
  readonly kind: string;
  readonly lngLat: readonly [number, number];
}

export const INCIDENTS: readonly IncidentFeature[] = [
  { id: 1, status: "open", kind: "fire", lngLat: [-122.3352, 47.6081] },
  { id: 2, status: "open", kind: "medical", lngLat: [-122.3419, 47.6034] },
  { id: 3, status: "closed", kind: "fire", lngLat: [-122.3287, 47.6146] },
  { id: 4, status: "open", kind: "hazmat", lngLat: [-122.3505, 47.6212] },
  { id: 5, status: "closed", kind: "medical", lngLat: [-122.3122, 47.5991] },
  { id: 6, status: "closed", kind: "rescue", lngLat: [-122.3618, 47.5903] },
];

export function incidentsGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: INCIDENTS.map((incident) => ({
      type: "Feature",
      id: incident.id,
      properties: { status: incident.status, kind: incident.kind },
      geometry: { type: "Point", coordinates: [...incident.lngLat] },
    })),
  };
}

const SOURCES: readonly HonuaAgentSourceSummary[] = [
  {
    id: "incidents",
    title: "City incidents (fixture)",
    protocol: "geoservices-feature-service",
    capabilities: ["query", "queryAggregate"],
  },
];

function filterExpression(clause: FilterClause): maplibregl.FilterSpecification | null {
  if (clause.operator === "=") {
    return ["==", ["get", clause.field], clause.value as string | number | boolean];
  }
  if (clause.operator === "!=") {
    return ["!=", ["get", clause.field], clause.value as string | number | boolean];
  }
  return null;
}

function countIncidents(request: HonuaAgentWidgetQueryRequest): number {
  const where = request.query?.where;
  if (typeof where === "string" && where.includes("status = 'open'")) {
    return INCIDENTS.filter((incident) => incident.status === "open").length;
  }
  return INCIDENTS.length;
}

/**
 * A small HonuaAgentRuntime adapter over a live MapLibre map: this is the
 * "map host" the NL layer's plans execute against.
 */
export function createMapLibreAgentRuntime(
  map: maplibregl.Map,
  onEffect: (description: string) => void,
): HonuaAgentRuntime {
  let selection: FeatureSelectionTarget[] = [];
  return {
    id: "nl-map-control-demo",
    listSources: () => SOURCES,
    listLayers: (): HonuaAgentLayerSummary[] =>
      map.getStyle().layers.map((layer) => ({
        id: layer.id,
        type: layer.type,
        sourceId: "source" in layer && typeof layer.source === "string" ? layer.source : undefined,
        visible: true,
      })),
    getViewport: (): HonuaAgentViewport => {
      const center = map.getCenter();
      return { center: [center.lng, center.lat], zoom: map.getZoom() };
    },
    getSelection: () => selection,
    setViewport: (viewport) => {
      if (viewport.bbox) {
        map.fitBounds(
          [
            [viewport.bbox[0], viewport.bbox[1]],
            [viewport.bbox[2], viewport.bbox[3]],
          ],
          { animate: false },
        );
      } else {
        map.jumpTo({
          ...(viewport.center ? { center: [viewport.center[0], viewport.center[1]] } : {}),
          ...(viewport.zoom !== undefined ? { zoom: viewport.zoom } : {}),
          ...(viewport.pitch !== undefined ? { pitch: viewport.pitch } : {}),
          ...(viewport.bearing !== undefined ? { bearing: viewport.bearing } : {}),
        });
      }
      onEffect(`setViewport → ${JSON.stringify(viewport)}`);
      return viewport;
    },
    setFilter: (id, clause) => {
      const expression = clause ? filterExpression(clause) : null;
      map.setFilter("incidents-circles", expression);
      onEffect(clause ? `setFilter "${id}" → ${JSON.stringify(clause)}` : `setFilter "${id}" cleared`);
      return { id };
    },
    addLayer: (layer, beforeId) => {
      map.addLayer(layer as unknown as maplibregl.LayerSpecification, beforeId);
      onEffect(`addLayer → ${String(layer.id ?? "layer")}`);
      return layer;
    },
    selectFeature: (target, options) => {
      selection = options?.replace === false ? [...selection, target] : [target];
      onEffect(`selectFeature → ${JSON.stringify(target)}`);
      return selection;
    },
    runWidgetQuery: (request): HonuaAgentWidgetQueryResult => {
      const count = countIncidents(request);
      onEffect(`runWidgetQuery ${request.kind} on "${request.sourceId}" → ${count}`);
      return { sourceId: request.sourceId, kind: request.kind, data: { count } };
    },
  };
}
