import type { Result } from "../contract/types.js";
import { encodeCsvCell } from "../core/csv.js";

function attributesOf(feature: Result["features"][number]): Record<string, unknown> {
  return feature.attributes as Record<string, unknown>;
}

/** GeoJSON FeatureCollection of `columns`, with the identity as each feature's id. */
export function featureCollection<T>(result: Result<T>, columns: readonly string[], identityColumn: string) {
  return {
    type: "FeatureCollection",
    features: result.features.map((feature) => {
      const attributes = attributesOf(feature as Result["features"][number]);
      return {
        type: "Feature",
        id: attributes[identityColumn],
        properties: Object.fromEntries(columns.map((name) => [name, attributes[name] ?? null])),
        geometry: feature.geometry ?? null,
      };
    }),
  };
}

/** CSV of `columns` in order; text stays text, so leading zeros survive, and null is an empty cell. */
export function csvDocument<T>(result: Result<T>, columns: readonly string[]): string {
  const cell = (value: unknown) => (value === null || value === undefined ? "" : encodeCsvCell(String(value)));
  const lines = [columns.map((name) => encodeCsvCell(name)).join(",")];
  for (const feature of result.features) {
    const attributes = attributesOf(feature as Result["features"][number]);
    lines.push(columns.map((name) => cell(attributes[name])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
