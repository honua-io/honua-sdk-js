import { HonuaNlMapControlError } from "@honua/sdk-js/nl-map-control";
import {
  type SemanticQuery,
  type SourceSpatiality,
  compileSemanticDuckDbQuery,
  createGeoParquetResourceHandle,
  parseSemanticQuery,
} from "@honua/sdk-js/query-planner";
import { CRS, FIXTURE_VERSION, SCHEMA } from "./fixture.js";

export type IncidentQuery = SemanticQuery<Record<string, unknown>, "geoparquet", SourceSpatiality>;
export interface QueryContext {
  readonly sourceId: "incidents";
  readonly sourceVersion: string;
  readonly schemaFingerprint: string;
  readonly authorizationContextId: "public-fixture";
  readonly viewport: readonly [number, number, number, number];
  readonly selectedLocation?: readonly [number, number];
  readonly previousQuery?: IncidentQuery;
  readonly mode: "recorded" | "live";
}
export const MAX_ROWS = 100;
export const resource = createGeoParquetResourceHandle({
  resolver: "io.honua.ask-map",
  id: "incidents",
  authorizationContextId: "public-fixture",
  resourceVersion: FIXTURE_VERSION,
});
export function compile(value: unknown) {
  const query = parseSemanticQuery(value, { schema: SCHEMA, protocol: "geoparquet" }) as IncidentQuery;
  if (!query.page?.limit || query.page.limit > MAX_ROWS || query.page.kind !== "first")
    throw new HonuaNlMapControlError("refusal", "Queries require a first-page limit between 1 and 100.");
  const result = compileSemanticDuckDbQuery<Record<string, unknown>, SourceSpatiality>({
    query,
    schema: SCHEMA,
    resource,
    geometry: { field: "shape", encoding: "wkb" },
  });
  if (result.outcome === "unsupported")
    throw new HonuaNlMapControlError("refusal", result.diagnostics.map((entry) => entry.message).join(" "));
  if (result.artifact.usesNativeFilter || result.fidelity !== "exact")
    throw new HonuaNlMapControlError(
      "refusal",
      "Only exact structured queries are admitted; arbitrary SQL and approximations are unavailable.",
    );
  return { query, artifact: result.artifact };
}
export function viewportFilter(context: QueryContext) {
  return {
    kind: "spatial",
    operator: "bbox-intersects",
    bbox: { box: { layout: "xy", bounds: context.viewport }, crs: CRS },
  } as const;
}

/** Human-readable review follows the parsed query, never the model's prose. */
export function describeQuery(query: IncidentQuery): string {
  const describe = (value: unknown): string => {
    if (!value || typeof value !== "object") return "all features";
    const node = value as Record<string, unknown>;
    if (node.kind === "boolean" && Array.isArray(node.args))
      return node.args.map(describe).join(node.operator === "and" ? " AND " : " OR ");
    if (node.kind === "comparison") {
      const left = node.left as { name: string };
      const right = node.right as { value: unknown };
      return `${left.name} ${String(node.operator)} ${JSON.stringify(right.value)}`;
    }
    if (node.kind === "spatial" && node.operator === "bbox-intersects") return "inside the captured viewport";
    if (node.kind === "spatial" && node.operator === "within-distance") {
      const distance = node.distance as { value: number; unit: string; mode: string };
      const geometry = node.geometry as { geometry: { coordinates: readonly number[] } };
      return `within ${distance.value} ${distance.unit} (${distance.mode}) of EPSG:3857 [${geometry.geometry.coordinates.join(", ")}]`;
    }
    if (node.kind === "spatial") return `spatial ${String(node.operator)} against the reviewed geometry`;
    return `${String(node.kind)} ${String(node.operator ?? "condition")} (see query details)`;
  };
  return `${describe(query.filter)}${query.kind === "aggregate" ? `; count grouped by ${query.groupBy.join(", ")}` : ""}; maximum ${query.page?.limit ?? "unbounded"} rows`;
}
