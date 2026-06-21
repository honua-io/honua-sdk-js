import type { EsriGeometryType, EsriSpatialRel } from "@honua/sdk-js";

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 100;
const METADATA_ERROR_MESSAGE = "Failed to fetch service metadata.";

export const GEOMETRY_TYPES = [
  "esriGeometryPoint",
  "esriGeometryPolyline",
  "esriGeometryPolygon",
  "esriGeometryEnvelope",
  "esriGeometryMultipoint",
] as const;

const SPATIAL_REL_MAP: Record<string, EsriSpatialRel> = {
  intersects: "esriSpatialRelIntersects",
  contains: "esriSpatialRelContains",
  within: "esriSpatialRelWithin",
};

export function mapSpatialRel(rel: string | undefined): EsriSpatialRel | undefined {
  if (!rel) return undefined;
  const mapped = SPATIAL_REL_MAP[rel];
  if (!mapped) throw new Error(`Unknown spatialRel "${rel}". Expected: intersects, contains, within`);
  return mapped;
}

export function clampLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  return Math.min(Math.max(1, n), MAX_LIMIT);
}

export function resolveGeometryType(
  geometry: Record<string, unknown> | undefined,
  geometryType: EsriGeometryType | undefined,
): EsriGeometryType | undefined {
  if (geometryType) {
    return geometryType;
  }

  if (!geometry) {
    return undefined;
  }

  if ("xmin" in geometry && "xmax" in geometry && "ymin" in geometry && "ymax" in geometry) {
    return "esriGeometryEnvelope";
  }

  if ("x" in geometry && "y" in geometry) {
    return "esriGeometryPoint";
  }

  if (Array.isArray(geometry.rings)) {
    return "esriGeometryPolygon";
  }

  if (Array.isArray(geometry.paths)) {
    return "esriGeometryPolyline";
  }

  if (Array.isArray(geometry.points)) {
    return "esriGeometryMultipoint";
  }

  return undefined;
}

export function jsonText(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

export function metadataErrorText(): string {
  return METADATA_ERROR_MESSAGE;
}

/**
 * Coerce a feature `count` from a query response into a usable value.
 *
 * The default `grpc-web` transport returns counts via `toSafeNumberOrString`,
 * which yields a **string** when the proto count exceeds
 * `Number.MAX_SAFE_INTEGER` (chosen specifically to avoid precision loss). Both
 * a finite `number` and a numeric `string` are valid counts; anything else
 * (non-finite numbers, non-numeric strings, missing values) returns
 * `undefined`.
 */
export function coerceCount(value: unknown): number | string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    // Accept canonical base-10 integer strings (optionally signed). These are
    // the large-count representation the grpc adapter emits to preserve
    // precision beyond Number.MAX_SAFE_INTEGER.
    return /^-?\d+$/.test(value.trim()) ? value.trim() : undefined;
  }
  return undefined;
}

export function encodeServiceId(serviceId: string): string {
  return encodeURIComponent(serviceId);
}

export function decodeServiceId(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error(`Invalid encoded serviceId: "${encoded}"`);
  }
}

export function parseLayerId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid layerId: "${value}"`);
  }
  return Number.parseInt(value, 10);
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1 || !Number.isFinite(concurrency)) {
    throw new Error(`Invalid concurrency value: ${concurrency}`);
  }

  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
