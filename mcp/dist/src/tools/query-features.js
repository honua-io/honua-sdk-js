import { z } from "zod";
import { GEOMETRY_TYPES, clampLimit, jsonText, mapSpatialRel, resolveGeometryType } from "../helpers.js";
export const schema = z.object({
    serviceId: z.string().describe("The feature service ID"),
    layerId: z.number().int().nonnegative().describe("The layer ID within the service"),
    where: z.string().optional().describe('SQL WHERE clause, e.g. "population > 50000"'),
    outFields: z.array(z.string()).optional().describe("Fields to return; defaults to all"),
    geometry: z.record(z.unknown()).optional().describe("Esri JSON geometry for spatial filter"),
    geometryType: z
        .enum(GEOMETRY_TYPES)
        .optional()
        .describe("Esri geometry type. If omitted, inferred from geometry when possible."),
    spatialRel: z
        .enum(["intersects", "contains", "within"])
        .optional()
        .describe("Spatial relationship (default: intersects)"),
    orderBy: z.string().optional().describe('Sort order, e.g. "name ASC"'),
    limit: z.number().int().positive().optional().describe("Max features to return (default 100, max 2000)"),
    offset: z.number().int().nonnegative().optional().describe("Number of features to skip (for pagination)"),
    returnGeometry: z.boolean().optional().default(false).describe("Include geometry in results (default: false)"),
});
export async function execute(client, input) {
    const response = await client.queryFeatures({
        serviceId: input.serviceId,
        layerId: input.layerId,
        where: input.where,
        outFields: input.outFields ?? "*",
        geometry: input.geometry,
        geometryType: resolveGeometryType(input.geometry, input.geometryType),
        spatialRel: mapSpatialRel(input.spatialRel),
        orderByFields: input.orderBy,
        resultRecordCount: clampLimit(input.limit),
        resultOffset: input.offset,
        returnGeometry: input.returnGeometry,
    });
    const features = response.features ?? [];
    return jsonText({
        returnedCount: features.length,
        features: features.map((f) => ({
            attributes: f.attributes,
            ...(input.returnGeometry && f.geometry ? { geometry: f.geometry } : {}),
        })),
        exceededTransferLimit: response.exceededTransferLimit ?? false,
        objectIdFieldName: response.objectIdFieldName ?? null,
        geometryType: response.geometryType ?? null,
        spatialReference: response.spatialReference ?? null,
    });
}
