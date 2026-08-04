/**
 * Equivalence ledger between the two filter lanes (#947 S2).
 *
 * The canonical lowering (`src/contract/query-filter.ts`, stable, schema-free,
 * behind `Source.query()`) and the schema-verified planner compilers
 * (`src/query-planner/*`, experimental, evidence-gated) both turn a filter into
 * GeoServices SQL-92. They are not one compiler and deliberately are not going
 * to be — the planner lane verifies a `SourceSchemaV2`, maps logical fields to
 * physical paths, checks CRS/axis order, reports structured fidelity losses, and
 * fingerprints its request; the canonical lane has no verified schema at query
 * time and fails closed by throwing instead.
 *
 * What must never happen is a *silent* difference. This ledger compiles the same
 * logical filter through both lanes and pins each row as either `identical` or a
 * `documented` difference with its reason, so any drift on either side fails
 * here rather than surfacing as a mismatched result set in production.
 *
 * The attribute AST is shared verbatim: `comparison`, `list`, `range`, `null`,
 * `pattern`, `boolean`, and `not` nodes have the same JSON shape in both lanes,
 * which is why the same object can be handed to both compilers below.
 */

import { describe, expect, it } from "vitest";

import { type QueryFilterExpression, compileQueryFilterToSql92, queryFilter } from "../src/contract/query-filter.js";
import { compileSemanticGeoServicesQuery } from "../src/query-planner/geoservices.js";

import { geoServicesSemanticSource, semanticLaneSchema } from "./semantic-lane-fixture.js";

const schema = semanticLaneSchema();

/** Canonical lane result: emitted SQL, or the construct name it refused. */
function canonical(filter: QueryFilterExpression): string {
  try {
    return compileQueryFilterToSql92(filter, { protocol: "geoservices-feature-service" }).where ?? "(none)";
  } catch (error) {
    return `refused:${(error as { capability?: string }).capability}`;
  }
}

/** Planner lane result: emitted SQL, or its stable unsupported diagnostic code. */
function semantic(filter: QueryFilterExpression): string {
  const result = compileSemanticGeoServicesQuery({
    query: { kind: "features", select: ["status"], geometry: "omit", filter } as never,
    schema,
    source: geoServicesSemanticSource as never,
  });
  return result.outcome === "compiled"
    ? (result.artifact.where ?? "(none)")
    : `unsupported:${result.diagnostics[0].code}`;
}

interface LedgerRow {
  readonly label: string;
  readonly filter: QueryFilterExpression;
  readonly canonical: string;
  readonly semantic: string;
  /** `identical` modulo the documented identifier-quoting difference. */
  readonly verdict: "identical" | "documented";
  readonly reason?: string;
}

/**
 * Identifier quoting is a whole-ledger difference rather than a per-row one: the
 * planner lane resolved every name against a verified schema, so it can quote
 * safely; the canonical lane only regex-validates caller text and emits it bare
 * so a case-folding server keeps its own resolution rules.
 */
const QUOTING_REASON = "planner quotes schema-verified identifiers; the canonical lane emits caller text bare";

