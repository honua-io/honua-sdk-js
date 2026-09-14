import type { QueryFeaturesRequest } from "@honua/sdk-js/honua";

export type ComplaintDistanceQuery = Omit<QueryFeaturesRequest, "serviceId" | "layerId" | "signal">;
export type ComplaintRequester = (query: Omit<QueryFeaturesRequest, "serviceId" | "layerId">) => Promise<unknown>;
export function complaintDistanceRequest(input: {
  day: string;
  dateField: string;
  geometry: Record<string, unknown>;
  geometryType: "esriGeometryPoint" | "esriGeometryPolyline";
  startTimes: unknown[];
}): ComplaintDistanceQuery;
export function matchingDistanceIds(
  request: ComplaintRequester,
  query: ComplaintDistanceQuery,
  signal: AbortSignal,
): Promise<string[]>;
