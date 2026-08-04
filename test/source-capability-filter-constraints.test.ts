/**
 * Drift gate between the protocol-default filter constraints the SDK attaches
 * to discovered capability profiles and the reviewed `queryFilterSupport` truth
 * in `config/support-manifest.v1.json` (which the generated
 * protocol-capability matrix publishes).
 *
 * The two are authored separately on purpose — one is runtime evidence, the
 * other is reviewed documentation — so this test is what keeps them honest.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROTOCOL_QUERY_FILTER_CONSTRAINTS } from "../src/source-capability-filter-constraints.js";

interface ManifestProtocol {
  readonly id: string;
  readonly queryFilter: {
    readonly dialect: string;
    readonly filter: "native" | "attributes-only" | "unsupported";
    readonly temporal: readonly ("source-dimension" | "field-predicate")[];
    readonly notes: string;
  };
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../config/support-manifest.v1.json", import.meta.url)), "utf8"),
) as { readonly protocols: readonly ManifestProtocol[] };

describe("protocol-default query filter constraints", () => {
  it("covers exactly the protocols the manifest says can filter", () => {
    const filterable = manifest.protocols
      .filter((protocol) => protocol.queryFilter.filter !== "unsupported")
      .map((protocol) => protocol.id)
      .sort();
    expect(Object.keys(PROTOCOL_QUERY_FILTER_CONSTRAINTS).sort()).toEqual(filterable);
  });

  it("gives a spatial allow list exactly to the protocols the manifest calls native", () => {
    for (const protocol of manifest.protocols) {
      const constraints = PROTOCOL_QUERY_FILTER_CONSTRAINTS[protocol.id];
      if (protocol.queryFilter.filter === "unsupported") {
        expect(constraints, protocol.id).toBeUndefined();
        continue;
      }
      expect(constraints, protocol.id).toBeDefined();
      if (protocol.queryFilter.filter === "attributes-only") {
        // The manifest says this adapter refuses a spatial node; the runtime
        // allow list must be empty rather than absent, so the gate fails closed.
        expect(constraints?.spatialPredicates, protocol.id).toEqual([]);
      } else {
        expect(constraints?.spatialPredicates?.length ?? 0, protocol.id).toBeGreaterThan(0);
      }
    }
  });

  it("advertises temporal predicates exactly when the manifest claims a field predicate", () => {
    for (const protocol of manifest.protocols) {
      const constraints = PROTOCOL_QUERY_FILTER_CONSTRAINTS[protocol.id];
      if (!constraints) continue;
      const claimsFieldPredicate = protocol.queryFilter.temporal.includes("field-predicate");
      expect(claimsFieldPredicate, protocol.id).toBe(true);
      expect(constraints.temporalPredicates, protocol.id).toEqual(["before", "after", "during", "time-intersects"]);
    }
  });

  it("keeps every operator list a superset of its spatial and temporal predicates", () => {
    for (const [protocol, constraints] of Object.entries(PROTOCOL_QUERY_FILTER_CONSTRAINTS)) {
      const operators = new Set(constraints.filterOperators ?? []);
      for (const predicate of constraints.spatialPredicates ?? []) {
        expect(operators.has(predicate), `${protocol}:${predicate}`).toBe(true);
      }
      for (const predicate of constraints.temporalPredicates ?? []) {
        expect(operators.has(predicate), `${protocol}:${predicate}`).toBe(true);
      }
      // Boolean composition is what makes a multi-clause filter expressible.
      for (const operator of ["and", "or", "not", "eq"] as const) {
        expect(operators.has(operator), `${protocol}:${operator}`).toBe(true);
      }
    }
  });

  it("restricts OData and GeoParquet to intersects-shaped predicates", () => {
    // Both lower a spatial node through an intersects-only channel
    // (`geo.intersects`, bbox pushdown); anything else would widen the result.
    for (const protocol of ["odata", "geoparquet"] as const) {
      expect(PROTOCOL_QUERY_FILTER_CONSTRAINTS[protocol]?.spatialPredicates).toEqual(["intersects", "bbox-intersects"]);
    }
  });
});