const LEDGER: readonly LedgerRow[] = [
  {
    label: "comparison/eq",
    filter: queryFilter.eq("status", "open"),
    canonical: "status = 'open'",
    semantic: `"status" = 'open'`,
    verdict: "identical",
  },
  {
    label: "list/in",
    filter: queryFilter.isIn("score", [1, 2]),
    canonical: "score IN (1, 2)",
    semantic: `"score" IN (1, 2)`,
    verdict: "identical",
  },
  {
    label: "range/between",
    filter: queryFilter.between("score", 1, 9),
    canonical: "score BETWEEN 1 AND 9",
    semantic: `"score" BETWEEN 1 AND 9`,
    verdict: "identical",
  },
  {
    label: "null/is-null",
    filter: queryFilter.isNull("optionalNote"),
    canonical: "optionalNote IS NULL",
    semantic: `"optionalNote" IS NULL`,
    verdict: "identical",
  },
  {
    label: "pattern/like",
    filter: queryFilter.like("status", "op%"),
    canonical: "status LIKE 'op%'",
    semantic: `"status" LIKE 'op%'`,
    verdict: "identical",
  },
  {
    label: "boolean/and",
    filter: queryFilter.and(queryFilter.eq("status", "open"), queryFilter.gt("score", 3)),
    canonical: "(status = 'open') AND (score > 3)",
    semantic: `("status" = 'open') AND ("score" > 3)`,
    verdict: "identical",
  },
  {
    label: "not",
    filter: queryFilter.not(queryFilter.eq("status", "open")),
    canonical: "NOT (status = 'open')",
    semantic: `NOT ("status" = 'open')`,
    verdict: "identical",
  },
  {
    // The alignment this slice landed: `before` and `after` are STRICT in both
    // lanes, matching CQL2 T_BEFORE/T_AFTER and FES Before/After. Before #947
    // S2 the canonical lane emitted `<=` / `>=` and silently returned one extra
    // instant's worth of rows.
    label: "temporal/before",
    filter: queryFilter.before("observedAt", "2026-07-15T00:00:00Z"),
    canonical: "observedAt < TIMESTAMP '2026-07-15T00:00:00Z'",
    semantic: `"observedAt" < TIMESTAMP '2026-07-15 00:00:00'`,
    verdict: "documented",
    reason: "same strict comparison; the planner reformats the literal for a schema-typed esriFieldTypeDate column",
  },
  {
    label: "temporal/after",
    filter: queryFilter.after("observedAt", "2026-07-15T00:00:00Z"),
    canonical: "observedAt > TIMESTAMP '2026-07-15T00:00:00Z'",
    semantic: `"observedAt" > TIMESTAMP '2026-07-15 00:00:00'`,
    verdict: "documented",
    reason: "same strict comparison; the planner reformats the literal for a schema-typed esriFieldTypeDate column",
  },
  {
    label: "pattern/like case-insensitive",
    filter: queryFilter.like("status", "op%", { caseSensitive: false }),
    canonical: "UPPER(status) LIKE UPPER('op%')",
    semantic: "unsupported:unsupported-node",
    verdict: "documented",
    reason:
      "the canonical lane emits the portable UPPER() rewrite; the planner declines to assume collation and reports unsupported-node",
  },
  {
    label: "temporal/during",
    filter: queryFilter.during("observedAt", "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z"),
    canonical: "(observedAt >= TIMESTAMP '2026-07-15T00:00:00Z' AND observedAt <= TIMESTAMP '2026-07-16T00:00:00Z')",
    semantic: "unsupported:unsupported-node",
    verdict: "documented",
    reason:
      "the canonical lane emits the closed interval the corpus reference evaluator uses; the planner refuses the OGC during topology predicate on an instant-valued column",
  },
];

describe("filter lane equivalence ledger", () => {
  it.each(LEDGER.map((row) => [row.label, row] as const))("pins both lanes for %s", (_label, row) => {
    expect(canonical(row.filter)).toBe(row.canonical);
    expect(semantic(row.filter)).toBe(row.semantic);
  });

  it("keeps every identical row identical once identifier quoting is normalized", () => {
    for (const row of LEDGER.filter((entry) => entry.verdict === "identical")) {
      expect(row.semantic.replaceAll('"', ""), `${row.label}: ${QUOTING_REASON}`).toBe(row.canonical);
    }
  });

  it("requires a recorded reason for every documented difference", () => {
    for (const row of LEDGER.filter((entry) => entry.verdict === "documented")) {
      expect(row.reason, row.label).toBeTruthy();
      expect(row.semantic.replaceAll('"', ""), row.label).not.toBe(row.canonical);
    }
  });

  it("agrees on temporal strictness, which is the divergence this slice removed", () => {
    // Both lanes must be strict; an inclusive bound on either side is the exact
    // silent superset bug the ledger exists to catch.
    for (const label of ["temporal/before", "temporal/after"]) {
      const row = LEDGER.find((entry) => entry.label === label)!;
      const operator = label.endsWith("before") ? "<" : ">";
      expect(row.canonical).toContain(`observedAt ${operator} TIMESTAMP`);
      expect(row.semantic).toContain(`"observedAt" ${operator} TIMESTAMP`);
      expect(row.canonical).not.toContain(`${operator}=`);
      expect(row.semantic).not.toContain(`${operator}=`);
    }
  });
});
