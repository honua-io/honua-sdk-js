import type { ExecutableGeometryValue } from "../src/contract/schema.js";
import { createSemanticQueryBuilder, legacyWhereToNativeFilter } from "../src/query-planner/index.js";
import type { TemporalValue } from "../src/query-planner/index.js";

interface TypedRecord {
  readonly id: number;
  readonly label: string;
  readonly active: boolean;
  readonly observedAt: TemporalValue<"instant">;
  readonly geometry: ExecutableGeometryValue;
}

const ogc = createSemanticQueryBuilder<TypedRecord, "ogc-features", "primary-geometry">();

// @ts-expect-error Property references are restricted to known record fields.
ogc.property("missing");

ogc.features({
  // @ts-expect-error Projection is restricted to known record fields.
  select: ["id", "missing"] as const,
});

// @ts-expect-error Equality literal type follows the selected field.
ogc.comparison("eq", ogc.property("id"), "one");

// @ts-expect-error Boolean fields do not accept ordered comparison operators.
ogc.comparison("gt", ogc.property("active"), true);

// @ts-expect-error Branded temporal strings are not ordinary pattern fields.
ogc.like(ogc.property("observedAt"), "2026-%");

ogc.aggregate({
  groupBy: [],
  metrics: [
    // @ts-expect-error Numeric metrics cannot target string fields.
    { fn: "avg", field: "label", as: "average" },
  ],
});

// @ts-expect-error An OGC source cannot carry a GeoServices SQL dialect.
ogc.native("geoservices-sql92", { format: "text", text: "1=1" });

const nonSpatial = createSemanticQueryBuilder<TypedRecord, "odata", "non-spatial">();
nonSpatial.features({
  // @ts-expect-error A proven non-spatial query cannot request geometry.
  geometry: "include",
});

// @ts-expect-error WFS raw where has no lossless native-text compatibility dialect.
legacyWhereToNativeFilter("wfs", "status = 'open'");
