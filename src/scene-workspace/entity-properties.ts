/** Resolve values in a Cesium entity property bag. */
export function readEntityProperties(bag: unknown): Record<string, unknown> {
  if (!bag || typeof bag !== "object") return {};
  const properties = bag as Record<string, unknown>;
  if (Array.isArray(properties.propertyNames) && typeof properties.getValue === "function") {
    const values: unknown = properties.getValue();
    if (values && typeof values === "object") return values as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const getter = value && typeof value === "object" ? (value as { getValue?: () => unknown }).getValue : undefined;
    out[key] = typeof getter === "function" ? getter.call(value) : value;
  }
  return out;
}
