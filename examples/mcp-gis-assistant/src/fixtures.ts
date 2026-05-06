import type { AssistantDataset } from "./types.js";

export const ASSISTANT_RESULT_LIMIT = 3;

export function createFixtureMcpGisAssistantDataset(now = 1_798_742_400_000): AssistantDataset {
  const service = {
    id: "honolulu-ops",
    name: "Honolulu Operations",
    type: "FeatureServer",
    status: "supported" as const,
    layerCount: 2,
  };
  const layers = [
    {
      id: 0,
      serviceId: service.id,
      sourceId: "honolulu-ops:0",
      name: "Field Tasks",
      geometryType: "point" as const,
      featureCount: 6,
    },
    {
      id: 1,
      serviceId: service.id,
      sourceId: "honolulu-ops:1",
      name: "Shelter Areas",
      geometryType: "polygon" as const,
      featureCount: 2,
    },
  ];
  const diagnostics = [
    {
      level: "info" as const,
      code: "fixture-backed",
      title: "Fixture assistant",
      detail: "Responses are deterministic fixture transcripts; no live LLM is called.",
    },
    {
      level: "warning" as const,
      code: "statistics-degraded",
      title: "Statistics degraded",
      detail: "Counts are computed from the bounded fixture slice for this first PR.",
    },
    {
      level: "warning" as const,
      code: "missing-cloud-credentials",
      title: "Cloud credentials missing",
      detail: "Set HONUA_API_KEY or HONUA_BEARER_TOKEN before using a live Honua Cloud MCP server.",
    },
  ];

  return {
    workspaceId: "fixture-cloud-honua",
    mode: "fixture",
    activeSourceId: layers[0].sourceId,
    services: [
      service,
      {
        id: "legacy-imagery",
        name: "Legacy Imagery",
        type: "MapServer",
        status: "unsupported",
        layerCount: 1,
      },
    ],
    layers,
    metadata: {
      service,
      layer: layers[0],
      extent: { xmin: -157.9, ymin: 21.27, xmax: -157.78, ymax: 21.35, spatialReference: { wkid: 4326 } },
      fields: [
        { name: "OBJECTID", alias: "Object ID", type: "oid" },
        { name: "title", alias: "Title", type: "string" },
        { name: "status", alias: "Status", type: "string" },
        { name: "priority", alias: "Priority", type: "string" },
        { name: "district", alias: "District", type: "string" },
      ],
      cache: {
        status: "ready",
        source: "fixture",
        updatedAt: now,
        revalidateAfterMs: 300_000,
      },
      capabilities: {
        listServices: "supported",
        describeLayer: "supported",
        queryFeatures: "supported",
        statistics: "degraded",
        realtime: "unsupported",
      },
      diagnostics,
    },
    features: [
      feature("1001", "Harbor debris response", -157.865, 21.307, "open", "critical", "harbor"),
      feature("1002", "Ala Moana pump check", -157.846, 21.293, "closed", "normal", "urban"),
      feature("1003", "Airport logistics delay", -157.91, 21.324, "open", "high", "airport"),
      feature("1004", "Kakaako grid outage", -157.855, 21.299, "open", "critical", "urban"),
      feature("1005", "Waikiki crowd support", -157.829, 21.278, "monitoring", "normal", "urban"),
      feature("1006", "Kalihi culvert inspection", -157.877, 21.333, "open", "high", "inland"),
    ],
    diagnostics,
  };
}

function feature(id: string, title: string, x: number, y: number, status: string, priority: string, district: string) {
  return {
    id,
    title,
    x,
    y,
    attributes: {
      OBJECTID: Number(id),
      title,
      status,
      priority,
      district,
    },
  };
}
