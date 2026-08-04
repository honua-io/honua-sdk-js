/**
 * Unit coverage for the canonical typed filter (#947): per-dialect compilation,
 * fail-closed fidelity, plan-fingerprint participation, and the GeoParquet
 * degraded (bbox-reduced) path.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_QUERY_FILTER_DEPTH,
  type QueryFilterExpression,
  assertQueryFilter,
  queryFilter,
} from "../../src/contract/query-filter.js";
import type { Query, SourceDescriptor } from "../../src/contract/types.js";
import { capabilities } from "../../src/contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { compileQuery } from "../../src/core/geoparquet-sql.js";
import { envelope, polygon } from "../../src/core/spatial-filter.js";
import { compileGeoServicesQuery } from "../../src/query-planner/geoservices.js";
import { compileGrpcQuery } from "../../src/query-planner/grpc.js";
import { createQueryIr, hashQueryIr } from "../../src/query-planner/ir.js";
import { compileOdataQuery } from "../../src/query-planner/odata-v1.js";
import { compileOgcApiFeaturesQuery } from "../../src/query-planner/ogc-features.js";
import { explainQuery, hashQueryPlan } from "../../src/query-planner/planner.js";
import type { QueryIrSourceIdentity } from "../../src/query-planner/types.js";
import { HonuaQueryPlanningError } from "../../src/query-planner/types.js";
import { compileWfsQuery } from "../../src/query-planner/wfs-v1.js";

const geoServicesIdentity: QueryIrSourceIdentity = {
  id: "incidents",
  protocol: "geoservices-feature-service",
  endpoint: "https://demo.honua.test/FeatureServer",
  serviceId: "incidents",
  layerId: 0,
  authorizationScope: [],
  capabilities: [],
};

const ogcIdentity: QueryIrSourceIdentity = {
  id: "incidents",
  protocol: "ogc-features",
  endpoint: "https://demo.honua.test/ogc",
  collectionId: "incidents",
  authorizationScope: [],
  capabilities: [],
};

const wfsIdentity: QueryIrSourceIdentity = {
  id: "incidents",
  protocol: "wfs",
  endpoint: "https://demo.honua.test/wfs",
  typeName: "ns:incidents",
  geometryProperty: "the_geom",
  authorizationScope: [],
  capabilities: [],
};

const odataIdentity: QueryIrSourceIdentity = {
  id: "incidents",
  protocol: "odata",
  endpoint: "https://demo.honua.test/odata",
  entitySet: "Incidents",
  geometryProperty: "Geometry",
  authorizationScope: [],
  capabilities: [],
};

const grpcIdentity: QueryIrSourceIdentity = {
  id: "incidents",
  protocol: "grpc",
  endpoint: "https://demo.honua.test",
  serviceId: "incidents",
  layerId: 0,
  authorizationScope: [],
  capabilities: [],
};

const attributeFilter = queryFilter.and(
  queryFilter.eq("STATUS", "open"),
  queryFilter.isIn("SEVERITY", [1, 2, 3]),
  queryFilter.not(queryFilter.isNull("CLOSED_AT")),
);

describe("query filter / validation", () => {
  it("bounds nesting depth so a hostile filter cannot exhaust the compiler", () => {
    let deep: QueryFilterExpression = queryFilter.eq("STATUS", "open");
    for (let index = 0; index <= MAX_QUERY_FILTER_DEPTH + 1; index += 1) deep = queryFilter.not(deep);
    expect(() => assertQueryFilter(deep, { protocol: "geoservices-feature-service" })).toThrow(
      HonuaCapabilityNotSupportedError,
    );
  });

  it("rejects a non-finite numeric literal", () => {
    expect(() => assertQueryFilter(queryFilter.gt("ACRES", Number.POSITIVE_INFINITY), { protocol: "odata" })).toThrow(
      /filter.literal.number/,
    );
  });

  it("honours a capability-profile predicate allow list", () => {
    expect(() =>
      assertQueryFilter(queryFilter.spatial("within", envelope(0, 0, 1, 1)), {
        protocol: "ogc-features",
        supportedSpatialPredicates: ["intersects", "bbox-intersects"],
      }),
    ).toThrow(/filter.spatial.within/);
  });
});

describe("query filter / deterministic v1 compilers", () => {
  it("compiles attribute predicates to GeoServices SQL-92", () => {
    const compiled = compileGeoServicesQuery(geoServicesIdentity, {
      filter: attributeFilter,
      temporalFilter: { kind: "interval", start: "2026-01-01T00:00:00Z", end: null },
    });
    expect(compiled.where).toBe("(STATUS = 'open') AND (SEVERITY IN (1, 2, 3)) AND (NOT (CLOSED_AT IS NULL))");
    expect(compiled.time).toBe(`${Date.parse("2026-01-01T00:00:00Z")},null`);
  });

  it("lifts a conjunctive spatial node onto the GeoServices geometry parameters", () => {
    const compiled = compileGeoServicesQuery(geoServicesIdentity, {
      filter: queryFilter.and(queryFilter.eq("STATUS", "open"), queryFilter.spatial("within", envelope(-1, -2, 3, 4))),
    });
    expect(compiled.where).toBe("STATUS = 'open'");
    expect(compiled.geometryType).toBe("esriGeometryEnvelope");
    expect(compiled.spatialRel).toBe("esriSpatialRelWithin");
  });

  it("compiles to CQL2 text and datetime for OGC API Features", () => {
    const compiled = compileOgcApiFeaturesQuery(ogcIdentity, {
      filter: queryFilter.like("NAME", "Ka%"),
      temporalFilter: { kind: "instant", instant: "2026-03-04T05:06:07Z" },
    });
    expect(compiled.filter).toBe("NAME LIKE 'Ka%'");
    expect(compiled.filterLang).toBe("cql2-text");
    expect(compiled.datetime).toBe("2026-03-04T05:06:07Z");
  });

  it("compiles to FES 2.0 for WFS", () => {
    const compiled = compileWfsQuery(wfsIdentity, {
      filter: queryFilter.and(
        queryFilter.between("ACRES", 1, 10),
        queryFilter.spatial(
          "intersects",
          polygon([
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ]),
        ),
      ),
    });
    expect(compiled.filter).toContain("<fes:PropertyIsBetween>");
    expect(compiled.filter).toContain("<fes:Intersects><fes:ValueReference>the_geom</fes:ValueReference>");
  });

  it("compiles to an OData $filter with anchored pattern functions", () => {
    const compiled = compileOdataQuery(odataIdentity, {
      filter: queryFilter.and(queryFilter.like("NAME", "Ka%"), queryFilter.ne("STATUS", "closed")),
    });
    expect(compiled.filter).toContain("startswith(NAME,'Ka')");
    expect(compiled.filter).toContain("STATUS ne 'closed'");
  });

  it("compiles to the gRPC FeatureService where clause", () => {
    const compiled = compileGrpcQuery(grpcIdentity, { filter: queryFilter.eq("STATUS", "open") });
    expect(compiled.where).toBe("STATUS = 'open'");
  });

  it("refuses a source-dimension temporal filter on protocols with no time parameter", () => {
    expect(() =>
      compileOdataQuery(odataIdentity, { temporalFilter: { kind: "instant", instant: "2026-01-01T00:00:00Z" } }),
    ).toThrow(HonuaQueryPlanningError);
    expect(() =>
      compileWfsQuery(wfsIdentity, { temporalFilter: { kind: "instant", instant: "2026-01-01T00:00:00Z" } }),
    ).toThrow(HonuaQueryPlanningError);
    expect(() =>
      compileGrpcQuery(grpcIdentity, { temporalFilter: { kind: "instant", instant: "2026-01-01T00:00:00Z" } }),
    ).toThrow(HonuaQueryPlanningError);
  });

  it("refuses an OData topological predicate the protocol has no function for", () => {
    expect(() =>
      compileOdataQuery(odataIdentity, { filter: queryFilter.spatial("within", envelope(0, 0, 1, 1)) }),
    ).toThrow(/within/);
  });
});

describe("query filter / GeoParquet degraded reduction", () => {
  const options = {
    sources: ["s3://bucket/parcels.parquet"],
    geometryAlias: "geometry",
    geometry: { column: "geometry", encoding: "wkb" as const },
  };

  it("pushes an envelope predicate down exactly", () => {
    const compiled = compileQuery(
      { filter: queryFilter.spatial("intersects", envelope(-1, -2, 3, 4)) } satisfies Query,
      options,
    );
    expect(compiled.sql).toContain("ST_Intersects");
    expect(compiled.bboxApproximated).toBe(false);
  });

  it("reports a non-envelope geometry as an approximated (degraded) bbox reduction", () => {
    const compiled = compileQuery(
      {
        filter: queryFilter.spatial(
          "intersects",
          polygon([
            [
              [0, 0],
              [2, 0],
              [2, 2],
              [0, 0],
            ],
          ]),
        ),
      } satisfies Query,
      options,
    );
    expect(compiled.bboxApproximated).toBe(true);
  });

  it("refuses a temporal filter that does not name its field", () => {
    expect(() =>
      compileQuery({ temporalFilter: { kind: "instant", instant: "2026-01-01T00:00:00Z" } } satisfies Query, options),
    ).toThrow(HonuaCapabilityNotSupportedError);
  });

  it("quotes identifiers and escapes literals in DuckDB SQL", () => {
    const compiled = compileQuery({ filter: queryFilter.eq("STATE", "O'Brien") } satisfies Query, options);
    expect(compiled.sql).toContain(`"STATE" = 'O''Brien'`);
  });
});

describe("query filter / plan identity", () => {
  const descriptor: SourceDescriptor = {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://demo.honua.test/FeatureServer", serviceId: "incidents", layerId: 0 },
    capabilities: capabilities(["query"]),
  };

  it("carries the typed filter into the canonical IR fingerprint", () => {
    const open = hashQueryIr(createQueryIr({ descriptor, query: { filter: queryFilter.eq("STATUS", "open") } }));
    const closed = hashQueryIr(createQueryIr({ descriptor, query: { filter: queryFilter.eq("STATUS", "closed") } }));
    const unfiltered = hashQueryIr(createQueryIr({ descriptor }));
    expect(open).not.toBe(closed);
    expect(open).not.toBe(unfiltered);
  });

  it("carries the temporal filter into the plan fingerprint", () => {
    const plan = (temporalFilter: Query["temporalFilter"]) =>
      hashQueryPlan(explainQuery({ descriptor, query: { filter: queryFilter.eq("STATUS", "open"), temporalFilter } }));
    expect(plan({ kind: "instant", instant: "2026-01-01T00:00:00Z" })).not.toBe(
      plan({ kind: "instant", instant: "2026-01-02T00:00:00Z" }),
    );
  });
});
