import type { OverturePlaceRow } from "./types.js";

export function normalizeFeature(attributes: Record<string, unknown>): OverturePlaceRow {
  const bbox = asRecord(attributes.bbox);
  const names = asRecord(attributes.names);
  return {
    id: String(attributes.id ?? "unknown"),
    name: String(attributes.name ?? names?.primary ?? "Unnamed place"),
    category: String(attributes.category ?? attributes.basic_category ?? "uncategorized"),
    confidence: requiredNumber(attributes.confidence, "confidence"),
    longitude: (requiredNumber(bbox?.xmin, "bbox.xmin") + requiredNumber(bbox?.xmax, "bbox.xmax")) / 2,
    latitude: (requiredNumber(bbox?.ymin, "bbox.ymin") + requiredNumber(bbox?.ymax, "bbox.ymax")) / 2,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  const result = numeric ? Number(value) : Number.NaN;
  if (!Number.isFinite(result)) throw new Error(`Overture ${field} must be a finite number.`);
  return result;
}
