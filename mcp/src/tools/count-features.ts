import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { GEOMETRY_TYPES, jsonText, mapSpatialRel, resolveGeometryType } from "../helpers.js";

export const schema = z.object({
  serviceId: z.string().describe("The feature service ID"),
  layerId: z.number().int().nonnegative().describe("The layer ID within the service"),
  where: z.string().optional().describe("SQL WHERE clause, e.g. \"status = 'active'\""),
  geometry: z.record(z.unknown()).optional().describe("Esri JSON geometry for spatial filter"),
  geometryType: z
    .enum(GEOMETRY_TYPES)
    .optional()
    .describe("Esri geometry type. If omitted, inferred from geometry when possible."),
  spatialRel: z
    .enum(["intersects", "contains", "within"])
    .optional()
    .describe("Spatial relationship (default: intersects)"),
});

export type Input = z.infer<typeof schema>;

export async function execute(client: HonuaClient, input: Input) {
  const response = (await client.queryFeatures({
    serviceId: input.serviceId,
    layerId: input.layerId,
    where: input.where,
    geometry: input.geometry,
    geometryType: resolveGeometryType(input.geometry, input.geometryType),
    spatialRel: mapSpatialRel(input.spatialRel),
    returnGeometry: false,
    outFields: "OBJECTID",
    extraParams: { returnCountOnly: true },
  })) as Record<string, unknown>;

  const hasCount = Object.prototype.hasOwnProperty.call(response, "count");
  const count = response.count;
  if (!hasCount || typeof count !== "number" || !Number.isFinite(count)) {
    throw new Error("Count query did not return a numeric count.");
  }

  return jsonText({ count });
}
